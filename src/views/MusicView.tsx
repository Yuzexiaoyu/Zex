import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ask, message } from '@tauri-apps/plugin-dialog';
import { createPortal } from 'react-dom';
import {
  Music, Plus, Search, Star, ArrowDownAZ, CalendarPlus,
  CheckSquare, Square, Trash2, Music2, ListMusic, GripVertical, ListPlus,
  Rows3, LayoutGrid,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useAppStore } from '../store';
import AddMusicModal from '../components/AddMusicModal';
import MusicContextMenu from '../components/MusicContextMenu';
import AddToPlaylistFlyout from '../components/AddToPlaylistFlyout';
import CreatePlaylistModal from '../components/CreatePlaylistModal';
import SortMenu, { type SortOption, type SortMenuHandle } from '../components/SortMenu';
import type { Track } from '../types';
import { coverSrc } from '../utils/media';
import CoverImg from '../components/CoverImg';
import { useEscIntercept } from '../utils/escIntercept';
import { useGamepadGroup, useFocusIndex, useRightStickScroll } from '../gamepad';
import { useT } from '../i18n';

type SortKey = 'recent' | 'title' | 'artist' | 'album' | 'custom';
// 全部 / 收藏 / 歌单（playlist:<id>）——歌单和收藏一个道理，都是筛选入口
type FilterKey = 'all' | 'favorite' | string;

// label/hint 存 i18n key，SortMenu 内部经 t() 渲染
const SORTS: SortOption[] = [
  { key: 'recent', label: 'music.sortRecent', hint: 'music.sortRecentHint', icon: CalendarPlus },
  { key: 'title', label: 'music.sortTitle', hint: 'music.sortTitleHint', icon: ArrowDownAZ },
  { key: 'artist', label: 'music.sortArtist', hint: 'music.sortArtistHint', icon: Music2 },
  { key: 'album', label: 'music.sortAlbum', hint: 'music.sortAlbumHint', icon: ListMusic },
  { key: 'custom', label: 'music.sortCustom', hint: 'music.sortCustomHint', icon: GripVertical },
];

// 曲目行高（px）：单列 = 封面 44 + 上下留白 + 行间距 2；紧凑多列 = 封面 40 + 留白 + 间距 2。
// 虚拟滚动的 estimateSize、悬停高亮块、拖拽目标槽位三处几何都从这里取值 ——
// 改行的内边距/封面尺寸时只改这两个常量
const ROW_H_SINGLE = 66;
const ROW_H_MULTI = 54;
// 多列几何：列间距 / 单列最小可用宽 / 列数上限。520 是「封面 + 两行文字 + 时长」
// 读起来不挤的下限 —— 1920 窗口 → 3 列，1280 → 2 列，960（最小窗口）→ 1 列
const COL_GAP = 12;
const MIN_COL_W = 520;
const MAX_COLS = 4;
// 滚动容器的左右内边距（px-6 单侧 24）。悬停高亮和拖拽命中要把指针坐标换算成
// 内容坐标，必须与容器实际 padding 同源（游戏库那边曾因写死值不符而整体偏移）
const PAD_X = 24;

// 四列用不同的起拍与收束速度；行内逐级推进，形成一遍轻快的列间波纹。
const INTRO_COLUMNS = [
  { duration: 104, offset: 0, step: 10, x: -3, y: 6 },
  { duration: 120, offset: 22, step: 12, x: -1, y: 8 },
  { duration: 136, offset: 44, step: 9, x: 1, y: 7 },
  { duration: 112, offset: 66, step: 11, x: 3, y: 6 },
] as const;
const INTRO_SINGLE = { duration: 120, offset: 0, step: 10, x: 0, y: 5 };

function musicIntro(row: number, column: number, multi: boolean) {
  const profile = multi ? INTRO_COLUMNS[column % INTRO_COLUMNS.length] : INTRO_SINGLE;
  return { ...profile, delay: profile.offset + row * profile.step };
}

