import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCoverCache } from '../src/utils/cover-cache.ts';

function fixture(options = {}) {
  const calls = [];
  const pending = new Map();
  const revoked = [];
  let time = 0;
  let serial = 0;
  const cache = createCoverCache({
    fetch: (source) => {
      calls.push(source);
      return new Promise((resolve, reject) => pending.set(source, { resolve, reject }));
    },
    createObjectURL: () => `blob:test-${++serial}`,
    revokeObjectURL: (url) => revoked.push(url),
    now: () => time,
    ...options,
  });
  return {
    cache, calls, revoked,
    advance: (ms) => { time += ms; },
    async finish(source, size = 4, status = 200) {
      assert.ok(pending.has(source), `${source} must have started`);
      pending.get(source).resolve({ ok: status >= 200 && status < 300, blob: async () => new Blob([new Uint8Array(size)]) });
      pending.delete(source);
      // Let the fetch and blob promises, then cache publication, complete.
      for (let i = 0; i < 8; i++) await Promise.resolve();
    },
  };
}

test('same-source inflight loads and three remounts reuse one retained result', async () => {
  const f = fixture();
  const a = f.cache.request('cover?v=1');
  const b = f.cache.request('cover?v=1');
  assert.deepEqual(f.calls, ['cover?v=1']);
  a.release();
  assert.equal(await a.promise, null);
  await f.finish('cover?v=1');
  const result = await b.promise;
  assert.equal(result.status, 'ready');
  b.release();
  for (let i = 0; i < 3; i++) {
    const revisit = f.cache.request('cover?v=1');
    assert.deepEqual(revisit.initial, result);
    revisit.release();
  }
  assert.equal(f.calls.length, 1);
  assert.equal(f.revoked.length, 0);
});

test('failure is shared across three remounts, expires, and versions retry immediately', async () => {
  const f = fixture();
  const first = f.cache.request('missing?v=1');
  await f.finish('missing?v=1', 0, 404);
  assert.deepEqual(await first.promise, { status: 'error' });
  first.release();
  for (let i = 0; i < 3; i++) {
    const revisit = f.cache.request('missing?v=1');
    assert.deepEqual(revisit.initial, { status: 'error' });
    revisit.release();
  }
  assert.equal(f.calls.length, 1);
  const version = f.cache.request('missing?v=2');
  await f.finish('missing?v=2');
  assert.equal((await version.promise).status, 'ready');
  version.release();
  f.advance(30_000);
  const retry = f.cache.request('missing?v=1');
  assert.equal(retry.initial, null);
  await f.finish('missing?v=1');
  retry.release();
  assert.deepEqual(f.calls, ['missing?v=1', 'missing?v=2', 'missing?v=1']);
});

test('negative cache stays bounded and network failures share cooldown', async () => {
  let calls = 0;
  const cache = createCoverCache({ maxFailures: 2, fetch: async () => { calls++; throw new Error('offline'); } });
  for (const source of ['a', 'b', 'c']) {
    const request = cache.request(source);
    assert.deepEqual(await request.promise, { status: 'error' });
    request.release();
  }
  assert.equal(cache.getStats().failures, 2);
  const hit = cache.request('c');
  assert.deepEqual(hit.initial, { status: 'error' });
  hit.release();
  assert.equal(calls, 3);
  const evicted = cache.request('a');
  await evicted.promise;
  evicted.release();
  assert.equal(calls, 4);
  assert.equal(cache.getStats().failures, 2);
});

test('six concurrent requests use LIFO promotion and discard abandoned queued work', async () => {
  const f = fixture();
  const started = Array.from({ length: 6 }, (_, i) => f.cache.request(`active-${i}`));
  const old = f.cache.request('old');
  const fresh = f.cache.request('fresh');
  const abandoned = f.cache.request('abandoned');
  abandoned.release();
  assert.equal(await abandoned.promise, null);
  const promoted = f.cache.request('old');
  assert.equal(f.calls.length, 6);
  assert.equal(f.cache.getStats().active, 6);
  assert.equal(f.cache.getStats().queued, 2);
  await f.finish('active-0');
  assert.equal(f.calls.at(-1), 'old');
  assert.equal(f.cache.getStats().active, 6);
  await f.finish('active-1');
  assert.equal(f.calls.at(-1), 'fresh');
  await Promise.all(['active-2', 'active-3', 'active-4', 'active-5', 'old', 'fresh'].map((source) => f.finish(source)));
  [...started, old, fresh, promoted].forEach((request) => request.release());
  assert.equal(f.calls.includes('abandoned'), false);
  assert.equal(f.cache.getStats().active, 0);
  assert.equal(f.cache.getStats().queued, 0);
});

test('started requests survive unmount, but no dead lease pins an oversized entry', async () => {
  const f = fixture({ maxBytes: 4 });
  const request = f.cache.request('oversized');
  request.release();
  await f.finish('oversized', 10);
  assert.deepEqual(f.revoked, ['blob:test-1']);
  assert.equal(f.cache.getStats().bytes, 0);
  assert.equal(f.cache.getStats().entries, 0);
});

test('all consumers are pinned before publication; releasing the last restores the byte budget', async () => {
  const f = fixture({ maxBytes: 4 });
  const a = f.cache.request('oversized');
  const b = f.cache.request('oversized');
  await f.finish('oversized', 10);
  assert.deepEqual(await a.promise, await b.promise);
  assert.equal(f.cache.getStats().bytes, 10);
  assert.deepEqual(f.revoked, []);
  a.release();
  a.release();
  assert.deepEqual(f.revoked, []);
  b.release();
  assert.deepEqual(f.revoked, ['blob:test-1']);
  assert.equal(f.cache.getStats().bytes, 0);
});

