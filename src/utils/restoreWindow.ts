let restoreSequence = 0;
const ENTRANCE_ANIMATIONS = new Set([
  'card-enter', 'stats-enter', 'fade-up', 'fade-in', 'scale-in', 'hero-in',
  'music-row-reveal', 'preview-enter',
]);

// 直接完成本次已创建的入场动画，不通过 animation:none 开关反复删除/重建动画。
export function finishEntranceAnimations() {
  for (const animation of document.getAnimations()) {
    if (!ENTRANCE_ANIMATIONS.has((animation as CSSAnimation).animationName)) continue;
    if (animation.effect?.getComputedTiming().iterations === Infinity) continue;
    try { animation.finish(); } catch { /* 已取消的动画无需恢复 */ }
  }
}

export function restoreWindowAfterPaint(
  restoreContent: () => void,
  showWindow: () => Promise<unknown>,
  shouldShow: () => boolean,
): Promise<void> {
  const sequence = ++restoreSequence;
  restoreContent();
  return new Promise((resolve, reject) => {
    requestAnimationFrame(() => {
      if (sequence !== restoreSequence || !shouldShow()) { resolve(); return; }
      finishEntranceAnimations();
      // 完成动画后先给浏览器一次实际绘制机会，再显示原生窗口。
      requestAnimationFrame(() => {
        if (sequence !== restoreSequence || !shouldShow()) { resolve(); return; }
        try { void showWindow().then(() => resolve(), reject); }
        catch (error) { reject(error); }
      });
    });
  });
}
