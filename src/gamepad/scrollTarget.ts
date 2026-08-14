import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

// 右摇杆滚动的滚动目标：栈式注册。视图挂载时 push 自己的滚动容器
// （详情/modal 覆盖时后进先出，滚动最上层），卸载时 pop 恢复前一个。
// service 收到 rscroll:* 事件时滚动栈顶容器。
const scrollStack: (HTMLElement | null)[] = [];

export function pushScrollTarget(el: HTMLElement | null) {
  scrollStack.push(el);
}
export function popScrollTarget(el: HTMLElement | null) {
  const i = scrollStack.lastIndexOf(el);
  if (i !== -1) scrollStack.splice(i, 1);
}
export function getScrollTarget(): HTMLElement | null {
  for (let i = scrollStack.length - 1; i >= 0; i--) {
    if (scrollStack[i]) return scrollStack[i];
  }
  return null;
}

/** 视图把滚动容器交给右摇杆服务：挂载注册、卸载自动撤销。
 *  无依赖数组：每次渲染后重算 —— 覆盖「滚动容器延迟渲染」场景（如影视详情页 data 未加载
 *  时根容器还没挂载，ref.current 为 null；加载完成后容器出现，本 effect 才 push 生效） */
export function useRightStickScroll(ref: RefObject<HTMLElement | null>) {
  const pushed = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === pushed.current) return; // 容器未变化：零操作
    if (pushed.current) popScrollTarget(pushed.current);
    if (el) pushScrollTarget(el);
    pushed.current = el;
  });
}

/** 带启用条件的变体：active 时注册 ref.current 为滚动目标，inactive 时撤销。
 *  用于「列内滚动」视图 —— 每列一个滚动容器，只有当前焦点列参与右摇杆滚动。
 *  active 翻转时 diff 到 el 变化 → 旧容器 pop、新容器 push；同列行内移动时零操作 */
export function useRightStickScrollIf(ref: RefObject<HTMLElement | null>, active: boolean) {
  const pushed = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = active ? ref.current : null;
    if (el === pushed.current) return; // 目标未变化：零操作
    if (pushed.current) popScrollTarget(pushed.current);
    if (el) pushScrollTarget(el);
    pushed.current = el;
  });
}
