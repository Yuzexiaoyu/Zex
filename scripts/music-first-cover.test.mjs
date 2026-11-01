// Real MusicView, real cover cache and HTTP images; only desktop IPC is mocked.
// Baseline mode loads the saved pre-fix modules so concurrent implementation edits
// cannot contaminate the reproduction. Normal mode always tests current sources.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseline = process.env.ZEX_MUSIC_COVER_BASELINE === '1';
const output = process.env.ZEX_MUSIC_COVER_OUTPUT || (baseline ? 'music-first-cover-before' : 'music-first-cover-after');
assert.match(output, /^music-first-cover-[a-z0-9-]+$/);
const outputDir = resolve('docs/verification');
const sourcePaths = ['src/views/MusicView.tsx', 'src/components/CoverImg.tsx', 'src/utils/cover-cache.ts'];
const frozen = new Map();
const hashes = {};
for (const path of sourcePaths) {
  const source = await readFile(baseline ? resolve(outputDir, 'music-first-cover-baseline-source', basename(path)) : path, 'utf8');
  hashes[path] = createHash('sha256').update(source).digest('hex');
  if (baseline) frozen.set(resolve(path).replaceAll('\\', '/'), source);
}
for (const path of ['src/index.css', 'src/utils/media.ts']) hashes[path] = createHash('sha256').update(await readFile(path)).digest('hex');
const optionalSources = ['src/utils/gridImages.ts', 'scripts/music-first-cover.test.mjs'];
if (!baseline) for (const path of optionalSources) {
  const source = await readFile(path).catch(() => null);
  if (source) hashes[path] = createHash('sha256').update(source).digest('hex');
}
const report = { generatedAt: new Date().toISOString(), baseline, sourceHashes: hashes,
  environment: { node: process.version, browser: '', requestInterception: false, httpCacheDisabled: false },
  scope: 'Actual React MusicView and production CSS/cache with mocked Tauri IPC and synthetic HTTP PNGs. Samples each requestAnimationFrame; visible means cover rectangle intersects the actual scrollport and all ancestors have opacity > 0.01, visibility visible. Browser-only, not installed WebView2.',
  decodedMeaning: 'decodedByApp counts successful application Image.decode calls; absence of that marker does not establish that the browser did not decode implicitly.',
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
const modes = {
  single: { layout: 'single', width: 1280, height: 900, delay: 35, decodeDelay: 0 },
  multi: { layout: 'multi', width: 1920, height: 900, delay: 35, decodeDelay: 0 },
  decode: { layout: 'multi', width: 1920, height: 900, delay: 20, decodeDelay: 70 },
  slow: { layout: 'multi', width: 1920, height: 900, delay: 1200, decodeDelay: 0 },
  missing: { layout: 'multi', width: 1920, height: 900, delay: 20, decodeDelay: 0 },
  stalled: { layout: 'multi', width: 1920, height: 900, delay: null, decodeDelay: 0 },
  cancel: { layout: 'multi', width: 1920, height: 900, delay: 1200, decodeDelay: 0 },
  earlyscroll: { layout: 'multi', width: 1920, height: 900, delay: 1200, decodeDelay: 0 },
};
const requested = (process.env.ZEX_MUSIC_COVER_MODES || (baseline ? 'single,multi' : Object.keys(modes).join(','))).split(',');
const server = await createServer({ appType: 'custom', plugins: [{ name: 'frozen-music-baseline', enforce: 'pre', load(id) { return frozen.get(id.replaceAll('\\', '/').split('?')[0]); } }], server: { port: 41791, strictPort: false, open: false, hmr: false } });
server.middlewares.use(async (req, res, next) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/__music-cover/')) {
    const [, , mode, file] = url.pathname.split('/');
    const id = Number(file.replace('.png', ''));
    const failed = mode === 'missing' && id === 0;
    const record = { mode, id, requestedAt: Date.now(), url: req.url, status: failed ? 404 : 200, completedAt: null, aborted: false };
    requests.push(record); res.on('close', () => { if (!res.writableFinished) record.aborted = true; });
    if (mode === 'stalled') { record.status = null; return; }
    // A single slow source tests bounded presentation without multiplying the
    // artificial delay across every six-request cache batch.
    const delay = ['slow', 'cancel', 'earlyscroll'].includes(mode) ? (id === 0 ? modes[mode].delay : 25) : modes[mode].delay;
    await new Promise((done) => setTimeout(done, delay));
    if (res.destroyed) return;
    res.statusCode = record.status; res.setHeader('Content-Type', failed ? 'text/plain' : 'image/png');
    res.setHeader('Cache-Control', failed ? 'no-store' : 'public, max-age=31536000, immutable');
    res.end(failed ? 'missing cover' : body); record.completedAt = Date.now(); return;
  }
  if (!url.pathname.startsWith('/__music-first-cover/')) return next();
  const mode = url.pathname.split('/').at(-1);
  const html = await server.transformIndexHtml(url.pathname, `<html class="dark"><head><link rel="icon" href="data:,"></head><body style="margin:0"><div id="root" style="height:100vh"></div><script type="module">
    import React from 'react'; import ReactDOM from 'react-dom/client';
    import MusicView from '/src/views/MusicView.tsx'; import { useAppStore } from '/src/store/index.ts'; import { coverCache } from '/src/utils/cover-cache.ts'; import '/src/index.css';
    window.store = useAppStore; window.cache = coverCache;
    const acquire = coverCache.request; let leaseId = 0;
    coverCache.request = (...args) => {
      const request = acquire(...args), id = ++leaseId; window.audit.leases.push({ id, source: args[0], start: performance.now(), released: null });
      const release = request.release; request.release = () => { const lease = window.audit.leases.find((item) => item.id === id); if (lease.released === null) lease.released = performance.now(); release(); };
      return request;
    };
    useAppStore.setState({ musicLayout: '${modes[mode].layout}' });
    function Harness() { const [mounted, setMounted] = React.useState(true); window.mountMusic = setMounted; return mounted ? React.createElement(MusicView) : null; }
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(Harness)));
  </script></body></html>`);
  res.setHeader('Content-Type', 'text/html'); res.end(html);
});

