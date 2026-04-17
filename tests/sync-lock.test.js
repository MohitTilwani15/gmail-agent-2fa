import { describe, it, expect } from 'vitest';
import { runSerialized, _activeKeys } from '../src/services/sync-lock.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('runSerialized', () => {
  it('runs a single call exactly once', async () => {
    let calls = 0;
    await runSerialized('k1', async () => { calls++; });
    expect(calls).toBe(1);
    expect(_activeKeys()).not.toContain('k1');
  });

  it('coalesces a burst of concurrent callers into one follow-up', async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const gates = [deferred(), deferred()];

    const fn = async () => {
      const i = calls;
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      await gates[i].promise;
      active--;
    };

    // First run starts immediately.
    const a = runSerialized('k2', fn);
    // These five all arrive while the first is in-flight — they must share
    // a single follow-up, not spawn five sequential runs.
    const b = runSerialized('k2', fn);
    const c = runSerialized('k2', fn);
    const d = runSerialized('k2', fn);
    const e = runSerialized('k2', fn);
    const f = runSerialized('k2', fn);

    gates[0].resolve();
    gates[1].resolve();
    await Promise.all([a, b, c, d, e, f]);

    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
    expect(_activeKeys()).not.toContain('k2');
  });

  it('keys are independent', async () => {
    let active1 = 0;
    let active2 = 0;
    const g1 = deferred();
    const g2 = deferred();

    const p1 = runSerialized('kA', async () => { active1++; await g1.promise; active1--; });
    const p2 = runSerialized('kB', async () => { active2++; await g2.promise; active2--; });

    // Both should be running in parallel.
    await new Promise(r => setTimeout(r, 10));
    expect(active1).toBe(1);
    expect(active2).toBe(1);

    g1.resolve();
    g2.resolve();
    await Promise.all([p1, p2]);
  });

  it('propagates the primary rejection but still drains the follow-up', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) throw new Error('primary boom');
    };

    const primary = runSerialized('k3', fn);
    const follower = runSerialized('k3', fn);

    await expect(primary).rejects.toThrow('primary boom');
    await expect(follower).resolves.toBeUndefined();
    expect(calls).toBe(2);
    expect(_activeKeys()).not.toContain('k3');
  });

  it('propagates a follow-up rejection to the coalesced callers only', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 2) throw new Error('follow boom');
    };

    const primary = runSerialized('k4', fn);
    const follower1 = runSerialized('k4', fn);
    const follower2 = runSerialized('k4', fn);

    await expect(primary).resolves.toBeUndefined();
    await expect(follower1).rejects.toThrow('follow boom');
    await expect(follower2).rejects.toThrow('follow boom');
    expect(calls).toBe(2);
  });
});
