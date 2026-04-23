// routes/protocols.js
const express = require('express');
const { query } = require('../db');

const router = express.Router();

router.get('/protocols', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM wellness_protocols
        WHERE ($1::bool IS FALSE OR active = TRUE)
        ORDER BY target_frequency_hz ASC`,
      [req.query.active !== 'false']
    );
    res.json({ protocols: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/protocols/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await query(`SELECT * FROM wellness_protocols WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ protocol: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/protocols', async (req, res) => {
  try {
    const {
      code, name, target_band, target_frequency_hz, duration_minutes,
      light_intensity_pct, audio_type, ramp_in_seconds, ramp_out_seconds,
      contraindication_note, description_wellness,
    } = req.body;

    if (!code || !name || !target_band || !target_frequency_hz || !duration_minutes) {
      return res.status(400).json({ error: 'code, name, target_band, target_frequency_hz, duration_minutes required' });
    }

    const { rows } = await query(
      `INSERT INTO wellness_protocols
        (code, name, target_band, target_frequency_hz, duration_minutes,
         light_intensity_pct, audio_type, ramp_in_seconds, ramp_out_seconds,
         contraindication_note, description_wellness)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [code, name, target_band, target_frequency_hz, duration_minutes,
       light_intensity_pct ?? 50, audio_type ?? 'isochronic',
       ramp_in_seconds ?? 120, ramp_out_seconds ?? 120,
       contraindication_note || null, description_wellness || null]
    );
    res.json({ ok: true, protocol: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/protocols/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const allowed = ['name','light_intensity_pct','audio_type','ramp_in_seconds',
                     'ramp_out_seconds','contraindication_note','description_wellness','active'];
    const sets = [];
    const vals = [];
    let i = 1;
    for (const k of allowed) {
      if (k in req.body) {
        sets.push(`${k} = $${i++}`);
        vals.push(req.body[k]);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'no updatable fields provided' });
    vals.push(id);
    const { rows } = await query(
      `UPDATE wellness_protocols SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, protocol: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