// 秒 → "m:ss"，解析失败显示 "-:--"
function fmtTime(seconds: number): string {
  if (!seconds || seconds <= 0) return '-:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function MusicView() {
  const t = useT();
  // 逐字段订阅：曲目列表最长，不能跟着 nowPlaying.positionMs 每秒重画整表
  const tracks = useAppStore((s) => s.tracks);
  const playlists = useAppStore((s) => s.playlists);
  const loadTracks = useAppStore((s) => s.loadTracks);
  const loadPlaylists = useAppStore((s) => s.loadPlaylists);
  const deleteTrack = useAppStore((s) => s.deleteTrack);
  const toggleTrackFavorite = useAppStore((s) => s.toggleTrackFavorite);
  const playTrack = useAppStore((s) => s.playTrack);
  const reorderTracks = useAppStore((s) => s.reorderTracks);
  const deletePlaylist = useAppStore((s) => s.deletePlaylist);
  // 只订阅这两个原始值，不要订阅 nowPlaying 整个对象 —— 它里面的 positionMs
  // 每秒被 music-progress 覆写一次，订阅对象等于让整张曲目表每秒重画一遍
  const playingTrackId = useAppStore((s) => s.nowPlaying?.trackId);
  const musicPlaying = useAppStore((s) => s.nowPlaying?.playing ?? false);
  // 列表形态：single 原单列（信息列最全）/ multi 紧凑多列（一屏曲目数约 3.6 倍）
  const musicLayout = useAppStore((s) => s.musicLayout);
  const setMusicLayout = useAppStore((s) => s.setMusicLayout);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [sort, setSort] = useState<SortKey>('custom');
  const [showAddModal, setShowAddModal] = useState(false);
  const [menu, setMenu] = useState<{ t: Track; x: number; y: number } | null>(null);
  // 多选模式：右键「多选」进入，行显示复选框、单击切换勾选，右键变批量删除；工具栏有全选框
  const [multiSelect, setMultiSelect] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkMenu, setBulkMenu] = useState<{ x: number; y: number } | null>(null);
  // 新建歌单弹窗：非 null = 打开，值为创建后要一起加入的曲目 id
  const [showCreatePlaylist, setShowCreatePlaylist] = useState<string[] | null>(null);
  // 歌单 chip 右键菜单：删除歌单
  const [playlistMenu, setPlaylistMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sortRef = useRef<SortMenuHandle>(null);
  // 多列：列数由容器宽度实测（单列恒为 1），行高随形态变。下面所有几何都只认这两个值
  const multi = musicLayout === 'multi';
  const [cols, setCols] = useState(1);
  const rowH = multi ? ROW_H_MULTI : ROW_H_SINGLE;
  // 切换形态时保留「首个可见曲目」：像素偏移在两种布局里对应的曲目能差几十首，
  // 不锚回去就是换一次布局跳一次位置
  const anchorRef = useRef<number | null>(null);

  // 列数 = 容器内容宽能放下几个 MIN_COL_W。切换形态和窗口缩放都走这一个算法
  const measureCols = (isMulti: boolean) => {
    const el = listRef.current;
    if (!isMulti || !el) return 1;
    const contentW = el.clientWidth - PAD_X * 2;
    const n = Math.floor((contentW + COL_GAP) / (MIN_COL_W + COL_GAP));
    return Math.max(1, Math.min(MAX_COLS, n));
  };
  // 窗口缩放时重算列数（单列模式不挂观察器）
  useLayoutEffect(() => {
    if (!multi) { setCols(1); return; }
    const el = listRef.current;
    if (!el) return;
    const remeasure = () => setCols(measureCols(true));
    remeasure();
    const ro = new ResizeObserver(remeasure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [multi]);

  useEscIntercept(!!menu || !!bulkMenu || !!playlistMenu);

  useEffect(() => { void loadTracks(); }, [loadTracks]);
  useEffect(() => { void loadPlaylists(); }, [loadPlaylists]);

  // 右键菜单 / 多选批量菜单 / 歌单右键菜单：点击别处 / Esc 关闭
  useEffect(() => {
    if (!menu && !bulkMenu && !playlistMenu) return;
    const close = () => { setMenu(null); setBulkMenu(null); setPlaylistMenu(null); };
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
  }, [menu, bulkMenu, playlistMenu]);

  // ─── 列表：搜索 + 收藏/歌单筛选 + 排序（前端本地，曲目量级无需后端） ───
  // 当前筛选的歌单（filter = "playlist:<id>"）；track_ids 集合供本地过滤
  const activePlaylist = filter.startsWith('playlist:')
    ? playlists.find((p) => p.id === filter.slice('playlist:'.length)) ?? null
    : null;
  const activePlaylistSet = useMemo(() => new Set(activePlaylist?.track_ids ?? []), [activePlaylist]);
  // custom = 后端 sort_order 顺序（不 sort），仅在此排序且无搜索/筛选时允许拖动
  const baseList = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = tracks.filter((t) => {
      if (q && ![t.title, t.artist, t.album].some((f) => (f || '').toLowerCase().includes(q))) {
        return false;
      }
      if (filter === 'favorite') return t.favorite;
      if (filter.startsWith('playlist:')) return activePlaylistSet.has(t.id);
      return true;
    });
    const byText = (a: string, b: string) => a.localeCompare(b, 'zh-Hans-CN');
    return [...matched].sort((a, b) => {
      switch (sort) {
        case 'title': return byText(a.title, b.title);
        case 'artist': return byText(a.artist || '', b.artist || '') || byText(a.title, b.title);
        case 'album': return byText(a.album || '', b.album || '') || a.track_number - b.track_number;
        case 'custom': return 0; // 保持后端 sort_order 顺序（稳定排序，原序不变）
        default: return byText(b.created_at || '', a.created_at || '') || byText(a.title, b.title);
      }
    });
  }, [tracks, query, filter, sort, activePlaylistSet]);

  // ─── 拖拽排序（仿游戏库：指针命中纯几何、工作副本实时重排、松手持久化） ───
  const [drag, setDrag] = useState<{
    id: string; from: number; x: number; y: number; startX: number; startY: number;
    grabDX: number; grabDY: number; width: number; rowH: number; active: boolean;
  } | null>(null);
  const [liveTracks, setLiveTracks] = useState<Track[] | null>(null);
  const [everDragged, setEverDragged] = useState(false);
  const dragRef = useRef<NonNullable<typeof drag>>(null);
  const liveRef = useRef<Track[] | null>(null);
  // 工作副本的 ref 和 state 必须成对更新：ref 给几何计算读（同步、不等渲染），
  // state 给克隆渲染读。手写两行曾漏掉其中一半 → 小范围拖拽时那一项直接消失
  const setLiveBoth = (arr: Track[] | null) => { liveRef.current = arr; setLiveTracks(arr); };
  const dragEnabled = sort === 'custom' && !query.trim() && filter === 'all' && !multiSelect;
  // 只有真正激活拖拽（移动超 4px）才屏蔽指针事件 —— pointerdown 未激活时若加
  // music-dragging，.music-dragging .music-row 的 pointer-events:none 会吞掉 click，
  // 点击行就无法播放/多选了
  const dragging = drag?.active === true;
  const displayList = liveTracks ?? baseList;

  // ─── 入场动画 ─────────────────────────────
  // 入场动画只属于「视图刚出现的首屏那批行」，不属于某一行。虚拟滚动下行会反复挂载，
  // 所以有两条硬约束：
  //   1) 延迟必须按绝对行号算。用「本批虚拟行里的序号」算的话，批次窗口一滑动，
  //      已挂载行的 animation-delay 就被改写 —— 浏览器会重算动画本地时间、把运行中
  //      的动画拽回起始相位，整行连封面一起重闪一遍
  //   2) 只有首屏那批行能拿动画。music-row-reveal 是 both 填充，延迟期内 opacity:0；
  //      滚动挂载进来的行若也加动画，行号一大就是几百 ms 的透明期 —— 那正是
  //      「入场没播完往下滚一片空白」
  const [introCells, setIntroCells] = useState(0);
  const [introDone, setIntroDone] = useState(false);
  // 首屏能放几行。用 layout effect 而非 effect：它在首帧绘制前跑，setState 触发的
  // 重渲染也在绘制前完成。首帧 listRef 还是 null、虚拟化器量不到高度 → 一行都不渲染，
  // 所以不存在「先画了没动画的行、再补上动画」的闪
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) setIntroCells(Math.ceil(el.clientHeight / rowH) * cols);
  }, [rowH, cols]);
  // 每列速度不同，按实际首屏成员的最晚结束时间收尾，避免截断慢列。
  // 起算点是「行真正出现」而不是挂载，异步载入曲目也能完整播放入场。
  const hasRows = displayList.length > 0;
  const introEnd = useMemo(() => {
    let end = 0;
    const count = Math.min(introCells, displayList.length);
    for (let i = 0; i < count; i++) {
      const timing = musicIntro(Math.floor(i / cols), i % cols, multi);
      end = Math.max(end, timing.delay + timing.duration);
    }
    return end + 48;
  }, [introCells, displayList.length, cols, multi]);
  useEffect(() => {
    if (!introCells || !hasRows) return;
    const id = setTimeout(() => setIntroDone(true), introEnd);
    return () => clearTimeout(id);
  }, [introCells, hasRows, introEnd]);

  // ─── 指针高亮 ─────────────────────────────
  // 不走 CSS :hover —— Chromium 滚动时不刷新 hover 命中测试，滚轮滚动会把高亮
  // 粘在滚动前那一行；而用「滚动中禁 hover」的 CSS 去压它，又会连 JS 点亮的行
  // 一起压掉（两条规则抢同一个 background-color，禁 hover 那条特异性更高）。
  //
  // 滚动跑在合成器线程上，主线程收到 scroll 事件时画面已经滚过去了 —— 无论
  // 用 rAF 还是同步处理，主线程改高亮至少晚一帧。这一帧里旧行的高亮跟着内容
  // 滑走，下一帧才跳回指针处，连续滚动就成了闪烁。所以滚动期间干脆不亮，
  // 停下来立刻亮在指针所在行（比原生 :hover 还准 —— 它得等鼠标动一下才更新）。
  //
  // 高亮块放在滚动容器外面（外壳的 absolute 定位），滚动不会平移它：滚动第一帧
  // 那个还没来得及熄灭的高亮是原地不动的，肉眼无感；若把它放进滚动内容里，
  // 这一帧它会跟着内容滑出一整格，那正是之前看到的残影
  const hlRef = useRef<HTMLDivElement>(null);
  const ptrClientYRef = useRef<number | null>(null);
  const ptrClientXRef = useRef<number | null>(null);
  const ptrInListRef = useRef(false);
  const scrollingRef = useRef(false);
  const scrollIdleRef = useRef(0);
  const hlRafRef = useRef(0);
  const hideHl = () => {
    const hl = hlRef.current;
    if (hl) hl.style.opacity = '0';
  };
  const paintHl = () => {
    hlRafRef.current = 0;
    const hl = hlRef.current;
    const el = listRef.current;
    if (!hl || !el) return;
    const y = ptrClientYRef.current;
    // 滚动中 / 拖拽中 / 指针不在列表 / 空列表 → 不亮
    if (scrollingRef.current || y === null || !ptrInListRef.current
      || dragRef.current !== null || displayList.length === 0) { hideHl(); return; }
    const rect = el.getBoundingClientRect();
    const x = ptrClientXRef.current;
    // 指针压在滚动条上（容器右缘）：拖滚动条时 坐标→格 的映射没有意义，不亮
    if (x !== null && x > rect.right - 14) { hideHl(); return; }
    // 列宽按容器实际内容宽算（clientWidth 已不含滚动条，出现/消失时每次重算）
    const contentW = el.clientWidth - PAD_X * 2;
    const slotW = (contentW - COL_GAP * (cols - 1)) / cols;
    const row = Math.floor((y - rect.top + el.scrollTop) / rowH);
    const col = cols === 1 ? 0 : Math.max(0, Math.min(cols - 1,
      Math.floor(((x ?? rect.left + PAD_X) - rect.left - PAD_X) / (slotW + COL_GAP))));
    const cur = row * cols + col;
    // 行号越界、或末行右侧那些没有曲目的空格 → 不亮
    if (row < 0 || cur < 0 || cur >= displayList.length) { hideHl(); return; }
    hl.style.top = `${row * rowH - el.scrollTop}px`;
    hl.style.left = `${PAD_X + col * (slotW + COL_GAP)}px`;
    hl.style.width = `${slotW}px`;
    hl.style.height = `${rowH - 2}px`;
    hl.style.opacity = '1';
  };
  const scheduleHl = () => { if (!hlRafRef.current) hlRafRef.current = requestAnimationFrame(paintHl); };
  const endScrolling = () => {
    if (scrollIdleRef.current) { window.clearTimeout(scrollIdleRef.current); scrollIdleRef.current = 0; }
    scrollingRef.current = false;
    paintHl();
  };
  const onListScroll = () => {
    // 首次滚动即结束入场：首屏行往回滚会重挂载，窗口还没过期的话会再播一次动画
    // （= 又一次空白）。已在动画中的行随类名撤销直接落到终态，不闪
    if (!introDone) setIntroDone(true);
    scrollingRef.current = true;
    hideHl(); // 同步熄灭，不等 rAF
    if (scrollIdleRef.current) window.clearTimeout(scrollIdleRef.current);
    scrollIdleRef.current = window.setTimeout(endScrolling, 90); // scrollend 的兜底
  };
  const onListPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
    const moved = e.clientX !== ptrClientXRef.current || e.clientY !== ptrClientYRef.current;
    ptrClientXRef.current = e.clientX;
    ptrClientYRef.current = e.clientY;
    ptrInListRef.current = true;
    // 鼠标真的动了 → 用户在指，立刻恢复高亮。滚动后浏览器补发的 mousemove
    // 坐标没变，不会误判成「鼠标动了」
    if (moved && scrollingRef.current) endScrolling();
    else scheduleHl();
  };
  const onListPointerLeave = () => {
    ptrInListRef.current = false;
    hideHl(); // 同步灭掉，不等下一帧
  };
  // 列表内容变了（搜索/排序/删除）→ 原行号失配，按当前指针位置重算一次
  useEffect(() => { paintHl(); }, [displayList.length, rowH, cols]);
  // scrollend：滚动真正停止（含惯性尾段）时立刻恢复高亮，比 90ms 兜底快
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.addEventListener('scrollend', endScrolling);
    return () => {
      el.removeEventListener('scrollend', endScrolling);
      if (hlRafRef.current) cancelAnimationFrame(hlRafRef.current);
      if (scrollIdleRef.current) window.clearTimeout(scrollIdleRef.current);
    };
  }, []);

  // 虚拟滚动：172+ 曲全量渲染约 3k DOM 节点，每次重渲染都要重建整棵树。
  // 单列一行一曲、多列一行 cols 曲；行高固定（rowH）不需要动态测量
  const rowVirtualizer = useVirtualizer({
    count: Math.ceil(displayList.length / cols),
    getScrollElement: () => listRef.current,
    estimateSize: () => rowH,
    // 滚轮快滑时原生滚动跑在 React 重渲染前面，窗口外无行可显 → 一片纯白（连文字都
    // 没有），停下才补齐。治它就是把 overscan 缓冲放大：每行的重活（封面 fetch / 解码）
    // 都在 useEffect 里、发生在「绘制之后」，渲染阶段本身很轻，所以多备几行几乎不花钱、
    // 是划算的。单列一行一曲，缓冲给到 24 最划算；多列一行 cols 曲、同样行数 DOM 翻几倍，
    // 收敛到 16。封面请求再多也由 CoverImg 的并发闸兜住，不会因此拥塞
    overscan: multi ? 16 : 24,
  });

  // 行高/列数变了：virtualizer 不会自己重跑 estimateSize，必须显式 measure，
  // 否则总高度和每行 start 还是旧行高算出来的（行会重叠或留大片空白）。
  // 紧接着把切换前记下的曲目锚回视口 —— measure 的新测量值要等一帧才可用
  useLayoutEffect(() => {
    rowVirtualizer.measure();
    const a = anchorRef.current;
    if (a === null) return;
    anchorRef.current = null;
    const id = requestAnimationFrame(() => {
      rowVirtualizer.scrollToIndex(Math.floor(a / cols), { align: 'start' });
    });
    return () => cancelAnimationFrame(id);
  }, [rowH, cols]);

  // 切换形态：先记下首个可见曲目的绝对序号，换完由上面的 effect 滚回去。
  // cols 必须和形态同一批次更新 —— 留给 ResizeObserver 晚一帧设的话，
  // 上面的 effect 会先用旧列数把 anchor 折算一遍（切一次跳一次）
  const toggleLayout = () => {
    const first = rowVirtualizer.getVirtualItems()[0];
    anchorRef.current = first ? first.index * cols : 0;
    const next = multi ? 'single' : 'multi';
    setCols(measureCols(next === 'multi'));
    setMusicLayout(next);
  };

  // 目标槽位 = 被拖行中心映射到固定网格几何（纯几何，与数组顺序无关 → 无反馈回路）。
  // 行按 rowH、列按槽宽，与虚拟滚动 estimateSize / 悬停高亮同源（都取 rowH、cols）
  const getTargetIndex = (d: NonNullable<typeof drag>, len: number): number => {
    const el = listRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const centerY = d.y - d.grabDY + d.rowH / 2 - rect.top + el.scrollTop;
    const row = Math.floor(centerY / rowH);
    let col = 0;
    if (cols > 1) {
      const contentW = el.clientWidth - PAD_X * 2;
      const slotW = (contentW - COL_GAP * (cols - 1)) / cols;
      const centerX = d.x - d.grabDX + d.width / 2 - rect.left - PAD_X;
      col = Math.max(0, Math.min(cols - 1, Math.floor(centerX / (slotW + COL_GAP))));
    }
    let idx = row * cols + col;
    // 末行右侧的空格（没有曲目）→ 视为末尾，否则会把被拖行卡在不存在的槽位上
    if (row >= Math.ceil(len / cols) - 1 && col >= (len % cols || cols)) idx = len - 1;
    return Math.max(0, Math.min(len - 1, idx));
  };

  const handleRowPointerDown = (e: React.PointerEvent, t: Track) => {
    if (!dragEnabled || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return; // 收藏按钮不触发拖拽
    // 注意：不能 e.preventDefault() —— 它会吞掉后续 click，导致点击行播放/多选失效。
    // 原生拖拽/文本选择由行上的 draggable={false} + select-none 阻止
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const from = baseList.findIndex((x) => x.id === t.id);
    const d: NonNullable<typeof drag> = {
      id: t.id, from: from < 0 ? 0 : from,
      x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY,
      grabDX: e.clientX - r.left, grabDY: e.clientY - r.top,
      width: r.width, rowH: r.height, active: false,
    };
    setDrag(d); dragRef.current = d;
    // 工作副本推迟到真正开始拖动时再建（onDragPointerMove 4px 阈值后）：
    // pointerdown 就 setLiveTracks 会让列表整份重渲染（入场动画重播 = 看起来像刷新）
    // 监听挂载/移除见下方 useEffect（window 级：拖拽行重挂载会丢 setPointerCapture）
  };

  const onDragPointerMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // 4px 阈值内视为点击（不建工作副本、不激活拖拽）
    if (!d.active && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
    if (!d.active) {
      // 真正开始拖动才建工作副本（避免点击时整列表重渲染 = 假刷新）。
      // 必须同时进 state：原行在 drag.active 那一刻就被 .drag-src 隐藏，而克隆
      // 渲染读的是 liveTracks —— 只设 ref 的话，从激活到第一次跨槽位之间
      // 「原行已隐」+「克隆未出」= 那一项凭空消失（多列下换列要横移一整个列宽，
      // 这个窗口大到几乎每次小幅拖拽都能看见）
      if (liveRef.current === null) setLiveBoth([...baseList]);
    }
    const el = listRef.current!;
    const rect = el.getBoundingClientRect();
    // 边缘自动滚动
    if (e.clientY < rect.top + 40) el.scrollBy({ top: -24 });
    else if (e.clientY > rect.bottom - 40) el.scrollBy({ top: 24 });
    const next = { ...d, x: e.clientX, y: e.clientY };
    if (!next.active) setEverDragged(true); // 首次激活后永久抑制入场动画重播
    const live = liveRef.current;
    if (next.active && live) {
      // 实时重排：目标槽位（纯几何）变化 → 被拖行就地移动，松手时布局零变化
      const target = getTargetIndex(next, live.length);
      const cur = live.findIndex((x) => x.id === d.id);
      if (target !== cur) {
        const nextArr = [...live];
        const [moved] = nextArr.splice(cur, 1);
        nextArr.splice(target, 0, moved);
        setLiveBoth(nextArr);
      }
    }
    setDrag({ ...next, active: true }); dragRef.current = { ...next, active: true };
  };

  const onDragPointerUp = async () => {
    const d = dragRef.current;
    dragRef.current = null; // 收尾统一置空：残留的 ref 会让结束后的幽灵监听继续当 active 拖拽处理
    if (!d) return;
    const live = liveRef.current;
    setDrag(null); setLiveBoth(null);
    // 数组已是最终顺序，只需持久化（store 先本地重排再写入，失败自行回滚）
    if (d.active && live && d.from !== live.findIndex((x) => x.id === d.id)) {
      await reorderTracks(live.map((t) => t.id));
    }
  };

  const onDragKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { // 取消：丢弃工作数组，回到后端顺序
      dragRef.current = null;
      setDrag(null); setLiveBoth(null);
    }
  };

  const onDragCancel = () => {
    dragRef.current = null;
    setDrag(null); setLiveBoth(null);
  };

  // 拖拽监听挂在 window 上，随「是否有拖拽」挂/卸（与 SeriesView 同款写法）：
  // 依赖用布尔 !!drag 而非对象 —— 拖拽过程 x/y/active 每帧变，依赖对象会每帧卸载重挂。
  // 挂载从 pointerdown（drag 非空）开始：4px 阈值激活的判断在 onDragPointerMove 里。
  // effect 不随拖拽中的 state 变化重跑，cleanup 与挂载是同一渲染闭包，add/remove 引用一致；
  // 旧写法在 pointerdown 里 add、重渲染后的 cleanupDrag 来 remove —— 引用不同，
  // 监听永久残留：每次拖拽泄漏 4 个 + 拖拽结束后幽灵滚动（鼠标在列表边缘时列表自己滚）
  useEffect(() => {
    if (!drag) return;
    // window 级监听：拖拽行重挂载会丢 setPointerCapture，不能用
    window.addEventListener('pointermove', onDragPointerMove);
    window.addEventListener('pointerup', onDragPointerUp);
    window.addEventListener('keydown', onDragKeyDown);
    window.addEventListener('blur', onDragCancel);
    return () => {
      window.removeEventListener('pointermove', onDragPointerMove);
      window.removeEventListener('pointerup', onDragPointerUp);
      window.removeEventListener('keydown', onDragKeyDown);
      window.removeEventListener('blur', onDragCancel);
    };
  }, [!!drag]);

  // 手柄焦点：列表组（上下选，A 播放）
  // 手柄焦点：列表组（上下选，A 播放）。无 leave —— 十字键在列表顶部/底部停在边界，
  // 移不到顶部导航行（游戏库/影视库/音乐库 tab 那行）；切库走肩键
  useGamepadGroup('music-list', {
    count: displayList.length,
    cols,
    activate: (i) => { const t = displayList[i]; if (t) handlePlay(t); },
    // 虚拟滚动下屏外行不在 DOM 里，必须走 virtualizer 定位；多列时序号要先折成行号
    // （旧写法 listRef.children[i] 取到的是包裹层而非行，一直没生效过）
    scrollIntoView: (i) => rowVirtualizer.scrollToIndex(Math.floor(i / cols), { align: 'auto' }),
  });
  const listFocused = useFocusIndex('music-list');
  // 右摇杆滚动目标：音乐库列表容器
  useRightStickScroll(listRef);

  // 播放：以当前排序/筛选列表为队列，从这首开始（mpv video=no，ZEX 留在前台）
  // 参数名用 track：组件里已有翻译函数 t，避免遮蔽
  const handlePlay = (track: Track) => {
    // playMusic 失败（播放器没响应）时后端不会切歌 —— 进度条保持旧曲，提示用户重试，
    // 而不是界面切到新歌、进度却永远不动（trackId 对不上被进度事件忽略）
    playTrack(track, displayList).catch((err) => {
      void message(t('music.playFailed', { msg: String(err) }), { title: t('music.playTitle'), kind: 'error' });
    });
  };

  const handleDelete = async (track: Track) => {
    const ok = await ask(t('music.removeConfirm', { title: track.title }), {
      title: t('music.removeTrackTitle'), kind: 'warning',
    });
    if (!ok) return;
    try {
      await deleteTrack(track.id);
    } catch (err) {
      void message(t('music.removeFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
    }
  };

  // ─── 多选 ───
  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const allSelected = displayList.length > 0 && displayList.every((t) => selected.has(t.id));
  const toggleSelectAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) displayList.forEach((t) => next.delete(t.id));
      else displayList.forEach((t) => next.add(t.id));
      return next;
    });
  };
  const exitMultiSelect = () => {
    setMultiSelect(false);
    setSelected(new Set());
    setBulkMenu(null);
  };
  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    const ok = await ask(t('music.removeSelectedConfirm', { n: selected.size }), {
      title: t('music.removeTrackTitle'), kind: 'warning',
    });
    if (!ok) return;
    for (const id of selected) {
      try { await deleteTrack(id); } catch (err) {
        void message(t('music.removeFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
        break;
      }
    }
    setSelected(new Set());
    setMultiSelect(false);
    setBulkMenu(null);
  };

  // 歌单 chip 右键「删除歌单」：直接销毁（仅删歌单，不动曲目）；删的是当前筛选的歌单则切回全部
  const handleDeletePlaylist = async (id: string) => {
    const pl = playlists.find((p) => p.id === id);
    setPlaylistMenu(null);
    if (!pl) return;
    try {
      await deletePlaylist(id);
      if (filter === `playlist:${id}`) setFilter('all');
    } catch (err) {
      void message(t('music.deletePlaylistFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
    }
  };

  return (
    <div
      className="h-full flex flex-col"
      onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
    >
      {/* ─── 工具栏 ──────────────────────────── */}
      {/* 空库时与影视库一致：整页只显示空态，工具栏不出现（空态自带「添加音乐」按钮） */}
      {tracks.length > 0 && (
      <div className="shrink-0 px-6 py-4 flex items-center gap-3 flex-wrap">
        <button className="btn btn-accent gap-2 text-sm" onClick={() => setShowAddModal(true)}>
          <Plus size={15} />
          {t('music.addMusic')}
        </button>

        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('music.searchPlaceholder')}
            className="input search-input text-sm"
          />
        </div>

        <div className="flex items-center gap-1.5">
          {([
            { key: 'all' as const, label: 'common.all' },
            { key: 'favorite' as const, label: 'music.favorite' },
            // 歌单和收藏一个道理：每个歌单一个 chip，点选即筛选该歌单曲目；右键 chip 可删歌单
            ...playlists.map((p) => ({ key: `playlist:${p.id}` as const, label: p.name, playlistId: p.id })),
          ]).map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              onContextMenu={(e) => {
                // 右键歌单 chip → 歌单管理菜单（删除）；stopPropagation 防 window contextmenu 关闭监听立刻收起
                if ('playlistId' in f) {
                  e.preventDefault();
                  e.stopPropagation();
                  setPlaylistMenu({ id: f.playlistId, x: e.clientX, y: e.clientY });
                }
              }}
              className={clsx('chip max-w-[9rem] truncate', filter === f.key && 'active')}
              title={'playlistId' in f ? f.label : t(f.label)}
            >
              {'playlistId' in f ? f.label : t(f.label)}
            </button>
          ))}
        </div>

        {multiSelect ? (
          <div className="ml-auto flex items-center gap-2.5">
            <button onClick={toggleSelectAll} className={clsx('chip', allSelected && 'active')}>
              {allSelected ? <CheckSquare size={13} /> : <Square size={13} />}
              {t('music.selectAll')}
            </button>
            <span className="text-xs text-text-tertiary tabular-nums">{t('music.selectedCount', { n: selected.size })}</span>
            <button onClick={exitMultiSelect} className="chip">
              {t('music.exitMultiSelect')}
            </button>
          </div>
        ) : (
          <div className="ml-auto flex items-center gap-2.5">
            <span className="text-xs text-text-tertiary tabular-nums">{t('music.trackCount', { n: tracks.length })}</span>
            {/* 列表形态切换：与排序按钮同款胶囊，显示的是「当前」形态 */}
            <button
              onClick={toggleLayout}
              className="sort-trigger"
              title={t('music.layoutSwitchTo', { mode: multi ? t('music.layoutSingle') : t('music.layoutMulti') })}
            >
              {multi ? <LayoutGrid size={14} /> : <Rows3 size={14} />}
              <span className="font-medium text-text-primary">{multi ? t('music.layoutMulti') : t('music.layoutSingle')}</span>
            </button>
            <SortMenu
              ref={sortRef}
              value={sort}
              options={SORTS}
              onChange={(k) => setSort(k as SortKey)}
            />
          </div>
        )}
      </div>
      )}

      {/* ─── 曲目列表 ────────────────────────── */}
      {/* 外壳不滚动：只作为指针高亮块的定位参照和裁剪框。高亮块必须待在滚动内容
          外面，否则滚动会把它跟着内容一起平移（见 paintHl 上方注释） */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
      <div ref={hlRef} className="music-hl" aria-hidden />
      <div ref={listRef}
        onScroll={onListScroll}
        onPointerMove={onListPointerMove}
        onPointerEnter={() => { ptrInListRef.current = true; }}
        onPointerLeave={onListPointerLeave}
        className={clsx('h-full overflow-y-auto px-6 pb-6', dragging && 'music-dragging', everDragged && 'music-drag-suppress')}>
        {tracks.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-6">
            <div className="empty-orb"><Music size={38} /></div>
            <div className="text-center">
              <p className="text-xl font-bold mb-2">{t('music.emptyTitle')}</p>
              <p className="text-sm text-text-tertiary">{t('music.emptyDesc')}</p>
            </div>
            <button className="btn btn-accent gap-2 px-6 py-3 text-sm" onClick={() => setShowAddModal(true)}>
              <Plus size={16} />
              {t('music.addMusic')}
            </button>
          </div>
        ) : displayList.length === 0 ? (
          <div className="py-20 flex flex-col items-center gap-3">
            <Search size={32} className="text-text-tertiary" />
            <p className="text-sm text-text-secondary">{t('music.noMatch')}</p>
          </div>
        ) : (
          <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
            {rowVirtualizer.getVirtualItems().map((vRow) => {
              // 单列一行一曲；多列一行 cols 曲（末行可能不满）
              const rowStart = vRow.index * cols;
              const rowTracks = displayList.slice(rowStart, rowStart + cols);
              if (rowTracks.length === 0) return null;
              return (
              // 外层只管虚拟定位与分列：入场动画会动 transform，
              // 与定位 transform 写在同一元素上会互相覆盖 → 行飞到错位置
              <div
                key={vRow.key}
                className="absolute left-0 right-0 top-0 grid"
                style={{
                  height: rowH - 2,
                  transform: `translateY(${vRow.start}px)`,
                  gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                  columnGap: COL_GAP,
                }}
              >
                {rowTracks.map((trk, colIdx) => {
                  const idx = rowStart + colIdx;
                  // 以绝对行列取节奏，虚拟窗口移动时不会改写同一首曲目的延迟。
                  const introCell = !everDragged && !introDone && idx < introCells;
                  const intro = musicIntro(vRow.index, colIdx, multi);
                  return (
                  <div
                    key={trk.id}
                    className={clsx(
                      // 行本身不带 hover 背景 —— 悬停高亮由列表外壳上的 .music-hl
                      // 高亮块负责（CSS :hover 在滚动时不刷新，会粘在旧行上）
                      'music-row group flex items-center h-full rounded-xl border border-transparent cursor-pointer',
                      multi ? 'gap-2.5 px-3' : 'gap-3 px-4',
                      introCell && 'music-row-enter',
                      dragEnabled && 'touch-none select-none', // 拖拽时防原生拖拽/选字；光标保持 pointer（点击=播放）
                      drag?.active && drag.id === trk.id && 'cursor-grabbing', // 正在拖动的行显示抓握
                      idx === listFocused && 'gamepad-focus',
                      drag?.active && drag.id === trk.id && 'drag-src',
                      trk.id === playingTrackId && 'music-row-playing', // 当前播放行：底色 + 左侧竖条
                    )}
                    style={introCell ? {
                      animationDelay: `${intro.delay}ms`,
                      animationDuration: `${intro.duration}ms`,
                      '--music-enter-x': `${intro.x}px`,
                      '--music-enter-y': `${intro.y}px`,
                    } as CSSProperties : undefined}
                    onClick={() => {
                      if (multiSelect) toggleSelect(trk.id);
                      else handlePlay(trk);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (multiSelect) setBulkMenu({ x: e.clientX, y: e.clientY });
                      else setMenu({ t: trk, x: e.clientX, y: e.clientY });
                    }}
                    onPointerDown={dragEnabled ? (e) => handleRowPointerDown(e, trk) : undefined}
                  >
                    {/* 多选复选框 */}
                    {multiSelect && (
                      <span className="w-5 shrink-0 flex items-center justify-center">
                        {selected.has(trk.id)
                          ? <CheckSquare size={16} className="text-[#00d4ff]" />
                          : <Square size={16} className="text-text-tertiary" />}
                      </span>
                    )}

                    {/* 封面 / 默认图标 */}
                    <div className={clsx(
                      'relative rounded-lg overflow-hidden shrink-0 bg-bg-surface border border-border-glass flex items-center justify-center',
                      multi ? 'w-10 h-10' : 'w-11 h-11',
                    )}>
                      {trk.cover_path ? (
                        // 行挂载时就在视口内（虚拟滚动 overscan 保证），lazy 只延迟解码调度
                        // —— 快速滚动停下时全视口同时补解码。eager 挂载即解码；CoverImg
                        // 提供内存缓存层（滚动回来零协议往返出图）
                        <CoverImg src={coverSrc(trk.cover_path, trk.updated_at)} alt="" loading="eager" decoding="async" className="w-full h-full object-cover" draggable={false} />
                      ) : (
                        <Music2 size={multi ? 18 : 20} className="text-text-tertiary" />
                      )}
                      {/* 正在播放：封面上盖三根跳动的均衡器竖条。暂停时条不动（animation-play-state），
                          一眼能分清「这首在放」和「这首停在这儿」 */}
                      {trk.id === playingTrackId && (
                        <span className={clsx('eq-badge', !musicPlaying && 'paused')} aria-hidden>
                          <i /><i /><i />
                        </span>
                      )}
                    </div>

                    {/* 歌名 / 歌手 / 专辑艺术家 */}
                    <div className="flex-1 min-w-0">
                      <p className={clsx(
                        'truncate font-medium',
                        multi ? 'text-sm' : 'text-base',
                        trk.id === playingTrackId ? 'text-accent' : 'text-text-primary',
                      )}>{trk.title}</p>
                      <p className={clsx('truncate text-text-secondary', multi ? 'text-xs' : 'text-sm')}>
                        {(trk.artist || t('music.unknownArtist'))}
                        {trk.album_artist && trk.album_artist !== trk.artist ? ` · ${trk.album_artist}` : ''}
                      </p>
                    </div>

                    {/* 专辑 / 比特率：多列下一列才 600 来宽，这两列挤掉的是曲名和歌手，只在单列显示 */}
                    {!multi && (
                      <span className="hidden md:block w-72 truncate text-xs text-text-secondary">{trk.album || t('music.unknownAlbum')}</span>
                    )}
                    {!multi && (
                      <span className="hidden xl:block w-20 shrink-0 text-right text-[11px] text-text-tertiary tabular-nums">
                        {trk.bitrate > 0 ? `${trk.bitrate} kbps` : ''}
                      </span>
                    )}

                    {/* 时长 */}
                    <span className={clsx(
                      'text-right text-xs text-text-tertiary tabular-nums',
                      multi ? 'w-12 shrink-0' : 'w-14',
                    )}>{fmtTime(trk.duration_seconds)}</span>

                    {/* 操作：收藏 */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); void toggleTrackFavorite(trk.id); }}
                        className={clsx(
                          'rounded-lg flex items-center justify-center text-text-tertiary hover:text-yellow-400 hover:bg-bg-surface-active transition-all',
                          multi ? 'w-7 h-7' : 'w-8 h-8',
                        )}
                        title={trk.favorite ? t('music.unfavorite') : t('music.favorite')}
                      >
                        <Star
                          size={multi ? 14 : 15}
                          className={trk.favorite ? 'text-yellow-400' : ''}
                          fill={trk.favorite ? 'currentColor' : 'none'}
                        />
                      </button>
                    </div>
                  </div>
                  );
                })}
              </div>
              );
            })}
          </div>
        )}
      </div>
      </div>

      {/* 拖拽克隆：跟随指针（只保留封面/歌名/歌手，精简渲染） */}
      {drag?.active && liveTracks && createPortal(
        <div
          className="drag-clone"
          style={{
            // 宽克隆贴右缘会被视口裁掉 → 左边界内缩，保证整行可见
            left: Math.max(8, Math.min(drag.x - drag.grabDX, window.innerWidth - drag.width - 8)),
            top: drag.y - drag.grabDY,
            width: drag.width,
          }}
        >
          {(() => {
            const src = liveTracks.find((x) => x.id === drag.id);
            if (!src) return null;
            return (
              <div className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl glass-card border border-[#00d4ff]/40 shadow-xl">
                <div className="w-11 h-11 rounded-lg overflow-hidden shrink-0 bg-bg-surface border border-border-glass flex items-center justify-center">
                  {src.cover_path
                    ? <CoverImg src={coverSrc(src.cover_path, src.updated_at)} alt="" className="w-full h-full object-cover" draggable={false} />
                    : <Music2 size={20} className="text-text-tertiary" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="truncate text-base font-medium text-text-primary">{src.title}</p>
                  <p className="truncate text-sm text-text-secondary">{src.artist || t('music.unknownArtist')}</p>
                </div>
                {/* 与原行同宽的专辑列，克隆视觉对齐完整一行（多列下行里也没有这列） */}
                {!multi && (
                  <span className="hidden md:block w-72 shrink-0 truncate text-xs text-text-secondary">{src.album || t('music.unknownAlbum')}</span>
                )}
                <span className="w-14 shrink-0 text-right text-xs text-text-tertiary tabular-nums">{fmtTime(src.duration_seconds)}</span>
              </div>
            );
          })()}
        </div>,
        document.body,
      )}

      {/* 弹窗与菜单 */}
      {showAddModal && (
        <AddMusicModal onClose={() => setShowAddModal(false)} onSuccess={() => { void loadTracks(); }} />
      )}

      {menu && (
        <MusicContextMenu
          track={menu.t}
          x={menu.x}
          y={menu.y}
          onPlay={() => handlePlay(menu.t)}
          onDelete={() => void handleDelete(menu.t)}
          onMultiSelect={() => { setMultiSelect(true); setSelected(new Set([menu.t.id])); }}
          onNewPlaylist={(trackIds) => { setMenu(null); setShowCreatePlaylist(trackIds); }}
          onClose={() => setMenu(null)}
        />
      )}

      {/* 多选模式的右键菜单：新建歌单 / 添加到歌单 / 批量删除 */}
      {bulkMenu && createPortal(
        <div
          className="fixed z-[100]"
          style={{
            left: Math.max(8, Math.min(bulkMenu.x, window.innerWidth - 220)),
            top: Math.max(8, Math.min(bulkMenu.y, window.innerHeight - 150)),
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="glass-card w-56 py-1.5 animate-scale-in">
            <button onClick={() => { setBulkMenu(null); setShowCreatePlaylist([...selected]); }} className="context-menu-item">
              <ListPlus size={14} className="text-text-secondary" />
              {t('music.newPlaylist')}
            </button>
            {/* 没有歌单时没有可添加的目标，「添加到歌单」不显示（悬浮二级菜单往右展开） */}
            {playlists.length > 0 && (
              <AddToPlaylistFlyout trackIds={[...selected]} onClose={() => setBulkMenu(null)} />
            )}
            <div className="context-menu-divider" />
            <button onClick={() => void handleBulkDelete()} className="context-menu-item text-danger">
              <Trash2 size={14} />
              {t('music.deleteSelected', { n: selected.size })}
            </button>
          </div>
        </div>,
        document.body,
      )}

      {/* 新建歌单弹窗：创建后自动筛选到新歌单 */}
      {showCreatePlaylist !== null && (
        <CreatePlaylistModal
          initialTrackIds={showCreatePlaylist}
          onClose={() => setShowCreatePlaylist(null)}
          onCreated={(pl) => { setShowCreatePlaylist(null); setFilter(`playlist:${pl.id}`); exitMultiSelect(); }}
        />
      )}

      {/* 歌单 chip 右键菜单：删除歌单 */}
      {playlistMenu && createPortal(
        <div
          className="fixed z-[100]"
          style={{
            left: Math.max(8, Math.min(playlistMenu.x, window.innerWidth - 170)),
            top: Math.max(8, Math.min(playlistMenu.y, window.innerHeight - 56)),
          }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="glass-card w-40 py-1.5 animate-scale-in">
            <button onClick={() => void handleDeletePlaylist(playlistMenu.id)} className="context-menu-item text-danger">
              <Trash2 size={14} />
              {t('music.deletePlaylist')}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
