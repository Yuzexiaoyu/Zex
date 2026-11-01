// PLAYWRIGHT_MODULE can point to an existing Playwright installation outside this project.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const requests = [];
const server = await createServer({ appType: 'custom', server: { port: 41787, strictPort: false, open: false } });
server.middlewares.use(async (req, res, next) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/__cover-cache-img/')) {
    const directImage = req.headers['sec-fetch-dest'] === 'image';
    requests.push({ source: req.url, directImage });
    if (url.pathname.endsWith('/slow')) await new Promise((done) => setTimeout(done, 250));
    const missing = url.pathname.endsWith('/missing') && url.searchParams.get('v') !== '2';
    const fallback = url.pathname.endsWith('/fallback') && !directImage;
    res.statusCode = missing ? 404 : fallback ? 403 : 200;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'image/svg+xml');
    res.end(missing || fallback || url.pathname.endsWith('/corrupt') ? 'invalid image' : '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#0088bb"/></svg>');
    return;
  }
  if (url.pathname !== '/__cover-cache') { next(); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end(await server.transformIndexHtml('/__cover-cache', `
    <html><head><link rel="icon" href="data:,"></head><body><div id="root"></div>
    <script type="module">
      import React from 'react';
      import ReactDOM from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import CoverImg from '/src/components/CoverImg.tsx';
      const root = ReactDOM.createRoot(document.getElementById('root'));
      window.events = [];
      window.showCover = (source, failureMode = 'placeholder', copies = 1, fetchPriority = 'auto') => flushSync(() => root.render(
        React.createElement(React.StrictMode, null, Array.from({ length: copies }, (_, index) => React.createElement(CoverImg, {
          key: index, src: source, failureMode, fetchPriority,
          onLoad: () => window.events.push({ source, type: 'load' }),
          onError: () => window.events.push({ source, type: 'error' }),
        })))));
      window.hideCovers = () => flushSync(() => root.render(null));
    </script></body></html>`));
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__cover-cache`);
  await page.waitForFunction(() => typeof window.showCover === 'function');
  const source = (name) => `/__cover-cache-img/${name}`;
  const count = (name) => requests.filter((request) => request.source === source(name)).length;
  const show = (name, mode = 'placeholder', copies = 1) => page.evaluate(([source, mode, copies]) => window.showCover(source, mode, copies), [source(name), mode, copies]);
  const ready = (count = 1) => page.waitForFunction((count) => [...document.images].filter((image) => image.dataset.coverStatus === 'ready' && image.naturalWidth > 0).length === count, count);
  const error = () => page.waitForFunction(() => document.images.length === 1 && document.images[0].dataset.coverStatus === 'error' && !document.images[0].hasAttribute('src'));

  await show('initial', 'placeholder', 2);
  await ready(2);
  assert.equal(count('initial'), 1, 'two StrictMode mounts share one fetch');
  const initialBlob = await page.locator('img').first().getAttribute('src');
  const priorityChanges = await page.evaluate((source) => {
    const nodes = [...document.images];
    const blobs = nodes.map((image) => image.getAttribute('src'));
    return ['low', 'high', 'auto'].map((priority) => {
      window.showCover(source, 'placeholder', 2, priority);
      return [...document.images].every((image, index) => image === nodes[index]
        && image.getAttribute('src') === blobs[index]
        && image.dataset.coverStatus === 'ready'
        && image.fetchPriority === priority);
    });
  }, source('initial'));
  assert.deepEqual(priorityChanges, [true, true, true], 'priority changes must preserve ready status, DOM nodes and blob URLs');
  assert.equal(count('initial'), 1);
  const changed = await page.evaluate((source) => {
    window.showCover(source);
    const image = document.images[0];
    return { source: image.dataset.coverSource, status: image.dataset.coverStatus, src: image.getAttribute('src') };
  }, source('slow'));
  assert.deepEqual(changed, { source: source('slow'), status: 'loading', src: null }, 'src switch clears the prior blob in the same commit');
  await show('initial');
  await ready();
  assert.equal(await page.locator('img').getAttribute('src'), initialBlob);
  await page.waitForTimeout(350);
  assert.equal(await page.locator('img').getAttribute('src'), initialBlob, 'late old request must not replace the current cover');
  assert.equal(await page.evaluate((source) => window.events.filter((event) => event.source === source && event.type === 'load').length, source('slow')), 0);
  await show('slow');
  await ready();
  assert.notEqual(await page.locator('img').getAttribute('src'), initialBlob);
  assert.equal(count('slow'), 1, 'request completed after source change is reused');

  await show('missing');
  await error();
  for (let round = 0; round < 3; round++) {
    await page.evaluate(() => window.hideCovers());
    await show('missing');
    await error();
  }
  assert.equal(count('missing'), 1, '404 placeholder must not fall back to a second original-URL request');
  await show('missing?v=2');
  await ready();
  assert.equal(count('missing?v=2'), 1);

  await show('corrupt');
  await error();
  for (let round = 0; round < 3; round++) {
    await page.evaluate(() => window.hideCovers());
    await show('corrupt');
    await error();
  }
  assert.equal(count('corrupt'), 1, 'invalid fetched bytes also share the failure cache');
  await show('fallback', 'original');
  await ready();
  assert.equal(count('fallback'), 2, 'default mode retains original-URL fallback when fetch is rejected');
  const events = await page.evaluate(() => window.events);
  assert.ok(events.some((event) => event.source === source('corrupt') && event.type === 'error'));
  assert.ok(events.some((event) => event.source === source('fallback') && event.type === 'load'));
  await page.evaluate(() => window.showCover(''));
  assert.equal(await page.locator('img').getAttribute('src'), null);
  assert.equal(await page.locator('img').getAttribute('data-cover-source'), '');
  await show('initial');
  await ready();
  assert.equal(await page.locator('img').getAttribute('src'), initialBlob);
  assert.deepEqual(errors, []);
  const report = { complete: true, browser: browser.version(), requests, events, pageErrors: errors, scenarios: ['inflight StrictMode deduplication', 'priority changes preserve ready nodes and URLs', 'source changes and late completion', 'cache-hit source changes', 'three missing-cover remounts', 'version invalidation', 'corrupt image cooldown', 'original-URL fallback and events', 'empty source'] };
  if (process.env.COVER_CACHE_WRITE_REPORT !== '0') await writeFile('docs/verification/cover-cache-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
