// routes/attention.js
//
// "DreamSonic Attention Check" — CPT-paradigm attention assessment.
//
// NOT the Conners CPT (trademarked). This is an original implementation of
// the continuous-performance-task paradigm (public domain since Rosvold 1956)
// used for longitudinal wellness tracking, not clinical diagnosis.
//
// No T-scores, no clinical interpretation, no comparisons to ADHD norms.
// Raw metrics only: RT, variability, omissions, commissions, accuracy.

'use strict';

const express = require('express');
const { query } = require('../db');

const router = express.Router();

// ============================================================================
// CPT Paradigm Constants
// ============================================================================

// 8-minute test, 200 trials total
const TRIAL_COUNT          = 200;
const NON_TARGET_PCT       = 0.20;  // 20% non-targets (modern Conners-3 ratio)
const ISI_OPTIONS_MS       = [1000, 2000, 4000]; // classic Conners ISI rotation
const STIMULUS_DURATION_MS = 250;                // how long each stimulus shows
const PRACTICE_TRIAL_COUNT = 10;                 // pre-test warmup, discarded

// Per-variant definitions: stimulus pool + which one is the inhibit-target
const VARIANTS = {
  letter: {
    name: 'Letter',
    stimulus_pool: ['A','B','C','D','E','F','G','H','J','K','L','M','N','P','R','S','T','U','V','W','Y'],
    non_target:    'X',
    instruction:   'Press SPACE for every letter EXCEPT X.',
  },
  shape: {
    name: 'Shape',
    stimulus_pool: ['square','triangle','diamond','pentagon','hexagon','star'],
    non_target:    'circle',
    instruction:   'Press SPACE for every shape EXCEPT the circle.',
  },
  color: {
    name: 'Color',
    stimulus_pool: ['blue','green','purple','teal','amber','cyan','white'],
    non_target:    'red',
    instruction:   'Press SPACE for every color EXCEPT red.',
  },
};
const VARIANT_KEYS = Object.keys(VARIANTS);

// ============================================================================
// Sequence Generation — server-side, seeded, not predictable by client
// ============================================================================

function generateSequence(variant) {
  const v = VARIANTS[variant];
  if (!v) throw new Error(`unknown variant: ${variant}`);

  // How many non-target (X) trials to include
  const nonTargetCount = Math.round(TRIAL_COUNT * NON_TARGET_PCT);
  const targetCount = TRIAL_COUNT - nonTargetCount;

  // Build the trial list
  const trials = [];
  for (let i = 0; i < targetCount; i++) {
    const stim = v.stimulus_pool[Math.floor(Math.random() * v.stimulus_pool.length)];
    trials.push({ stimulus: stim, is_target: true });
  }
  for (let i = 0; i < nonTargetCount; i++) {
    trials.push({ stimulus: v.non_target, is_target: false });
  }

  // Fisher-Yates shuffle — makes the sequence unpredictable
  for (let i = trials.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [trials[i], trials[j]] = [trials[j], trials[i]];
  }

  // Prevent any run of 4+ identical is_target values at the start of the test
  // (otherwise a client could form a bad habit in the first few trials)
  for (let attempts = 0; attempts < 3; attempts++) {
    let hasRun = false;
    for (let i = 0; i < Math.min(20, trials.length - 3); i++) {
      if (trials[i].is_target === trials[i+1].is_target &&
          trials[i].is_target === trials[i+2].is_target &&
          trials[i].is_target === trials[i+3].is_target) {
        hasRun = true;
        break;
      }
    }
    if (!hasRun) break;
    // Re-shuffle just the first 30 trials
    for (let i = Math.min(29, trials.length - 1); i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [trials[i], trials[j]] = [trials[j], trials[i]];
    }
  }

  // Assign ISI (inter-stimulus interval) — rotate through the three options
  for (let i = 0; i < trials.length; i++) {
    trials[i].isi_ms = ISI_OPTIONS_MS[i % ISI_OPTIONS_MS.length];
  }
  // Shuffle the ISI assignments separately so ISI and stimulus aren't coupled
  for (let i = trials.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [trials[i].isi_ms, trials[j].isi_ms] = [trials[j].isi_ms, trials[i].isi_ms];
  }

  return trials;
}

