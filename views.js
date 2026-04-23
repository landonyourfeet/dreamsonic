// views.js
// HTML page routes + static file serving.

const express = require('express');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'public');

function mount(app) {
  // Static assets
  app.use('/static', express.static(PUBLIC_DIR, { maxAge: 0, etag: true, index: false }));

  // Coach-facing pages
  app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'coach-dashboard.html'));
  });

  app.get('/intake', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'intake.html'));
  });

  app.get('/session/:id/run', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'session-runner.html'));
  });

  app.get('/client/:id', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'client-detail.html'));
  });

  // Public client progress (UUID-gated)
  app.get('/w/:external_id', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'client-progress.html'));
  });
}

module.exports = { mount };
