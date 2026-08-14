import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { ask, message } from '@tauri-apps/plugin-dialog';
import {
  Film, Play, Plus, Search, Star, Sparkles, Loader2, CheckCheck, Tv,
  History, CalendarPlus, ArrowDownAZ, GripVertical,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useAppStore } from '../store';
import AddSeriesModal from '../components/AddSeriesModal';
import SeriesContextMenu from '../components/SeriesContextMenu';
import LibraryContextMenu from '../components/LibraryContextMenu';
import SeriesDiskManagerModal from '../components/SeriesDiskManagerModal';
import SortMenu, { type SortOption, type SortMenuHandle } from '../components/SortMenu';
import SeriesDetail from './SeriesDetail';
import * as api from '../api';
import TmdbPickerModal from '../components/TmdbPickerModal';
import type { SeriesCard, TmdbSearchResult } from '../types';
import { coverSrc, yearOf } from '../utils/media';
import { useEscIntercept } from '../utils/escIntercept';
import { useFocusStore, useGamepadGroup, useGamepadFocus, useFocusIndex } from '../gamepad';

type FilterKey = 'all' | 'unfinished' | 'finished' | 'favorite';
type SortKey = 'custom' | 'recent' | 'title' | 'added' | 'rating';

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'unfinished', label: '未看完' },
  { key: 'finished', label: '已看完' },
  { key: 'favorite', label: '收藏' },
];

const SORTS: SortOption[] = [
  { key: 'custom', label: '自定义', hint: '拖动海报调整顺序', icon: GripVertical },
  { key: 'recent', label: '最近观看', hint: '看过的排前面', icon: History },
  { key: 'added', label: '最近添加', hint: '新导入的排前面', icon: CalendarPlus },
  { key: 'title', label: '名称', hint: '按剧名拼音升序', icon: ArrowDownAZ },
  { key: 'rating', label: '评分', hint: 'TMDB 评分从高到低', icon: Star },
];

const GRID_GAP = 20;        // 与 .poster-grid 的 gap 保持一致
const RING_LEN = 2 * Math.PI * 12; // 环形进度圆环周长（r=12）

// 拖拽状态：与游戏库同款 live reorder —— 拖拽期间工作数组随时等于最终顺序，
// 让位卡片直接在网格里流动，松手时布局零变化
interface DragState {
  id: string;
  from: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  grabDX: number;
  grabDY: number;
  width: number;
  height: number;
  active: boolean;
}

