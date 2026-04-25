// seed-data.js
// Default protocol library and constrained coach-note vocabulary.
// Idempotent via ON CONFLICT DO NOTHING.

const { query } = require('./db');

// EEG device registry seeds.
// channel_map is ordered to match the device's native channel index.
// frontal_available gates the analysis engine: devices with frontal channels
// get true Frontal Alpha Asymmetry; devices without fall back to temporal
// asymmetry as a proxy.
const DEFAULT_EEG_DEVICES = [
  {
    code: 'simulator',
    display_name: 'Simulator',
    vendor: 'DreamSonic',
    channel_count: 4,
    channel_map: ['O1', 'O2', 'T3', 'T4'],
    sample_rate_hz: 250,
    max_safe_amplitude_uv: 200,
    frontal_available: false,
    connection_type: 'simulator',
    driver_module: 'simulator',
    notes: 'Synthetic signal for training, demos, and when hardware is unavailable.',
  },
  {
    code: 'brainbit',
    display_name: 'BrainBit Flex',
    vendor: 'BrainBit',
    channel_count: 4,
    channel_map: ['O1', 'O2', 'T3', 'T4'],
    sample_rate_hz: 250,
    max_safe_amplitude_uv: 200,
    frontal_available: false,
    connection_type: 'bluetooth',
    driver_module: 'brainbit',
    notes: 'Primary production device. Dry electrodes, 4 channels, occipital + temporal montage.',
  },
  {
    code: 'epoc1',
    display_name: 'Emotiv EPOC 1.0',
    vendor: 'Emotiv',
    channel_count: 14,
    channel_map: ['F3','FC5','AF3','F7','T7','P7','O1','O2','P8','T8','F8','AF4','FC6','F4'],
    sample_rate_hz: 128,
    max_safe_amplitude_uv: 1000,
    frontal_available: true,
    connection_type: 'bluetooth',
    driver_module: 'epoc-bridge',
    notes: '14-channel saline-electrode EEG. Full bilateral frontal coverage enables true Frontal Alpha Asymmetry. Requires the EPOC bridge program running on the operator Mac (see /epoc-bridge/README.md).',
  },
  {
    code: 'myndband',
    display_name: 'MyndPlay MyndBand',
    vendor: 'MyndPlay',
    channel_count: 1,
    channel_map: ['Fp1'],
    sample_rate_hz: 512,
    max_safe_amplitude_uv: 800,
    frontal_available: true,
    connection_type: 'bluetooth',
    driver_module: 'myndplay-bridge',
    notes: 'Single-channel BLE forehead band at Fp1. Supports SASI mood metric, alpha/theta tracking, entrainment monitoring. Cannot compute bilateral asymmetry. Requires the MyndPlay bridge program running on the operator Mac (see /myndplay-bridge/README.md).',
  },
  // Future devices — uncomment when hardware arrives and SDK drivers are wired.
  // {
  //   code: 'muse2',
  //   display_name: 'Muse 2',
  //   vendor: 'InteraXon',
  //   channel_count: 4,
  //   channel_map: ['TP9', 'AF7', 'AF8', 'TP10'],
  //   sample_rate_hz: 256,
  //   max_safe_amplitude_uv: 180,
  //   frontal_available: true,
  //   connection_type: 'bluetooth',
  //   driver_module: 'muse',
  //   notes: 'Has frontal channels — enables true Frontal Alpha Asymmetry analysis.',
  // },
  // {
  //   code: 'openbci_cyton',
  //   display_name: 'OpenBCI Cyton',
  //   vendor: 'OpenBCI',
  //   channel_count: 8,
  //   channel_map: ['Fp1', 'Fp2', 'C3', 'C4', 'P7', 'P8', 'O1', 'O2'],
  //   sample_rate_hz: 250,
  //   max_safe_amplitude_uv: 250,
  //   frontal_available: true,
  //   connection_type: 'bluetooth',
  //   driver_module: 'openbci',
  //   notes: 'Research-grade 8-channel. Full 10-20 coverage for advanced protocols.',
  // },
];

