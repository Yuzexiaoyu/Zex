// Browser regression of the real statistics components. Existing audit evidence is never overwritten.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const outputDir = resolve('docs/verification');
const outputStem = process.env.ZEX_STATS_FIX_OUTPUT || 'stats-image-fix';
assert.match(outputStem, /^stats-image-fix(?:-[a-z0-9-]+)?$/, 'use a new fix-evidence filename');
const requested = (process.env.ZEX_STATS_FIX_MODES || 'actual_dpr1,actual_dpr2,slow,missing,csp').split(',').filter(Boolean);
const requests = [];
const lines = [];
const log = (value) => { const line = JSON.stringify(value); lines.push(line); console.log(line); };
const report = {
  generatedAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  environment: { node: process.version, browser: '', httpCacheDisabled: false, requestInterception: false, viewport: { width: 1600, height: 950 } },
  sourceHashes: {}, requested, scenarios: [],
  scope: 'Real React components and current CSP, mocked stats IPC, synthetic PNG thumbnails served with mirrored covers cache headers; not installed WebView2 or native thumbnail generation.',
  complete: false,
};
for (const path of ['src/views/StatsView.tsx', 'src/components/StatsCovers.tsx', 'src/utils/statsImages.ts', 'src/utils/statsPreload.ts', 'src/utils/cover-cache.ts', 'src/components/CoverImg.tsx', 'src/types/index.ts', 'src-tauri/src/covers.rs', 'src-tauri/src/stats.rs', 'src-tauri/tauri.conf.json', 'scripts/stats-image-regression.mjs']) {
  report.sourceHashes[path] = createHash('sha256').update(await readFile(path)).digest('hex');
}
const shapeFile = 'scripts/fixtures/stats-library-shape.json';
const shapeBytes = await readFile(shapeFile);
const counts = JSON.parse(shapeBytes);
assert.deepEqual(counts, { game: 112, video: 6, music: 132 });
report.actualShapeReference = { file: shapeFile, sha256: createHash('sha256').update(shapeBytes).digest('hex'), counts, syntheticPixels: true };
const productionCsp = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).app.security.csp;
report.productionCsp = productionCsp;

function png(width, height, version) {
  const crc = (bytes) => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const content = Buffer.concat([Buffer.from(type), data]); const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(content)); return Buffer.concat([length, content, checksum]); };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (1 + width * 3) + 1 + x * 3;
    pixels[offset] = (x * 3 + y + version * 71) & 255;
    pixels[offset + 1] = (x + y * 2 + version * 17) & 255;
    pixels[offset + 2] = (x ^ y ^ (version * 31)) & 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const fixtureCache = new Map();