function generatePracticeSequence(variant) {
  const v = VARIANTS[variant];
  const trials = [];
  // 10 practice trials: 80% target, 20% non-target
  for (let i = 0; i < 8; i++) {
    const stim = v.stimulus_pool[Math.floor(Math.random() * v.stimulus_pool.length)];
    trials.push({ stimulus: stim, is_target: true, isi_ms: 1500 });
  }
  for (let i = 0; i < 2; i++) {
    trials.push({ stimulus: v.non_target, is_target: false, isi_ms: 1500 });
  }
  for (let i = trials.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [trials[i], trials[j]] = [trials[j], trials[i]];
  }
  return trials;
}

// In-memory store of active sequences so the server can score submissions
// accurately without trusting client-reported ground truth.
// key: assessment_id, value: trials array
const activeSequences = new Map();

// Clean up stale sequences older than 2 hours (test is 8 min so this is generous)
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, seq] of activeSequences.entries()) {
    if (seq._createdAt < cutoff) activeSequences.delete(id);
  }
}, 10 * 60 * 1000);

// ============================================================================
// ROUTES
// ============================================================================

router.post('/attention/start', async (req, res) => {
  try {
    const { client_id, session_id, operator_name, force_variant } = req.body;
    if (!Number.isInteger(client_id)) {
      return res.status(400).json({ error: 'client_id required' });
    }

    // Verify client exists and is active
    const { rows: c } = await query(
      `SELECT id, first_name, last_name_initial, active
         FROM wellness_clients WHERE id = $1`,
      [client_id]
    );
    if (!c.length) return res.status(404).json({ error: 'client not found' });
    if (!c[0].active) return res.status(400).json({ error: 'client is not active' });

    // Pick variant: random unless operator forced one
    const variant = force_variant && VARIANT_KEYS.includes(force_variant)
      ? force_variant
      : VARIANT_KEYS[Math.floor(Math.random() * VARIANT_KEYS.length)];

    // Create the assessment record
    const { rows: ins } = await query(
      `INSERT INTO wellness_attention_assessments
         (client_id, session_id, variant, operator_name)
       VALUES ($1,$2,$3,$4)
       RETURNING id, started_at`,
      [client_id, session_id || null, variant, operator_name || null]
    );

    const assessmentId = ins[0].id;
    const trials = generateSequence(variant);
    const practice = generatePracticeSequence(variant);

    // Store server-side for scoring
    activeSequences.set(assessmentId, {
      _createdAt: Date.now(),
      trials,
      practice,
      variant,
      client_id,
    });

    const variantInfo = VARIANTS[variant];
    res.json({
      ok: true,
      assessment_id: assessmentId,
      variant: variant,
      variant_name: variantInfo.name,
      instruction: variantInfo.instruction,
      non_target: variantInfo.non_target,
      practice_trials: practice,
      trials,
      stimulus_duration_ms: STIMULUS_DURATION_MS,
      started_at: ins[0].started_at,
      client_name: `${c[0].first_name} ${c[0].last_name_initial}.`,
    });
  } catch (err) {
    console.error('[attention] start error', err);
    res.status(500).json({ error: err.message });
  }
});

