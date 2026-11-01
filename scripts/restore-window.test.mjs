import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finishEntranceAnimations, restoreWindowAfterPaint } from '../src/utils/restoreWindow.ts';

function fixture(t) {
  const frames = [];
  const events = [];
  const animations = [];
  const originals = new Map();
  for (const [key, value] of Object.entries({
    document: { getAnimations: () => animations },
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return {
    events, animations,
    frame() { frames.splice(0).forEach((callback) => callback()); },
    restore() { events.push('restore'); },
    async show() { events.push('show'); },
  };
}

test('window shows after two paint opportunities and finishes only finite entrance motion', async (t) => {
  const f = fixture(t);
  for (const [name, iterations] of [['stats-enter', 1], ['card-enter', 1], ['fade-in', 1], ['spin', Infinity], ['card-enter', Infinity], ['unrelated', 1]]) {
    f.animations.push({ animationName: name, effect: { getComputedTiming: () => ({ iterations }) }, finish: () => f.events.push(name) });
  }
  const restored = restoreWindowAfterPaint(f.restore, f.show, () => true);
  assert.deepEqual(f.events, ['restore']);
  f.frame();
  assert.deepEqual(f.events, ['restore', 'stats-enter', 'card-enter', 'fade-in'], 'finish motion before the paint that precedes native show');
  f.frame();
  await restored;
  assert.deepEqual(f.events, ['restore', 'stats-enter', 'card-enter', 'fade-in', 'show']);
});

test('duplicate restore events coalesce to the latest show request', async (t) => {
  const f = fixture(t);
  const first = restoreWindowAfterPaint(f.restore, f.show, () => true);
  const second = restoreWindowAfterPaint(f.restore, f.show, () => true);
  f.frame(); f.frame();
  await Promise.all([first, second]);
  assert.deepEqual(f.events, ['restore', 'restore', 'show']);
});

test('a hide before presentation cancels the queued native show', async (t) => {
  const f = fixture(t);
  let visible = true;
  const pending = restoreWindowAfterPaint(f.restore, f.show, () => visible);
  f.frame();
  visible = false;
  f.frame();
  await pending;
  assert.deepEqual(f.events, ['restore']);
});

test('cancelled animations do not prevent remaining entrances from finishing', (t) => {
  const f = fixture(t);
  f.animations.push({ animationName: 'stats-enter', finish() { throw new Error('cancelled'); } });
  f.animations.push({ animationName: 'card-enter', finish() { f.events.push('finished'); } });
  finishEntranceAnimations();
  assert.deepEqual(f.events, ['finished']);
});

test('native show rejection and synchronous throw both propagate to the caller', async (t) => {
  const f = fixture(t);
  for (const show of [() => Promise.reject(new Error('native failure')), () => { throw new Error('native failure'); }]) {
    const pending = restoreWindowAfterPaint(f.restore, show, () => true);
    const rejection = assert.rejects(pending, /native failure/);
    f.frame(); f.frame();
    await rejection;
  }
});
