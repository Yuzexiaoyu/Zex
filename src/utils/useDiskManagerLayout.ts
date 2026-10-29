import { useLayoutEffect, useRef } from 'react';

// 先满足短列表；两块都溢出时，长的一块最多占 65%，短的一块至少占 35%。
function divideHeight(needs: number[], available: number): number[] {
  const total = needs.reduce((sum, height) => sum + height, 0);
  if (total <= available) return needs;
  if (available <= 0) return needs.map(() => 0);
  if (needs.length === 1) return [available];
  if (needs.length === 2) {
    const share = Math.max(0.35, Math.min(0.65, needs[0] / total));
    const first = Math.min(needs[0], Math.max(available - needs[1], available * share));
    return [first, available - first];
  }
  // 三行以上先平分一部分保底空间，再按未展示的内容量分配余量。
  const floor = available * 0.7 / needs.length;
  const base = needs.map((height) => Math.min(height, floor));
  const rest = available - base.reduce((sum, height) => sum + height, 0);
  const unmet = total - base.reduce((sum, height) => sum + height, 0);
  return base.map((height, i) => height + rest * (needs[i] - height) / unmet);
}

function verticalChrome(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
    + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
}

function outerHeight(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return element.offsetHeight + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
}

export function useDiskManagerLayout() {
  const modalRef = useRef<HTMLDivElement>(null);

  // 只订阅一次；容量数字、复制进度和拖拽坐标更新不再同步触发整窗测量。
  useLayoutEffect(() => {
    const modal = modalRef.current;
    const overlay = modal?.parentElement;
    const body = modal?.querySelector<HTMLElement>('[data-disk-body]');
    if (!modal || !overlay || !body) return;
    let frame = 0;
    let observed = new Set<Element>();
    let refreshTargets = true;

    const measure = () => {
      frame = 0;
      const grid = body.querySelector<HTMLElement>('[data-disk-grid]');
      const queue = modal.querySelector<HTMLElement>('[data-disk-queue]');
      const queueList = queue?.querySelector<HTMLElement>('[data-disk-list]');
      const queueContent = queueList?.firstElementChild as HTMLElement | null;
      const fixed = Array.from(modal.children).filter((el) => el !== body && el !== queue) as HTMLElement[];
      const cards = grid ? Array.from(grid.children) as HTMLElement[] : [];
      const fixedCardParts = cards.flatMap((card) => Array.from(card.children)
        .filter((el) => !el.hasAttribute('data-disk-list')) as HTMLElement[]);
      const overlayStyle = getComputedStyle(overlay);
      const available = Math.max(0, overlay.clientHeight
        - (parseFloat(overlayStyle.paddingTop) || 0)
        - (parseFloat(overlayStyle.paddingBottom) || 0)
        - verticalChrome(modal)
        - fixed.reduce((sum, el) => sum + outerHeight(el), 0));
      const bodyChrome = verticalChrome(body);
      const queueChrome = queue ? verticalChrome(queue) + Array.from(queue.children)
        .filter((el) => el !== queueList)
        .reduce((sum, el) => sum + outerHeight(el as HTMLElement), 0) : 0;
      const queueNeed = queueContent?.offsetHeight ?? 0;
      const columns = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 1;
      const gap = grid ? parseFloat(getComputedStyle(grid).rowGap) || 0 : 0;
      const rows: { fixed: number; natural: number; minimum: number }[] = [];
      cards.forEach((card, index) => {
        const list = card.querySelector<HTMLElement>('[data-disk-list]')!;
        const content = list.firstElementChild as HTMLElement;
        const chrome = verticalChrome(card) + verticalChrome(list) + Array.from(card.children)
          .filter((el) => el !== list)
          .reduce((sum, el) => sum + outerHeight(el as HTMLElement), 0);
        const row = rows[Math.floor(index / columns)] ?? { fixed: 0, natural: 0, minimum: 0 };
        row.fixed = Math.max(row.fixed, chrome);
        row.natural = Math.max(row.natural, chrome + content.offsetHeight);
        row.minimum = Math.max(row.minimum, chrome + Math.min(64, content.offsetHeight));
        rows[Math.floor(index / columns)] = row;
      });
      const gaps = Math.max(0, rows.length - 1) * gap;
      const gridFixed = rows.reduce((sum, row) => sum + row.fixed, 0);
      const needs = rows.map((row) => row.natural - row.fixed);
      // 空态也保持紧凑，不用整个视口的高度撑开加载提示。
      const emptyHeight = rows.length ? 0 : 160;
      const budget = Math.max(0, available - bodyChrome - gaps - gridFixed - queueChrome - emptyHeight);
      const [gridBudget, queueBudget] = divideHeight([
        needs.reduce((sum, height) => sum + height, 0), queueNeed,
      ], budget);
      let heights = divideHeight(needs, gridBudget).map((height, i) => height + rows[i].fixed);
      let bodyHeight = bodyChrome + gaps + heights.reduce((sum, height) => sum + height, 0) + emptyHeight;
      let queueHeight = queue ? queueChrome + queueBudget : 0;
      let scrollGrid = false;

      // 极多磁盘/很矮的窗口连卡片头都放不下时，只滚动网格，卡内列表完整展开，
      // 避免多层滚动和卡片被挤成零高度；通常只出现各卡内部的列表滚动条。
      if (bodyHeight + queueHeight > available + 0.5 || heights.some((height, i) => height < rows[i].minimum)) {
        const naturalBody = bodyChrome + gaps + rows.reduce((sum, row) => sum + row.natural, 0) + emptyHeight;
        [bodyHeight, queueHeight] = divideHeight([naturalBody, queue ? queueChrome + queueNeed : 0], available);
        heights = rows.map((row) => row.natural);
        scrollGrid = true;
      }
      body.style.height = `${bodyHeight}px`;
      body.style.overflowY = scrollGrid ? 'auto' : 'hidden';
      if (grid) grid.style.gridTemplateRows = heights.map((height) => `${height}px`).join(' ');
      if (queue) queue.style.height = `${queueHeight}px`;
      if (refreshTargets) {
        refreshTargets = false;
        const targets = new Set<Element>([overlay, ...fixed, ...fixedCardParts,
          ...Array.from(modal.querySelectorAll<HTMLElement>('[data-disk-content]')),
          ...(queue ? [queue.firstElementChild as HTMLElement] : []),
        ]);
        observed.forEach((element) => { if (!targets.has(element)) observer.unobserve(element); });
        targets.forEach((element) => { if (!observed.has(element)) observer.observe(element); });
        observed = targets;
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    // 列表增删、网格/队列挂载时更新监听对象；忽略普通文本数值变化。
    const mutations = new MutationObserver((records) => {
      if (!records.some((record) => [...record.addedNodes, ...record.removedNodes]
        .some((node) => node instanceof HTMLElement))) return;
      refreshTargets = true;
      schedule();
    });
    mutations.observe(modal, { childList: true, subtree: true });
    measure();
    window.addEventListener('resize', schedule);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
    };
  }, []);

  return modalRef;
}
