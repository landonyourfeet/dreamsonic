# DreamSonic

EEG-guided sound and light wellness sessions. A standalone coaching platform
for brainwave self-regulation training, operated under a strict wellness /
performance scope.

---

## What this is

- A Node.js / Express / Postgres web app
- Runs on Railway at **dreamsonic.org**
- Coaches run sessions with BrainBit EEG headbands (or a built-in simulator)
- Six preset entrainment protocols targeting different brainwave bands
- Per-client intake, medical screening, versioned consent, and a progress dashboard

## What this is NOT

- Not medical treatment, therapy, or counseling
- Not FDA-cleared for any clinical purpose
- Not a diagnostic tool
- Not connected to or conditioned upon any housing, employment, or commercial relationship

## Architecture at a glance

```
Browser (coach laptop, Chrome)
    │
    │   HTTPS
    ▼
Railway Web Service  ──────────►  Railway Postgres
  server.js (Express)              wellness_* tables
  routes/*.js (API)                (self-bootstraps on boot)
  public/*.html (UI)
```

The **EEG adapter is browser-side** (Web Bluetooth) — the server never touches
Bluetooth. This means every coach device is self-sufficient; no on-premise
hardware to provision.

## Getting started

See [DEPLOY.md](./DEPLOY.md) for the full Railway setup.

Local dev:

```bash
npm install
cp .env.example .env       # then edit DATABASE_URL
npm start
```

Then open http://localhost:3000

## Folder layout

```
server.js             ← Express entry point
db.js                 ← Postgres pool
schema.js             ← CREATE TABLE IF NOT EXISTS (self-bootstraps)
seed-data.js          ← Default protocols + coach-note vocabulary
views.js              ← HTML page routes + static assets
routes/
  clients.js          ← Intake, screening, consent
  protocols.js        ← Protocol CRUD
  sessions.js         ← Session lifecycle state machine
  progress.js         ← Client dashboard + admin stats
public/
  eeg-source.js       ← Adapter-agnostic EEG (simulator + BrainBit BT)
  coach-dashboard.html
  intake.html
  session-runner.html
  client-detail.html
  client-progress.html
```

## Legal posture

The module's language, data model, and flow are purposely engineered to keep
the service on the wellness / performance side of the line. Key protections:

- Consent text is versioned and SHA-256 hashed on every signature
- No clinical language anywhere in the UI ("clients" not "patients", "training" not "treatment")
- Coach notes are a constrained vocabulary — free text is intentionally unsupported
- Screening auto-disqualifies on photosensitive history, seizure history, minors, acute intoxication
- Participation is explicitly decoupled from any other commercial relationship in the consent text
