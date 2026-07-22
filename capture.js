'use strict';

// Phase capture harness — the tool the "somebody needs eyes on this" gap was waiting on.
//
// Two stages, deliberately separate:
//   1. COLLECT — play every game through the real server with real websocket clients and
//      record the actual sanitized STATE payload at each phase. Fixtures are captured,
//      never hand-written, so a screen can never be "verified" against a state the
//      server would not really send.
//   2. RENDER — replay each fixture into the real index.html in headless Chrome and
//      screenshot it, once per skin.
//
// No new dependencies: it drives the Chrome already installed on the machine over CDP
// using the ws module the server already depends on. Nothing is installed, nothing is
// downloaded, nothing is published — it writes PNGs to captures/ and prints coverage.
//
// Run: node capture.js
//
// What this does and does not prove: it proves every phase renders, and produces an
// artefact a human can look at. It does not decide whether what it produced looks good.
// A person still has to open captures/ — this only makes that possible in one pass
// instead of impossible.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const WebSocket = require('ws');

const OUT_DIR = path.join(__dirname, 'captures');
const SKINS = ['modern', 'retro'];
// Both orientations, because the first run of this harness produced 36 screenshots of
// the same rotate-to-landscape interstitial and nothing else — a directory full of
// artefacts that looked like coverage and showed no game at all.
const VIEWPORTS = [
  { name: 'portrait', width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
  { name: 'landscape', width: 844, height: 390, deviceScaleFactor: 2, mobile: true },
];

// Mirrors PHASES_BY_GAME / SHARED_PHASES in index.html. Kept here so the harness can
// report what it did NOT reach — a capture run that silently skips a phase is exactly
// the "green that describes something else" failure we keep finding.
const PHASES_BY_GAME = {
  hues: ['ready', 'guess'],
  spectrum: ['ready', 'guess'],
  trivia: ['question', 'buzzed', 'judging'],
  bluff: ['reveal', 'writing', 'voting'],
  pictionary: ['drawing', 'guessed', 'timeout', 'vote'],
};
const SHARED_PHASES = ['lobby', 'score', 'over'];

// Mirrors PAINT_COLORS in game-pictionary.js — the server validates the exact string.
const PAINT_COLORS = ['#fff1e8','#ffec27','#ff004d','#ff77a8','#00e436','#29adff','#1d2b53','#000000'];

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

/* ============================ STAGE 1 — COLLECT ============================ */

function player(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const c = { ws, state: null, idx: null, code: null, seen: new Map() };
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'JOINED') { c.code = m.code; c.idx = m.yourIdx; }
    if (m.type === 'STATE') {
      c.state = m.state;
      // First sighting of a phase wins: it is the state a player actually arrives on.
      if (!c.seen.has(m.state.phase)) c.seen.set(m.state.phase, m.state);
    }
  });
  ws.on('error', () => {});
  c.send = o => ws.send(JSON.stringify(o));
  c.ready = new Promise(r => ws.on('open', r));
  return c;
}

async function table(port, gameType, count) {
  const host = player(port);
  await host.ready;
  host.send({ type: 'CREATE_ROOM', name: 'Ada', gameType, turnSeconds: 30 });
  await sleep(120);
  const others = [];
  for (let i = 1; i < count; i++) {
    const p = player(port);
    await p.ready;
    p.send({ type: 'JOIN_ROOM', code: host.code, name: ['Bo', 'Cy', 'Dee', 'Eli'][i - 1] });
    await sleep(80);
    others.push(p);
  }
  const t = { host, others, all: [host, ...others], extra: {} };
  // A phase's FIRST state is what a player arrives on, which for a board game is an
  // empty board. That is a real screen, but it is not the screen anyone plays on, and
  // a directory of empty boards reads as coverage while showing nothing. snap() lets a
  // driver also record the mid-phase state — board painted, markers placed.
  t.snap = label => { if (!t.extra[label]) t.extra[label] = t.host.state; };
  return t;
}

