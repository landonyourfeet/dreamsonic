// schema.js — self-initializing schema.
// Every table guarded by IF NOT EXISTS. Safe to run on every boot.
//
// Naming: wellness_* prefix kept for namespace clarity and future-proofing.
// Design: DOB stored as month/year only. Free-text coach notes forbidden by
// the constrained vocabulary join table — intentional legal discipline.

const { query } = require('./db');

const STATEMENTS = [
  `CREATE EXTENSION IF NOT EXISTS "pgcrypto"`,

  `CREATE TABLE IF NOT EXISTS wellness_clients (
    id                       SERIAL PRIMARY KEY,
    external_id              UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    first_name               TEXT NOT NULL,
    last_name_initial        CHAR(1) NOT NULL,
    dob_month                INTEGER CHECK (dob_month BETWEEN 1 AND 12),
    dob_year                 INTEGER CHECK (dob_year BETWEEN 1900 AND 2100),
    email                    TEXT,
    phone                    TEXT,
    consent_signed_at        TIMESTAMPTZ,
    consent_version          TEXT,
    medical_clearance_status TEXT NOT NULL DEFAULT 'pending'
                             CHECK (medical_clearance_status IN ('pending','cleared','disqualified','expired')),
    medical_clearance_date   DATE,
    general_notes            TEXT,
    active                   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wellness_clients_external
     ON wellness_clients(external_id)`,
  `CREATE INDEX IF NOT EXISTS idx_wellness_clients_active
     ON wellness_clients(active) WHERE active = TRUE`,

  `CREATE TABLE IF NOT EXISTS wellness_medical_screenings (
    id                         SERIAL PRIMARY KEY,
    client_id                  INTEGER NOT NULL REFERENCES wellness_clients(id) ON DELETE CASCADE,
    photosensitive_history     BOOLEAN NOT NULL,
    seizure_history            BOOLEAN NOT NULL,
    concussion_history_2yr     BOOLEAN NOT NULL,
    psychoactive_meds          BOOLEAN NOT NULL,
    pregnant                   BOOLEAN NOT NULL,
    cardiac_condition          BOOLEAN NOT NULL,
    under_18                   BOOLEAN NOT NULL,
    acute_intoxication         BOOLEAN NOT NULL,
    client_stated_no_concerns  BOOLEAN NOT NULL,
    disqualified               BOOLEAN NOT NULL,
    disqualified_reason_code   TEXT,
    screened_by_staff_id       INTEGER,
    screened_by_staff_name     TEXT,
    screened_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wellness_screenings_client
     ON wellness_medical_screenings(client_id, screened_at DESC)`,

  `CREATE TABLE IF NOT EXISTS wellness_consent_records (
    id                SERIAL PRIMARY KEY,
    client_id         INTEGER NOT NULL REFERENCES wellness_clients(id) ON DELETE CASCADE,
    consent_version   TEXT NOT NULL,
    consent_text_hash TEXT NOT NULL,
    signature_name    TEXT NOT NULL,
    signature_ip      TEXT,
    signed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    witnessed_by      TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wellness_consent_client
     ON wellness_consent_records(client_id, signed_at DESC)`,

  `CREATE TABLE IF NOT EXISTS wellness_protocols (
    id                   SERIAL PRIMARY KEY,
    code                 TEXT NOT NULL UNIQUE,
    name                 TEXT NOT NULL,
    target_band          TEXT NOT NULL CHECK (target_band IN ('delta','theta','alpha','smr','beta','gamma')),
    target_frequency_hz  NUMERIC(5,2) NOT NULL,
    duration_minutes     INTEGER NOT NULL CHECK (duration_minutes BETWEEN 5 AND 60),
    light_intensity_pct  INTEGER NOT NULL DEFAULT 50 CHECK (light_intensity_pct BETWEEN 0 AND 100),
    audio_type           TEXT NOT NULL DEFAULT 'isochronic' CHECK (audio_type IN ('binaural','isochronic','none')),
    ramp_in_seconds      INTEGER NOT NULL DEFAULT 120,
    ramp_out_seconds     INTEGER NOT NULL DEFAULT 120,
    contraindication_note TEXT,
    description_wellness TEXT,
    active               BOOLEAN NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // EEG device registry — add new headset vendors by INSERT, no code change.
  // channel_map is ordered 10-20 electrode names matching the device's raw
  // channel index so the analysis engine can map semantic roles (left temporal,
  // right frontal, etc.) without hardcoding any specific device.
  `CREATE TABLE IF NOT EXISTS wellness_eeg_devices (
    code                  TEXT PRIMARY KEY,
    display_name          TEXT NOT NULL,
    vendor                TEXT,
    channel_count         INTEGER NOT NULL,
    channel_map           JSONB NOT NULL,
    sample_rate_hz        INTEGER NOT NULL,
    max_safe_amplitude_uv INTEGER NOT NULL DEFAULT 200,
    frontal_available     BOOLEAN NOT NULL DEFAULT FALSE,
    connection_type       TEXT NOT NULL DEFAULT 'bluetooth'
                          CHECK (connection_type IN ('bluetooth','usb','simulator','network')),
    driver_module         TEXT,
    notes                 TEXT,
    active                BOOLEAN NOT NULL DEFAULT TRUE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wellness_eeg_devices_active
     ON wellness_eeg_devices(active) WHERE active = TRUE`,

  `CREATE TABLE IF NOT EXISTS wellness_sessions (
    id                    SERIAL PRIMARY KEY,
    client_id             INTEGER NOT NULL REFERENCES wellness_clients(id),
    protocol_id           INTEGER NOT NULL REFERENCES wellness_protocols(id),
    coach_staff_id        INTEGER,
    coach_staff_name      TEXT,
    scheduled_at          TIMESTAMPTZ,
    started_at            TIMESTAMPTZ,
    completed_at          TIMESTAMPTZ,
    status                TEXT NOT NULL DEFAULT 'scheduled'
                          CHECK (status IN ('scheduled','active','completed','stopped_early','cancelled')),

    pre_stress            INTEGER CHECK (pre_stress BETWEEN 1 AND 10),
    pre_focus             INTEGER CHECK (pre_focus BETWEEN 1 AND 10),
    pre_mood              INTEGER CHECK (pre_mood BETWEEN 1 AND 10),
    post_stress           INTEGER CHECK (post_stress BETWEEN 1 AND 10),
    post_focus            INTEGER CHECK (post_focus BETWEEN 1 AND 10),
    post_mood             INTEGER CHECK (post_mood BETWEEN 1 AND 10),

    baseline_delta        NUMERIC, baseline_theta NUMERIC, baseline_alpha NUMERIC,
    baseline_smr          NUMERIC, baseline_beta  NUMERIC, baseline_gamma NUMERIC,

    stimulus_delta        NUMERIC, stimulus_theta NUMERIC, stimulus_alpha NUMERIC,
    stimulus_smr          NUMERIC, stimulus_beta  NUMERIC, stimulus_gamma NUMERIC,

    cooldown_delta        NUMERIC, cooldown_theta NUMERIC, cooldown_alpha NUMERIC,
    cooldown_smr          NUMERIC, cooldown_beta  NUMERIC, cooldown_gamma NUMERIC,

    client_stopped_early  BOOLEAN NOT NULL DEFAULT FALSE,
    stop_reason_code      TEXT,
    eeg_source            TEXT NOT NULL DEFAULT 'simulator'
                          CHECK (eeg_source IN ('simulator','bluetooth','other')),
    raw_eeg_file_ref      TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wellness_sessions_client_date
     ON wellness_sessions(client_id, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_wellness_sessions_status
     ON wellness_sessions(status) WHERE status IN ('scheduled','active')`,

  `CREATE TABLE IF NOT EXISTS wellness_session_events (
    id               SERIAL PRIMARY KEY,
    session_id       INTEGER NOT NULL REFERENCES wellness_sessions(id) ON DELETE CASCADE,
    event_type       TEXT NOT NULL,
    event_timestamp  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata         JSONB
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wellness_events_session
     ON wellness_session_events(session_id, event_timestamp)`,

  `CREATE TABLE IF NOT EXISTS wellness_coach_note_vocab (
    id           SERIAL PRIMARY KEY,
    code         TEXT NOT NULL UNIQUE,
    display_text TEXT NOT NULL,
    category     TEXT,
    active       BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order   INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS wellness_session_notes (
    id         SERIAL PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES wellness_sessions(id) ON DELETE CASCADE,
    vocab_id   INTEGER NOT NULL REFERENCES wellness_coach_note_vocab(id),
    added_by   TEXT,
    added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wellness_session_notes_session
     ON wellness_session_notes(session_id)`,

  // Attention Check assessments (CPT-paradigm).
  // Raw metrics only — never stored as T-scores or clinical likelihood values.
  // session_id is nullable so clients can take baseline tests outside a session.
  `CREATE TABLE IF NOT EXISTS wellness_attention_assessments (
    id                    SERIAL PRIMARY KEY,
    client_id             INTEGER NOT NULL REFERENCES wellness_clients(id) ON DELETE CASCADE,
    session_id            INTEGER REFERENCES wellness_sessions(id) ON DELETE SET NULL,
    variant               TEXT NOT NULL CHECK (variant IN ('letter','shape','color')),
    started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at          TIMESTAMPTZ,
    completed             BOOLEAN NOT NULL DEFAULT FALSE,
    total_trials          INTEGER,
    target_trials         INTEGER,
    non_target_trials     INTEGER,
    hits                  INTEGER,
    omissions             INTEGER,
    commissions           INTEGER,
    mean_rt_ms            NUMERIC(7,2),
    rt_stddev_ms          NUMERIC(7,2),
    rt_coefficient_var    NUMERIC(5,3),
    accuracy_pct          NUMERIC(5,2),
    operator_name         TEXT,
    metadata              JSONB
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wellness_attention_client
     ON wellness_attention_assessments(client_id, completed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_wellness_attention_session
     ON wellness_attention_assessments(session_id) WHERE session_id IS NOT NULL`,

  // Match-and-Migrate event log — raw event stream from the autopilot.
  // Every state transition during a session creates a row. Aggregates
  // computed after session end go into wellness_match_migrate_summaries.
  `CREATE TABLE IF NOT EXISTS wellness_match_migrate_events (
    id              SERIAL PRIMARY KEY,
    session_id      INTEGER NOT NULL REFERENCES wellness_sessions(id) ON DELETE CASCADE,
    client_id       INTEGER NOT NULL REFERENCES wellness_clients(id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL CHECK (event_type IN (
      'lock_established', 'lock_lost', 'migration_step',
      'migration_step_failed', 'target_reached', 'session_started',
      'session_ended', 'autopilot_engaged', 'autopilot_disengaged'
    )),
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    brain_hz        NUMERIC(5,2),
    orb_hz          NUMERIC(5,2),
    target_hz       NUMERIC(5,2),
    lock_state      TEXT,
    metadata        JSONB
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mm_events_session
     ON wellness_match_migrate_events(session_id, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_mm_events_client
     ON wellness_match_migrate_events(client_id, occurred_at DESC)`,

  // Per-session summary — computed after session_ended event arrives.
  // Captures the headline metrics for this session at a glance.
  `CREATE TABLE IF NOT EXISTS wellness_match_migrate_summaries (
    id                          SERIAL PRIMARY KEY,
    session_id                  INTEGER NOT NULL UNIQUE REFERENCES wellness_sessions(id) ON DELETE CASCADE,
    client_id                   INTEGER NOT NULL REFERENCES wellness_clients(id) ON DELETE CASCADE,
    computed_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    time_to_first_lock_sec      NUMERIC(7,1),
    total_locked_sec            NUMERIC(7,1),
    total_session_sec           NUMERIC(7,1),
    locked_ratio                NUMERIC(5,3),
    migrations_attempted        INTEGER,
    migrations_successful       INTEGER,
    largest_successful_step_hz  NUMERIC(4,2),
    largest_brain_deviation_hz  NUMERIC(4,2),
    average_tuning_bandwidth_hz NUMERIC(4,2),
    target_reached              BOOLEAN,
    target_reached_at_sec       NUMERIC(7,1),
    starting_brain_hz           NUMERIC(5,2),
    final_brain_hz              NUMERIC(5,2),
    target_hz                   NUMERIC(5,2)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mm_summaries_client
     ON wellness_match_migrate_summaries(client_id, computed_at DESC)`,

  // Late-added columns — idempotent, safe on every boot.
  // eeg_device_code ties a session to a specific device in the registry.
  // Existing sessions predating this column keep their legacy eeg_source text.
  `ALTER TABLE wellness_sessions
     ADD COLUMN IF NOT EXISTS eeg_device_code TEXT REFERENCES wellness_eeg_devices(code)`,

  // Per-protocol safety cap on how far the autopilot is allowed to move
  // a brain in a single session. Default 4 Hz prevents aggressive shifts.
  // Combined with start-where-brain-is logic, this means a session targets
  // the SIGNED MIN(brain_baseline ± max_freq_shift, protocol_target).
  `ALTER TABLE wellness_protocols
     ADD COLUMN IF NOT EXISTS max_freq_shift NUMERIC(4,2) NOT NULL DEFAULT 4.0`,

  // Computed per-session target — set by the runner once baseline phase
  // ends, capturing the actual destination for this client this session.
  // = baseline_brain_hz + signed_step toward protocol target_frequency_hz,
  // clamped by protocol max_freq_shift.
  `ALTER TABLE wellness_sessions
     ADD COLUMN IF NOT EXISTS baseline_brain_hz NUMERIC(5,2)`,
  `ALTER TABLE wellness_sessions
     ADD COLUMN IF NOT EXISTS computed_target_hz NUMERIC(5,2)`,

  // Freeform staff sessions - no client, no protocol, manual control.
  // Filter these out of client analytics + reports.
  `ALTER TABLE wellness_sessions
     ADD COLUMN IF NOT EXISTS is_freeform BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE wellness_sessions
     ADD COLUMN IF NOT EXISTS freeform_label TEXT`,
  `ALTER TABLE wellness_sessions
     ADD COLUMN IF NOT EXISTS military_mode BOOLEAN NOT NULL DEFAULT FALSE`,
];

async function init() {
  console.log('[schema] initializing...');
  for (const sql of STATEMENTS) {
    try {
      await query(sql);
    } catch (err) {
      console.error('[schema] failed on:', sql.slice(0, 80) + '...');
      throw err;
    }
  }
  console.log('[schema] ready');
}

module.exports = { init };
