'use strict';

// Platform-infrastructure repros. Separate file from test-disconnect.js on purpose:
// that harness is shared with NIKO and covers game-module behaviour, this one covers
// server.js infrastructure and is GEORGE's to keep green.
//
//   P1 — half-open sockets. A backgrounded phone keeps a socket that never fires
//        'close', so the player stays 'connected' and every "waiting on all connected
//        players" phase waits on a ghost forever. The disconnect fix does not help:
//        there is no disconnect. Ping/pong has to manufacture one.
//   P2 — client version skew. index.html was read into memory once at boot, so a
//        long-lived process serves a stale client after the file changes underneath it.
//        Presents as a game bug; is a deploy bug.
//
// Run: node test-platform.js

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const HEARTBEAT_MS = 300; // real ping/pong, just faster than the 30s production default
let PORT = null;

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
function check(id, label, pass, detail) {
  results.push({ id, label, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${label}${detail ? `\n        ${detail}` : ''}`);
}

// opts.autoPong=false simulates a socket the OS still holds open but nobody answers on.
function client(name, opts = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, opts);
  const c = { name, ws, state: null, errors: [], idx: null };
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'STATE') c.state = m.state;
    else if (m.type === 'JOINED') { c.code = m.code; c.idx = m.yourIdx; }
    else if (m.type === 'ERROR') c.errors.push(m.message);
  });
  ws.on('error', () => {});
  c.send = obj => ws.send(JSON.stringify(obj));
  c.ready = new Promise(res => ws.on('open', res));
  return c;
}

function get(headers = {}) {
  // Drop undefined values: pre-fix the server sends no ETag, and passing an undefined
  // header throws — which would crash the harness instead of reporting an honest FAIL.
  const clean = Object.fromEntries(Object.entries(headers).filter(([, v]) => v != null));
  return new Promise(res => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/', headers: clean }, r => {
      let body = '';
      r.on('data', d => { body += d; });
      r.on('end', () => res({ status: r.statusCode, etag: r.headers.etag, body }));
    });
  });
}

// P1: the silent player never closes their socket — the server has to notice and cut it.
async function testP1() {
  const host = client('Host');
  await host.ready;
  host.send({ type: 'CREATE_ROOM', name: 'Host', gameType: 'bluff' });
  await sleep(80);

  const p1 = client('P1');
  await p1.ready;
  p1.send({ type: 'JOIN_ROOM', code: host.code, name: 'P1' });
  await sleep(60);

  // The ghost: connected, joined, and will never answer a ping again.
  const ghost = client('Ghost', { autoPong: false });
  await ghost.ready;
  ghost.send({ type: 'JOIN_ROOM', code: host.code, name: 'Ghost' });
  await sleep(60);

  host.send({ type: 'START_GAME' });
  await sleep(100);
  host.send({ type: 'START_WRITING' });
  await sleep(100);

  if (host.state.phase !== 'writing') {
    return check('P1', 'a silent half-open client stops hanging the room',
      false, `setup failed: expected phase 'writing', got '${host.state.phase}'`);
  }

  // Everyone who is really there submits. The ghost never will.
  host.send({ type: 'SUBMIT_BLUFF', text: 'host bluff' });
  p1.send({ type: 'SUBMIT_BLUFF', text: 'p1 bluff' });
  await sleep(150);

  const before = host.state.phase;
  // Two full heartbeat rounds: one to send the ping, one to notice it went unanswered.
  await sleep(HEARTBEAT_MS * 3);

  check('P1', 'a silent half-open client stops hanging the room',
    host.state.phase === 'voting',
    `phase with ghost present '${before}', after ${HEARTBEAT_MS * 3}ms of heartbeat '${host.state.phase}' (expected 'voting')`);

  [host, p1, ghost].forEach(c => { try { c.ws.close(); } catch {} });
}

// P2: the served client must track the file on disk, not the file as it was at boot.
async function testP2() {
  const indexPath = path.join(__dirname, 'index.html');
  const original = fs.statSync(indexPath);

  const first = await get();
  const revalidated = await get({ 'If-None-Match': first.etag });

  // Touch mtime only — the file's bytes are never modified by this test.
  const future = new Date(original.mtimeMs + 60000);
  fs.utimesSync(indexPath, future, future);
  let afterTouch;
  try {
    afterTouch = await get({ 'If-None-Match': first.etag });
  } finally {
    fs.utimesSync(indexPath, original.atime, original.mtime); // always restore
  }

  const served = first.status === 200 && !!first.etag;
  const cheap = revalidated.status === 304;
  const noticed = afterTouch.status === 200 && afterTouch.etag !== first.etag;

  check('P2', 'a changed index.html is served without restarting the process',
    served && cheap && noticed,
    `first ${first.status} etag=${first.etag}; revalidate ${revalidated.status}; ` +
    `after touch ${afterTouch.status} etag=${afterTouch.etag}`);
}

(async () => {
  PORT = await freePort();
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT, HEARTBEAT_MS },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const up = new Promise((res, rej) => {
    srv.stdout.on('data', d => String(d).includes('listening') && res());
    srv.on('exit', code => rej(new Error(`server exited before listening (code ${code})`)));
    setTimeout(() => rej(new Error('server did not start within 5s')), 5000);
  });
  try {
    await up;
  } catch (e) {
    console.error(`CANNOT RUN — ${e.message}`);
    srv.kill();
    process.exit(2);
  }

  try {
    await testP1();
    await testP2();
  } finally {
    srv.kill();
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
