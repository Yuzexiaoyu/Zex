// Real Zustand store actions; only desktop IPC is a controllable fixture.
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
function fixture() {
  const requests = [];
  const api = {
    getSeriesLibrary: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
  };
  const exports = {};
  evaluate((name) => name === '../api' ? api : name === '../utils/lyrics' ? lyrics : require(name), exports);
  const store = exports.useAppStore;
  const publications = [];
  store.subscribe((state, old) => { if (state.series !== old.series) publications.push(state.series); });
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return {
    store, api, requests, publications, flush,
    ensure: () => store.getState().ensureSeriesLoaded(),
    load: () => store.getState().loadSeries(),
    async finish(index, series) { assert.ok(requests[index]); requests[index].resolve(series); await flush(); },
    async fail(index, error) { assert.ok(requests[index]); requests[index].reject(error); await flush(); },
  };
}
const version = (value) => [{ id: 'series', updated_at: value }];

test('startup and repeated ensure calls share one query, including an empty-library result', async () => {
  const f = fixture();
  const first = f.ensure();
  assert.equal(f.ensure(), first);
  assert.equal(f.ensure(), first);
  await f.flush();
  assert.equal(f.requests.length, 1);
  const empty = [];
  await f.finish(0, empty);
  assert.equal(await first, undefined);
  assert.equal(f.store.getState().series, empty);
  assert.equal(f.store.getState().seriesLoaded, true);
  await f.ensure();
  assert.equal(f.requests.length, 1, 'a loaded empty library must not query on every entry');
});

test('ensure joins an explicit initial load without requesting a follow-up query', async () => {
  const f = fixture();
  const first = f.load();
  assert.equal(f.ensure(), first);
  await f.flush();
  await f.finish(0, version('v1'));
  await first;
  assert.equal(f.requests.length, 1);
});

test('refresh during a pending query skips the old snapshot and waits for the new version', async () => {
  const f = fixture();
  const old = version('existing');
  f.store.setState({ series: old, seriesLoaded: true });
  f.publications.length = 0;
  const before = f.store.getState();
  const first = f.load();
  let finished = false;
  void first.then(() => { finished = true; });
  await f.flush();
  const refresh = f.load();
  assert.equal(refresh, first);
  await f.finish(0, version('v1'));
  assert.equal(f.requests.length, 2);
  assert.equal(finished, false, 'the shared promise includes the requested follow-up');
  assert.equal(f.store.getState().series, old);
  assert.deepEqual(f.publications, [], 'known-stale data never reaches subscribers');
  const latest = version('v2');
  await f.finish(1, latest);
  await Promise.all([first, refresh]);
  assert.deepEqual(f.publications, [latest]);
  const after = f.store.getState();
  for (const key of Object.keys(before)) {
    if (key !== 'series' && key !== 'seriesLoaded') assert.equal(after[key], before[key], `unrelated state ${key} remains unchanged`);
  }
});

test('multiple refresh requests during one query merge into a single follow-up', async () => {
  const f = fixture();
  const shared = f.load();
  // Calls before the first IPC starts still represent explicit refresh requests.
  for (let i = 0; i < 5; i++) assert.equal(f.load(), shared);
  await f.flush();
  assert.equal(f.requests.length, 1);
  await f.finish(0, version('v1'));
  assert.equal(f.requests.length, 2);
  await f.finish(1, version('v2'));
  await shared;
  await f.flush();
  assert.equal(f.requests.length, 2, 'no polling or unconditional drain loop');
  assert.equal(f.store.getState().series[0].updated_at, 'v2');
});

test('a new refresh during the follow-up triggers one further query before completion', async () => {
  const f = fixture();
  const shared = f.load();
  await f.flush();
  f.load();
  await f.finish(0, version('v1'));
  assert.equal(f.requests.length, 2);
  assert.equal(f.load(), shared);
  assert.equal(f.load(), shared);
  await f.finish(1, version('v2'));
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.publications, []);
  const latest = version('v3');
  await f.finish(2, latest);
  await shared;
  assert.deepEqual(f.publications, [latest]);
});

test('a failed initial query releases the request and permits an ensure retry', async () => {
  const f = fixture();
  const first = f.ensure();
  const error = new Error('first IPC failed');
  const rejected = assert.rejects(first, (actual) => actual === error);
  await f.flush();
  await f.fail(0, error);
  await rejected;
  assert.equal(f.store.getState().seriesLoaded, false);
  const retry = f.ensure();
  assert.notEqual(retry, first);
  await f.flush();
  const latest = version('recovered');
  await f.finish(1, latest);
  await retry;
  assert.equal(f.store.getState().series, latest);
});

test('a queued refresh after failure can recover and resolve every joined caller', async () => {
  const f = fixture();
  const first = f.ensure();
  await f.flush();
  const refresh = f.load();
  await f.fail(0, new Error('superseded failure'));
  assert.equal(f.requests.length, 2);
  assert.equal(f.ensure(), first, 'ensure during recovery adds no extra query');
  const latest = version('recovered');
  await f.finish(1, latest);
  await Promise.all([first, refresh]);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.publications, [latest]);
});

test('the final requested query decides rejection, preserves cached data, and permits retry', async () => {
  const f = fixture();
  const cached = version('cached');
  f.store.setState({ series: cached, seriesLoaded: true });
  f.publications.length = 0;
  const shared = f.load();
  const finalError = new Error('final IPC failed');
  const rejected = assert.rejects(shared, (actual) => actual === finalError);
  await f.flush();
  f.load();
  await f.fail(0, new Error('superseded failure'));
  await f.fail(1, finalError);
  await rejected;
  assert.equal(f.store.getState().series, cached);
  assert.equal(f.store.getState().seriesLoaded, true);
  assert.deepEqual(f.publications, []);
  const retry = f.load();
  await f.flush();
  await f.finish(2, version('retry'));
  await retry;
  assert.equal(f.requests.length, 3);
});

test('cached ensure does no work while an explicit refresh is in progress', async () => {
  const f = fixture();
  f.store.setState({ seriesLoaded: true, series: version('cached') });
  const refresh = f.load();
  assert.equal(await f.ensure(), undefined);
  assert.equal(f.requests.length, 1);
  await f.finish(0, version('updated'));
  await refresh;
  assert.equal(f.requests.length, 1);
});

test('a synchronous IPC exception clears the request for retry', async () => {
  const f = fixture();
  const original = f.api.getSeriesLibrary;
  const error = new Error('sync IPC error');
  f.api.getSeriesLibrary = () => { throw error; };
  await assert.rejects(f.ensure(), (actual) => actual === error);
  f.api.getSeriesLibrary = original;
  const retry = f.ensure();
  await f.flush();
  await f.finish(0, version('recovered'));
  await retry;
  assert.equal(f.store.getState().seriesLoaded, true);
});

test('a refresh requested by a publication subscriber belongs to the same completion', async () => {
  const f = fixture();
  let reentrant;
  const stop = f.store.subscribe((state) => {
    if (state.series[0]?.updated_at === 'v1' && !reentrant) reentrant = state.loadSeries();
  });
  const shared = f.load();
  await f.flush();
  await f.finish(0, version('v1'));
  assert.equal(reentrant, shared);
  assert.equal(f.requests.length, 2);
  await f.finish(1, version('v2'));
  await shared;
  stop();
  assert.equal(f.store.getState().series[0].updated_at, 'v2');
});
