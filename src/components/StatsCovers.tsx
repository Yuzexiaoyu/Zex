import { memo, useState } from 'react';
import { clsx } from 'clsx';
import { Gamepad2, Film, Music2 } from 'lucide-react';
import type { TopEntry } from '../types';
import { statsCoverSrc } from '../utils/statsImages';
import CoverImg from './CoverImg';
import { t, useT } from '../i18n';

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

// 秒 → "1021 小时 48 分" / "42 分钟"（读起来完整；词条与 utils/media.ts 同源）
export function longDur(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0
    ? t('common.duration.hoursMinutes', { h, m })
    : t('common.duration.hours', { n: h });
  if (m > 0) return t('common.duration.minutes', { n: m });
  return s > 0 ? t('common.duration.underMinute') : t('common.duration.zero');
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
export const RowCard = memo(function RowCard({ entry, media, color, rank, focused, anchor, onContextMenu, coverUnavailable = false, coverScale = 1 }: {
  entry: TopEntry;
  media: MediaKey;
  color: string;
  rank: number;
  focused?: boolean;
  anchor?: string;
  onContextMenu?: (e: React.MouseEvent, entry: TopEntry) => void;
  coverUnavailable?: boolean;
  coverScale?: number;
}) {
  const t = useT();
  const Icon = FALLBACK_ICON[media];
  const imgSrc = statsCoverSrc(entry, coverScale);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  // 首屏超时只是暂时占位；晚到 load 即恢复，也适用于虚拟行卸载后的重挂载。
  const unavailable = coverUnavailable && loadedSrc !== imgSrc;

  return (
    <div
      className={clsx('stats-row', focused && 'stats-row-focus')}
      style={{ ['--cc' as string]: color }}
      data-stat-cover={anchor}
      onContextMenu={onContextMenu ? (event) => onContextMenu(event, entry) : undefined}
    >
      {/* 容器比例跟随图片形态：宽幅封面（banner/bg）用 16:9；音乐用方形；
          无宽幅图回退竖版封面时用 2:3 竖版容器 —— 配 contain 全程不裁切、不留怪边 */}
      <div className={clsx(
        'stats-row-cover',
        unavailable && 'stats-row-cover-unavailable',
        media === 'music' ? 'stats-row-cover-square'
          : entry.wide_path ? 'stats-row-cover-wide'
          : 'stats-row-cover-portrait',
      )}>
        {imgSrc ? (
          <>
            <CoverImg
              className="stats-row-img"
              data-stats-image
              src={imgSrc}
              failureMode="placeholder"
              alt=""
              loading="lazy"
              decoding="async"
              draggable={false}
              onLoad={() => setLoadedSrc(imgSrc)}
              style={unavailable ? { visibility: 'hidden' } : undefined}
            />
            <div className="stats-row-img stats-row-blank stats-row-fallback absolute inset-0"><Icon size={18} /></div>
          </>
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
          <span className="stats-row-time" style={{ color }}>{t('stats.notPlayed')}</span>
        ) : (
          <span className="stats-row-time" style={{ color }}>{longDur(entry.seconds)}</span>
        )}
        {/* 次数只统计音乐：游戏/影视不显示 */}
        {media === 'music' && entry.count > 0 && (
          <span className="stats-row-count">{t('stats.countTimes', { n: entry.count.toLocaleString() })}</span>
        )}
      </div>
    </div>
  );
  // 按值比较而不是按引用：统计页每次刷新都会拿到全新的 stats 对象（IPC 反序列化），
  // 引用比较会让最多 3×500 行全部重渲染，正好卡在切页 / 刷新那一帧。
  // 这里只比真正影响渲染的字段，内容没变的行整块跳过。
}, (a, b) =>
  a.entry.id === b.entry.id
  && a.entry.name === b.entry.name
  && a.entry.sub === b.entry.sub
  && a.entry.seconds === b.entry.seconds
  && a.entry.count === b.entry.count
  && a.entry.wide_path === b.entry.wide_path
  && a.entry.cover_path === b.entry.cover_path
  && a.entry.cover_version === b.entry.cover_version
  && a.media === b.media
  && a.color === b.color
  && a.rank === b.rank
  && a.focused === b.focused
  && a.anchor === b.anchor
  && a.coverUnavailable === b.coverUnavailable
  && a.coverScale === b.coverScale
  && a.onContextMenu === b.onContextMenu);
