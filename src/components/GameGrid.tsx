import { useRef, useState, useEffect, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAppStore } from '../store';
import GameCard from './GameCard';
import GameFolderCard from './GameFolderCard';
import GameFolderPopover, { FOLDER_GAME_CARD_WIDTH, type FolderDragInfo } from './GameFolderPopover';
import FolderCoverModal from './FolderCoverModal';
import GameContextMenu from './GameContextMenu';
import GameFolderContextMenu from './GameFolderContextMenu';
import GameFolderNameModal from './GameFolderNameModal';
import CoverPickerModal from './CoverPickerModal';
import GameRestoreDialog from './GameRestoreDialog';
import LibraryContextMenu from './LibraryContextMenu';
import { Plus, Gamepad2, FileArchive } from 'lucide-react';
import { message } from '@tauri-apps/plugin-dialog';
import type { Game, GameFolder } from '../types';
import { clsx } from 'clsx';
import { useEscIntercept } from '../utils/escIntercept';
import { useFocusIndex, useGamepadGroup } from '../gamepad';
import { buildLibraryLayout, folderGames, slotOf } from '../utils/libraryCells';
import { useT } from '../i18n';

interface Props {
  /** 本视图要展示的游戏（顶层传全部可见游戏，布局自己把文件夹成员摘出去） */
  games: Game[];
  /** 顶层文件夹 */
  folders: GameFolder[];
  /** 平铺模式：搜索 / 收藏筛选，按顺序铺满、不留空格、不显示文件夹 */
  flat?: boolean;
  onLaunch: (id: string) => void;
  columns?: number;
  onAddGame?: () => void;
  onOpenSteam?: () => void;
  onImportArchive?: () => void;
  onOpenDiskManager?: () => void;
  /** 右键「帧数设置…」：打开帧数面板并选中该游戏 */
  onOpenFpsSettings?: (gameId: string) => void;
}

// 拖拽状态：live reorder（实时重排）——拖拽期间工作副本随时等于最终状态，
// 卡片直接在网格布局中流动（零 transform 位移），松手时布局零变化 → 结构上不可能抽动
interface DragState {
  key: string;      // 被拖的格子（g:<id> / f:<id>）
  kind: 'game' | 'folder';
  fromSlot: number; // 起始格号（判断是否真正移动过）
  x: number;
  y: number;
  startX: number;
  startY: number;
  grabDX: number;   // 指针在卡片内的抓取偏移（克隆跟随用）
  grabDY: number;
  width: number;    // 原始卡片宽高（克隆保持一致）
  height: number;
  active: boolean;  // 是否超过 4px 阈值（低于阈值视为点击）
}

// 拖拽工作副本：一张卡的位置就是它的格号，拖拽期间直接改副本里的 slot，松手就是要持久化的东西
interface LiveState {
  games: Game[];
  folders: GameFolder[];
}

// 把某一格（g:<id> / f:<id>）的格号改掉。游戏与文件夹共用一个格号空间，所以按 key 前缀分流
function setSlotIn(w: LiveState, key: string, slot: number): LiveState {
  const id = key.slice(2);
  if (key.startsWith('f:')) {
    return { games: w.games, folders: w.folders.map((f) => (f.id === id ? { ...f, slot } : f)) };
  }
  return { games: w.games.map((g) => (g.id === id ? { ...g, slot } : g)), folders: w.folders };
}

