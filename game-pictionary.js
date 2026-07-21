'use strict';

const WORDS = require('./word-deck.json');
// word-deck.json: array of strings (200 words)

const COLS = 30, ROWS = 16;
// 8-colour PICO-8-inspired painting palette
const PAINT_COLORS = ['#fff1e8','#ffec27','#ff004d','#ff77a8','#00e436','#29adff','#1d2b53','#000000'];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function normalize(str) {
  return (str || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function initRoom(room) {
  room.wordDeck = shuffle([...WORDS]);
  room.wordIdx = 0;
  room.artistIdx = 0;       // index into players array; rotates each round
  room.secretWord = null;
  room.paintedCells = [];   // [{r,c,color}] — full canvas state
  room.guesses = [];        // [{playerIdx,text,correct}]
  room.difficultyVotes = [];// [{playerIdx,vote}] — 'easy'|'medium'|'hard'
  room.lastDeltas = [];
}

function startRound(room) {
  room.artistIdx = room.round % room.players.length;
  const word = room.wordDeck[room.wordIdx % room.wordDeck.length];
  room.wordIdx++;
  room.secretWord = word;
  room.paintedCells = [];
  room.guesses = [];
  room.difficultyVotes = [];
  room.lastDeltas = room.players.map(() => 0);
  room.phase = 'drawing';
  room.lastActivity = Date.now();
}

function connectedNonArtists(room) {
  return room.players.map((p, i) => (p.connected && i !== room.artistIdx) ? i : null).filter(i => i !== null);
}

function allDifficultyVoted(room) {
  const connected = room.players.map((p, i) => p.connected ? i : null).filter(i => i !== null);
  return connected.every(i => room.difficultyVotes.some(v => v.playerIdx === i));
}

function revealScore(room, winnerIdx) {
  room.phase = 'score';
  room.lastDeltas = room.players.map(() => 0);
  if (winnerIdx !== null && winnerIdx !== undefined) {
    // Guesser gets 2pts; artist gets 1pt for the guess.
    room.lastDeltas[winnerIdx] += 2;
    room.lastDeltas[room.artistIdx] += 1;
  }
  room.players.forEach((p, i) => { p.score += room.lastDeltas[i]; });
  room.lastActivity = Date.now();
}

function processGuess(room, playerIdx, msg) {
  switch (msg.type) {

    // Artist paints a cell; broadcasts immediately via broadcastState in server.js.
    case 'PAINT_CELL': {
      if (room.phase !== 'drawing' && room.phase !== 'guessed') return { ok: false, silent: true };
      if (playerIdx !== room.artistIdx) return { ok: false, silent: true };
      const { r, c, color } = msg;
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return { ok: false, silent: true };
      if (!PAINT_COLORS.includes(color)) return { ok: false, silent: true };
      // Overwrite existing cell or append.
      const existing = room.paintedCells.findIndex(pc => pc.r === r && pc.c === c);
      if (existing >= 0) {
        room.paintedCells[existing].color = color;
      } else {
        room.paintedCells.push({ r, c, color });
      }
      room.lastActivity = Date.now();
      return { ok: true };
    }

    // Guesser submits a text guess; checked against secretWord case-insensitively.
    case 'SUBMIT_GUESS': {
      if (room.phase !== 'drawing') return { ok: false, silent: true };
      if (playerIdx === room.artistIdx) return { ok: false, silent: true };
      const text = (msg.text || '').trim().slice(0, 40);
      if (!text) return { ok: false, silent: true };
      const correct = normalize(text) === normalize(room.secretWord);
      room.guesses.push({ playerIdx, text, correct });
      room.lastActivity = Date.now();
      if (correct) {
        room.phase = 'guessed';
        // Don't score yet — wait for difficulty votes or host to advance.
      }
      return { ok: true, correct };
    }

    // Move from guessed/timeout → vote phase (host or auto after timer).
    case 'START_VOTE': {
      if (room.phase !== 'guessed' && room.phase !== 'timeout') return { ok: false, silent: true };
      room.phase = 'vote';
      room.lastActivity = Date.now();
      return { ok: true };
    }

    case 'SUBMIT_DIFFICULTY': {
      if (room.phase !== 'vote') return { ok: false, error: 'Not in vote phase' };
      const vote = msg.vote;
      if (!['easy','medium','hard'].includes(vote)) return { ok: false, error: 'Invalid vote' };
      if (room.difficultyVotes.some(v => v.playerIdx === playerIdx)) return { ok: false, silent: true };
      room.difficultyVotes.push({ playerIdx, vote });
      room.lastActivity = Date.now();
      if (allDifficultyVoted(room)) {
        // Find the first correct guesser (if any).
        const winner = room.guesses.find(g => g.correct);
        revealScore(room, winner ? winner.playerIdx : null);
      }
      return { ok: true };
    }

    // Timer expired during drawing — transition to timeout.
    case 'TIMER_EXPIRE': {
      if (room.phase !== 'drawing') return { ok: false, silent: true };
      room.phase = 'timeout';
      room.lastActivity = Date.now();
      return { ok: true };
    }

    case 'NEXT_ROUND': {
      if (room.phase !== 'score') return { ok: false, error: 'Not in score phase' };
      if (room.round + 1 >= room.totalRounds) {
        room.phase = 'over';
      } else {
        room.round++;
        startRound(room);
      }
      room.lastActivity = Date.now();
      return { ok: true };
    }

    case 'PLAY_AGAIN': {
      if (room.phase !== 'over') return { ok: false, error: 'Game is not over' };
      room.players.forEach(p => { p.score = 0; });
      room.totalRounds = room.players.length * 2;
      room.round = 0;
      room.wordDeck = shuffle([...WORDS]);
      room.wordIdx = 0;
      startRound(room);
      return { ok: true };
    }

    case 'SKIP_TURN':
    case 'UNDO_LAST':
    case 'CLUE_READY':
    case 'PLACE_GUESS':
    case 'SUBMIT_BLUFF':
    case 'CAST_VOTE':
      return { ok: false, silent: true };

    default:
      return { ok: false, error: `Unknown action: ${msg.type}` };
  }
}

function sanitizeForPlayer(room, playerIdx) {
  const isArtist = playerIdx === room.artistIdx;
  const inScore = room.phase === 'score' || room.phase === 'over';

  // Censor correct guess text until score so word isn't revealed via the chat.
  const sanitizedGuesses = room.guesses.map(g => ({
    playerIdx: g.playerIdx,
    text: (g.correct && !inScore && !isArtist) ? '★ Correct!' : g.text,
    correct: g.correct,
  }));

  return {
    code: room.code,
    gameType: room.gameType,
    hostIdx: room.hostIdx,
    players: room.players.map(p => ({ name: p.name, color: p.color, score: p.score, connected: p.connected })),
    round: room.round,
    totalRounds: room.totalRounds,
    phase: room.phase,
    artistIdx: room.artistIdx,
    // Only the artist sees the secret word until score phase.
    secretWord: (isArtist || inScore) ? room.secretWord : null,
    paintedCells: room.paintedCells,
    guesses: sanitizedGuesses,
    difficultyVotes: room.difficultyVotes,
    myDifficultyVoted: room.difficultyVotes.some(v => v.playerIdx === playerIdx),
    lastDeltas: room.lastDeltas,
    settings: room.settings,
    timerSeconds: room.timerSeconds || 0,
    paintColors: PAINT_COLORS,
  };
}

module.exports = { PAINT_COLORS, initRoom, startRound, processGuess, sanitizeForPlayer };
