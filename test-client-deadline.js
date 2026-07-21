'use strict';

// Client-side proof for the phase-deadline countdown (C1–C5).
//
// Why this file exists at all: the server half of a deadline is strictly worse than no
// deadline if the client is silent about it — phases would start advancing out from
// under people with no warning. So "the countdown renders" is not polish, it is the
// other half of the fix, and it needs evidence like any other half.
//
// What this CANNOT tell you: whether the countdown is legible, well-placed, or noticed.
// jsdom resolves styles; it does not have eyes. Both-skins visual coverage is still
// open and is still nobody's green tick to give.
//
// Run: node test-client-deadline.js
// Requires jsdom, which is deliberately NOT in package.json — it is a local test-only
// dependency and this repo deploys its node_modules. Install with:
//   npm install jsdom --no-save

const fs = require('fs');
const path = require('path');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  console.error(
    'CANNOT RUN: jsdom is not installed.\n' +
    '            npm install jsdom --no-save\n' +
    '            No tests were run — this is not a test failure.'
  );
  process.exit(2);
}

const results = [];
function check(id, label, pass, detail) {
  results.push({ id, label, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${label}${detail ? `\n        ${detail}` : ''}`);
}

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function boot() {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  const win = dom.window;
  // The page opens a socket on load; there is no server here and we do not need one.
  win.WebSocket = function () { this.readyState = 0; this.send = () => {}; this.close = () => {}; };
  win.WebSocket.OPEN = 1;
  // Missing surface must read as FAIL, not as a crashed harness — a stack trace where a
  // red line belongs sends whoever reads it hunting the tests instead of the code.
  if (typeof win.renderDeadline !== 'function') return null;
  return win;
}

// Minimal state good enough for renderDeadline; it reads phase and deadline only.
function stateWith(phase, deadline) {
  return {
    code: 'TEST', gameType: 'bluff', phase, hostIdx: 0, round: 0, totalRounds: 2,
    players: [{ name: 'A', color: '#fff', score: 0, connected: true }],
    submissions: [], votes: [], lastDeltas: [0], settings: { turnSeconds: 0 },
    timerSeconds: 0, deadline,
  };
}

function run(win, phase, deadline, theme) {
  win.document.documentElement.setAttribute('data-theme', theme);
  // `state` is a top-level `let`, so it is not a window property — assigning
  // win.state would silently shadow it and test nothing. Rebind inside the realm.
  win.__testState = stateWith(phase, deadline);
  win.eval('state = window.__testState; renderDeadline();');
  const d = win.document.getElementById('deadline');
  return {
    text: d.textContent,
    shown: d.style.display !== 'none',
    urgent: d.classList.contains('urgent'),
    color: win.getComputedStyle(d).color,
  };
}

for (const theme of ['modern', 'retro']) {
  const win = boot();
  if (!win) {
    for (const id of ['C1', 'C2', 'C3', 'C4', 'C5']) {
      check(`${id}/${theme}`, 'phase-deadline countdown surface', false,
        'renderDeadline() is not defined in index.html — the client half is missing');
    }
    continue;
  }

  // C1 — no deadline on this phase means no countdown at all. The player must never
  // see a clock for a phase that has none; an idle indicator is worse than silence.
  const none = run(win, 'reveal', null, theme);
  check(`C1/${theme}`, 'a null deadline renders nothing',
    !none.shown && none.text === '',
    `display shown=${none.shown} text='${none.text}'`);

  // C2 — coarse while the server is coarse. Above 15s the server broadcasts every 15s,
  // so an exact number would sit frozen and read as a bug. Wording must not imply
  // per-second precision we are not being sent.
  const coarse = run(win, 'writing', { phase: 'writing', remaining: 74, total: 90 }, theme);
  check(`C2/${theme}`, 'a far-off deadline reads coarse, not falsely precise',
    coarse.shown && !coarse.urgent && !/\b74\b/.test(coarse.text),
    `text='${coarse.text}' urgent=${coarse.urgent} (must not print the raw 74)`);

  // C3 — exact and urgent under 15s, where the server does send every second.
  const urgent = run(win, 'writing', { phase: 'writing', remaining: 8, total: 90 }, theme);
  check(`C3/${theme}`, 'the last 15 seconds count down exactly and escalate',
    urgent.shown && urgent.urgent && /8s/.test(urgent.text),
    `text='${urgent.text}' urgent=${urgent.urgent} color=${urgent.color}`);

  // C4 — a deadline block left over from a phase we have already moved past must not
  // be drawn. This is the stale-frame case: STATE arrives, phase advanced, deadline
  // block describes the phase before it.
  const stale = run(win, 'voting', { phase: 'writing', remaining: 5, total: 90 }, theme);
  check(`C4/${theme}`, 'a deadline for a phase we have left is ignored',
    !stale.shown,
    `phase 'voting' with a 'writing' deadline → shown=${stale.shown} text='${stale.text}'`);

  // C5 — the deadline is not the game clock. #timer and #deadline must be separate
  // elements, so a 90s round timer and a 90s anti-stall backstop can never be read as
  // one number. Merging them was explicitly ruled against.
  const doc = win.document;
  const t = doc.getElementById('timer'), dl = doc.getElementById('deadline');
  check(`C5/${theme}`, 'the deadline is a distinct element from the game clock',
    !!t && !!dl && t !== dl && dl.className.indexOf('timer') === -1,
    `#timer and #deadline both present and distinct (deadline.class='${dl.className || 'deadline'}')`);

  win.close();
}

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