// NOTE: Beta-band (15-25 Hz) photic stimulation carries the highest overlap
// with photosensitive seizure triggers — the Peak Engagement protocol is
// audio-only by design.
const DEFAULT_PROTOCOLS = [
  {
    code: 'DEEP_CALM_10',
    name: 'Deep Calm',
    target_band: 'alpha',
    target_frequency_hz: 10.00,
    duration_minutes: 20,
    light_intensity_pct: 45,
    audio_type: 'isochronic',
    description_wellness: 'Alpha-band self-regulation training for relaxation response and stress resilience.',
  },
  {
    code: 'FOCUS_SHARPENER_14',
    name: 'Focus Sharpener',
    target_band: 'smr',
    target_frequency_hz: 14.00,
    duration_minutes: 20,
    light_intensity_pct: 40,
    audio_type: 'isochronic',
    description_wellness: 'SMR-band training for sustained focus and calm engagement.',
  },
  {
    code: 'CREATIVE_FLOW_7',
    name: 'Creative Flow',
    target_band: 'theta',
    target_frequency_hz: 7.00,
    duration_minutes: 25,
    light_intensity_pct: 35,
    audio_type: 'binaural',
    description_wellness: 'Theta-band training associated with creative ideation and memory consolidation.',
  },
  {
    code: 'RECOVERY_4',
    name: 'Recovery',
    target_band: 'delta',
    target_frequency_hz: 4.00,
    duration_minutes: 25,
    light_intensity_pct: 25,
    audio_type: 'binaural',
    description_wellness: 'Delta-band training associated with deep rest and sleep-onset preparation.',
  },
  {
    code: 'PEAK_ENGAGE_18',
    name: 'Peak Engagement (audio-only)',
    target_band: 'beta',
    target_frequency_hz: 18.00,
    duration_minutes: 15,
    light_intensity_pct: 0,
    audio_type: 'isochronic',
    description_wellness: 'Beta-band audio-only training for active task engagement. No photic stimulus.',
  },
  {
    code: 'MEDITATION_8',
    name: 'Meditation Entry',
    target_band: 'alpha',
    target_frequency_hz: 8.50,
    duration_minutes: 15,
    light_intensity_pct: 35,
    audio_type: 'isochronic',
    description_wellness: 'Low-alpha training as a guided entry for meditation practice.',
  },
  {
    code: 'HAPPY_LB',
    name: 'Happy',
    target_band: 'smr',
    target_frequency_hz: 13.50,
    max_freq_shift: 4.0,
    duration_minutes: 20,
    light_intensity_pct: 50,
    audio_type: 'isochronic',
    description_wellness: 'Uplift protocol — meets the brain wherever it is and migrates upward into low-beta/SMR. Associated with active engagement, alert positive mood, focused attention. Capped at 4 Hz shift per session for safety.',
  },
];