test('count limit is inclusive, hits update LRU, and mounted older entries are protected', async () => {
  const f = fixture({ maxEntries: 2 });
  const a = f.cache.request('a');
  await f.finish('a');
  a.release();
  const b = f.cache.request('b');
  await f.finish('b');
  b.release();
  assert.equal(f.revoked.length, 0, 'exactly the entry limit should remain cached');
  const hit = f.cache.request('a');
  hit.release();
  const c = f.cache.request('c');
  await f.finish('c');
  assert.deepEqual(f.revoked, ['blob:test-2'], 'least recently used b is evicted');
  const heldA = f.cache.request('a');
  const d = f.cache.request('d');
  await f.finish('d');
  assert.equal(f.cache.getStats().entries, 3, 'active working set may exceed the limit');
  assert.deepEqual(f.revoked, ['blob:test-2']);
  c.release();
  assert.deepEqual(f.revoked, ['blob:test-2', 'blob:test-3']);
  assert.equal(f.cache.getStats().entries, 2);
  heldA.release();
  d.release();
});

test('invalid images retain active URLs, cool down, and late old errors do not poison replacements', async () => {
  const f = fixture();
  const a = f.cache.request('corrupt');
  const b = f.cache.request('corrupt');
  await f.finish('corrupt');
  a.reportError();
  assert.deepEqual(f.revoked, []);
  const miss = f.cache.request('corrupt');
  assert.deepEqual(miss.initial, { status: 'error' });
  miss.release();
  f.advance(30_000);
  const replacement = f.cache.request('corrupt');
  await f.finish('corrupt');
  const replacementResult = await replacement.promise;
  b.reportError();
  const hit = f.cache.request('corrupt');
  assert.deepEqual(hit.initial, replacementResult);
  a.release();
  assert.deepEqual(f.revoked, []);
  b.release();
  assert.deepEqual(f.revoked, ['blob:test-1']);
  assert.equal(f.cache.getStats().bytes, 4);
  replacement.release();
  hit.release();
});

test('visible high requests precede newer low requests, with LIFO inside each priority', async () => {
  const f = fixture({ maxConcurrent: 1 });
  const blocker = f.cache.request('active');
  const highOld = f.cache.request('high-old', 'high');
  const highNew = f.cache.request('high-new', 'high');
  const automatic = f.cache.request('automatic');
  const lowOld = f.cache.request('low-old', 'low');
  const lowNew = f.cache.request('low-new', 'low');
  for (const [finished, next] of [['active', 'high-new'], ['high-new', 'high-old'], ['high-old', 'automatic'], ['automatic', 'low-new'], ['low-new', 'low-old']]) {
    await f.finish(finished);
    assert.equal(f.calls.at(-1), next);
  }
  await f.finish('low-old');
  [blocker, highOld, highNew, automatic, lowOld, lowNew].forEach((request) => request.release());
});

test('shared sources use the highest priority among live leases without duplicate fetching', async () => {
  const f = fixture({ maxConcurrent: 1 });
  const blocker = f.cache.request('active');
  const low = f.cache.request('shared', 'low');
  const high = f.cache.request('shared', 'high');
  const latestLow = f.cache.request('shared', 'low');
  const automatic = f.cache.request('automatic');
  await f.finish('active');
  assert.equal(f.calls.at(-1), 'shared', 'a later low lease must not override the visible high lease');
  await f.finish('shared');
  assert.deepEqual(await high.promise, await low.promise);
  assert.deepEqual(await latestLow.promise, await low.promise);
  assert.equal(f.calls.filter((source) => source === 'shared').length, 1);
  await f.finish('automatic');
  [blocker, low, high, latestLow, automatic].forEach((request) => request.release());
});

test('queued leases support dynamic promotion, demotion, and removing the highest priority', async () => {
  const f = fixture({ maxConcurrent: 1 });
  const blocker = f.cache.request('active');
  const promoted = f.cache.request('promoted', 'low');
  const demoted = f.cache.request('demoted', 'high');
  const sharedLow = f.cache.request('shared', 'low');
  const sharedHigh = f.cache.request('shared', 'high');
  const automatic = f.cache.request('automatic');
  promoted.setPriority('high');
  demoted.setPriority('low');
  sharedHigh.release();
  sharedHigh.setPriority('high');
  assert.equal(await sharedHigh.promise, null);
  await f.finish('active');
  assert.equal(f.calls.at(-1), 'promoted');
  await f.finish('promoted');
  assert.equal(f.calls.at(-1), 'automatic', 'released high and demoted high leases no longer outrank auto');
  await f.finish('automatic');
  assert.equal(f.calls.at(-1), 'shared', 'remaining equal-priority requests retain LIFO');
  await f.finish('shared');
  assert.equal(f.calls.at(-1), 'demoted');
  await f.finish('demoted');
  [blocker, promoted, demoted, sharedLow, automatic].forEach((request) => request.release());
});

test('changing priorities preserves inflight loads, cached results, and their retained URLs', async () => {
  const f = fixture({ maxBytes: 1 });
  const request = f.cache.request('cover', 'low');
  request.setPriority('high');
  request.setPriority('auto');
  assert.deepEqual(f.calls, ['cover']);
  await f.finish('cover', 4);
  const result = await request.promise;
  request.setPriority('low');
  request.setPriority('high');
  const hit = f.cache.request('cover', 'low');
  hit.setPriority('high');
  assert.deepEqual(hit.initial, result);
  assert.deepEqual(await request.promise, result);
  assert.deepEqual(f.calls, ['cover']);
  assert.deepEqual(f.revoked, [], 'priority changes must retain the active blob even over budget');
  request.release();
  assert.deepEqual(f.revoked, []);
  hit.release();
  assert.deepEqual(f.revoked, [result.url]);
});
