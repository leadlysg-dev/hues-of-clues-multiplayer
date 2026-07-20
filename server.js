'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const game = require('./game');

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

const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'));
const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(indexHtml);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server });

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastState(room) {
  room.players.forEach((p, idx) => {
    if (p.ws && p.ws.readyState === p.ws.OPEN) {
      send(p.ws, { type: 'STATE', state: game.sanitizeForPlayer(room, idx) });
    }
  });
}

function startRoomTimer(room) {
  stopRoomTimer(room);
  if (!room.settings.turnSeconds) return;
  room.timerSeconds = room.settings.turnSeconds;
  room.timerId = setInterval(() => {
    room.timerSeconds = Math.max(0, room.timerSeconds - 1);
    broadcastState(room);
    if (room.timerSeconds <= 0) {
      stopRoomTimer(room);
      game.skipTurn(room);
      if (room.phase === 'guess' && room.turnQueue.length > 0) {
        startRoomTimer(room);
      } else {
        broadcastState(room);
      }
    }
  }, 1000);
}

function stopRoomTimer(room) {
  if (room.timerId) { clearInterval(room.timerId); room.timerId = null; }
  room.timerSeconds = 0;
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { type } = msg;

    if (type === 'CREATE_ROOM') {
      const name = (msg.name || '').trim().slice(0, 16);
      if (!name) return send(ws, { type: 'ERROR', message: 'Name required' });
      const code = genCode();
      const room = game.createRoom(code, name, { turnSeconds: msg.turnSeconds });
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

      case 'CLUE_READY': {
        if (playerIdx !== room.cueGiver) return send(ws, { type: 'ERROR', message: 'Only the cue giver can do this' });
        if (room.phase !== 'ready') return send(ws, { type: 'ERROR', message: 'Not in ready phase' });
        game.beginGuessing(room, msg.clue);
        if (room.phase === 'guess' && room.turnQueue.length > 0) startRoomTimer(room);
        broadcastState(room);
        break;
      }

      case 'PLACE_GUESS': {
        const result = game.placeGuess(room, playerIdx, msg.r, msg.c);
        if (!result.ok) return send(ws, { type: 'ERROR', message: result.error });
        if (room.phase === 'score') {
          stopRoomTimer(room);
        } else if (room.turnQueue.length > 0) {
          startRoomTimer(room);
        }
        broadcastState(room);
        break;
      }

      case 'SKIP_TURN': {
        if (room.phase !== 'guess') break;
        stopRoomTimer(room);
        game.skipTurn(room);
        if (room.phase === 'guess' && room.turnQueue.length > 0) startRoomTimer(room);
        broadcastState(room);
        break;
      }

      case 'UNDO_LAST': {
        if (game.undoLast(room)) {
          startRoomTimer(room);
          broadcastState(room);
        }
        break;
      }

      case 'NEXT_ROUND': {
        if (room.phase !== 'score') break;
        game.nextRound(room);
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

      case 'PLAY_AGAIN': {
        if (room.phase !== 'over') break;
        stopRoomTimer(room);
        game.playAgain(room);
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

    // If it was this player's turn to guess, skip them
    if (room.phase === 'guess' && room.turnQueue[0] === playerIdx) {
      stopRoomTimer(room);
      game.skipTurn(room);
      if (room.phase === 'guess' && room.turnQueue.length > 0) {
        startRoomTimer(room);
      }
    }

    // If host disconnected in lobby, promote next connected player
    if (room.phase === 'lobby' && playerIdx === room.hostIdx) {
      const newHost = room.players.findIndex((pl, i) => i !== playerIdx && pl.connected);
      if (newHost !== -1) room.hostIdx = newHost;
    }

    const anyConnected = room.players.some(pl => pl.connected);
    if (anyConnected) broadcastState(room);
  });
});

// Expire stale rooms every 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > ROOM_EXPIRY_MS) {
      stopRoomTimer(room);
      rooms.delete(code);
    }
  }
}, 15 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Hues of Clues server listening on port ${PORT}`);
});
