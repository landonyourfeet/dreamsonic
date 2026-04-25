// routes/match-migrate.js
//
// API for the Match & Migrate autopilot data layer.
//
// Three layers:
//   1. POST /api/sessions/:id/mm-event   — log raw events (from runner autopilot)
//   2. POST /api/sessions/:id/mm-summary — compute session summary on session end
//   3. GET  /api/clients/:id/mm-profile  — read running per-client profile
//
// The events are the raw building blocks. Summaries are aggregates per session.
// Profiles are aggregates across all of a client's sessions — that's where the
// adaptive learning lives.

'use strict';

const express = require('express');
const { query } = require('../db');

const router = express.Router();

// ============================================================================
// EVENT INGEST — runner POSTs every state transition during stimulus phase
// ============================================================================
router.post('/sessions/:id/mm-event', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    if (!Number.isFinite(sessionId)) return res.status(400).json({ error: 'invalid session id' });

    const { event_type, brain_hz, orb_hz, target_hz, lock_state, metadata } = req.body;

    // Validate event_type against our known set
    const validTypes = [
      'lock_established', 'lock_lost', 'migration_step',
      'migration_step_failed', 'target_reached', 'session_started',
      'session_ended', 'autopilot_engaged', 'autopilot_disengaged'
    ];
    if (!validTypes.includes(event_type)) {
      return res.status(400).json({ error: `invalid event_type: ${event_type}` });
    }

    // Look up client_id from the session (denormalized for fast per-client queries)
    const { rows: sRows } = await query(
      `SELECT client_id FROM wellness_sessions WHERE id = $1`, [sessionId]
    );
    if (!sRows.length) return res.status(404).json({ error: 'session not found' });
    const clientId = sRows[0].client_id;

    // Coerce numeric fields (PG accepts strings but be tidy)
    const num = v => (v == null || v === '') ? null : Number(v);

    const { rows } = await query(
      `INSERT INTO wellness_match_migrate_events
        (session_id, client_id, event_type, brain_hz, orb_hz, target_hz, lock_state, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, occurred_at`,
      [sessionId, clientId, event_type, num(brain_hz), num(orb_hz), num(target_hz),
       lock_state || null, metadata ? JSON.stringify(metadata) : null]
    );

    res.json({ ok: true, event: rows[0] });
  } catch (err) {
    console.error('[mm-event] error', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// SESSION SUMMARY — compute aggregates from the event log when session ends
// ============================================================================
router.post('/sessions/:id/mm-summary', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    if (!Number.isFinite(sessionId)) return res.status(400).json({ error: 'invalid session id' });

    const { rows: sRows } = await query(
      `SELECT id, client_id, target_frequency_hz FROM wellness_sessions WHERE id = $1`,
      [sessionId]
    );
    if (!sRows.length) return res.status(404).json({ error: 'session not found' });
    const session = sRows[0];

    // Pull all events for this session, in order
    const { rows: events } = await query(
      `SELECT * FROM wellness_match_migrate_events
        WHERE session_id = $1
        ORDER BY occurred_at ASC`,
      [sessionId]
    );

    if (events.length === 0) {
      return res.json({ ok: true, summary: null, note: 'no events to summarize' });
    }

    const summary = computeSummary(events, session);

    // UPSERT — recompute if called more than once
    const { rows: ins } = await query(
      `INSERT INTO wellness_match_migrate_summaries
        (session_id, client_id, time_to_first_lock_sec, total_locked_sec, total_session_sec,
         locked_ratio, migrations_attempted, migrations_successful,
         largest_successful_step_hz, largest_brain_deviation_hz, average_tuning_bandwidth_hz,
         target_reached, target_reached_at_sec, starting_brain_hz, final_brain_hz, target_hz)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (session_id) DO UPDATE SET
         computed_at = NOW(),
         time_to_first_lock_sec = EXCLUDED.time_to_first_lock_sec,
         total_locked_sec = EXCLUDED.total_locked_sec,
         total_session_sec = EXCLUDED.total_session_sec,
         locked_ratio = EXCLUDED.locked_ratio,
         migrations_attempted = EXCLUDED.migrations_attempted,
         migrations_successful = EXCLUDED.migrations_successful,
         largest_successful_step_hz = EXCLUDED.largest_successful_step_hz,
         largest_brain_deviation_hz = EXCLUDED.largest_brain_deviation_hz,
         average_tuning_bandwidth_hz = EXCLUDED.average_tuning_bandwidth_hz,
         target_reached = EXCLUDED.target_reached,
         target_reached_at_sec = EXCLUDED.target_reached_at_sec,
         starting_brain_hz = EXCLUDED.starting_brain_hz,
         final_brain_hz = EXCLUDED.final_brain_hz,
         target_hz = EXCLUDED.target_hz
       RETURNING *`,
      [sessionId, session.client_id,
       summary.time_to_first_lock_sec, summary.total_locked_sec, summary.total_session_sec,
       summary.locked_ratio, summary.migrations_attempted, summary.migrations_successful,
       summary.largest_successful_step_hz, summary.largest_brain_deviation_hz,
       summary.average_tuning_bandwidth_hz, summary.target_reached,
       summary.target_reached_at_sec, summary.starting_brain_hz, summary.final_brain_hz,
       summary.target_hz]
    );

    res.json({ ok: true, summary: ins[0] });
  } catch (err) {
    console.error('[mm-summary] error', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// CLIENT PROFILE — running per-client averages across all completed sessions
// ============================================================================
router.get('/clients/:clientId/mm-profile', async (req, res) => {
  try {
    const clientId = parseInt(req.params.clientId, 10);
    if (!Number.isFinite(clientId)) return res.status(400).json({ error: 'invalid client id' });

    const { rows: summaries } = await query(
      `SELECT * FROM wellness_match_migrate_summaries
        WHERE client_id = $1
        ORDER BY computed_at DESC
        LIMIT 50`,
      [clientId]
    );

    if (summaries.length === 0) {
      return res.json({
        profile: null,
        sessions_count: 0,
        note: 'no match-migrate sessions recorded yet',
      });
    }

    // Compute running averages across all summaries
    const avg = (key) => {
      const vals = summaries.map(s => Number(s[key])).filter(v => isFinite(v));
      if (vals.length === 0) return null;
      return Math.round((vals.reduce((a,b) => a+b, 0) / vals.length) * 100) / 100;
    };
    const max = (key) => {
      const vals = summaries.map(s => Number(s[key])).filter(v => isFinite(v));
      if (vals.length === 0) return null;
      return Math.max(...vals);
    };

    const profile = {
      sessions_count: summaries.length,
      avg_time_to_first_lock_sec: avg('time_to_first_lock_sec'),
      avg_locked_ratio: avg('locked_ratio'),
      avg_migration_success_rate: (() => {
        const attempted = summaries.reduce((a,s) => a + (s.migrations_attempted || 0), 0);
        const success = summaries.reduce((a,s) => a + (s.migrations_successful || 0), 0);
        return attempted > 0 ? Math.round((success / attempted) * 1000) / 1000 : null;
      })(),
      max_successful_step_hz: max('largest_successful_step_hz'),
      avg_tuning_bandwidth_hz: avg('average_tuning_bandwidth_hz'),
      target_reached_count: summaries.filter(s => s.target_reached).length,
      target_reached_rate: Math.round(
        (summaries.filter(s => s.target_reached).length / summaries.length) * 1000
      ) / 1000,
      avg_target_reached_at_sec: avg('target_reached_at_sec'),
    };

    // Suggested autopilot tuning based on this client's history.
    // After 3+ sessions, the autopilot can use the client's known parameters
    // instead of conservative defaults.
    const suggested = summaries.length >= 3 ? {
      use_personalized_params: true,
      // Suggested step size: 80% of largest successful step, capped at 0.5 Hz
      migration_step_hz: profile.max_successful_step_hz
        ? Math.min(0.5, profile.max_successful_step_hz * 0.8)
        : 0.3,
      // Suggested hold time: scaled by inverse locked_ratio (less stable = longer hold)
      migration_hold_sec: profile.avg_locked_ratio
        ? Math.round(180 / Math.max(0.5, profile.avg_locked_ratio))
        : 180,
      // Lock criterion: tighten if client locks easily, loosen if not
      lock_threshold_hz: profile.avg_time_to_first_lock_sec && profile.avg_time_to_first_lock_sec < 60
        ? 0.3 : 0.5,
    } : {
      use_personalized_params: false,
      migration_step_hz: 0.3,
      migration_hold_sec: 180,
      lock_threshold_hz: 0.4,
      note: 'using defaults — need 3+ sessions for personalization',
    };

    res.json({
      profile,
      suggested,
      recent_sessions: summaries.slice(0, 10),
    });
  } catch (err) {
    console.error('[mm-profile] error', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// SESSION EVENTS — read all events for a session (for debugging + replay)
// ============================================================================
router.get('/sessions/:id/mm-events', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const { rows } = await query(
      `SELECT * FROM wellness_match_migrate_events
        WHERE session_id = $1
        ORDER BY occurred_at ASC`,
      [sessionId]
    );
    res.json({ events: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// COMPUTE SUMMARY — pure function, given event list + session, return aggregates
// ============================================================================
function computeSummary(events, session) {
  const out = {
    time_to_first_lock_sec: null,
    total_locked_sec: 0,
    total_session_sec: null,
    locked_ratio: null,
    migrations_attempted: 0,
    migrations_successful: 0,
    largest_successful_step_hz: null,
    largest_brain_deviation_hz: null,
    average_tuning_bandwidth_hz: null,
    target_reached: false,
    target_reached_at_sec: null,
    starting_brain_hz: null,
    final_brain_hz: null,
    target_hz: Number(session.target_frequency_hz) || null,
  };

  if (events.length === 0) return out;

  const sessionStart = new Date(events[0].occurred_at).getTime();
  const sessionEnd = new Date(events[events.length - 1].occurred_at).getTime();
  out.total_session_sec = Math.round((sessionEnd - sessionStart) / 100) / 10;

  // Find first brain reading for starting Hz
  for (const e of events) {
    if (e.brain_hz != null) { out.starting_brain_hz = Number(e.brain_hz); break; }
  }
  // Find last brain reading for final Hz
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].brain_hz != null) {
      out.final_brain_hz = Number(events[i].brain_hz); break;
    }
  }

  // Time to first lock
  const firstLock = events.find(e => e.event_type === 'lock_established');
  if (firstLock) {
    out.time_to_first_lock_sec = Math.round(
      (new Date(firstLock.occurred_at).getTime() - sessionStart) / 100
    ) / 10;
  }

  // Total locked time = sum of (lock_lost.t - lock_established.t) pairs
  let lockStartT = null;
  let lockedDeviations = []; // record brain deviations during lock periods
  for (const e of events) {
    if (e.event_type === 'lock_established') {
      lockStartT = new Date(e.occurred_at).getTime();
    } else if (e.event_type === 'lock_lost' && lockStartT != null) {
      out.total_locked_sec += (new Date(e.occurred_at).getTime() - lockStartT) / 1000;
      // Record the deviation that broke lock
      if (e.brain_hz != null && e.orb_hz != null) {
        lockedDeviations.push(Math.abs(Number(e.brain_hz) - Number(e.orb_hz)));
      }
      lockStartT = null;
    }
  }
  // If we ended while locked
  if (lockStartT != null) {
    out.total_locked_sec += (sessionEnd - lockStartT) / 1000;
  }
  out.total_locked_sec = Math.round(out.total_locked_sec * 10) / 10;

  if (out.total_session_sec > 0) {
    out.locked_ratio = Math.round(
      (out.total_locked_sec / out.total_session_sec) * 1000
    ) / 1000;
  }

  // Migration counts + largest successful step
  const successfulSteps = [];
  for (const e of events) {
    if (e.event_type === 'migration_step') {
      out.migrations_attempted += 1;
      out.migrations_successful += 1;
      if (e.metadata && e.metadata.step_hz != null) {
        successfulSteps.push(Math.abs(Number(e.metadata.step_hz)));
      }
    } else if (e.event_type === 'migration_step_failed') {
      out.migrations_attempted += 1;
    }
  }
  if (successfulSteps.length > 0) {
    out.largest_successful_step_hz = Math.round(Math.max(...successfulSteps) * 100) / 100;
  }

  // Largest brain deviation that broke lock = our tuning bandwidth probe
  if (lockedDeviations.length > 0) {
    out.largest_brain_deviation_hz = Math.round(Math.max(...lockedDeviations) * 100) / 100;
    // Average tuning bandwidth = mean of deviations that broke lock
    const sum = lockedDeviations.reduce((a,b) => a+b, 0);
    out.average_tuning_bandwidth_hz = Math.round(
      (sum / lockedDeviations.length) * 100
    ) / 100;
  }

  // Target reached?
  const reachedEvent = events.find(e => e.event_type === 'target_reached');
  if (reachedEvent) {
    out.target_reached = true;
    out.target_reached_at_sec = Math.round(
      (new Date(reachedEvent.occurred_at).getTime() - sessionStart) / 100
    ) / 10;
  }

  return out;
}

module.exports = router;