// Each driver plays ONE round of its game and returns. The runner loops it, taking
// NEXT_ROUND out of 'score' each time, until the room reaches 'over' — because 'over'
// is a real screen a player lands on and the previous version of this harness could
// never reach it. `count` is the table size; every fixture is the host's sanitized
// view, so a capture is one consistent player's screen rather than a composite.
const DRIVERS = {
  // hues and spectrum share a shape: cue giver gives a clue, then each guesser in
  // turnQueue order places one cell. hues was missing entirely from this harness —
  // five games ship, four were being captured.
  hues: { count: 4, round: gridRound },
  spectrum: { count: 4, round: gridRound },

  trivia: {
    count: 3,
    async round(t) {
      const buzzer = t.others[0];
      buzzer.send({ type: 'BUZZ' });
      await sleep(3400); // the real 3s buzz window has to close into 'judging'
      t.host.send({ type: 'MARK_CORRECT' });
      await sleep(250);
    },
  },

  bluff: {
    count: 4,
    async round(t) {
      t.host.send({ type: 'START_WRITING' });
      await sleep(250);
      // One distinct lie per player: a repeated string renders as two identical options
      // and reads like a client bug in the capture when it is only the fixture repeating.
      const lies = [
        'Blue was the last colour to get a name',
        'Cyan is a shade of grief in Old Norse',
        'Red reads as nearer than blue to the eye',
        'Purple cost more than gold by weight',
        'Green was banned in Victorian wallpaper',
      ];
      t.all.forEach((p, i) => p.send({ type: 'SUBMIT_BLUFF', text: lies[i] }));
      await sleep(400);
      // Vote by TEXT, not by index. Submissions are shuffled before display, so
      // `(i + 1) % n` lands on your own bluff roughly a quarter of the time — the
      // server rejects it, nobody notices, and the round sits in 'voting' until the
      // 45s deadline rescues it. That is how the earlier run captured bluff/score by
      // luck and lost it on the next one.
      t.all.forEach((p, i) => {
        const opts = p.state.submissions || [];
        const pos = opts.findIndex(s => s.text !== lies[i]);
        if (pos >= 0) p.send({ type: 'CAST_VOTE', votedIdx: pos });
      });
      await sleep(400);
    },
  },

  pictionary: {
    count: 4,
    async round(t) {
      const artistIdx = t.host.state.artistIdx;
      const artist = t.all.find(p => p.idx === artistIdx);
      const guesser = t.all.find(p => p.idx !== artistIdx);
      // Colours are hex strings from PAINT_COLORS, not indices. Sending an index gets
      // a { ok:false, silent:true } — every stroke this harness ever "painted" was
      // silently dropped, so every pictionary capture was of a blank board.
      for (let i = 0; i < 12; i++) artist.send({ type: 'PAINT_CELL', r: 4 + (i % 5), c: 6 + i, color: PAINT_COLORS[i % PAINT_COLORS.length] });
      await sleep(250);
      t.snap('drawing-painted');
      guesser.send({ type: 'SUBMIT_GUESS', text: artist.state.secretWord });
      await sleep(300);
      artist.send({ type: 'START_VOTE' });
      await sleep(250);
      // Every connected player, artist included — allDifficultyVoted() counts the
      // whole connected roster, so excluding the artist stalls the phase until the
      // 30s deadline fires. The old driver excluded them.
      t.all.forEach(p => p.send({ type: 'SUBMIT_DIFFICULTY', vote: 'medium' }));
      await sleep(400);
    },
  },
};

async function gridRound(t) {
  const cue = t.all.find(p => p.idx === t.host.state.cueGiver);
  cue.send({ type: 'CLUE_READY', clue: 'somewhere warm' });
  await sleep(300);
  // Walk the real turnQueue rather than assuming an order: whoever is up places a
  // distinct cell. Forcing a guess out of turn is how the last suite passed 50/50
  // against a phase the server would never actually produce.
  let n = 0;
  while (t.host.state.phase === 'guess' && n < 8) {
    const idx = t.host.state.turnQueue[0];
    const p = t.all.find(x => x.idx === idx);
    if (!p) break;
    p.send({ type: 'PLACE_GUESS', r: 5 + n, c: 8 + n * 3 });
    n++;
    await sleep(200);
    if (n === 1) t.snap('guess-placed');
  }
  await sleep(250);
}

// Plays a game to completion, collecting the first state seen in every phase.
async function playToOver(port, gameType, spec) {
  const t = await table(port, gameType, spec.count);
  t.host.send({ type: 'START_GAME' });
  await sleep(300);
  // Guard is a runaway stop, not an expected exit — if it fires, the phase is reported
  // as NOT CAPTURED rather than quietly missing.
  for (let guard = 0; guard < 40 && t.host.state && t.host.state.phase !== 'over'; guard++) {
    if (t.host.state.phase === 'score') {
      t.host.send({ type: 'NEXT_ROUND' });
      await sleep(300);
      continue;
    }
    await spec.round(t);
  }
  await sleep(200);
  // Say where it actually stopped. A driver that stalls mid-game otherwise shows up
  // only as a missing phase at the end, with no clue which round it died in.
  if (t.host.state.phase !== 'over') {
    console.log(`    stopped in phase '${t.host.state.phase}' at round ${t.host.state.round + 1}/${t.host.state.totalRounds}`);
  }
  return t;
}

