'use strict';

// Shared named-timer infrastructure. Rooms can hold multiple concurrent timers
// (e.g. a 'turn' timer and a 'buzz' timer), all tracked under room._timers.
// stopAllTimers must be called on room expiry and full disconnect to prevent leaks.

function startTimer(room, name, seconds, onTick, onExpire) {
  stopTimer(room, name); // replace any existing timer with this name
  if (!room._timers) room._timers = new Map();
  let remaining = seconds;
  const entry = { remaining };
  entry.intervalId = setInterval(() => {
    remaining = Math.max(0, remaining - 1);
    entry.remaining = remaining;
    if (onTick) onTick(remaining);
    if (remaining <= 0) {
      stopTimer(room, name);
      if (onExpire) onExpire();
    }
  }, 1000);
  room._timers.set(name, entry);
}

function stopTimer(room, name) {
  const entry = room._timers?.get(name);
  if (!entry) return;
  clearInterval(entry.intervalId);
  room._timers.delete(name);
}

// Call this on room expiry or when all players have disconnected.
function stopAllTimers(room) {
  if (!room._timers) return;
  for (const entry of room._timers.values()) clearInterval(entry.intervalId);
  room._timers.clear();
}

function getRemaining(room, name) {
  return room._timers?.get(name)?.remaining ?? 0;
}

module.exports = { startTimer, stopTimer, stopAllTimers, getRemaining };
