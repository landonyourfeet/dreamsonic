// server.js — DreamSonic application entry
//
// Standalone Node/Express server. Runs on Railway behind the proxy.
// Single Postgres database via DATABASE_URL.

const express = require('express');

const app = express();
app.set('trust proxy', 1);  // Railway terminates TLS in front of us
app.use(express.json({ limit: '1mb' }));

// Request logging — minimal
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    if (req.path !== '/health') {
      console.log(`[req] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});

// Health check (Railway pings this)
app.get('/health', (req, res) => res.json({ ok: true, service: 'dreamsonic' }));

// API routes — all mounted under /api
const clients    = require('./routes/clients');
const protocols  = require('./routes/protocols');
const sessions   = require('./routes/sessions');
const progress   = require('./routes/progress');
app.use('/api', clients);
app.use('/api', protocols);
app.use('/api', sessions);
app.use('/api', progress);

// HTML page routes + static assets
require('./views').mount(app);

// Root
app.get('/', (req, res) => res.redirect('/dashboard'));

// Error handler
app.use((err, req, res, next) => {
  console.error('[err]', err);
  res.status(500).json({ error: err.message });
});

// Boot sequence: init DB schema + seed defaults, then listen.
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    console.log('[dreamsonic] starting...');
    await require('./schema').init();
    await require('./seed-data').init();
    app.listen(PORT, () => {
      console.log(`[dreamsonic] listening on :${PORT}`);
    });
  } catch (err) {
    console.error('[dreamsonic] BOOT FAILED', err);
    process.exit(1);
  }
})();
