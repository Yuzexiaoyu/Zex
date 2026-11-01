// Integration benchmark: actual music/statistics surfaces, store, navigation hook,
// production CSS and cover cache. Only desktop IPC and artwork are fixtures.
// Frozen baseline survives concurrent implementation work; current-source runs
// fail if any relevant production module changes before their completion.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseline = process.env.ZEX_MUSIC_PRERENDER_BASELINE === '1';
const productionRuntime = process.env.NODE_ENV === 'production';
const output = process.env.ZEX_MUSIC_PRERENDER_OUTPUT || (baseline ? 'music-prerender-before' : 'music-prerender-after');
assert.match(output, /^music-prerender-[a-z0-9-]+$/);
const outputDir = resolve('docs/verification');
const sourcePaths = [
  'src/App.tsx', 'src/views/MusicView.tsx', 'src/components/CoverImg.tsx',
  'src/components/StatsSurface.tsx', 'src/utils/cover-cache.ts', 'src/utils/gridImages.ts',
  'src/utils/usePresentedView.ts', 'src/index.css', 'src/store/index.ts',
  'src/gamepad/focus.ts', 'src/gamepad/scrollTarget.ts', 'src/views/StatsView.tsx',
  'src/utils/statsPreload.ts', 'src/utils/statsImages.ts', 'src/components/StatsCovers.tsx',
];
if (!baseline) sourcePaths.push('src/components/MusicSurface.tsx', 'src/components/SortMenu.tsx');
const frozen = new Map();
const hashes = {};
for (const path of sourcePaths) {
  const source = await readFile(baseline ? resolve(outputDir, 'music-prerender-baseline-source', path) : path, 'utf8');
  hashes[path] = createHash('sha256').update(source).digest('hex');
  if (baseline) frozen.set(resolve(path).replaceAll('\\', '/'), source);
}
hashes['scripts/music-prerender.test.mjs'] = createHash('sha256').update(await readFile('scripts/music-prerender.test.mjs')).digest('hex');
const modes = {
  single: { layout: 'single', width: 1280, height: 900, delay: 35, decodeDelay: 0 },
  multi: { layout: 'multi', width: 1920, height: 900, delay: 35, decodeDelay: 0 },
  decode: { layout: 'multi', width: 1920, height: 900, delay: 20, decodeDelay: 70 },
  cancel: { layout: 'multi', width: 1920, height: 900, delay: 1600, decodeDelay: 0 },
  resize: { layout: 'multi', width: 1280, height: 900, delay: 35, decodeDelay: 0 },
  empty: { layout: 'multi', width: 1920, height: 900, delay: 35, decodeDelay: 0 },
  refresh: { layout: 'multi', width: 1920, height: 900, delay: 20, decodeDelay: 70 },
};
const requested = (process.env.ZEX_MUSIC_PRERENDER_MODES || (baseline ? 'single,multi' : Object.keys(modes).join(','))).split(',');
const report = { generatedAt: new Date().toISOString(), baseline, sourceHashes: hashes,
  environment: { node: process.version, nodeEnv: process.env.NODE_ENV || null, productionRuntimeRequested: productionRuntime, browser: '', requestInterception: false, httpCacheDisabled: false },
  scope: 'Real React MusicView/MusicSurface, StatsSurface, usePresentedView, store and cover cache in a navigation harness matching App startup data preload. Tauri IPC and HTTP PNG content are fixtures. Browser-only; not installed WebView2. DOM dimensions and rAF frames measure presentation, not perceived native display latency.',
  scenarios: [], complete: false };
