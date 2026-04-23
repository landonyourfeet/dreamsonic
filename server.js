// server.js — DreamSonic application entry
//
// Two domains, one deployment:
//   halo.dreamsonic.org   → Project Halo staff console (full UI + API)
//   dreamsonic.org / www  → public landing + /w/:external_id client portal
//
// A single host gate enforces the split at the API layer. Staff pages vs.
// public pages are split in views.js.

const express = require('express');

const app = express();
app.set('trust proxy', 1);                        // Railway terminates TLS in front
app.use(express.json({ limit: '1mb' }));

// --- Hostname detection ---------------------------------------------------
// Sets req.isHalo / req.isPublic from the Host header.
// Localhost and *.railway.app default to Halo so Cap's first deploy
// (before DNS is pointed) shows the staff console.
function detectHost(req, res, next) {
  const h = (req.hostname || '').toLowerCase();
  const isLocal =
        h === 'localhost'
     || h.startsWith('127.')
     || h.endsWith('.railway.app')
     || h.endsWith('.up.railway.app');
  req.isHalo = h.startsWith('halo.') || isLocal;
  req.isPublic = !req.isHalo;
  next();
}
app.use(detectHost);

// --- Request logging ------------------------------------------------------
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (req.path === '/health') return;
    const ms = Date.now() - started;
    const tag = req.isHalo ? 'HALO' : 'PUB ';
    console.log(`[${tag}] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// --- Health check (unrestricted, for Railway probes) ----------------------
app.get('/health', (req, res) => res.json({ ok: true, service: 'dreamsonic' }));

// --- API host gate --------------------------------------------------------
// Halo domain: full API access.
// Public domain: only GET /api/progress/:external_id (UUID-gated) passes.
function apiHostGate(req, res, next) {
  if (req.isHalo) return next();
  if (req.method === 'GET' && /^\/progress\/[0-9a-f-]{36}$/i.test(req.path)) {
    return next();
  }
  return res.status(404).json({ error: 'not found' });
}

const clients   = require('./routes/clients');
const protocols = require('./routes/protocols');
const sessions  = require('./routes/sessions');
const progress  = require('./routes/progress');
const packet    = require('./routes/packet');
const attention = require('./routes/attention');
const devices   = require('./routes/devices');

app.use('/api', apiHostGate, clients);
app.use('/api', apiHostGate, protocols);
app.use('/api', apiHostGate, sessions);
app.use('/api', apiHostGate, progress);
app.use('/api', apiHostGate, packet);
app.use('/api', apiHostGate, attention);
app.use('/api', apiHostGate, devices);

// --- Views + static assets (host-aware) -----------------------------------
require('./views').mount(app);

// --- Error handler --------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('[err]', err);
  res.status(500).json({ error: err.message });
});

// --- Boot sequence --------------------------------------------------------
const http = require('http');
const wsHub = require('./routes/ws-hub');
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    console.log('[dreamsonic] starting...');
    await require('./schema').init();
    await require('./seed-data').init();

    const server = http.createServer(app);
    wsHub.attach(server);

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[dreamsonic] listening on 0.0.0.0:${PORT}`);
      console.log('[dreamsonic] halo console at halo.dreamsonic.org');
      console.log('[dreamsonic] public site at dreamsonic.org');
    });
  } catch (err) {
    console.error('[dreamsonic] BOOT FAILED', err);
    process.exit(1);
  }
})();
