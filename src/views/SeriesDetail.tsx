import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { message } from '@tauri-apps/plugin-dialog';
import {
  ArrowLeft, Play, Star, Check, CheckCheck, RotateCcw, Loader2,
  Film, Layers, CalendarDays, Clock, FolderOpen,
} from 'lucide-react';
import { clsx } from 'clsx';
import * as api from '../api';
import type { Episode, NextEpisode, SeriesDetailData } from '../types';
import { cleanEpisodeTitle, coverSrc, formatDuration, formatRuntime, watchPercent, yearOf } from '../utils/media';
import { useEscIntercept } from '../utils/escIntercept';
import { useFocusStore, useGamepadGroup, useFocusIndex, useRightStickScroll } from '../gamepad';
import { useT } from '../i18n';

interface Props {
  seriesId: string;
  onClose: () => void;
  onChanged?: () => void; // 观看状态/元数据变化后通知首页刷新统计
}

export default function SeriesDetail({ seriesId, onClose, onChanged }: Props) {
  const t = useT();
  const [data, setData] = useState<SeriesDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeSeason, setActiveSeason] = useState('');
  // 整页滚动容器（右摇杆滚动目标）
  const scrollRef = useRef<HTMLDivElement>(null);
  // 右摇杆滚动目标：详情页打开时压栈、关闭恢复底层（影视库网格）
  useRightStickScroll(scrollRef);

  const load = useCallback(async (keepSeason = true) => {
    const detail = await api.getSeriesDetail(seriesId);
    setData(detail);
    setActiveSeason((prev) => {
      if (keepSeason && prev && detail.seasons.some((s) => s.id === prev)) return prev;
      // 默认停在「下一集」所在季，没有则第一季
      return detail.next_episode?.season_id || detail.seasons[0]?.id || '';
    });
    return detail;
  }, [seriesId]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    load(false)
      .catch((err) => { void message(t('series.loadFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [load]);

  // Esc 返回列表
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 详情开着时由本页消费 Esc（先关详情），App 的全局「Esc=收托盘」让位
  useEscIntercept(true);

  // 播放器换集或退出后，进度/已看/累计时长都变了 —— 重新拉一次详情。
  // 首页那边由 App.tsx 的 loadSeries 负责，详情页数据是独立的一份
  useEffect(() => {
    let stops: Array<() => void> = [];
    let cancelled = false;
    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const subs = await Promise.all([
        listen<string>('episode-changed', () => { void load(); }),
        listen<void>('mpv-closed', () => { void load(); }),
      ]);
      if (cancelled) subs.forEach((s) => s()); else stops = subs;
    })();
    return () => { cancelled = true; stops.forEach((s) => s()); };
  }, [load]);

  const season = useMemo(
    () => data?.seasons.find((s) => s.id === activeSeason) ?? data?.seasons[0],
    [data, activeSeason],
  );

  const progressPct = data && data.episode_count > 0
    ? (data.watched_count / data.episode_count) * 100
    : 0;

  // 详情页导航用到的派生状态（供焦点组的 leave/activate 判断；渲染区复用，不重复声明）
  const isMovie = data?.media_type === 'movie';
  const nextEp = data?.next_episode;
  const hasSeasonActions = !isMovie && !!season && season.episodes.length > 0;

  // ─── 手柄焦点导航 ──────────────────────────
  const episodesFocused = useFocusIndex('detail-episodes');
  const topFocused = useFocusIndex('detail-top');
  const heroFocused = useFocusIndex('detail-hero');
  const seasonActionsFocused = useFocusIndex('detail-season-actions');

  // 切季：左右键直接切换（不经过焦点移动），季标签的 active 高亮随之变化；
  // 肩键 LB/RB 不在这里接管，统一切库（service 的 cycleView 处理）
  const switchSeason = useCallback((dir: 1 | -1) => {
    const list = data?.seasons ?? [];
    if (list.length === 0) return;
    const cur = list.findIndex((s) => s.id === activeSeason);
    const base = cur < 0 ? 0 : cur;
    const next = list[(base + dir + list.length) % list.length];
    if (next) setActiveSeason(next.id);
  }, [data, activeSeason]);

  // 集列表：纵向组，上下切换集、A=播放；左右切季；「上」越界到返回按钮，B=返回影视库
  useGamepadGroup('detail-episodes', {
    count: season?.episodes.length ?? 0,
    cols: 1,
    activate: (i) => { const ep = season?.episodes[i]; if (ep) void playEpisode(ep); },
    scrollIntoView: (i) => {
      const rows = document.querySelectorAll('.ep-row');
      (rows[i] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
    },
    horizontal: (dir) => { switchSeason(dir === 'right' ? 1 : -1); return true; },
    leave: (dir) => {
      if (dir === 'up') useFocusStore.getState().switchTo(hasSeasonActions ? 'detail-season-actions' : 'detail-hero');
    },
    exit: onClose,
  });

  // 顶部：仅返回按钮（季标签用左右/肩键直接切，不单独聚焦）；「下」到继续观看/收藏行，B=返回
  useGamepadGroup('detail-top', {
    count: 1,
    cols: 1,
    activate: () => onClose(),
    horizontal: (dir) => { switchSeason(dir === 'right' ? 1 : -1); return true; },
    leave: (dir) => { if (dir === 'down') useFocusStore.getState().switchTo('detail-hero'); },
    exit: onClose,
  });

  // 继续观看/收藏行：横向组（[继续观看/播放, 收藏]）；「上」到返回按钮、「下」到整季操作/集列表
  useGamepadGroup('detail-hero', {
    count: nextEp || (isMovie && data?.seasons[0]?.episodes[0]) || (data?.episode_count ?? 0) > 0 ? 2 : 1,
    cols: 2,
    activate: (i) => {
      if (i === 1) { void toggleFavorite(); return; }
      if (nextEp) {
        const target = data?.seasons.flatMap((s) => s.episodes).find((e) => e.id === nextEp.id);
        if (target) void playEpisode(target);
        return;
      }
      const movieFile = isMovie ? data?.seasons[0]?.episodes[0] : undefined;
      if (movieFile) void playEpisode(movieFile);
      // 「全部看完了」占位：无操作
    },
    scrollIntoView: () => {
      document.querySelector('.detail-hero-actions')?.scrollIntoView({ block: 'nearest' });
    },
    leave: (dir) => {
      if (dir === 'up') useFocusStore.getState().switchTo('detail-top');
      else if (dir === 'down') useFocusStore.getState().switchTo(hasSeasonActions ? 'detail-season-actions' : 'detail-episodes');
    },
    exit: onClose,
  });

  // 整季标记已看/重置行：横向组（[整季标记已看, 整季重置]）；电影或无剧集的季不聚焦
  useGamepadGroup('detail-season-actions', {
    count: hasSeasonActions ? 2 : 0,
    cols: 2,
    activate: (i) => { void setSeasonWatched(i === 0); },
    scrollIntoView: () => {
      document.querySelector('.detail-season-actions')?.scrollIntoView({ block: 'nearest' });
    },
    leave: (dir) => {
      if (dir === 'up') useFocusStore.getState().switchTo('detail-hero');
      else if (dir === 'down') useFocusStore.getState().switchTo('detail-episodes');
    },
    exit: onClose,
  });

  // 进入详情：焦点压进集列表（栈底保留 grid:series，B 弹栈返回影视库）；
  // 卸载时清理残留（鼠标点返回按钮不走 B 弹栈）
  useEffect(() => {
    useFocusStore.getState().push('detail-episodes');
    return () => {
      const s = useFocusStore.getState();
      const top = s.stack.length ? s.stack[s.stack.length - 1] : undefined;
      if (top?.group === 'detail-episodes' || top?.group === 'detail-top'
        || top?.group === 'detail-hero' || top?.group === 'detail-season-actions') {
        s.back();
      }
    };
  }, []);

  // 本地乐观更新：先改 UI 再落库，避免整页重载导致的闪烁。
  // watched 变化时重算 next_episode（与后端 get_series_detail 同口径：按季、集顺序取第一条未看）。
  // 否则单集「标记已看」后 Hero 的「继续观看 SxxExx」仍指向刚标记完的那集，点下去会重看一遍
  const patchEpisode = (episodeId: string, patch: Partial<Episode>) => {
    setData((prev) => prev && (() => {
      const seasons = prev.seasons.map((s) => ({
        ...s,
        episodes: s.episodes.map((e) => (e.id === episodeId ? { ...e, ...patch } : e)),
      }));
      let next: NextEpisode | null = null;
      outer:
      for (const s of seasons) {
        for (const e of s.episodes) {
          if (!e.watched) {
            next = {
              id: e.id,
              season_id: e.season_id,
              season_number: s.season_number,
              episode_number: e.episode_number,
              title: e.title,
              still_path: e.still_path,
              local_path: e.local_path,
              runtime_minutes: e.runtime_minutes,
              watched_ms: e.watched_ms,
            };
            break outer;
          }
        }
      }
      return {
        ...prev,
        seasons,
        watched_count: patch.watched === undefined
          ? prev.watched_count
          : prev.watched_count + (patch.watched ? 1 : -1),
        next_episode: next,
      };
    })());
  };

  const toggleWatched = async (ep: Episode) => {
    const next = !ep.watched;
    // 勾选/取消都清零进度：取消后这集从未看重新开始，不残留"看到一半"
    patchEpisode(ep.id, { watched: next, watched_ms: 0 });
    try {
      await api.markEpisodeWatched(ep.id, next);
      onChanged?.();
    } catch (err) {
      patchEpisode(ep.id, { watched: ep.watched, watched_ms: ep.watched_ms }); // 回滚
      void message(t('series.markFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
    }
  };

  const playEpisode = async (ep: Episode) => {
    if (!ep.local_path) {
      void message(t('series.epNoFileThis'), { title: t('series.cannotPlay'), kind: 'warning' });
      return;
    }
    try {
      // 进度与观看时长由后端 IPC 线程记账，这里不用再 touchEpisodePlayed。
      // 不在此隐藏窗口：等 mpv-ready 事件（窗口已全屏）由 App 统一收走，避免进播放器闪桌面
      await api.playEpisode(ep.id);
      onChanged?.();
    } catch (err) {
      void message(t('series.playFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
    }
  };

  const setSeasonWatched = async (watched: boolean) => {
    if (!season) return;
    try {
      await api.markSeasonWatched(season.id, watched);
      await load();
      onChanged?.();
    } catch (err) {
      void message(t('series.opFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
    }
  };

  const toggleFavorite = async () => {
    if (!data) return;
    const next = !data.favorite;
    setData({ ...data, favorite: next });
    try {
      await api.setSeriesFavorite(data.id, next);
      onChanged?.();
    } catch (err) {
      setData({ ...data, favorite: !next });
      void message(t('series.favoriteFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
    }
  };

  if (loading || !data) {
    return (
      <div className="h-full flex items-center justify-center gap-3 text-text-secondary">
        <Loader2 size={18} className="animate-spin text-[#00d4ff]" />
        {t('series.loading')}
      </div>
    );
  }

  const backdrop = data.bg_path || data.poster_path;
  const year = yearOf(data.first_air_date);
  // 电影只有一个视频文件，季/集是内部承载结构，界面上不呈现
  const movieFile = isMovie ? data.seasons[0]?.episodes[0] : undefined;
  const metaBits = (isMovie
    ? [t('series.movie'), year, data.status, data.genres, formatRuntime(movieFile?.runtime_minutes ?? 0)]
    : [
        year,
        data.status,
        data.genres,
        data.seasons.length > 0 ? t('series.seasonCount', { n: data.seasons.length }) : '',
        data.episode_count > 0 ? t('series.episodeCount', { n: data.episode_count }) : '',
      ]
  )
    // 累计观看时长（由播放会话累加，和游戏库的「已玩 X」同构）
    .concat(data.total_seconds > 0 ? [t('series.watchedTotal', { time: formatDuration(data.total_seconds) })] : [])
    .filter(Boolean);

  return (
    <div ref={scrollRef} className="relative h-full overflow-y-auto detail-scroll">
      {/* 背景大图：顶部铺满，向下渐隐到页面底色。无背景图（bg/poster 都空）时
          浅色主题下 hero 白字叠在页面浅底上不可读 → 渲染深色渐变承接
          （detail-backdrop-fallback，深色模式 display:none 保持现状） */}
      {backdrop ? (
        <div className="detail-backdrop">
          <img src={coverSrc(backdrop, data.updated_at)} alt="" />
          <div className="detail-backdrop-fade" />
        </div>
      ) : (
        <div className="detail-backdrop detail-backdrop-fallback" />
      )}

      <div className="relative z-10 px-8 pb-10">
        {/* 返回 */}
        <div className="sticky top-0 z-20 -mx-8 px-8 py-4 flex items-center gap-3">
          <button onClick={onClose} className={clsx('detail-back', topFocused === 0 && 'gamepad-focus')}>
            <ArrowLeft size={16} />
            {t('series.backToLibrary')}
          </button>
        </div>

        {/* Hero：海报 + 元信息 + 简介 */}
        <div className="flex gap-8 pt-6 pb-8 max-lg:flex-col">
          <div className="shrink-0">
            {data.poster_path ? (
              <img
                src={coverSrc(data.poster_path, data.updated_at)}
                alt={data.title}
                className="detail-poster"
              />
            ) : (
              <div className="detail-poster flex items-center justify-center bg-gradient-to-br from-[#2a1a4e] to-[#0d0d2b] detail-poster-fallback">
                <Film size={40} className="text-text-tertiary" />
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1 flex flex-col justify-end">
            <h1 className="text-4xl font-bold tracking-tight leading-tight text-white drop-shadow-lg max-lg:text-3xl">
              {data.title}
            </h1>
            {data.aliases && data.aliases !== data.title && (
              <p className="mt-1.5 text-sm text-white/50">{data.aliases}</p>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-white/75">
              {data.vote_average > 0 && (
                <span className="rating-badge">
                  <Star size={13} fill="currentColor" />
                  {data.vote_average.toFixed(1)}
                </span>
              )}
              {metaBits.map((bit, i) => (
                <span key={i} className="flex items-center gap-3">
                  {i > 0 && <span className="w-1 h-1 rounded-full bg-white/30" />}
                  {bit}
                </span>
              ))}
            </div>

            {data.overview ? (
              <p className="mt-4 max-w-3xl text-[15px] leading-relaxed text-white/80 line-clamp-5">
                {data.overview}
              </p>
            ) : (
              <p className="mt-4 text-sm text-white/45">
                {t('series.noOverview')}
              </p>
            )}

            {/* 观看进度（电影只有一集，进度条没有意义） */}
            {!isMovie && data.episode_count > 0 && (
              <div className="mt-5 flex items-center gap-3 max-w-md">
                <div className="flex-1 h-1.5 rounded-full bg-white/15 overflow-hidden">
                  <div className="h-full rounded-full bg-[#00d4ff] shadow-[0_0_12px_rgba(0,212,255,0.6)]" style={{ width: `${progressPct}%` }} />
                </div>
                <span className="text-xs text-white/60 tabular-nums whitespace-nowrap">
                  {t('series.watchedCount', { watched: data.watched_count, total: data.episode_count })}
                </span>
              </div>
            )}

            <div className="mt-6 flex flex-wrap items-center gap-3 detail-hero-actions">
              {nextEp ? (
                <button
                  onClick={() => {
                    const target = data.seasons
                      .flatMap((s) => s.episodes)
                      .find((e) => e.id === nextEp.id);
                    if (target) void playEpisode(target);
                  }}
                  className={clsx('btn btn-accent px-6 py-3 text-sm', heroFocused === 0 && 'gamepad-focus')}
                >
                  <Play size={16} fill="currentColor" />
                  {isMovie ? t('series.playMovie') : (
                    <>
                      {data.watched_count > 0 ? t('series.continueWatching') : t('series.startWatching')}
                      <span className="opacity-70 tabular-nums">
                        S{String(nextEp.season_number).padStart(2, '0')}E{String(nextEp.episode_number).padStart(2, '0')}
                      </span>
                    </>
                  )}
                </button>
              ) : isMovie && movieFile ? (
                <button
                  onClick={() => void playEpisode(movieFile)}
                  className={clsx('btn btn-accent px-6 py-3 text-sm', heroFocused === 0 && 'gamepad-focus')}
                >
                  <Play size={16} fill="currentColor" />
                  {t('series.replay')}
                </button>
              ) : data.episode_count > 0 ? (
                <span className={clsx('btn btn-glass px-6 py-3 text-sm cursor-default', heroFocused === 0 && 'gamepad-focus')}>
                  <CheckCheck size={16} className="text-green-400" />
                  {t('series.allWatched')}
                </span>
              ) : null}

              <button
                onClick={() => void toggleFavorite()}
                className={clsx('btn btn-glass px-5 py-3 text-sm', data.favorite && 'fav-on', heroFocused === 1 && 'gamepad-focus')}
              >
                <Star
                  size={15}
                  className={data.favorite ? 'text-[#ffd75e]' : ''}
                  fill={data.favorite ? 'currentColor' : 'none'}
                />
                {data.favorite ? t('series.favorited') : t('series.favorite')}
              </button>
            </div>
          </div>
        </div>

        {/* 季标签页（电影不显示） */}
        {!isMovie && data.seasons.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap py-4 border-t border-border-glass">
            {data.seasons.map((s) => {
              const watched = s.episodes.filter((e) => e.watched).length;
              // 整季已看完：非空季且每集都打了勾（0 集的季不算，避免 0/0 误判）
              const seasonDone = s.episodes.length > 0 && watched === s.episodes.length;
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveSeason(s.id)}
                  className={clsx(
                    'season-tab',
                    s.id === (season?.id ?? '') && 'active',
                    seasonDone && 'done',
                  )}
                  title={seasonDone ? t('series.seasonDoneTitle') : undefined}
                >
                  <Layers size={13} />
                  {s.name?.trim() || t('series.seasonN', { n: s.season_number })}
                  <span className={clsx('tabular-nums text-xs', seasonDone ? 'text-[#34d399] font-semibold' : 'opacity-60')}>
                    {watched}/{s.episodes.length}
                  </span>
                  {seasonDone && (
                    <span className="season-tab-done">
                      <Check size={11} strokeWidth={3.5} />
                    </span>
                  )}
                </button>
              );
            })}

            {season && season.episodes.length > 0 && (
              <div className="ml-auto flex items-center gap-2 detail-season-actions">
                <button
                  onClick={() => setSeasonWatched(true)}
                  className={clsx('btn btn-glass py-2 px-3.5 text-xs', seasonActionsFocused === 0 && 'gamepad-focus')}
                >
                  <CheckCheck size={13} />
                  {t('series.markSeasonWatched')}
                </button>
                <button
                  onClick={() => setSeasonWatched(false)}
                  className={clsx('btn btn-glass py-2 px-3.5 text-xs', seasonActionsFocused === 1 && 'gamepad-focus')}
                >
                  <RotateCcw size={13} />
                  {t('series.resetSeason')}
                </button>
              </div>
            )}
          </div>
        )}

        {/* 集列表（季标签下方直接是各集，不再插入季简介） */}
        {!season || season.episodes.length === 0 ? (
          <div className="py-16 flex flex-col items-center gap-3 text-center">
            <Film size={36} className="text-text-tertiary" />
            <p className="text-sm text-text-secondary">
              {isMovie ? t('series.noEpMovie') : t('series.noEpSeason')}
            </p>
            <p className="text-xs text-text-tertiary">
              {isMovie
                ? t('series.noEpMovieHint')
                : t('series.noEpSeasonHint')}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 pb-6">
            {season.episodes.map((ep, i) => {
              // 已看 = 满格；未看 = 实际观看进度
              const pct = ep.watched ? 100 : watchPercent(ep.watched_ms, ep.runtime_minutes);
              return (
                <div
                  key={ep.id}
                  className={clsx('ep-row group', ep.watched ? 'watched' : pct > 0 && 'watching', i === episodesFocused && 'gamepad-focus')}
                >
                  {/* 剧照 */}
                  <div className="ep-still" onClick={() => void playEpisode(ep)}>
                    {ep.still_path ? (
                      <img src={coverSrc(ep.still_path, ep.last_watched_at || undefined)} alt="" loading="lazy" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#16213a] to-[#0d0d2b]">
                        <Film size={18} className="text-text-tertiary" />
                      </div>
                    )}
                    <span className="ep-still-play">
                      <Play size={16} fill="currentColor" />
                    </span>
                    {ep.watched ? (
                      <span className="ep-still-done-badge"><Check size={13} strokeWidth={3} /></span>
                    ) : pct > 0 ? (
                      <span className="ep-still-watching">{Math.round(pct)}%</span>
                    ) : null}
                  </div>

                  {/* 信息 */}
                  <div className="min-w-0 flex-1 py-1">
                    <div className="flex items-baseline gap-2.5">
                      {/* 电影只有一个文件，不存在第几季第几集 */}
                      {!isMovie && (
                        <span className="text-[#00d4ff] font-bold tabular-nums text-sm text-glow-accent">
                          E{String(ep.episode_number).padStart(2, '0')}
                        </span>
                      )}
                      <h3 className="text-[15px] font-semibold truncate text-text-primary">
                        {isMovie
                          ? (cleanEpisodeTitle(ep.title, ep.episode_number).replace(/^第 \d+ 集$/, data.title) || data.title)
                          : cleanEpisodeTitle(ep.title, ep.episode_number)}
                      </h3>
                      {ep.vote_average > 0 && (
                        <span className="flex items-center gap-1 text-xs text-yellow-400/90 shrink-0">
                          <Star size={11} fill="currentColor" />
                          {ep.vote_average.toFixed(1)}
                        </span>
                      )}
                    </div>

                    {ep.overview && (
                      <p className="mt-1.5 text-[13px] leading-relaxed text-text-secondary line-clamp-2">
                        {ep.overview}
                      </p>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-tertiary">
                      {ep.air_date && (
                        <span className="flex items-center gap-1.5"><CalendarDays size={12} />{ep.air_date}</span>
                      )}
                      {ep.runtime_minutes > 0 && (
                        <span className="flex items-center gap-1.5"><Clock size={12} />{formatRuntime(ep.runtime_minutes)}</span>
                      )}
                      {ep.local_path ? (
                        <span className="flex items-center gap-1.5 truncate max-w-[380px]" title={ep.local_path}>
                          <FolderOpen size={12} />
                          {ep.local_path.split(/[/\\]/).pop()}
                        </span>
                      ) : (
                        <span className="text-[#f59e0b]/80">{t('series.epNoLocalFile')}</span>
                      )}
                    </div>
                  </div>

                  {/* 操作 */}
                  <div className="flex items-center gap-2 shrink-0 self-center">
                    <button
                      onClick={() => void playEpisode(ep)}
                      className="ep-action"
                      title={ep.local_path ? t('series.play') : t('series.epNoFileShort')}
                    >
                      <Play size={15} fill="currentColor" />
                    </button>
                    <button
                      onClick={() => void toggleWatched(ep)}
                      className={clsx('ep-action', ep.watched && 'done')}
                      title={ep.watched ? t('series.markUnwatched') : t('series.markWatched')}
                    >
                      <Check size={15} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
