import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preloadStatsImages } from '../src/utils/statsPreload.ts';

function fixture(t, decode = () => Promise.resolve()) {
  const frames = new Map();
  const timers = new Map();
  const events = [];
  let nextId = 0;
  let resize;
  let disconnected = false;
  const globals = {
    window: {
      innerHeight: 600,
      setTimeout: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
      clearTimeout: (id) => timers.delete(id),
    },
    requestAnimationFrame: (callback) => { const id = ++nextId; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
    ResizeObserver: class {
      constructor(callback) { resize = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    },
  };
  const restoreGlobals = [];
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    restoreGlobals.push(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    });
  }
  const images = Array.from({ length: 8 }, (_, index) => ({
    src: `cover-${index}`,
    set loading(value) { events.push(`write:${index}:${value}`); },
    set fetchPriority(value) { events.push(`priority:${index}:${value}`); },
    decode() { events.push(`decode:${index}`); return decode(index); },
  }));
  const bounds = { top: 0, bottom: 300, width: 800, height: 300 };
  const page = {
    getBoundingClientRect: () => bounds,
    querySelectorAll: () => [{
      getBoundingClientRect: () => bounds,
      querySelectorAll: () => images.map((image, index) => ({
        getBoundingClientRect() { events.push(`read:${index}`); return { top: index * 100, bottom: index * 100 + 90 }; },
        querySelector: () => image,
      })),
    }],
  };
  let ready = 0;
  let result;
  const dispose = preloadStatsImages(page, (value) => { ready++; result = value; });
  t.after(() => {
    dispose();
    restoreGlobals.forEach((restore) => restore());
  });
  return {
    events, images, bounds, frames, timers, dispose,
    resize: () => resize(),
    get ready() { return ready; },
    get result() { return result; },
    get disconnected() { return disconnected; },
    async flush() {
      const queued = [...frames.values()];
      frames.clear();
      queued.forEach((callback) => callback());
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test('preloads only viewport plus one row; batches layout reads before writes', async (t) => {
  const f = fixture(t);
  assert.equal(f.events.length, 0, 'initialization must not synchronously measure layout');
  f.resize();
  f.resize();
  assert.equal(f.frames.size, 1, 'initial resize and mount share one frame');
  await f.flush();
  assert.deepEqual(f.events.filter((event) => event.startsWith('decode:')), ['decode:0', 'decode:1', 'decode:2', 'decode:3']);
  assert.ok(f.events.findLastIndex((event) => event.startsWith('read:')) < f.events.findIndex((event) => event.startsWith('write:')));
  assert.equal(f.ready, 1);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.result, { unavailableSources: [], timedOut: false });
});

test('hung image releases page at timeout; late decode does not notify twice', async (t) => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const f = fixture(t, () => pending);
  await f.flush();
  assert.equal(f.ready, 0);
  const timer = [...f.timers.values()][0];
  assert.equal(timer.delay, 400);
  timer.callback();
  assert.equal(f.ready, 1);
  assert.deepEqual(f.result, { unavailableSources: ['cover-0', 'cover-1', 'cover-2', 'cover-3'], timedOut: true });
  resolve();
  await f.flush();
  assert.equal(f.ready, 1);
  assert.equal(f.result.timedOut, true, 'late completion cannot alter the committed timeout result');
});

test('broken image does not block readiness', async (t) => {
  const f = fixture(t, () => Promise.reject(new Error('missing cover')));
  await f.flush();
  assert.equal(f.ready, 1);
  assert.deepEqual(f.result, { unavailableSources: ['cover-0', 'cover-1', 'cover-2', 'cover-3'], timedOut: false });
});

test('resize reuses decodes, loads newly exposed rows and handles changed sources', async (t) => {
  const f = fixture(t);
  await f.flush();
  f.events.length = 0;
  f.bounds.bottom = 500;
  f.bounds.height = 500;
  f.images[0].src = 'replacement-cover';
  f.resize();
  f.resize();
  await f.flush();
  assert.deepEqual(f.events.filter((event) => event.startsWith('decode:')), ['decode:0', 'decode:4', 'decode:5']);
  assert.equal(f.ready, 1);
});

test('zero-sized page waits for valid layout', async (t) => {
  const f = fixture(t);
  f.bounds.width = 0;
  await f.flush();
  assert.equal(f.ready, 0);
  assert.equal(f.events.length, 0);
  assert.equal(f.timers.size, 0, 'invalid geometry cannot start a timeout that falsely marks the page ready');
  f.bounds.width = 800;
  f.resize();
  await f.flush();
  assert.equal(f.ready, 1);
});

test('older decode completion cannot release a resized page with a new pending cover', async (t) => {
  let resolveFirst;
  let resolveNext;
  const first = new Promise((done) => { resolveFirst = done; });
  const next = new Promise((done) => { resolveNext = done; });
  const f = fixture(t, (index) => index < 4 ? first : next);
  await f.flush();
  f.bounds.bottom = 500;
  f.bounds.height = 500;
  f.resize();
  await f.flush();
  resolveFirst();
  await f.flush();
  assert.equal(f.ready, 0);
  resolveNext();
  await f.flush();
  assert.equal(f.ready, 1);
});

test('dispose cancels frame, timeout, observer and in-flight readiness callback', async (t) => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const f = fixture(t, () => pending);
  await f.flush();
  f.resize();
  f.dispose();
  assert.equal(f.frames.size, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.disconnected, true);
  resolve();
  await f.flush();
  assert.equal(f.ready, 0);
});
