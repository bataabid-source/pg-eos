// WBS 2.16 part 1a-2 — RED tests for the offline queue (brief Master decisions 1 & 2).
//
// `apps/pda/src/offline-queue.ts` does not exist yet (pg-frontend builds it next) — this whole
// file is RED because the import below cannot resolve. It exercises the minimal, dependency-free
// IndexedDB wrapper (one object store `queue`, `keyPath: 'id'`, db name `pda-offline-queue`) via
// `enqueue`, `list`, `count`, `subscribe`, and the pure `queueStatus` threshold function (doc 40
// §D4: green 0 / yellow 1-20 / red > 20).
//
// jsdom has no native IndexedDB — `fake-indexeddb/auto` polyfills the global `indexedDB` for this
// file only (pg-frontend declares `fake-indexeddb` as a devDependency in package.json; this import
// does not require any change to apps/pda/src/test-setup.ts, which is outside pg-tester's write
// scope).
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';

import { enqueue, list, count, subscribe, queueStatus } from '../../src/offline-queue';

// Each test gets a fresh database (Master decision 1's fixed db name `pda-offline-queue`) so
// count()/list() assertions are not polluted by entries written in a previous test.
beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('pda-offline-queue');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
});

describe('PDA offline queue — IndexedDB wrapper (Master decision 1)', () => {
  it('enqueue() then count() reports 1 after a single entry', async () => {
    await enqueue({ scan: 'ABC' });

    await expect(count()).resolves.toBe(1);
  });

  it('enqueue() twice then list() returns both entries with correct payloads and generated UUID id/createdAt', async () => {
    await enqueue({ scan: 'A' });
    await enqueue({ scan: 'B' });

    const entries = await list();

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.payload)).toEqual(
      expect.arrayContaining([{ scan: 'A' }, { scan: 'B' }]),
    );
    for (const entry of entries) {
      expect(typeof entry.id).toBe('string');
      expect(entry.id.length).toBeGreaterThan(0);
      // createdAt must be a genuine, parseable timestamp (an ISO string, per the brief's entry
      // shape { id, createdAt, payload }).
      expect(() => new Date(entry.createdAt).toISOString()).not.toThrow();
    }
    // UUID keys (Master decision 1) — the two entries must have distinct ids.
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
  });

  it("subscribe()'s callback fires after a successful enqueue", async () => {
    let calls = 0;
    const unsubscribe = subscribe(() => {
      calls += 1;
    });

    await enqueue({ scan: 'C' });

    // Exactly one enqueue must fire the callback exactly once — a subscribe implementation that
    // double-fires per write (a bug) must fail this test.
    expect(calls).toBe(1);
    unsubscribe();
  });

  it('the returned unsubscribe function stops further callbacks', async () => {
    let calls = 0;
    const unsubscribe = subscribe(() => {
      calls += 1;
    });

    await enqueue({ scan: 'D' });
    const callsAfterFirstEnqueue = calls;
    unsubscribe();

    await enqueue({ scan: 'E' });

    expect(calls).toBe(callsAfterFirstEnqueue);
  });

  describe('queueStatus() — doc 40 §D4 thresholds, verbatim (pure function, no IndexedDB needed)', () => {
    it('n === 0 -> "green"', () => {
      expect(queueStatus(0)).toBe('green');
    });

    it('n === 1 -> "yellow" (lower boundary of 1-20)', () => {
      expect(queueStatus(1)).toBe('yellow');
    });

    it('n === 20 -> "yellow" (upper boundary of 1-20)', () => {
      expect(queueStatus(20)).toBe('yellow');
    });

    it('n === 21 -> "red" (first value above 20)', () => {
      expect(queueStatus(21)).toBe('red');
    });
  });
});
