// routes/clients.js
// Client lifecycle endpoints: create, read, update, screening, consent.

const express = require('express');
const crypto = require('crypto');
const { query, withTx } = require('../db');

const router = express.Router();

// Consent text version — bump this whenever the text changes below.
// Every signature stores a SHA-256 hash of the text it signed, so historical
// versions remain traceable even after text updates.
const CONSENT_VERSION = 'dreamsonic-v1.0.0-2026';
const CONSENT_TEXT = `
DREAMSONIC — WELLNESS SERVICES CONSENT

1. NATURE OF SERVICE. The brainwave-tracking and sensory-entrainment sessions offered by DreamSonic are WELLNESS and PERFORMANCE services. They are NOT medical care, psychotherapy, counseling, or treatment for any diagnosed or undiagnosed condition.

2. NO MEDICAL CLAIMS. No representation is made that these sessions diagnose, prevent, cure, treat, or mitigate any disease, disorder, or mental-health condition. If the client is experiencing symptoms of a medical or psychological condition, the client is directed to consult a licensed healthcare provider.

3. EQUIPMENT. The BrainBit EEG headband is a consumer / research-grade device, not FDA-cleared for clinical diagnosis. It measures electrical activity at the scalp for self-regulation feedback only.

4. PHOTIC STIMULUS RISK. Light-flicker stimulation can, in rare cases, trigger seizures in photosensitive individuals. Client confirms accurate completion of medical screening. Client may stop the session at any time by verbal request, pressing the stop control, or simply removing the headphones and eye-shield.

5. VOLUNTARY PARTICIPATION. Participation is entirely voluntary. This service stands apart from any other relationship, commercial or otherwise, that the client may have with DreamSonic staff or with any affiliated entity. Specifically, participation is in no way conditioned upon, or related to, any tenant, rental, lease, employment, or payment status the client may have with any other entity, regardless of shared ownership or personnel. Declining or discontinuing this service has zero effect on any such separate matters.

6. DATA. Session metrics (band power summaries, self-reported ratings) and raw EEG recordings are stored solely for the purpose of the client's own wellness tracking. Client data is not shared with any outside party, employer, landlord, or affiliated entity without explicit written authorization from the client.

7. NO PROVIDER-PATIENT RELATIONSHIP. Nothing in this engagement creates a doctor-patient, therapist-client, counselor-client, or other clinical relationship. DreamSonic coaches are not licensed healthcare providers and do not provide clinical services in this context.

8. ACKNOWLEDGMENT. By signing below, client acknowledges reading and understanding each of the above clauses, confirms that responses given on the medical screening were accurate to the best of the client's knowledge, and consents to participate in the DreamSonic sessions on the terms stated herein.
`.trim();

function computeConsentHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

router.get('/consent-text', (req, res) => {
  res.json({
    version: CONSENT_VERSION,
    hash: computeConsentHash(CONSENT_TEXT),
    text: CONSENT_TEXT,
  });
});

