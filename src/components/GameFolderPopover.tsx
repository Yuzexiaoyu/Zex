import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { Clock, FolderOpen, ImagePlus, X } from 'lucide-react';
import GameCard from './GameCard';
import { useAppStore } from '../store';
import { useModalGamepad } from '../gamepad';
import { formatDuration } from '../utils/media';
import type { Game, GameFolder } from '../types';
import { useT } from '../i18n';

interface Props {
  folder: GameFolder;
  /** 文件夹成员，已按文件夹内顺序排好 */
  games: Game[];
  onClose: () => void;
  onLaunch: (id: string) => void;
  /** 右键某张卡：交给 GameGrid 弹它那套卡片菜单（详情 / 换封面 / 移出文件夹…） */
  onGameContextMenu: (e: React.MouseEvent, game: Game) => void;
  /** 拖拽状态上报：GameGrid 据此亮出主网格的格子、算落点（null = 拖拽结束） */
  onDragInfo?: (info: FolderDragInfo | null) => void;
  /** 卡片拖出面板后松手：落到主网格哪一格由 GameGrid 定（它才有格号几何） */
  onDropOutside?: () => void;
  /** 头部「调整封面」：封面窗口由 GameGrid 持有（浮层关掉它还在） */
  onChangeCover?: () => void;
  /** 主网格正把一张外部游戏拖到本浮层上 = 落点高亮（松手会放进这个文件夹，由 GameGrid 落库） */
  dropActive?: boolean;
  /** 主网格拖拽进行中：锁定浮层位置，拖上去只亮高亮、不跟着卡片 / 滚动条挪位 */
  frozen?: boolean;
  /** 主网格一格的实测宽度：成员卡拖出面板时，克隆要从「文件夹封面大小」放大回这个库内尺寸 */
  mainCellWidth?: number;
  /** 外部游戏拖到浮层上的落点序号（0..成员数）：据此在网格里空出一格、把后面的卡挤开；null = 没在往里拖 */
  insertIndex?: number | null;
}

/** 浮层正在拖的那张卡，几何按「克隆卡」算 —— 字段与 GameGrid 的 hitTest 对口 */
export interface FolderDragInfo {
  gameId: string;
  x: number;
  y: number;
  grabDX: number;
  grabDY: number;
  width: number;
  height: number;
  /** 克隆卡中心已离开面板 = 松手要落进主网格 */
  out: boolean;
}

// 保持 134px 封面，常规窗口显示四列、三排，超出部分在内容区滚动。
export const FOLDER_GAME_CARD_WIDTH = 134;
const PANEL_W = 602; // 四张封面 + 三道 12px 间隙 + 内边距、边框与滚动条槽位
const GAP = 12;
const MARGIN = 8;

