'use strict';

const QUESTIONS = [
  { text: 'What is the largest planet in the solar system?', options: ['Mars', 'Saturn', 'Jupiter', 'Neptune'], correctIdx: 2 },
  { text: 'How many sides does a hexagon have?', options: ['Five', 'Six', 'Seven', 'Eight'], correctIdx: 1 },
  { text: 'What country is credited with inventing pizza?', options: ['Greece', 'France', 'Spain', 'Italy'], correctIdx: 3 },
  { text: 'What is the capital city of Australia?', options: ['Sydney', 'Melbourne', 'Canberra', 'Brisbane'], correctIdx: 2 },
  { text: 'How many strings does a standard guitar have?', options: ['4', '5', '6', '7'], correctIdx: 2 },
  { text: 'What gas do plants absorb from the atmosphere to make food?', options: ['Oxygen', 'Nitrogen', 'Carbon dioxide', 'Hydrogen'], correctIdx: 2 },
  { text: 'Which element has the chemical symbol Au?', options: ['Silver', 'Aluminium', 'Copper', 'Gold'], correctIdx: 3 },
  { text: 'In what year did the Berlin Wall fall?', options: ['1987', '1989', '1991', '1993'], correctIdx: 1 },
  { text: 'What is the fastest land animal?', options: ['Lion', 'Leopard', 'Greyhound', 'Cheetah'], correctIdx: 3 },
  { text: 'How many bones are in the adult human body?', options: ['186', '196', '206', '216'], correctIdx: 2 },
  { text: 'Which language has the most native speakers worldwide?', options: ['English', 'Spanish', 'Hindi', 'Mandarin'], correctIdx: 3 },
  { text: 'Which is the largest ocean on Earth?', options: ['Atlantic', 'Indian', 'Arctic', 'Pacific'], correctIdx: 3 },
  { text: 'What does HTTP stand for?', options: ['HyperText Transfer Protocol', 'High Tech Text Protocol', 'Home Tool Transfer Process', 'Hybrid Transfer Technology'], correctIdx: 0 },
  { text: 'How many players from one team are on the court in basketball?', options: ['4', '5', '6', '7'], correctIdx: 1 },
  { text: 'What is the square root of 144?', options: ['10', '11', '12', '13'], correctIdx: 2 },
  { text: 'Which country has the most natural lakes?', options: ['Russia', 'USA', 'China', 'Canada'], correctIdx: 3 },
  { text: 'In what year was the first iPhone released?', options: ['2005', '2006', '2007', '2008'], correctIdx: 2 },
  { text: 'Which planet is known as the Red Planet?', options: ['Venus', 'Mars', 'Jupiter', 'Mercury'], correctIdx: 1 },
  { text: 'How many teeth does a typical adult human have?', options: ['28', '30', '32', '34'], correctIdx: 2 },
  { text: 'What is the smallest country in the world by area?', options: ['Monaco', 'San Marino', 'Liechtenstein', 'Vatican City'], correctIdx: 3 },
  { text: 'What is the hardest natural substance on Earth?', options: ['Granite', 'Steel', 'Diamond', 'Quartz'], correctIdx: 2 },
  { text: 'Which organ produces insulin in the human body?', options: ['Liver', 'Kidney', 'Pancreas', 'Stomach'], correctIdx: 2 },
  { text: 'How many continents are there on Earth?', options: ['5', '6', '7', '8'], correctIdx: 2 },
  { text: 'What is the chemical formula for water?', options: ['CO2', 'H2O', 'NaCl', 'O2'], correctIdx: 1 },
  { text: 'Who painted the Mona Lisa?', options: ['Michelangelo', 'Raphael', 'Leonardo da Vinci', 'Caravaggio'], correctIdx: 2 },
];

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Called once when room is created; sets Trivia-specific fields.
function initRoom(room) {
  room.triviaQuestions = shuffle([...QUESTIONS]);
  room.triviaQuestion = null;
  room.triviaAnswers = {};
  room.lastDeltas = [];
  room.turnQueue = [];
}

function startRound(room) {
  // Fix totalRounds to a sensible trivia length on first start or play again.
  if (room.round === 0) room.totalRounds = Math.min(10, QUESTIONS.length);
  room.triviaQuestion = room.triviaQuestions[room.round % room.triviaQuestions.length];
  room.triviaAnswers = {};
  room.lastDeltas = room.players.map(() => 0);
  // turnQueue drives the per-player timer via server.js's applyTimerPolicy.
  // Each player answers in turn; when all have gone, revealScore fires.
  room.turnQueue = room.players.map((p, i) => (p.connected ? i : null)).filter(i => i !== null);
  room.phase = 'guess';
  room.lastActivity = Date.now();
}

function revealScore(room) {
  room.phase = 'score';
  room.turnQueue = [];
  const correct = room.triviaQuestion.correctIdx;
  room.lastDeltas = room.players.map((p, i) => {
    const pts = room.triviaAnswers[i] === correct ? 1 : 0;
    p.score += pts;
    return pts;
  });
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

// Unified entry point for all in-game player actions.
function processGuess(room, playerIdx, msg) {
  switch (msg.type) {
    case 'PLACE_GUESS': {
      if (room.phase !== 'guess') return { ok: false, error: 'Not in guess phase' };
      if (room.turnQueue[0] !== playerIdx) return { ok: false, error: 'Not your turn' };
      const ai = msg.answerIdx;
      if (typeof ai !== 'number' || ai < 0 || ai > 3) return { ok: false, error: 'Invalid answer' };
      room.triviaAnswers[playerIdx] = ai;
      room.turnQueue.shift();
      room.lastActivity = Date.now();
      if (room.turnQueue.length === 0) revealScore(room);
      return { ok: true };
    }
    case 'TIMER_EXPIRE': {
      if (room.phase !== 'guess') return { ok: false, silent: true };
      // Current player timed out — skip them (no answer recorded = wrong).
      if (room.turnQueue.length > 0) room.turnQueue.shift();
      room.lastActivity = Date.now();
      if (room.turnQueue.length === 0) revealScore(room);
      return { ok: true };
    }
    case 'SKIP_TURN': {
      if (room.phase !== 'guess') return { ok: false, error: 'Not in guess phase' };
      if (room.turnQueue.length > 0) room.turnQueue.shift();
      room.lastActivity = Date.now();
      if (room.turnQueue.length === 0) revealScore(room);
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
    case 'UNDO_LAST':
    case 'CLUE_READY':
      return { ok: false, silent: true };
    default:
      return { ok: false, error: `Unknown action: ${msg.type}` };
  }
}

function sanitizeForPlayer(room, playerIdx) {
  const inGuess = room.phase === 'guess';
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
      options: room.triviaQuestion.options,
      // Hide the correct answer until the score phase.
      correctIdx: inGuess ? null : room.triviaQuestion.correctIdx,
    } : null,
    // During guess phase each player only sees their own submitted answer.
    triviaAnswers: inGuess
      ? (room.triviaAnswers[playerIdx] !== undefined ? { [playerIdx]: room.triviaAnswers[playerIdx] } : {})
      : { ...room.triviaAnswers },
    lastDeltas: room.lastDeltas,
    turnQueue: room.turnQueue,
    settings: room.settings,
    timerSeconds: room.timerSeconds || 0,
  };
}

module.exports = { initRoom, startRound, processGuess, sanitizeForPlayer };
