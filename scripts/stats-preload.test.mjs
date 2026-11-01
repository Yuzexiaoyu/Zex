import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preloadStatsImages } from '../src/utils/statsPreload.ts';

function fixture(t, decode = () => Promise.resolve()) {
  const frames = new Map();
  const timers = new Map();
  const events = [];
  let nextId = 0;
  let resize;
  let mutate;
  let disconnected = false;
  let mutationDisconnected = false;
  const listeners = new Map();
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
    MutationObserver: class {
      constructor(callback) { mutate = callback; }
      observe() {}
      disconnect() { mutationDisconnected = true; }
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
    dataset: {},
    getAttribute(name) { return name === 'src' ? this.src : null; },
    set loading(value) { events.push(`write:${index}:${value}`); },
    set fetchPriority(value) { events.push(`priority:${index}:${value}`); },
    decode() { events.push(`decode:${index}`); return decode(index); },
  }));
  const bounds = { top: 0, bottom: 300, width: 800, height: 300 };
  const page = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name) => listeners.delete(name),
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
    events, images, bounds, frames, timers, dispose, listeners,
    resize: () => resize(),
    mutate: (index) => mutate([{ type: 'attributes', target: images[index] }]),
    mutations: (changes) => mutate(changes),
    added: () => mutate([{ type: 'childList', target: page }]),
    emit: (name, index) => listeners.get(name)?.({ type: name, target: images[index] }),
    get ready() { return ready; },
    get result() { return result; },
    get disconnected() { return disconnected; },
    get mutationDisconnected() { return mutationDisconnected; },
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

test('hung image releases page at timeout; late decode clears temporary placeholders', async (t) => {
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
  assert.ok(f.ready > 1, 'late success must notify presentation state');
  assert.deepEqual(f.result, { unavailableSources: [], timedOut: true });
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
  assert.deepEqual(f.result.unavailableSources, []);
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
  assert.equal(f.mutationDisconnected, true);
  assert.equal(f.listeners.size, 0);
  resolve();
  await f.flush();
  assert.equal(f.ready, 0);
});

test('asynchronous blob sources wait and report the logical URL after timeout', async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 4; index++) {
    f.images[index].dataset.coverSource = `logical-${index}`;
    f.images[index].src = '';
  }
  await f.flush();
  assert.equal(f.ready, 0);
  assert.equal(f.events.filter((event) => event.startsWith('decode:')).length, 0, 'empty sources are never decoded');
  [...f.timers.values()][0].callback();
  assert.deepEqual(f.result.unavailableSources, ['logical-0', 'logical-1', 'logical-2', 'logical-3']);
  for (let index = 0; index < 4; index++) {
    f.images[index].src = `blob:cover-${index}`;
    f.mutate(index);
  }
  await f.flush();
  assert.deepEqual(f.result.unavailableSources, []);
});

test('negative cache errors without an img src finish with logical placeholders', async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 4; index++) {
    f.images[index].dataset = { coverSource: `logical-${index}`, coverStatus: 'error' };
    f.images[index].src = '';
  }
  await f.flush();
  assert.deepEqual(f.result, { unavailableSources: ['logical-0', 'logical-1', 'logical-2', 'logical-3'], timedOut: false });
  assert.equal(f.timers.size, 0);
});

test('source mutation rejects stale completion and decodes the replacement blob', async (t) => {
  let finishOld;
  const old = new Promise((resolve) => { finishOld = resolve; });
  let calls = 0;
  const f = fixture(t, (index) => index === 0 && calls++ === 0 ? old : Promise.resolve());
  await f.flush();
  f.images[0].src = 'blob:new';
  f.images[0].dataset.coverSource = 'logical-new';
  finishOld();
  await f.flush();
  await f.flush();
  assert.equal(f.ready, 1);
  assert.deepEqual(f.result.unavailableSources, []);
  assert.equal(f.events.filter((event) => event === 'decode:0').length, 2);
});

test('scroll mounts after readiness do not rescan or decode unrelated images', async (t) => {
  const f = fixture(t);
  await f.flush();
  f.events.length = 0;
  f.added();
  f.mutate(7);
  await f.flush();
  assert.deepEqual(f.events, []);
});

test('load event recovers an earlier decode error on the same source', async (t) => {
  let failed = true;
  const f = fixture(t, (index) => index === 0 && failed ? Promise.reject(new Error('transient')) : Promise.resolve());
  await f.flush();
  assert.deepEqual(f.result.unavailableSources, ['cover-0']);
  failed = false;
  f.emit('load', 0);
  await f.flush();
  assert.deepEqual(f.result.unavailableSources, []);
});

test('another decode completing cannot mark a silently replaced source as ready', async (t) => {
  let finishLast;
  const last = new Promise((resolve) => { finishLast = resolve; });
  const f = fixture(t, (index) => index === 3 ? last : Promise.resolve());
  await f.flush();
  f.images[0].src = 'new-source-before-observer';
  finishLast();
  await f.flush();
  assert.equal(f.ready, 0, 'readiness must compare current sources even before mutation delivery');
  f.mutate(0);
  await f.flush();
  assert.equal(f.ready, 1);
});

for (const mixed of [false, true]) {
  test(`pending DOM remeasurement blocks old decode readiness (mixed mutations: ${mixed})`, async (t) => {
    let finishOld;
    let finishNew;
    const old = new Promise((resolve) => { finishOld = resolve; });
    const next = new Promise((resolve) => { finishNew = resolve; });
    const f = fixture(t, () => old);
    await f.flush();
    const oldImage = f.images[0];
    f.images[0] = { ...oldImage, src: 'new-row-cover', decode: () => next };
    f.mutations([
      ...(mixed ? [{ type: 'attributes', target: oldImage }] : []),
      { type: 'childList', target: {} },
    ]);
    finishOld();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(f.ready, 0, 'queued measurement must complete before publishing readiness');
    await f.flush();
    assert.equal(f.ready, 0, 'newly mounted row must be included even in a mixed mutation batch');
    finishNew();
    await f.flush();
    assert.deepEqual(f.result, { unavailableSources: [], timedOut: false });
  });
}

test('layout becoming invalid during preparation pauses timeout and readiness', async (t) => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const f = fixture(t, () => pending);
  await f.flush();
  f.bounds.height = 0;
  f.resize();
  await f.flush();
  assert.equal(f.timers.size, 0);
  finish();
  await f.flush();
  assert.equal(f.ready, 0);
  f.bounds.height = 300;
  f.resize();
  await f.flush();
  assert.equal(f.ready, 1);
});