const fixtures = (media, height, version) => {
  const key = `${media}-${height}-${version}`;
  if (!fixtureCache.has(key)) {
    const ratio = media === 'game' ? 1920 / 620 : media === 'video' ? 1280 / 720 : 1;
    const width = Math.round(height * ratio);
    const body = png(width, height, version === 'fixture-v2' ? 2 : 1);
    fixtureCache.set(key, { width, height, body });
  }
  return fixtureCache.get(key);
};
const server = await createServer({ appType: 'custom', server: { port: 41789, strictPort: false, open: false, hmr: false } });
const cspFor = (html) => {
  const coverOrigin = `http://localhost:${server.httpServer.address().port}`;
  const hashes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].filter((match) => match[1].trim()).map((match) => "'sha256-" + createHash('sha256').update(match[1]).digest('base64') + "'");
  // Only translate the custom-protocol origin and permit Vite fixture modules.
  return productionCsp.replaceAll('http://covers.localhost', coverOrigin) + "; script-src 'self' " + hashes.join(' ');
};
server.middlewares.use(async (req, res, next) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/__stats-image-fix-cover/')) {
    const [, , mode, media, file] = url.pathname.split('/');
    const id = Number(file.replace('.png', ''));
    const height = Number(url.searchParams.get('h')) || 720;
    const version = url.searchParams.get('v') || '';
    const fixture = fixtures(media, height, version);
    const etag = `"${mode}-${media}-${id}-${height}-${version}"`;
    const failed = mode === 'missing' && id === 0;
    const status = failed ? 404 : req.headers['if-none-match'] === etag ? 304 : 200;
    const record = { mode, media, id, url: req.url, thumb: url.searchParams.get('thumb'), height, width: fixture.width, version, status, ifNoneMatch: req.headers['if-none-match'] ?? null, bodyBytes: status === 200 ? fixture.body.length : 0, aborted: false };
    requests.push(record);
    res.on('close', () => { if (!res.writableFinished) record.aborted = true; });
    if (mode === 'slow') await new Promise((done) => setTimeout(done, 800));
    if (res.destroyed) return;
    res.statusCode = status;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', failed ? 'no-store' : version ? 'public, max-age=31536000, immutable' : 'public, no-cache');
    if (!failed) res.setHeader('ETag', etag);
    res.setHeader('Content-Type', failed ? 'text/plain' : 'image/png');
    res.end(status === 304 ? undefined : failed ? 'not found' : fixture.body);
    return;
  }
  if (!url.pathname.startsWith('/__stats-image-fix/')) return next();
  const mode = url.pathname.split('/').at(-1);
  const coverOrigin = `http://localhost:${server.httpServer.address().port}`;
  const module = mode === 'csp' ? `
    import CoverImg from '/src/components/CoverImg.tsx';
    function Harness() {
      const [mounted, setMounted] = React.useState(true); window.mountCover = setMounted;
      return mounted ? React.createElement(CoverImg, { src: '${coverOrigin}/__stats-image-fix-cover/csp/music/0.png?thumb=stats&h=72&v=fixture-v1', width: 72, height: 72,
        onLoad: () => window.audit.loads++, onError: () => window.audit.errors++ }) : null;
    }
  ` : `
    import StatsSurface from '/src/components/StatsSurface.tsx';
    import { useAppStore } from '/src/store/index.ts';
    import { startStatsRefresh } from '/src/utils/statsRefresh.ts';
    import { usePresentedView } from '/src/utils/usePresentedView.ts';
    import '/src/index.css';
    window.store = useAppStore;
    function Harness() {
      const view = usePresentedView(useAppStore((s) => s.activeView));
      React.useEffect(() => { void useAppStore.getState().loadStats(); return startStatsRefresh(); }, []);
      return React.createElement('main', { style: { height: '900px', position: 'relative' } }, React.createElement(StatsSurface, { active: view === 'stats' }));
    }
  `;
  const html = await server.transformIndexHtml(url.pathname, `<html class="dark"><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module">
    import React from 'react'; import ReactDOM from 'react-dom/client'; ${module}
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(Harness)));
  </script></body></html>`);
  res.setHeader('Content-Type', 'text/html'); res.setHeader('Content-Security-Policy', cspFor(html)); res.end(html);
});

