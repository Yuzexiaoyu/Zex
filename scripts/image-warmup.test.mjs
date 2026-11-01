import assert from 'node:assert/strict';
import { test } from 'node:test';

let instance = 0;
async function fixture(t, options = {}) {
  const api = await import(new URL(`../src/utils/preloadImages.ts?test=${++instance}`, import.meta.url));
  const images = [];
  const timers = new Map();
  let serial = 0;
  let active = 0;
  let peak = 0;
  const globals = {
    window: {
      setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, delay, image: images.at(-1) }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    Image: class {
      naturalWidth = 100;
      naturalHeight = 100;
      fetchPriority = 'auto';
      constructor() { images.push(this); }
      set src(value) {
        this.source = value;
        this.priorityAtStart = this.fetchPriority;
        [this.naturalWidth, this.naturalHeight] = options.sizes?.[value] ?? [100, 100];
        if (options.behavior?.[value] === 'src-throw') throw new Error('source rejected');
      }
      get src() { return this.source; }
      decode() {
        this.decodeCalls = (this.decodeCalls ?? 0) + 1;
        if (options.behavior?.[this.src] === 'throw') throw new Error('decode rejected synchronously');
        active++;
        peak = Math.max(peak, active);
        const promise = new Promise((resolve, reject) => {
          this.finish = resolve;
          this.fail = () => reject(new Error('decode failed'));
          if (options.behavior?.[this.src] === 'reject') this.fail();
          else if (options.auto) resolve();
        });
        return promise.then(() => { active--; }, (error) => { active--; throw error; });
      }
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    });
  }
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return {
    ...api, images, timers, flush,
    get sources() { return images.map((image) => image.src); },
    get peak() { return peak; },
    async finish(src) { assert.ok(images.some((image) => image.src === src)); images.findLast((image) => image.src === src).finish(); await flush(); },
    async expire(src) {
      const entry = [...timers].find(([, timer]) => timer.image.src === src);
      assert.ok(entry, `${src} must have a pending timeout`);
      const [id, timer] = entry;
      assert.equal(timer.delay, 2500);
      timers.delete(id);
      timer.callback();
      await flush();
    },
  };
}

test('legacy prepareImages ignores empty/duplicate URLs and reuses prepared native images', async (t) => {
  const f = await fixture(t);
  const pending = f.prepareImages(['', 'a', 'a', 'b', '']);
  assert.deepEqual(f.sources, ['a', 'b']);
  assert.equal(f.isImagePrepared(''), true);
  assert.equal(f.isImagePrepared('a'), false);
  for (const image of f.images) {
    assert.equal(image.priorityAtStart, 'auto');
    assert.equal(image.decoding, 'async');
    assert.equal(image.decodeCalls, 1);
  }
  await f.finish('a');
  await f.finish('b');
  assert.equal(await pending, undefined);
  await f.prepareImages(['a', 'b']);
  assert.equal(f.images.length, 2);
  assert.equal(f.isImagePrepared('a'), true);
  assert.equal(f.timers.size, 0);
});

test('foreground preparation shares and promotes an inflight warmup without downgrading it', async (t) => {
  const f = await fixture(t);
  const low = f.warmImages(['a']);
  assert.equal(f.images[0].priorityAtStart, 'low', 'priority is set before src starts the request');
  const normal = f.prepareImages(['a']);
  assert.equal(f.images[0].fetchPriority, 'auto');
  const high = f.prepareImages(['a'], { priority: 'high' });
  assert.equal(f.images[0].fetchPriority, 'high');
  const anotherLow = f.warmImages(['a']);
  assert.equal(f.images[0].fetchPriority, 'high');
  assert.equal(f.images.length, 1);
  assert.equal(f.images[0].decodeCalls, 1);
  await f.finish('a');
  await Promise.all([low, normal, high, anotherLow]);
  assert.equal(f.isImagePrepared('a'), true);
});

test('background warmup starts at most two sources and consumes the unique queue in order', async (t) => {
  const f = await fixture(t);
  const pending = f.warmImages(['', 'a', 'a', 'b', 'c', '', 'd', 'e']);
  assert.deepEqual(f.sources, ['a', 'b']);
  await f.finish('b');
  assert.deepEqual(f.sources, ['a', 'b', 'c']);
  await f.finish('a');
  assert.deepEqual(f.sources, ['a', 'b', 'c', 'd']);
  await f.finish('c');
  assert.deepEqual(f.sources, ['a', 'b', 'c', 'd', 'e']);
  await f.finish('d');
  await f.finish('e');
  assert.equal(await pending, undefined);
  assert.equal(f.peak, 2);
  assert.ok(f.images.every((image) => image.priorityAtStart === 'low'));
});

test('requested warmup can use four high-priority workers', async (t) => {
  const f = await fixture(t);
  const pending = f.warmImages(['a', 'b', 'c', 'd', 'e'], { priority: 'high', concurrency: 4 });
  assert.deepEqual(f.sources, ['a', 'b', 'c', 'd']);
  for (const src of ['a', 'b', 'c', 'd', 'e']) await f.finish(src);
  await pending;
  assert.equal(f.peak, 4);
  assert.ok(f.images.every((image) => image.priorityAtStart === 'high'));
});