// 文件夹浮层：点文件夹卡，内容**从卡片旁边弹出**（不是另开一个窗口）——
// 游戏库原样留在周围，网格不重排、不铺遮罩，点别处就收起。
// 优先贴卡片右侧，右侧放不下则翻到左侧；两侧都不足时选空间较大的一侧，再夹进窗口。
//
// 顺序即文件夹内顺序，拖动卡片直接重排（松手写回 game_folder_items.sort_order）；
// 把卡片拖出面板 = 放回游戏库：主网格亮出格子并实时让位（挤开，与主页拖动同一套手感），
// 松手落在指针所指那一格（落点与写库都由 GameGrid 做，它才有格号几何）。
// 换封面 / 看详情走右键那套卡片菜单 —— 菜单由 GameGrid 持有，
// 本组件只上报「在哪儿右键了谁」。
//
// 层级 z-85：高于网格，低于悬停预览(90)、右键菜单(100)、封面选择(110)、详情(200) ——
// 这些从浮层里再开出来的东西才盖得住它
export default function GameFolderPopover({ folder, games, onClose, onLaunch, onGameContextMenu, onDragInfo, onDropOutside, onChangeCover, dropActive, frozen, mainCellWidth, insertIndex }: Props) {
  const t = useT();
  const reorderFolderGames = useAppStore((s) => s.reorderFolderGames);
  const panelRef = useRef<HTMLDivElement>(null);

  // 手柄 / 键盘：B 与 Esc 关闭，打开期间按键不穿透到背后的网格
  useModalGamepad('popover:game-folder', { onClose });

  // ─── 贴住文件夹卡 ───────────────────────
  const [pos, setPos] = useState<{ x: number; y: number; side: 'right' | 'left' } | null>(null);

  const place = useCallback(() => {
    // 主网格拖拽期间锁死位置：拖拽会让网格补预留行 / 冒出滚动条，列宽随之变、锚点卡片横移，
    // 这会把浮层也带偏。拖拽时只保留已有坐标，拖上去就只亮一圈高亮，纹丝不动
    if (frozen) return;
    const a = document.querySelector(`[data-folder-card="${folder.id}"]`) as HTMLElement | null;
    if (!a) { onClose(); return; } // 锚点没了（文件夹被解散 / 卡片被虚拟滚动卸载）
    const r = a.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) { onClose(); return; } // 整张卡滚出窗口
    // 取未受入场缩放影响的布局尺寸，并保留 vh 产生的小数像素。
    // offsetHeight 会四舍五入，贴底时会吃掉一部分窗口边距。
    const panelStyle = panelRef.current ? getComputedStyle(panelRef.current) : null;
    const w = panelStyle ? Number.parseFloat(panelStyle.width) : Math.min(PANEL_W, window.innerWidth - MARGIN * 2);
    const rightSpace = window.innerWidth - MARGIN - r.right - GAP;
    const leftSpace = r.left - GAP - MARGIN;
    const right = rightSpace >= w || (leftSpace < w && rightSpace >= leftSpace);
    const idealX = right ? r.right + GAP : r.left - GAP - w;
    const x = Math.max(MARGIN, Math.min(idealX, window.innerWidth - MARGIN - w));
    // 面板高度只有挂进 DOM 才知道 —— 量到之前先贴卡片顶，量到之后再夹进窗口
    const h = panelStyle ? Number.parseFloat(panelStyle.height) : 0;
    const y = h > 0 ? Math.max(MARGIN, Math.min(r.top, window.innerHeight - MARGIN - h)) : r.top;
    const side: 'right' | 'left' = right ? 'right' : 'left';
    // 位置没变就沿用原对象：place 会在每次库滚动时被调用，别为同一处坐标反复重渲染
    setPos((cur) => (cur && cur.x === x && cur.y === y && cur.side === side ? cur : { x, y, side }));
  }, [folder.id, onClose, frozen]);

  // 首帧：面板先以不可见挂进 DOM → 量高度 → 定位，全在 paint 之前完成，不会闪
  useLayoutEffect(() => { place(); }, [place]);

  // 游戏库滚动 / 窗口缩放 / 卡片列数变化 → 跟着锚点走。
  // 只监听库的滚动容器，浮层内部滚动不触发重新定位。
  useEffect(() => {
    const a = document.querySelector(`[data-folder-card="${folder.id}"]`);
    const scroller = a?.closest('.library-scroll');
    const onMove = () => place();
    const observer = new ResizeObserver(onMove);
    if (a) observer.observe(a);
    if (scroller) observer.observe(scroller);
    if (panelRef.current) observer.observe(panelRef.current);
    scroller?.addEventListener('scroll', onMove);
    window.addEventListener('resize', onMove);
    return () => {
      observer.disconnect();
      scroller?.removeEventListener('scroll', onMove);
      window.removeEventListener('resize', onMove);
    };
  }, [folder.id, place]);

  // 点别处收起。用 pointerdown 捕获阶段：先收起浮层，再让那一下点击照常落到目标上
  // （点另一张文件夹卡 = 收起这张、弹出那张）。点卡片自己不算 —— 那交给卡片的点击逻辑做开关；
  // 封面窗口（GameGrid 持有、层级更高）开着时点它也不算
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el || panelRef.current?.contains(el)) return;
      if (el.closest?.(`[data-folder-card="${folder.id}"]`)) return;
      if (el.closest?.('[data-folder-cover-modal]')) return;
      // 主网格里的游戏卡：按下很可能是要把它拖进本文件夹，别收起浮层 ——
      // 收起了就没了落点。真·点别处（空白 / 别的文件夹卡）才收。
      // 浮层自己的成员卡在上面 panelRef.contains 已提前放行，不会落到这里
      if (el.closest?.('.game-card')) return;
      onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [folder.id, onClose]);

  // ─── 显示顺序 + 拖拽重排 ────────────────
  // 显示顺序是本地副本：拖拽期间只改它（松手才写库），外部数据（移出 / 新增成员）变了再同步回来
  const [order, setOrder] = useState<string[]>(() => games.map((g) => g.id));
  useEffect(() => {
    const next = games.map((g) => g.id);
    setOrder((cur) => (cur.join() === next.join() ? cur : next));
  }, [games]);

  const byId = useMemo(() => new Map(games.map((g) => [g.id, g])), [games]);
  const ordered = useMemo(
    () => order.map((id) => byId.get(id)).filter((g): g is Game => !!g),
    [order, byId],
  );
  const totalSeconds = useMemo(() => games.reduce((sum, g) => sum + (g.total_seconds || 0), 0), [games]);

  // 命中按**克隆卡中心**找底下的卡片（不是指针位置 —— 指针差着一个抓取偏移，
  // 从卡角按下时能错开一整列，看着盖住了却换不了位），再按中心在卡片左半还是右半决定插到前 / 后。
  // 被拖的卡片原位隐藏、只留一张克隆跟着指针走（与游戏库主网格同款手感），
  // 中心压在自己身上时直接跳过 —— 换位后不会来回抖
  const dragRef = useRef<{
    id: string; startX: number; startY: number;
    grabDX: number; grabDY: number; width: number; height: number; active: boolean;
  } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  // 跟随指针的克隆：位置得进 render 才能画出来，所以拖拽中每帧更新这份 state
  const [clone, setClone] = useState<{ x: number; y: number; grabDX: number; grabDY: number; width: number } | null>(null);
  // 指针拖到面板外 = 松手就移出文件夹。期间冻结内部重排，面板里的顺序不跟着抖
  const [dragOut, setDragOut] = useState(false);
  const dragOutRef = useRef(false);
  const orderRef = useRef(order);
  useEffect(() => { orderRef.current = order; }, [order]);
  // 当前挂在 window 上的两个拖拽监听（拖到一半浮层被 Esc / 手柄 B 关掉时要摘掉 ——
  // 它们是 pointerdown 那一帧的闭包，卸载后没人摘得掉）
  const listenersRef = useRef<{ move: (e: PointerEvent) => void; up: () => void } | null>(null);
  useEffect(() => () => {
    const l = listenersRef.current;
    if (!l) return;
    window.removeEventListener('pointermove', l.move);
    window.removeEventListener('pointerup', l.up);
    onDragInfo?.(null); // 拖到一半被关掉：主网格的格子提示也得收掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPointerMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
      d.active = true;
      setDragId(d.id);
    }
    setClone({ x: e.clientX, y: e.clientY, grabDX: d.grabDX, grabDY: d.grabDY, width: d.width });
    // 克隆卡中心：命中与「是否拖出面板」都按它算，和眼睛看到的那张卡一致
    const cx = e.clientX - d.grabDX + d.width / 2;
    const cy = e.clientY - d.grabDY + d.height / 2;
    const p = panelRef.current?.getBoundingClientRect();
    const out = !!p && (cx < p.left || cx > p.right || cy < p.top || cy > p.bottom);
    if (out !== dragOutRef.current) { dragOutRef.current = out; setDragOut(out); }
    // 主网格要据此亮格子、画落点框 —— 拖在面板里时也报，这样格子从一开始就看得见
    onDragInfo?.({
      gameId: d.id,
      x: e.clientX, y: e.clientY,
      grabDX: d.grabDX, grabDY: d.grabDY,
      width: d.width, height: d.height,
      out,
    });
    if (out) return; // 要落进主网格了，面板内不再重排
    const el = document.elementFromPoint(cx, cy)?.closest('[data-folder-game]') as HTMLElement | null;
    const overId = el?.dataset.folderGame;
    if (!overId || overId === d.id) return;
    const r = el!.getBoundingClientRect();
    const after = cx > r.left + r.width / 2;
    setOrder((cur) => {
      if (!cur.includes(d.id) || !cur.includes(overId)) return cur;
      const next = cur.filter((x) => x !== d.id);
      next.splice(next.indexOf(overId) + (after ? 1 : 0), 0, d.id);
      return next.join() === cur.join() ? cur : next;
    });
  };

  const onPointerUp = () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    listenersRef.current = null;
    const d = dragRef.current;
    const out = dragOutRef.current;
    dragRef.current = null;
    dragOutRef.current = false;
    setDragId(null);
    setClone(null);
    setDragOut(false);
    if (!d?.active) return;
    if (out) {
      // 落进主网格：格号、写库、以及那边拖拽状态的清理都归 GameGrid
      // （别在这儿先报 null —— 它要用那份几何算落点）
      onDropOutside?.();
      return;
    }
    onDragInfo?.(null);
    const ids = orderRef.current;
    if (ids.join() !== games.map((g) => g.id).join()) void reorderFolderGames(folder.id, ids);
  };

  const handlePointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    // 按在「开始游戏」上也要能拖：按钮上不 preventDefault —— 那会掐掉按钮自己的 click，
    // 启动就没了。真拖起来后由 GameGrid 的 suppressClick 挡掉松手补发的那一下
    if (!(e.target as HTMLElement).closest('button')) e.preventDefault(); // 防止图片原生拖拽 / 文本选择
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragRef.current = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      grabDX: e.clientX - r.left,
      grabDY: e.clientY - r.top,
      width: r.width,
      height: r.height,
      active: false,
    };
    listenersRef.current = { move: onPointerMove, up: onPointerUp };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  const dragGame = dragId ? byId.get(dragId) : undefined;

  return createPortal(
    <>
      <div
        ref={panelRef}
        className={clsx('folder-popover glass-modal solid-modal animate-scale-in', dropActive && 'drop-target')}
        style={{
          left: pos?.x ?? -9999,
          top: pos?.y ?? -9999,
          width: `min(${PANEL_W}px, calc(100vw - ${MARGIN * 2}px))`,
          visibility: pos ? 'visible' : 'hidden',
          // 从贴着卡片的那条边展开
          transformOrigin: pos?.side === 'left' ? 'right top' : 'left top',
        }}
      >
        {/* 头部 */}
        <div className="shrink-0 flex items-center gap-2.5 px-4 py-3 border-b border-border-glass">
          <div className="w-8 h-8 rounded-lg bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.2)] flex items-center justify-center shrink-0">
            <FolderOpen size={15} className="text-[#00d4ff]" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold truncate leading-tight">{folder.name}</h3>
            <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-tertiary tabular-nums">
              <Clock size={10} />
              {totalSeconds > 0
                ? t('games.folderSummary', { n: games.length, time: formatDuration(totalSeconds) })
                : t('games.folderCountOnly', { n: games.length })}
            </p>
          </div>
          {/* 名字右侧：调整封面（封面窗口由 GameGrid 持有，压在这层浮层之上） */}
          <button
            onClick={onChangeCover}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] text-text-secondary hover:text-white hover:bg-bg-surface-active transition-all shrink-0"
          >
            <ImagePlus size={12} />
            {t('games.changeFolderCover')}
          </button>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-text-tertiary hover:bg-bg-surface-active shrink-0"
          >
            <X size={14} />
          </button>
        </div>

        {/* 内容：固定封面尺寸，最多四列、三排，小窗口自动换行并受视口高度约束 */}
        <div className="folder-popover-body">
          {ordered.length === 0 && insertIndex == null ? (
            <div className="flex flex-col items-center justify-center gap-3 py-10">
              <div className="empty-orb w-[62px] h-[62px]"><FolderOpen size={24} /></div>
              <p className="text-xs text-text-tertiary">{t('games.folderEmptyHint')}</p>
            </div>
          ) : (
            <div
              className={clsx('grid gap-3', dragId && 'folder-grid-dragging', dragOut && 'folder-grid-out')}
              style={{ gridTemplateColumns: `repeat(auto-fill, ${FOLDER_GAME_CARD_WIDTH}px)` }}
            >
              {(() => {
                const cells = ordered.map((game) => (
                  <div
                    key={game.id}
                    data-folder-game={game.id}
                    className={clsx('folder-view-cell', dragId === game.id && 'dragging')}
                  >
                    <GameCard
                      game={game}
                      onLaunch={(e) => { e.stopPropagation(); if (!game.archive_status) onLaunch(game.id); }}
                      onContextMenu={(e) => onGameContextMenu(e, game)}
                      onPointerDown={(e) => handlePointerDown(e, game.id)}
                      dragging={dragId === game.id}
                      previewDisabled
                    />
                  </div>
                ));
                // 外部游戏正拖进来：在落点处插一个虚线占位格，后面的卡顺势往后挤 —— 就是「松手会落在这」
                if (insertIndex != null) {
                  const i = Math.max(0, Math.min(insertIndex, cells.length));
                  cells.splice(i, 0, <div key="__ext_ghost__" className="folder-view-cell folder-ext-ghost" />);
                }
                return cells;
              })()}
            </div>
          )}
        </div>

        {/* 底部提示：拖出面板时改口播「松手就移出」 */}
        <div
          className={clsx(
            'shrink-0 px-4 py-2 border-t border-border-glass text-[11px]',
            dragOut ? 'text-[#00d4ff]' : 'text-text-tertiary',
          )}
        >
          {dragOut ? t('games.folderDragOutHint') : t('games.folderViewHint')}
        </div>
      </div>

      {/* 拖拽克隆：跟随指针。.drag-clone 的 pointer-events:none 让它不挡命中判定。
          拖出面板 = 要放回游戏库 → 直接把克隆的 width 换成库内整格宽度（量 .library-scroll 里一张真卡；
          浮层已 portal 到 body、不在其内，量到的必是主网格卡），让卡按真实尺寸重新排版 ——
          圆角、「已压缩」角标都保持原样大小，而不是把小封面整体放大（那样角标会被撑大、圆角过圆）。
          锚点按抓取点在封面内的「比例」换算（grabDX*放大倍数），指针始终落在卡上同一相对位置；
          宽度即时变（不加过渡：过渡期间卡的实宽会落后于锚点算出的新宽，指针会飘） */}
      {clone && dragGame && (() => {
        const mainCard = document.querySelector('.library-scroll .game-card') as HTMLElement | null;
        const targetW = mainCard?.offsetWidth || mainCellWidth || clone.width;
        const w = dragOut ? Math.max(clone.width, targetW) : clone.width;
        const s = w / clone.width; // 放大倍数：抓取偏移同比放大，指针咬住封面同一处
        return (
          <div
            className={clsx('drag-clone', dragOut && 'drag-clone-out')}
            style={{ left: clone.x - clone.grabDX * s, top: clone.y - clone.grabDY * s, width: w }}
          >
            <GameCard game={dragGame} onLaunch={() => {}} previewDisabled />
          </div>
        );
      })()}
    </>,
    document.body,
  );
}
