// routes/progress.js
// Public-by-UUID client progress data + admin stats aggregate.

const express = require('express');
const { query } = require('../db');

const router = express.Router();

router.get('/progress/:external_id', async (req, res) => {
  try {
    const externalId = req.params.external_id;
    if (!/^[0-9a-f-]{36}$/i.test(externalId)) {
      return res.status(400).json({ error: 'invalid external_id' });
    }

    const { rows: clientRows } = await query(
      `SELECT id, first_name, last_name_initial, external_id, created_at
         FROM wellness_clients WHERE external_id = $1 AND active = TRUE`,
      [externalId]
    );
    if (!clientRows.length) return res.status(404).json({ error: 'not found' });
    const client = clientRows[0];

    const { rows: sessions } = await query(
      `SELECT s.id, s.started_at, s.completed_at, s.status,
              s.pre_stress, s.pre_focus, s.pre_mood,
              s.post_stress, s.post_focus, s.post_mood,
              s.baseline_alpha, s.stimulus_alpha, s.cooldown_alpha,
              s.baseline_theta, s.stimulus_theta,
              s.baseline_smr, s.stimulus_smr,
              s.baseline_beta, s.stimulus_beta,
              s.baseline_delta, s.stimulus_delta,
              s.baseline_gamma, s.stimulus_gamma,
              p.name AS protocol_name, p.target_band, p.target_frequency_hz
         FROM wellness_sessions s
         JOIN wellness_protocols p ON p.id = s.protocol_id
        WHERE s.client_id = $1 AND s.status IN ('completed','stopped_early')
        ORDER BY s.started_at ASC`,
      [client.id]
    );

    const n = sessions.length;
    const stressDeltas = [], focusDeltas = [], moodDeltas = [], targetBandGains = [];

    for (const s of sessions) {
      if (s.pre_stress != null && s.post_stress != null) stressDeltas.push(s.post_stress - s.pre_stress);
      if (s.pre_focus != null && s.post_focus != null) focusDeltas.push(s.post_focus - s.pre_focus);
      if (s.pre_mood != null && s.post_mood != null) moodDeltas.push(s.post_mood - s.pre_mood);

      const base = s[`baseline_${s.target_band}`];
      const stim = s[`stimulus_${s.target_band}`];
      if (base && stim && base > 0) {
        targetBandGains.push(((stim - base) / base) * 100);
      }
    }

    const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

    res.json({
      client: {
        first_name: client.first_name,
        last_name_initial: client.last_name_initial,
        member_since: client.created_at,
      },
      summary: {
        total_sessions: n,
        avg_stress_change: avg(stressDeltas),
        avg_focus_change: avg(focusDeltas),
        avg_mood_change: avg(moodDeltas),
        avg_target_band_gain_pct: avg(targetBandGains),
      },
      sessions: sessions.map(s => ({
        id: s.id,
        date: s.started_at,
        protocol_name: s.protocol_name,
        target_band: s.target_band,
        target_frequency_hz: s.target_frequency_hz,
        status: s.status,
        pre_stress: s.pre_stress, post_stress: s.post_stress,
        pre_focus: s.pre_focus,   post_focus: s.post_focus,
        pre_mood: s.pre_mood,     post_mood: s.post_mood,
        target_band_gain_pct: (() => {
          const base = s[`baseline_${s.target_band}`];
          const stim = s[`stimulus_${s.target_band}`];
          return (base && stim && base > 0) ? ((stim - base) / base) * 100 : null;
        })(),
      })),
    });
  } catch (err) {
    console.error('[progress] error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/stats', async (req, res) => {
  try {
    const [{ rows: clients }, { rows: sessions }, { rows: scheduled }] = await Promise.all([
      query(`SELECT
        COUNT(*) FILTER (WHERE active) ::int AS active_clients,
        COUNT(*) FILTER (WHERE medical_clearance_status = 'cleared' AND consent_signed_at IS NOT NULL)::int AS ready_clients,
        COUNT(*) FILTER (WHERE medical_clearance_status = 'disqualified')::int AS disqualified
        FROM wellness_clients`),
      query(`SELECT
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
        COUNT(*) FILTER (WHERE status = 'stopped_early')::int AS stopped_early,
        COUNT(*) FILTER (WHERE status = 'active')::int AS active,
        COUNT(*) FILTER (WHERE status = 'completed' AND started_at > NOW() - INTERVAL '7 days')::int AS completed_7d,
        COUNT(*) FILTER (WHERE status = 'completed' AND started_at > NOW() - INTERVAL '30 days')::int AS completed_30d
        FROM wellness_sessions`),
      query(`SELECT s.id, s.scheduled_at,
                    c.first_name, c.last_name_initial,
                    p.name AS protocol_name
               FROM wellness_sessions s
               JOIN wellness_clients c ON c.id = s.client_id
               JOIN wellness_protocols p ON p.id = s.protocol_id
              WHERE s.status = 'scheduled' AND s.scheduled_at > NOW()
              ORDER BY s.scheduled_at ASC LIMIT 10`),
    ]);
    res.json({
      clients: clients[0],
      sessions: sessions[0],
      upcoming: scheduled,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