const DEFAULT_VOCAB = [
  { code: 'OBS_GOOD_SIGNAL', category: 'observation', display_text: 'Signal quality stable throughout session', sort_order: 1 },
  { code: 'OBS_MOVEMENT_ARTIFACT', category: 'observation', display_text: 'Movement artifacts noted; session data adjusted', sort_order: 2 },
  { code: 'OBS_TARGET_BAND_GAIN', category: 'observation', display_text: 'Target band power increased during stimulus phase', sort_order: 3 },
  { code: 'OBS_MINIMAL_CHANGE', category: 'observation', display_text: 'Minimal band power change observed this session', sort_order: 4 },
  { code: 'OBS_STEADY_RELAX', category: 'observation', display_text: 'Relaxation response appeared steady', sort_order: 5 },

  { code: 'CR_REPORTED_CALM', category: 'client_report', display_text: 'Client reported feeling more relaxed post-session', sort_order: 10 },
  { code: 'CR_REPORTED_FOCUS', category: 'client_report', display_text: 'Client reported improved focus post-session', sort_order: 11 },
  { code: 'CR_REPORTED_TIRED', category: 'client_report', display_text: 'Client reported tiredness post-session', sort_order: 12 },
  { code: 'CR_REPORTED_NO_CHANGE', category: 'client_report', display_text: 'Client reported no notable change', sort_order: 13 },
  { code: 'CR_REPORTED_HEADACHE', category: 'client_report', display_text: 'Client reported mild headache — flagged for follow-up', sort_order: 14 },
  { code: 'CR_REPORTED_POSITIVE', category: 'client_report', display_text: 'Client reported positive experience', sort_order: 15 },

  { code: 'ADJ_LOWER_INTENSITY', category: 'adjustment', display_text: 'Reduced light intensity mid-session at client request', sort_order: 20 },
  { code: 'ADJ_SHORTENED', category: 'adjustment', display_text: 'Session shortened per client preference', sort_order: 21 },
  { code: 'ADJ_PROTOCOL_CHANGE', category: 'adjustment', display_text: 'Recommended different protocol for next visit', sort_order: 22 },

  { code: 'EQ_FIT_CHECK_OK', category: 'equipment', display_text: 'Headband fit verified at session start', sort_order: 30 },
  { code: 'EQ_REPOSITIONED', category: 'equipment', display_text: 'Headband repositioned mid-session for signal quality', sort_order: 31 },

  { code: 'FU_RECOMMEND_WEEKLY', category: 'followup', display_text: 'Recommended weekly session cadence', sort_order: 40 },
  { code: 'FU_RECOMMEND_BIWEEKLY', category: 'followup', display_text: 'Recommended twice-weekly cadence', sort_order: 41 },
  { code: 'FU_EXTERNAL_REFERRAL', category: 'followup', display_text: 'Provided external resource directory to client', sort_order: 42 },
  { code: 'FU_NONE_SCHEDULED', category: 'followup', display_text: 'No follow-up session scheduled at this time', sort_order: 43 },
];

async function init() {
  console.log('[seed] seeding defaults...');

  for (const d of DEFAULT_EEG_DEVICES) {
    await query(
      `INSERT INTO wellness_eeg_devices
        (code, display_name, vendor, channel_count, channel_map,
         sample_rate_hz, max_safe_amplitude_uv, frontal_available,
         connection_type, driver_module, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (code) DO NOTHING`,
      [d.code, d.display_name, d.vendor, d.channel_count,
       JSON.stringify(d.channel_map), d.sample_rate_hz, d.max_safe_amplitude_uv,
       d.frontal_available, d.connection_type, d.driver_module, d.notes]
    );
  }

  for (const p of DEFAULT_PROTOCOLS) {
    await query(
      `INSERT INTO wellness_protocols
        (code, name, target_band, target_frequency_hz, duration_minutes,
         light_intensity_pct, audio_type, description_wellness, max_freq_shift)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (code) DO NOTHING`,
      [p.code, p.name, p.target_band, p.target_frequency_hz, p.duration_minutes,
       p.light_intensity_pct, p.audio_type, p.description_wellness,
       p.max_freq_shift != null ? p.max_freq_shift : 4.0]
    );
  }

  for (const v of DEFAULT_VOCAB) {
    await query(
      `INSERT INTO wellness_coach_note_vocab (code, display_text, category, sort_order)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (code) DO NOTHING`,
      [v.code, v.display_text, v.category, v.sort_order]
    );
  }

  const { rows: dc } = await query(`SELECT COUNT(*)::int AS c FROM wellness_eeg_devices`);
  const { rows: pc } = await query(`SELECT COUNT(*)::int AS c FROM wellness_protocols`);
  const { rows: vc } = await query(`SELECT COUNT(*)::int AS c FROM wellness_coach_note_vocab`);
  console.log(`[seed] ready — ${dc[0].c} devices, ${pc[0].c} protocols, ${vc[0].c} vocab terms`);
}

module.exports = { init };
