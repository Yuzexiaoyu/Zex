// Run with Node and Playwright installed (or PLAYWRIGHT_MODULE pointing to its index.mjs).
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseline = process.env.ZEX_TEST_BASELINE === '1';
const server = await createServer({
  appType: 'custom',
  server: { port: 41783, strictPort: false, open: false },
  plugins: baseline ? [{
    name: 'reproduce-missing-grid-measurement',
    enforce: 'pre',
    transform(code, id) {
      if (id.replaceAll('\\', '/').endsWith('/src/components/GameGrid.tsx')) {
        return code.replace('[colCount, hasCards]', '[colCount]');
      }
    },
  }] : [],
});

server.middlewares.use('/__startup-animation-test', async (_req, res) => {
  const html = await server.transformIndexHtml('/__startup-animation-test', `
    <html class="dark"><head><link rel="icon" href="data:,"></head><body><div id="root" style="height:850px"></div>
    <script type="module">
      import React from 'react';
      import ReactDOM from 'react-dom/client';
      import GameGrid from '/src/components/GameGrid.tsx';
      import '/src/index.css';
      window.animationEnds = [];
      document.addEventListener('animationend', (event) => {
        if (event.animationName === 'card-enter' && event.target.classList.contains('game-card')) {
          window.animationEnds.push({ name: event.target.querySelector('.game-card-title')?.textContent, elapsed: event.elapsedTime });
        }
      });
      function Harness() {
        const [games, setGames] = React.useState([]);
        const [folders, setFolders] = React.useState([]);
        const [generation, setGeneration] = React.useState(0);
        window.loadGames = (options = {}) => {
          const cover = (i) => options.covers ? '/__startup-cover?delay=' + (options.delay || 0) + '&id=' + i + '&case=' + (options.case || '') + (options.broken ? '&broken=1' : '') : '';
          setGames(Array.from({ length: 40 }, (_, i) => ({
          id: 'test-' + i, name: 'Game ' + i, cover_path: cover(i), banner_path: '', bg_path: '',
          install_dir: '', exe_path: '', launch_args: '', env_vars: '', work_dir: '',
          notes: '', tags: '', favorite: false, hidden: false, total_seconds: 0,
          play_count: 0, created_at: '', updated_at: '', steam_appid: 0, slot: i,
          })));
          setFolders(options.folder ? [{ id: 'folder-1', name: 'Folder', game_ids: ['test-0', 'test-1', 'test-2'], slot: 0, cover_path: options.custom ? cover('custom') : '' }] : []);
          if (options.remount) setGeneration((value) => value + 1);
        };
        window.remount = () => setGeneration((value) => value + 1);
        return React.createElement(GameGrid, { key: generation, games, folders, columns: 8, onLaunch() {} });
      }
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(Harness)));
    </script></body></html>`);
  res.setHeader('Content-Type', 'text/html');
  res.end(html);
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  // 独立延迟每张图片，模拟本地 covers 协议；不引入 HTTP/1 六连接串行排队。
  await page.route('**/__startup-cover?**', async (route) => {
    const url = new URL(route.request().url());
    await new Promise((resolve) => setTimeout(resolve, Number(url.searchParams.get('delay') || 0)));
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: url.searchParams.has('broken') ? 'invalid image' : '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#0088bb"/></svg>',
    }).catch(() => {});
  });
  await page.addInitScript(() => {
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function () {
      await decode.call(this);
      if (this.src.includes('case=decode')) await new Promise((resolve) => setTimeout(resolve, 650));
    };
    let callbackId = 0;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => ++callbackId,
      unregisterCallback() {},
      convertFileSrc: (path) => new URL(path, window.location.origin).href,
      invoke: async (command) => {
        if (command === 'plugin:event|listen') return ++callbackId;
        if (command === 'plugin:event|unlisten') return;
        throw new Error('Unexpected test IPC: ' + command);
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  });
  const errors = [];
  page.on('pageerror', (error) => { errors.push(error.message); console.error(error.message); });
  page.on('console', (message) => { if (message.type() === 'error') console.error(message.text()); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__startup-animation-test`);
  await page.waitForFunction(() => typeof window.loadGames === 'function');
  assert.equal(await page.locator('.game-card').count(), 0);
  // 留出真实异步读库的空态阶段，复现冷启动 ref 尚未挂载的路径。
  await page.waitForTimeout(600);
  await page.evaluate(() => window.loadGames());
  await page.waitForSelector('.game-card', { state: 'attached' });
  const delays = () => page.locator('.game-card').evaluateAll((cards) => cards.slice(0, 8).map((card) => Number.parseFloat(card.style.animationDelay)));
  const expected = Array.from({ length: 8 }, (_, i) => i * 35);
  const cold = await delays();
  assert.deepEqual(cold, expected, 'cold startup must stagger cards like a library switch');
  await page.waitForTimeout(1400);
  const completed = await page.evaluate(() => window.animationEnds);
  assert.ok(completed.length >= 8, 'first row must finish its full animation');
  assert.ok(completed.every((event) => Math.abs(event.elapsed - 0.3) < 0.001));
  assert.equal(await page.locator('.game-card').first().evaluate((card) => getComputedStyle(card).opacity), '1');
  await page.evaluate(() => window.remount());
  await page.waitForTimeout(50);
  assert.deepEqual(await delays(), cold, 'warm remount and cold startup must use the same delays');
  await page.waitForTimeout(1400);
  await page.locator('.library-scroll').evaluate((grid) => { grid.scrollTop = 600; });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.game-card').first().evaluate((card) => getComputedStyle(card).animationName), 'none', 'scrolling must not replay the introduction');

  // 冷封面读盘慢于完整动画：就绪前整张卡不可见，动画时间保持暂停。
  await page.evaluate(() => window.loadGames({ covers: true, delay: 1100, case: 'slow', remount: true }));
  await page.waitForSelector('[data-grid-preparing]', { state: 'attached' });
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.game-grid').evaluate((grid) => getComputedStyle(grid).opacity), '0');
  assert.equal(await page.locator('.game-card').first().evaluate((card) => getComputedStyle(card).animationPlayState), 'paused');
  await page.waitForSelector('[data-grid-preparing]', { state: 'detached' });
  const visibleDecoded = await page.locator('.library-scroll').evaluate((grid) => {
    const bounds = grid.getBoundingClientRect();
    return [...grid.querySelectorAll('.game-card')].filter((card) => {
      const rect = card.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    }).every((card) => { const img = card.querySelector('img'); return img.complete && img.naturalWidth > 0; });
  });
  assert.ok(visibleDecoded, 'all visible covers must be decoded before revealing the frames');
  assert.deepEqual(await delays(), expected, 'waiting for covers must preserve stagger delays');

  // 字节加载完仍有解码延迟时，不能仅凭 complete / load 事件提前播放。
  await page.evaluate(() => window.loadGames({ covers: true, case: 'decode', remount: true }));
  await page.waitForSelector('[data-grid-preparing]', { state: 'attached' });
  await page.waitForTimeout(200);
  assert.ok(await page.locator('.game-card img').first().evaluate((img) => img.complete && img.naturalWidth > 0));
  assert.equal(await page.locator('.game-grid').evaluate((grid) => getComputedStyle(grid).opacity), '0', 'loaded bytes must still wait for decode to resolve');
  await page.waitForSelector('[data-grid-preparing]', { state: 'detached' });

  // 文件夹拼图与自定义封面走 CoverImg 的异步 blob src，不能被当成无图卡提前放行。
  for (const custom of [false, true]) {
    await page.evaluate((custom) => window.loadGames({ covers: true, folder: true, custom, delay: 500, case: 'folder-' + custom, remount: true }), custom);
    await page.waitForSelector('[data-grid-preparing]', { state: 'attached' });
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.game-grid').evaluate((grid) => getComputedStyle(grid).opacity), '0');
    await page.waitForSelector('[data-grid-preparing]', { state: 'detached' });
    assert.ok(await page.locator('.folder-card img').evaluateAll((images) => images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0 && img.src.startsWith('blob:'))), 'folder covers must use the loaded blob cache and decode before reveal');
  }

  await page.evaluate(() => window.loadGames({ covers: true, broken: true, case: 'broken', remount: true }));
  await page.waitForSelector('[data-grid-preparing]', { state: 'detached' });
  assert.equal(await page.locator('.game-grid').evaluate((grid) => getComputedStyle(grid).opacity), '1', 'missing covers must not leave a blank grid');

  await page.evaluate(() => window.loadGames({ covers: true, delay: 5000, case: 'timeout', remount: true }));
  await page.waitForSelector('[data-grid-preparing]', { state: 'attached' });
  const timeoutStart = Date.now();
  await page.waitForSelector('[data-grid-preparing]', { state: 'detached', timeout: 4000 });
  assert.ok(Date.now() - timeoutStart < 3500, 'a stalled cover must release the grid within the timeout');
  // 卸载慢图页面，旧预热回调不能污染随后无图的新页面。
  await page.evaluate(() => window.loadGames({ covers: true, delay: 500, case: 'unmount', remount: true }));
  await page.waitForSelector('[data-grid-preparing]', { state: 'attached' });
  await page.waitForTimeout(100);
  await page.evaluate(() => window.loadGames({ remount: true }));
  await page.waitForSelector('[data-grid-preparing]', { state: 'detached' });
  await page.waitForTimeout(800);
  assert.equal(await page.locator('[data-grid-preparing]').count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ coldDelaysMs: cold, fullDurationSeconds: 0.3, completedAnimations: completed.length, warmMatchesCold: true, scrollReplay: false, slowCoversWait: true, decodeWait: true, visibleDecoded, folderMosaicAndCustomBlobDecoded: true, missingCoverReleases: true, stalledCoverTimeout: true, unmountCleanup: true, pageErrors: errors }));
} finally {
  await browser?.close();
  await server.close();
}