// Pictionary 'timeout' is only reachable by letting the real 90s drawing timer expire:
// the server takes no client TIMER_EXPIRE, and shortening the round timer means editing
// server.js, which is GEORGE's. So the harness waits it out — one 95s table, once.
async function pictionaryTimeout(port) {
  const t = await table(port, 'pictionary', 3);
  t.host.send({ type: 'START_GAME' });
  await sleep(300);
  const artist = t.all.find(p => p.idx === t.host.state.artistIdx);
  for (let i = 0; i < 10; i++) artist.send({ type: 'PAINT_CELL', r: 6 + (i % 4), c: 10 + i, color: PAINT_COLORS[i % PAINT_COLORS.length] });
  const deadline = Date.now() + 110000;
  while (Date.now() < deadline && t.host.state.phase === 'drawing') {
    await sleep(5000);
    console.log(`    drawing… timerSeconds=${t.host.state.timerSeconds}`);
  }
  console.log(`    ended in phase '${t.host.state.phase}'`);
  await sleep(300);
  return t;
}

async function collect(port) {
  const fixtures = {};
  const take = (gameType, t) => {
    for (const [label, state] of Object.entries(t.extra)) {
      const k = `${gameType}/${label}`;
      if (!fixtures[k]) fixtures[k] = state;
    }
    for (const [phase, state] of t.host.seen) {
      const k = `${gameType}/${phase}`;
      if (!fixtures[k]) fixtures[k] = state;
    }
    t.all.forEach(p => { try { p.ws.close(); } catch {} });
  };

  for (const [gameType, spec] of Object.entries(DRIVERS)) {
    console.log(`  ${gameType}...`);
    take(gameType, await playToOver(port, gameType, spec));
    await sleep(150);
  }
  console.log('  pictionary/timeout (waiting out the real 90s round timer)...');
  take('pictionary', await pictionaryTimeout(port));
  return fixtures;
}

/* ============================ STAGE 2 — RENDER ============================ */

function cdpTargets(port) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: '/json/list' }, r => {
      let body = '';
      r.on('data', d => { body += d; });
      r.on('end', () => { try { res(JSON.parse(body)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

async function waitForChrome(port, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const targets = await cdpTargets(port);
      const page = targets.find(t => t.type === 'page');
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Chrome did not expose a debuggable page within 15s');
}

// Minimal CDP client. A dependency-free stand-in for puppeteer: we need four commands.
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
  const pending = new Map();
  let nextId = 1;
  const events = new Map();
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    } else if (m.method && events.has(m.method)) {
      events.get(m.method).forEach(fn => fn(m.params));
      events.delete(m.method);
    }
  });
  return {
    ready: new Promise(r => ws.on('open', r)),
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    once(method) {
      return new Promise(r => {
        if (!events.has(method)) events.set(method, []);
        events.get(method).push(r);
      });
    },
    close() { try { ws.close(); } catch {} },
  };
}

async function render(serverPort, fixtures) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hoc-capture-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });

  const shot = [];
  try {
    const page = await waitForChrome(debugPort);
    const c = cdp(page.webSocketDebuggerUrl);
    await c.ready;
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    const loaded = c.once('Page.loadEventFired');
    await c.send('Emulation.setDeviceMetricsOverride', VIEWPORTS[0]);
    await c.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` });
    await loaded;
    await sleep(400);

    for (const vp of VIEWPORTS) {
      await c.send('Emulation.setDeviceMetricsOverride', vp);
      await sleep(150);
      let lastGame = null;
      for (const [key, state] of Object.entries(fixtures)) {
        const gameOfKey = key.split('/')[0];
        // Reload between games. Fixtures are replayed into one long-lived page, and
        // the client does not clear another game's board on a gameType change — the
        // first landscape spectrum capture came out with pictionary's painted cells
        // still sitting on the grid. That is a plausible client bug in its own right
        // (leave a pictionary game, join a spectrum one, same page load) and it is
        // raised as one, but a capture must not show a state no player could reach.
        if (gameOfKey !== lastGame) {
          const reloaded = c.once('Page.loadEventFired');
          await c.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` });
          await reloaded;
          await sleep(350);
          lastGame = gameOfKey;
        }
        for (const skin of SKINS) {
          // rotateDismissed is forced: the interstitial is a real screen, but it is not
          // the screen under test, and leaving it up hides every game behind it.
          const expr = `(() => {
            rotateDismissed = true;
            applySkin(${JSON.stringify(skin)});
            handleMsg({type:'JOINED', code:'TEST', yourIdx:0});
            handleMsg({type:'STATE', state:${JSON.stringify(state)}});
            const rh = document.getElementById('rotateHint');
            if (rh) rh.classList.remove('game-active');
            // Same reason: the how-to-play card is a real screen shown once, and it
            // sits over every phase behind it if the capture never dismisses it.
            if (typeof dismissHtp === 'function') dismissHtp();
            const htp = document.getElementById('howToPlay');
            if (htp) htp.style.display = 'none';
            const hint = document.getElementById('htpScrollHint');
            if (hint) hint.style.display = 'none';
            return 'ok';
          })()`;
          const evaluated = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true });
          if (evaluated.exceptionDetails) {
            console.log(`  ERROR  ${key} [${skin}/${vp.name}] — ${evaluated.exceptionDetails.text}`);
            continue;
          }
          await sleep(180); // let transitions settle before the shutter
          const { data } = await c.send('Page.captureScreenshot', { format: 'png' });
          const file = path.join(OUT_DIR, `${key.replace('/', '-')}-${skin}-${vp.name}.png`);
          fs.writeFileSync(file, Buffer.from(data, 'base64'));
          shot.push(path.basename(file));
        }
      }
    }
    c.close();
  } finally {
    chrome.kill('SIGKILL'); // headless Chrome does not reliably exit on its own
    // Chrome is still flushing its profile as it dies, so the directory can refill
    // under rmSync. Cleanup failing must never lose the screenshots we came for.
    await sleep(300);
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      console.log(`  note: left temp profile behind (${e.code}) — ${profile}`);
    }
  }
  return shot;
}