test('abort stops queued sources while started images settle into the shared cache', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const pending = f.warmImages(['a', 'b', 'c', 'd'], { signal: controller.signal });
  controller.abort();
  await f.finish('a');
  await f.finish('b');
  await pending;
  assert.deepEqual(f.sources, ['a', 'b']);
  assert.equal(f.isImagePrepared('a'), true);
  assert.equal(f.isImagePrepared('b'), true);
  assert.equal(f.isImagePrepared('c'), false);
  await f.prepareImages(['a', 'b']);
  assert.equal(f.images.length, 2);
});

test('already-aborted and empty warmups start no images', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await f.warmImages(['a', 'b'], { signal: controller.signal });
  await f.warmImages(['', '']);
  assert.equal(f.images.length, 0);
  assert.equal(f.timers.size, 0);
});

test('32-entry LRU budget retains recent hits and evicts only the oldest source', async (t) => {
  const f = await fixture(t, { auto: true });
  const sources = Array.from({ length: 32 }, (_, index) => `cover-${index}`);
  await f.warmImages(sources);
  assert.ok(sources.every(f.isImagePrepared));
  await f.prepareImages(['cover-0']);
  await f.prepareImages(['cover-32']);
  assert.equal(f.isImagePrepared('cover-0'), true, 'cache hits refresh the LRU position');
  assert.equal(f.isImagePrepared('cover-1'), false);
  assert.equal(f.isImagePrepared('cover-2'), true);
  assert.equal(f.isImagePrepared('cover-32'), true);
  assert.equal([...sources, 'cover-32'].filter(f.isImagePrepared).length, 32);
  assert.equal(f.images.length, 33, 'cache hits do not decode again');
});

test('64 MiB decoded budget evicts LRU images before reaching the count limit', async (t) => {
  const sizes = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((src) => [src, [2048, 2048]]));
  const f = await fixture(t, { auto: true, sizes });
  await f.warmImages(['a', 'b', 'c', 'd']);
  assert.ok(['a', 'b', 'c', 'd'].every(f.isImagePrepared), 'four 16 MiB images fit exactly');
  await f.prepareImages(['a']);
  await f.prepareImages(['e']);
  assert.equal(f.isImagePrepared('b'), false);
  assert.ok(['a', 'c', 'd', 'e'].every(f.isImagePrepared));
});

test('an image larger than 64 MiB is decoded but not retained or allowed to evict useful images', async (t) => {
  const f = await fixture(t, { auto: true, sizes: { oversized: [4097, 4096] } });
  await f.prepareImages(['small']);
  await f.warmImages(['oversized']);
  assert.equal(f.isImagePrepared('small'), true);
  assert.equal(f.isImagePrepared('oversized'), false);
  await f.prepareImages(['oversized']);
  assert.deepEqual(f.sources, ['small', 'oversized', 'oversized']);
});

test('decode errors and synchronous failures release workers and remain retryable', async (t) => {
  const behavior = { missing: 'reject', broken: 'throw', invalid: 'src-throw' };
  const f = await fixture(t, { auto: true, behavior });
  await f.warmImages(['missing', 'broken', 'invalid', 'good']);
  assert.deepEqual(f.sources, ['missing', 'broken', 'invalid', 'good']);
  assert.equal(f.isImagePrepared('good'), true);
  for (const src of ['missing', 'broken', 'invalid']) {
    assert.equal(f.isImagePrepared(src), false);
    delete behavior[src];
  }
  await f.prepareImages(['missing', 'broken', 'invalid']);
  assert.ok(['missing', 'broken', 'invalid'].every(f.isImagePrepared));
  assert.equal(f.timers.size, 0);
});

test('timeout releases a worker; late completion cannot cache stale work or remove its retry', async (t) => {
  const f = await fixture(t);
  const warming = f.warmImages(['slow', 'next'], { concurrency: 1 });
  const first = f.images[0];
  await f.expire('slow');
  assert.deepEqual(f.sources, ['slow', 'next']);
  assert.equal(f.isImagePrepared('slow'), false);
  const retry = f.prepareImages(['slow'], { priority: 'high' });
  first.finish();
  await f.flush();
  assert.equal(f.isImagePrepared('slow'), false, 'a timed-out decode does not publish stale readiness');
  const sharedRetry = f.prepareImages(['slow']);
  assert.equal(f.images.length, 3, 'late old completion preserves the current inflight entry');
  await f.finish('slow');
  await f.finish('next');
  await Promise.all([warming, retry, sharedRetry]);
  assert.equal(f.isImagePrepared('slow'), true);
  assert.equal(f.timers.size, 0);
});

test('aborting a hung warmup settles at its timeout without starting more sources', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const pending = f.warmImages(['slow', 'unused'], { concurrency: 1, signal: controller.signal });
  controller.abort();
  await f.expire('slow');
  assert.equal(await pending, undefined);
  assert.deepEqual(f.sources, ['slow']);
});

test('invalid concurrency values remain bounded and cannot strand a nonempty queue', async (t) => {
  for (const concurrency of [0, -1, 1.9, NaN, Infinity]) {
    await t.test(String(concurrency), async (subtest) => {
      const f = await fixture(subtest, { auto: true });
      await f.warmImages(['a', 'b', 'c'], { concurrency });
      assert.deepEqual(f.sources, ['a', 'b', 'c']);
      assert.equal(f.peak, Number.isFinite(concurrency) ? 1 : 2);
    });
  }
});
