import { useEffect, useState } from 'react';
import type { TopEntry } from '../types';
import { coverSrc } from './media';

// 行高 72px，向上选择有限的 DPR 档位，避免窗口缩放生成无限规格。
export function statsCoverScale(pixelRatio = window.devicePixelRatio): number {
  return Math.min(3, Math.max(1, Math.ceil(pixelRatio || 1)));
}

export function statsCoverSrc(entry: TopEntry, scale = statsCoverScale()): string {
  const source = coverSrc(entry.wide_path || entry.cover_path);
  if (!source) return '';
  const url = new URL(source);
  url.searchParams.set('thumb', 'stats');
  url.searchParams.set('h', String(72 * statsCoverScale(scale)));
  if (entry.cover_version) url.searchParams.set('v', entry.cover_version);
  return url.href;
}

// 跨显示器移动和浏览器缩放都可能改变 DPR，稳定档位变化才重取缩略图。
export function useStatsCoverScale(): number {
  const [scale, setScale] = useState(statsCoverScale);
  useEffect(() => {
    let query: MediaQueryList;
    const update = () => {
      setScale(statsCoverScale());
      query?.removeEventListener('change', update);
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      query.addEventListener('change', update);
    };
    update();
    window.addEventListener('resize', update);
    return () => {
      query.removeEventListener('change', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  return scale;
}
