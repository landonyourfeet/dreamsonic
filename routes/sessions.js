// routes/sessions.js
// Session lifecycle state machine.
//   scheduled -> active -> completed
//                     \-> stopped_early
//                     \-> cancelled

const express = require('express');
const { query, withTx } = require('../db');

const router = express.Router();

router.post('/sessions', async (req, res) => {
  try {
    const {
      client_id, protocol_id, scheduled_at,
      coach_staff_id, coach_staff_name, eeg_source, eeg_device_code,
    } = req.body;

    if (!client_id || !protocol_id) {
      return res.status(400).json({ error: 'client_id and protocol_id required' });
    }

    const { rows: c } = await query(
      `SELECT medical_clearance_status, consent_signed_at, active
         FROM wellness_clients WHERE id = $1`,
      [client_id]
    );
    if (!c.length) return res.status(404).json({ error: 'client not found' });
    if (!c[0].active) return res.status(400).json({ error: 'client is not active' });
    if (c[0].medical_clearance_status !== 'cleared') {
      return res.status(400).json({
        error: `client medical clearance status is '${c[0].medical_clearance_status}' — cannot schedule`,
      });
    }
    if (!c[0].consent_signed_at) {
      return res.status(400).json({ error: 'client has not signed consent — cannot schedule' });
    }

    // Device code takes precedence; fall back to legacy eeg_source enum for older clients
    const deviceCode = eeg_device_code || null;
    const legacyEegSource = deviceCode === 'simulator' ? 'simulator'
      : deviceCode ? 'bluetooth'
      : (eeg_source || 'simulator');

    // Verify device exists in registry if one was specified
    if (deviceCode) {
      const { rows: d } = await query(
        `SELECT code FROM wellness_eeg_devices WHERE code = $1 AND active = TRUE`,
        [deviceCode]
      );
      if (!d.length) {
        return res.status(400).json({ error: `unknown EEG device code: ${deviceCode}` });
      }
    }

    const { rows } = await query(
      `INSERT INTO wellness_sessions
        (client_id, protocol_id, coach_staff_id, coach_staff_name,
         scheduled_at, eeg_source, eeg_device_code, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'scheduled')
       RETURNING *`,
      [client_id, protocol_id, coach_staff_id || null, coach_staff_name || null,
       scheduled_at || null, legacyEegSource, deviceCode]
    );

    res.json({ ok: true, session: rows[0] });
  } catch (err) {
    console.error('[sessions] create error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/sessions', async (req, res) => {
  try {
    const status = req.query.status || null;
    const clientId = req.query.client_id ? parseInt(req.query.client_id, 10) : null;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);

    const conditions = [];
    const params = [];
    let i = 1;
    if (status) { conditions.push(`s.status = $${i++}`); params.push(status); }
    if (clientId) { conditions.push(`s.client_id = $${i++}`); params.push(clientId); }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const { rows } = await query(
      `SELECT s.*,
              c.first_name, c.last_name_initial, c.external_id,
              p.name AS protocol_name, p.target_band, p.target_frequency_hz, p.duration_minutes
         FROM wellness_sessions s
         JOIN wellness_clients c ON c.id = s.client_id
         JOIN wellness_protocols p ON p.id = s.protocol_id
         ${whereClause}
        ORDER BY COALESCE(s.started_at, s.scheduled_at, s.created_at) DESC
        LIMIT $${i}`,
      params
    );
    res.json({ sessions: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/sessions/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: sess } = await query(
      `SELECT s.*,
              c.first_name, c.last_name_initial, c.external_id AS client_external_id,
              c.medical_clearance_status, c.consent_signed_at,
              p.code AS protocol_code, p.name AS protocol_name,
              p.target_band, p.target_frequency_hz, p.duration_minutes,
              p.light_intensity_pct, p.audio_type,
              p.ramp_in_seconds, p.ramp_out_seconds, p.description_wellness
         FROM wellness_sessions s
         JOIN wellness_clients c ON c.id = s.client_id
         JOIN wellness_protocols p ON p.id = s.protocol_id
        WHERE s.id = $1`,
      [id]
    );
    if (!sess.length) return res.status(404).json({ error: 'not found' });

    const { rows: events } = await query(
      `SELECT * FROM wellness_session_events
        WHERE session_id = $1 ORDER BY event_timestamp ASC`, [id]
    );

    const { rows: notes } = await query(
      `SELECT n.id, n.added_by, n.added_at, v.code, v.display_text, v.category
         FROM wellness_session_notes n
         JOIN wellness_coach_note_vocab v ON v.id = n.vocab_id
        WHERE n.session_id = $1
        ORDER BY n.added_at ASC`, [id]
    );

    res.json({ session: sess[0], events, notes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sessions/:id/start', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { pre_stress, pre_focus, pre_mood } = req.body;

    const result = await withTx(async (c) => {
      const { rows: check } = await c.query(
        `SELECT s.status,
                cli.medical_clearance_status, cli.consent_signed_at
           FROM wellness_sessions s
           JOIN wellness_clients cli ON cli.id = s.client_id
          WHERE s.id = $1`, [id]
      );
      if (!check.length) throw Object.assign(new Error('session not found'), { http: 404 });
      if (check[0].status !== 'scheduled') {
        throw Object.assign(new Error(`session status is '${check[0].status}' — cannot start`), { http: 400 });
      }
      if (check[0].medical_clearance_status !== 'cleared') {
        throw Object.assign(new Error('client medical clearance not current'), { http: 400 });
      }
      if (!check[0].consent_signed_at) {
        throw Object.assign(new Error('client consent not on file'), { http: 400 });
      }

      const { rows } = await c.query(
        `UPDATE wellness_sessions
            SET status = 'active', started_at = NOW(),
                pre_stress = $1, pre_focus = $2, pre_mood = $3
          WHERE id = $4
          RETURNING *`,
        [pre_stress || null, pre_focus || null, pre_mood || null, id]
      );

      await c.query(
        `INSERT INTO wellness_session_events (session_id, event_type, metadata)
         VALUES ($1, 'session_started', $2::jsonb)`,
        [id, JSON.stringify({ pre_stress, pre_focus, pre_mood })]
      );

      return rows[0];
    });

    res.json({ ok: true, session: result });
  } catch (err) {
    console.error('[sessions] start error', err);
    res.status(err.http || 500).json({ error: err.message });
  }
});

router.post('/sessions/:id/phase', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { phase, band_powers, metadata } = req.body;

    if (!['baseline', 'stimulus', 'cooldown'].includes(phase)) {
      return res.status(400).json({ error: 'phase must be baseline|stimulus|cooldown' });
    }
    const bp = band_powers || {};
    const prefix = phase;

    await withTx(async (c) => {
      await c.query(
        `UPDATE wellness_sessions
            SET ${prefix}_delta = $1, ${prefix}_theta = $2, ${prefix}_alpha = $3,
                ${prefix}_smr   = $4, ${prefix}_beta  = $5, ${prefix}_gamma = $6
          WHERE id = $7`,
        [bp.delta ?? null, bp.theta ?? null, bp.alpha ?? null,
         bp.smr ?? null, bp.beta ?? null, bp.gamma ?? null, id]
      );

      await c.query(
        `INSERT INTO wellness_session_events (session_id, event_type, metadata)
         VALUES ($1, $2, $3::jsonb)`,
        [id, `phase_complete_${phase}`, JSON.stringify({ band_powers: bp, ...metadata })]
      );
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[sessions] phase error', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/sessions/:id/complete', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { post_stress, post_focus, post_mood, note_vocab_ids, coach_name } = req.body;

    const result = await withTx(async (c) => {
      const { rows } = await c.query(
        `UPDATE wellness_sessions
            SET status = 'completed', completed_at = NOW(),
                post_stress = $1, post_focus = $2, post_mood = $3
          WHERE id = $4
          RETURNING *`,
        [post_stress || null, post_focus || null, post_mood || null, id]
      );

      if (Array.isArray(note_vocab_ids)) {
        for (const vid of note_vocab_ids) {
          await c.query(
            `INSERT INTO wellness_session_notes (session_id, vocab_id, added_by)
             VALUES ($1,$2,$3)`,
            [id, vid, coach_name || null]
          );
        }
      }

      await c.query(
        `INSERT INTO wellness_session_events (session_id, event_type, metadata)
         VALUES ($1, 'session_completed', $2::jsonb)`,
        [id, JSON.stringify({ post_stress, post_focus, post_mood, note_vocab_ids })]
      );

      return rows[0];
    });

    res.json({ ok: true, session: result });
  } catch (err) {
    console.error('[sessions] complete error', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/sessions/:id/stop', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { stop_reason_code, post_stress, post_focus, post_mood } = req.body;

    const result = await withTx(async (c) => {
      const { rows } = await c.query(
        `UPDATE wellness_sessions
            SET status = 'stopped_early', client_stopped_early = TRUE,
                stop_reason_code = $1, completed_at = NOW(),
                post_stress = $2, post_focus = $3, post_mood = $4
          WHERE id = $5 AND status = 'active'
          RETURNING *`,
        [stop_reason_code || 'unspecified',
         post_stress || null, post_focus || null, post_mood || null, id]
      );
      if (!rows.length) throw Object.assign(new Error('session not active'), { http: 400 });

      await c.query(
        `INSERT INTO wellness_session_events (session_id, event_type, metadata)
         VALUES ($1, 'session_stopped_early', $2::jsonb)`,
        [id, JSON.stringify({ stop_reason_code, post_stress, post_focus, post_mood })]
      );
      return rows[0];
    });

    res.json({ ok: true, session: result });
  } catch (err) {
    console.error('[sessions] stop error', err);
    res.status(err.http || 500).json({ error: err.message });
  }
});

router.post('/sessions/:id/event', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { event_type, metadata } = req.body;
    if (!event_type) return res.status(400).json({ error: 'event_type required' });
    await query(
      `INSERT INTO wellness_session_events (session_id, event_type, metadata)
       VALUES ($1,$2,$3::jsonb)`,
      [id, event_type, JSON.stringify(metadata || {})]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/vocab', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, code, display_text, category, sort_order
         FROM wellness_coach_note_vocab
        WHERE active = TRUE
        ORDER BY sort_order ASC, id ASC`
    );
    res.json({ vocab: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