router.post('/clients', async (req, res) => {
  try {
    const { first_name, last_name_initial, dob_month, dob_year, email, phone, general_notes } = req.body;

    if (!first_name || !last_name_initial) {
      return res.status(400).json({ error: 'first_name and last_name_initial required' });
    }
    if (last_name_initial.length !== 1) {
      return res.status(400).json({ error: 'last_name_initial must be exactly 1 character' });
    }

    const { rows } = await query(
      `INSERT INTO wellness_clients
         (first_name, last_name_initial, dob_month, dob_year, email, phone, general_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [first_name.trim(), last_name_initial.toUpperCase(),
       dob_month || null, dob_year || null,
       email || null, phone || null, general_notes || null]
    );

    res.json({ ok: true, client: rows[0] });
  } catch (err) {
    console.error('[clients] create error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/clients', async (req, res) => {
  try {
    const activeOnly = req.query.active !== 'false';
    const { rows } = await query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM wellness_sessions s
                WHERE s.client_id = c.id AND s.status = 'completed')::int AS completed_sessions,
              (SELECT MAX(started_at) FROM wellness_sessions s
                WHERE s.client_id = c.id) AS last_session_at
         FROM wellness_clients c
        WHERE ($1::bool IS FALSE OR c.active = TRUE)
        ORDER BY c.created_at DESC`,
      [activeOnly]
    );
    res.json({ clients: rows });
  } catch (err) {
    console.error('[clients] list error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/clients/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });

    const { rows: clientRows } = await query(
      `SELECT * FROM wellness_clients WHERE id = $1`, [id]
    );
    if (!clientRows.length) return res.status(404).json({ error: 'not found' });

    const { rows: screening } = await query(
      `SELECT * FROM wellness_medical_screenings WHERE client_id = $1
       ORDER BY screened_at DESC LIMIT 1`, [id]
    );

    const { rows: consent } = await query(
      `SELECT id, consent_version, signature_name, signed_at
         FROM wellness_consent_records WHERE client_id = $1
        ORDER BY signed_at DESC LIMIT 1`, [id]
    );

    const { rows: sessions } = await query(
      `SELECT s.*, p.name AS protocol_name, p.target_band, p.target_frequency_hz
         FROM wellness_sessions s
         JOIN wellness_protocols p ON p.id = s.protocol_id
        WHERE s.client_id = $1
        ORDER BY COALESCE(s.started_at, s.scheduled_at, s.created_at) DESC`,
      [id]
    );

    res.json({
      client: clientRows[0],
      latest_screening: screening[0] || null,
      latest_consent: consent[0] || null,
      sessions,
    });
  } catch (err) {
    console.error('[clients] get error', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/clients/:id/screening', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const {
      photosensitive_history, seizure_history, concussion_history_2yr,
      psychoactive_meds, pregnant, cardiac_condition,
      under_18, acute_intoxication, client_stated_no_concerns,
      screened_by_staff_id, screened_by_staff_name,
    } = req.body;

    const disqualReasons = [];
    if (photosensitive_history) disqualReasons.push('photosensitive_history');
    if (seizure_history) disqualReasons.push('seizure_history');
    if (under_18) disqualReasons.push('minor');
    if (acute_intoxication) disqualReasons.push('acute_intoxication');
    if (!client_stated_no_concerns) disqualReasons.push('concerns_raised');

    const disqualified = disqualReasons.length > 0;

    const result = await withTx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO wellness_medical_screenings
          (client_id, photosensitive_history, seizure_history, concussion_history_2yr,
           psychoactive_meds, pregnant, cardiac_condition, under_18, acute_intoxication,
           client_stated_no_concerns, disqualified, disqualified_reason_code,
           screened_by_staff_id, screened_by_staff_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [id, !!photosensitive_history, !!seizure_history, !!concussion_history_2yr,
         !!psychoactive_meds, !!pregnant, !!cardiac_condition, !!under_18, !!acute_intoxication,
         !!client_stated_no_concerns, disqualified,
         disqualReasons.join(',') || null,
         screened_by_staff_id || null, screened_by_staff_name || null]
      );

      await c.query(
        `UPDATE wellness_clients
            SET medical_clearance_status = $1,
                medical_clearance_date = CURRENT_DATE,
                updated_at = NOW()
          WHERE id = $2`,
        [disqualified ? 'disqualified' : 'cleared', id]
      );

      return rows[0];
    });

    res.json({ ok: true, screening: result, disqualified, disqualified_reasons: disqualReasons });
  } catch (err) {
    console.error('[clients] screening error', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/clients/:id/consent', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { signature_name, consent_version, witnessed_by } = req.body;

    if (!signature_name || signature_name.trim().length < 3) {
      return res.status(400).json({ error: 'signature_name required (full name)' });
    }
    if (consent_version !== CONSENT_VERSION) {
      return res.status(400).json({ error: `consent version mismatch; current is ${CONSENT_VERSION}` });
    }

    const hash = computeConsentHash(CONSENT_TEXT);
    const ip = req.headers['x-forwarded-for'] || req.ip || null;

    const result = await withTx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO wellness_consent_records
          (client_id, consent_version, consent_text_hash, signature_name, signature_ip, witnessed_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [id, consent_version, hash, signature_name.trim(), ip, witnessed_by || null]
      );

      await c.query(
        `UPDATE wellness_clients
            SET consent_signed_at = NOW(),
                consent_version = $1,
                updated_at = NOW()
          WHERE id = $2`,
        [consent_version, id]
      );

      return rows[0];
    });

    res.json({ ok: true, consent: result });
  } catch (err) {
    console.error('[clients] consent error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/clients/:id/readiness', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await query(
      `SELECT medical_clearance_status, consent_signed_at FROM wellness_clients WHERE id = $1`, [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const c = rows[0];
    const ready = c.medical_clearance_status === 'cleared' && !!c.consent_signed_at;
    res.json({
      ready,
      medical_clearance_status: c.medical_clearance_status,
      consent_signed: !!c.consent_signed_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.CONSENT_VERSION = CONSENT_VERSION;
module.exports.CONSENT_TEXT = CONSENT_TEXT;
