// Diagnostic audit of the current statistics UI. Production sources are not transformed.
// PLAYWRIGHT_MODULE may point to an existing Playwright installation outside this project.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const outputDir = resolve('docs/verification');
const selectedModes = (process.env.ZEX_STATS_AUDIT_MODES || 'current,versioned,slow,missing,pressure').split(',').filter(Boolean);
const selectedCacheModes = (process.env.ZEX_STATS_AUDIT_CACHE_MODES ?? 'open,config,connect,all').split(',').filter(Boolean);
const outputStem = process.env.ZEX_STATS_AUDIT_OUTPUT || 'stats-scroll-audit';
const requests = [];
const report = {
  generatedAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  environment: { node: process.version, browser: '', httpCacheDisabled: false, requestInterception: false },
  sourceHashes: {},
  scope: 'Current React UI with mocked statistics IPC and HTTP responses matching covers cache headers; not the running installed WebView.',
  scenarios: [],
  requestedScenarios: selectedModes,
  requestedCacheScenarios: selectedCacheModes,
};
for (const path of ['src/views/StatsView.tsx', 'src/components/StatsCovers.tsx', 'src/utils/statsImages.ts', 'src/utils/statsPreload.ts', 'src/components/CoverImg.tsx', 'src-tauri/src/music.rs', 'src-tauri/tauri.conf.json', 'scripts/stats-lifecycle.test.mjs', 'scripts/stats-scroll-audit.mjs']) {
  report.sourceHashes[path] = createHash('sha256').update(await readFile(path)).digest('hex');
}

// Deterministic raster fixtures, rather than SVGs that omit bitmap decoding costs.
function png(width, height) {
  const crc = (bytes) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const content = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(content));
    return Buffer.concat([length, content, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (1 + width * 3) + 1 + x * 3;
      pixels[offset] = (x * 3 + y) & 255;
      pixels[offset + 1] = (x + y * 2) & 255;
      pixels[offset + 2] = (x ^ y) & 255;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const fixtures = { game: png(600, 300), video: png(1280, 720), music: png(256, 256) };
report.fixtures = Object.fromEntries(Object.entries(fixtures).map(([key, value]) => [key, { compressedBytes: value.length, sha256: createHash('sha256').update(value).digest('hex') }]));
let actualCounts;
let actualGameFixture;
if (selectedModes.includes('actual_shape')) {
  const shapeFile = 'scripts/fixtures/stats-library-shape.json';
  const shapeSource = await readFile(shapeFile);
  actualCounts = JSON.parse(shapeSource);
  actualGameFixture = png(1920, 620);
  report.actualShapeReference = { file: shapeFile, sha256: createHash('sha256').update(shapeSource).digest('hex'), counts: actualCounts, gameFixtureDimensions: [1920, 620], syntheticPixels: true };
}
const productionCsp = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).app.security.csp;

const server = await createServer({ appType: 'custom', server: { port: 41785, strictPort: false, open: false } });
server.middlewares.use(async (req, res, next) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/__stats-scroll-cover/')) {
    const [, , mode, media, filename] = url.pathname.split('/');
    const id = Number(filename.replace('.png', ''));
    const bytes = mode === 'actual_shape' && media === 'game' ? actualGameFixture : fixtures[media];
    const etag = '"' + mode + '-' + media + '-' + id + '"';
    const failed = mode === 'missing' && id === 0;
    const status = failed ? 404 : req.headers['if-none-match'] === etag ? 304 : 200;
    const record = { mode, media, id, url: req.url, ifNoneMatch: req.headers['if-none-match'] ?? null, status, bodyBytes: status === 200 ? bytes.length : 0, aborted: false };
    requests.push(record);
    res.on('close', () => { if (!res.writableFinished) record.aborted = true; });
    if (mode === 'slow') await new Promise((done) => setTimeout(done, 800));
    if (res.destroyed) return;
    res.statusCode = status;
    if (!failed) {
      res.setHeader('Cache-Control', url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'public, no-cache');
      res.setHeader('ETag', etag);
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Content-Type', failed ? 'text/plain' : 'image/png');
    res.end(status === 304 ? undefined : failed ? 'not found' : bytes);
    return;
  }
  if (url.pathname.startsWith('/__stats-cache-audit/')) {
    // A unique HTML path prevents Vite's inline-module proxy from sharing different fixtures.
    const mode = url.pathname.split('/').at(-1);
    const imageOrigin = 'http://localhost:' + server.httpServer.address().port;
    const html = await server.transformIndexHtml(url.pathname, `
      <html><head><link rel="icon" href="data:,"></head><body><div id="root"></div>
      <script type="module">
        import React from 'react';
        import ReactDOM from 'react-dom/client';
        import CoverImg from '/src/components/CoverImg.tsx';
        function Harness() {
          const [mounted, setMounted] = React.useState(true);
          window.mountCover = setMounted;
          return mounted ? React.createElement(CoverImg, {
            src: '${imageOrigin}/__stats-scroll-cover/cache_${mode}/music/0.png',
            width: 72, height: 72,
            onLoad: () => window.cacheAudit.loads++, onError: () => window.cacheAudit.errors++,
          }) : null;
        }
        ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
      </script></body></html>`);
    if (mode !== 'open') {
      // Only translate the covers origin and permit fixture scripts. Image/fetch directives
      // otherwise remain those in the checked-in release configuration.
      let csp = productionCsp.replaceAll('http://covers.localhost', imageOrigin);
      if (mode === 'connect' || mode === 'all') csp = csp.replace('connect-src ', 'connect-src ' + imageOrigin + ' ');
      if (mode === 'all') csp = csp.replace('img-src ', 'img-src blob: ');
      const hashes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].filter((match) => match[1].trim()).map((match) => "'sha256-" + createHash('sha256').update(match[1]).digest('base64') + "'");
      csp += "; script-src 'self' " + hashes.join(' ');
      res.setHeader('Content-Security-Policy', csp);
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(html);
    return;
  }
  if (url.pathname !== '/__stats-scroll-audit') return next();
  res.setHeader('Content-Type', 'text/html');
  res.end(await server.transformIndexHtml(url.pathname, `
    <html class="dark"><head><link rel="icon" href="data:,"></head><body><div id="root"></div>
    <script type="module">
      import React from 'react';
      import ReactDOM from 'react-dom/client';
      import StatsSurface from '/src/components/StatsSurface.tsx';
      import { useAppStore } from '/src/store/index.ts';
      import { startStatsRefresh } from '/src/utils/statsRefresh.ts';
      import { usePresentedView } from '/src/utils/usePresentedView.ts';
      import '/src/index.css';
      window.store = useAppStore;
      function Harness() {
        const requested = useAppStore((s) => s.activeView);
        const view = usePresentedView(requested);
        React.useEffect(() => { void useAppStore.getState().loadStats(); return startStatsRefresh(); }, []);
        return React.createElement('main', { style: { height: '900px', position: 'relative' } },
          React.createElement(StatsSurface, { active: view === 'stats' }));
      }
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(Harness)));
    </script></body></html>`));
});