async function initialize(page, mode) {
  await page.addInitScript(({ mode, counts }) => {
    const ids = new WeakMap(); let next = 0;
    const identity = (node) => { if (!ids.has(node)) ids.set(node, ++next); return ids.get(node); };
    window.audit = { statsCalls: 0, fetches: [], animationStarts: [], loads: 0, errors: 0, violations: [] };
    const fetch = window.fetch;
    window.fetch = function (...args) { if (String(args[0]).includes('/__stats-image-fix-cover/')) window.audit.fetches.push(String(args[0])); return fetch.apply(this, args); };
    document.addEventListener('securitypolicyviolation', (e) => window.audit.violations.push({ directive: e.effectiveDirective, blockedURI: e.blockedURI }));
    document.addEventListener('animationstart', (e) => { if (e.animationName === 'stats-row-enter') window.audit.animationStarts.push(e.animationName); });
    window.describeImages = () => [...document.querySelectorAll('img[data-stats-image]')].map((img) => {
      const row = img.closest('.stats-row');
      let pixel = null;
      if (img.complete && img.naturalWidth > 0) { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0); pixel = [...ctx.getImageData(0, 0, 1, 1).data]; }
      return { anchor: row?.dataset.statCover, rowId: identity(row), imageId: identity(img), source: img.dataset.coverSource, src: img.getAttribute('src'), status: img.dataset.coverStatus, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, complete: img.complete, visibility: getComputedStyle(img).visibility, pixel };
    });
    const media = (key) => ({ total_seconds: 10000, play_count: 10, library_count: counts[key], played_count: counts[key], total_episodes: 0, total_watched_episodes: 0,
      top: Array.from({ length: counts[key] }, (_, i) => { const path = '/__stats-image-fix-cover/' + mode + '/' + key + '/' + i + '.png'; return { id: key + '-' + i, name: key + ' ' + i, sub: '', seconds: 10000 - i, count: 1, cover_path: path, wide_path: key === 'music' ? '' : path, cover_version: 'fixture-v1' }; }) });
    let callback = 0;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      convertFileSrc: (path) => new URL(path, 'http://localhost:' + location.port).href,
      transformCallback: () => ++callback, unregisterCallback() {},
      invoke: async (command) => { if (command === 'get_stats') { window.audit.statsCalls++; return { game: media('game'), video: media('video'), music: media('music') }; } if (command === 'plugin:event|listen') return ++callback; if (command === 'plugin:event|unlisten') return; throw new Error('Unexpected IPC: ' + command); },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  }, { mode, counts });
}
const twoFrames = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
async function scroll(page, offset) {
  await page.locator('.stats-col-rows').evaluateAll((cols, value) => { for (const col of cols) col.scrollTop = value; }, offset);
  await page.waitForFunction((offset) => [...document.querySelectorAll('.stats-col')].every((col) => {
    const index = Number(col.querySelector('.stats-row')?.dataset.statCover.split('-').at(-1));
    const actual = col.querySelector('.stats-col-rows').scrollTop;
    return offset === 0 ? index === 0 : Math.abs(index - Math.max(0, Math.floor(actual / 94) - 3)) <= 2;
  }), offset);
  await twoFrames(page);
}
async function waitImages(page) {
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('img[data-stats-image]')];
    return images.length > 0 && images.every((img) => img.dataset.coverStatus === 'error' || (img.complete && img.naturalWidth > 0 && img.dataset.coverStatus === 'ready' && getComputedStyle(img).visibility !== 'hidden'));
  }, null, { timeout: 15000 });
  await twoFrames(page);
}
const snapshot = (page) => page.evaluate(() => ({ images: window.describeImages(), audit: structuredClone(window.audit), rowCount: document.querySelectorAll('.stats-row').length, unavailable: window.store.getState().statsPresentation?.unavailableCovers.size }));
function verifyImages(images, height) {
  for (const image of images.filter((image) => image.status !== 'error')) {
    assert.ok(image.src?.startsWith('blob:'), 'successful cover must use its cached blob');
    const source = new URL(image.source);
    assert.equal(source.searchParams.get('thumb'), 'stats'); assert.equal(source.searchParams.get('h'), String(height));
    assert.equal(source.searchParams.get('v'), 'fixture-v1');
    assert.equal(image.naturalHeight, height); assert.equal(image.status, 'ready'); assert.notEqual(image.visibility, 'hidden');
  }
}
const summary = (mode) => { const list = requests.filter((r) => r.mode === mode); return { total: list.length, uniqueUrls: new Set(list.map((r) => r.url)).size, status404: list.filter((r) => r.status === 404).length, bodyBytes: list.reduce((sum, r) => sum + r.bodyBytes, 0), aborted: list.filter((r) => r.aborted).length }; };

