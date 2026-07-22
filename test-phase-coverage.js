'use strict';

// Phase-coverage guard (platform tooling — George).
//
// WHY THIS EXISTS
// KNOWN_PHASES in index.html gates every client render path: a phase the set
// does not contain hits the waiting-screen fallback, and the board never
// advances. That set is built from PHASES_BY_GAME + SHARED_PHASES — two
// hand-maintained lists. capture.js keeps its own mirror of the same two
// lists. The game modules (game*.js) are the ONLY real source of truth for
// which phases actually get emitted (`room.phase = '...'`). Nothing mechanical
// stopped those hand-lists from drifting out from under the modules, and a
// module that starts emitting a new phase without someone hand-editing two
// files in index.html and capture.js silently breaks that game's board.
//
// This test derives the truth from the module sources and fails — naming the
// exact game and phase — the moment any hand-maintained list is short. It is
// the guard that a "KNOWN_PHASES is short by N phases" report should never be
// able to surprise us again.
//
// It changes no product logic; it only reads the module sources and the two
// phase lists and asserts they agree. Runs offline, no server, no sockets.

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const MODULE_FILES = {
  hues: 'game.js',
  spectrum: 'game-spectrum.js',
  trivia: 'game-trivia.js',
  bluff: 'game-bluff.js',
  pictionary: 'game-pictionary.js',
};
// 'lobby' is set by the router's createRoom, not inside a game module — every
// game passes through it, so it is a shared phase that no module file emits.
const ROUTER_EMITTED = ['lobby'];

// Every phase a module actually assigns to room.phase. Deliberately derived by
// reading the source rather than by requiring the module and driving it: it is
// the assignment sites we care about, and a static read cannot miss a branch
// that a given play-through happens not to reach.
function phasesEmittedBy(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const set = new Set();
  const re = /\.phase\s*=\s*['"]([a-zA-Z]+)['"]/g;
  let m;
  while ((m = re.exec(src))) set.add(m[1]);
  return set;
}

// Pull the two phase lists out of a file that defines them as object/array
// literals (index.html and capture.js both do). Returns {byGame, shared}.
function readPhaseLists(file, label) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const byGameMatch = src.match(/PHASES_BY_GAME\s*=\s*(\{[\s\S]*?\})/);
  const sharedMatch = src.match(/SHARED_PHASES\s*=\s*(\[[^\]]*\])/);
  if (!byGameMatch) throw new Error(`${label}: could not find PHASES_BY_GAME`);
  if (!sharedMatch) throw new Error(`${label}: could not find SHARED_PHASES`);
  // eslint-disable-next-line no-eval
  const byGame = eval('(' + byGameMatch[1] + ')');
  // eslint-disable-next-line no-eval
  const shared = eval(sharedMatch[1]);
  return { byGame, shared };
}

function main() {
  const failures = [];

  // 1. What each module truly emits.
  const emitted = {};
  const allEmitted = new Set(ROUTER_EMITTED);
  for (const [game, file] of Object.entries(MODULE_FILES)) {
    emitted[game] = phasesEmittedBy(file);
    for (const p of emitted[game]) allEmitted.add(p);
  }

  // 2. index.html — the set that actually gates rendering.
  const idx = readPhaseLists('index.html', 'index.html');
  const known = new Set([...idx.shared, ...Object.values(idx.byGame).flat()]);

  // Every emitted phase must be renderable.
  for (const p of allEmitted) {
    if (!known.has(p)) {
      const owner = Object.keys(emitted).find((g) => emitted[g].has(p)) || 'router';
      failures.push(`index.html KNOWN_PHASES is missing '${p}' (emitted by ${owner}) — that phase hits the waiting-screen fallback and its board never advances`);
    }
  }

  // Per-game specificity: each game's emitted, non-shared phases must be listed
  // under that game in PHASES_BY_GAME (so the render path attributes correctly).
  for (const [game, phases] of Object.entries(emitted)) {
    const listed = new Set([...(idx.byGame[game] || []), ...idx.shared]);
    for (const p of phases) {
      if (!listed.has(p)) {
        failures.push(`index.html PHASES_BY_GAME.${game} does not list '${p}' which ${MODULE_FILES[game]} emits`);
      }
    }
  }

  // 3. capture.js mirror must match index.html, or coverage reporting lies.
  let cap;
  try {
    cap = readPhaseLists('capture.js', 'capture.js');
  } catch (e) {
    failures.push(`capture.js: ${e.message}`);
  }
  if (cap) {
    const capKnown = new Set([...cap.shared, ...Object.values(cap.byGame).flat()]);
    for (const p of known) if (!capKnown.has(p)) failures.push(`capture.js phase lists are missing '${p}' present in index.html — its coverage report would under-count`);
    for (const p of capKnown) if (!known.has(p)) failures.push(`capture.js phase lists carry '${p}' absent from index.html — mirror drift`);
  }

  // Report.
  const emittedSummary = Object.entries(emitted)
    .map(([g, s]) => `${g}:[${[...s].sort().join(',')}]`)
    .join('  ');
  console.log('modules emit   ', emittedSummary);
  console.log('KNOWN_PHASES   ', [...known].sort().join(','));
  console.log('emitted union  ', [...allEmitted].sort().join(','));

  if (failures.length) {
    console.log(`\n${failures.length} phase-coverage failure(s):`);
    for (const f of failures) console.log('  FAIL  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS  every phase the ${Object.keys(MODULE_FILES).length} game modules emit is in KNOWN_PHASES, attributed per game, and mirrored in capture.js`);
}

main();
