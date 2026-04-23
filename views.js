// views.js — HTML page routes, host-aware.
//
// halo.dreamsonic.org                 staff console pages
// dreamsonic.org / www                public landing + /w/:external_id portal
// localhost / *.railway.app           treated as halo (for dev convenience)

const express = require('express');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'public');

function mount(app) {
  // Static assets — served from both domains
  app.use('/static', express.static(PUBLIC_DIR, { maxAge: 0, etag: true, index: false }));

  // --- Shared: client progress portal (UUID-gated, safe on either host) ---
  app.get('/w/:external_id', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'client-progress.html'));
  });

  // --- Halo console pages (staff only) ---
  app.get('/dashboard', haloOnly, (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'coach-dashboard.html'));
  });
  app.get('/intake', haloOnly, (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'intake.html'));
  });
  app.get('/session/:id/run', haloOnly, (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'session-runner.html'));
  });
  app.get('/client/:id', haloOnly, (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'client-detail.html'));
  });

  // --- Root routing: host-aware ---
  app.get('/', (req, res) => {
    if (req.isHalo) return res.redirect('/dashboard');
    return res.sendFile(path.join(PUBLIC_DIR, 'landing.html'));
  });
}

function haloOnly(req, res, next) {
  if (!req.isHalo) {
    // On the public domain, block staff pages with a friendly redirect
    return res.redirect('/');
  }
  next();
}

module.exports = { mount };
