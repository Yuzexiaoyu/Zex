import { useEffect, type RefObject } from 'react';
import { useAppStore } from '../store';
import { warmImages } from './preloadImages';
import { seriesFirstScreenSources } from './seriesImages';

// 只预热 Image/浏览器缓存，不挂载影视页面、详情或手柄组。
export function useSeriesImageWarmup(viewportRef?: RefObject<HTMLElement | null>): void {
  const series = useAppStore((state) => state.series);
  const hidden = useAppStore((state) => state.hiddenLibraries.includes('series'));
  const requested = useAppStore((state) => state.activeView === 'series');
  useEffect(() => {
    if (hidden || !series.length) return;
    let disposed = false;
    let idle: number | undefined;
    let timer: number | undefined;
    let work: AbortController | undefined;
    const viewport = viewportRef?.current;
    const cancelScheduled = () => {
      if (idle !== undefined) window.cancelIdleCallback(idle);
      window.clearTimeout(timer);
      idle = undefined; timer = undefined;
    };
    const start = () => {
      cancelScheduled();
      if (disposed) return;
      const width = viewport?.clientWidth ?? window.innerWidth;
      const height = viewport?.clientHeight ?? window.innerHeight;
      if (!width || !height) return;
      work?.abort();
      work = new AbortController();
      void warmImages(seriesFirstScreenSources(series, width, height), {
        priority: requested ? 'high' : 'low', concurrency: requested ? 4 : 2, signal: work.signal,
      });
    };
    const schedule = () => {
      cancelScheduled();
      work?.abort();
      if (requested) start();
      else if (window.requestIdleCallback) idle = window.requestIdleCallback(start, { timeout: 400 });
      else timer = window.setTimeout(start, 100);
    };
    const resize = viewport ? new ResizeObserver(schedule) : null;
    if (viewport) resize?.observe(viewport);
    else window.addEventListener('resize', schedule);
    schedule();
    return () => {
      disposed = true;
      cancelScheduled();
      work?.abort();
      resize?.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [series, hidden, requested, viewportRef]);
}
