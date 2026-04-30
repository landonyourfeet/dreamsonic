// routes/freeform.js
//
// Staff "Quick Start" / freeform session API. No client intake, no protocol
// selection, no clearance gate. Sessions are anonymous-staff-mode and get
// flagged is_freeform=true so they're filtered from client analytics.
//
// Used by you / Janelle / Jodi to test the system, demo for friends, train
// staff on the experience, or just play with the device on yourself.
//
// Endpoints:
//   POST /api/freeform/start       — create + activate a freeform session
//   POST /api/freeform/:id/end     — mark complete

'use strict';

const express = require('express');
const { query } = require('../db');

const router = express.Router();

// ----------------------------------------------------------------------------
// POST /api/freeform/start
//   body: { label?: string, military_mode?: boolean, eeg_device_code?: string,
//           starting_freq_hz?: number, target_band?: string }
//   returns: { session_id, redirect: '/freeform/:id' }
// ----------------------------------------------------------------------------
router.post('/freeform/start', async (req, res) => {
  try {
    const {
      label,
      military_mode,
      eeg_device_code,
      starting_freq_hz,
      target_band,
    } = req.body || {};

    // Look up the staff placeholder client + freeform protocol
    const { rows: cRows } = await query(
      `SELECT id FROM wellness_clients WHERE external_id = 'FREEFORM_STAFF_PLACEHOLDER'`
    );
    if (!cRows.length) {
      return res.status(500).json({
        error: 'Freeform placeholder client not found. Restart server to re-seed.',
      });
    }
    const clientId = cRows[0].id;

    const { rows: pRows } = await query(
      `SELECT id FROM wellness_protocols WHERE code = 'FREEFORM'`
    );
    if (!pRows.length) {
      return res.status(500).json({
        error: 'Freeform protocol not found. Restart server to re-seed.',
      });
    }
    const protocolId = pRows[0].id;

    // Coerce starting frequency - safety clamp depends on military_mode flag
    const startHz = Number(starting_freq_hz);
    let safeStartHz = isFinite(startHz) ? startHz : 10.0;
    if (!military_mode) {
      // Standard safety: 2-14 Hz
      safeStartHz = Math.max(2, Math.min(14, safeStartHz));
    } else {
      // Military mode: looser bounds, but still hard-capped at sensible
      // physical limits (1-50 Hz)
      safeStartHz = Math.max(1, Math.min(50, safeStartHz));
    }

    const { rows } = await query(
      `INSERT INTO wellness_sessions
        (client_id, protocol_id, status, started_at,
         eeg_source, eeg_device_code,
         is_freeform, freeform_label, military_mode,
         coach_staff_name)
       VALUES ($1, $2, 'active', NOW(),
               $3, $4,
               TRUE, $5, $6,
               'staff')
       RETURNING id, started_at, is_freeform, military_mode`,
      [
        clientId,
        protocolId,
        eeg_device_code === 'simulator' ? 'simulator'
          : eeg_device_code ? 'bluetooth' : 'simulator',
        eeg_device_code || null,
        label || null,
        !!military_mode,
      ]
    );

    res.json({
      session_id: rows[0].id,
      started_at: rows[0].started_at,
      is_freeform: true,
      military_mode: !!military_mode,
      starting_freq_hz: safeStartHz,
      redirect: `/session/${rows[0].id}/freeform`,
    });
  } catch (err) {
    console.error('[freeform/start]', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/freeform/:id/end
//   Marks a freeform session complete. No post-rating required.
// ----------------------------------------------------------------------------
router.post('/freeform/:id/end', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await query(
      `UPDATE wellness_sessions
          SET status = 'completed', completed_at = NOW()
        WHERE id = $1 AND is_freeform = TRUE`,
      [id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/freeform/recent
//   List recent freeform sessions for the dashboard, useful for staff to
//   see which freeform tests they've run.
// ----------------------------------------------------------------------------
router.get('/freeform/recent', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, freeform_label, started_at, completed_at, status,
              military_mode, eeg_device_code
         FROM wellness_sessions
        WHERE is_freeform = TRUE
        ORDER BY started_at DESC
        LIMIT 20`
    );
    res.json({ sessions: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