export default function GameGrid({
  games, folders, flat = false, onLaunch, columns = 8, onAddGame, onOpenSteam, onImportArchive,
  onOpenDiskManager, onOpenFpsSettings,
}: Props) {
  const t = useT();
  // 逐字段订阅：网格里有全部可见 GameCard，不能跟着无关字段重画
  const filter = useAppStore((s) => s.filter);
  const loadGames = useAppStore((s) => s.loadGames);
  const loadGameFolders = useAppStore((s) => s.loadGameFolders);
  const setLibrarySlots = useAppStore((s) => s.setLibrarySlots);
  const setGamesFolder = useAppStore((s) => s.setGamesFolder);
  const parentRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ game: Game; x: number; y: number; slot: number } | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ folder: GameFolder; x: number; y: number } | null>(null);
  // 命名弹窗：新建（右键游戏）/ 重命名（右键文件夹）。挂在网格上而不是菜单里 —— 菜单点完就卸载了
  const [nameModal, setNameModal] = useState<
    { mode: 'create'; initialName: string; gameIds: string[]; slot: number }
    | { mode: 'rename'; folderId: string; initialName: string }
    | null
  >(null);
  const [libMenu, setLibMenu] = useState<{ x: number; y: number } | null>(null);
  const [emptyAddMenu, setEmptyAddMenu] = useState(false);
  const [coverGame, setCoverGame] = useState<{ game: Game; kind: 'portrait' | 'wide' } | null>(null);
  const [restoreGame, setRestoreGame] = useState<Game | null>(null);
  // 打开的文件夹内容弹窗（点文件夹卡 / 右键菜单「打开文件夹」）
  const [folderViewId, setFolderViewId] = useState<string | null>(null);
  // 文件夹封面窗口（浮层头部「调整封面」打开）。存 id 不存对象：文件夹被解散 / 数据重载后自动关掉
  const [folderCoverId, setFolderCoverId] = useState<string | null>(null);
  const colCount = Math.max(1, columns);
  const rowHeight = 380;
  const gap = 16;
  // 滚动容器的左右内边距。拖拽命中判定（hitTest）要用它把指针坐标换算成
  // 网格内坐标，必须与下面容器实际渲染的 padding 是同一个值 —— 曾经这里写死 24（p-6）
  // 而容器是 px-[10px]，列判定整体偏 14px、列宽也算窄了 28px
  const padX = 10;

  // ─── 拖拽排序 ────────────────────────────
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const liveRef = useRef<LiveState | null>(null);
  // 拖到某个文件夹卡上 → 这一格变成「放进去」的落点（此时停止实时重排，布局不抖）
  const [dropFolderKey, setDropFolderKey] = useState<string | null>(null);
  const dropFolderRef = useRef<string | null>(null);
  // 外部游戏拖进「打开着的文件夹浮层」时的落点序号（0..成员数）：浮层据此空出一格把别的卡挤开，
  // 松手就把游戏插到这个序号。null = 没在往浮层里拖（或落到的是末尾 / 文件夹卡本身）
  const [folderInsert, setFolderInsert] = useState<number | null>(null);
  const folderInsertRef = useRef<number | null>(null);
  const setFolderInsertBoth = (i: number | null) => { folderInsertRef.current = i; setFolderInsert(i); };
  // ─── 从文件夹浮层往库里拖 ───
  // 浮层只管上报「拖的是谁、克隆卡在哪」，格号几何只有这边有。
  // 拖拽一开始就亮出格子（placing + 末尾预留行），卡片中心离开面板后实时让位、画落点框
  const [folderDragActive, setFolderDragActive] = useState(false);
  const [folderDropSlot, setFolderDropSlot] = useState<number | null>(null);
  const folderDragRef = useRef<FolderDragInfo | null>(null);
  // 落点格号（松手落位用）。state 那份是给渲染画框的 —— 拖到文件夹卡上时框不画，但格号仍要留着
  const folderDropSlotRef = useRef<number | null>(null);
  // 拖完那一下浏览器还会补发一个 click，落点正好是松手位置底下那张卡（重排后是哪张卡并不确定），
  // 按在「开始游戏」上拖动时这就是误启动 —— 拖拽一结束先按下这道闸，下一个宏任务再放开。
  // click 与 pointerup 属于同一次输入，必然落在这一拍里（与 SeriesView 的 suppressClick 同款）
  const suppressClickRef = useRef(false);
  const suppressClick = () => {
    suppressClickRef.current = true;
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
  };

  // 右键菜单 / 拖拽 / 文件夹弹窗开着时由它们消费 Esc，App 的全局「Esc=收托盘」让位
  useEscIntercept(!!menu || !!folderMenu || !!libMenu || emptyAddMenu);
  useEscIntercept(!!drag);
  const setLiveBoth = (v: LiveState | null) => { liveRef.current = v; setLive(v); };
  const setDropFolderBoth = (k: string | null) => { dropFolderRef.current = k; setDropFolderKey(k); };
  // 首次拖拽后永久抑制卡片入场动画（拖拽中切掉 animation:none 会让所有卡片重播渐出）
  const [everDragged, setEverDragged] = useState(false);
  // 入场动画只属于「视图刚出现的首屏那批卡」，不属于某张卡。虚拟滚动下卡片会反复挂载，
  // 所以有两条硬约束（与音乐库 MusicView 同源）：
  //   1) 延迟必须按绝对格号算。用「本批虚拟行里的序号」算的话，批次窗口一滑动，
  //      已挂载卡的 animation-delay 就被改写 —— 浏览器重算动画本地时间、把运行中的
  //      动画拽回起始相位，整张卡连封面一起重闪
  //   2) 只有首屏那批卡能拿动画。card-enter 是 both 填充，延迟期内 opacity:0；
  //      滚动挂载进来的卡若也加动画，格号一大就是几百 ms 的透明期 = 滚下去一片空白
  const [introCells, setIntroCells] = useState(0);
  const [introDone, setIntroDone] = useState(false);
  // 一格的实测宽度：文件夹卡要用它决定拼图墙摆几张
  const [cellWidth, setCellWidth] = useState(0);
  // 首屏放得下几格。layout effect：首帧绘制前跑，且首帧虚拟化器量不到高度、
  // 一张卡都不渲染，所以不存在「先画了没动画的卡再补动画」的闪
  useLayoutEffect(() => {
    const measure = () => {
      const el = parentRef.current;
      if (!el) return;
      setIntroCells(Math.ceil(el.clientHeight / (rowHeight + gap)) * colCount);
      setCellWidth((el.clientWidth - padX * 2 - gap * (colCount - 1)) / colCount);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [colCount]);

  // ─── 布局：文件夹钉在格号上，游戏顺序填空 ───
  // 拖拽中用工作副本算（指针一动就重算），否则用 props。末尾的空格只在拖拽时补出来：
  // 不补的话文件夹没法摆到现有内容之后，常驻又会让库底下永远挂着空白
  const dragging = drag?.active === true;
  // 库里亮出格子的两种来由：自己在拖，或文件夹浮层正在往外拖。
  // 两者都末尾预留**两行**空格：空槽会显成蓝色虚线方框（「可以放这」），只留一行的话
  // 内容行占满时就只看得见底下那一行，想留一格空着再放也没地方
  const gridHinting = dragging || folderDragActive;
  const slots = useMemo(
    () => buildLibraryLayout(live?.games ?? games, live?.folders ?? folders, {
      flat,
      colCount,
      padRows: gridHinting ? 2 : 0,
    }),
    [live, games, folders, flat, colCount, gridHinting],
  );

  // 窗口长度按首屏格数推（末格延迟 + 动画 300ms + 余量），写死短了会把尾部卡掐停在半透明
  const hasCards = slots.length > 0;
  useEffect(() => {
    if (!introCells || !hasCards) return;
    const id = setTimeout(() => setIntroDone(true), introCells * 35 + 420);
    return () => clearTimeout(id);
  }, [introCells, hasCards]);
  // 松手落位锁：与状态更新同一批次提交，确保禁过渡帧在 drop 提交时真正生效
  // （旧的命令式 classList.add 会在 React 重写 className 时被抹掉，从未生效过 → 松手一直抽动）
  const [dropLock, setDropLock] = useState(false);
  const setDragBoth = (d: DragState | null) => { dragRef.current = d; setDrag(d); };
  // 仅在自定义排序（默认）下可拖拽；搜索/筛选等模式禁用
  const dragEnabled = !filter.search && !filter.favorite;

  const rows = Math.ceil(slots.length / colCount);

  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight + gap,
    overscan: 3,
    // 封面是 2/3 宽高比，卡片高度随宽度变化，必须按实际测量值布局，否则行与行重叠
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  // ─── 文件夹内容弹窗 ────────────────────────
  const folderView = useMemo(
    () => (folderViewId ? folders.find((f) => f.id === folderViewId) ?? null : null),
    [folderViewId, folders],
  );
  // 弹窗里的成员（按文件夹内顺序）。取不到的 id 跳过 —— 与顶层布局同一套口径
  const folderViewGames = useMemo(
    () => (folderView ? folderGames(folderView, new Map(games.map((g) => [g.id, g]))) : []),
    [folderView, games],
  );
  // 文件夹被解散 / 数据重载后不存在了 → 关掉弹窗，别停在一个空壳上
  useEffect(() => {
    if (folderViewId && !folders.some((f) => f.id === folderViewId)) setFolderViewId(null);
  }, [folderViewId, folders]);
  // 封面窗口同款：文件夹没了就把窗口收掉
  const folderCover = useMemo(
    () => (folderCoverId ? folders.find((f) => f.id === folderCoverId) ?? null : null),
    [folderCoverId, folders],
  );
  useEffect(() => {
    if (folderCoverId && !folders.some((f) => f.id === folderCoverId)) setFolderCoverId(null);
  }, [folderCoverId, folders]);

  // ─── 手柄焦点导航 ──────────────────────────
  // 当前手柄焦点在游戏库网格时的索引（鼠标模式下返回 -1，手柄高亮/封面让位给鼠标 hover）
  const focusedIndex = useFocusIndex('grid:games');
  // 网格注册为焦点组：A=启动游戏 / 打开文件夹，「上」越过顶行跳到顶部导航。
  // 空格参与行列几何（count 含空格）但不可聚焦 —— 交给 skip 跳过
  useGamepadGroup('grid:games', {
    count: slots.length,
    cols: colCount,
    skip: (i) => !slots[i],
    activate: (i) => {
      const c = slots[i];
      if (!c) return;
      if (c.kind === 'folder') setFolderViewId(c.folder.id);
      else if (!c.game.archive_status) onLaunch(c.game.id);
    },
    scrollIntoView: (i) => virtualizer.scrollToIndex(Math.floor(i / colCount)),
  });

  // 右键卡片 → 卡片菜单（同时关闭库菜单与另一种卡片菜单）。
  // 记下它当前所在的格号：右键「新建文件夹」要把新文件夹钉在这一格
  const handleContextMenu = (e: React.MouseEvent, game: Game, slot: number) => {
    e.preventDefault();
    e.stopPropagation();
    setLibMenu(null);
    setFolderMenu(null);
    setMenu({ game, x: e.clientX, y: e.clientY, slot });
  };

  const handleFolderContextMenu = (e: React.MouseEvent, folder: GameFolder) => {
    e.preventDefault();
    e.stopPropagation();
    setLibMenu(null);
    setMenu(null);
    setFolderMenu({ folder, x: e.clientX, y: e.clientY });
  };

  // 右键空白 → 库级菜单（同时关闭卡片菜单）
  const handleBlankContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu(null);
    setFolderMenu(null);
    setLibMenu({ x: e.clientX, y: e.clientY });
  };

  // Close menus on click elsewhere / right-click outside / scroll / resize / Esc
  useEffect(() => {
    if (!menu && !folderMenu && !libMenu && !emptyAddMenu) return;
    const close = () => { setMenu(null); setFolderMenu(null); setLibMenu(null); setEmptyAddMenu(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
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
  }, [menu, folderMenu, libMenu, emptyAddMenu]);

  // ─── 拖拽：命中测试（单一纯几何路径，dnd-kit 式） ───
  // 目标格号 = 被拖卡片中心映射到固定网格几何（行用虚拟化实测高度，列用槽宽）。
  // 不读 DOM 命中、不依赖让位后的卡片位置 → 无反馈回路、单调连续、无跳变。
  // 换格时机：卡片中心越过邻格边缘（≈ 盖住邻格一半），与抓取点无关。
  // 参数只要「克隆卡几何」这几个字段：DragState 和浮层上报的 FolderDragInfo 都对得上
  const hitTest = (
    d: { x: number; y: number; grabDX: number; grabDY: number; width: number; height: number },
    len: number,
  ): number => {
    const el = parentRef.current!;
    const rect = el.getBoundingClientRect();
    // 被拖卡片中心（content 坐标，必须加 scrollTop）
    const centerX = (d.x - d.grabDX + d.width / 2) - rect.left - padX;
    const centerY = (d.y - d.grabDY + d.height / 2) - rect.top + el.scrollTop;
    const items = virtualizer.getVirtualItems(); // 已挂载行（可见 + overscan，实测 start/size）
    if (items.length === 0) return 0;
    const row = items.find((r) => centerY < r.start + r.size) ?? items[items.length - 1];
    const contentW = el.clientWidth - padX * 2;
    const slotW = (contentW - gap * (colCount - 1)) / colCount;
    const col = Math.max(0, Math.min(colCount - 1, Math.floor(centerX / (slotW + gap))));
    return Math.max(0, Math.min(len - 1, row.index * colCount + col));
  };

  const cleanupDrag = () => {
    window.removeEventListener('pointermove', onDragPointerMove);
    window.removeEventListener('pointerup', onDragPointerUp);
    window.removeEventListener('keydown', onDragKeyDown);
    window.removeEventListener('blur', onDragCancel);
  };

  // 一格在 spacer 里的位置（content 坐标，spacer 是 relative）—— 落点框照它定位。
  // 行的 top/height 取虚拟化器的实测值，与卡片用的是同一份几何
  const slotRect = (slot: number) => {
    const el = parentRef.current;
    if (!el) return null;
    const v = virtualizer.getVirtualItems().find((it) => it.index === Math.floor(slot / colCount));
    if (!v) return null; // 目标行没挂载（滚动范围外）
    const slotW = (el.clientWidth - padX * 2 - gap * (colCount - 1)) / colCount;
    return {
      left: (slot % colCount) * (slotW + gap),
      top: v.start,
      width: slotW,
      height: v.size - gap,
    };
  };

  // 工作副本 → 要写回的格号（只挑变了的）。写整份而不是只写被拖那张 + 被换那张，
  // 是为了让库里的格号与屏幕上**永远完全一致**：撞格的卡在布局里会被顺延，
  // 只写两张的话它的旧格号会一直留着，下次再拖又撞上
  const changedSlots = (work: LiveState): Array<{ key: string; slot: number }> => {
    const finalLayout = buildLibraryLayout(work.games, work.folders, { flat: false, colCount, padRows: 0 });
    const before = new Map<string, number>();
    for (const g of games) before.set(`g:${g.id}`, slotOf(g));
    for (const f of folders) before.set(`f:${f.id}`, slotOf(f));
    const items: Array<{ key: string; slot: number }> = [];
    finalLayout.forEach((cell, slot) => {
      if (!cell) return;
      const b = before.get(cell.key);
      if (b !== undefined && b !== slot) items.push({ key: cell.key, slot });
    });
    return items;
  };

  // 挤开一格：target 起连续占用的那一块整体后移，遇到第一个空格就停（放哪就是哪）。
  // 从文件夹浮层往外拖时用它算「让位后」的预览布局 —— 拖拽期间就摆好，松手零变化。
  // 文件夹卡不参与让位（与主网格「拖游戏时文件夹钉死」同一条规则）：它原地占着自己的格号，
  // 后面的游戏从它头上跨过去。否则从浮层里拖一张成员出来，会把文件夹卡连同后面一片一起推走
  const insertInto = (src: LiveState, target: number): LiveState => {
    const layout = buildLibraryLayout(src.games, src.folders, { colCount, padRows: 1 });
    if (!layout[target]) return src;
    let end = target;
    while (layout[end]) end += 1; // padRows 保证末尾一定有空格，不会越界成死循环
    let w = src;
    for (let i = end - 1; i >= target; i--) {
      const cell = layout[i];
      if (cell?.kind !== 'game') continue; // 文件夹：钉死原地，不挪
      let to = i + 1;
      while (to < end && layout[to]?.kind === 'folder') to += 1; // 从文件夹占的格上跨过去
      w = setSlotIn(w, cell.key, to);
    }
    return w;
  };

  // 浮层上报拖拽状态：亮格子 + 拖出面板后实时让位（预览挤开后的布局）+ 画落点框。
  // 落到文件夹卡上 = 放进那个文件夹（与主网格拖游戏同一条规则）—— 文件夹卡永远是路标，
  // 只被点亮，不被挤走；落回自己那个文件夹 = 放回去（松手不做任何写库）
  const handleFolderDragInfo = (info: FolderDragInfo | null) => {
    folderDragRef.current = info;
    setFolderDragActive(!!info);
    if (info) setEverDragged(true); // 同主网格：拖过就永久抑制入场动画，撤掉 drag-active 时不重播
    if (!info?.out) {
      if (!info) suppressClick(); // 浮层里的拖拽收尾（同主网格：挡掉松手补发的 click）
      // 拖在面板里 / 拖回面板内：收起落点框与文件夹高亮，布局恢复原样
      if (folderDropSlotRef.current !== null) {
        folderDropSlotRef.current = null;
        setFolderDropSlot(null);
        setLiveBoth(null);
      }
      if (dropFolderRef.current !== null) setDropFolderBoth(null);
      return;
    }
    const work: LiveState = { games: [...games], folders: [...folders] };
    const layout = buildLibraryLayout(work.games, work.folders, { colCount, padRows: 2 });
    const target = hitTest(info, layout.length);
    const occupant = layout[target];
    const intoFolder = occupant?.kind === 'folder' ? occupant.key : null;
    if (intoFolder) {
      // 进文件夹：撤掉落点框与让位（网格回到拖拽前的样子），只点亮那张文件夹卡
      if (folderDropSlotRef.current !== null) {
        folderDropSlotRef.current = null;
        setFolderDropSlot(null);
      }
      if (dropFolderRef.current !== intoFolder) setDropFolderBoth(intoFolder);
      if (liveRef.current) setLiveBoth(null);
      return;
    }
    if (dropFolderRef.current !== null) setDropFolderBoth(null);
    if (target === folderDropSlotRef.current) return;
    folderDropSlotRef.current = target;
    setFolderDropSlot(target);
    // 与主页拖动同一套手感：卡片在拖拽期间就摆到最终位置，松手零变化
    setLiveBoth(insertInto(work, target));
  };

  // 浮层里的卡被拖出面板后松手 → 落到指针所指那一格（已有卡片的话它们各让一格）；
  // 落在文件夹卡上则是「放进那个文件夹」（就是它自己那个文件夹 = 放回去，不写库）
  const handleFolderDrop = async () => {
    const info = folderDragRef.current;
    const target = folderDropSlotRef.current;
    const intoFolder = dropFolderRef.current;
    const work = liveRef.current;
    folderDragRef.current = null;
    folderDropSlotRef.current = null;
    setFolderDragActive(false);
    setFolderDropSlot(null);
    setDropFolderBoth(null);
    setLiveBoth(null);
    suppressClick(); // 同上：这一下松手也不能触发底下那张卡的启动
    if (!info) return;
    if (intoFolder) {
      const folderId = intoFolder.slice(2);
      if (folderId === folderViewId) return; // 落回自己那个文件夹：等于放回去
      try {
        await setGamesFolder([info.gameId], folderId);
      } catch (err) {
        void message(t('games.folderMoveFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
      }
      return;
    }
    if (target === null || !work) return;
    // 工作副本就是松手后的布局（拖拽期间已实时让位）→ 只写变了的格 + 这张游戏落到 target
    const items = changedSlots(work);
    items.push({ key: `g:${info.gameId}`, slot: target });
    try {
      // 先写格号再移出文件夹：此刻它还在文件夹里、顶层看不见，所以不会先弹到旧格再跳过来
      await setLibrarySlots(items);
      await setGamesFolder([info.gameId], null);
    } catch (err) {
      void message(t('games.folderMoveFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
    }
  };

  // 外部游戏克隆中心 (cx,cy) 落在浮层成员网格的哪个序号之前（0..成员数）。
  // 按阅读顺序扫成员格：中心在某格上方整行 → 插它前面；同一行且在格中线左侧 → 插它前面；
  // 都不满足（在最后一行右边 / 所有卡之下）→ 追加到末尾。与卡片中心判定同一套口径
  const folderInsertAt = (panel: HTMLElement, cx: number, cy: number): number => {
    const cells = Array.from(panel.querySelectorAll('[data-folder-game]')) as HTMLElement[];
    for (let i = 0; i < cells.length; i++) {
      const r = cells[i].getBoundingClientRect();
      if (cy < r.top) return i;                       // 整行都在中心上方 → 插到这一行最前
      if (cy <= r.bottom && cx < r.left + r.width / 2) return i; // 同行、在格左半 → 插它前面
    }
    return cells.length;
  };

  const handleCardPointerDown = (e: React.PointerEvent, key: string, kind: 'game' | 'folder', slot: number) => {
    if (e.button !== 0) return;
    // 按在「开始游戏」上也要能拖（以前这行直接 return，按在按钮上完全拖不动）：
    // 按钮上不 preventDefault —— 那会把按钮自己的 click 一起掐掉，而启动是主操作。
    // 真拖起来之后由 suppressClick 挡掉松手补发的那一下，普通点按仍照常启动游戏
    if (!(e.target as HTMLElement).closest('button')) e.preventDefault(); // 防止图片原生拖拽/文本选择
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setLiveBoth({ games: [...games], folders: [...folders] }); // 工作副本：松手即最终状态
    setDropFolderBoth(null);
    setDragBoth({
      key,
      kind,
      fromSlot: slot,
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      grabDX: e.clientX - r.left,
      grabDY: e.clientY - r.top,
      width: r.width,
      height: r.height,
      active: false,
    });
    // window 级监听：拖拽卡片跨行换父节点会重挂载，setPointerCapture 会丢，不能用
    window.addEventListener('pointermove', onDragPointerMove);
    window.addEventListener('pointerup', onDragPointerUp);
    window.addEventListener('keydown', onDragKeyDown);
    window.addEventListener('blur', onDragCancel);
  };

  const onDragPointerMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // 4px 阈值内视为点击
    if (!d.active && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
    const el = parentRef.current!;
    const rect = el.getBoundingClientRect();
    // 扩大的浮层会盖住主网格里的文件夹；先判断指针是否在浮层内，
    // 落点和边缘滚动都归可见的这一层，不能穿透到它下面的卡片 / 游戏库。
    const panel = d.kind === 'game' && folderViewId
      ? document.querySelector<HTMLElement>('.folder-popover')
      : null;
    const pr = panel?.getBoundingClientRect();
    const overPanel = !!pr && e.clientX >= pr.left && e.clientX <= pr.right
      && e.clientY >= pr.top && e.clientY <= pr.bottom;
    if (overPanel) {
      const body = panel?.querySelector<HTMLElement>('.folder-popover-body');
      const br = body?.getBoundingClientRect();
      if (br && e.clientY >= br.top && e.clientY <= br.bottom) {
        if (e.clientY < br.top + 40) body!.scrollBy({ top: -24 });
        else if (e.clientY > br.bottom - 40) body!.scrollBy({ top: 24 });
      }
    } else {
      if (e.clientY < rect.top + 60) el.scrollBy({ top: -24 });
      else if (e.clientY > rect.bottom - 60) el.scrollBy({ top: 24 });
    }
    const next: DragState = { ...d, x: e.clientX, y: e.clientY };
    if (!next.active) setEverDragged(true); // 首次激活后永久抑制入场动画重播
    const work = liveRef.current;
    if (next.active && work) {
      // 这里必须就地重算布局，不能用渲染时那份 slots —— 本函数是 pointerdown 那一帧
      // 注册到 window 上的闭包，渲染态对它永远是旧的；工作副本在 ref 里才是最新的。
      // 平铺模式（搜索 / 收藏）起不了拖拽（dragEnabled 已挡住），所以这里只剩一条路
      const layout = buildLibraryLayout(work.games, work.folders, { colCount, padRows: 2 });
      // 浮层开着拖游戏时，落点一律跟「指针」而不是「克隆卡中心」：抓取偏移大时中心会落在离指针很远的格，
      // 进浮层前那几帧会把落点框 / 让位卡闪在浮层下方（空文件夹、小浮层尤其明显）。跟指针则预览始终在
      // 指针底下，一碰到浮层就干净地切成「放进文件夹」。没开浮层时仍按卡片中心判定，与整套拖拽一致
      const hitAnchor = folderViewId && d.kind === 'game'
        ? { ...next, grabDX: d.width / 2, grabDY: d.height / 2 }
        : next;
      const target = hitTest(hitAnchor, layout.length);
      const occupant = layout[target];
      // 拖游戏碰到文件夹 = 放进这个文件夹。整格都算落点（不只卡面）：文件夹在拖游戏时是钉死的，
      // 这一格没有「抢位」的去处，把 16px 的格缝留成无反应的死区只会让指针在那儿卡一下
      const into = overPanel ? `f:${folderViewId}`
        : d.kind === 'game' && occupant?.kind === 'folder' ? occupant.key : null;
      // 文件夹浮层开着时，把外部游戏拖到浮层面板上也算放进这个文件夹 —— 面板多半弹在卡旁边、
      // 盖住的是空白区，文件夹卡本身可能被挡住，所以直接按面板矩形判定。
      // 用「指针」而非「克隆卡中心」判定是否在面板上：抓取偏移大时，中心会被拉到离指针很远，
      // 于是出现「指针已经在浮层上、但中心还在浮层外」的空档 —— 那一瞬 into 还没置上，主网格仍在
      // 实时重排、把落点框 / 让位的卡闪现在浮层下方，然后才跳进浮层。改用指针，指针一进面板就算放进来，
      // 没有这个空档（克隆入面板后会缩成封面大小、本就贴着指针，落点也按指针算，与看到的一致）
      const insertAt = overPanel && panel ? folderInsertAt(panel, next.x, next.y) : null;
      const wasInto = dropFolderRef.current;
      if (into !== wasInto) setDropFolderBoth(into);
      if (insertAt !== folderInsertRef.current) setFolderInsertBoth(insertAt);
      if (into) {
        // 进浮层：主网格回到拖拽前的「原始布局」（撤掉拖动过程里的让位 / 交换），只把被拖游戏自己的
        // 原格显成虚线空格（渲染处据 dropFolderKey 处理）。只在刚进浮层那一下重置一次 —— 否则会残留
        // 半截重排：进浮层前那一格的落点框、以及被挤走的邻卡会在那儿闪一下。重置后整片网格干净、静止
        if (!wasInto) setLiveBoth({ games: [...games], folders: [...folders] });
      } else {
        // 顶层：整库自由摆放 —— 拖到哪格就钉在哪格（空格也行）；那格已经有东西就两者交换，
        // 谁都不会丢位置、也不会把别人挤得满库乱跑。
        // 拖游戏时文件夹不参与交换（它没进 into 就说明这格不是文件夹）：文件夹是路标，
        // 拖一张游戏路过它就把它顶走，位置记忆全乱 —— 想挪文件夹就拖文件夹本身
        const curSlot = layout.findIndex((c) => c?.key === d.key);
        if (target !== curSlot) {
          let w = setSlotIn(work, d.key, target);
          if (occupant && occupant.key !== d.key) w = setSlotIn(w, occupant.key, curSlot);
          setLiveBoth(w);
        }
      }
    }
    setDragBoth({ ...next, active: true });
  };

  const onDragPointerUp = async () => {
    const d = dragRef.current;
    cleanupDrag();
    if (!d) return;
    const work = liveRef.current;
    const into = dropFolderRef.current;
    const insertAt = folderInsertRef.current; // 捕获落点序号（下面会清掉 ref）
    if (!d.active) {
      // 没超过阈值 = 点击：文件夹卡的「打开」走这里（卡片本身不挂 onClick，
      // 否则拖完松手那一下的 click 也会把文件夹打开）
      setDragBoth(null);
      setLiveBoth(null);
      setDropFolderBoth(null);
      setFolderInsertBoth(null);
      if (d.kind === 'folder') {
        // 再点一次同一张卡 = 收起浮层
        const id = d.key.slice(2);
        setFolderViewId((cur) => (cur === id ? null : id));
      }
      return;
    }
    suppressClick(); // 松手那下补发的 click 不许落到任何按钮上（见 suppressClickRef）
    // 落位锁：与清拖拽同一批次提交，让「拖拽卡 opacity 0→1」在禁过渡帧内完成，松手零反馈
    setDropLock(true);
    window.setTimeout(() => setDropLock(false), 80); // 2~4 帧后释放（此时卡片已全部到位，释放无感知）
    setDragBoth(null);
    setLiveBoth(null);
    setDropFolderBoth(null);
    setFolderInsertBoth(null);
    if (!work) return;
    if (into) {
      // 放进文件夹：顶层少一格、文件夹多一个成员。
      // 写回整份工作副本（含被放进文件夹的那张自己）：拖拽期间实时重排已经把它摆到最后的位置，
      // 只写别人会让「它的旧格号」和「让位者的新格号」撞在一起，松手那一帧有一张卡被迫挪一格。
      // 全写回去 = 屏幕与库里完全一致，松手只有被拖那张消失（零跳变）。
      // 它自己那条 slot 也一并更新：那是它的「原位记忆」，以后移出 / 解散时先试着回那一格 ——
      // 记的正是用户最后一次把它摆下的地方
      try {
        const items = changedSlots(work);
        if (items.length > 0) await setLibrarySlots(items);
        const gid = d.key.slice(2);
        const folderId = into.slice(2);
        // 拖进「打开着的浮层」并指定了落点 → 连目标文件夹的最终顺序一起写（把这张插到 insertAt），
        // 否则（落到文件夹卡本身 / 没有序号）就追加到末尾（order 省略）
        let order: string[] | undefined;
        if (insertAt != null && folderId === folderViewId) {
          const ids = folderViewGames.map((g) => g.id).filter((x) => x !== gid);
          ids.splice(Math.max(0, Math.min(insertAt, ids.length)), 0, gid);
          order = ids;
        }
        await setGamesFolder([gid], folderId, order);
      } catch (err) {
        void message(t('games.folderMoveFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
      }
      return;
    }
    // 顶层：把松手后的整份布局写回去（通常只有 2 张卡变了，剩下的会被比对过滤掉）
    const items = changedSlots(work);
    if (items.length > 0) await setLibrarySlots(items);
  };

  const onDragKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      cleanupDrag();
      setDragBoth(null); // 取消：丢弃工作副本，回到原状态
      setLiveBoth(null);
      setDropFolderBoth(null);
      setFolderInsertBoth(null);
    }
  };

  const onDragCancel = () => {
    cleanupDrag();
    setDragBoth(null);
    setLiveBoth(null);
    setDropFolderBoth(null);
    setFolderInsertBoth(null);
  };

  if (slots.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center h-full gap-6"
        onContextMenu={handleBlankContextMenu}
      >
        <div className="empty-orb"><Gamepad2 size={38} /></div>
        <div className="text-center">
          <p className="text-xl font-bold mb-2">{t('games.emptyTitle')}</p>
          <p className="text-sm text-text-tertiary">{t('games.emptyDesc')}</p>
        </div>
        <div className="relative">
          <button
            className="btn btn-accent gap-2 px-6 py-3 text-sm"
            onClick={(e) => { e.stopPropagation(); setEmptyAddMenu((open) => !open); }}
          >
            <Plus size={16} />
            {t('games.addGame')}
          </button>
          {emptyAddMenu && (
            <div
              className="absolute left-1/2 top-full z-50 mt-3 -translate-x-1/2 glass-modal solid-modal w-80 overflow-hidden shadow-2xl animate-scale-in"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-4 py-3 border-b border-border-glass bg-[rgba(0,212,255,0.05)] text-left">
                <p className="text-sm font-semibold text-text-primary">{t('games.addToLibrary')}</p>
                <p className="mt-0.5 text-xs text-text-secondary">{t('games.chooseAddMethod')}</p>
              </div>
              <div className="p-2 space-y-1.5">
                <button
                  onClick={() => { setEmptyAddMenu(false); onAddGame?.(); }}
                  className="group w-full flex items-center gap-3 rounded-xl px-3 py-3 text-left transition-all hover:bg-[rgba(0,212,255,0.10)] border border-transparent hover:border-[rgba(0,212,255,0.20)]"
                >
                  <span className="w-10 h-10 rounded-xl bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.22)] flex items-center justify-center shrink-0">
                    <Plus size={18} className="text-[#00d4ff]" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-text-primary">{t('games.addManual')}</span>
                    <span className="block mt-0.5 text-xs text-text-secondary">{t('games.addManualDesc')}</span>
                  </span>
                </button>
                <button
                  onClick={() => { setEmptyAddMenu(false); onOpenSteam?.(); }}
                  className="group w-full flex items-center gap-3 rounded-xl px-3 py-3 text-left transition-all hover:bg-bg-surface-hover border border-transparent hover:border-border-glass-hover"
                >
                  <span className="w-10 h-10 rounded-xl bg-bg-surface border border-border-glass flex items-center justify-center shrink-0">
                    <Gamepad2 size={18} className="text-text-secondary" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-text-primary">{t('games.steamImport')}</span>
                    <span className="block mt-0.5 text-xs text-text-secondary">{t('games.steamImportDesc')}</span>
                  </span>
                </button>
                <button
                  onClick={() => { setEmptyAddMenu(false); onImportArchive?.(); }}
                  className="group w-full flex items-center gap-3 rounded-xl px-3 py-3 text-left transition-all hover:bg-bg-surface-hover border border-transparent hover:border-border-glass-hover"
                >
                  <span className="w-10 h-10 rounded-xl bg-bg-surface border border-border-glass flex items-center justify-center shrink-0">
                    <FileArchive size={18} className="text-text-secondary" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-text-primary">{t('games.importArchive')}</span>
                    <span className="block mt-0.5 text-xs text-text-secondary">{t('games.importArchiveDesc')}</span>
                  </span>
                </button>
              </div>
            </div>
          )}
        </div>

        {libMenu && (
          <LibraryContextMenu x={libMenu.x} y={libMenu.y} onClose={() => setLibMenu(null)}>
            <button onClick={() => { setLibMenu(null); onAddGame?.(); }} className="context-menu-item">
              <Plus size={14} className="text-[#00d4ff]" />
              {t('games.addGame')}
            </button>
            <button onClick={() => { setLibMenu(null); onOpenSteam?.(); }} className="context-menu-item">
              <Gamepad2 size={14} className="text-text-secondary" />
              {t('games.steamScan')}
            </button>
            <button onClick={() => { setLibMenu(null); onImportArchive?.(); }} className="context-menu-item">
              <FileArchive size={14} className="text-text-secondary" />
              {t('games.importArchive')}
            </button>
          </LibraryContextMenu>
        )}
      </div>
    );
  }

  const draggedCell = dragging ? slots.find((c) => c?.key === drag!.key) : null;

  // x 轴 hidden：悬停缩放（scale 1.02）会让最右列卡片超出右边界 1~2px，overflow-auto 会因此显示横向滚动条；y 轴仍正常滚动
  return (
    <div
      ref={parentRef}
      className="h-full library-scroll overflow-y-auto"
      style={{ paddingLeft: padX, paddingRight: padX }}
      onContextMenu={handleBlankContextMenu}
      // 首次滚动即结束入场：滚动挂载进来的卡直接走 drag-suppress 的 animation:none
      // （card-enter 是 both，关掉动画直接呈现终态，不闪），首屏卡往回滚也不会重播
      onScroll={introDone ? undefined : () => setIntroDone(true)}
    >
      <div
        ref={spacerRef}
        className={clsx(
          gridHinting && 'drag-active',
          // 拖拽时让空格显出虚线框：「可以放这」要看得见（自己拖、或从文件夹浮层往外拖）
          gridHinting && !flat && 'placing',
          // 入场窗口过期后复用 drag-suppress：animation:none 让滚动挂载的卡不再重播入场
          // （card-enter 是 both，关掉动画直接呈现终态，不会闪）；它连带的 :hover 压制也正是
          // 需要的 —— 动画一关，原本压制悬停上浮的保留帧就消失了，得显式压回才和入场时一致
          (everDragged || introDone) && 'drag-suppress',
          dropLock && 'drop-instant',
        )}
        style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}
      >
        {virtualizer.getVirtualItems().map((row) => {
          const start = row.index * colCount;
          const rowCells = slots.slice(start, start + colCount);
          return (
            <div
              key={row.key}
              data-index={row.index}
              ref={virtualizer.measureElement}
              className="absolute w-full grid gap-4"
              style={{
                top: `${row.start}px`,
                paddingBottom: gap,
                gridTemplateColumns: `repeat(${colCount}, minmax(0, 1fr))`,
              }}
              onDragStart={(e) => e.preventDefault()}
            >
              {rowCells.map((cell, colIndex) => {
                const globalIndex = start + colIndex;
                // 空格：撑住 2:3 占位（整行都是空格时行高不能塌，否则拖拽的格号几何全错）
                if (!cell) {
                  return <div key={`empty-${globalIndex}`} className="library-slot-empty" />;
                }
                // 已经拖进文件夹浮层（dropFolderKey 置上）：被拖的游戏此刻算「在浮层里」，
                // 它在主网格占的那格还原成虚线空格 —— 否则这格会渲染一张隐身卡（.dragging opacity:0），
                // 在整片蓝色虚线网格里留下一个没有虚线的洞（正是「拖入前一刻所在的格」）
                if (dropFolderKey && dragging && drag!.key === cell.key) {
                  return <div key={cell.key} className="library-slot-empty" />;
                }
                // 用绝对格号而非批内序号：批内序号会随虚拟窗口滑动改写，改写运行中
                // 动画的 delay 会把它拽回起始相位 → 整张卡重闪。
                // 不设上限：封顶会把后半段卡片压到同一时刻开始动画，看起来
                // 「后半段瞬间一起出现」；范围已由 globalIndex < introCells 收在首屏内
                const introCell = !everDragged && !introDone && globalIndex < introCells;
                const delay = introCell ? globalIndex * 35 : 0;
                if (cell.kind === 'folder') {
                  return (
                    <GameFolderCard
                      key={cell.key}
                      folder={cell.folder}
                      games={cell.games}
                      cellWidth={cellWidth}
                      open={folderViewId === cell.folder.id}
                      onContextMenu={(e) => handleFolderContextMenu(e, cell.folder)}
                      onPointerDown={dragEnabled
                        ? (e) => handleCardPointerDown(e, cell.key, 'folder', globalIndex)
                        : undefined}
                      dragging={dragging && drag!.key === cell.key}
                      dropActive={dropFolderKey === cell.key}
                      animationDelay={delay}
                      focused={globalIndex === focusedIndex}
                    />
                  );
                }
                const game = cell.game;
                return (
                  <GameCard
                    key={cell.key}
                    game={game}
                    onLaunch={(e) => { e.stopPropagation(); if (suppressClickRef.current) return; if (!game.archive_status) onLaunch(game.id); }}
                    onContextMenu={(e) => handleContextMenu(e, game, globalIndex)}
                    onPointerDown={dragEnabled
                      ? (e) => handleCardPointerDown(e, cell.key, 'game', globalIndex)
                      : undefined}
                    dragging={dragging && drag!.key === cell.key}
                    previewDisabled={dragging}
                    animationDelay={delay}
                    focused={globalIndex === focusedIndex}
                  />
                );
              })}
            </div>
          );
        })}

        {/* 拖拽落点框：主页拖动画在被拖卡片的位置，从文件夹浮层往外拖画在插入点 —— 两处同一个框。
            画在 spacer 里跟着内容滚，所以用的是 content 坐标 */}
        {(() => {
          const slot = dragging
            ? (dropFolderKey ? -1 : slots.findIndex((c) => c?.key === drag!.key))
            : folderDropSlot ?? -1;
          if (slot < 0) return null;
          const r = slotRect(slot);
          return r ? <div className="drop-slot" style={r} /> : null;
        })()}
      </div>

      {/* 拖拽克隆：跟随指针。拖进文件夹时缩到「文件夹内封面」那么大 —— 预告它要被收进去 */}
      {dragging && draggedCell && (() => {
        // 克隆中心正落在某个文件夹（主网格文件夹卡 或 打开的浮层）上 = 松手会放进去。
        // 游戏卡才缩（文件夹拖文件夹不触发合并，不缩）
        const intoFolder = draggedCell.kind === 'game' && !!dropFolderKey;
        // 目标尺寸取浮层里真实那一格的宽度；浮层没开时使用同一固定封面尺寸
        const cell = intoFolder ? (document.querySelector('.folder-view-cell') as HTMLElement | null) : null;
        const targetW = cell?.offsetWidth || FOLDER_GAME_CARD_WIDTH;
        const scale = intoFolder ? Math.min(1, targetW / drag!.width) : 1;
        return createPortal(
          <div
            className="drag-clone"
            style={{
              left: drag!.x - drag!.grabDX,
              top: drag!.y - drag!.grabDY,
              width: drag!.width,
              transform: `scale(${scale})`,
              // 以抓取点为原点缩放：卡片朝指针收，指针始终咬在卡上同一处，不会滑出卡面
              transformOrigin: `${drag!.grabDX}px ${drag!.grabDY}px`,
            }}
          >
            {/* 与原卡同款禁用悬停预览：当前靠 .drag-clone 的 pointer-events:none 兜着，
                一旦那个样式被改动（克隆卡可 hover），漏传会让拖拽中弹出预览卡 */}
            {draggedCell.kind === 'folder' ? (
              <GameFolderCard folder={draggedCell.folder} games={draggedCell.games} cellWidth={cellWidth} />
            ) : (
              <GameCard game={draggedCell.game} onLaunch={() => {}} previewDisabled />
            )}
          </div>,
          document.body,
        );
      })()}

      {/* 文件夹内容浮层：从卡片旁边弹出，里面的卡片右键走同一套卡片菜单（菜单层级比浮层高，盖得住） */}
      {folderView && (
        <GameFolderPopover
          key={folderView.id}
          folder={folderView}
          games={folderViewGames}
          onClose={() => setFolderViewId(null)}
          onLaunch={(id) => { if (suppressClickRef.current) return; onLaunch(id); }}
          onGameContextMenu={(e, game) => {
            e.preventDefault();
            e.stopPropagation();
            setFolderMenu(null);
            setLibMenu(null);
            setMenu({ game, x: e.clientX, y: e.clientY, slot: slotOf(game) });
          }}
          onDragInfo={handleFolderDragInfo}
          onDropOutside={handleFolderDrop}
          onChangeCover={() => setFolderCoverId(folderView.id)}
          dropActive={dropFolderKey === `f:${folderView.id}`}
          frozen={gridHinting}
          mainCellWidth={cellWidth}
          insertIndex={dropFolderKey === `f:${folderView.id}` ? folderInsert : null}
        />
      )}

      {/* 文件夹封面窗口：浮层头部「调整封面」打开，层级（z-110）压得住浮层（z-85） */}
      {folderCover && (
        <FolderCoverModal
          folder={folderCover}
          onClose={() => setFolderCoverId(null)}
          onApplied={async () => {
            setFolderCoverId(null);
            await loadGameFolders();
          }}
        />
      )}

      {/* 卡片右键菜单 */}
      {menu && (
        <GameContextMenu
          game={menu.game}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onChangeCover={() => setCoverGame({ game: menu.game, kind: 'portrait' })}
          onChangeBanner={() => setCoverGame({ game: menu.game, kind: 'wide' })}
          onDiskManage={() => onOpenDiskManager?.()}
          onFpsSettings={() => onOpenFpsSettings?.(menu.game.id)}
          onRestore={() => setRestoreGame(menu.game)}
          onNewFolder={() => setNameModal({
            mode: 'create',
            initialName: menu.game.name,
            gameIds: [menu.game.id],
            slot: menu.slot, // 新文件夹钉在这张卡原来的格位上
          })}
        />
      )}

      {/* 文件夹右键菜单 */}
      {folderMenu && (
        <GameFolderContextMenu
          folder={folderMenu.folder}
          x={folderMenu.x}
          y={folderMenu.y}
          onClose={() => setFolderMenu(null)}
          onOpen={() => setFolderViewId(folderMenu.folder.id)}
          onRename={() => setNameModal({ mode: 'rename', folderId: folderMenu.folder.id, initialName: folderMenu.folder.name })}
        />
      )}

      {/* 新建 / 重命名文件夹 */}
      {nameModal && (
        <GameFolderNameModal
          mode={nameModal.mode}
          folderId={nameModal.mode === 'rename' ? nameModal.folderId : undefined}
          initialName={nameModal.initialName}
          initialGameIds={nameModal.mode === 'create' ? nameModal.gameIds : undefined}
          initialSlot={nameModal.mode === 'create' ? nameModal.slot : undefined}
          onClose={() => setNameModal(null)}
        />
      )}

      {/* 更换封面弹窗 */}
      {coverGame && (
        <CoverPickerModal
          game={coverGame.game}
          kind={coverGame.kind}
          onClose={() => setCoverGame(null)}
          onApplied={async () => {
            setCoverGame(null);
            await loadGames();
          }}
        />
      )}

      {restoreGame && (
        <GameRestoreDialog
          game={restoreGame}
          onClose={() => setRestoreGame(null)}
          onBusy={() => {}}
          onRefresh={loadGames}
        />
      )}

      {/* 空白区域库级菜单 */}
      {libMenu && (
        <LibraryContextMenu x={libMenu.x} y={libMenu.y} onClose={() => setLibMenu(null)}>
          <button onClick={() => { setLibMenu(null); onAddGame?.(); }} className="context-menu-item">
            <Plus size={14} className="text-[#00d4ff]" />
            {t('games.addGame')}
          </button>
          <button onClick={() => { setLibMenu(null); onOpenSteam?.(); }} className="context-menu-item">
            <Gamepad2 size={14} className="text-text-secondary" />
            {t('games.steamScan')}
          </button>
          {/* 每行数量已移到「设置 → 外观」，右键菜单只保留库级操作 */}
        </LibraryContextMenu>
      )}
    </div>
  );
}
