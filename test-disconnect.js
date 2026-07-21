'use strict';

// Executable repro for the two disconnect defects routed by NIKO (T-20260721T143239Z-bb5b53).
//
//   D1 — bluff/pictionary hang forever when a player drops mid-'writing'.
//        allPlayersSubmitted() is only evaluated inside a message handler, so the
//        ws.close path never re-checks it and no further message can arrive.
//   D2 — a mid-game host drop bricks the round. Host promotion was gated on
//        phase === 'lobby', so hostIdx kept pointing at a dead player and every
//        host-only action returned {"ok":false,"error":"Host only"}.
//
// Run: node test-disconnect.js   (spawns the real server on PORT, real ws clients)

const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = process.env.TEST_PORT || 3999;
const URL = `ws://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A test client that remembers the last STATE it was sent.
function client(name) {
  const ws = new WebSocket(URL);
  const c = { name, ws, state: null, errors: [], idx: null };
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'STATE') c.state = m.state;
    else if (m.type === 'JOINED') { c.code = m.code; c.idx = m.yourIdx; }
    else if (m.type === 'ERROR') c.errors.push(m.message);
  });
  c.send = obj => ws.send(JSON.stringify(obj));
  c.ready = new Promise(res => ws.on('open', res));
  return c;
}

async function makeRoom(gameType, playerCount) {
  const host = client('Host');
  await host.ready;
  host.send({ type: 'CREATE_ROOM', name: 'Host', gameType });
  await sleep(80);

  const others = [];
  for (let i = 1; i < playerCount; i++) {
    const c = client(`P${i}`);
    await c.ready;
    c.send({ type: 'JOIN_ROOM', code: host.code, name: `P${i}` });
    await sleep(60);
    others.push(c);
  }
  return { host, others, all: [host, ...others] };
}

const results = [];
function check(id, label, pass, detail) {
  results.push({ id, label, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${label}${detail ? `\n        ${detail}` : ''}`);
}

// D1: five players in 'writing', four submit, fifth drops. Phase must advance to 'voting'.
async function testD1() {
  const { host, others } = await makeRoom('bluff', 5);
  host.send({ type: 'START_GAME' });
  await sleep(100);
  host.send({ type: 'START_WRITING' });
  await sleep(100);

  if (host.state.phase !== 'writing') {
    return check('D1', 'bluff advances when the last un-submitted player drops',
      false, `setup failed: expected phase 'writing', got '${host.state.phase}'`);
  }

  // Four of five submit; P4 stays silent, then drops.
  host.send({ type: 'SUBMIT_BLUFF', text: 'host bluff' });
  for (const c of others.slice(0, 3)) c.send({ type: 'SUBMIT_BLUFF', text: `${c.name} bluff` });
  await sleep(150);

  const before = host.state.phase;
  others[3].ws.close();
  await sleep(250);

  check('D1', 'bluff advances when the last un-submitted player drops',
    host.state.phase === 'voting',
    `phase before drop '${before}', after drop '${host.state.phase}' (expected 'voting')`);

  [host, ...others].forEach(c => { try { c.ws.close(); } catch {} });
}

// D3: pictionary 'vote' is the same defect class as D1 — allDifficultyVoted() only ran
// from inside SUBMIT_DIFFICULTY, so the last outstanding voter dropping hung the round.
async function testD3() {
  const { host, others } = await makeRoom('pictionary', 4);
  host.send({ type: 'START_GAME' });
  await sleep(100);

  // Drive the round to 'vote': artist paints, a guesser gets it, artist ends the round.
  const artistIdx = host.state.artistIdx;
  const all = [host, ...others];
  const artist = all.find(c => c.idx === artistIdx);
  const word = artist.state.secretWord;
  const guesser = all.find(c => c.idx !== artistIdx);
  guesser.send({ type: 'SUBMIT_GUESS', text: word });
  await sleep(120);
  artist.send({ type: 'START_VOTE' });
  await sleep(120);

  if (host.state.phase !== 'vote') {
    return check('D3', 'pictionary advances when the last un-voted player drops',
      false, `setup failed: expected phase 'vote', got '${host.state.phase}'`);
  }

  // Everyone but the last player votes; the last one drops instead.
  const voters = all.slice(0, all.length - 1);
  for (const c of voters) c.send({ type: 'SUBMIT_DIFFICULTY', vote: 'easy' });
  await sleep(150);

  const before = host.state.phase;
  all[all.length - 1].ws.close();
  await sleep(250);

  check('D3', 'pictionary advances when the last un-voted player drops',
    host.state.phase === 'score',
    `phase before drop '${before}', after drop '${host.state.phase}' (expected 'score')`);

  all.forEach(c => { try { c.ws.close(); } catch {} });
}

