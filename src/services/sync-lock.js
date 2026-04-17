// Serializes async runs per key with coalescing.
// If a run for `key` is active, subsequent calls coalesce into a single
// follow-up that executes once the current run finishes. All callers queued
// during that interval share the same follow-up promise, so a burst of N
// concurrent requests produces at most 2 sequential executions.
const state = new Map();

export function runSerialized(key, fn) {
  const existing = state.get(key);

  if (existing) {
    if (!existing.pending) {
      existing.pending = new Promise((resolve, reject) => {
        existing.resolve = resolve;
        existing.reject = reject;
      });
    }
    return existing.pending;
  }

  const entry = { pending: null, resolve: null, reject: null };
  state.set(key, entry);

  const loop = async () => {
    try {
      await fn();
    } finally {
      while (entry.pending) {
        const resolve = entry.resolve;
        const reject = entry.reject;
        entry.pending = null;
        entry.resolve = null;
        entry.reject = null;
        try {
          await fn();
          resolve();
        } catch (err) {
          reject(err);
        }
      }
      state.delete(key);
    }
  };

  return loop();
}

// Test-only helper to confirm the map is empty between tests.
export function _activeKeys() {
  return Array.from(state.keys());
}
