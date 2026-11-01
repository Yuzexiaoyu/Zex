// 首屏图片实际解码完成后再开始卡片入场；只处理可见卡，不扫描整个游戏库。
export function prepareGridImages(grid: HTMLElement, onReady: () => void): () => void {
  let disposed = false;
  let frame = 0;
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
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const images: HTMLImageElement[] = [];
    for (const card of grid.querySelectorAll<HTMLElement>('.game-card, .folder-card')) {
      const rect = card.getBoundingClientRect();
      if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue;
      images.push(...card.querySelectorAll<HTMLImageElement>('img'));
    }
    let waiting = false;
    for (const image of images) {
      // CoverImg 会异步把 blob URL 写入 src；未写入时仍要等，不能误判为空图。
      const src = image.getAttribute('src');
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
  observer.observe(grid, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  const resize = new ResizeObserver(schedule);
  resize.observe(grid);
  // 慢盘/失联图片有上限，避免界面永久不可见。
  const timer = window.setTimeout(finish, 2500);
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
