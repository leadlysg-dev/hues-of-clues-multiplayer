'use strict';

const FACTS = require('./color-facts.json');
// color-facts.json: array of strings (general color trivia facts)

const COLS = 30, ROWS = 16;

function cellHsl(r, c) {
  const hue = (c / COLS) * 360, t = r / (ROWS - 1);
  const light = 84 - t * 54, sat = 62 + 34 * Math.sin(t * Math.PI);
  return { css: `hsl(${hue.toFixed(1)},${sat.toFixed(0)}%,${light.toFixed(0)}%)` };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function initRoom(room) {
  room.bluffFacts = shuffle([...FACTS]);
  room.factIdx = 0;
  room.revealedCell = null;
  room.submissions = [];   // [{playerIdx, text, isReal}]; null playerIdx = real fact
  room.shuffledOrder = []; // indices into submissions, shuffled for voting display
  room.votes = [];         // [{playerIdx, votedIdx}]; votedIdx = position in shuffledOrder
  room.lastDeltas = [];
}

function pickCell() {
  return { r: Math.floor(Math.random() * ROWS), c: Math.floor(Math.random() * COLS) };
}

function startRound(room) {
  const { r, c } = pickCell();
  room.revealedCell = { r, c, css: cellHsl(r, c).css };
  room.submissions = [];
  room.shuffledOrder = [];
  room.votes = [];
  room.lastDeltas = room.players.map(() => 0);
  // Seed the real fact into submissions.
  const fact = room.bluffFacts[room.factIdx % room.bluffFacts.length];
  room.factIdx++;
  room.submissions.push({ playerIdx: null, text: fact, isReal: true });
  room.phase = 'reveal';
  room.lastActivity = Date.now();
}

function connectedPlayers(room) {
  return room.players.map((p, i) => p.connected ? i : null).filter(i => i !== null);
}

function allPlayersSubmitted(room) {
  const connected = connectedPlayers(room);
  return connected.every(i => room.submissions.some(s => s.playerIdx === i));
}

function allPlayersVoted(room) {
  const connected = connectedPlayers(room);
  return connected.every(i => room.votes.some(v => v.playerIdx === i));
}

function beginVoting(room) {
  // Shuffle submission indices for display order (keeps real fact anonymous).
  const indices = room.submissions.map((_, i) => i);
  room.shuffledOrder = shuffle(indices);
  room.phase = 'voting';
  room.lastActivity = Date.now();
}

function revealScore(room) {
  room.phase = 'score';
  room.lastDeltas = room.players.map(() => 0);

  // Find the shuffled position of the real submission.
  const realSubmIdx = room.submissions.findIndex(s => s.isReal);
  const realShufflePos = room.shuffledOrder.indexOf(realSubmIdx);

  for (const vote of room.votes) {
    if (vote.votedIdx === realShufflePos) {
      // Correctly identified the real fact.
      room.lastDeltas[vote.playerIdx] += 2;
    } else {
      // Voted for a bluff — award 1pt to the bluff's author.
      const submIdx = room.shuffledOrder[vote.votedIdx];
      const authorIdx = room.submissions[submIdx].playerIdx;
      if (authorIdx !== null && authorIdx !== undefined) {
        room.lastDeltas[authorIdx] += 1;
      }
    }
  }
  room.players.forEach((p, i) => { p.score += room.lastDeltas[i]; });
  room.lastActivity = Date.now();
}

function processGuess(room, playerIdx, msg) {
  switch (msg.type) {

    case 'START_WRITING': {
      if (room.phase !== 'reveal') return { ok: false, error: 'Not in reveal phase' };
      if (playerIdx !== room.hostIdx) return { ok: false, error: 'Host only' };
      room.phase = 'writing';
      room.lastActivity = Date.now();
      return { ok: true };
    }

    case 'SUBMIT_BLUFF': {
      if (room.phase !== 'writing') return { ok: false, error: 'Not in writing phase' };
      const text = (msg.text || '').trim().slice(0, 80);
      if (!text) return { ok: false, error: 'Bluff cannot be empty' };
      // One submission per player.
      if (room.submissions.some(s => s.playerIdx === playerIdx)) {
        return { ok: false, error: 'Already submitted' };
      }
      room.submissions.push({ playerIdx, text, isReal: false });
      room.lastActivity = Date.now();
      if (allPlayersSubmitted(room)) beginVoting(room);
      return { ok: true };
    }

    case 'CAST_VOTE': {
      if (room.phase !== 'voting') return { ok: false, error: 'Not in voting phase' };
      const votedIdx = msg.votedIdx;
      if (typeof votedIdx !== 'number' || votedIdx < 0 || votedIdx >= room.shuffledOrder.length) {
        return { ok: false, error: 'Invalid vote' };
      }
      // Prevent voting for own submission.
      const submIdx = room.shuffledOrder[votedIdx];
      if (room.submissions[submIdx].playerIdx === playerIdx) {
        return { ok: false, error: 'Cannot vote for your own submission' };
      }
      // One vote per player.
      if (room.votes.some(v => v.playerIdx === playerIdx)) {
        return { ok: false, error: 'Already voted' };
      }
      room.votes.push({ playerIdx, votedIdx });
      room.lastActivity = Date.now();
      if (allPlayersVoted(room)) revealScore(room);
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
      room.bluffFacts = shuffle([...FACTS]);
      room.factIdx = 0;
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
  const inScore = room.phase === 'score';
  const inVoting = room.phase === 'voting';

  let sanitizedSubmissions;
  if (inScore) {
    // Full reveal: text, author, isReal, in shuffled display order.
    sanitizedSubmissions = room.shuffledOrder.map((submIdx, pos) => ({
      text: room.submissions[submIdx].text,
      isReal: room.submissions[submIdx].isReal,
      playerIdx: room.submissions[submIdx].playerIdx,
      pos,
    }));
  } else if (inVoting) {
    // Show text only, in shuffled order. No attribution, no isReal.
    sanitizedSubmissions = room.shuffledOrder.map((submIdx, pos) => ({
      text: room.submissions[submIdx].text,
      pos,
    }));
  } else {
    // Reveal/writing: no texts shown; just let player know their own was received.
    sanitizedSubmissions = [];
  }

  return {
    code: room.code,
    gameType: room.gameType,
    hostIdx: room.hostIdx,
    players: room.players.map(p => ({ name: p.name, color: p.color, score: p.score, connected: p.connected })),
    round: room.round,
    totalRounds: room.totalRounds,
    phase: room.phase,
    revealedCell: room.revealedCell,
    submissions: sanitizedSubmissions,
    // Count of player bluffs submitted (not counting the real fact seeded by server).
    submittedCount: room.submissions.filter(s => s.playerIdx !== null).length,
    mySubmitted: room.submissions.some(s => s.playerIdx === playerIdx),
    votes: inScore ? room.votes : room.votes.filter(v => v.playerIdx === playerIdx),
    myVoted: room.votes.some(v => v.playerIdx === playerIdx),
    lastDeltas: room.lastDeltas,
    settings: room.settings,
    timerSeconds: room.timerSeconds || 0,
  };
}

module.exports = { initRoom, startRound, processGuess, sanitizeForPlayer };
