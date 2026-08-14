import { clsx } from 'clsx';
import { Gamepad2, Film, Music2 } from 'lucide-react';
import type { TopEntry } from '../types';
import { coverSrc } from '../utils/media';

// 三类媒体的统一配色：游戏＝主题青，影视＝紫，音乐＝绿（复用 --color-success 色值）
export const MEDIA_COLORS = {
  game: '#00d4ff',
  video: '#a855f7',
  music: '#10b981',
} as const;

export type MediaKey = keyof typeof MEDIA_COLORS;

// 秒 → "1021h48m" / "18m" / "42s"（紧凑写法）
export function shortDur(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// 秒 → "1021 小时 48 分" / "42 分钟"（读起来完整）
export function longDur(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
  if (m > 0) return `${m} 分钟`;
  return s > 0 ? '不到 1 分钟' : '0 分钟';
}

const FALLBACK_ICON = {
  game: Gamepad2,
  video: Film,
  music: Music2,
} as const;

/** 每列内的横向行：封面在左、信息在右，一行只有一个项目。
 *  游戏/影视用宽幅封面（16:9 banner/bg），音乐用方形专辑封面；
 *  宽幅缺失时回退到竖版 cover_path 裁切，都没有再回退占位。
 *  信息常驻可见（名称/副标题/时长），悬停或手柄聚焦时整行高亮。
 *  anchor 是手柄滚动定位用的 data 属性值（格式 `${media}-${index}`） */
export function RowCard({ entry, media, color, rank, focused, anchor }: {
  entry: TopEntry;
  media: MediaKey;
  color: string;
  rank: number;
  focused?: boolean;
  anchor?: string;
}) {
  const Icon = FALLBACK_ICON[media];
  const imgSrc = entry.wide_path || entry.cover_path;

  return (
    <div
      className={clsx('stats-row', focused && 'stats-row-focus')}
      style={{ ['--cc' as string]: color }}
      data-stat-cover={anchor}
    >
      {/* 容器比例跟随图片形态：宽幅封面（banner/bg）用 16:9；音乐用方形；
          无宽幅图回退竖版封面时用 2:3 竖版容器 —— 配 contain 全程不裁切、不留怪边 */}
      <div className={clsx(
        'stats-row-cover',
        media === 'music' ? 'stats-row-cover-square'
          : entry.wide_path ? 'stats-row-cover-wide'
          : 'stats-row-cover-portrait',
      )}>
        {imgSrc ? (
          <img className="stats-row-img" src={coverSrc(imgSrc)} alt="" loading="lazy" draggable={false} />
        ) : (
          <div className="stats-row-img stats-row-blank"><Icon size={18} /></div>
        )}
        <span className="stats-row-rank" style={{ background: color }}>{rank}</span>
      </div>

      <div className="stats-row-body">
        <p className="stats-row-name" title={entry.name}>{entry.name}</p>
        {entry.sub && <p className="stats-row-sub" title={entry.sub}>{entry.sub}</p>}
      </div>

      <div className="stats-row-meta">
        {/* 游戏列含未玩过的条目（0 时长，统计页也展示）：显示「未游玩」，颜色与时长一致 */}
        {media === 'game' && entry.seconds <= 0 ? (
          <span className="stats-row-time" style={{ color }}>未游玩</span>
        ) : (
          <span className="stats-row-time" style={{ color }}>{longDur(entry.seconds)}</span>
        )}
        {/* 次数只统计音乐：游戏/影视不显示 */}
        {media === 'music' && entry.count > 0 && (
          <span className="stats-row-count">{entry.count.toLocaleString()} 次</span>
        )}
      </div>
    </div>
  );
}
