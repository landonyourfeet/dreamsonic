// routes/devices.js
//
// Registry-backed lookup for EEG device options.
// Populates the schedule modal dropdown so adding a new device (Muse, OpenBCI)
// is a matter of INSERT INTO wellness_eeg_devices, not a code change.

'use strict';

const express = require('express');
const { query } = require('../db');

const router = express.Router();

// List all active devices — used by the schedule modal dropdown
router.get('/devices', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT code, display_name, vendor, channel_count, sample_rate_hz,
              connection_type, frontal_available
         FROM wellness_eeg_devices
        WHERE active = TRUE
        ORDER BY
          CASE connection_type WHEN 'simulator' THEN 0 ELSE 1 END,
          display_name ASC`
    );
    res.json({ devices: rows });
  } catch (err) {
    console.error('[devices] list error', err);
    res.status(500).json({ error: err.message });
  }
});

// Get a single device by code (used by runner to show device info during session)
router.get('/devices/:code', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM wellness_eeg_devices WHERE code = $1 AND active = TRUE`,
      [req.params.code]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ device: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