let browser;
let activePage;
try {
  await mkdir(outputDir, { recursive: true }); await server.listen();
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true }); report.environment.browser = browser.version();
  for (const mode of requested) {
    const dpr = mode === 'actual_dpr2' ? 2 : 1;
    const page = activePage = await browser.newPage({ viewport: report.environment.viewport, deviceScaleFactor: dpr });
    const pageErrors = []; page.on('pageerror', (error) => pageErrors.push(error.message));
    await initialize(page, mode);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__stats-image-fix/${mode}`);
    if (mode === 'csp') {
      await page.waitForFunction(() => window.audit.loads === 1);
      for (let i = 0; i < 2; i++) { await page.evaluate(() => window.mountCover(false)); await page.waitForSelector('img', { state: 'detached' }); await page.evaluate(() => window.mountCover(true)); await page.waitForFunction((expected) => window.audit.loads === expected, i + 2); }
      const result = await page.evaluate(() => ({ ...window.audit, src: document.querySelector('img').src, naturalHeight: document.querySelector('img').naturalHeight }));
      assert.equal(result.fetches.length, 1); assert.equal(summary(mode).total, 1); assert.equal(result.loads, 3); assert.equal(result.errors, 0); assert.deepEqual(result.violations, []); assert.ok(result.src.startsWith('blob:')); assert.deepEqual(pageErrors, []);
      report.scenarios.push({ mode, ...result, requests: summary(mode), pageErrors }); log({ mode, fetches: result.fetches.length, loads: result.loads, requests: summary(mode) });
      await page.close(); activePage = null; continue;
    }
    await page.waitForFunction(() => { const state = window.store?.getState(); return state?.statsPresentation?.stats === state?.stats && document.querySelectorAll('.stats-row').length > 0; });
    const timeoutPresentation = mode === 'slow' ? await snapshot(page) : undefined;
    await waitImages(page);
    const initial = await snapshot(page);
    assert.ok(initial.rowCount < 80, 'virtualization must remain active'); verifyImages(initial.images, 72 * dpr);
    await page.evaluate(() => window.store.getState().setActiveView('stats'));
    await page.waitForSelector('[data-stats-enter]');
    await page.locator('.stats-surface').evaluate(async (surface) => { await Promise.all(surface.getAnimations({ subtree: true }).map((animation) => animation.finished)); });
    const navigation = await snapshot(page);
    const visits = [];
    let middleRevisit;
    let versionUpdate;
    if (mode.startsWith('actual_')) {
      const maximum = await page.locator('.stats-col-rows').evaluateAll((cols) => Math.max(...cols.map((col) => col.scrollHeight - col.clientHeight)));
      for (let offset = 940; offset < maximum; offset += 940) { await scroll(page, offset); await waitImages(page); visits.push({ offset, ...(await snapshot(page)) }); }
      await scroll(page, maximum); await waitImages(page);
      assert.equal(summary(mode).uniqueUrls, 250, 'the complete list must be loaded before revisiting');
      assert.ok(summary(mode).bodyBytes < 32 * 1024 * 1024, 'the synthetic thumbnail working set must fit the current cache budget');
    }
    if (mode.startsWith('actual_') || mode === 'missing') {
      for (let trip = 0; trip < 3; trip++) { await scroll(page, 32000); await waitImages(page); assert.equal(await page.locator('[data-stat-cover="game-0"]').count(), 0); await scroll(page, 0); await waitImages(page); }
    }
    if (mode.startsWith('actual_')) {
      const previous = visits.find((visit) => visit.offset === 4700); assert.ok(previous);
      const requestStart = requests.length; const fetchStart = await page.evaluate(() => window.audit.fetches.length);
      await scroll(page, 4700); await waitImages(page);
      const revisited = await snapshot(page);
      middleRevisit = { offset: 4700, before: previous.images, after: revisited.images, requests: requests.slice(requestStart), fetchCalls: revisited.audit.fetches.length - fetchStart };
      assert.equal(middleRevisit.requests.length, 0, 'cached middle revisit must perform zero HTTP requests'); assert.equal(middleRevisit.fetchCalls, 0);
      assert.deepEqual(revisited.images.map((image) => image.source), previous.images.map((image) => image.source));
      assert.deepEqual(revisited.images.map((image) => image.src), previous.images.map((image) => image.src)); verifyImages(revisited.images, 72 * dpr);
      for (const media of ['game', 'video', 'music']) {
        const oldImage = previous.images.find((image) => image.anchor.startsWith(media + '-'));
        const newImage = revisited.images.find((image) => image.anchor === oldImage.anchor);
        if (media === 'video') assert.equal(newImage.imageId, oldImage.imageId, 'six video rows remain resident');
        else assert.notEqual(newImage.imageId, oldImage.imageId, 'long columns must recreate their offscreen image nodes');
      }
      const before = revisited.images.find((image) => image.anchor === 'game-47'); assert.ok(before);
      await page.evaluate(() => { const stats = window.store.getState().stats; const top = stats.game.top.map((entry, index) => index === 47 ? { ...entry, cover_version: 'fixture-v2' } : entry); window.store.setState({ stats: { ...stats, game: { ...stats.game, top } } }); });
      await page.waitForFunction(() => { const image = document.querySelector('[data-stat-cover="game-47"] img'); return image?.dataset.coverSource?.includes('fixture-v2') && image.dataset.coverStatus === 'ready' && image.complete && image.naturalWidth > 0; });
      await waitImages(page);
      const after = (await snapshot(page)).images.find((image) => image.anchor === 'game-47');
      assert.equal(after.rowId, before.rowId, 'the same logical row remains mounted'); assert.notEqual(after.src, before.src); assert.notDeepEqual(after.pixel, before.pixel, 'the decoded image must actually change when only cover_version changes');
      versionUpdate = { before, after, requests: requests.filter((r) => r.mode === mode && r.version === 'fixture-v2') }; assert.equal(versionUpdate.requests.length, 1);
    }
    const final = await snapshot(page);
    assert.equal(final.audit.statsCalls, navigation.audit.statsCalls, 'scrolling or local version update must not issue stats IPC');
    assert.equal(final.audit.animationStarts.length, navigation.audit.animationStarts.length, 'scrolling must not replay the entrance');
    assert.deepEqual(final.audit.violations, []); assert.deepEqual(pageErrors, []);
    if (mode === 'slow') { assert.ok(timeoutPresentation.unavailable > 0, 'the 800ms delay must exceed the 400ms preparation deadline'); assert.equal(final.unavailable, 0, 'late success must repair committed unavailable state'); assert.ok(final.images.every((image) => image.status === 'ready' && image.visibility !== 'hidden')); }
    if (mode === 'missing') { for (const media of ['game', 'video', 'music']) assert.equal(requests.filter((r) => r.mode === mode && r.media === media && r.id === 0).length, 1, 'failed logical sources must not retry on each remount'); assert.equal(summary(mode).status404, 3); }
    const screenshot = `${outputStem}-${mode}.png`; await page.screenshot({ path: resolve(outputDir, screenshot) });
    report.scenarios.push({ mode, dpr, timeoutPresentation, initial, navigation, visitedOffsets: visits.map((visit) => visit.offset), middleRevisit, versionUpdate, final, requests: summary(mode), pageErrors, screenshot });
    log({ mode, dpr, middleRequests: middleRevisit?.requests.length, versionUpdated: Boolean(versionUpdate), statsQueriesDuringScroll: final.audit.statsCalls - navigation.audit.statsCalls, entranceReplays: final.audit.animationStarts.length - navigation.audit.animationStarts.length, unavailable: final.unavailable, requests: summary(mode) });
    await page.close(); activePage = null;
  }
  report.complete = true;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  if (activePage) { report.failure.pageUrl = activePage.url(); report.failure.snapshot = await snapshot(activePage).catch(() => null); await activePage.screenshot({ path: resolve(outputDir, outputStem + '-failure.png') }).catch(() => {}); }
  log({ failure: report.failure.message }); process.exitCode = 1;
} finally {
  await browser?.close(); await server.close();
  report.sourceHashesAfterRun = {};
  for (const path of Object.keys(report.sourceHashes)) report.sourceHashesAfterRun[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  report.sourceUnchangedDuringRun = Object.entries(report.sourceHashes).every(([path, hash]) => report.sourceHashesAfterRun[path] === hash);
  if (!report.sourceUnchangedDuringRun) { report.complete = false; report.failure ??= { message: 'Sources changed while the browser regression was running; rerun against a stable source snapshot.' }; process.exitCode = 1; }
  log({ complete: report.complete, scenarios: report.scenarios.length, sourceUnchangedDuringRun: report.sourceUnchangedDuringRun });
  await writeFile(resolve(outputDir, outputStem + '-results.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(outputDir, outputStem + '-requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(resolve(outputDir, outputStem + '.log'), lines.join('\n') + '\n');
}