// D4: the artist is the only player who can advance 'drawing', so their leaving strands
// everyone else. Not in the original brief — same defect class, found while fixing D1.
async function testD4() {
  const { host, others } = await makeRoom('pictionary', 3);
  host.send({ type: 'START_GAME' });
  await sleep(120);

  const all = [host, ...others];
  const artist = all.find(c => c.idx === host.state.artistIdx);
  const survivor = all.find(c => c.idx !== host.state.artistIdx && c !== artist) || others[0];

  if (host.state.phase !== 'drawing') {
    return check('D4', 'pictionary escapes when the artist drops mid-drawing',
      false, `setup failed: expected phase 'drawing', got '${host.state.phase}'`);
  }

  const before = host.state.phase;
  artist.ws.close();
  await sleep(250);

  const seen = survivor.state ? survivor.state.phase : '(no state)';
  check('D4', 'pictionary escapes when the artist drops mid-drawing',
    seen === 'score',
    `phase before drop '${before}', remaining player now sees '${seen}' (expected 'score')`);

  all.forEach(c => { try { c.ws.close(); } catch {} });
}

// D5: onPlayerLeft must be idempotent and must not advance a room nobody is left in.
// An .every() over an empty roster is vacuously true — the guard against that is the
// difference between "waiting" and "a room with no players walking itself to score".
async function testD5() {
  const bluff = require('./game-bluff');
  const room = require('./game-router').createRoom('TEST', 'A', 30, 'bluff');
  room.players.push({ name: 'B', score: 0, connected: true });
  require('./game-router').startRound(room);
  room.phase = 'writing';

  // Everyone leaves without submitting anything.
  room.players.forEach(p => { p.connected = false; });
  bluff.onPlayerLeft(room, 1);
  const emptyHeld = room.phase === 'writing';

  // Firing repeatedly for an already-departed player must not change anything further.
  bluff.onPlayerLeft(room, 1);
  bluff.onPlayerLeft(room, 1);
  const idempotent = room.phase === 'writing';

  // And it must be a no-op in a phase it knows nothing about.
  room.phase = 'score';
  bluff.onPlayerLeft(room, 1);
  const noopElsewhere = room.phase === 'score';

  check('D5', 'onPlayerLeft is idempotent, and an empty room does not self-advance',
    emptyHeld && idempotent && noopElsewhere,
    `empty room held='${emptyHeld}' idempotent='${idempotent}' no-op in 'score'='${noopElsewhere}'`);
}

// D2: host drops mid-game; a host-only action from the promoted host must succeed.
async function testD2() {
  const { host, others } = await makeRoom('bluff', 3);
  host.send({ type: 'START_GAME' });
  await sleep(120);

  if (host.state.phase === 'lobby') {
    return check('D2', 'host-only actions work after a mid-game host drop',
      false, 'setup failed: game did not start');
  }

  const hostIdxBefore = others[0].state.hostIdx;
  host.ws.close();
  await sleep(200);

  const promoted = others[0].state.hostIdx;
  // The promoted host issues a host-gated action. Pre-fix this returns "Host only".
  const actor = others.find(c => c.idx === promoted) || others[0];
  actor.errors.length = 0;
  actor.send({ type: 'START_WRITING' });
  await sleep(200);

  const advanced = actor.state.phase === 'writing';
  check('D2', 'host-only actions work after a mid-game host drop',
    promoted !== hostIdxBefore && advanced,
    `hostIdx ${hostIdxBefore} → ${promoted}; phase '${actor.state.phase}'` +
    (actor.errors.length ? `; errors: ${JSON.stringify(actor.errors)}` : ''));

  others.forEach(c => { try { c.ws.close(); } catch {} });
}

(async () => {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise(res => srv.stdout.on('data', d => String(d).includes('listening') && res()));

  try {
    await testD1();
    await testD2();
    await testD3();
    await testD4();
    await testD5();
  } finally {
    srv.kill();
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