/* ================================= MAIN ================================= */

(async () => {
  if (!fs.existsSync(CHROME)) {
    console.error(`CANNOT RUN — no Chrome at ${CHROME}`);
    process.exit(2);
  }

  const serverPort = await freePort();
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: serverPort },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    await new Promise((res, rej) => {
      srv.stdout.on('data', d => String(d).includes('listening') && res());
      srv.on('exit', code => rej(new Error(`server exited before listening (${code})`)));
      setTimeout(() => rej(new Error('server did not start within 5s')), 5000);
    });
  } catch (e) {
    console.error(`CANNOT RUN — ${e.message}`);
    srv.kill();
    process.exit(2);
  }

  let fixtures, shot;
  try {
    console.log('collecting states from real gameplay...');
    fixtures = await collect(serverPort);
    fs.writeFileSync(path.join(__dirname, 'capture-fixtures.json'), JSON.stringify(fixtures, null, 2));
    console.log(`captured ${Object.keys(fixtures).length} states`);
    // --collect-only: fixture work is seconds, rendering is minutes. Iterating on a
    // driver should not cost a full screenshot pass.
    shot = process.argv.includes('--collect-only') ? [] : (console.log('rendering...'), await render(serverPort, fixtures));
  } finally {
    srv.kill();
  }

  // Coverage, stated as a gap rather than a total: an uncaptured phase is the whole
  // point of running this, so it must not be possible to miss it in the output.
  const want = [];
  for (const [g, phases] of Object.entries(PHASES_BY_GAME)) {
    for (const p of [...phases, ...SHARED_PHASES]) want.push(`${g}/${p}`);
  }
  const got = new Set(Object.keys(fixtures));
  const missing = want.filter(k => !got.has(k));

  console.log(`\n${shot.length} screenshots → ${path.relative(process.cwd(), OUT_DIR)}/`);
  // Count canonical phases only. Mid-phase extras are bonus artefacts and must not
  // inflate the coverage number into something like "32/29", which reads as a pass
  // while saying nothing about whether every phase was reached.
  const covered = want.filter(k => got.has(k)).length;
  const extras = got.size - covered;
  console.log(`${covered}/${want.length} phase-views captured${extras ? ` (+${extras} mid-phase extras)` : ''}`);
  if (missing.length) {
    console.log(`\nNOT CAPTURED — no screenshot exists for these, they are unverified:`);
    for (const m of missing) console.log(`  ${m}`);
  }
  console.log('\nThis harness proves every captured phase renders. It does not judge how it');
  console.log('looks — open the directory. That part still needs a person.');
})();
