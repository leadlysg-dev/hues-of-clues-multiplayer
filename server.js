'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const game = require('./game-router');
const timer = require('./timer');

const PORT = process.env.PORT || 3000;
const ROOM_EXPIRY_MS = 2 * 60 * 60 * 1000; // 2 hours inactivity
const RECONNECT_WINDOW_MS = 60 * 1000; // 60 seconds to reconnect

const rooms = new Map();     // code → room
const wsToPlayer = new Map(); // ws → { code, playerIdx }

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0,O,1,I
function genCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// index.html is re-read whenever its mtime changes rather than snapshotted at boot.
// Client and server now land in separate commits, so a boot-time snapshot means a
// long-lived process serves a stale client — version skew that presents as a game bug.
const INDEX_PATH = path.join(__dirname, 'index.html');
let indexCache = { mtimeMs: 0, body: null, etag: null };
function getIndex() {
  const { mtimeMs, size } = fs.statSync(INDEX_PATH);
  if (mtimeMs !== indexCache.mtimeMs) {
    indexCache = {
      mtimeMs,
      body: fs.readFileSync(INDEX_PATH),
      etag: `W/"${size.toString(16)}-${Math.round(mtimeMs).toString(16)}"`,
    };
  }
  return indexCache;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    const idx = getIndex();
    if (req.headers['if-none-match'] === idx.etag) {
      res.writeHead(304, { ETag: idx.etag });
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'ETag': idx.etag,
      'Cache-Control': 'no-cache', // revalidate every load; 304s stay cheap
    });
    res.end(idx.body);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server });

// Half-open socket detection. A backgrounded phone or a dropped mobile connection
// leaves a socket that never fires 'close', so the player stays 'connected' forever
// and every "waiting on all connected players" phase waits on a ghost. Ping on an
// interval; a client that misses one full round terminates, which routes into the
// normal close path (host promotion + onPlayerLeft) rather than hanging the room.
const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_MS) || 30000;
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// The phase-deadline block is injected here rather than inside each module's
// sanitizeForPlayer, so the client surface costs zero module changes and cannot
// drift between games. Null whenever the current phase has no deadline.
function deadlineState(room) {
  if (room._deadlinePhase !== room.phase) return null;
  const total = PHASE_DEADLINES[room.gameType]?.[room.phase];
  if (!total) return null;
  return {
    phase: room.phase,
    remaining: timer.getRemaining(room, 'phase'),
    total: Math.round(total / DEADLINE_SCALE),
  };
}

function broadcastState(room) {
  const deadline = deadlineState(room);
  room.players.forEach((p, idx) => {
    if (p.ws && p.ws.readyState === p.ws.OPEN) {
      send(p.ws, { type: 'STATE', state: { ...game.sanitizeForPlayer(room, idx), deadline } });
    }
  });
}

// Starts (or restarts) the turn timer for a room.
// Expiry routes through processGuess so each game module controls the consequence.
function startRoomTimer(room) {
  if (!room.settings.turnSeconds) return;
  room.timerSeconds = room.settings.turnSeconds;
  timer.startTimer(room, 'turn', room.settings.turnSeconds,
    (rem) => {
      room.timerSeconds = rem;
      broadcastState(room);
    },
    () => {
      room.timerSeconds = 0;
      game.processGuess(room, null, { type: 'TIMER_EXPIRE' });
      if (room.phase === 'guess' && room.turnQueue.length > 0) {
        startRoomTimer(room);
      } else {
        broadcastState(room);
      }
    }
  );
}

function stopRoomTimer(room) {
  timer.stopTimer(room, 'turn');
  room.timerSeconds = 0;
}

// Phase deadlines. Ping/pong terminates a socket nobody answers on, but not a human
// who walked away with a live tab — the browser keeps answering pongs for them. These
// are the durations NIKO ruled (game feel is their call, not platform's):
//   bluff/writing 90s   — a writing task; rushing it costs more than one idle player
//   bluff/voting  45s   — reading four short submissions
//   pictionary/vote 30s — a one-tap difficulty rating
// Deliberately absent: pictionary/drawing already has its own 90s round timer and a
// second deadline would double-fire; trivia/judging has none, because timing out a
// host's scoring decision auto-resolves it, which is worse than waiting.
const PHASE_DEADLINES = {
  bluff: { writing: 90, voting: 45 },
  pictionary: { vote: 30 },
};
// Test-only: divides every deadline so a suite can exercise real expiry in ~1s.
const DEADLINE_SCALE = parseInt(process.env.DEADLINE_SCALE) || 1;

