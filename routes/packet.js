// routes/packet.js
// GET /api/sessions/:id/packet.pdf   — generates a client take-home packet

const express = require('express');
const { query } = require('../db');
const { buildPacket } = require('./packet-builder');

const router = express.Router();

router.get('/sessions/:id/packet.pdf', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'invalid session id' });
    }

    // Target session, fully hydrated (client + protocol)
    const { rows: sess } = await query(
      `SELECT s.*,
              c.first_name, c.last_name_initial, c.external_id AS client_external_id,
              p.code AS protocol_code, p.name AS protocol_name,
              p.target_band, p.target_frequency_hz, p.duration_minutes,
              p.light_intensity_pct, p.audio_type
         FROM wellness_sessions s
         JOIN wellness_clients c ON c.id = s.client_id
         JOIN wellness_protocols p ON p.id = s.protocol_id
        WHERE s.id = $1`,
      [id]
    );
    if (!sess.length) return res.status(404).json({ error: 'session not found' });
    const session = sess[0];

    // Operator observations (vocab-chip notes)
    const { rows: notes } = await query(
      `SELECT n.id, n.added_at, v.display_text, v.category
         FROM wellness_session_notes n
         JOIN wellness_coach_note_vocab v ON v.id = n.vocab_id
        WHERE n.session_id = $1
        ORDER BY n.added_at ASC`, [id]
    );

    // Full client history for trajectory chart, oldest -> newest
    const { rows: history } = await query(
      `SELECT id, status, scheduled_at, started_at, completed_at, stopped_at,
              pre_stress, pre_focus, pre_mood, post_stress, post_focus, post_mood,
              target_band_baseline, target_band_stimulus
         FROM wellness_sessions
        WHERE client_id = $1
        ORDER BY COALESCE(started_at, scheduled_at, created_at) ASC`,
      [session.client_id]
    );

    const bytes = await buildPacket({ session, notes, history });

    // Safe filename
    const dateStr = (session.completed_at || session.started_at || new Date())
      .toString().slice(0, 10);
    const safeName = `${session.first_name}_${session.last_name_initial}`
      .replace(/[^a-zA-Z0-9_]/g, '');
    const filename = `dreamsonic_packet_${safeName}_${dateStr}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(Buffer.from(bytes));
  } catch (err) {
    console.error('[packet] render error', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
