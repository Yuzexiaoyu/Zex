// 后台预热常驻统计页首屏与下一行；就绪后交接显示，慢图超时使用稳定占位。
const READY_TIMEOUT_MS = 400;

export interface StatsPreloadResult {
  unavailableSources: string[];
  timedOut: boolean;
}

export function preloadStatsImages(page: HTMLElement, onReady: (result: StatsPreloadResult) => void): () => void {
  let disposed = false;
  let ready = false;
  let frame = 0;
  let request = 0;
  let timer: number | undefined;
  let visibleImages: HTMLImageElement[] = [];
  const pending = new WeakMap<HTMLImageElement, { src: string; promise: Promise<void> }>();
  const decoded = new WeakMap<HTMLImageElement, { src: string; success: boolean }>();
  const finish = (timedOut = false) => {
    if (disposed || ready) return;
    ready = true;
    window.clearTimeout(timer);
    const unavailableSources = [...new Set(visibleImages.filter((image) => {
      const result = decoded.get(image);
      return result?.src !== image.src || !result.success;
    }).map((image) => image.src))];
    onReady({ unavailableSources, timedOut });
  };

  const prepareVisible = () => {
    frame = 0;
    const currentRequest = ++request;
    const pageBounds = page.getBoundingClientRect();
    // 窗口隐藏/最小化时没有有效布局，等 ResizeObserver 再测，不能误报已预热。
    if (pageBounds.width <= 0 || pageBounds.height <= 0) return;
    // 最小化时 rAF 可能暂停；有有效首屏布局后才开始超时计时。
    if (!ready && timer === undefined) timer = window.setTimeout(() => finish(true), READY_TIMEOUT_MS);
    const images: HTMLImageElement[] = [];
    // 先完成所有几何读取，再修改图片属性，避免读写交错导致反复布局。
    for (const column of page.querySelectorAll<HTMLElement>('.stats-col-rows')) {
      const bounds = column.getBoundingClientRect();
      const top = Math.max(bounds.top, pageBounds.top, 0);
      const bottom = Math.min(bounds.bottom, pageBounds.bottom, window.innerHeight);
      if (bottom <= top) continue;
      for (const row of column.querySelectorAll<HTMLElement>('[data-stat-cover]')) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom <= top) continue;
        if (rect.top >= bottom + 96) break;
        const image = row.querySelector<HTMLImageElement>('img[data-stats-image]');
        if (image) images.push(image);
      }
    }
    visibleImages = images;
    const tasks = images.map((image) => {
      const src = image.src;
      const previous = pending.get(image);
      if (previous?.src === src) return previous.promise;
      image.loading = 'eager';
      image.fetchPriority = 'high';
      const promise = image.decode().then(
        () => { decoded.set(image, { src, success: true }); },
        () => { decoded.set(image, { src, success: false }); },
      );
      pending.set(image, { src, promise });
      return promise;
    });
    void Promise.allSettled(tasks).then(() => {
      if (currentRequest === request) finish();
    });
  };
  const schedule = () => {
    if (!disposed && !frame) frame = requestAnimationFrame(prepareVisible);
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(page);
  schedule();
  return () => {
    disposed = true;
    window.clearTimeout(timer);
    cancelAnimationFrame(frame);
    resize.disconnect();
  };
}
