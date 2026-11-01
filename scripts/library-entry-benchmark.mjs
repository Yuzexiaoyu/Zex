// Compact browser benchmark of real library components. Only desktop IPC/artwork
// are fixtures; it does not build, deploy, copy the source tree, or save frame arrays.
// PLAYWRIGHT_MODULE may point to an installed Playwright index.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baselineFile = process.env.ZEX_LIBRARY_BASELINE;
const output = process.env.ZEX_LIBRARY_OUTPUT || 'library-entry-after';
assert.match(output, /^library-entry-[a-z0-9-]+$/);
const baseline = baselineFile ? JSON.parse((await readFile(baselineFile, 'utf8')).replace(/^\uFEFF/, '')) : null;
const paths = ['src/App.tsx', 'src/views/SeriesView.tsx', 'src/views/GameView.tsx', 'src/store/index.ts',
  'src/utils/preloadImages.ts', 'src/utils/media.ts', 'src/utils/usePresentedView.ts',
  'src/index.css', 'src/components/GameGrid.tsx', 'src/components/GameCard.tsx'];
if (!baseline) paths.push('src/utils/seriesImages.ts', 'src/utils/useSeriesImageWarmup.ts', 'src/components/SeriesImageWarmup.tsx');
const frozen = new Map(), hashes = {};
for (const path of paths) {
  const source = baseline?.[path] ?? await readFile(path, 'utf8');
  frozen.set(resolve(path).replaceAll('\\', '/'), source);
  hashes[path] = createHash('sha256').update(source).digest('hex');
}
hashes['scripts/library-entry-benchmark.mjs'] = createHash('sha256').update(await readFile('scripts/library-entry-benchmark.mjs')).digest('hex');
const production = process.env.NODE_ENV === 'production';
const cases = {
  compact: { width: 1280, height: 900, series: 6, delay: 35, dwell: 1000 },
  wide: { width: 1920, height: 900, series: 120, delay: 35, dwell: 1000 },
  early: { width: 1600, height: 900, series: 48, delay: 80, dwell: 0 },
  resize: { width: 1280, height: 900, resizeWidth: 1920, series: 120, delay: 35, dwell: 1000 },
};
const requested = (process.env.ZEX_LIBRARY_CASES || Object.keys(cases).join(',')).split(',');
const requests = [], report = { generatedAt: new Date().toISOString(), baseline: !!baseline,
  sourceHashes: hashes, environment: { node: process.version, production, browser: '', cacheEnabled: true, requestInterception: false },
  scope: 'Actual SeriesView/GameView, store, navigation hook, and CSS in a focused harness; synthetic PNGs and IPC. Games/series startup data calls mirror App; persistent music/stats/settings surfaces are omitted. Browser rAF/DOM metrics, not installed WebView2 perceived latency. HTTP/1 local server may queue image requests.',
  scenarios: [], complete: false };