async function initPage(page, mode, counts) {
  await page.addInitScript(({ mode, counts }) => {
    const ids = new WeakMap();
    let nextId = 0;
    const identity = (element) => { if (!ids.has(element)) ids.set(element, ++nextId); return ids.get(element); };
    window.audit = { statsCalls: 0, explicitDecodeCalls: 0, mounts: [], removals: [], loads: [], errors: [], srcChanges: [], animationStarts: [] };
    window.describeFirstImages = () => [...document.querySelectorAll('.stats-col')].map((col) => {
      const row = col.querySelector('.stats-row');
      const img = row?.querySelector('img');
      return { anchor: row?.dataset.statCover, imageId: img ? identity(img) : null, src: img?.src, complete: img?.complete, naturalWidth: img?.naturalWidth, visibility: img ? getComputedStyle(img).visibility : null };
    });
    const imageInfo = (img) => ({ anchor: img.closest('.stats-row')?.dataset.statCover, imageId: identity(img), src: img.getAttribute('src'), ms: performance.now() });
    const images = (node) => node instanceof Element ? [...(node.matches('img[data-stats-image]') ? [node] : []), ...node.querySelectorAll('img[data-stats-image]')] : [];
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') { window.audit.srcChanges.push(imageInfo(mutation.target)); continue; }
        for (const node of mutation.addedNodes) for (const img of images(node)) window.audit.mounts.push(imageInfo(img));
        for (const node of mutation.removedNodes) for (const img of images(node)) window.audit.removals.push(imageInfo(img));
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
    document.addEventListener('load', (e) => { if (e.target.matches?.('img[data-stats-image]')) window.audit.loads.push(imageInfo(e.target)); }, true);
    document.addEventListener('error', (e) => { if (e.target.matches?.('img[data-stats-image]')) window.audit.errors.push(imageInfo(e.target)); }, true);
    document.addEventListener('animationstart', (e) => { if (e.animationName === 'stats-row-enter') window.audit.animationStarts.push(e.animationName); });
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () { window.audit.explicitDecodeCalls++; return decode.call(this); };
    const media = (key) => ({
      total_seconds: 10000, play_count: 10, library_count: counts?.[key] ?? 500, played_count: counts?.[key] ?? 500,
      total_episodes: 0, total_watched_episodes: 0,
      top: Array.from({ length: counts?.[key] ?? 500 }, (_, i) => {
        const path = '/__stats-scroll-cover/' + mode + '/' + key + '/' + i + '.png' + (mode === 'versioned' ? '?v=fixture1' : '');
        return { id: key + '-' + i, name: key + ' ' + i, sub: '', seconds: 10000 - i, count: 1, cover_path: path, wide_path: key === 'music' ? '' : path };
      }),
    });
    let callback = 0;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      convertFileSrc: (path) => new URL(path, location.origin).href,
      transformCallback: () => ++callback, unregisterCallback() {},
      invoke: async (command) => {
        if (command === 'get_stats') { window.audit.statsCalls++; return { game: media('game'), video: media('video'), music: media('music') }; }
        if (command === 'plugin:event|listen') return ++callback;
        if (command === 'plugin:event|unlisten') return;
        throw new Error('Unexpected IPC: ' + command);
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  }, { mode, counts });
}
const waitForImages = (page) => page.waitForFunction(() => {
  const images = [...document.querySelectorAll('img[data-stats-image]')];
  return images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0);
});
const twoFrames = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const scroll = async (page, offset) => {
  await page.locator('.stats-col-rows').evaluateAll((cols, value) => { for (const col of cols) col.scrollTop = value; }, offset);
  await page.waitForFunction((offset) => [...document.querySelectorAll('.stats-col')].every((col) => {
    const index = Number(col.querySelector('.stats-row')?.dataset.statCover.split('-').at(-1));
    const actualOffset = col.querySelector('.stats-col-rows').scrollTop;
    return offset === 0 ? index === 0 : Math.abs(index - Math.max(0, Math.floor(actualOffset / 94) - 3)) <= 2;
  }), offset);
  await twoFrames(page);
};
function requestSummary(mode) {
  const list = requests.filter((request) => request.mode === mode);
  const byUrl = new Map();
  for (const request of list) byUrl.set(request.url, (byUrl.get(request.url) ?? 0) + 1);
  return { total: list.length, uniqueUrls: byUrl.size, repeatedRequests: list.length - byUrl.size, status200: list.filter((r) => r.status === 200).length, status304: list.filter((r) => r.status === 304).length, status404: list.filter((r) => r.status === 404).length, aborted: list.filter((r) => r.aborted).length, firstCovers: list.filter((r) => r.id === 0) };
}

