// 后台准备首屏与下一行。超时只放行页面，异步来源和晚到成功仍可更新占位。
const READY_TIMEOUT_MS = 400;

export interface StatsPreloadResult {
  unavailableSources: string[];
  timedOut: boolean;
}

interface ImageState {
  logical: string;
  actual: string;
  success?: boolean;
  decoding?: Promise<void>;
}

const actualSource = (image: HTMLImageElement) => image.getAttribute('src') || '';
const logicalSource = (image: HTMLImageElement) => image.dataset.coverSource || actualSource(image);

export function preloadStatsImages(page: HTMLElement, onReady: (result: StatsPreloadResult) => void): () => void {
  let disposed = false;
  let ready = false;
  let timedOut = false;
  let prepared = false;
  let frame = 0;
  let measure = true;
  let timer: number | undefined;
  let visibleImages: HTMLImageElement[] = [];
  let lastSources: string[] | undefined;
  const states = new Map<HTMLImageElement, ImageState>();
  const currentState = (image: HTMLImageElement) => {
    const state = states.get(image);
    return state?.logical === logicalSource(image) && state.actual === actualSource(image) ? state : undefined;
  };

  const publish = () => {
    if (disposed || !prepared || measure) return;
    if (!ready) {
      if (!timedOut && visibleImages.some((image) => currentState(image)?.success === undefined)) return;
      ready = true;
      window.clearTimeout(timer);
    }
    const sources = [...new Set(visibleImages
      .filter((image) => currentState(image)?.success !== true)
      .map(logicalSource).filter(Boolean))].sort();
    if (lastSources && sources.length === lastSources.length && sources.every((src, i) => src === lastSources![i])) return;
    lastSources = sources;
    onReady({ unavailableSources: sources, timedOut });
  };

  const inspect = (image: HTMLImageElement) => {
    const logical = logicalSource(image);
    const actual = actualSource(image);
    let state = states.get(image);
    if (!state || state.logical !== logical || state.actual !== actual) {
      state = { logical, actual };
      states.set(image, state);
    }
    if (image.dataset.coverStatus === 'error') {
      state.success = false;
      return;
    }
    // CoverImg 首次未命中时没有 src。等待其 blob 地址，不能把空 src 当失败。
    if (!actual || state.decoding) return;
    image.loading = 'eager';
    image.fetchPriority = 'high';
    const current = state;
    const complete = (success: boolean) => {
      if (disposed || states.get(image) !== current) return;
      if (actualSource(image) !== actual || logicalSource(image) !== logical) {
        schedule(false);
        return;
      }
      current.success = success;
      publish();
    };
    state.decoding = image.decode().then(() => complete(true), () => complete(false));
  };

  const prepareVisible = () => {
    const pageBounds = page.getBoundingClientRect();
    // 隐藏/最小化无有效布局时不开始超时；ResizeObserver 会在恢复后重试。
    if (pageBounds.width <= 0 || pageBounds.height <= 0) {
      prepared = false;
      window.clearTimeout(timer);
      timer = undefined;
      return false;
    }
    const images: HTMLImageElement[] = [];
    // 几何读取全部完成后再修改 loading / fetchPriority。
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
    const retained = new Set(images);
    for (const image of states.keys()) if (!retained.has(image)) states.delete(image);
    prepared = true;
    if (!ready && timer === undefined) {
      timer = window.setTimeout(() => { timedOut = true; publish(); }, READY_TIMEOUT_MS);
    }
    return true;
  };

  const schedule = (needsMeasure: boolean) => {
    if (disposed) return;
    measure ||= needsMeasure;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (measure) {
        measure = false;
        if (!prepareVisible()) return;
      }
      visibleImages.forEach(inspect);
      publish();
    });
  };
  const resize = new ResizeObserver(() => schedule(true));
  resize.observe(page);
  const mutations = new MutationObserver((changes) => {
    // 就绪后只跟踪已预热节点的来源，滚动挂载新行不触发全页扫描或显式 decode。
    if (!ready && changes.some((change) => change.type === 'childList')) schedule(true);
    else if (changes.some((change) => states.has(change.target as HTMLImageElement))) schedule(false);
  });
  mutations.observe(page, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'data-cover-source', 'data-cover-status'] });
  const onImageEvent = (event: Event) => {
    const image = event.target as HTMLImageElement;
    const state = states.get(image);
    if (!state) return;
    if (event.type === 'load' && state.success === false) states.delete(image);
    schedule(false);
  };
  page.addEventListener('load', onImageEvent, true);
  page.addEventListener('error', onImageEvent, true);
  schedule(true);
  return () => {
    disposed = true;
    window.clearTimeout(timer);
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
    page.removeEventListener('load', onImageEvent, true);
    page.removeEventListener('error', onImageEvent, true);
    visibleImages = [];
    states.clear();
  };
}