export default function SeriesView() {
  // 逐字段订阅：整墙海报不该跟着音乐进度等无关字段每秒重画
  const series = useAppStore((s) => s.series);
  const loadSeries = useAppStore((s) => s.loadSeries);
  const reorderSeries = useAppStore((s) => s.reorderSeries);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [sort, setSort] = useState<SortKey>('custom');

  // 右键菜单：卡片 / 空白区域
  const [menu, setMenu] = useState<{ s: SeriesCard; x: number; y: number } | null>(null);
  const [libMenu, setLibMenu] = useState<{ x: number; y: number } | null>(null);

  // TMDB 抓取进度（右键「获取元数据」触发）：状态在全局 store，切库回来面板不丢
  const fetchingTitle = useAppStore((s) => s.metadataFetchingTitle);
  const fetchPct = useAppStore((s) => s.fetchPct);
  const setFetchingTitle = useAppStore((s) => s.setMetadataFetching);
  const setFetchPct = useAppStore((s) => s.setFetchPct);
  // TMDB 候选选择（同名作品消歧）
  const [picker, setPicker] = useState<{ s: SeriesCard; results: TmdbSearchResult[] } | null>(null);
  // 磁盘管理弹窗（影视库封面右键菜单进入，与游戏库共用同一弹窗）
  const [showDiskManager, setShowDiskManager] = useState(false);

  // Hero：跟随鼠标悬停的海报切换（移开后保持不变）
  const [hoverId, setHoverId] = useState<string | null>(null);

  // 拖拽排序
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const sortRef = useRef<SortMenuHandle>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [liveItems, setLiveItems] = useState<SeriesCard[] | null>(null);
  const liveRef = useRef<SeriesCard[] | null>(null);
  // 拖过一次之后永久禁掉卡片入场动画：拖拽期间为了让位需要 animation: none，
  // 松手时这条规则一撤销，所有卡片的 card-enter 会整体重播 —— 看起来就是「刷新了一下」
  const [everDragged, setEverDragged] = useState(false);
  const suppressClickRef = useRef(false); // 拖完那一下的 click 不能打开详情
  const setDragBoth = (d: DragState | null) => { dragRef.current = d; setDrag(d); };
  const setLiveBoth = (arr: SeriesCard[] | null) => { liveRef.current = arr; setLiveItems(arr); };

  // 右键菜单 / 拖拽开着时由它们消费 Esc，App 的全局「Esc=收托盘」让位
  useEscIntercept(!!menu || !!libMenu);
  useEscIntercept(!!drag);

  useEffect(() => { void loadSeries(); }, [loadSeries]);

  useEffect(() => {
    if (!menu && !libMenu) return;
    const close = () => { setMenu(null); setLibMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu, libMenu]);

  useEffect(() => {
    if (!fetchingTitle) return;
    let un: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const stop = await listen<{ done: number; total: number }>('series-cover-progress', (e) => {
        if (!cancelled) setFetchPct(Math.min(100, (e.payload.done / Math.max(1, e.payload.total)) * 100));
      });
      if (cancelled) stop(); else un = stop;
    })();
    return () => { cancelled = true; un?.(); };
  }, [fetchingTitle]);

  // ─── 列表：搜索 + 筛选 + 排序 ───────────────
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = series.filter((s) => {
      if (q && ![s.title, s.aliases, s.genres].some((f) => (f || '').toLowerCase().includes(q))) {
        return false;
      }
      if (filter === 'favorite') return s.favorite;
      // 未看完 / 已看完互斥且覆盖全部：没有剧集数据的算未看完
      if (filter === 'unfinished') return s.episode_count === 0 || s.watched_count < s.episode_count;
      if (filter === 'finished') return s.episode_count > 0 && s.watched_count >= s.episode_count;
      return true;
    });
    if (sort === 'custom') return matched; // 后端已按 sort_order 返回，保持不动
    const byText = (a: string, b: string) => a.localeCompare(b, 'zh-Hans-CN');
    return [...matched].sort((a, b) => {
      switch (sort) {
        case 'title': return byText(a.title, b.title);
        case 'added': return byText(b.created_at || '', a.created_at || '');
        case 'rating': return (b.vote_average || 0) - (a.vote_average || 0);
        default: {
          // 最近观看：看过的按时间倒序在前，没看过的按标题排后面
          if (a.last_watched_at && b.last_watched_at) return byText(b.last_watched_at, a.last_watched_at);
          if (a.last_watched_at) return -1;
          if (b.last_watched_at) return 1;
          return byText(a.title, b.title);
        }
      }
    });
  }, [series, query, filter, sort]);

  // ─── Hero ──────────────────────────────────
  // 默认展示：继续观看的最近一部，没有则挑最近添加的
  const defaultHero = useMemo(() => {
    if (series.length === 0) return null;
    const watching = series
      .filter((s) => s.last_watched_at && s.next_episode)
      .sort((a, b) => (b.last_watched_at || '').localeCompare(a.last_watched_at || ''));
    if (watching.length > 0) return watching[0];
    const withArt = series.filter((s) => s.bg_path || s.poster_path);
    const pool = withArt.length > 0 ? withArt : series;
    return [...pool].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0] ?? null;
  }, [series]);

  // 悬停哪张海报，上方就切成哪部剧；移开后回到默认。
  // 拖拽期间锁定为被拖动的那张（拖拽会关掉卡片的指针事件，否则信息会掉回默认剧）
  const focusId = drag?.active ? drag.id : hoverId;
  const hero = useMemo(
    () => (focusId ? series.find((s) => s.id === focusId) ?? defaultHero : defaultHero),
    [focusId, series, defaultHero],
  );

  // 悬停即切换；移开不回落，信息停在最后看过的那部，直到悬停另一张海报
  const previewSeries = (id: string) => setHoverId(id);

  // ─── 拖拽排序 ──────────────────────────────
  // 仅自定义排序且未筛选时可拖（其它排序下位置由规则决定，拖动没有意义）
  const dragEnabled = sort === 'custom' && !query.trim() && filter === 'all';
  const displayList = liveItems ?? visible;
  const dragging = drag !== null;

  // ─── 手柄焦点导航 ──────────────────────────
  // 海报网格列数随容器宽度变化，用 ResizeObserver 实测（与拖拽 getTargetIndex 同款几何）
  const [gridCols, setGridCols] = useState(4);
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => {
      const first = grid.firstElementChild as HTMLElement | undefined;
      if (!first) return;
      const stepX = first.getBoundingClientRect().width + GRID_GAP;
      setGridCols(Math.max(1, Math.round((grid.getBoundingClientRect().width + GRID_GAP) / stepX)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(grid);
    return () => ro.disconnect();
  }, [displayList.length]);

  // 当前手柄焦点：海报网格 / hero 两个按钮
  const posterFocused = useFocusIndex('grid:series');
  const heroPlayFocused = useGamepadFocus('hero', 0);
  const heroDetailFocused = useGamepadFocus('hero', 1);
  const toolbarFocused = useFocusIndex('series-toolbar');

  // 海报网格组：A=进详情；「上」越顶行 → 工具栏「添加影视」那一行
  useGamepadGroup('grid:series', {
    count: displayList.length,
    cols: gridCols,
    activate: (i) => { const s = displayList[i]; if (s) setDetailId(s.id); },
    scrollIntoView: (i) => {
      const card = gridRef.current?.children[i] as HTMLElement | undefined;
      card?.scrollIntoView({ block: 'nearest' });
    },
    leave: (dir, index) => {
      // 上移 → 工具栏；横向保持原列位置（不跳回最左的「添加影视」）
      if (dir === 'up') {
        const col = index % gridCols;
        useFocusStore.getState().switchTo('series-toolbar', Math.min(col, toolbarCount - 1));
      }
    },
  });

  // 工具栏：横向组 [添加影视, 筛选 chips(全部/未看完/已看完/收藏), 排序]；
  // 左右在各项间移动、A 激活；「上」到 hero、「下」回海报网格
  const toolbarCount = 1 + FILTERS.length + 1;
  useGamepadGroup('series-toolbar', {
    count: toolbarCount,
    cols: toolbarCount,
    activate: (i) => {
      if (i === 0) setShowAddModal(true);
      else if (i <= FILTERS.length) setFilter(FILTERS[i - 1].key);
      else sortRef.current?.toggle();
    },
    leave: (dir) => {
      if (dir === 'up') useFocusStore.getState().switchTo('hero');
      if (dir === 'down') useFocusStore.getState().switchTo('grid:series');
    },
  });

  // hero 组：2 个按钮（播放/继续、剧集详情）；「下」到工具栏；「上」停住不进顶部导航
  useGamepadGroup('hero', {
    count: hero ? 2 : 0,
    cols: 2,
    activate: (i) => {
      if (!hero) return;
      if (i === 0) void playNext(hero);
      else setDetailId(hero.id);
    },
    scrollIntoView: () => { scrollRef.current?.scrollTo({ top: 0 }); },
    leave: (dir) => {
      if (dir === 'down') useFocusStore.getState().switchTo('series-toolbar');
    },
  });
  const draggedSeries = drag?.active ? displayList.find((s) => s.id === drag.id) ?? null : null;

  // 目标槽位：纯几何计算（网格是等宽等高的规则网格），不读被让位卡片的实际位置 →
  // 无反馈回路，拖动过程单调连续不跳变
  const getTargetIndex = (d: DragState, len: number): number => {
    const grid = gridRef.current;
    const first = grid?.firstElementChild as HTMLElement | undefined;
    if (!grid || !first) return 0;
    const gridRect = grid.getBoundingClientRect();
    const cell = first.getBoundingClientRect();
    const stepX = cell.width + GRID_GAP;
    const stepY = cell.height + GRID_GAP;
    const cols = Math.max(1, Math.round((gridRect.width + GRID_GAP) / stepX));
    const centerX = d.x - d.grabDX + d.width / 2 - gridRect.left;
    const centerY = d.y - d.grabDY + d.height / 2 - gridRect.top;
    const col = Math.max(0, Math.min(cols - 1, Math.floor(centerX / stepX)));
    const row = Math.max(0, Math.floor(centerY / stepY));
    return Math.max(0, Math.min(len - 1, row * cols + col));
  };

  const handleCardPointerDown = (e: React.PointerEvent, s: SeriesCard) => {
    if (!dragEnabled || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return; // 播放按钮不触发拖拽
    e.preventDefault();  // 禁掉图片原生拖拽与文本选择
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const from = visible.findIndex((v) => v.id === s.id);
    previewSeries(s.id); // 上方信息锁定到被拖的这部
    setLiveBoth([...visible]);
    setDragBoth({
      id: s.id,
      from: from < 0 ? 0 : from,
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      grabDX: e.clientX - rect.left,
      grabDY: e.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      active: false,
    });
  };

  // 监听挂在 window 上，且只随「是否在拖拽」挂/卸一次：
  // 每次指针移动都重挂会漏掉 removeEventListener（函数标识变了），造成监听泄漏
  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      // 4px 内视为点击
      if (!d.active && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
      if (!d.active) setEverDragged(true);
      const sc = scrollRef.current;
      if (sc) {
        const r = sc.getBoundingClientRect();
        if (e.clientY < r.top + 80) sc.scrollBy({ top: -24 });
        else if (e.clientY > r.bottom - 80) sc.scrollBy({ top: 24 });
      }
      const next: DragState = { ...d, x: e.clientX, y: e.clientY, active: true };
      const live = liveRef.current;
      if (live) {
        const target = getTargetIndex(next, live.length);
        const cur = live.findIndex((s) => s.id === d.id);
        if (cur >= 0 && target !== cur) {
          const arr = [...live];
          const [moved] = arr.splice(cur, 1);
          arr.splice(target, 0, moved);
          setLiveBoth(arr);
        }
      }
      setDragBoth(next);
    };

    const finish = () => {
      const d = dragRef.current;
      const live = liveRef.current;
      setDragBoth(null);
      setLiveBoth(null);
      if (!d?.active || !live) return;
      previewSeries(d.id); // 松手后信息继续停在刚拖过的这部（此时指针事件刚恢复，不会再触发 enter）
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      if (d.from !== live.findIndex((s) => s.id === d.id)) {
        void reorderSeries(live.map((s) => s.id));
      }
    };

    const cancel = () => { setDragBoth(null); setLiveBoth(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel(); };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', cancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  // ─── 操作 ──────────────────────────────────
  const playNext = async (s: SeriesCard) => {
    const ep = s.next_episode;
    if (!ep) {
      setDetailId(s.id);
      return;
    }
    if (!ep.local_path) {
      void message('下一集还没有关联本地视频文件', { title: '无法播放', kind: 'warning' });
      return;
    }
    try {
      // 进度与观看时长由后端 IPC 线程记账，这里不用再 touchEpisodePlayed。
      // 不在此隐藏窗口：等 mpv-ready 事件（窗口已全屏）由 App 统一收走，避免进播放器闪桌面
      await api.playEpisode(ep.id);
      void loadSeries();
    } catch (err) {
      void message(`播放失败：${String(err)}`, { title: '错误', kind: 'error' });
    }
  };

  const handleDelete = async (s: SeriesCard) => {
    const ok = await ask(`确定删除《${s.title}》吗？该剧的季、集与观看记录会一并删除。`, {
      title: '删除影视', kind: 'warning',
    });
    if (!ok) return;
    try {
      await api.deleteSeries(s.id);
      if (detailId === s.id) setDetailId(null);
      await loadSeries();
    } catch (err) {
      void message(`删除失败：${String(err)}`, { title: '错误', kind: 'error' });
    }
  };

  const runFetch = async (s: SeriesCard, tmdbId?: number) => {
    // 全局防重入：状态在 store，切库回来也在，不会二次触发
    if (useAppStore.getState().metadataFetchingTitle) return;
    setFetchingTitle(s.title);
    setFetchPct(0);
    try {
      // 成功后不弹提示（界面刷新即为反馈）；失败仍弹错误
      await api.autoFetchSeriesMetadata(s.id, tmdbId);
      await loadSeries();
    } catch (err) {
      void message(`获取失败：${String(err)}`, { title: '错误', kind: 'error' });
    } finally {
      setFetchingTitle(null);
      setFetchPct(0);
    }
  };

  // 先搜索候选：命中多条（同名作品）交给用户选，只有一条就直接抓
  const handleAutoFetch = async (s: SeriesCard) => {
    if (useAppStore.getState().metadataFetchingTitle) return;
    try {
      const results = await api.searchTmdb(s.title, s.media_type);
      if (results.length === 0) {
        void message(`TMDB 上没有找到「${s.title}」，可以改名后重试`, { title: '未找到', kind: 'warning' });
        return;
      }
      if (results.length === 1) {
        void runFetch(s, results[0].id);
        return;
      }
      setPicker({ s, results });
    } catch (err) {
      void message(`搜索失败：${String(err)}`, { title: '错误', kind: 'error' });
    }
  };

  // 详情页：整块替换库视图
  if (detailId) {
    return (
      <SeriesDetail
        seriesId={detailId}
        onClose={() => setDetailId(null)}
        onChanged={() => { void loadSeries(); }}
      />
    );
  }

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-y-auto"
      onContextMenu={(e) => { e.preventDefault(); setMenu(null); setLibMenu({ x: e.clientX, y: e.clientY }); }}
    >
      {series.length === 0 ? (
        <div className="h-full flex flex-col items-center justify-center gap-6">
          <div className="relative">
            <div className="w-32 h-32 rounded-3xl bg-gradient-to-br from-[#7c3aed]/10 to-[#00d4ff]/10 border border-[rgba(124,58,237,0.15)] flex items-center justify-center animate-float">
              <Tv size={52} className="text-text-tertiary" />
            </div>
            <div className="absolute -inset-4 rounded-full bg-[#7c3aed]/5 blur-2xl animate-pulse" />
          </div>
          <div className="text-center">
            <p className="text-xl font-semibold text-text-primary/70 mb-2">影视库还是空的</p>
            <p className="text-sm text-text-tertiary">选择一个含视频文件的文件夹，季和集会自动识别导入</p>
          </div>
          <button className="btn btn-accent gap-2 px-6 py-3 text-sm" onClick={() => setShowAddModal(true)}>
            <Plus size={16} />
            添加影视
          </button>
        </div>
      ) : (
        <>
          {/* ─── Hero：多部轮播，鼠标悬停暂停，可点圆点手动切换 ─── */}
          {hero && (
            <section
              className="hero"
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setLibMenu(null);
                setMenu({ s: hero, x: e.clientX, y: e.clientY });
              }}
            >
              {(hero.bg_path || hero.poster_path) && (
                <img
                  key={`bg-${hero.id}`}
                  className={clsx('hero-bg', !hero.bg_path && 'hero-bg-poster')}
                  src={coverSrc(hero.bg_path || hero.poster_path, hero.updated_at)}
                  alt=""
                />
              )}
              <div className="hero-shade" />

              <div className="hero-content" key={`content-${hero.id}`}>
                <h1 className="hero-title">{hero.title}</h1>
                <div className="hero-meta">
                  {hero.vote_average > 0 && (
                    <span className="rating-badge">
                      <Star size={13} fill="currentColor" />
                      {hero.vote_average.toFixed(1)}
                    </span>
                  )}
                  {(hero.media_type === 'movie'
                    ? ['电影', yearOf(hero.first_air_date), hero.status, hero.genres,
                       hero.watched_count > 0 ? '已看过' : '']
                    : [yearOf(hero.first_air_date), hero.status, hero.genres,
                       hero.season_count > 0 ? `${hero.season_count} 季` : '',
                       hero.episode_count > 0 ? `已看 ${hero.watched_count}/${hero.episode_count}` : '']
                  ).filter(Boolean).map((bit, i) => (
                    <span key={i} className="hero-meta-item">{bit}</span>
                  ))}
                </div>
                {hero.overview && <p className="hero-overview">{hero.overview}</p>}
                <div className="mt-5 flex items-center gap-3">
                  <button className={clsx('btn btn-accent px-6 py-3 text-sm', heroPlayFocused && 'gamepad-focus')} onClick={() => void playNext(hero)}>
                    <Play size={16} fill="currentColor" />
                    {hero.media_type === 'movie' ? (
                      hero.next_episode ? '播放电影' : '查看详情'
                    ) : hero.next_episode ? (
                      <>
                        {hero.watched_count > 0 ? '继续观看' : '开始观看'}
                        <span className="opacity-70 tabular-nums">
                          S{String(hero.next_episode.season_number).padStart(2, '0')}
                          E{String(hero.next_episode.episode_number).padStart(2, '0')}
                        </span>
                      </>
                    ) : '查看详情'}
                  </button>
                  <button className={clsx('btn btn-glass px-5 py-3 text-sm', heroDetailFocused && 'gamepad-focus')} onClick={() => setDetailId(hero.id)}>
                    <Film size={15} />
                    剧集详情
                  </button>
                </div>
              </div>

            </section>
          )}

          {/* ─── 工具栏（滚动时吸顶） ──────────── */}
          <div className="sticky top-0 z-20 glass border-b border-border-glass px-6 py-3 flex items-center gap-3 flex-wrap">
            <button className={clsx('btn btn-accent gap-2 text-sm', toolbarFocused === 0 && 'gamepad-focus')} onClick={() => setShowAddModal(true)}>
              <Plus size={15} />
              添加影视
            </button>

            <div className="relative flex-1 min-w-[180px] max-w-sm">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索剧名、原名或类型"
                className="input search-input text-sm"
              />
            </div>

            <div className="flex items-center gap-1.5">
              {FILTERS.map((f, i) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={clsx('chip', filter === f.key && 'active', toolbarFocused === i + 1 && 'gamepad-focus')}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <div className="ml-auto flex items-center gap-2.5">
              {dragEnabled && (
                <span className="hidden xl:flex items-center gap-1.5 text-xs text-text-tertiary">
                  <GripVertical size={13} />
                  拖动海报可调整顺序
                </span>
              )}
              <SortMenu
                ref={sortRef}
                value={sort}
                options={SORTS}
                onChange={(k) => setSort(k as SortKey)}
                focused={toolbarFocused === 1 + FILTERS.length}
              />
            </div>
          </div>

          {/* ─── 海报墙 ────────────────────────── */}
          <div className="px-6 py-6">
            {displayList.length === 0 ? (
              <div className="py-20 flex flex-col items-center gap-3">
                <Search size={32} className="text-text-tertiary" />
                <p className="text-sm text-text-secondary">没有匹配的影视</p>
              </div>
            ) : (
              <div
                ref={gridRef}
                className={clsx('poster-grid', drag?.active && 'dragging', everDragged && 'drag-suppress')}
              >
                {displayList.map((s, idx) => {
                  const pct = s.episode_count > 0 ? (s.watched_count / s.episode_count) * 100 : 0;
                  const done = s.episode_count > 0 && s.watched_count >= s.episode_count;
                  return (
                    <div
                      key={s.id}
                      className={clsx('poster-card group', drag?.active && drag.id === s.id && 'drag-src', idx === posterFocused && 'gamepad-focus')}
                      onClick={() => { if (!suppressClickRef.current) setDetailId(s.id); }}
                      onMouseEnter={() => previewSeries(s.id)}
                      onPointerDown={dragEnabled ? (e) => handleCardPointerDown(e, s) : undefined}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setLibMenu(null);
                        setMenu({ s, x: e.clientX, y: e.clientY });
                      }}
                    >
                      <div className="poster-frame">
                        {s.poster_path ? (
                          <img src={coverSrc(s.poster_path, s.updated_at)} alt={s.title} loading="lazy" className="poster-img" draggable={false} />
                        ) : (
                          <div className="poster-img flex items-center justify-center bg-gradient-to-br from-[#2a1a4e] to-[#0d0d2b]">
                            <Film size={38} className="text-text-tertiary" />
                          </div>
                        )}

                        <div className="poster-badges">
                          {done && (
                            <span className="poster-done"><CheckCheck size={12} />已看完</span>
                          )}
                        </div>
                        {!done && s.media_type === 'tv' && pct > 0 && (
                          <span className="poster-ring">
                            <svg viewBox="0 0 30 30">
                              <circle className="poster-ring-track" cx="15" cy="15" r="12" />
                              <circle
                                className="poster-ring-fill"
                                cx="15" cy="15" r="12"
                                strokeDasharray={RING_LEN}
                                strokeDashoffset={RING_LEN * (1 - pct / 100)}
                              />
                            </svg>
                            <span className="poster-ring-text"><b>{Math.round(pct)}</b><i>%</i></span>
                          </span>
                        )}

                        {/* 悬停信息条：底部滑入，元信息为主（标题/年份季集/进度/播放），不放大段简介 */}
                        <div className="poster-hover">
                          <p className="poster-hover-title">{s.title}</p>
                          <p className="poster-hover-meta">
                            {(s.media_type === 'movie'
                              ? [yearOf(s.first_air_date), '电影']
                              : [yearOf(s.first_air_date), s.season_count > 0 ? `${s.season_count} 季` : '', s.episode_count > 0 ? `${s.episode_count} 集` : '']
                            ).filter(Boolean).join(' · ') || '未获取信息'}
                          </p>
                          {done ? (
                            <p className="poster-hover-done">
                              <CheckCheck size={12} />
                              已看完
                            </p>
                          ) : pct > 0 ? (
                            <div className="poster-hover-progress">
                              <div className="poster-hover-progress-track">
                                <div className="poster-hover-progress-fill" style={{ width: `${pct}%` }} />
                              </div>
                              <span className="poster-hover-progress-text">{Math.round(pct)}%</span>
                            </div>
                          ) : null}
                          {s.next_episode && (
                            <div className="poster-hover-actions">
                              <button
                                className="poster-play"
                                onClick={(e) => { e.stopPropagation(); void playNext(s); }}
                              >
                                <Play size={13} fill="currentColor" />
                                {s.media_type === 'movie' ? '播放电影' : (
                                  <>
                                    播放 S{String(s.next_episode.season_number).padStart(2, '0')}
                                    E{String(s.next_episode.episode_number).padStart(2, '0')}
                                  </>
                                )}
                              </button>
                            </div>
                          )}
                        </div>

                        <div className="poster-caption">
                          <p className="poster-name">{s.title}</p>
                          <p className="poster-sub">
                            {(s.media_type === 'movie'
                              ? [yearOf(s.first_air_date), '电影']
                              : [yearOf(s.first_air_date), s.season_count > 0 ? `${s.season_count} 季` : '', s.episode_count > 0 ? `${s.episode_count} 集` : '']
                            ).filter(Boolean).join(' · ') || '未获取信息'}
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* 拖拽克隆：跟随指针 */}
      {drag?.active && draggedSeries && createPortal(
        <div
          className="drag-clone"
          style={{ left: drag.x - drag.grabDX, top: drag.y - drag.grabDY, width: drag.width }}
        >
          <div className="poster-frame">
            {draggedSeries.poster_path ? (
              <img src={coverSrc(draggedSeries.poster_path, draggedSeries.updated_at)} alt="" className="poster-img" draggable={false} />
            ) : (
              <div className="poster-img flex items-center justify-center bg-gradient-to-br from-[#2a1a4e] to-[#0d0d2b]">
                <Film size={38} className="text-text-tertiary" />
              </div>
            )}
            <div className="poster-caption">
              <p className="poster-name">{draggedSeries.title}</p>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* TMDB 候选选择 */}
      {picker && (
        <TmdbPickerModal
          title={picker.s.title}
          results={picker.results}
          currentId={picker.s.tmdb_id}
          onPick={(id) => { const target = picker.s; setPicker(null); void runFetch(target, id); }}
          onClose={() => setPicker(null)}
        />
      )}

      {/* 弹窗与菜单 */}
      {showAddModal && (
        <AddSeriesModal onClose={() => setShowAddModal(false)} onSuccess={() => { void loadSeries(); }} />
      )}

      {/* 磁盘管理弹窗（封面右键「磁盘管理」进入，管理影视文件跨盘移动） */}
      {showDiskManager && (
        <SeriesDiskManagerModal onClose={() => setShowDiskManager(false)} />
      )}

      {menu && (
        <SeriesContextMenu
          series={menu.s}
          x={menu.x}
          y={menu.y}
          onOpen={() => setDetailId(menu.s.id)}
          onDelete={() => void handleDelete(menu.s)}
          onAutoFetch={() => void handleAutoFetch(menu.s)}
          onDiskManage={() => setShowDiskManager(true)}
          onClose={() => setMenu(null)}
        />
      )}

      {libMenu && (
        <LibraryContextMenu x={libMenu.x} y={libMenu.y} onClose={() => setLibMenu(null)}>
          <button onClick={() => { setLibMenu(null); setShowAddModal(true); }} className="context-menu-item">
            <Plus size={14} className="text-[#00d4ff]" />
            添加影视
          </button>
          <button onClick={() => { setLibMenu(null); void loadSeries(); }} className="context-menu-item">
            <Sparkles size={14} className="text-text-secondary" />
            刷新影视库
          </button>
        </LibraryContextMenu>
      )}

      {/* TMDB 抓取进度 */}
      {fetchingTitle && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[120] glass-card px-5 py-4 min-w-[320px] flex flex-col gap-2.5 animate-fade-up">
          <div className="flex items-center gap-3 text-sm">
            <Loader2 size={15} className="animate-spin text-[#00d4ff]" />
            <span className="truncate">正在从 TMDB 获取《{fetchingTitle}》</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1 h-1.5 rounded-full bg-bg-surface-active overflow-hidden">
              <div className="h-full rounded-full bg-[#00d4ff] transition-[width] duration-300" style={{ width: `${fetchPct}%` }} />
            </div>
            <span className="text-xs text-text-secondary w-9 text-right tabular-nums">{Math.round(fetchPct)}%</span>
          </div>
        </div>
      )}
    </div>
  );
}