const requests = [];
const lines = [];
const log = (value) => { const line = JSON.stringify(value); lines.push(line); console.log(line); };
function png() {
  const crc = (bytes) => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const size = Buffer.alloc(4); size.writeUInt32BE(data.length); const hash = Buffer.alloc(4); hash.writeUInt32BE(crc(body)); return Buffer.concat([size, body, hash]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(96, 0); header.writeUInt32BE(96, 4); header[8] = 8; header[9] = 2;
  const data = Buffer.alloc(96 * (1 + 96 * 3));
  for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) { const n = y * 289 + 1 + x * 3; data[n] = x * 2; data[n + 1] = y * 2; data[n + 2] = 180; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(data)), chunk('IEND', Buffer.alloc(0))]);
}
const body = png();
const server = await createServer({ mode: productionRuntime ? 'production' : 'development', appType: 'custom', plugins: [{ name: 'frozen-music-prerender-baseline', enforce: 'pre', load(id) { return frozen.get(id.replaceAll('\\', '/').split('?')[0]); } }], server: { port: 41792, strictPort: false, open: false, hmr: false } });
report.environment.viteIsProduction = server.config.isProduction;
server.middlewares.use(async (req, res, next) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/__prerender-cover/')) {
    const [, , mode, kind, file] = url.pathname.split('/');
    const id = Number(file.replace('.png', ''));
    const record = { mode, kind, id, requestedAt: Date.now(), url: req.url, completedAt: null, aborted: false };
    requests.push(record); res.on('close', () => { if (!res.writableFinished) record.aborted = true; });
    await new Promise((done) => setTimeout(done, kind === 'music' && (mode !== 'cancel' || id === 0) ? modes[mode].delay : 20));
    if (res.destroyed) return;
    res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(body); record.completedAt = Date.now(); return;
  }
  if (!url.pathname.startsWith('/__music-prerender/')) return next();
  const mode = url.pathname.split('/').at(-1);
  const html = await server.transformIndexHtml(url.pathname, `<html class="dark"><head><link rel="icon" href="data:,"></head><body style="margin:0"><div id="root"></div><script type="module">
    import React from 'react'; import ReactDOM from 'react-dom/client';
    import ${baseline ? 'MusicView' : 'MusicSurface'} from '/src/${baseline ? 'views/MusicView' : 'components/MusicSurface'}.tsx';
    import StatsSurface from '/src/components/StatsSurface.tsx';
    import { usePresentedView } from '/src/utils/usePresentedView.ts';
    import { useAppStore } from '/src/store/index.ts';
    import { coverCache } from '/src/utils/cover-cache.ts';
    import { useFocusStore } from '/src/gamepad/index.ts';
    import { getScrollTarget, useRightStickScrollIf } from '/src/gamepad/scrollTarget.ts';
    import '/src/index.css';
    window.store = useAppStore; window.cache = coverCache; window.focusStore = useFocusStore; window.getScrollTarget = getScrollTarget;
    window.audit.runtime = { reactVersion: React.version, reactHasDevelopmentAct: typeof React.act === 'function', viteProd: import.meta.env.PROD, initialTrackCount: useAppStore.getState().tracks.length };
    window.groups = new Map();
    const focus = useFocusStore.getState(), register = focus.register, unregister = focus.unregister;
    useFocusStore.setState({ register: (id, opts) => { window.groups.set(id, opts); register(id, opts); }, unregister: (id) => { window.groups.delete(id); unregister(id); } });
    const acquire = coverCache.request; let leaseId = 0;
    coverCache.request = (...args) => {
      const request = acquire(...args), id = ++leaseId; window.audit.leases.push({ id, source: args[0], start: performance.now(), released: null });
      const release = request.release; request.release = () => { const lease = window.audit.leases.find((item) => item.id === id); if (lease.released === null) lease.released = performance.now(); release(); }; return request;
    };
    useAppStore.setState({ musicLayout: '${modes[mode].layout}', activeView: 'games' });
    function Previous({ view }) {
      const ref = React.useRef(null); useRightStickScrollIf(ref, true);
      return React.createElement('div', { ref, 'data-previous-view': view, style: { height: '100%', background: '#203048', padding: 20 } }, view, React.createElement('button', { id: 'previous-focus' }, 'Previous focus'));
    }
    function Harness() {
      const [mounted, setMounted] = React.useState(true); window.mountHarness = setMounted;
      const requested = useAppStore((s) => s.activeView), presented = usePresentedView(requested);
      React.useEffect(() => { const s = useAppStore.getState(); void Promise.all([s.loadTracks(), s.loadPlaylists(), s.loadStats()]); }, []);
      return React.createElement(React.Fragment, null,
        React.createElement('nav', { style: { height: 50 } }, ['games','music','stats','settings'].map((view) => React.createElement('button', { id: 'nav-' + view, key: view, style: { padding: 12 }, onClick: () => { window.audit.clicks.push({ view, at: performance.now(), phase: window.audit.phase }); useAppStore.getState().setActiveView(view); } }, view))),
        mounted && React.createElement('main', { style: { position: 'relative', height: 'calc(100vh - 50px)' } },
          React.createElement('div', { className: 'h-full', 'data-presented-view': presented, inert: requested !== presented },
            !['music','stats'].includes(presented) && React.createElement(Previous, { key: presented, view: presented }),
            ${baseline ? "presented === 'music' && React.createElement(MusicView)" : "React.createElement(MusicSurface, { active: presented === 'music' })"},
            React.createElement(StatsSurface, { active: presented === 'stats' }))));
    }
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(Harness)));
  </script></body></html>`);
  res.setHeader('Content-Type', 'text/html'); res.end(html);
});

