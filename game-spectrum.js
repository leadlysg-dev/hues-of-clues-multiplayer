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

// Called once when room is created; sets Spectrum-specific fields.
function initRoom(room) {
  room.cueGiver = 0;
  room.target = null;
  room.guesses = [];
  room.turnQueue = [];
  room.lastDeltas = [];
  room.currentClue = '';
}

function startRound(room) {
  room.cueGiver = room.round % room.players.length;
  room.target = { r: Math.floor(Math.random() * ROWS), c: Math.floor(Math.random() * COLS) };
  room.guesses = [];
  room.lastDeltas = room.players.map(() => 0);
  room.currentClue = '';
  room.phase = 'ready';
  room.lastActivity = Date.now();
}

function connectedGuessers(room) {
  const out = [];
  for (let i = 1; i < room.players.length; i++) {
    const idx = (room.cueGiver + i) % room.players.length;
    if (room.players[idx].connected) out.push(idx);
  }
  return out;
}

function beginGuessing(room, clue) {
  room.currentClue = (clue || '').trim().slice(0, 40);
  room.phase = 'guess';
  room.turnQueue = connectedGuessers(room);
  room.lastActivity = Date.now();
  if (room.turnQueue.length === 0) revealScore(room);
}

function placeGuessInternal(room, playerIdx, r, c) {
  if (room.phase !== 'guess') return { ok: false, error: 'Not in guess phase' };
  if (room.turnQueue[0] !== playerIdx) return { ok: false, error: 'Not your turn' };
  if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return { ok: false, error: 'Invalid cell' };
  if (room.guesses.some(g => g.r === r && g.c === c)) return { ok: false, error: 'Cell already taken' };
  room.turnQueue.shift();
  room.guesses.push({ playerIdx, r, c });
  room.lastActivity = Date.now();
  if (room.turnQueue.length === 0) revealScore(room);
  return { ok: true };
}

function skipTurnInternal(room) {
  if (room.turnQueue.length > 0) room.turnQueue.shift();
  room.lastActivity = Date.now();
  if (room.turnQueue.length === 0) revealScore(room);
}

function undoLastInternal(room) {
  if (room.phase !== 'guess' || room.guesses.length === 0) return false;
  const last = room.guesses.pop();
  room.turnQueue.unshift(last.playerIdx);
  room.lastActivity = Date.now();
  return true;
}

function revealScore(room) {
  room.phase = 'score';
  const { r, c } = room.target;
  for (const g of room.guesses) {
    const dr = Math.abs(g.r - r), dc = Math.abs(g.c - c);
    let pts = 0;
    if (dr === 0 && dc === 0) pts = 3;
    else if (dr <= 1 && dc <= 1) pts = 2;
    else if (dr <= 2 && dc <= 2) pts = 1;
    room.lastDeltas[g.playerIdx] += pts;
    if (dr <= 1 && dc <= 1) room.lastDeltas[room.cueGiver] += 1;
  }
  room.players.forEach((p, i) => { p.score += room.lastDeltas[i]; });
  room.lastActivity = Date.now();
}

function nextRoundInternal(room) {
  if (room.round + 1 >= room.totalRounds) {
    room.phase = 'over';
  } else {
    room.round++;
    startRound(room);
  }
  room.lastActivity = Date.now();
}

function playAgainInternal(room) {
  room.players.forEach(p => { p.score = 0; });
  room.totalRounds = room.players.length * 2;
  room.round = 0;
  startRound(room);
}

// Unified entry point for all in-game player actions.
function processGuess(room, playerIdx, msg) {
  switch (msg.type) {
    case 'CLUE_READY': {
      if (playerIdx !== room.cueGiver) return { ok: false, error: 'Only the cue giver can do this' };
      if (room.phase !== 'ready') return { ok: false, error: 'Not in ready phase' };
      beginGuessing(room, msg.clue);
      return { ok: true };
    }
    case 'PLACE_GUESS':
      return placeGuessInternal(room, playerIdx, msg.r, msg.c);
    case 'TIMER_EXPIRE':
    case 'SKIP_TURN': {
      if (room.phase !== 'guess') return { ok: false, error: 'Not in guess phase' };
      skipTurnInternal(room);
      return { ok: true };
    }
    case 'UNDO_LAST': {
      if (!undoLastInternal(room)) return { ok: false, silent: true };
      return { ok: true };
    }
    case 'NEXT_ROUND': {
      if (room.phase !== 'score') return { ok: false, error: 'Not in score phase' };
      nextRoundInternal(room);
      return { ok: true };
    }
    case 'PLAY_AGAIN': {
      if (room.phase !== 'over') return { ok: false, error: 'Game is not over' };
      playAgainInternal(room);
      return { ok: true };
    }
    default:
      return { ok: false, error: `Unknown action: ${msg.type}` };
  }
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

module.exports = {
  COLS, ROWS, PLAYER_COLORS,
  cellHsl, coord, parseCoord,
  initRoom, startRound, processGuess, sanitizeForPlayer,
};
