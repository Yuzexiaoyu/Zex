import { useEffect } from 'react';
import { useAppStore } from '../store';

// 声明某浮层正在消费 Esc：active 为 true 时计数 +1，关闭/卸载时 -1。
// App 的全局「Esc=收托盘」只在计数为 0 时生效，避免开详情/弹窗时按 Esc 把整个应用收走
export function useEscIntercept(active: boolean) {
  useEffect(() => {
    if (!active) return;
    useAppStore.getState().escInterceptInc();
    return () => useAppStore.getState().escInterceptDec();
  }, [active]);
}
