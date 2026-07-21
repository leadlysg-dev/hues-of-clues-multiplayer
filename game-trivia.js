'use strict';

const QUESTIONS = require('./questions.json');
// questions.json format: { text, category, answer, hint }

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
  room.triviaQuestions = shuffle([...QUESTIONS]);
  room.triviaQuestion = null;
  room.buzzOrder = [];        // [{ playerIdx, timestamp }] in arrival order
  room.currentBuzzer = null;  // playerIdx of player currently in judging seat
  room.lastDeltas = [];
}

function startRound(room) {
  if (room.round === 0) room.totalRounds = Math.min(15, QUESTIONS.length);
  room.triviaQuestion = room.triviaQuestions[room.round % room.triviaQuestions.length];
  room.buzzOrder = [];
  room.currentBuzzer = null;
  room.lastDeltas = room.players.map(() => 0);
  room.phase = 'question';
  room.lastActivity = Date.now();
}

function revealScore(room, correctPlayerIdx) {
  room.phase = 'score';
  room.lastDeltas = room.players.map(() => 0);
  if (correctPlayerIdx !== null && correctPlayerIdx !== undefined) {
    room.lastDeltas[correctPlayerIdx] = 1;
    room.players[correctPlayerIdx].score += 1;
  }
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

// Unified entry point for all in-game player actions (and timer expiry).
function processGuess(room, playerIdx, msg) {
  switch (msg.type) {

    // Player hits buzz button during 'question' phase.
    // Returns { ok, firstBuzz } so server.js can start the 3s buzz window timer.
    case 'BUZZ': {
      if (room.phase !== 'question') return { ok: false, silent: true };
      const ts = msg.timestamp || Date.now();
      const alreadyBuzzed = room.buzzOrder.some(b => b.playerIdx === playerIdx);
      if (alreadyBuzzed) return { ok: false, silent: true };
      const firstBuzz = room.buzzOrder.length === 0;
      room.buzzOrder.push({ playerIdx, timestamp: ts });
      if (firstBuzz) {
        room.phase = 'buzzed';
        room.currentBuzzer = null; // will be set when buzz window closes
      }
      room.lastActivity = Date.now();
      return { ok: true, firstBuzz };
    }

    // Fired by server.js when the 3s buzz window timer expires.
    // Promotes the first buzzer to judging seat.
    case 'BUZZ_EXPIRED': {
      if (room.phase !== 'buzzed') return { ok: false, silent: true };
      // Sort by timestamp just in case out-of-order delivery happened
      room.buzzOrder.sort((a, b) => a.timestamp - b.timestamp);
      room.currentBuzzer = room.buzzOrder[0].playerIdx;
      room.phase = 'judging';
      room.lastActivity = Date.now();
      return { ok: true };
    }

    // Host marks the current buzzer correct.
    case 'MARK_CORRECT': {
      if (room.phase !== 'judging') return { ok: false, error: 'Not in judging phase' };
      if (playerIdx !== room.hostIdx) return { ok: false, error: 'Host only' };
      revealScore(room, room.currentBuzzer);
      return { ok: true };
    }

    // Host marks the current buzzer wrong — no points awarded.
    case 'MARK_WRONG': {
      if (room.phase !== 'judging') return { ok: false, error: 'Not in judging phase' };
      if (playerIdx !== room.hostIdx) return { ok: false, error: 'Host only' };
      revealScore(room, null);
      return { ok: true };
    }

    // Round timer expired with no buzz — skip to score, no points.
    case 'TIMER_EXPIRE': {
      if (room.phase !== 'question') return { ok: false, silent: true };
      revealScore(room, null);
      return { ok: true };
    }

    case 'NEXT_ROUND': {
      if (room.phase !== 'score') return { ok: false, error: 'Not in score phase' };
      nextRoundInternal(room);
      return { ok: true };
    }

    case 'PLAY_AGAIN': {
      if (room.phase !== 'over') return { ok: false, error: 'Game is not over' };
      room.players.forEach(p => { p.score = 0; });
      room.triviaQuestions = shuffle([...QUESTIONS]);
      room.round = 0;
      startRound(room);
      return { ok: true };
    }

    case 'SKIP_TURN':
    case 'UNDO_LAST':
    case 'CLUE_READY':
    case 'PLACE_GUESS':
      return { ok: false, silent: true };

    default:
      return { ok: false, error: `Unknown action: ${msg.type}` };
  }
}

function sanitizeForPlayer(room, playerIdx) {
  const isHost = playerIdx === room.hostIdx;
  return {
    code: room.code,
    gameType: room.gameType,
    hostIdx: room.hostIdx,
    players: room.players.map(p => ({ name: p.name, color: p.color, score: p.score, connected: p.connected })),
    round: room.round,
    totalRounds: room.totalRounds,
    phase: room.phase,
    triviaQuestion: room.triviaQuestion ? {
      text: room.triviaQuestion.text,
      category: room.triviaQuestion.category,
      hint: room.triviaQuestion.hint,
      // Full answer only visible to host; shown to everyone in score phase.
      answer: (isHost || room.phase === 'score') ? room.triviaQuestion.answer : null,
    } : null,
    buzzOrder: room.buzzOrder,
    currentBuzzer: room.currentBuzzer,
    lastDeltas: room.lastDeltas,
    settings: room.settings,
    timerSeconds: room.timerSeconds || 0,
  };
}

module.exports = { initRoom, startRound, processGuess, sanitizeForPlayer };
