'use strict';

const COLS = 30, ROWS = 16;
const CARDS = require('./spectrum-cards.json');

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Called once when room is created (by game-router.js).
function initRoom(room) {
  room.cueGiver = 0;
  room.target = null;
  room.guesses = [];
  room.turnQueue = [];
  room.lastDeltas = [];
  room.currentClue = '';
  room.spectrumLeft = '';
  room.spectrumRight = '';
  room.secretWord = '';
  room._cardDeck = shuffle(CARDS);
  room._cardIdx = 0;
}

function startRound(room) {
  room.cueGiver = room.round % room.players.length;
  const card = room._cardDeck[room._cardIdx % room._cardDeck.length];
  room._cardIdx++;
  room.spectrumLeft = card.left;
  room.spectrumRight = card.right;
  room.secretWord = card.word;
  room.target = { c: Math.floor(Math.random() * COLS) };
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
  if (c < 0 || c >= COLS) return { ok: false, error: 'Invalid column' };
  room.turnQueue.shift();
  // Store r for marker display on board; only c is used for scoring.
  room.guesses.push({ playerIdx, r: (r !== undefined ? r : 0), c });
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
  const tc = room.target.c;
  for (const g of room.guesses) {
    const dc = Math.abs(g.c - tc);
    let pts = 0;
    if (dc === 0) pts = 3;
    else if (dc <= 1) pts = 2;
    else if (dc <= 2) pts = 1;
    room.lastDeltas[g.playerIdx] += pts;
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
  room._cardDeck = shuffle(CARDS);
  room._cardIdx = 0;
  startRound(room);
}

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
  const hideSecret = (room.phase === 'ready' || room.phase === 'guess') && playerIdx !== room.cueGiver;
  return {
    code: room.code,
    gameType: room.gameType,
    hostIdx: room.hostIdx,
    players: room.players.map(p => ({ name: p.name, color: p.color, score: p.score, connected: p.connected })),
    round: room.round,
    totalRounds: room.totalRounds,
    cueGiver: room.cueGiver,
    target: hideSecret ? null : room.target,
    phase: room.phase,
    guesses: room.guesses,
    turnQueue: room.turnQueue,
    lastDeltas: room.lastDeltas,
    currentClue: room.currentClue,
    spectrumLeft: room.spectrumLeft,
    spectrumRight: room.spectrumRight,
    secretWord: hideSecret ? null : room.secretWord,
    settings: room.settings,
    timerSeconds: room.timerSeconds || 0,
  };
}

module.exports = { initRoom, startRound, processGuess, sanitizeForPlayer };
