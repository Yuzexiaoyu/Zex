import { useLayoutEffect, useRef } from 'react';
import { useAppStore } from '../store';

type View = ReturnType<typeof useAppStore.getState>['activeView'];

// 请求常驻页面时保留当前页，直到对应数据、布局和首屏封面已准备好。
// 已进入后的后台刷新保持当前内容，导航到其他页则立即取消等待。
export function usePresentedView(requested: View): View {
  const statsReady = useAppStore((s) => !!s.statsPresentation
    && s.statsPresentation.stats === s.stats
    && s.statsPresentation.libraries === s.hiddenLibraries);
  const musicReady = useAppStore((s) => !!s.musicPresentation
    && s.musicPresentation.tracks === s.tracks
    && s.musicPresentation.playlists === s.playlists
    && s.musicPresentation.layout === s.musicLayout
    && (s.tracksStatus === 'ready' || s.tracksStatus === 'error')
    && (s.playlistsStatus === 'ready' || s.playlistsStatus === 'error'));
  const waiting = requested === 'stats' ? !statsReady : requested === 'music' ? !musicReady : false;
  // 只需记住已提交的页，不用 state 再令整棵页面树重渲染一次。
  const previous = useRef<View>(waiting ? 'games' : requested);
  const presented = waiting && previous.current !== requested ? previous.current : requested;
  useLayoutEffect(() => { previous.current = presented; }, [presented]);
  return presented;
}