async function initialize(page, mode) {
  await page.addInitScript(({ mode, config }) => {
    window.audit = { frames: [], phase: 'cold', animationStarts: [], ipc: [], leases: [], decodes: [], decoded: new Set(), loads: [], fetches: [] };
    const audit = window.audit;
    const originalDecode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function (...args) {
      const item = { src: this.src, at: performance.now(), done: null, error: null }; audit.decodes.push(item);
      return originalDecode.apply(this, args).then(async () => { if (config.decodeDelay) await new Promise((done) => setTimeout(done, config.decodeDelay)); item.done = performance.now(); audit.decoded.add(item.src); }, (error) => { item.error = String(error); throw error; });
    };
    const fetch = window.fetch;
    window.fetch = function (...args) { if (String(args[0]).includes('/__music-cover/')) audit.fetches.push({ source: String(args[0]), at: performance.now() }); return fetch.apply(this, args); };
    document.addEventListener('load', (event) => { if (event.target instanceof HTMLImageElement) audit.loads.push({ src: event.target.src, at: performance.now() }); }, true);
    document.addEventListener('animationstart', (event) => { if (event.animationName === 'music-row-reveal') audit.animationStarts.push({ at: performance.now(), phase: audit.phase, title: event.target.querySelector('p')?.textContent }); });
    window.musicScroll = () => document.querySelector('[data-music-list]') || [...document.querySelectorAll('div')].find((el) => el.classList.contains('overflow-y-auto') && el.querySelector('.music-row'));
    const isVisible = (el, scroll) => {
      const box = el.getBoundingClientRect(); const clip = scroll?.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0 || box.bottom <= Math.max(0, clip?.top || 0) || box.top >= Math.min(innerHeight, clip?.bottom || innerHeight) || box.right <= 0 || box.left >= innerWidth) return false;
      let opacity = 1;
      for (let node = el; node instanceof HTMLElement; node = node.parentElement) { const style = getComputedStyle(node); opacity *= Number(style.opacity); if (style.display === 'none' || style.visibility !== 'visible' || opacity <= 0.01) return false; }
      return true;
    };
    const sample = () => {
      const scroll = window.musicScroll(); const rows = [...document.querySelectorAll('.music-row')];
      const visible = rows.filter((row) => isVisible(row.querySelector('img')?.parentElement || row, scroll));
      const images = visible.map((row) => { const img = row.querySelector('img'); return { id: Number(row.querySelector('p')?.textContent?.replace('Track ', '')), status: img?.dataset.coverStatus, complete: img?.complete, naturalWidth: img?.naturalWidth, src: img?.getAttribute('src'), visibleImage: img ? isVisible(img, scroll) : false, decodedByApp: img ? audit.decoded.has(img.src) : false }; });
      const ready = images.filter((img) => img.visibleImage && img.complete && img.naturalWidth > 0);
      const frame = { at: performance.now(), phase: audit.phase, mounted: rows.length, visible: visible.length, ready: ready.length, blank: images.filter((img) => !ready.includes(img)).map((img) => img.id), pending: images.filter((img) => img.status !== 'error' && !ready.includes(img)).map((img) => img.id), errors: images.filter((img) => img.status === 'error').map((img) => img.id), decodedByApp: ready.filter((img) => img.decodedByApp).length, scrollTop: scroll?.scrollTop || 0, cache: window.cache?.getStats() };
      if ((rows.length || audit.frames.length) && audit.frames.length < 5000) audit.frames.push(frame);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    let callback = 0;
    const tracks = Array.from({ length: 200 }, (_, id) => ({ id: 'track-' + id, title: 'Track ' + id, artist: 'Artist ' + id, album: 'Album', album_artist: '', cover_path: '/__music-cover/' + mode + '/' + id + '.png', local_path: '', duration_seconds: 180, bitrate: 320, favorite: false, track_number: id, created_at: '2026-11-01', updated_at: 'fixture-v1', total_seconds: 0, play_count: 0, sort_order: id }));
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, convertFileSrc: (path) => new URL(path, location.origin).href, transformCallback: () => ++callback, unregisterCallback() {}, invoke: async (command) => { audit.ipc.push(command); if (command === 'get_all_tracks') { await new Promise((done) => setTimeout(done, 30)); return tracks; } if (command === 'get_playlists') return []; if (command === 'plugin:event|listen') return ++callback; if (command === 'plugin:event|unlisten' || command === 'set_setting') return; throw new Error('Unexpected IPC: ' + command); } };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  }, { mode, config: modes[mode] });
}
const twoFrames = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const snap = (page) => page.evaluate(() => ({ ...window.audit, decoded: [...window.audit.decoded], cache: window.cache.getStats() }));
const phase = async (page, value) => { await page.evaluate((value) => { window.audit.phase = value; }, value); await twoFrames(page); };
const waitReady = (page) => page.waitForFunction(() => { const frame = window.audit.frames.at(-1); return frame?.visible > 0 && frame.pending.length === 0 && frame.cache.active === 0 && frame.cache.queued === 0; }, null, { timeout: 10000 });
async function scrollTo(page, offset) {
  await page.evaluate((offset) => { window.musicScroll().scrollTop = offset; }, offset);
  await page.waitForFunction((offset) => Math.abs((window.audit.frames.at(-1)?.scrollTop ?? -1) - offset) < 2, offset);
  await twoFrames(page);
}
function summarize(frames, name) {
  const selected = frames.filter((frame) => frame.phase === name);
  const visible = selected.filter((frame) => frame.visible > 0);
  const blanks = visible.filter((frame) => frame.blank.length > 0);
  const pending = visible.filter((frame) => frame.pending.length > 0);
  return { frames: selected.length, visibleFrames: visible.length, firstVisibleAt: visible[0]?.at ?? null, firstVisible: visible[0] || null, maxVisible: Math.max(0, ...visible.map((frame) => frame.visible)), blankFrames: blanks.length, pendingFrames: pending.length, maxBlank: Math.max(0, ...blanks.map((frame) => frame.blank.length)), blankIds: [...new Set(blanks.flatMap((frame) => frame.blank))], firstBlankAt: blanks[0]?.at ?? null, lastBlankAt: blanks.at(-1)?.at ?? null, fullyReadyAt: visible.find((frame) => frame.blank.length === 0 && frame.visible === Math.max(...visible.map((frame) => frame.visible)))?.at ?? null };
}
let browser;
let activePage;
try {
  await mkdir(outputDir, { recursive: true }); await server.listen();
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true }); report.environment.browser = browser.version();
  for (const mode of requested) {
    assert.ok(modes[mode], 'unknown mode: ' + mode);
    const config = modes[mode]; const errors = [];
    const page = activePage = await browser.newPage({ viewport: { width: config.width, height: config.height } });
    page.on('pageerror', (error) => errors.push(error.message));
    await initialize(page, mode); await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__music-first-cover/${mode}`);
    await page.waitForFunction(() => window.audit.frames.some((frame) => frame.mounted > 0));
    if (mode === 'stalled') {
      await page.waitForFunction(() => window.audit.frames.at(-1)?.visible > 0, null, { timeout: 4000 });
      await twoFrames(page); const released = await snap(page); const timing = summarize(released.frames, 'cold');
      const waitMs = timing.firstVisibleAt - released.frames[0].at;
      assert.ok(waitMs >= 2000 && waitMs < 3500, 'permanently pending sources must release the entrance near the 2500ms deadline');
      assert.equal(await page.locator('[data-music-preparing]').count(), 0, 'deadline must remove the preparation gate');
      await page.evaluate(() => window.mountMusic(false)); await page.waitForSelector('.music-row', { state: 'detached' }); await twoFrames(page);
      const final = await snap(page); assert.equal(final.leases.filter((lease) => lease.released === null).length, 0); assert.equal(final.cache.queued, 0); assert.deepEqual(errors, []);
      report.scenarios.push({ mode, config, waitMs, coldSummary: timing, released, final, pageErrors: errors }); log({ mode, waitMs, visibleRowsAfterDeadline: timing.maxVisible, liveLeasesAfterUnmount: 0 });
      await page.close(); activePage = null; continue;
    }
    if (mode === 'cancel') {
      await page.evaluate(() => window.mountMusic(false)); await page.waitForSelector('.music-row', { state: 'detached' });
      await twoFrames(page); const cancelled = await snap(page);
      assert.equal(cancelled.leases.filter((lease) => lease.released === null).length, 0, 'unmount must release every cache lease');
      assert.equal(cancelled.cache.queued, 0, 'unmount must cancel queued-only cover requests');
      await page.waitForFunction(() => window.cache.getStats().active === 0); await twoFrames(page);
      assert.equal(await page.locator('.music-row').count(), 0);
      const final = await snap(page); assert.deepEqual(errors, []);
      report.scenarios.push({ mode, config, cancelled, final, pageErrors: errors }); log({ mode, liveLeasesAfterUnmount: cancelled.leases.filter((lease) => lease.released === null).length, queuedAfterUnmount: cancelled.cache.queued });
      await page.close(); activePage = null; continue;
    }
    if (mode === 'earlyscroll') {
      await phase(page, 'earlyscroll'); await scrollTo(page, 1000);
      const first = await snap(page); await waitReady(page);
      await scrollTo(page, 0); await waitReady(page); await twoFrames(page);
      const final = await snap(page);
      assert.equal(final.animationStarts.filter((item) => item.phase === 'earlyscroll').length, 0, 'scroll during preparation must cancel the entrance');
      assert.deepEqual(errors, []); report.scenarios.push({ mode, config, first, final, pageErrors: errors }); log({ mode, animationsAfterEarlyScroll: final.animationStarts.filter((item) => item.phase === 'earlyscroll').length });
      await page.close(); activePage = null; continue;
    }
    await waitReady(page); await page.waitForTimeout(350); await twoFrames(page);
    const cold = await snap(page); const coldSummary = summarize(cold.frames, 'cold');
    if (baseline) assert.ok(coldSummary.blankFrames > 0, 'baseline must reproduce visible unloaded covers');
    else if (['single', 'multi', 'decode', 'slow'].includes(mode)) assert.equal(coldSummary.blankFrames, 0, 'cold entry must not reveal a row before its cover is displayable');
    else assert.ok(coldSummary.firstVisibleAt - cold.frames[0].at < 3000, 'slow or missing covers must not block the view indefinitely');
    if (!baseline && mode === 'decode') { assert.ok(cold.decodes.length > 0, 'entry preparation must explicitly decode'); const first = coldSummary.firstVisible; assert.equal(first.decodedByApp, first.ready, 'all images exposed at the first visible frame must have completed app decode'); }
    let warmSummary;
    let scrollSummary;
    if (['single', 'multi'].includes(mode)) {
      await phase(page, 'scroll'); const animations = cold.animationStarts.length;
      await scrollTo(page, 2000); await waitReady(page);
      await scrollTo(page, 0); await waitReady(page); await twoFrames(page);
      const scrolled = await snap(page); scrollSummary = summarize(scrolled.frames, 'scroll');
      assert.equal(scrolled.animationStarts.length, animations, 'virtualized remounts must not replay entrance');
      await page.evaluate(() => window.mountMusic(false)); await page.waitForSelector('.music-row', { state: 'detached' });
      const beforeWarm = await snap(page); assert.equal(beforeWarm.leases.filter((lease) => lease.released === null).length, 0);
      await phase(page, 'warm'); await page.evaluate(() => window.mountMusic(true)); await waitReady(page); await page.waitForTimeout(350);
      const warm = await snap(page); warmSummary = { ...summarize(warm.frames, 'warm'), newFetches: warm.fetches.length - beforeWarm.fetches.length };
      if (!baseline) assert.equal(warmSummary.blankFrames, 0, 'warm remount must not expose unloaded images');
      assert.equal(warmSummary.newFetches, 0, 'warm entry must reuse cached sources');
    }
    const final = await snap(page); assert.deepEqual(errors, []);
    const modeRequests = requests.filter((request) => request.mode === mode);
    const coldFirstFrame = cold.frames.find((frame) => frame.mounted > 0);
    const visibleIds = new Set(Array.from({ length: coldSummary.maxVisible }, (_, id) => id));
    const firstScreenRequests = modeRequests.filter((request) => visibleIds.has(request.id));
    const requestOrder = modeRequests.map((request) => request.id);
    const lastVisibleRequestPosition = Math.max(...firstScreenRequests.map((request) => requestOrder.indexOf(request.id)));
    const overscanBeforeLastVisible = requestOrder.slice(0, lastVisibleRequestPosition).filter((id) => !visibleIds.has(id)).length;
    report.scenarios.push({ mode, config, coldSummary, warmSummary, scrollSummary, coldFirstMountedAt: coldFirstFrame?.at, overscanBeforeLastVisible, requestOrder, cold, final, pageErrors: errors });
    log({ mode, cold: coldSummary, warm: warmSummary, overscanBeforeLastVisible });
    await page.close(); activePage = null;
  }
  report.complete = true;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  if (activePage) { report.failure.snapshot = await snap(activePage).catch(() => null); await activePage.screenshot({ path: resolve(outputDir, output + '-failure.png') }).catch(() => {}); }
  log({ failure: error.message }); process.exitCode = 1;
} finally {
  await browser?.close(); await server.close();
  if (!baseline) { report.sourceUnchangedDuringRun = true; for (const [path, hash] of Object.entries(hashes)) if (createHash('sha256').update(await readFile(path)).digest('hex') !== hash) report.sourceUnchangedDuringRun = false;
    if (!report.sourceUnchangedDuringRun) { report.complete = false; report.failure ??= { message: 'Production sources changed during the run; rerun with stable sources.' }; process.exitCode = 1; }
  } else report.frozenBaselineSources = [...frozen.keys()];
  await writeFile(resolve(outputDir, output + '.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(outputDir, output + '-requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(resolve(outputDir, output + '.log'), lines.join('\n') + '\n');
  log({ complete: report.complete, scenarios: report.scenarios.length, output: resolve(outputDir, output + '.json') });
}
