import type { SeriesCard } from '../types';
import { coverSrc } from './media';

// 与影视库默认 Hero 共用选择规则，后台预热不能猜另一部作品。
export function selectDefaultSeriesHero(series: readonly SeriesCard[]): SeriesCard | null {
  if (!series.length) return null;
  const watching = series.filter((item) => item.last_watched_at && item.next_episode)
    .sort((a, b) => (b.last_watched_at || '').localeCompare(a.last_watched_at || ''));
  if (watching.length) return watching[0];
  const withArt = series.filter((item) => item.bg_path || item.poster_path);
  return [...(withArt.length ? withArt : series)]
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0] ?? null;
}

// 对齐 .hero(360px)、.poster-grid(min 168px/gap 20px) 和 px-6。
// 工具栏高度保守估算，最多预热31张海报+1张Hero；不遍历整个图库。
export function firstSeriesPosterCount(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 0;
  const innerWidth = Math.max(168, width - 48);
  const columns = Math.max(1, Math.floor((innerWidth + 20) / 188));
  const posterWidth = (innerWidth - (columns - 1) * 20) / columns;
  const rows = Math.ceil(Math.max(0, height - 360 - 48) / (posterWidth * 1.5 + 20));
  return Math.min(31, rows * columns);
}

export function seriesFirstScreenSources(series: readonly SeriesCard[], width: number, height: number): string[] {
  const hero = selectDefaultSeriesHero(series);
  const count = firstSeriesPosterCount(width, height);
  return [...new Set([
    hero ? coverSrc(hero.bg_path || hero.poster_path, hero.updated_at) : '',
    ...series.slice(0, count).map((item) => coverSrc(item.poster_path, item.updated_at)),
  ].filter(Boolean))];
}