// Expiry advances the phase on whoever did act — it is not a forfeit. A player who
// timed out simply has no submission and no vote; nobody is punished for a slow phone.
function applyPhaseDeadline(room) {
  const seconds = PHASE_DEADLINES[room.gameType]?.[room.phase];
  const connected = room.players.filter(p => p.connected).length;

  if (!seconds || connected === 0) {
    timer.stopTimer(room, 'phase');
    room._deadlinePhase = null;
    return;
  }
  if (room._deadlinePhase === room.phase) return; // already running for this phase

  room._deadlinePhase = room.phase;
  const startedIn = room.phase;
  timer.startTimer(room, 'phase', Math.max(1, Math.round(seconds / DEADLINE_SCALE)),
    rem => {
      // Every second near the end so the countdown is honest; sparser before that,
      // because a full state broadcast per second for 90s is real traffic on free tier.
      if (rem <= 15 || rem % 15 === 0) broadcastState(room);
    },
    () => {
      if (room.phase !== startedIn) return; // phase moved on; deadline is stale
      room._deadlinePhase = null;
      game.processGuess(room, null, { type: 'PHASE_DEADLINE' });
      applyTimerPolicy(room);
      broadcastState(room);
    }
  );
}

// After any game action, apply the correct timer policy for the current game/phase.
function applyTimerPolicy(room) {
  if (room.phase === 'guess' && room.turnQueue.length > 0) {
    // Spectrum: per-player turn timer.
    startRoomTimer(room);
  } else if ((room.gameType === 'trivia' && room.phase === 'question') ||
             (room.gameType === 'pictionary' && room.phase === 'drawing')) {
    // Trivia question / Pictionary drawing: 90s round timer — start once per phase.
    if (!room._timers?.has('round')) {
      const roundSeconds = 90;
      room.timerSeconds = roundSeconds;
      timer.startTimer(room, 'round', roundSeconds,
        rem => { room.timerSeconds = rem; broadcastState(room); },
        () => {
          room.timerSeconds = 0;
          game.processGuess(room, null, { type: 'TIMER_EXPIRE' });
          broadcastState(room);
        }
      );
    }
  } else {
    // All other phases: stop all named timers.
    stopRoomTimer(room);
    timer.stopTimer(room, 'round');
    timer.stopTimer(room, 'buzz');
  }
  // Independent of the turn/round timers above: a phase can have both, or only this.
  applyPhaseDeadline(room);
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { type } = msg;

    if (type === 'CREATE_ROOM') {
      const name = (msg.name || '').trim().slice(0, 16);
      if (!name) return send(ws, { type: 'ERROR', message: 'Name required' });
      const gameType = (msg.gameType || 'spectrum').toLowerCase();
      const code = genCode();
      let room;
      try { room = game.createRoom(code, name, { turnSeconds: msg.turnSeconds }, gameType); }
      catch (e) { return send(ws, { type: 'ERROR', message: e.message }); }
      room.players[0].ws = ws;
      rooms.set(code, room);
      wsToPlayer.set(ws, { code, playerIdx: 0 });
      send(ws, { type: 'JOINED', code, yourIdx: 0 });
      send(ws, { type: 'STATE', state: game.sanitizeForPlayer(room, 0) });
      return;
    }

    if (type === 'JOIN_ROOM') {
      const code = (msg.code || '').toUpperCase().trim();
      const name = (msg.name || '').trim().slice(0, 16);
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'ERROR', message: 'Room not found' });
      if (room.phase !== 'lobby') return send(ws, { type: 'ERROR', message: 'Game already in progress' });
      if (room.players.length >= 8) return send(ws, { type: 'ERROR', message: 'Room is full (max 8)' });
      if (!name) return send(ws, { type: 'ERROR', message: 'Name required' });
      const playerIdx = room.players.length;
      room.players.push({ name, color: game.PLAYER_COLORS[playerIdx], score: 0, connected: true, ws });
      wsToPlayer.set(ws, { code, playerIdx });
      send(ws, { type: 'JOINED', code, yourIdx: playerIdx });
      broadcastState(room);
      return;
    }

    if (type === 'RECONNECT') {
      const code = (msg.code || '').toUpperCase().trim();
      const name = (msg.name || '').trim();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'ERROR', message: 'Room not found' });
      const playerIdx = room.players.findIndex(p => p.name === name && !p.connected);
      if (playerIdx === -1) {
        // Try to find connected slot (double-connect case)
        const altIdx = room.players.findIndex(p => p.name === name);
        if (altIdx !== -1) {
          room.players[altIdx].ws = ws;
          wsToPlayer.set(ws, { code, playerIdx: altIdx });
          send(ws, { type: 'JOINED', code, yourIdx: altIdx });
          send(ws, { type: 'STATE', state: game.sanitizeForPlayer(room, altIdx) });
          return;
        }
        return send(ws, { type: 'ERROR', message: 'No disconnected player with that name found' });
      }
      room.players[playerIdx].ws = ws;
      room.players[playerIdx].connected = true;
      wsToPlayer.set(ws, { code, playerIdx });
      send(ws, { type: 'JOINED', code, yourIdx: playerIdx });
      broadcastState(room);
      return;
    }

    // All other messages require being in a room
    const info = wsToPlayer.get(ws);
    if (!info) return send(ws, { type: 'ERROR', message: 'Not in a room' });
    const { code, playerIdx } = info;
    const room = rooms.get(code);
    if (!room) return send(ws, { type: 'ERROR', message: 'Room not found' });

    switch (type) {
      case 'START_GAME': {
        if (playerIdx !== room.hostIdx) return send(ws, { type: 'ERROR', message: 'Only the host can start' });
        if (room.phase !== 'lobby') return send(ws, { type: 'ERROR', message: 'Game already started' });
        if (room.players.length < 2) return send(ws, { type: 'ERROR', message: 'Need at least 2 players' });
        room.totalRounds = room.players.length * 2;
        room.round = 0;
        game.startRound(room);
        broadcastState(room);
        break;
      }

      // All in-game player actions route through the game module via processGuess.
      case 'CLUE_READY':
      case 'PLACE_GUESS':
      case 'SKIP_TURN':
      case 'UNDO_LAST':
      case 'NEXT_ROUND':
      case 'PLAY_AGAIN':
      case 'MARK_CORRECT':
      case 'MARK_WRONG':
      case 'START_WRITING':
      case 'SUBMIT_BLUFF':
      case 'CAST_VOTE':
      case 'PAINT_CELL':
      case 'SUBMIT_GUESS':
      case 'START_VOTE':
      case 'SUBMIT_DIFFICULTY': {
        const result = game.processGuess(room, playerIdx, msg);
        if (result && !result.ok) {
          if (!result.silent) send(ws, { type: 'ERROR', message: result.error });
          break;
        }
        applyTimerPolicy(room);
        broadcastState(room);
        break;
      }

      // Trivia buzz: record arrival, start 3s buzz window on first buzz.
      case 'BUZZ': {
        msg.timestamp = Date.now();
        const result = game.processGuess(room, playerIdx, msg);
        if (result && !result.ok) {
          if (!result.silent) send(ws, { type: 'ERROR', message: result.error });
          break;
        }
        if (result && result.firstBuzz) {
          // First buzz opens a 3s window for other players to also buzz in.
          timer.startTimer(room, 'buzz', 3, null, () => {
            game.processGuess(room, null, { type: 'BUZZ_EXPIRED' });
            broadcastState(room);
          });
        }
        broadcastState(room);
        break;
      }

      case 'END_GAME': {
        stopRoomTimer(room);
        room.phase = 'over';
        room.lastActivity = Date.now();
        broadcastState(room);
        break;
      }

      default:
        send(ws, { type: 'ERROR', message: `Unknown action: ${type}` });
    }
  });

  ws.on('close', () => {
    const info = wsToPlayer.get(ws);
    if (!info) return;
    wsToPlayer.delete(ws);
    const { code, playerIdx } = info;
    const room = rooms.get(code);
    if (!room) return;

    const p = room.players[playerIdx];
    if (!p) return;
    p.connected = false;
    p.ws = null;
    room.lastActivity = Date.now();

    // If it was this player's turn to guess, skip them and manage the timer.
    if (room.phase === 'guess' && room.turnQueue[0] === playerIdx) {
      stopRoomTimer(room);
      game.processGuess(room, playerIdx, { type: 'SKIP_TURN' });
    }

    // D2: if the host disconnected, promote the next connected player — in ANY phase.
    // Host-gated actions (MARK_CORRECT, START_WRITING, NEXT_ROUND) are unreachable while
    // hostIdx points at a dead player, which bricks the round with no way out.
    if (playerIdx === room.hostIdx) {
      const newHost = room.players.findIndex((pl, i) => i !== playerIdx && pl.connected);
      if (newHost !== -1) room.hostIdx = newHost;
    }

    // D1: give the game module a chance to re-evaluate "everyone has submitted/voted"
    // now that the roster shrank. Without this, a phase that waits on all connected
    // players hangs forever — no further message can arrive to unstick it.
    game.onPlayerLeft(room, playerIdx);

    const anyConnected = room.players.some(pl => pl.connected);
    // Nobody left in the room: kill every named timer rather than letting intervals
    // tick against an empty room until the 2h expiry sweep. Render free tier is one
    // long-lived process — leaked intervals accumulate across every abandoned room.
    if (anyConnected) {
      applyTimerPolicy(room);
      broadcastState(room);
    } else {
      timer.stopAllTimers(room);
      room.timerSeconds = 0;
      room._deadlinePhase = null; // so a reconnect restarts the deadline cleanly
    }
  });
});

// Expire stale rooms every 15 minutes; stopAllTimers catches every named timer.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > ROOM_EXPIRY_MS) {
      timer.stopAllTimers(room);
      rooms.delete(code);
    }
  }
}, 15 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Hues of Clues server listening on port ${PORT}`);
});
