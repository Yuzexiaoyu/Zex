// Run with PLAYWRIGHT_MODULE pointing to Playwright's index.mjs when not installed locally.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = await createServer({ appType: 'custom', server: { port: 41784, strictPort: false, open: false } });
server.middlewares.use('/__stats-lifecycle', async (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(await server.transformIndexHtml('/__stats-lifecycle', `
    <html class="dark"><head><link rel="icon" href="data:,"></head><body><div id="root"></div>
    <script type="module">
      import React from 'react';
      import ReactDOM from 'react-dom/client';
      import StatsSurface from '/src/components/StatsSurface.tsx';
      import { useAppStore } from '/src/store/index.ts';
      import { startStatsRefresh } from '/src/utils/statsRefresh.ts';
      import { usePresentedView } from '/src/utils/usePresentedView.ts';
      import { restoreWindowAfterPaint } from '/src/utils/restoreWindow.ts';
      import { useFocusStore, setInputMode } from '/src/gamepad/index.ts';
      import '/src/index.css';
      window.store = useAppStore;
      window.focusStore = useFocusStore;
      window.setInputMode = setInputMode;
      window.restore = () => restoreWindowAfterPaint(() => {}, async () => {}, () => true);
      window.animationStarts = [];
      window.animationEnds = [];
      for (const [event, target] of [['animationstart', window.animationStarts], ['animationend', window.animationEnds]]) {
        document.addEventListener(event, (e) => {
          if (e.animationName === 'stats-enter' && e.target.classList.contains('stats-page')) target.push(e.target.className);
        });
      }
      function Harness() {
        const requested = useAppStore((s) => s.activeView);
        const view = usePresentedView(requested);
        React.useEffect(() => { void useAppStore.getState().loadStats(); return startStatsRefresh(); }, []);
        return React.createElement('main', { style: { height: '900px', position: 'relative' } },
          view !== 'stats' ? React.createElement('div', { 'data-previous-view': view, style: { height: '100%', background: '#304878' } }, view) : null,
          React.createElement(StatsSurface, { active: view === 'stats' }));
      }
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(Harness)));
    </script></body></html>`));
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const compositor = await page.context().newCDPSession(page);
  await compositor.send('Tracing.start', { categories: 'devtools.timeline', transferMode: 'ReturnAsStream' });
  let imageRequests = 0;
  await page.route('**/__stats-cover/**', async (route) => {
    imageRequests++;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="72"><rect width="128" height="72" fill="#0088bb"/></svg>' });
  });
  await page.addInitScript(() => {
    window.statsCalls = 0;
    window.revision = 0;
    window.decodes = 0;
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () { window.decodes++; return decode.call(this); };
    let callback = 0;
    const media = (key) => ({
      total_seconds: 10000, play_count: 10, library_count: 500, played_count: 500,
      total_episodes: 0, total_watched_episodes: 0,
      top: Array.from({ length: 500 }, (_, i) => ({
        id: key + '-' + i, name: key + ' ' + i, sub: '', seconds: 10000 - i, count: 1,
        cover_path: '/__stats-cover/' + key + '/' + i + '?revision=' + (i === 0 ? window.revision : 0), wide_path: '',
      })),
    });
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      convertFileSrc: (path) => new URL(path, window.location.origin).href,
      transformCallback: () => ++callback, unregisterCallback() {},
      invoke: async (command) => {
        if (command === 'get_stats') {
          window.statsCalls++;
          await new Promise((resolve) => setTimeout(resolve, 25));
          return { game: media('game'), video: media('video'), music: media('music') };
        }
        if (command === 'plugin:event|listen') return ++callback;
        if (command === 'plugin:event|unlisten') return;
        throw new Error('Unexpected IPC: ' + command);
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__stats-lifecycle`);
  await page.waitForFunction(() => document.querySelectorAll('.stats-col').length === 3 && document.querySelectorAll('.stats-row').length > 0);
  assert.ok(await page.locator('.stats-row').count() < 80, '1500 records must mount only viewport and overscan rows');
  await page.waitForFunction(() => {
    const firstImages = [...document.querySelectorAll('.stats-col')].map((col) => col.querySelector('img'));
    return firstImages.every((img) => img?.complete && img.naturalWidth > 0) && window.decodes >= 24;
  });
  await page.waitForFunction(() => { const s = window.store.getState(); return s.statsPresentation?.stats === s.stats && s.statsPresentation?.libraries === s.hiddenLibraries; });
  assert.equal(await page.locator('[data-stats-enter]').count(), 0, 'hidden startup must not play the entry animation');
  assert.equal(await page.evaluate(() => window.animationStarts.length), 0);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const { root } = await compositor.send('DOM.getDocument');
  const { nodeId } = await compositor.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.stats-page' });
  const { node } = await compositor.send('DOM.describeNode', { nodeId });
  const traceComplete = new Promise((resolve) => compositor.once('Tracing.tracingComplete', resolve));
  await compositor.send('Tracing.end');
  const { stream: backgroundStream } = await traceComplete;
  let backgroundTrace = '';
  while (true) { const chunk = await compositor.send('IO.read', { handle: backgroundStream }); backgroundTrace += chunk.data; if (chunk.eof) break; }
  await compositor.send('IO.close', { handle: backgroundStream });
  const paints = JSON.parse(backgroundTrace).traceEvents.filter((event) => event.name === 'Paint' && event.ph === 'X');
  const backgroundPainted = paints.some((event) => event.args?.data?.nodeId === node.backendNodeId);
  console.log(JSON.stringify({ backgroundPainted, pageBackendNode: node.backendNodeId, paintNodes: [...new Set(paints.map((event) => event.args?.data?.nodeId))] }));
  assert.ok(backgroundPainted, 'the statistics page must have a Paint record before the first entry');
  assert.equal(await page.locator('.stats-surface').evaluate((el) => getComputedStyle(el).opacity), '0');
  assert.equal(await page.locator('.stats-surface').evaluate((el) => el.inert), true);
  if (process.env.ZEX_STATS_PROFILE) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing,toplevel', transferMode: 'ReturnAsStream' });
    const samples = await page.evaluate(() => new Promise((resolve) => {
      const samples = [];
      const start = performance.now();
      performance.mark('stats-entry-click');
      window.store.getState().setActiveView('stats');
      const tick = () => {
        const animation = document.querySelector('.stats-page').getAnimations()[0];
        samples.push({ ms: performance.now() - start, animationTime: animation?.currentTime ?? null });
        if (performance.now() - start < 450) requestAnimationFrame(tick); else resolve(samples);
      };
      requestAnimationFrame(tick);
    }));
    const complete = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end');
    const { stream } = await complete;
    let raw = '';
    while (true) { const chunk = await cdp.send('IO.read', { handle: stream }); raw += chunk.data; if (chunk.eof) break; }
    await cdp.send('IO.close', { handle: stream });
    const events = JSON.parse(raw).traceEvents;
    const mark = events.find((event) => event.name === 'stats-entry-click');
    const afterClick = events.filter((event) => event.ts >= mark.ts && event.ts < mark.ts + 450000);
    const firstPaint = afterClick.find((event) => event.name === 'Paint' && event.ph === 'X');
    const report = {
      cpuThrottle: 4,
      mountedRows: await page.locator('.stats-row').count(),
      firstPaintCompletedMs: firstPaint ? (firstPaint.ts + firstPaint.dur - mark.ts) / 1000 : null,
      layoutMs: afterClick.filter((event) => event.name === 'Layout' && event.ph === 'X').reduce((sum, event) => sum + event.dur, 0) / 1000,
      paintMs: afterClick.filter((event) => event.name === 'Paint' && event.ph === 'X').reduce((sum, event) => sum + event.dur, 0) / 1000,
      firstAnimationFrame: samples[0],
      maxFrameGapMs: Math.max(...samples.map((sample, i) => sample.ms - (samples[i - 1]?.ms ?? 0))),
      samples,
    };
    await writeFile(process.env.ZEX_STATS_PROFILE, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ profile: process.env.ZEX_STATS_PROFILE, ...report, samples: undefined }));
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await page.evaluate(() => window.store.getState().setActiveView('games'));
    await page.waitForSelector('[data-stats-enter]', { state: 'detached' });
    await page.evaluate(() => { window.animationStarts.length = 0; window.animationEnds.length = 0; });
  }
  await page.evaluate(() => { window.originalRow = document.querySelector('.stats-row'); window.originalImage = window.originalRow.querySelector('img'); });
  const callsBeforeEntry = await page.evaluate(() => window.statsCalls);
  const requestsBeforeEntry = imageRequests;
  const decodesBeforeEntry = await page.evaluate(() => window.decodes);
  const enter = async () => {
    await page.evaluate(() => window.store.getState().setActiveView('stats'));
    await page.waitForSelector('[data-stats-enter]');
    assert.equal(await page.locator('.stats-placeholder').count(), 0);
    assert.equal(await page.locator('.stats-page').evaluate((el) => getComputedStyle(el).animationName), 'stats-enter');
    await page.waitForTimeout(380);
  };
  const leave = async () => {
    await page.evaluate(() => window.store.getState().setActiveView('games'));
    await page.waitForSelector('[data-stats-enter]', { state: 'detached' });
  };
  // 逐帧检查外框、文字、封面有效透明度，不能再出现外框已亮、列表仍透明的中间帧。
  const entryFrames = await page.evaluate(() => new Promise((resolve) => {
    const frames = [];
    const opacity = (element) => {
      if (!element) return 0;
      let result = 1;
      for (let node = element; node instanceof HTMLElement; node = node.parentElement) result *= Number(getComputedStyle(node).opacity);
      return result;
    };
    const start = performance.now();
    window.store.getState().setActiveView('stats');
    const sample = () => {
      frames.push({ ms: performance.now() - start, old: opacity(document.querySelector('[data-previous-view]')), panel: opacity(document.querySelector('.stats-col')), list: opacity(document.querySelector('.stats-col-rows')), cover: opacity(document.querySelector('.stats-row img')), transform: getComputedStyle(document.querySelector('.stats-page')).transform });
      if (performance.now() - start < 360) requestAnimationFrame(sample); else resolve(frames);
    };
    requestAnimationFrame(sample);
  }));
  assert.ok(entryFrames.every((frame) => Math.abs(frame.panel - frame.list) < 0.001 && Math.abs(frame.panel - frame.cover) < 0.001), 'the panel, list and covers must enter together in every sampled frame');
  assert.ok(entryFrames.every((frame) => Math.max(frame.old, frame.panel) >= 0.999), 'equal transparent panel/list/cover values must never pass the no-blank-frame check');
  assert.ok(entryFrames.some((frame) => frame.panel >= 0.999 && frame.transform !== 'none' && frame.transform !== 'matrix(1, 0, 0, 1, 0, 0)'), 'entry must animate its position while remaining opaque');
  await leave();

  await page.evaluate(() => { window.animationStarts.length = 0; window.animationEnds.length = 0; });
  for (let i = 0; i < 3; i++) { await enter(); await leave(); }
  assert.equal(await page.evaluate(() => window.animationEnds.length), 3, 'each entry must complete one whole-page animation');
  assert.ok(await page.evaluate(() => window.originalRow === document.querySelector('.stats-row') && window.originalImage === document.querySelector('.stats-row img')), 'navigation must retain row and cover DOM nodes');
  assert.equal(await page.evaluate(() => window.statsCalls), callsBeforeEntry, 'navigation must use resident statistics without querying');
  assert.equal(await page.evaluate(() => window.decodes), decodesBeforeEntry, 'navigation must reuse predecoded covers');
  assert.equal(imageRequests, requestsBeforeEntry, 'navigation must not reread covers');


  // 数据变化在隐藏状态合并刷新；每秒播放进度和导航不触发额外查询。
  await page.evaluate(() => {
    window.revision = 1;
    const store = window.store;
    store.setState({ games: [...store.getState().games] });
    store.setState({ series: [...store.getState().series] });
    store.setState({ tracks: [...store.getState().tracks] });
  });
  await page.waitForFunction((calls) => window.statsCalls === calls + 1, callsBeforeEntry);
  await page.waitForFunction(() => document.querySelector('.stats-row img').src.includes('revision=1') && document.querySelector('.stats-row img').complete);
  const refreshedCalls = await page.evaluate(() => window.statsCalls);
  await enter();
  const startsBeforeRefresh = await page.evaluate(() => window.animationStarts.length);
  await page.evaluate(async () => { await window.store.getState().loadStats(); });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.animationStarts.length), startsBeforeRefresh, 'data refresh must not replay the entry animation');

  await page.evaluate(() => window.store.setState({ nowPlaying: { trackId: 'music-0', playing: true, positionMs: 0 } }));
  await page.waitForFunction((calls) => window.statsCalls === calls + 1, refreshedCalls + 1);
  const playingCalls = await page.evaluate(() => window.statsCalls);
  await page.evaluate(() => {
    for (let positionMs = 1000; positionMs <= 10000; positionMs += 1000) {
      window.store.setState({ nowPlaying: { ...window.store.getState().nowPlaying, positionMs } });
    }
  });
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.statsCalls), playingCalls, 'per-second playback progress must not query statistics');

  await page.locator('.stats-col-rows').first().evaluate((el) => { el.scrollTop = 500; });
  await leave(); await enter();
  assert.ok(await page.locator('.stats-col-rows').first().evaluate((el) => el.scrollTop >= 499), 'resident columns must retain scroll position');
  await page.evaluate(() => {
    window.setInputMode('gamepad');
    window.focusStore.getState().reset('stats:col:game', 499);
  });
  await page.waitForSelector('[data-stat-cover="game-499"].stats-row-focus');
  assert.ok(await page.locator('[data-stat-cover="game-499"]').evaluate((row) => {
    const bounds = row.closest('.stats-col-rows').getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    return rect.top >= bounds.top && rect.bottom <= bounds.bottom + 1;
  }), 'gamepad must scroll to and mount the last of 500 rows');
  await page.evaluate(() => window.setInputMode('mouse'));
  await page.locator('[data-stat-cover="game-499"]').click({ button: 'right' });
  await page.locator('.context-menu-item').filter({ hasText: '调整时长' }).click();
  const modal = page.locator('[class~="z-[300]"]');
  await modal.waitFor();
  assert.ok(await modal.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return rect.top === 0 && rect.left === 0 && Math.abs(rect.height - window.innerHeight) < 1;
  }), 'pre-render layers must not change the fixed modal viewport');
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'detached' });
  await page.evaluate(() => window.store.setState({ hiddenLibraries: ['music'] }));
  await page.waitForFunction(() => document.querySelectorAll('.stats-col').length === 2);
  assert.ok(await page.locator('.stats-row').count() < 60);
  await leave();
  await page.evaluate(() => window.store.getState().setActiveView('stats'));
  await page.waitForSelector('[data-stats-enter]');
  await page.evaluate(async () => { await window.restore(); });
  assert.equal(await page.locator('.stats-page').evaluate((el) => el.getAnimations()[0].playState), 'finished', 'tray restore must finish existing entrance motion before showing the window');
  assert.equal(await page.locator('[data-skip-animations]').count(), 0);
  await leave(); await enter();
  assert.equal(await page.locator('.stats-page').evaluate((el) => getComputedStyle(el).animationName), 'stats-enter', 'restore cannot suppress later navigation');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ records: 1500, virtualized: true, hiddenStartupPredecoded: true, backgroundPainted, repeatedEntries: 3, completedEntryAnimations: 3, synchronizedFirstEntryFrames: entryFrames.length, gamepadLastRow: 499, modalViewportPreserved: true, navigationQueries: 0, navigationImageRequests: 0, navigationDecodes: 0, residentDomAndScroll: true, backgroundRefreshCoalesced: refreshedCalls === callsBeforeEntry + 1, refreshDoesNotReplay: true, playbackProgressQueries: 0, hiddenLibraryColumns: 2, trayRestoreFinishesAnimation: true, nextNavigationReplays: true, pageErrors: errors }));
} finally {
  await browser?.close();
  await server.close();
}