function png() {
  const crc = (bytes) => { let n = 0xffffffff; for (const b of bytes) { n ^= b; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const size = Buffer.alloc(4), hash = Buffer.alloc(4); size.writeUInt32BE(data.length); hash.writeUInt32BE(crc(body)); return Buffer.concat([size, body, hash]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(96); header.writeUInt32BE(144, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(144 * 289);
  for (let y = 0; y < 144; y++) for (let x = 0; x < 96; x++) { const p = y * 289 + 1 + x * 3; pixels[p] = x * 2; pixels[p + 1] = y; pixels[p + 2] = 170; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const body = png();
const server = await createServer({ mode: production ? 'production' : 'development', appType: 'custom',
  plugins: [{ name: 'frozen-library-source', enforce: 'pre', load(id) { return frozen.get(id.replaceAll('\\', '/').split('?')[0]); } }],
  server: { port: 41794, strictPort: false, open: false, hmr: false } });
server.middlewares.use(async (req, res, next) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/__library-cover/')) {
    const [, , scenario, kind, file] = url.pathname.split('/');
    const record = { scenario, kind, file, at: Date.now(), ended: null };
    requests.push(record);
    await new Promise((done) => setTimeout(done, cases[scenario].delay));
    if (res.destroyed) return;
    res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(body); record.ended = Date.now(); return;
  }
  if (!url.pathname.startsWith('/__library-entry/')) return next();
  const html = await server.transformIndexHtml(url.pathname, `<html class="dark"><head><link rel="icon" href="data:,"></head><body style="margin:0"><div id="root"></div><script type="module">
    import React from 'react'; import ReactDOM from 'react-dom/client';
    import SeriesView from '/src/views/SeriesView.tsx'; import GameView from '/src/views/GameView.tsx';
    import { useAppStore } from '/src/store/index.ts';
    import { usePresentedView } from '/src/utils/usePresentedView.ts';
    ${baseline ? '' : "import SeriesImageWarmup from '/src/components/SeriesImageWarmup.tsx';"}
    import '/src/index.css';
    window.store = useAppStore;
    window.audit.runtime = { viteProd: import.meta.env.PROD, reactVersion: React.version, reactDevelopment: typeof React.act === 'function' };
    function Harness() {
      const viewportRef = React.useRef(null);
      const requested = useAppStore((s) => s.activeView), view = usePresentedView(requested);
      React.useEffect(() => { const s = useAppStore.getState(); void Promise.all([s.loadGames(), s.${baseline ? 'loadSeries' : 'ensureSeriesLoaded'}()]); }, []);
      return React.createElement(React.Fragment, null,
        React.createElement('nav', { style: { height: 65 } }, ['games','series'].map((view) => React.createElement('button', { id: 'nav-' + view, key: view, style: { padding: 12 }, onClick: () => {
          window.audit.phases[window.audit.phase].click = performance.now(); useAppStore.getState().setActiveView(view);
        } }, view))),
        React.createElement('main', { ref: viewportRef, 'data-view': view, style: { height: 'calc(100vh - 65px)' } },
          ${baseline ? '' : 'React.createElement(SeriesImageWarmup, { viewportRef }),'}
          view === 'games' ? React.createElement(GameView) : React.createElement(SeriesView)));
    }
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
  </script></body></html>`);
  res.setHeader('Content-Type', 'text/html'); res.end(html);
});
async function init(page, scenario) {
  await page.addInitScript(({ scenario, config }) => {
    const audit = window.audit = { phase: 'startup', phases: { startup: {} }, ipc: {}, animations: {}, resourceByPhase: {}, runtime: null };
    const source = (kind, id) => '/__library-cover/' + scenario + '/' + kind + '/' + id + '.png';
    const games = Array.from({ length: 112 }, (_, i) => ({ id: 'g-' + i, name: 'Game ' + i, cover_path: source('game', i), banner_path: '', bg_path: '', install_dir: '', exe_path: '', launch_args: '', env_vars: '', work_dir: '', notes: '', tags: '', favorite: false, hidden: false, total_seconds: 0, play_count: 0, created_at: '', updated_at: 'v1', steam_appid: 0, slot: i }));
    const series = Array.from({ length: config.series }, (_, i) => ({ id: 's-' + i, title: 'Series ' + i, aliases: '', overview: 'Fixture synopsis', poster_path: source('poster', i), bg_path: source('hero', i), first_air_date: '2026-01-01', status: '', tmdb_id: 0, tvdb_id: 0, tags: '', favorite: false, vote_average: 7, genres: '', sort_order: i, media_type: 'tv', total_seconds: 0, created_at: '2026-01-01', updated_at: 'v1', season_count: 1, episode_count: 12, watched_count: 0, local_count: 0, last_watched_at: '', next_episode: null }));
    let callback = 0;
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      convertFileSrc: (path) => new URL(path, location.origin).href, transformCallback: () => ++callback, unregisterCallback() {}, invoke: async (command) => {
        const key = audit.phase + ':' + command; audit.ipc[key] = (audit.ipc[key] || 0) + 1;
        if (command === 'get_all_games') { await new Promise((done) => setTimeout(done, 30)); return games; }
        if (command === 'get_series_library') { await new Promise((done) => setTimeout(done, 30)); return series; }
        if (command === 'get_game_folders') return [];
        if (command === 'plugin:event|listen') return ++callback;
        if (['plugin:event|unlisten', 'set_setting'].includes(command)) return;
        throw new Error('Unexpected IPC: ' + command);
      } };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    const opacity = (el) => { let a = 1; for (let n = el; n instanceof HTMLElement; n = n.parentElement) { const s = getComputedStyle(n); if (s.display === 'none' || s.visibility !== 'visible') return 0; a *= Number(s.opacity); } return a; };
    document.addEventListener('animationstart', (e) => {
      if (e.animationName !== 'card-enter') return;
      const p = audit.phases[audit.phase]; p.firstAnimation ??= performance.now();
    });
    new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.name.includes('/__library-cover/')) {
      const p = audit.resourceByPhase[audit.phase] ??= { count: 0, transferBytes: 0, durationMs: 0 };
      p.count++; p.transferBytes += e.transferSize; p.durationMs += e.duration;
    } }).observe({ type: 'resource', buffered: true });
    const sample = () => {
      const p = audit.phases[audit.phase], now = performance.now(); p.frames = (p.frames || 0) + 1;
      const view = document.querySelector('main')?.dataset.view;
      if ((audit.phase === 'series' && view !== 'series') || (audit.phase === 'return' && view !== 'games')) { requestAnimationFrame(sample); return; }
      const cards = [...document.querySelectorAll(view === 'series' ? '.poster-card' : '.game-card')];
      const viewport = cards.filter((card) => { const r = card.getBoundingClientRect(); return r.width > 0 && r.top < innerHeight && r.bottom > 65; });
      const shown = viewport.filter((card) => opacity(card) > 0.01);
      const blank = shown.filter((card) => { const img = card.querySelector('img'); return !img?.complete || img.naturalWidth < 1; });
      p.maxMounted = Math.max(p.maxMounted || 0, cards.length); p.maxViewport = Math.max(p.maxViewport || 0, viewport.length);
      if (shown.length) p.firstVisible ??= now;
      if (shown.length > blank.length) p.firstCompleteCard ??= now;
      if (blank.length) { p.blankFrames = (p.blankFrames || 0) + 1; p.maxBlank = Math.max(p.maxBlank || 0, blank.length); }
      if (viewport.length && shown.length === viewport.length && blank.length === 0) p.firstCompleteViewport ??= now;
      const hero = document.querySelector('.hero-bg');
      if (hero && opacity(hero) > 0.01 && hero.complete && hero.naturalWidth > 0) p.heroReady ??= now;
      if (!p.samples) p.samples = [];
      if (p.samples.length < 6 && p.click) p.samples.push({ ms: Math.round(now - p.click), mounted: cards.length, viewport: viewport.length, shown: shown.length, blank: blank.length });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, { scenario, config: cases[scenario] });
}
function summarize(phase) {
  const result = { ...phase };
  for (const key of ['firstAnimation', 'firstVisible', 'firstCompleteCard', 'firstCompleteViewport', 'heroReady']) {
    result[key + 'Ms'] = phase[key] && phase.click ? Math.round((phase[key] - phase.click) * 10) / 10 : null; delete result[key];
  }
  delete result.click; delete result.samples; return result;
}
const byKind = (list) => Object.fromEntries(['game', 'poster', 'hero'].map((kind) => [kind, list.filter((request) => request.kind === kind).length]));
let browser;
try {
  await server.listen(); browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  report.environment.browser = browser.version();
  for (const name of requested) {
    assert.ok(cases[name], 'unknown scenario'); const config = cases[name], errors = [];
    const page = await browser.newPage({ viewport: { width: config.width, height: config.height } });
    page.on('pageerror', (e) => errors.push(e.message)); await init(page, name);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__library-entry/${name}`);
    await page.waitForFunction(() => window.store?.getState().series.length > 0 && window.store.getState().games.length > 0);
    if (config.dwell) await page.waitForTimeout(config.dwell);
    if (config.resizeWidth) { await page.setViewportSize({ width: config.resizeWidth, height: config.height }); await page.waitForTimeout(600); }
    const before = requests.filter((r) => r.scenario === name).length;
    await page.evaluate(() => { window.audit.phase = 'series'; window.audit.phases.series = {}; document.getElementById('nav-series').click(); });
    await page.waitForFunction(() => !!window.audit.phases.series.firstCompleteViewport);
    await page.waitForTimeout(450);
    const visibleSources = await page.evaluate(() => [...document.querySelectorAll('.poster-card img, .hero-bg')].filter((img) => {
      const r = img.getBoundingClientRect(); return r.width > 0 && r.top < innerHeight && r.bottom > 65;
    }).map((img) => new URL(img.src).pathname));
    const after = requests.filter((r) => r.scenario === name).length;
    assert.equal(await page.locator('.game-card').count(), 0, 'game library must not remain mounted');
    await page.evaluate(() => { window.audit.phase = 'return'; window.audit.phases.return = {}; document.getElementById('nav-games').click(); });
    await page.waitForFunction(() => !!window.audit.phases.return.firstCompleteViewport);
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.poster-card').count(), 0, 'series library must not remain mounted');
    const audit = await page.evaluate(() => window.audit);
    assert.equal(audit.runtime.viteProd, production); assert.equal(audit.runtime.reactDevelopment, !production);
    assert.deepEqual(errors, []);
    const ownRequests = requests.filter((r) => r.scenario === name);
    const scenario = { name, config, beforeNavigationRequests: before, afterSeriesNavigationNewRequests: after - before,
      firstViewportNewRequests: ownRequests.slice(before, after).filter((request) => visibleSources.includes('/__library-cover/' + name + '/' + request.kind + '/' + request.file)).length,
      requestKinds: { background: byKind(ownRequests.slice(0, before)), series: byKind(ownRequests.slice(before, after)), gameReturn: byKind(ownRequests.slice(after)) },
      gameReturnNewRequests: ownRequests.length - after,
      series: summarize(audit.phases.series), gameReturn: summarize(audit.phases.return), ipc: audit.ipc, resources: audit.resourceByPhase, runtime: audit.runtime, errors };
    report.scenarios.push(scenario); console.log(JSON.stringify(scenario)); await page.close();
  }
  if (!baseline) for (const path of paths) assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), hashes[path], 'source changed during benchmark: ' + path);
  report.complete = true;
} finally {
  await browser?.close(); await server.close(); await mkdir(resolve('docs/verification'), { recursive: true });
  await writeFile(resolve('docs/verification', output + '.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ complete: report.complete, scenarios: report.scenarios.length, output: 'docs/verification/' + output + '.json' }));
}
