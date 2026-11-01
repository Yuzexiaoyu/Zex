// Test real Zustand state and production store actions; only desktop IPC is mocked.
// Transpilation resolves the store's bundler-style imports without running a browser.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';
import * as lyrics from '../src/utils/lyrics.ts';

const require = createRequire(import.meta.url);
const source = await readFile(new URL('../src/store/index.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const evaluate = new Function('require', 'exports', outputText);
function fixture(overrides = {}) {
  const api = { getSetting: async () => null, setSetting: async () => {}, ...overrides };
  const exports = {};
  evaluate((name) => name === '../api' ? api : name === '../utils/lyrics' ? lyrics : require(name), exports);
  return { store: exports.useAppStore, api };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function prepare(store) {
  const state = store.getState();
  state.prepareMusicPresentation(state.tracks, state.playlists, state.musicLayout);
}

for (const [data, load, request] of [
  ['tracks', 'loadTracks', 'getAllTracks'],
  ['playlists', 'loadPlaylists', 'getPlaylists'],
]) {
  const status = `${data}Status`, errorKey = `${data}Error`;

  test(`${data}: startup and reentrant requests share one IPC and preserve statistics`, async () => {
    const pending = deferred();
    let calls = 0, reentrant;
    const { store } = fixture({ [request]: () => { calls++; return pending.promise; } });
    const statsPresentation = { stats: null, libraries: [], unavailableCovers: new Set() };
    const previous = [{ id: 'previous' }];
    store.setState({ [data]: previous, tracksStatus: 'ready', playlistsStatus: 'ready', statsPresentation });
    prepare(store);
    const prepared = store.getState().musicPresentation;
    const unsubscribe = store.subscribe((state, old) => {
      if (state[status] === 'loading' && old[status] !== 'loading') reentrant = state[load]();
    });
    const first = store.getState()[load]();
    assert.equal(reentrant, first, 'loading subscriber cannot trigger a second request');
    assert.equal(store.getState()[load](), first, 'startup and page mount share their completion');
    assert.equal(store.getState()[status], 'loading');
    assert.equal(store.getState()[data], previous, 'background refresh preserves existing rows');
    assert.equal(store.getState().musicPresentation, prepared);
    await Promise.resolve();
    assert.equal(calls, 1);
    const next = [{ id: 'next' }];
    pending.resolve(next);
    await first;
    assert.equal(store.getState()[data], next);
    assert.equal(store.getState()[status], 'ready');
    assert.equal(store.getState()[errorKey], null);
    assert.equal(store.getState().musicPresentation, null, 'new data must be prepared before entry');
    assert.equal(store.getState().statsPresentation, statsPresentation);
    unsubscribe();
  });

  test(`${data}: failed refresh keeps rows, rejects its original error and permits retry`, async () => {
    const failed = deferred();
    const { store, api } = fixture({ [request]: () => failed.promise });
    const previous = [{ id: 'previous' }];
    store.setState({ [data]: previous, tracksStatus: 'ready', playlistsStatus: 'ready' });
    const first = store.getState()[load]();
    const reason = new Error('fixture IPC failure');
    const rejection = assert.rejects(first, (error) => error === reason);
    failed.reject(reason);
    await rejection;
    assert.equal(store.getState()[data], previous);
    assert.equal(store.getState()[status], 'error');
    assert.equal(store.getState()[errorKey], reason.message);
    prepare(store);
    assert.ok(store.getState().musicPresentation, 'failed refresh cannot trap navigation forever');
    const next = [{ id: 'recovered' }];
    api[request] = async () => next;
    const retry = store.getState()[load]();
    assert.notEqual(retry, first);
    assert.equal(store.getState()[status], 'loading');
    assert.equal(store.getState()[errorKey], null);
    await retry;
    assert.equal(store.getState()[status], 'ready');
    assert.equal(store.getState()[data], next);
    assert.equal(store.getState().musicPresentation, null);
  });

  test(`${data}: synchronous IPC exceptions release in-flight request state`, async () => {
    const { store, api } = fixture({ [request]: () => { throw 'fixture sync failure'; } });
    await assert.rejects(store.getState()[load](), (error) => error === 'fixture sync failure');
    assert.equal(store.getState()[status], 'error');
    assert.equal(store.getState()[errorKey], 'fixture sync failure');
    api[request] = async () => [];
    await store.getState()[load]();
    assert.equal(store.getState()[status], 'ready');
  });
}

test('cold empty library waits for both requests, then allows a recoverable failure', async () => {
  const tracks = deferred(), playlists = deferred();
  const { store } = fixture({ getAllTracks: () => tracks.promise, getPlaylists: () => playlists.promise });
  prepare(store);
  assert.equal(store.getState().musicPresentation, null, 'idle arrays are not a loaded empty library');
  const trackLoad = store.getState().loadTracks(), playlistLoad = store.getState().loadPlaylists();
  const rejection = assert.rejects(playlistLoad, /fixture playlist failure/);
  tracks.resolve([]);
  await trackLoad;
  prepare(store);
  assert.equal(store.getState().musicPresentation, null, 'track completion alone cannot release entry');
  playlists.reject(new Error('fixture playlist failure'));
  await rejection;
  prepare(store);
  assert.ok(store.getState().musicPresentation, 'error UI must remain reachable with an empty library');
});

test('late cover readiness for old arrays or layout cannot release the current library', () => {
  const { store } = fixture();
  store.setState({ tracks: [{ id: 'old-track' }], playlists: [{ id: 'old-playlist' }], tracksStatus: 'ready', playlistsStatus: 'ready' });
  const old = store.getState();
  store.setState({ tracks: [{ id: 'new-track' }] });
  old.prepareMusicPresentation(old.tracks, old.playlists, old.musicLayout);
  assert.equal(store.getState().musicPresentation, null);
  const next = store.getState();
  store.setState({ playlists: [{ id: 'new-playlist' }] });
  old.prepareMusicPresentation(next.tracks, next.playlists, next.musicLayout);
  assert.equal(store.getState().musicPresentation, null);
  const newest = store.getState();
  newest.setMusicLayout('multi');
  newest.prepareMusicPresentation(newest.tracks, newest.playlists, newest.musicLayout);
  assert.equal(store.getState().musicPresentation, null);
  prepare(store);
  assert.equal(store.getState().musicPresentation?.layout, 'multi');
});

test('repeat readiness and invalidation do not create render notification loops', () => {
  const { store } = fixture();
  store.setState({ tracksStatus: 'ready', playlistsStatus: 'ready' });
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications++; });
  store.getState().invalidateMusicPresentation();
  assert.equal(notifications, 0);
  prepare(store);
  assert.equal(notifications, 1);
  prepare(store);
  store.getState().setMusicLayout('single');
  assert.equal(notifications, 1, 'unchanged layout and repeated decode callback are inert');
  store.getState().invalidateMusicPresentation();
  store.getState().invalidateMusicPresentation();
  assert.equal(notifications, 2);
  unsubscribe();
});

test('persisted layout changes invalidate music readiness without touching statistics', async () => {
  const { store, api } = fixture({ getSetting: async (key) => key === 'music_layout' ? 'multi' : null });
  const statsPresentation = { stats: null, libraries: [], unavailableCovers: new Set() };
  store.setState({ tracksStatus: 'ready', playlistsStatus: 'ready', statsPresentation });
  prepare(store);
  await store.getState().loadPreferences();
  assert.equal(store.getState().musicLayout, 'multi');
  assert.equal(store.getState().musicPresentation, null);
  assert.equal(store.getState().statsPresentation, statsPresentation);
  prepare(store);
  const prepared = store.getState().musicPresentation;
  await store.getState().loadPreferences();
  assert.equal(store.getState().musicPresentation, prepared, 're-reading the same preference preserves preparation');
  api.getSetting = async (key) => key === 'music_layout' ? 'unsupported' : null;
  await store.getState().loadPreferences();
  assert.equal(store.getState().musicPresentation, prepared, 'invalid preference keeps current layout');
});
