import { useAppStore } from '../store';

// 与各库共用常驻 store。数据变化后在后台刷新，导航切换与每秒播放进度不触发查询。
export function startStatsRefresh(): () => void {
  let timer: number | undefined;
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (state.games === previous.games && state.series === previous.series
      && state.tracks === previous.tracks
      && state.nowPlaying?.trackId === previous.nowPlaying?.trackId
      && state.nowPlaying?.playing === previous.nowPlaying?.playing) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      void useAppStore.getState().loadStats().catch(() => {});
    }, 350);
  });
  return () => {
    unsubscribe();
    window.clearTimeout(timer);
  };
}
