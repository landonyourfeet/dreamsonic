// routes/analysis.js
//
// DreamSonic Analysis Engine — pure functions, no side effects.
//
// Takes raw EEG samples + a device profile (BrainBit, Muse, OpenBCI, ...),
// returns structured brain-state analysis + stimulation directives.
//
// The engine does NOT talk to HTTP, the database, or the hardware. It's a
// pure transformation: samples in, decisions out. The adaptive controller
// (separate module) wraps this with timing, state, safety clamps, and I/O.
//
// Device-agnostic by design. To support a new headset, INSERT a row in
// wellness_eeg_devices — no code change needed unless the new device has
// unusual electrode placements not yet mapped in ROLE_ELECTRODES below.

'use strict';

// ============================================================================
// CONSTANTS
// ============================================================================

// Band definitions (Hz) — standard clinical ranges
const BANDS = Object.freeze({
  delta: [0.5, 4],
  theta: [4,   8],
  alpha: [8,  13],
  smr:   [12, 15],
  beta:  [13, 30],
  gamma: [30, 45],
});
const BAND_KEYS = Object.freeze(Object.keys(BANDS));

// Hardware safety ceiling — ENFORCED. Cannot be overridden by any caller,
// any config, or any UI. The only way to raise these limits is to edit this
// file. Lowered from the 15-25Hz photosensitive seizure trigger zone.
const SAFETY = Object.freeze({
  MIN_FREQ_HZ:        2.0,
  MAX_FREQ_HZ:       14.0,
  MIN_INTENSITY_PCT:  0,
  MAX_INTENSITY_PCT: 100,
  CAUTION_FREQ_HZ:   13.0,
});

// Autopilot adjustment bounds — limits on per-tick change magnitude
const AUTOPILOT = Object.freeze({
  MAX_FREQ_DELTA_PER_TICK:        0.5,
  MAX_INTENSITY_DELTA_PER_TICK:  15,
  MIN_TICK_INTERVAL_MS:       10_000,
  TICK_PERIOD_MS:              2_000,
  ANALYSIS_WINDOW_SAMPLES:       512,  // power of 2 for FFT
});

// Signal-quality thresholds
const ARTIFACT = Object.freeze({
  MIN_VALID_SAMPLES_PCT: 80,
  FREEZE_AFTER_BAD_S:     5,
});

// 10-20 electrode names mapped to semantic roles. Used by getChannelRoles()
// to match a device's channel_map to positions the analysis engine cares
// about. Extend this if a new device uses an unusual electrode site.
const ROLE_ELECTRODES = Object.freeze({
  leftFrontal:   ['Fp1', 'AF7', 'F3', 'F7'],
  rightFrontal:  ['Fp2', 'AF8', 'F4', 'F8'],
  leftTemporal:  ['T3', 'T7', 'TP9', 'FT7'],
  rightTemporal: ['T4', 'T8', 'TP10', 'FT8'],
  leftOccipital: ['O1', 'PO7'],
  rightOccipital:['O2', 'PO8'],
});

// ============================================================================
// CHANNEL ROLE MAPPING
// ============================================================================

/**
 * Given a device profile's channel_map (e.g. ['O1','O2','T3','T4']),
 * return which device index (0-based) corresponds to each semantic role.
 * Roles the device cannot provide return null.
 *
 * @param {object} deviceProfile
 * @returns {object} { leftFrontal, rightFrontal, leftTemporal, rightTemporal, leftOccipital, rightOccipital }
 */
function getChannelRoles(deviceProfile) {
  const map = Array.isArray(deviceProfile.channel_map)
    ? deviceProfile.channel_map
    : JSON.parse(deviceProfile.channel_map || '[]');
  const roles = {};
  for (const [role, electrodes] of Object.entries(ROLE_ELECTRODES)) {
    roles[role] = null;
    for (const electrode of electrodes) {
      const idx = map.indexOf(electrode);
      if (idx !== -1) { roles[role] = idx; break; }
    }
  }
  return roles;
}