async function initialize(page, mode) {
  await page.addInitScript(({ mode, config }) => {
    const audit = window.audit = { frames: [], phase: 'background', clicks: [], animationStarts: [], ipc: [], leases: [], decodes: [], decoded: new Set(), fetches: [], keys: [] };
    const originalDecode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function (...args) {
      const item = { src: this.src, at: performance.now(), done: null, error: null }; audit.decodes.push(item);
      return originalDecode.apply(this, args).then(async () => { if (config.decodeDelay) await new Promise((done) => setTimeout(done, config.decodeDelay)); item.done = performance.now(); audit.decoded.add(item.src); }, (error) => { item.error = String(error); throw error; });
    };
    const fetch = window.fetch;
    window.fetch = function (...args) { if (String(args[0]).includes('/__prerender-cover/')) audit.fetches.push({ source: String(args[0]), at: performance.now(), phase: audit.phase }); return fetch.apply(this, args); };
    document.addEventListener('animationstart', (event) => {
      if (['music-row-reveal','stats-enter'].includes(event.animationName)) audit.animationStarts.push({ name: event.animationName, at: performance.now(), phase: audit.phase, title: event.target.querySelector('p')?.textContent });
      if (mode === 'refresh' && event.animationName === 'music-row-reveal' && !audit.entryRefresh) {
        audit.entryRefresh = { at: performance.now(), animationElapsedTime: event.elapsedTime };
        const state = window.store.getState();
        window.store.setState({ tracks: state.tracks.map((track) => ({ ...track })) });
      }
    });
    window.addEventListener('keydown', (event) => { queueMicrotask(() => audit.keys.push({ key: event.key, prevented: event.defaultPrevented, focus: document.activeElement?.id })); });
    window.musicScroll = () => document.querySelector('[data-music-list]');
    const opacity = (el) => {
      let result = 1; for (let node = el; node instanceof HTMLElement; node = node.parentElement) { const style = getComputedStyle(node); result *= Number(style.opacity); if (style.display === 'none' || style.visibility !== 'visible') return 0; } return result;
    };
    const sample = () => {
      const scroll = window.musicScroll(), bounds = scroll?.getBoundingClientRect();
      const rows = [...document.querySelectorAll('.music-row')];
      const inBounds = (el) => { const box = el.getBoundingClientRect(); return bounds && box.width > 0 && box.height > 0 && box.bottom > Math.max(0, bounds.top) && box.top < Math.min(innerHeight, bounds.bottom); };
      const viewport = rows.filter(inBounds);
      const visible = viewport.filter((row) => opacity(row) > 0.01);
      const blank = visible.filter((row) => { const img = row.querySelector('img'); return !img || !img.complete || img.naturalWidth < 1 || opacity(img) <= 0.01; });
      const s = window.store?.getState();
      audit.frames.push({ at: performance.now(), phase: audit.phase, requested: s?.activeView, presented: document.querySelector('[data-presented-view]')?.dataset.presentedView, mounted: rows.length, viewport: viewport.length, visible: visible.length, blank: blank.map((row) => row.querySelector('p')?.textContent), preparing: !!document.querySelector('[data-music-preparing]'), ready: !!s?.musicPresentation, scrollTop: scroll?.scrollTop || 0, musicGroupCount: window.groups?.get('music-list')?.count ?? null, scrollTarget: window.getScrollTarget?.()?.dataset.musicList !== undefined ? 'music' : window.getScrollTarget?.()?.dataset.previousView || null });
      if (audit.frames.length < 5000) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    let callback = 0;
    const tracks = Array.from({ length: mode === 'empty' ? 0 : 500 }, (_, id) => ({ id: 'track-' + id, title: 'Track ' + id, artist: 'Artist ' + id, album: 'Album', album_artist: '', cover_path: '/__prerender-cover/' + mode + '/music/' + id + '.png', local_path: '', duration_seconds: 180, bitrate: 320, favorite: false, track_number: id, created_at: '2026-11-01', updated_at: 'fixture-v1', total_seconds: 0, play_count: 0, sort_order: id }));
    const media = (kind) => ({ total_seconds: 3600, play_count: 1, library_count: 50, played_count: 50, total_episodes: 0, total_watched_episodes: 0, top: Array.from({ length: 50 }, (_, id) => ({ id: kind + '-' + id, name: kind + ' ' + id, sub: '', seconds: 10000 - id, count: 1, cover_path: '/__prerender-cover/' + mode + '/stats-' + kind + '/' + id + '.png', wide_path: '' })) });
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, convertFileSrc: (path) => new URL(path, location.origin).href, transformCallback: () => ++callback, unregisterCallback() {}, invoke: async (command) => {
      audit.ipc.push({ command, at: performance.now(), phase: audit.phase });
      if (command === 'get_all_tracks') { await new Promise((done) => setTimeout(done, 30)); return tracks; }
      if (command === 'get_playlists') return [];
      if (command === 'get_stats') return { game: media('game'), video: media('video'), music: media('music') };
      if (command === 'plugin:event|listen') return ++callback;
      if (['plugin:event|unlisten','set_setting','play_music'].includes(command)) return;
      throw new Error('Unexpected IPC: ' + command);
    } };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  }, { mode, config: modes[mode] });
}
const twoFrames = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const snap = (page) => page.evaluate(() => ({ ...window.audit, decoded: [...window.audit.decoded], cache: window.cache?.getStats(), escInterceptCount: window.store?.getState().escInterceptCount, groups: [...window.groups].map(([id, opts]) => ({ id, count: opts.count })) }));
const phase = (page, name) => page.evaluate((value) => { window.audit.phase = value; }, name);
const click = async (page, view) => { await page.evaluate((view) => document.getElementById('nav-' + view).click(), view); };
const waitIdle = (page) => page.waitForFunction(() => window.cache?.getStats().active === 0 && window.cache?.getStats().queued === 0);
const waitVisibleReady = (page) => page.waitForFunction(() => { const f = window.audit.frames.at(-1); return f?.presented === 'music' && f.visible > 0 && f.blank.length === 0 && !f.preparing; });
function summarize(audit, name) {
  const frames = audit.frames.filter((f) => f.phase === name), visible = frames.filter((f) => f.visible > 0), maxVisible = Math.max(0, ...visible.map((f) => f.visible));
  const click = audit.clicks.find((c) => c.phase === name && c.view === 'music');
  const animation = audit.animationStarts.find((a) => a.phase === name && a.name === 'music-row-reveal');
  const complete = visible.find((f) => f.visible === maxVisible && f.blank.length === 0);
  return { clickAt: click?.at ?? null, firstAnimationMs: click && animation ? animation.at - click.at : null, firstVisibleMs: click && visible[0] ? visible[0].at - click.at : null, fullScreenMs: click && complete ? complete.at - click.at : null, firstPresentedMs: click ? (frames.find((f) => f.presented === 'music')?.at ?? click.at) - click.at : null, framesUntilAnimation: click && animation ? frames.filter((f) => f.at >= click.at && f.at < animation.at).length : null, blankFrames: visible.filter((f) => f.blank.length > 0).length, maxVisible, maxMounted: Math.max(0, ...frames.map((f) => f.mounted)) };
}
let browser, activePage;
try {
  await mkdir(outputDir, { recursive: true }); await server.listen();
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true }); report.environment.browser = browser.version();
  for (const mode of requested) {
    assert.ok(modes[mode], 'unknown mode: ' + mode);
    const config = modes[mode], errors = [];
    const page = activePage = await browser.newPage({ viewport: { width: config.width, height: config.height } });
    page.on('pageerror', (error) => errors.push(error.message));
    const compositor = !baseline && mode === 'multi' ? await page.context().newCDPSession(page) : null;
    if (compositor) await compositor.send('Tracing.start', { categories: 'devtools.timeline', transferMode: 'ReturnAsStream' });
    await initialize(page, mode); await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__music-prerender/${mode}`);
    await page.waitForFunction(() => window.store && window.store.getState().stats && (window.store.getState().tracks.length > 0 || location.pathname.endsWith('/empty')));
    const runtime = await page.evaluate(() => window.audit.runtime);
    assert.equal(runtime.viteProd, productionRuntime, 'Vite runtime must match requested production/development mode');
    assert.equal(runtime.reactHasDevelopmentAct, !productionRuntime, 'React runtime must match requested production/development mode');
    if (mode === 'cancel') {
      await page.waitForFunction(() => window.audit.fetches.some((f) => f.source.includes('/music/0.png')));
      await phase(page, 'cancel'); await click(page, 'music'); await twoFrames(page);
      assert.equal(await page.locator('[data-presented-view]').getAttribute('data-presented-view'), 'games', 'unprepared music retains the previous page');
      assert.equal(await page.locator('[data-presented-view]').evaluate((el) => el.inert), true);
      const requestedPriorities = await page.evaluate(() => {
        const list = window.musicScroll(), bounds = list.getBoundingClientRect();
        return [...list.querySelectorAll('.music-row')].filter((row) => {
          const rect = row.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom;
        }).map((row) => row.querySelector('img')?.fetchPriority);
      });
      assert.ok(requestedPriorities.length > 0 && requestedPriorities.every((value) => value === 'high'), 'requested music promotes viewport images while the previous page is still presented');
      await page.evaluate((priorities) => { window.audit.requestedViewportPriorities = priorities; }, requestedPriorities);
      await click(page, 'settings'); await page.waitForSelector('[data-presented-view="settings"]');
      await waitIdle(page); await page.waitForTimeout(100); await twoFrames(page);
      const final = await snap(page);
      assert.equal(final.frames.at(-1).presented, 'settings', 'late readiness must not reopen a cancelled destination');
      assert.equal(final.animationStarts.filter((a) => a.name === 'music-row-reveal').length, 0, 'hidden or cancelled navigation must not consume intro');
      assert.notEqual(final.frames.at(-1).scrollTarget, 'music', 'hidden music does not steal right-stick target');
      assert.deepEqual(errors, []); report.scenarios.push({ mode, config, final, pageErrors: errors }); log({ mode, cancelled: true, latePresentation: final.frames.at(-1).presented });
      await page.close(); activePage = null; continue;
    }
    // 1s normal game-library dwell makes background preparation independent of
    // the act of navigation. Baseline intentionally has no music DOM or covers.
    await page.waitForTimeout(1000); await waitIdle(page); await twoFrames(page);
    if (!baseline) await page.waitForFunction(() => !!window.store.getState().musicPresentation);
    if (mode === 'resize') { await page.setViewportSize({ width: 1920, height: 900 }); await page.waitForTimeout(100); await waitIdle(page); await twoFrames(page); }
    const background = await snap(page);
    if (compositor) {
      const { root } = await compositor.send('DOM.getDocument');
      const { nodeId } = await compositor.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-music-hidden]' });
      const { node } = await compositor.send('DOM.describeNode', { nodeId, depth: -1 });
      const ids = new Set();
      const collect = (node) => { ids.add(node.backendNodeId); node.children?.forEach(collect); }; collect(node);
      const finished = new Promise((done) => compositor.once('Tracing.tracingComplete', done));
      await compositor.send('Tracing.end'); const { stream } = await finished; let trace = '';
      while (true) { const chunk = await compositor.send('IO.read', { handle: stream }); trace += chunk.data; if (chunk.eof) break; }
      await compositor.send('IO.close', { handle: stream });
      const paints = JSON.parse(trace).traceEvents.filter((e) => e.name === 'Paint' && e.ph === 'X');
      const musicPaints = paints.filter((e) => ids.has(e.args?.data?.nodeId));
      background.prepaint = { paintedWhileHidden: musicPaints.length > 0, musicPaints: musicPaints.map((e) => ({ nodeId: e.args.data.nodeId, durationUs: e.dur })), allPaintNodeIds: [...new Set(paints.map((e) => e.args?.data?.nodeId))], musicRootBackendNodeId: node.backendNodeId };
      assert.ok(background.prepaint.paintedWhileHidden, 'music must have real Paint events before first navigation');
    }
    const last = background.frames.at(-1);
    assert.equal(last.visible, 0, 'music never appears over games during startup');
    assert.equal(background.animationStarts.filter((a) => a.name === 'music-row-reveal').length, 0, 'background preparation cannot play entrance');
    assert.ok(last.musicGroupCount === null || last.musicGroupCount === 0, 'hidden music cannot activate its gamepad group');
    assert.notEqual(last.scrollTarget, 'music', 'hidden music cannot steal right-stick scroll');
    if (baseline) assert.equal(last.mounted, 0);
    else if (mode !== 'empty') {
      assert.ok(last.mounted > 0 && last.mounted < 130, 'hidden music prebuilds only virtualized viewport and overscan');
      assert.ok(background.fetches.some((f) => f.source.includes('/music/')), 'first-screen requests happen before navigation');
      assert.equal(await page.locator('[data-music-hidden]').evaluate((el) => el.inert), true);
    }
    await page.locator('#previous-focus').focus(); await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'previous-focus', 'hidden music must not capture keyboard focus');
    assert.equal(await page.evaluate(() => window.audit.keys.at(-1).prevented), false, 'hidden music must not consume Escape');
    await phase(page, 'first'); await click(page, 'music');
    if (mode !== 'empty') { await waitVisibleReady(page); await page.waitForTimeout(350); } else await page.waitForSelector('[data-presented-view="music"]');
    await twoFrames(page); const first = await snap(page), firstSummary = summarize(first, 'first');
    if (mode !== 'empty') {
      assert.equal(firstSummary.blankFrames, 0, 'entry preserves complete covers');
      assert.ok(firstSummary.firstAnimationMs !== null, 'first navigation plays row intro');
      // Chromium may deliver an additional rAF around viewport resize; measure
      // the actual milliseconds as evidence and allow that one-frame jitter.
      if (!baseline) {
        const entryFrames = first.frames.filter((f) => f.phase === 'first' && f.at >= firstSummary.clickAt);
        assert.ok(entryFrames.every((f) => !f.preparing), 'prepared navigation must not wait behind the cover gate');
      }
      assert.ok(firstSummary.maxMounted < 130, '500 tracks stay virtualized');
    }
    if (mode === 'refresh') {
      assert.ok(first.entryRefresh && first.entryRefresh.animationElapsedTime === 0, 'fixture must refresh tracks while entrance is starting');
      const afterRefresh = first.frames.filter((f) => f.phase === 'first' && f.at >= first.entryRefresh.at);
      assert.ok(afterRefresh.length > 5);
      assert.ok(afterRefresh.every((f) => !f.preparing), 'an active entrance refresh cannot reapply the preparing cover gate');
      const firstShown = afterRefresh.findIndex((f) => f.visible > 0);
      assert.ok(firstShown >= 0 && afterRefresh.slice(firstShown).every((f) => f.visible > 0), 'an already-shown music list cannot become completely hidden during refresh');
    }
    const newFetchesOnEntry = first.fetches.length - background.fetches.length;
    const newTrackLoadsOnEntry = first.ipc.filter((i) => i.command === 'get_all_tracks').length - background.ipc.filter((i) => i.command === 'get_all_tracks').length;
    if (!baseline) { assert.equal(newFetchesOnEntry, 0, 'prepared navigation must not refetch covers'); assert.equal(newTrackLoadsOnEntry, 0, 'prepared navigation must not repeat track IPC'); }
    let warmSummary, scroll;
    if (mode !== 'empty') {
      await phase(page, 'scroll'); const priorAnimations = first.animationStarts.filter((a) => a.name === 'music-row-reveal').length;
      await page.evaluate(() => { window.musicScroll().scrollTop = 2000; }); await waitIdle(page); await page.waitForTimeout(80); await twoFrames(page);
      await page.evaluate(() => { window.musicScroll().scrollTop = 0; }); await waitIdle(page); await twoFrames(page);
      scroll = await snap(page);
      assert.equal(scroll.animationStarts.filter((a) => a.name === 'music-row-reveal').length, priorAnimations, 'scroll remount must not replay intro');
      assert.ok(scroll.frames.every((f) => f.mounted < 160), 'virtualized rows remain bounded');
      await click(page, 'games'); await page.waitForSelector('[data-presented-view="games"]'); await twoFrames(page);
      const hidden = await snap(page);
      assert.notEqual(hidden.frames.at(-1).scrollTarget, 'music', 'leaving music restores another scroll target');
      await phase(page, 'warm'); await click(page, 'music'); await waitVisibleReady(page); await page.waitForTimeout(350); await twoFrames(page);
      const warm = await snap(page); warmSummary = summarize(warm, 'warm');
      assert.equal(warmSummary.blankFrames, 0);
      assert.equal(warm.fetches.length - hidden.fetches.length, 0, 'warm entry does not fetch cached covers');
      if (!baseline && mode === 'multi') {
        await phase(page, 'input');
        assert.equal(warm.runtime.initialTrackCount, 0, 'highlight fixture begins with an empty track store before async load');
        const bounds = await page.locator('[data-music-list]').boundingBox();
        await page.mouse.move(bounds.x + 180, bounds.y + 28);
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.music-hl')).opacity === '1');
        const beforeScroll = await page.locator('.music-hl').evaluate((el) => ({ opacity: getComputedStyle(el).opacity, top: el.style.top }));
        await page.evaluate(() => { const list = window.musicScroll(); list.scrollTop = 54; list.dispatchEvent(new Event('scroll')); });
        assert.equal(await page.locator('.music-hl').evaluate((el) => getComputedStyle(el).opacity), '0', 'scroll temporarily clears highlight');
        await page.evaluate(() => window.musicScroll().dispatchEvent(new Event('scrollend')));
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.music-hl')).opacity === '1');
        const afterScrollEnd = await page.locator('.music-hl').evaluate((el) => ({ opacity: getComputedStyle(el).opacity, top: el.style.top }));
        // React's delegated pointer listener runs before this window bubble
        // listener. Thus the real pointer move queues the highlight frame and
        // then navigation cancels it before the next paint.
        await page.evaluate(() => window.addEventListener('pointermove', () => window.store.getState().setActiveView('games'), { once: true }));
        await page.mouse.move(bounds.x + 190, bounds.y + 80);
        await page.waitForSelector('[data-presented-view="games"]'); await twoFrames(page);
        await click(page, 'music'); await waitVisibleReady(page); await page.waitForTimeout(300);
        await page.mouse.move(bounds.x + 215, bounds.y + 135);
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.music-hl')).opacity === '1');
        const afterReturn = await page.locator('.music-hl').evaluate((el) => ({ opacity: getComputedStyle(el).opacity, top: el.style.top }));
        assert.notEqual(afterReturn.top, afterScrollEnd.top, 'moving after cancelled highlight frame must move the highlight');
        await page.evaluate((checks) => { window.audit.highlightChecks = checks; }, { beforeScroll, afterScrollEnd, afterReturn });
        await page.evaluate(() => { window.musicScroll().scrollTop = 0; }); await twoFrames(page);
        await page.locator('.music-row').first().click({ button: 'right' });
        await page.waitForFunction(() => window.groups.has('menu:music'));
        assert.ok(await page.locator('.context-menu-item').count() > 0);
        // Direct navigation models the global shoulder-key path: no mouse click
        // outside the menu is allowed to clean it up on the component's behalf.
        await page.evaluate(() => window.store.getState().setActiveView('games'));
        await page.waitForSelector('[data-presented-view="games"]'); await twoFrames(page);
        assert.equal(await page.locator('.context-menu-item').count(), 0, 'leaving music tears down portal menus');
        assert.equal(await page.evaluate(() => window.store.getState().escInterceptCount), 0, 'hidden modal state cannot reserve global Escape');
        assert.equal(await page.evaluate(() => window.groups.has('menu:music')), false, 'hidden context menu releases gamepad registration');
      }
    }
    await phase(page, 'stats'); await click(page, 'stats'); await page.waitForSelector('[data-presented-view="stats"]'); await page.waitForTimeout(350); await twoFrames(page);
    assert.equal(await page.locator('.stats-row').count() > 0, true);
    assert.ok(await page.locator('.stats-row').count() < 80, 'statistics remains virtualized');
    const final = await snap(page);
    assert.equal(final.animationStarts.filter((a) => a.phase === 'stats' && a.name === 'stats-enter').length, 1, 'statistics retains its entry animation');
    if (!baseline) assert.notEqual(final.frames.at(-1).scrollTarget, 'music');
    assert.deepEqual(errors, []);
    report.scenarios.push({ mode, config, firstSummary, warmSummary, newFetchesOnEntry, newTrackLoadsOnEntry, background, first, scroll, final, pageErrors: errors });
    log({ mode, firstSummary, warmSummary, newFetchesOnEntry, newTrackLoadsOnEntry });
    await page.close(); activePage = null;
  }
  report.complete = true;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  if (activePage) { report.failure.snapshot = await snap(activePage).catch(() => null); await activePage.screenshot({ path: resolve(outputDir, output + '-failure.png') }).catch(() => {}); }
  log({ failure: error.message }); process.exitCode = 1;
} finally {
  await browser?.close(); await server.close();
  if (!baseline) {
    report.sourceUnchangedDuringRun = true;
    for (const [path, hash] of Object.entries(hashes)) if (createHash('sha256').update(await readFile(path)).digest('hex') !== hash) report.sourceUnchangedDuringRun = false;
    if (!report.sourceUnchangedDuringRun) { report.complete = false; report.failure ??= { message: 'Sources changed during run; repeat when stable.' }; process.exitCode = 1; }
  } else report.frozenBaselineSources = [...frozen.keys()];
  await writeFile(resolve(outputDir, output + '.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(outputDir, output + '-requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(resolve(outputDir, output + '.log'), lines.join('\n') + '\n');
  log({ complete: report.complete, scenarios: report.scenarios.length, output: resolve(outputDir, output + '.json') });
}
