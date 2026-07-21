'use strict';

const COLS = 30, ROWS = 16;
const PLAYER_COLORS = ['#e74c3c','#2f7bff','#27ae60','#9b59b6','#f39c12','#16c5c5','#ff5da2','#e6c92e'];

function cellHsl(r, c) {
  const hue = (c / COLS) * 360, t = r / (ROWS - 1);
  const light = 84 - t * 54, sat = 62 + 34 * Math.sin(t * Math.PI);
  return { css: `hsl(${hue.toFixed(1)},${sat.toFixed(0)}%,${light.toFixed(0)}%)`, light };
}

function coord(r, c) { return String.fromCharCode(65 + r) + (c + 1); }

function parseCoord(str) {
  const m = /^([A-P])\s*([0-9]{1,2})$/i.exec((str || '').trim());
  if (!m) return null;
  const r = m[1].toUpperCase().charCodeAt(0) - 65, c = parseInt(m[2], 10) - 1;
  if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return null;
  return { r, c };
}

function createRoom(code, hostName, settings) {
  return {
    code,
    hostIdx: 0,
    players: [{ name: hostName, color: PLAYER_COLORS[0], score: 0, connected: true, ws: null }],
    round: 0,
    totalRounds: 2,
    cueGiver: 0,
    target: null,
    phase: 'lobby',
    guesses: [],
    turnQueue: [],
    lastDeltas: [],
    currentClue: '',
    settings: { turnSeconds: parseInt(settings.turnSeconds) || 30 },
    lastActivity: Date.now(),
    timerSeconds: 0,
    timerId: null,
  };
}

function startRound(state) {
  state.cueGiver = state.round % state.players.length;
  state.target = { r: Math.floor(Math.random() * ROWS), c: Math.floor(Math.random() * COLS) };
  state.guesses = [];
  state.lastDeltas = state.players.map(() => 0);
  state.currentClue = '';
  state.phase = 'ready';
  state.lastActivity = Date.now();
}

function connectedGuessers(state) {
  const o = [];
  for (let i = 1; i < state.players.length; i++) {
    const idx = (state.cueGiver + i) % state.players.length;
    if (state.players[idx].connected) o.push(idx);
  }
  return o;
}

function beginGuessing(state, clue) {
  state.currentClue = (clue || '').trim().slice(0, 40);
  state.phase = 'guess';
  state.turnQueue = connectedGuessers(state);
  state.lastActivity = Date.now();
  if (state.turnQueue.length === 0) revealScore(state);
}

function placeGuess(state, playerIdx, r, c) {
  if (state.phase !== 'guess') return { ok: false, error: 'Not in guess phase' };
  if (state.turnQueue[0] !== playerIdx) return { ok: false, error: 'Not your turn' };
  if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return { ok: false, error: 'Invalid cell' };
  if (state.guesses.some(g => g.r === r && g.c === c)) return { ok: false, error: 'Cell already taken' };
  state.turnQueue.shift();
  state.guesses.push({ playerIdx, r, c });
  state.lastActivity = Date.now();
  if (state.turnQueue.length === 0) revealScore(state);
  return { ok: true };
}

function skipTurn(state) {
  if (state.turnQueue.length > 0) state.turnQueue.shift();
  state.lastActivity = Date.now();
  if (state.turnQueue.length === 0) revealScore(state);
}

function undoLast(state) {
  if (state.phase !== 'guess' || state.guesses.length === 0) return false;
  const last = state.guesses.pop();
  state.turnQueue.unshift(last.playerIdx);
  state.lastActivity = Date.now();
  return true;
}

function revealScore(state) {
  state.phase = 'score';
  const { r, c } = state.target;
  for (const g of state.guesses) {
    const dr = Math.abs(g.r - r), dc = Math.abs(g.c - c);
    let pts = 0;
    if (dr === 0 && dc === 0) pts = 3;
    else if (dr <= 1 && dc <= 1) pts = 2;
    else if (dr <= 2 && dc <= 2) pts = 1;
    state.lastDeltas[g.playerIdx] += pts;
    if (dr <= 1 && dc <= 1) state.lastDeltas[state.cueGiver] += 1;
  }
  state.players.forEach((p, i) => { p.score += state.lastDeltas[i]; });
  state.lastActivity = Date.now();
}

function nextRound(state) {
  if (state.round + 1 >= state.totalRounds) {
    state.phase = 'over';
  } else {
    state.round++;
    startRound(state);
  }
  state.lastActivity = Date.now();
}

function playAgain(state) {
  state.players.forEach(p => { p.score = 0; });
  state.round = 0;
  startRound(state);
}

function sanitizeForPlayer(room, playerIdx) {
  const hideTarget = (room.phase === 'ready' || room.phase === 'guess') && playerIdx !== room.cueGiver;
  return {
    code: room.code,
    gameType: room.gameType,
    hostIdx: room.hostIdx,
    players: room.players.map(p => ({ name: p.name, color: p.color, score: p.score, connected: p.connected })),
    round: room.round,
    totalRounds: room.totalRounds,
    cueGiver: room.cueGiver,
    target: hideTarget ? null : room.target,
    phase: room.phase,
    guesses: room.guesses,
    turnQueue: room.turnQueue,
    lastDeltas: room.lastDeltas,
    currentClue: room.currentClue,
    settings: room.settings,
    timerSeconds: room.timerSeconds || 0,
  };
}

// Adapter interface used by game-router: populate game-specific fields on the base room.
function initRoom(room) {
  room.cueGiver = 0;
  room.target = null;
  room.guesses = [];
  room.turnQueue = [];
  room.lastDeltas = room.players.map(() => 0);
  room.currentClue = '';
  room.timerId = null;
}

// Adapter interface used by game-router: dispatch all in-game messages.
function processGuess(room, playerIdx, msg) {
  switch (msg.type) {
    case 'CLUE_READY':
      beginGuessing(room, msg.clue);
      return { ok: true };
    case 'PLACE_GUESS':
      return placeGuess(room, playerIdx, msg.r, msg.c);
    case 'SKIP_TURN':
    case 'TIMER_EXPIRE':
      skipTurn(room);
      return { ok: true };
    case 'UNDO_LAST':
      undoLast(room);
      return { ok: true };
    case 'NEXT_ROUND':
      nextRound(room);
      return { ok: true };
    case 'PLAY_AGAIN':
      playAgain(room);
      return { ok: true };
    default:
      return { ok: false, error: `Unknown message: ${msg.type}`, silent: true };
  }
}

module.exports = {
  COLS, ROWS, PLAYER_COLORS,
  cellHsl, coord, parseCoord,
  initRoom, createRoom, startRound, beginGuessing,
  placeGuess, skipTurn, undoLast,
  revealScore, nextRound, playAgain,
  processGuess, sanitizeForPlayer,
};
