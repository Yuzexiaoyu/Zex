import { useLayoutEffect, useState } from 'react';
import { useAppStore } from '../store';

type View = ReturnType<typeof useAppStore.getState>['activeView'];

// 请求统计页时保留当前页，直到对应数据、列布局和首屏封面已准备好。
// 已进入统计页后的后台刷新保持当前内容，导航到其他页则立即取消等待。
export function usePresentedView(requested: View): View {
  const ready = useAppStore((s) => !!s.statsPresentation
    && s.statsPresentation.stats === s.stats
    && s.statsPresentation.libraries === s.hiddenLibraries);
  const [previous, setPrevious] = useState<View>(requested === 'stats' && !ready ? 'games' : requested);
  const presented = requested === 'stats' && !ready && previous !== 'stats' ? previous : requested;
  useLayoutEffect(() => { setPrevious(presented); }, [presented]);
  return presented;
}