// Accepts the full batch of responses at the end of the test.
// Body: { responses: [{trial_index, pressed, reaction_time_ms}, ...] }
// Server reconciles against its stored trial sequence (which the client never saw raw).
router.post('/attention/:id/complete', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

    const seq = activeSequences.get(id);
    if (!seq) {
      return res.status(410).json({ error: 'assessment sequence expired or not found' });
    }

    const responses = req.body.responses;
    if (!Array.isArray(responses)) {
      return res.status(400).json({ error: 'responses array required' });
    }

    // Score server-side
    let hits = 0, omissions = 0, commissions = 0, correctRejections = 0;
    const rtValues = [];
    for (let i = 0; i < seq.trials.length; i++) {
      const trial = seq.trials[i];
      const response = responses[i] || { pressed: false, reaction_time_ms: null };

      if (trial.is_target) {
        if (response.pressed) {
          hits++;
          if (response.reaction_time_ms != null && response.reaction_time_ms > 50
              && response.reaction_time_ms < 2000) {
            rtValues.push(response.reaction_time_ms);
          }
        } else {
          omissions++;
        }
      } else {
        if (response.pressed) commissions++;
        else correctRejections++;
      }
    }

    // Compute RT statistics
    let meanRT = null, stddevRT = null, cvRT = null;
    if (rtValues.length > 0) {
      const sum = rtValues.reduce((a, b) => a + b, 0);
      meanRT = sum / rtValues.length;
      if (rtValues.length > 1) {
        const sqSum = rtValues.reduce((a, b) => a + Math.pow(b - meanRT, 2), 0);
        stddevRT = Math.sqrt(sqSum / (rtValues.length - 1));
        cvRT = stddevRT / meanRT;
      }
    }

    const totalTrials = seq.trials.length;
    const targetTrials = seq.trials.filter(t => t.is_target).length;
    const nonTargetTrials = totalTrials - targetTrials;
    const accuracyPct = ((hits + correctRejections) / totalTrials) * 100;

    // Persist
    await query(
      `UPDATE wellness_attention_assessments
          SET completed = TRUE,
              completed_at = NOW(),
              total_trials = $1,
              target_trials = $2,
              non_target_trials = $3,
              hits = $4,
              omissions = $5,
              commissions = $6,
              mean_rt_ms = $7,
              rt_stddev_ms = $8,
              rt_coefficient_var = $9,
              accuracy_pct = $10
        WHERE id = $11`,
      [totalTrials, targetTrials, nonTargetTrials, hits, omissions, commissions,
       meanRT, stddevRT, cvRT, accuracyPct, id]
    );

    // Clean up in-memory sequence
    activeSequences.delete(id);

    res.json({
      ok: true,
      assessment_id: id,
      results: {
        total_trials: totalTrials,
        target_trials: targetTrials,
        non_target_trials: nonTargetTrials,
        hits,
        omissions,
        commissions,
        correct_rejections: correctRejections,
        accuracy_pct: Math.round(accuracyPct * 100) / 100,
        mean_rt_ms: meanRT != null ? Math.round(meanRT) : null,
        rt_stddev_ms: stddevRT != null ? Math.round(stddevRT * 10) / 10 : null,
        rt_coefficient_var: cvRT != null ? Math.round(cvRT * 1000) / 1000 : null,
      },
    });
  } catch (err) {
    console.error('[attention] complete error', err);
    res.status(500).json({ error: err.message });
  }
});

// Fetch a single completed assessment
router.get('/attention/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await query(
      `SELECT * FROM wellness_attention_assessments WHERE id = $1`, [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ assessment: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full history for a client — powers the trend chart on the dossier + portal
router.get('/attention/client/:clientId/history', async (req, res) => {
  try {
    const clientId = parseInt(req.params.clientId, 10);
    const { rows } = await query(
      `SELECT id, variant, started_at, completed_at, completed,
              mean_rt_ms, rt_stddev_ms, rt_coefficient_var,
              hits, omissions, commissions, accuracy_pct
         FROM wellness_attention_assessments
        WHERE client_id = $1 AND completed = TRUE
        ORDER BY completed_at ASC`,
      [clientId]
    );
    res.json({ assessments: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Latest completed assessment for engine starting-point tuning
router.get('/attention/client/:clientId/latest', async (req, res) => {
  try {
    const clientId = parseInt(req.params.clientId, 10);
    const { rows } = await query(
      `SELECT * FROM wellness_attention_assessments
        WHERE client_id = $1 AND completed = TRUE
        ORDER BY completed_at DESC
        LIMIT 1`,
      [clientId]
    );
    if (!rows.length) return res.json({ assessment: null });
    res.json({ assessment: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Client's rolling baseline (avg of last 5 completed assessments)
// Used as the fallback when today's CPT isn't taken
router.get('/attention/client/:clientId/baseline', async (req, res) => {
  try {
    const clientId = parseInt(req.params.clientId, 10);
    const { rows } = await query(
      `SELECT AVG(mean_rt_ms) AS avg_rt,
              AVG(rt_stddev_ms) AS avg_stddev,
              AVG(rt_coefficient_var) AS avg_cv,
              AVG(omissions) AS avg_omissions,
              AVG(commissions) AS avg_commissions,
              AVG(accuracy_pct) AS avg_accuracy,
              COUNT(*) AS sample_n
         FROM (SELECT * FROM wellness_attention_assessments
                WHERE client_id = $1 AND completed = TRUE
                ORDER BY completed_at DESC LIMIT 5) recent`,
      [clientId]
    );
    res.json({ baseline: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