let browser;
try {
  await mkdir(outputDir, { recursive: true });
  await server.listen();
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  report.environment.browser = browser.version();
  for (const mode of selectedModes) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await initPage(page, mode, mode === 'actual_shape' ? actualCounts : undefined);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__stats-scroll-audit?mode=${mode}`);
    await page.waitForFunction(() => { const s = window.store?.getState(); return s?.statsPresentation?.stats === s?.stats && document.querySelectorAll('.stats-row').length > 0; });
    await waitForImages(page);
    const initial = await page.evaluate(() => { window.initialStats = window.store.getState().stats; return { firstImages: window.describeFirstImages(), audit: structuredClone(window.audit), rows: document.querySelectorAll('.stats-row').length, unavailable: window.store.getState().statsPresentation.unavailableCovers.size }; });
    assert.ok(initial.rows < 80, 'the actual UI must retain virtualization');
    const requestsBeforeNavigation = requests.filter((r) => r.mode === mode).length;
    await page.evaluate(() => window.store.getState().setActiveView('stats'));
    await page.waitForSelector('[data-stats-enter]');
    await page.locator('.stats-surface').evaluate(async (surface) => { await Promise.all(surface.getAnimations({ subtree: true }).map((animation) => animation.finished)); });
    const navigation = await page.evaluate(() => ({ firstImages: window.describeFirstImages(), audit: structuredClone(window.audit) }));
    assert.deepEqual(navigation.firstImages.map((i) => i.imageId), initial.firstImages.map((i) => i.imageId), 'navigation must keep the first image nodes');
    const navigationRequests = requests.filter((r) => r.mode === mode).length - requestsBeforeNavigation;
    await page.locator('.stats-col-rows').evaluateAll((cols) => { for (const col of cols) col.scrollTop = 188; });
    await twoFrames(page);
    const nearFirstImages = await page.evaluate(() => ['game', 'video', 'music'].map((media) => !!document.querySelector('[data-stat-cover="' + media + '-0"] img')));
    assert.deepEqual(nearFirstImages, [mode !== 'missing', mode !== 'missing', mode !== 'missing']);
    await scroll(page, 0);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing', transferMode: 'ReturnAsStream' });
    const pressureStops = [];
    const pressureSnapshots = [];
    if (mode === 'pressure') {
      for (let offset = 2000; offset <= 44000; offset += 2800) {
        await scroll(page, offset);
        await waitForImages(page);
        pressureStops.push(offset);
        pressureSnapshots.push({ offset, firstImages: await page.evaluate(() => window.describeFirstImages()) });
      }
    } else if (mode === 'actual_shape') {
      const maxOffset = await page.locator('.stats-col-rows').evaluateAll((cols) => Math.max(...cols.map((col) => col.scrollHeight - col.clientHeight)));
      for (let offset = 940; offset < maxOffset; offset += 940) {
        await scroll(page, offset);
        await waitForImages(page);
        pressureStops.push(offset);
        pressureSnapshots.push({ offset, firstImages: await page.evaluate(() => window.describeFirstImages()) });
      }
      await scroll(page, maxOffset);
      await waitForImages(page);
      pressureStops.push(maxOffset);
      pressureSnapshots.push({ offset: maxOffset, firstImages: await page.evaluate(() => window.describeFirstImages()) });
    }
    const trips = [];
    for (let trip = 0; trip < 3; trip++) {
      await page.evaluate((trip) => performance.mark('audit-down-start-' + trip), trip);
      await scroll(page, 32000);
      await waitForImages(page);
      assert.equal(await page.locator('[data-stat-cover="game-0"]').count(), 0, 'scrolling beyond overscan must really unmount the original row');
      const firstRowUnmounted = await page.evaluate(() => ['game', 'video', 'music'].map((media) => !document.querySelector('[data-stat-cover="' + media + '-0"]')));
      await page.evaluate((trip) => performance.mark('audit-down-end-' + trip), trip);
      const returnFrames = await page.evaluate((trip) => new Promise((done) => {
        performance.mark('audit-return-start-' + trip);
        const start = performance.now();
        const frames = [];
        for (const col of document.querySelectorAll('.stats-col-rows')) col.scrollTop = 0;
        const sample = () => {
          const columns = [...document.querySelectorAll('.stats-col-rows')].map((col) => {
            const bounds = col.getBoundingClientRect();
            const rows = [...col.querySelectorAll('.stats-row')].filter((row) => { const rect = row.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom; });
            return { visibleRows: rows.length, readyImages: rows.filter((row) => { const img = row.querySelector('img'); return img?.complete && img.naturalWidth > 0; }).length, coverWidths: rows.map((row) => row.querySelector('.stats-row-cover').getBoundingClientRect().width) };
          });
          frames.push({ ms: performance.now() - start, columns });
          if (performance.now() - start < 180) requestAnimationFrame(sample); else done(frames);
        };
        requestAnimationFrame(sample);
      }), trip);
      await scroll(page, 0);
      await waitForImages(page);
      await page.evaluate((trip) => performance.mark('audit-return-end-' + trip), trip);
      trips.push({ ...await page.evaluate(() => ({ firstImages: window.describeFirstImages(), statsUnchanged: window.initialStats === window.store.getState().stats, explicitDecodeCalls: window.audit.explicitDecodeCalls, rows: document.querySelectorAll('.stats-row').length })), firstRowUnmounted, returnFrames });
    }
    let middleRevisit;
    const middleOffset = mode === 'pressure' ? 4800 : mode === 'actual_shape' ? 4700 : null;
    if (middleOffset !== null) {
      const previouslyVisited = pressureSnapshots.find((snapshot) => snapshot.offset === middleOffset);
      assert.ok(previouslyVisited, 'the middle viewport must have been visited before this measurement');
      const requestStart = requests.length;
      const alreadyRequested = new Set(requests.filter((request) => request.mode === mode).map((request) => request.url));
      await page.evaluate(() => performance.mark('audit-middle-start'));
      await scroll(page, middleOffset);
      await waitForImages(page);
      await page.evaluate(() => performance.mark('audit-middle-end'));
      const firstImages = await page.evaluate(() => window.describeFirstImages());
      assert.deepEqual(firstImages.map((image) => image.src), previouslyVisited.firstImages.map((image) => image.src), 'revisit must use exactly the previously loaded logical image URLs');
      const imageRequests = requests.slice(requestStart).filter((request) => request.mode === mode);
      middleRevisit = {
        offset: middleOffset, previouslyVisited, firstImages,
        freshImageNodes: firstImages.map((image, column) => image.imageId !== previouslyVisited.firstImages[column].imageId),
        requests: imageRequests,
        repeatedRequests: imageRequests.filter((request) => alreadyRequested.has(request.url)).length,
      };
    }
    const completed = new Promise((done) => cdp.once('Tracing.tracingComplete', done));
    await cdp.send('Tracing.end');
    const { stream } = await completed;
    let trace = '';
    while (true) { const chunk = await cdp.send('IO.read', { handle: stream }); trace += chunk.data; if (chunk.eof) break; }
    await cdp.send('IO.close', { handle: stream });
    const events = JSON.parse(trace).traceEvents;
    const decodeEvents = events.filter((event) => /decode/i.test(event.name));
    const decodeCounts = {};
    for (const event of decodeEvents) decodeCounts[event.name] = (decodeCounts[event.name] ?? 0) + 1;
    const phases = trips.map((_, trip) => Object.fromEntries(['down', 'return'].map((phase) => {
      const start = events.find((event) => event.name === 'audit-' + phase + '-start-' + trip);
      const end = events.find((event) => event.name === 'audit-' + phase + '-end-' + trip);
      assert.ok(start && end, 'trace must contain both phase markers');
      const counts = {};
      for (const event of decodeEvents.filter((event) => event.ts >= start.ts && event.ts <= end.ts)) counts[event.name] = (counts[event.name] ?? 0) + 1;
      return [phase, { durationMs: (end.ts - start.ts) / 1000, decodeEvents: counts }];
    })));
    if (middleRevisit) {
      const start = events.find((event) => event.name === 'audit-middle-start');
      const end = events.find((event) => event.name === 'audit-middle-end');
      assert.ok(start && end, 'the middle revisit must have trace markers');
      middleRevisit.decodeEvents = {};
      for (const event of decodeEvents.filter((event) => event.ts >= start.ts && event.ts <= end.ts)) middleRevisit.decodeEvents[event.name] = (middleRevisit.decodeEvents[event.name] ?? 0) + 1;
      middleRevisit.decodeTraceSamples = decodeEvents.filter((event) => event.name === 'Decode Image' && event.ts >= start.ts && event.ts <= end.ts).map((event) => ({ name: event.name, timestampUs: event.ts, durationUs: event.dur, args: event.args }));
      middleRevisit.durationMs = (end.ts - start.ts) / 1000;
    }
    const final = await page.evaluate(() => ({ firstImages: window.describeFirstImages(), audit: structuredClone(window.audit), unavailable: window.store.getState().statsPresentation.unavailableCovers.size }));
    assert.ok(trips.every((trip) => trip.statsUnchanged && trip.rows < 80));
    assert.ok(trips.every((trip, index) => trip.firstImages.every((image, col) => {
      if (mode === 'missing') return true;
      const previous = index === 0 ? initial.firstImages[col].imageId : trips[index - 1].firstImages[col].imageId;
      return trip.firstRowUnmounted[col] ? image.imageId !== previous : image.imageId === previous;
    })), 'unmounted rows create fresh images; resident rows retain their images');
    assert.equal(final.audit.statsCalls, initial.audit.statsCalls, 'scrolling must not query statistics');
    assert.equal(final.audit.explicitDecodeCalls, navigation.audit.explicitDecodeCalls, 'scrolling does not invoke the initial viewport preload decoder');
    assert.equal(final.audit.animationStarts.length, navigation.audit.animationStarts.length, 'scrolling must not replay the entrance');
    if (mode === 'slow') {
      assert.ok(initial.unavailable > 0);
      assert.equal(final.unavailable, initial.unavailable, 'late success does not repair the committed unavailable-cover set');
      assert.ok(final.firstImages.every((image) => image.complete && image.naturalWidth > 0 && image.visibility === 'hidden'), 'slow images stay hidden despite a successful load');
    }
    if (mode === 'missing') {
      for (const media of ['game', 'video', 'music']) assert.ok(requests.filter((request) => request.mode === mode && request.media === media && request.id === 0 && request.status === 404).length >= 2, 'failed cover requests are retried after row remount');
    }
    assert.deepEqual(pageErrors, []);
    const scenario = { mode, initial, navigationRequests, nearFirstImages, pressureStops, pressureSnapshots, trips, phases, middleRevisit, final, requests: requestSummary(mode), automaticDecodeTraceEvents: decodeCounts, traceDecodeDurationUs: decodeEvents.filter((event) => event.ph === 'X').reduce((sum, event) => sum + (event.dur ?? 0), 0), pageErrors };
    report.scenarios.push(scenario);
    console.log(JSON.stringify({ mode, rows: initial.rows, statsQueriesDuringScroll: final.audit.statsCalls - initial.audit.statsCalls, navigationRequests, remounts: final.audit.mounts.length - navigation.audit.mounts.length, imageLoadEventsDuringScroll: final.audit.loads.length - navigation.audit.loads.length, unavailableAfterSuccessfulLoad: final.unavailable, requests: { ...scenario.requests, firstCovers: undefined }, decodeTraceEvents: decodeCounts, returnDecodeEvents: phases.map((phase) => phase.return.decodeEvents), middleRevisit: middleRevisit ? { repeatedRequests: middleRevisit.repeatedRequests, decodeEvents: middleRevisit.decodeEvents, freshImageNodes: middleRevisit.freshImageNodes } : undefined }));
    await page.close();
  }
  report.cacheComponentScenarios = [];
  for (const mode of selectedCacheModes) {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      window.cacheAudit = { loads: 0, errors: 0, fetches: 0, violations: [] };
      const fetch = window.fetch;
      window.fetch = function (...args) { if (String(args[0]).includes('/__stats-scroll-cover/')) window.cacheAudit.fetches++; return fetch.apply(this, args); };
      document.addEventListener('securitypolicyviolation', (event) => window.cacheAudit.violations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI }));
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__stats-cache-audit/${mode}`);
    await page.waitForFunction(() => window.cacheAudit.loads + window.cacheAudit.errors > 0);
    for (let trip = 0; trip < 2; trip++) {
      await page.evaluate(() => window.mountCover(false));
      await page.waitForSelector('img', { state: 'detached' });
      await page.evaluate(() => window.mountCover(true));
      await page.waitForFunction((expected) => window.cacheAudit.loads + window.cacheAudit.errors >= expected, trip + 2);
    }
    const result = await page.evaluate(() => ({ ...window.cacheAudit, src: document.querySelector('img')?.getAttribute('src'), naturalWidth: document.querySelector('img')?.naturalWidth }));
    result.mode = mode;
    result.requests = requestSummary('cache_' + mode);
    result.pageErrors = pageErrors;
    assert.deepEqual(pageErrors, []);
    if (mode === 'open' || mode === 'all') { assert.equal(result.fetches, 1); assert.equal(result.naturalWidth, 256); assert.equal(result.requests.total, 1); assert.equal(result.errors, 0); }
    if (mode === 'config') { assert.equal(result.fetches, 3); assert.ok(result.violations.some((violation) => violation.directive === 'connect-src')); assert.equal(result.naturalWidth, 256); }
    if (mode === 'connect') { assert.equal(result.fetches, 1); assert.ok(result.violations.some((violation) => violation.directive === 'img-src' && violation.blockedURI === 'blob')); assert.equal(result.naturalWidth, 0); }
    report.cacheComponentScenarios.push(result);
    console.log(JSON.stringify({ cacheComponent: mode, fetches: result.fetches, requests: result.requests.total, loads: result.loads, errors: result.errors, violations: result.violations.map((v) => v.directive) }));
    await page.close();
  }
  report.complete = true;
} finally {
  await browser?.close();
  await server.close();
  await writeFile(resolve(outputDir, outputStem + '-results.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(outputDir, outputStem + '-requests.json'), JSON.stringify(requests, null, 2));
}
