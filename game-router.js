'use strict';

// Registry of game modules. Add new games here when built.
const MODULES = {
  hues: require('./game'),
  spectrum: require('./game-spectrum'),
  trivia: require('./game-trivia'),
  bluff: require('./game-bluff'),
  pictionary: require('./game-pictionary'),
};

const PLAYER_COLORS = ['#e74c3c','#2f7bff','#27ae60','#9b59b6','#f39c12','#16c5c5','#ff5da2','#e6c92e'];

function getModule(room) {
  const mod = MODULES[room.gameType];
  if (!mod) throw new Error(`Unknown gameType: ${room.gameType}`);
  return mod;
}

// Creates the base room object and calls the module's initRoom for game-specific fields.
function createRoom(code, hostName, settings, gameType) {
  const type = (gameType || 'spectrum').toLowerCase();
  if (!MODULES[type]) throw new Error(`Unknown gameType: ${type}`);
  const room = {
    code,
    gameType: type,
    hostIdx: 0,
    players: [{ name: hostName, color: PLAYER_COLORS[0], score: 0, connected: true, ws: null }],
    round: 0,
    totalRounds: 2,
    phase: 'lobby',
    settings: { turnSeconds: parseInt(settings.turnSeconds) || 30 },
    lastActivity: Date.now(),
    timerSeconds: 0,
  };
  MODULES[type].initRoom(room);
  return room;
}

function startRound(room) {
  return getModule(room).startRound(room);
}

// Routes all in-game player actions (and timer expiry) to the correct module.
function processGuess(room, playerIdx, msg) {
  return getModule(room).processGuess(room, playerIdx, msg);
}

function sanitizeForPlayer(room, playerIdx) {
  return getModule(room).sanitizeForPlayer(room, playerIdx);
}

// Called by server.js after a player disconnects, once the room's own bookkeeping
// (connected flag, host promotion) is done. Optional per module: a game that has no
// "waiting on everyone" phase simply doesn't export it and gets a no-op.
// Modules must be idempotent here — it can fire for a player who already left.
function onPlayerLeft(room, playerIdx) {
  const mod = getModule(room);
  if (typeof mod.onPlayerLeft !== 'function') return { ok: true, noop: true };
  return mod.onPlayerLeft(room, playerIdx) || { ok: true };
}

module.exports = {
  PLAYER_COLORS,
  createRoom, startRound, processGuess, sanitizeForPlayer, onPlayerLeft,
};
