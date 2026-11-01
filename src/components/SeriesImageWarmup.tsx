import { memo, type RefObject } from 'react';
import { useSeriesImageWarmup } from '../utils/useSeriesImageWarmup';

// 订阅只影响这个无界面的预热器，不让影视数据更新重渲染整棵 App。
export default memo(function SeriesImageWarmup({ viewportRef }: { viewportRef: RefObject<HTMLElement | null> }) {
  useSeriesImageWarmup(viewportRef);
  return null;
});
