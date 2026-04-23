// seed-data.js
// Default protocol library and constrained coach-note vocabulary.
// Idempotent via ON CONFLICT DO NOTHING.

const { query } = require('./db');

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

  for (const p of DEFAULT_PROTOCOLS) {
    await query(
      `INSERT INTO wellness_protocols
        (code, name, target_band, target_frequency_hz, duration_minutes,
         light_intensity_pct, audio_type, description_wellness)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (code) DO NOTHING`,
      [p.code, p.name, p.target_band, p.target_frequency_hz, p.duration_minutes,
       p.light_intensity_pct, p.audio_type, p.description_wellness]
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

  const { rows: pc } = await query(`SELECT COUNT(*)::int AS c FROM wellness_protocols`);
  const { rows: vc } = await query(`SELECT COUNT(*)::int AS c FROM wellness_coach_note_vocab`);
  console.log(`[seed] ready — ${pc[0].c} protocols, ${vc[0].c} vocab terms`);
}

module.exports = { init };
