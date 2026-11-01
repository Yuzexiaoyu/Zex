// 首屏图片实际解码完成后再开始卡片入场；只处理可见卡，不扫描整个游戏库。
export function prepareGridImages(grid: HTMLElement, onReady: () => void): () => void {
  return prepareVisibleImages(grid, '.game-card, .folder-card', onReady);
}

// 同一套解码交接用于游戏卡片和音乐行；overscan 节点不延迟首屏。
export function prepareVisibleImages(grid: HTMLElement, itemSelector: string, onReady: () => void): () => void {
  let disposed = false;
  let frame = 0;
  let timer: number | undefined;
  const decoded = new WeakMap<HTMLImageElement, string>();
  const decoding = new WeakMap<HTMLImageElement, string>();
  const finish = () => {
    if (disposed) return;
    dispose();
    onReady();
  };
  const schedule = () => {
    if (!disposed && !frame) frame = requestAnimationFrame(check);
  };
  const check = () => {
    frame = 0;
    const bounds = grid.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      window.clearTimeout(timer);
      timer = undefined;
      return;
    }
    // 有有效布局后才开始计时；最小化期间不能把未准备的图片误报为就绪。
    timer ??= window.setTimeout(finish, 2500);
    const images: HTMLImageElement[] = [];
    for (const card of grid.querySelectorAll<HTMLElement>(itemSelector)) {
      const rect = card.getBoundingClientRect();
      if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue;
      images.push(...card.querySelectorAll<HTMLImageElement>('img'));
    }
    let waiting = false;
    for (const image of images) {
      // CoverImg 会异步把 blob URL 写入 src；未写入时仍要等，不能误判为空图。
      const src = image.getAttribute('src');
      if (image.dataset.coverStatus === 'error') continue;
      if (!src) { waiting = true; continue; }
      if (decoded.get(image) === src) continue;
      waiting = true;
      if (decoding.get(image) === src) continue;
      image.loading = 'eager';
      image.fetchPriority = 'high';
      decoding.set(image, src);
      const settle = () => {
        if (disposed || image.getAttribute('src') !== src) return;
        // 损坏/缺失封面也算完成，保留浏览器原有错误处理，不拖住整屏。
        decoded.set(image, src);
        schedule();
      };
      void image.decode().then(settle, settle);
    }
    if (!waiting) finish();
  };
  const observer = new MutationObserver(schedule);
  observer.observe(grid, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'data-cover-source', 'data-cover-status'] });
  const resize = new ResizeObserver(schedule);
  resize.observe(grid);
  function dispose() {
    disposed = true;
    window.clearTimeout(timer);
    cancelAnimationFrame(frame);
    observer.disconnect();
    resize.disconnect();
  }
  schedule();
  return dispose;
}
