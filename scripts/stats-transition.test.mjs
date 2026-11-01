// Code-driven integration tests; no native desktop automation.
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = await createServer({ appType: 'custom', server: { port: 41785, strictPort: false, open: false } });
server.middlewares.use('/__stats-transition', async (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(await server.transformIndexHtml('/__stats-transition', `
    <html class="dark"><head><link rel="icon" href="data:,"></head><body><div id="root"></div>
    <script type="module">
      import React from 'react';
      import ReactDOM from 'react-dom/client';
      import GameView from '/src/views/GameView.tsx';
      import StatsSurface from '/src/components/StatsSurface.tsx';
      import { usePresentedView } from '/src/utils/usePresentedView.ts';
      import { useAppStore } from '/src/store/index.ts';
      import { startStatsRefresh } from '/src/utils/statsRefresh.ts';
      import { restoreWindowAfterPaint } from '/src/utils/restoreWindow.ts';
      import '/src/index.css';
      window.store = useAppStore;
      window.restore = () => restoreWindowAfterPaint(() => {}, async () => { window.shows = (window.shows || 0) + 1; }, () => true);
      window.starts = 0;
      document.addEventListener('animationstart', (e) => { if (e.animationName === 'stats-enter') window.starts++; });
      function Harness() {
        const requested = useAppStore((s) => s.activeView);
        const view = usePresentedView(requested);
        React.useEffect(() => { void useAppStore.getState().loadStats().catch(() => {}); return startStatsRefresh(); }, []);
        return React.createElement(React.Fragment, null,
          React.createElement('nav', null, ['games','stats','music','series','settings'].map((id) =>
            React.createElement('button', { key: id, id: 'nav-' + id, onClick: () => useAppStore.getState().setActiveView(id) }, id))),
          React.createElement('main', { style: { position: 'relative', height: '850px' } },
            React.createElement('div', { className: 'h-full', 'data-presented-view': view, inert: requested !== view },
              view === 'games' ? React.createElement('div', { className: 'h-full', 'data-previous-view': 'games' }, React.createElement(GameView)) : null,
              view !== 'games' && view !== 'stats' ? React.createElement('div', { 'data-previous-view': view, style: { height:'100%', background:'#304878', color:'white' } }, view) : null,
              React.createElement(StatsSurface, { active: view === 'stats' }))));
      }
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(Harness)));
    </script></body></html>`));
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const base = `http://127.0.0.1:${server.httpServer.address().port}/__stats-transition`;
  const results = [];
  for (const scenario of ['warm', 'cold', 'cancel', 'slow', 'broken', 'archive', 'empty', 'error']) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 920 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/__previous-cover/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#4268ac"/></svg>' }));
    await page.route('**/__transition-cover/**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, scenario === 'slow' ? 1800 : 80));
      await route.fulfill({ contentType: 'image/svg+xml', body: scenario === 'broken' ? 'invalid image' : '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="72"><rect width="128" height="72" fill="#0088bb"/></svg>' }).catch(() => {});
    });
    await page.addInitScript((scenario) => {
      let callback = 0;
      const gate = ['cold','cancel'].includes(scenario) ? new Promise((resolve) => { window.releaseStats = resolve; }) : Promise.resolve();
      const games = Array.from({ length: 24 }, (_, i) => ({
        id:'previous-' + i, name:'Previous game ' + i, cover_path:'/__previous-cover/' + i,
        banner_path:'', bg_path:'', install_dir:'', exe_path:'', launch_args:'', env_vars:'', work_dir:'', notes:'', tags:'',
        favorite:false, hidden:false, total_seconds:0, play_count:0, created_at:'', updated_at:'', steam_appid:0, slot:i,
      }));
      const media = (key) => {
        const count = scenario === 'empty' || (scenario === 'archive' && key !== 'game') ? 0 : scenario === 'archive' ? 1 : 500;
        return {
          total_seconds:count ? 3600 : 0, play_count:0, library_count:scenario === 'archive' ? 0 : count, played_count:count,
          total_episodes:0, total_watched_episodes:0,
          top:Array.from({length:count}, (_,i) => ({ id:scenario === 'archive' ? 'game:app:TARGET' : key + '-' + i, name:key + ' ' + i,
            sub:'', seconds:3600-i, count:0, cover_path:'/__transition-cover/' + key + '/' + i, wide_path:'' })),
        };
      };
      window.__TAURI_INTERNALS__ = {
        metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
        convertFileSrc:(path) => new URL(path, location.origin).href,
        transformCallback:() => ++callback, unregisterCallback() {},
        invoke:async (command) => {
          if (command === 'get_stats') {
            await gate;
            if (scenario === 'error') throw new Error('Fixture statistics unavailable');
            return {game:media('game'),video:media('video'),music:media('music')};
          }
          if (command === 'get_all_games') return games;
          if (command === 'get_game_folders') return [];
          if (command === 'plugin:event|listen') return ++callback;
          if (command === 'plugin:event|unlisten') return;
          throw new Error('Unexpected IPC: ' + command);
        },
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener() {}};
    }, scenario);
    await page.goto(base);
    await page.waitForSelector('.game-card');
    await page.waitForSelector('[data-grid-preparing]', { state: 'detached' });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.game-card')).opacity === '1');
    if (scenario === 'cancel') {
      await page.evaluate(() => document.getElementById('nav-stats').click());
      await page.waitForFunction(() => window.store.getState().activeView === 'stats');
      assert.equal(await page.locator('[data-presented-view]').getAttribute('data-presented-view'), 'games');
      await page.evaluate(() => document.getElementById('nav-settings').click());
      await page.waitForSelector('[data-presented-view="settings"]');
      await page.evaluate(() => window.releaseStats());
      await page.waitForFunction(() => { const s=window.store.getState(); return s.statsPresentation?.stats === s.stats && s.statsPresentation?.libraries === s.hiddenLibraries; });
      assert.equal(await page.locator('[data-presented-view]').getAttribute('data-presented-view'), 'settings', 'late preparation cannot reopen a cancelled destination');
      assert.equal(await page.evaluate(() => window.starts), 0, 'cancelled navigation cannot consume the entrance animation');
    } else if (scenario !== 'cold' && scenario !== 'slow') {
      await page.waitForFunction(() => { const s=window.store.getState(); return s.statsPresentation?.stats === s.stats && s.statsPresentation?.libraries === s.hiddenLibraries; });
    }
    const frames = await page.evaluate((scenario) => new Promise((resolve) => {
      const frames = [];
      const opacity = (element) => {
        if (!element) return 0;
        let result = 1;
        for (let node=element;node instanceof HTMLElement;node=node.parentElement) {
          const style=getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') return 0;
          result *= Number(style.opacity);
        }
        return result;
      };
      const sample = () => {
        const surface = document.querySelector('.stats-surface');
        const incoming = document.querySelector('.stats-page') || document.querySelector('.stats-empty-enter') || surface;
        const coversReady = [...document.querySelectorAll('.stats-col-rows')].every((column) => {
          const bounds = column.getBoundingClientRect();
          return [...column.querySelectorAll('img[data-stats-image]')].every((image) => {
            const rect = image.closest('.stats-row').getBoundingClientRect();
            return rect.bottom <= bounds.top || rect.top >= Math.min(bounds.bottom, innerHeight)
              || getComputedStyle(image).visibility === 'hidden' || (image.complete && image.naturalWidth > 0);
          });
        });
        frames.push({old:opacity(document.querySelector('[data-previous-view]')), incoming:opacity(incoming), view:document.querySelector('[data-presented-view]').dataset.presentedView, coversReady});
        if (frames.at(-1).view === 'stats' && frames.length > 60) resolve(frames);
        else if (frames.length > 600) resolve(frames);
        else requestAnimationFrame(sample);
      };
      sample();
      document.getElementById('nav-stats').click();
      if (scenario === 'cold') setTimeout(() => window.releaseStats(), 160);
    }), scenario);
    assert.equal(frames.at(-1).view, 'stats', scenario + ': navigation must finish');
    assert.ok(frames.every((frame) => Math.max(frame.old, frame.incoming) >= 0.999), scenario + ': every frame needs an opaque old or incoming page');
    assert.ok(frames.filter((frame) => frame.view === 'stats').every((frame) => frame.coversReady), scenario + ': first visible frame must contain decoded covers or stable placeholders');
    if (scenario === 'cold') assert.ok(frames.filter((frame) => frame.view === 'games').length > 1, 'cold data must retain the real game library');
    if (!['empty','error'].includes(scenario)) {
      assert.equal(await page.locator('.stats-page').evaluate((el) => getComputedStyle(el).opacity), '1');
      assert.ok(await page.locator('.stats-row').count() > 0 && await page.locator('.stats-row').count() < 80);
    }
    if (scenario === 'archive') assert.equal(await page.locator('[data-stat-cover="game-0"]').count(), 1);
    if (scenario === 'slow') {
      const fallbackCount = await page.locator('.stats-row-cover-unavailable').count();
      assert.ok(fallbackCount > 0, 'timed-out covers must have a stable fallback');
      await page.waitForFunction(() => document.querySelectorAll('.stats-row-cover-unavailable').length === 0);
      assert.ok(await page.locator('img[data-stats-image]').evaluateAll((images) => images.every((image) => image.complete && image.naturalWidth > 0 && getComputedStyle(image).visibility === 'visible')), 'late success must replace temporary placeholders');
    }
    if (scenario === 'warm') {
      const readyState = await page.evaluate(() => {
        const state=window.store.getState();
        const old=state.stats;
        window.store.setState({stats:{...old}});
        window.store.getState().prepareStatsPresentation(old,state.hiddenLibraries);
        const current=window.store.getState();
        return current.statsPresentation.stats === current.stats;
      });
      assert.equal(readyState, false, 'an old decode callback cannot prepare new statistics');
      await page.evaluate(async () => { await window.restore(); });
      assert.equal(await page.locator('.stats-page').evaluate((el) => el.getAnimations()[0].playState), 'finished');
      assert.equal(await page.evaluate(() => document.querySelectorAll('[data-skip-animations]').length), 0, 'restore must not leave DOM suppression flags');
      await page.evaluate(() => document.getElementById('nav-games').click());
      await page.waitForSelector('[data-presented-view="games"]');
      await page.waitForFunction(() => document.querySelector('.stats-page').getAnimations().length === 0);
      await page.evaluate(() => document.getElementById('nav-stats').click());
      await page.waitForSelector('[data-presented-view="stats"]');
      await page.waitForFunction(() => window.starts >= 2);
    }
    if (scenario === 'error') assert.ok(await page.getByText('Fixture statistics unavailable', {exact:true}).count());
    assert.deepEqual(errors, []);
    results.push({scenario, sampledFrames:frames.length, blankFrames:frames.filter((frame)=>Math.max(frame.old,frame.incoming)<0.999).length});
    await page.close();
  }
  console.log(JSON.stringify({productionPreviousView:'GameView', scenarios:results, firstFrameCoversReady:true, cancelledNavigationStaysCancelled:true, stalePreparationRejected:true, restoreFinishesWithoutSuppressingNextEntry:true, archiveVisible:true, slowCoverFallbackRecovers:true}));
} finally {
  await browser?.close();
  await server.close();
}