// ============================================================================
// FFT — Cooley-Tukey radix-2, in-place
// ============================================================================

function fftInPlace(re, im) {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error('FFT length must be power of 2');

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angStep = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const ang = angStep * k;
        const wRe = Math.cos(ang);
        const wIm = Math.sin(ang);
        const tRe = re[i + k + half] * wRe - im[i + k + half] * wIm;
        const tIm = re[i + k + half] * wIm + im[i + k + half] * wRe;
        re[i + k + half] = re[i + k] - tRe;
        im[i + k + half] = im[i + k] - tIm;
        re[i + k] += tRe;
        im[i + k] += tIm;
      }
    }
  }
}

function applyHannWindow(samples) {
  const n = samples.length;
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
    samples[i] *= w;
  }
}

// ============================================================================
// BAND POWER COMPUTATION
// ============================================================================

function computeChannelBandPowers(channelSamples, sampleRateHz) {
  const N = AUTOPILOT.ANALYSIS_WINDOW_SAMPLES;
  if (!channelSamples || channelSamples.length < N) return null;

  const slice = channelSamples.slice(-N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = slice[i];

  // DC removal
  let sum = 0;
  for (let i = 0; i < N; i++) sum += re[i];
  const mean = sum / N;
  for (let i = 0; i < N; i++) re[i] -= mean;
  applyHannWindow(re);

  fftInPlace(re, im);

  const binHz = sampleRateHz / N;
  const powers = {};
  for (const band of BAND_KEYS) {
    const [lo, hi] = BANDS[band];
    const loBin = Math.max(1, Math.floor(lo / binHz));
    const hiBin = Math.min(N / 2 - 1, Math.ceil(hi / binHz));
    let p = 0;
    for (let k = loBin; k <= hiBin; k++) {
      p += re[k] * re[k] + im[k] * im[k];
    }
    powers[band] = (2 / (N * N)) * p;
  }
  powers.total = BAND_KEYS.reduce((s, b) => s + powers[b], 0);
  return powers;
}

function averageBandPowers(...sources) {
  const valid = sources.filter(Boolean);
  if (!valid.length) return null;
  const out = {};
  for (const k of [...BAND_KEYS, 'total']) {
    out[k] = valid.reduce((sum, s) => sum + s[k], 0) / valid.length;
  }
  return out;
}

function safeDiv(n, d) {
  return Number.isFinite(d) && d !== 0 ? n / d : null;
}

function safeLogRatio(a, b) {
  return (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0)
    ? Math.log(a) - Math.log(b) : null;
}

// ============================================================================
// SIGNAL QUALITY ASSESSMENT
// ============================================================================

function assessSignalQuality(ringBuffer, deviceProfile) {
  const N = AUTOPILOT.ANALYSIS_WINDOW_SAMPLES;
  const maxAmp = deviceProfile.max_safe_amplitude_uv || 200;
  const chCount = deviceProfile.channel_count;

  for (let ch = 0; ch < chCount; ch++) {
    if (!ringBuffer[ch] || ringBuffer[ch].length < N) {
      return { status: 'insufficient', reason: `channel ${ch} has only ${ringBuffer[ch]?.length || 0} samples` };
    }
  }

  let totalBadFrac = 0;
  const perChannel = [];
  for (let ch = 0; ch < chCount; ch++) {
    const slice = ringBuffer[ch].slice(-N);
    let bad = 0;
    for (const v of slice) {
      if (!Number.isFinite(v) || Math.abs(v) > maxAmp) bad++;
    }
    const pctClean = (1 - bad / slice.length) * 100;
    perChannel.push({ channel: ch, pctClean: Math.round(pctClean * 10) / 10 });
    totalBadFrac += bad / slice.length;
  }
  const avgClean = (1 - totalBadFrac / chCount) * 100;

  let status = 'good';
  if (avgClean < ARTIFACT.MIN_VALID_SAMPLES_PCT) status = 'poor';
  else if (avgClean < 92) status = 'fair';

  return { status, avgCleanPct: Math.round(avgClean * 10) / 10, perChannel };
}

// ============================================================================
// WINDOW ANALYSIS
// ============================================================================

/**
 * Analyze the most recent window of EEG data from a device.
 *
 * @param {number[][]} ringBuffer - array of channel sample arrays
 * @param {object} deviceProfile - row from wellness_eeg_devices
 * @returns {object|null} analysis bundle or null if insufficient data
 */
function analyzeWindow(ringBuffer, deviceProfile) {
  if (!deviceProfile) throw new Error('analyzeWindow requires a deviceProfile');
  if (!Array.isArray(ringBuffer)) return null;

  const quality = assessSignalQuality(ringBuffer, deviceProfile);
  if (quality.status === 'insufficient') {
    return { timestamp: Date.now(), quality, insufficient: true };
  }

  const sr = deviceProfile.sample_rate_hz;
  const chCount = deviceProfile.channel_count;

  const channels = [];
  for (let ch = 0; ch < chCount; ch++) {
    const p = computeChannelBandPowers(ringBuffer[ch], sr);
    if (!p) return { timestamp: Date.now(), quality, insufficient: true };
    channels.push(p);
  }

  const roles = getChannelRoles(deviceProfile);

  // Build aggregates from whichever roles this device has
  const byRole = {};
  for (const [role, idx] of Object.entries(roles)) {
    byRole[role] = idx !== null ? channels[idx] : null;
  }

  const frontal    = averageBandPowers(byRole.leftFrontal,  byRole.rightFrontal);
  const temporal   = averageBandPowers(byRole.leftTemporal, byRole.rightTemporal);
  const occipital  = averageBandPowers(byRole.leftOccipital,byRole.rightOccipital);
  const allSites   = averageBandPowers(frontal, temporal, occipital);

  const ratios = {
    theta_beta_global:    allSites ? safeDiv(allSites.theta, allSites.beta) : null,
    alpha_beta_occipital: occipital ? safeDiv(occipital.alpha, occipital.beta) : null,
    theta_alpha_global:   allSites ? safeDiv(allSites.theta, allSites.alpha) : null,
  };

  // Frontal Alpha Asymmetry — the strongest mood biomarker.
  // Formula: ln(right alpha) - ln(left alpha)
  // Positive = right-dominant alpha = reduced left activation = depression-risk pattern
  let frontalAsymmetry = null;
  if (byRole.leftFrontal && byRole.rightFrontal) {
    frontalAsymmetry = safeLogRatio(byRole.rightFrontal.alpha, byRole.leftFrontal.alpha);
  }

  // Temporal asymmetry — proxy when no frontal channels (BrainBit)
  let temporalAsymmetry = null;
  if (byRole.leftTemporal && byRole.rightTemporal) {
    temporalAsymmetry = safeLogRatio(byRole.rightTemporal.alpha, byRole.leftTemporal.alpha);
  }

  // Spectral Asymmetry Index (SASI) — single-site mood marker.
  // For single-channel devices (MyndPlay) where bilateral asymmetry isn't
  // possible, SASI compares slow-band (theta+alpha) to fast-band (beta) power
  // at the same site. Higher slow-band relative to fast-band correlates with
  // depressed/withdrawn states; lower correlates with active engagement.
  // Reference: Hinrikus et al. 2009; Mohammadi et al. 2015.
  // Computed as the natural log ratio: ln(beta) - ln(theta + alpha)
  // Positive = active/engaged; Negative = withdrawn/depressed-leaning.
  let spectralAsymmetry = null;
  if (byRole.leftFrontal && !byRole.rightFrontal) {
    // Single frontal channel — use SASI at that site
    const ch = byRole.leftFrontal;
    spectralAsymmetry = safeLogRatio(ch.beta, ch.theta + ch.alpha);
  } else if (byRole.rightFrontal && !byRole.leftFrontal) {
    const ch = byRole.rightFrontal;
    spectralAsymmetry = safeLogRatio(ch.beta, ch.theta + ch.alpha);
  } else if (frontal && deviceProfile.channel_count === 1) {
    // Fallback: any single frontal channel device
    spectralAsymmetry = safeLogRatio(frontal.beta, frontal.theta + frontal.alpha);
  }

  return {
    timestamp: Date.now(),
    deviceCode: deviceProfile.code,
    quality,
    channels,
    frontal, temporal, occipital, allSites,
    ratios,
    frontalAsymmetry,        // null on devices without bilateral frontal channels
    temporalAsymmetry,       // always present if bilateral temporal channels exist
    spectralAsymmetry,       // SASI — single-site mood proxy (single-channel devices)
    frontalAvailable: deviceProfile.frontal_available,
    singleChannelMode: deviceProfile.channel_count === 1,
  };
}

// ============================================================================
// STATE DETECTION
// ============================================================================

/**
 * Classify current brain state using baseline + protocol target.
 * Branches on frontal_available — frontal devices get true FAA, others use
 * temporal asymmetry as a weaker proxy.
 */
function detectState(current, baseline, protocol) {
  if (!current || current.insufficient || current.quality.status === 'poor') {
    return { state: 'ARTIFACT', confidence: 1.0, rationale: 'Signal quality below threshold' };
  }
  if (!baseline) {
    return { state: 'BASELINE_ESTABLISHING', confidence: 0.5, rationale: 'Collecting baseline' };
  }
  if (!current.allSites || !baseline.allSites) {
    return { state: 'NEUTRAL', confidence: 0.3, rationale: 'Aggregate data unavailable' };
  }

  const { target_band } = protocol;

  // Fractional deviation from baseline per band
  const deltaFromBase = {};
  for (const band of BAND_KEYS) {
    const b = baseline.allSites[band];
    const c = current.allSites[band];
    deltaFromBase[band] = (b && b > 0) ? (c - b) / b : 0;
  }

  // 1. HYPERAROUSAL — elevated beta in any available region
  const betaCurrent = current.temporal?.beta ?? current.allSites.beta;
  const betaBase = baseline.temporal?.beta ?? baseline.allSites.beta;
  if (betaBase > 0 && betaCurrent > betaBase * 1.4) {
    return {
      state: 'HYPERAROUSAL',
      confidence: clamp((betaCurrent / betaBase - 1.4) / 0.6, 0.5, 0.95),
      rationale: `Beta ${((betaCurrent / betaBase - 1) * 100).toFixed(0)}% above baseline`,
      deltaFromBase,
    };
  }

  // 2. HYPOAROUSAL — excessive slow waves
  if (deltaFromBase.delta > 0.35 && deltaFromBase.theta > 0.25 && deltaFromBase.beta < -0.2) {
    return { state: 'HYPOAROUSAL', confidence: 0.7,
      rationale: 'Slow-wave dominant with reduced beta', deltaFromBase };
  }

  // 3. RUMINATION — device-specific:
  //    Frontal-available: frontal midline theta elevated + occipital alpha low
  //    Frontal-unavailable (BrainBit): temporal theta + occipital alpha suppression
  const rumThetaRegion = current.frontal || current.temporal;
  const rumThetaBase   = baseline.frontal || baseline.temporal;
  if (rumThetaRegion && rumThetaBase && current.occipital && baseline.occipital) {
    const thetaUp = (rumThetaRegion.theta / rumThetaBase.theta) > 1.25;
    const alphaDown = (current.occipital.alpha / baseline.occipital.alpha) < 0.85;
    if (thetaUp && alphaDown) {
      return { state: 'RUMINATION', confidence: 0.75,
        rationale: 'Theta elevated with occipital alpha suppression', deltaFromBase };
    }
  }

  // 4. FRONTAL ASYMMETRY DEPRESSION-PATTERN — only on frontal-capable devices
  if (current.frontalAvailable && current.frontalAsymmetry !== null && baseline.frontalAsymmetry !== null) {
    // Positive FAA = right-dominant = depression-risk pattern
    // If sustained > 0.2 AND has grown from baseline
    if (current.frontalAsymmetry > 0.2 && current.frontalAsymmetry > baseline.frontalAsymmetry + 0.15) {
      return { state: 'FRONTAL_ASYMMETRY_FLAG', confidence: 0.7,
        rationale: 'Right-dominant frontal alpha — approach motivation target', deltaFromBase };
    }
  }

  // 4b. SASI MOOD FLAG — single-channel fallback (MyndPlay etc.)
  // SASI = ln(beta) - ln(theta + alpha). Lower = withdrawn/depressed-leaning.
  // We flag when current SASI has dropped meaningfully below baseline.
  if (current.singleChannelMode && current.spectralAsymmetry !== null
      && baseline.spectralAsymmetry !== null) {
    const sasiDrop = baseline.spectralAsymmetry - current.spectralAsymmetry;
    // A drop of 0.3+ log units sustained = meaningful shift toward slow-band dominance
    if (sasiDrop > 0.3) {
      return { state: 'SASI_MOOD_FLAG',
        confidence: clamp(sasiDrop, 0.5, 0.85),
        rationale: 'Slow-band dominance increased — withdrawn-leaning shift',
        deltaFromBase };
    }
  }

  // 5. ON TARGET
  const targetDelta = deltaFromBase[target_band];
  if (targetDelta > 0.15 && Math.abs(deltaFromBase.beta) < 0.3) {
    return { state: 'ON_TARGET', confidence: clamp(targetDelta, 0.5, 0.95),
      rationale: `${target_band} +${(targetDelta * 100).toFixed(0)}% above baseline`, deltaFromBase };
  }

  return { state: 'NEUTRAL', confidence: 0.5, rationale: 'No strong deviation', deltaFromBase };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ============================================================================
// STIMULATION DIRECTIVE — proposal only; safety clamp runs separately
// ============================================================================

function proposeDirective(stateResult, currentOutput, protocol) {
  const { state } = stateResult;
  const { target_frequency_hz } = protocol;
  let freq = currentOutput.frequency_hz;
  let intensity = currentOutput.intensity_pct;
  let action = 'HOLD';
  let reason = '';

  switch (state) {
    case 'ARTIFACT':
      action = 'FREEZE';
      reason = 'Signal quality insufficient — engine paused';
      break;
    case 'BASELINE_ESTABLISHING':
      freq = target_frequency_hz;
      action = 'HOLD';
      reason = 'Establishing baseline — holding protocol default';
      break;
    case 'HYPERAROUSAL':
      freq = Math.max(8.0, currentOutput.frequency_hz - 0.5);
      intensity = Math.max(20, currentOutput.intensity_pct - 10);
      action = 'DE_ESCALATE';
      reason = 'Hyperarousal detected — reducing frequency and intensity';
      break;
    case 'HYPOAROUSAL':
      freq = Math.min(14.0, currentOutput.frequency_hz + 0.4);
      intensity = Math.min(85, currentOutput.intensity_pct + 8);
      action = 'RE_ENGAGE';
      reason = 'Hypoarousal detected — increasing frequency to re-engage';
      break;
    case 'RUMINATION':
      freq = 10.0;
      intensity = Math.max(50, currentOutput.intensity_pct);
      action = 'ALPHA_BOOST';
      reason = 'Rumination pattern — locking to 10Hz alpha center';
      break;
    case 'FRONTAL_ASYMMETRY_FLAG':
      // Target: train toward left frontal activation (SMR / low-beta 12-15Hz at F3)
      freq = 13.0;
      intensity = Math.min(75, currentOutput.intensity_pct + 5);
      action = 'ACTIVATION_TRAIN';
      reason = 'Right-dominant frontal alpha — training approach motivation';
      break;
    case 'SASI_MOOD_FLAG':
      // Single-channel mood flag - same training direction as FAA flag
      // Goal: shift balance from slow-band dominance toward beta engagement
      freq = 13.0;
      intensity = Math.min(75, currentOutput.intensity_pct + 5);
      action = 'ACTIVATION_TRAIN';
      reason = 'Slow-band dominance — training approach activation (single-channel)';
      break;
    case 'ON_TARGET':
      freq = 0.8 * currentOutput.frequency_hz + 0.2 * target_frequency_hz;
      action = 'REINFORCE';
      reason = 'On target — holding with slight protocol lock';
      break;
    case 'NEUTRAL':
    default:
      freq = 0.9 * currentOutput.frequency_hz + 0.1 * target_frequency_hz;
      action = 'HOLD';
      reason = 'Neutral — drifting toward protocol target';
  }

  return { proposedFrequencyHz: freq, proposedIntensityPct: intensity, action, reason };
}

// ============================================================================
// SAFETY CLAMP — ENFORCED. No parameters. No overrides.
// ============================================================================

/**
 * Final hardware safety checkpoint. Runs on every directive before it reaches
 * the stimulation player. Clamps cannot be disabled, raised, or bypassed
 * without editing this file. This is by design.
 *
 * @param {object} proposed - { proposedFrequencyHz, proposedIntensityPct, ... }
 * @returns {object} { frequencyHz, intensityPct, clamps: [], ...originalFields }
 */
function applySafetyClamps(proposed) {
  const clamps = [];
  let freq = proposed.proposedFrequencyHz;
  let intensity = proposed.proposedIntensityPct;

  if (!Number.isFinite(freq)) {
    freq = SAFETY.MIN_FREQ_HZ;
    clamps.push({ field: 'frequency', reason: 'non-finite, reset to minimum' });
  } else if (freq > SAFETY.MAX_FREQ_HZ) {
    clamps.push({ field: 'frequency', from: freq, to: SAFETY.MAX_FREQ_HZ,
      reason: `ceiling ${SAFETY.MAX_FREQ_HZ}Hz` });
    freq = SAFETY.MAX_FREQ_HZ;
  } else if (freq < SAFETY.MIN_FREQ_HZ) {
    clamps.push({ field: 'frequency', from: freq, to: SAFETY.MIN_FREQ_HZ,
      reason: `floor ${SAFETY.MIN_FREQ_HZ}Hz` });
    freq = SAFETY.MIN_FREQ_HZ;
  }

  if (!Number.isFinite(intensity)) {
    intensity = 0;
    clamps.push({ field: 'intensity', reason: 'non-finite, reset to 0' });
  } else if (intensity > SAFETY.MAX_INTENSITY_PCT) {
    clamps.push({ field: 'intensity', from: intensity, to: SAFETY.MAX_INTENSITY_PCT,
      reason: `ceiling ${SAFETY.MAX_INTENSITY_PCT}%` });
    intensity = SAFETY.MAX_INTENSITY_PCT;
  } else if (intensity < SAFETY.MIN_INTENSITY_PCT) {
    intensity = SAFETY.MIN_INTENSITY_PCT;
    clamps.push({ field: 'intensity', from: proposed.proposedIntensityPct,
      to: SAFETY.MIN_INTENSITY_PCT, reason: 'floor 0%' });
  }

  return {
    frequencyHz: Math.round(freq * 100) / 100,
    intensityPct: Math.round(intensity),
    action: proposed.action,
    reason: proposed.reason,
    clamps,
    inCautionZone: freq >= SAFETY.CAUTION_FREQ_HZ,
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  BANDS,
  BAND_KEYS,
  SAFETY,
  AUTOPILOT,
  ARTIFACT,
  getChannelRoles,
  computeChannelBandPowers,
  assessSignalQuality,
  analyzeWindow,
  detectState,
  proposeDirective,
  applySafetyClamps,
};
