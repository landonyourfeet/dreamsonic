// routes/ws-hub.js
//
// WebSocket hub for live session coordination.
//
// Actors:
//   - Stimulation Player (stimulation-player.html) - receives directives, reports back
//   - Halo Runner (session-runner.html) - operator controls, sees engine decisions
//   - Adaptive Controller (server-side) - emits directives based on EEG + state
//
// Rooms: one per session id. Every client joins by sending {type:'join', session_id, role}.
// The hub relays typed messages between members of the same room.

'use strict';

const WebSocket = require('ws');

// Message shapes (documentation, not enforced at wire level):
//
// CLIENT -> SERVER:
//   { type: 'join', session_id: int, role: 'player' | 'runner' | 'controller' }
//   { type: 'directive', session_id, payload: { frequencyHz, intensityPct, action, reason, ... } }
//   { type: 'player_state', session_id, payload: { actual_hz, actual_intensity, frame_rate, audio_running } }
//   { type: 'verbal_cue', session_id, payload: { cue: 'too_intense'|'more_please'|'just_right' } }
//   { type: 'eeg_sample', session_id, payload: { t, channels: [a,b,c,d] } }  // future
//   { type: 'mode_change', session_id, payload: { mode: 'manual'|'autopilot'|'abort' } }
//   { type: 'ping' }
//
// SERVER -> CLIENT:
//   { type: 'joined', session_id, role, members: [...] }
//   { type: 'peer_joined', session_id, role }
//   { type: 'peer_left', session_id, role }
//   { type: 'directive', ... }       -- relayed
//   { type: 'player_state', ... }    -- relayed
//   { type: 'mode_change', ... }     -- relayed
//   { type: 'pong' }
//   { type: 'error', message }

const rooms = new Map();  // session_id -> Set<ws>

function joinRoom(sessionId, ws) {
  if (!rooms.has(sessionId)) rooms.set(sessionId, new Set());
  rooms.get(sessionId).add(ws);
}

function leaveRoom(sessionId, ws) {
  const room = rooms.get(sessionId);
  if (!room) return;
  room.delete(ws);
  if (room.size === 0) rooms.delete(sessionId);
}

function broadcastToRoom(sessionId, fromWs, msg) {
  const room = rooms.get(sessionId);
  if (!room) return;
  const payload = JSON.stringify(msg);
  for (const peer of room) {
    if (peer === fromWs) continue;
    if (peer.readyState === WebSocket.OPEN) peer.send(payload);
  }
}

function getRoomRoles(sessionId) {
  const room = rooms.get(sessionId);
  if (!room) return [];
  return Array.from(room).map(c => c.dsRole).filter(Boolean);
}

function safeSend(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch (e) { /* swallow */ }
}

function attach(httpServer) {
  const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.dsSession = null;
    ws.dsRole = null;
    const remote = req.socket.remoteAddress;
    console.log(`[ws] connection from ${remote}`);

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch { safeSend(ws, { type: 'error', message: 'invalid json' }); return; }

      if (!msg.type) { safeSend(ws, { type: 'error', message: 'missing type' }); return; }

      // JOIN — claim a session + role
      if (msg.type === 'join') {
        const { session_id, role } = msg;
        if (!Number.isInteger(session_id) || !['player', 'runner', 'controller'].includes(role)) {
          safeSend(ws, { type: 'error', message: 'invalid join' });
          return;
        }
        if (ws.dsSession !== null) leaveRoom(ws.dsSession, ws);
        ws.dsSession = session_id;
        ws.dsRole = role;
        joinRoom(session_id, ws);
        console.log(`[ws] session ${session_id} joined by ${role}`);
        safeSend(ws, { type: 'joined', session_id, role, members: getRoomRoles(session_id) });
        broadcastToRoom(session_id, ws, { type: 'peer_joined', session_id, role });
        return;
      }

      // PING — liveness heartbeat
      if (msg.type === 'ping') {
        safeSend(ws, { type: 'pong', t: Date.now() });
        return;
      }

      // Any other message requires having joined a session
      if (ws.dsSession === null) {
        safeSend(ws, { type: 'error', message: 'must join a session first' });
        return;
      }

      // Relay known types to the room
      const relayTypes = new Set([
        'directive', 'player_state', 'mode_change', 'verbal_cue', 'manual_control',
      ]);
      if (relayTypes.has(msg.type)) {
        broadcastToRoom(ws.dsSession, ws, { ...msg, session_id: ws.dsSession });
        return;
      }

      safeSend(ws, { type: 'error', message: `unknown type: ${msg.type}` });
    });

    ws.on('close', () => {
      if (ws.dsSession !== null) {
        const sid = ws.dsSession;
        const role = ws.dsRole;
        leaveRoom(sid, ws);
        broadcastToRoom(sid, ws, { type: 'peer_left', session_id: sid, role });
        console.log(`[ws] session ${sid} ${role} disconnected`);
      }
    });

    ws.on('error', (err) => {
      console.error('[ws] socket error', err.message);
    });
  });

  // Liveness ping every 30s, terminate dead sockets
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) { /* swallow */ }
    }
  }, 30_000);
  wss.on('close', () => clearInterval(heartbeat));

  console.log('[ws] hub attached at /ws');
  return wss;
}

module.exports = { attach };
