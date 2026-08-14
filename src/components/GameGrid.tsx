import { useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAppStore } from '../store';
import GameCard from './GameCard';
import GameContextMenu from './GameContextMenu';
import CoverPickerModal from './CoverPickerModal';
import LibraryContextMenu from './LibraryContextMenu';
import { Plus, Gamepad2 } from 'lucide-react';
import type { Game } from '../types';
import { clsx } from 'clsx';
import { useEscIntercept } from '../utils/escIntercept';
import { useFocusIndex, useGamepadGroup } from '../gamepad';

interface Props {
  games: Game[];
  onLaunch: (id: string) => void;
  columns?: number;
  onAddGame?: () => void;
  onOpenSteam?: () => void;
  onOpenDiskManager?: () => void;
}

// 拖拽状态：live reorder（实时重排）——拖拽期间工作数组随时等于最终顺序，
// 让位卡片直接在网格布局中流动（零 transform 位移），松手时布局零变化 → 结构上不可能抽动
interface DragState {
  id: string;
  from: number;     // 起始索引（固定，判断是否真正移动过）
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

export default function GameGrid({
  games, onLaunch, columns = 8, onAddGame, onOpenSteam, onOpenDiskManager,
}: Props) {
  // 逐字段订阅：网格里有全部可见 GameCard，不能跟着无关字段重画
  const filter = useAppStore((s) => s.filter);
  const loadGames = useAppStore((s) => s.loadGames);
  const reorderGames = useAppStore((s) => s.reorderGames);
  const parentRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ game: Game; x: number; y: number } | null>(null);
  const [libMenu, setLibMenu] = useState<{ x: number; y: number } | null>(null);
  const [coverGame, setCoverGame] = useState<{ game: Game; kind: 'portrait' | 'wide' } | null>(null);
  const colCount = Math.max(1, columns);
  const rowHeight = 380;
  const gap = 16;
  // 滚动容器的左右内边距。拖拽命中判定（getTargetIndex）要用它把指针坐标换算成
  // 网格内坐标，必须与下面容器实际渲染的 padding 是同一个值 —— 曾经这里写死 24（p-6）
  // 而容器是 px-[10px]，列判定整体偏 14px、列宽也算窄了 28px
  const padX = 10;

  // ─── 拖拽排序 ────────────────────────────
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  // 拖拽中的工作数组：指针移动即实时重排，松手时就是最终顺序（live reorder）
  const [liveItems, setLiveItems] = useState<Game[] | null>(null);
  const liveRef = useRef<Game[] | null>(null);

  // 右键菜单 / 拖拽开着时由它们消费 Esc，App 的全局「Esc=收托盘」让位
  useEscIntercept(!!menu || !!libMenu);
  useEscIntercept(!!drag);
  const setLiveBoth = (arr: Game[] | null) => { liveRef.current = arr; setLiveItems(arr); };
  // 首次拖拽后永久抑制卡片入场动画（拖拽中切掉 animation:none 会让所有卡片重播渐出）
  const [everDragged, setEverDragged] = useState(false);
  // 入场动画属于「视图刚出现」，不属于某张卡。虚拟滚动下卡片会反复挂载，
  // 按全局索引算延迟会让滚到深处的卡拿到几秒延迟（先空白再淡入）。
  // 用挂载时刻做窗口，过期后不再传 animationDelay
  const [introDone, setIntroDone] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setIntroDone(true), 700);
    return () => clearTimeout(id);
  }, []);
  const introWindow = !introDone;
  // 松手落位锁：与状态更新同一批次提交，确保禁过渡帧在 drop 提交时真正生效
  // （旧的命令式 classList.add 会在 React 重写 className 时被抹掉，从未生效过 → 松手一直抽动）
  const [dropLock, setDropLock] = useState(false);
  const setDragBoth = (d: DragState | null) => { dragRef.current = d; setDrag(d); };
  const displayGames = liveItems ?? games;
  // 仅在自定义排序（默认）下可拖拽；搜索/筛选等模式禁用
  const dragEnabled = !filter.search && !filter.favorite;

  const rows = Math.ceil(displayGames.length / colCount);

  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight + gap,
    overscan: 3,
    // 封面是 2/3 宽高比，卡片高度随宽度变化，必须按实际测量值布局，否则行与行重叠
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  // ─── 手柄焦点导航 ──────────────────────────
  // 当前手柄焦点在游戏库网格时的索引（鼠标模式下返回 -1，手柄高亮/封面让位给鼠标 hover）
  const focusedIndex = useFocusIndex('grid:games');
  // 网格注册为焦点组：A=启动游戏，「上」越过顶行跳到顶部导航
  useGamepadGroup('grid:games', {
    count: displayGames.length,
    cols: colCount,
    activate: (i) => { const g = displayGames[i]; if (g) onLaunch(g.id); },
    scrollIntoView: (i) => virtualizer.scrollToIndex(Math.floor(i / colCount)),
  });

  // 右键卡片 → 卡片菜单（同时关闭库菜单）
  const handleContextMenu = (e: React.MouseEvent, game: Game) => {
    e.preventDefault();
    e.stopPropagation();
    setLibMenu(null);
    setMenu({ game, x: e.clientX, y: e.clientY });
  };

  // 右键空白 → 库级菜单（同时关闭卡片菜单）
  const handleBlankContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu(null);
    setLibMenu({ x: e.clientX, y: e.clientY });
  };

  // Close menus on click elsewhere / right-click outside / scroll / resize / Esc
  useEffect(() => {
    if (!menu && !libMenu) return;
    const close = () => { setMenu(null); setLibMenu(null); };
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
  }, [menu, libMenu]);

  // ─── 拖拽：命中测试（单一纯几何路径，dnd-kit 式） ───
  // 目标槽位 = 被拖卡片中心映射到固定网格几何（行用虚拟化实测高度，列用槽宽）。
  // 不读 DOM 命中、不依赖让位后的卡片位置 → 无反馈回路、单调连续、无跳变。
  // 换位时机：卡片中心越过邻卡边缘（≈ 盖住邻卡一半），与抓取点无关。
  const getTargetIndex = (d: DragState, len: number): number => {
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
    let idx = row.index * colCount + col;
    // 末行空位 → 视为末尾
    if (row.index === Math.ceil(len / colCount) - 1 && col >= (len % colCount || colCount)) {
      idx = len - 1;
    }
    return Math.max(0, Math.min(len - 1, idx));
  };

  const cleanupDrag = () => {
    window.removeEventListener('pointermove', onDragPointerMove);
    window.removeEventListener('pointerup', onDragPointerUp);
    window.removeEventListener('keydown', onDragKeyDown);
    window.removeEventListener('blur', onDragCancel);
  };

  const handleCardPointerDown = (e: React.PointerEvent, game: Game) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return; // 启动游戏按钮不触发拖拽
    e.preventDefault(); // 防止图片原生拖拽/文本选择
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const from = games.findIndex((g) => g.id === game.id);
    setLiveBoth([...games]); // 工作副本：拖拽期间实时重排，松手即最终顺序
    setDragBoth({
      id: game.id,
      from: from < 0 ? 0 : from,
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
    // 边缘自动滚动
    if (e.clientY < rect.top + 60) el.scrollBy({ top: -24 });
    else if (e.clientY > rect.bottom - 60) el.scrollBy({ top: 24 });
    const next: DragState = { ...d, x: e.clientX, y: e.clientY };
    if (!next.active) setEverDragged(true); // 首次激活后永久抑制入场动画重播
    const live = liveRef.current;
    if (next.active && live) {
      // 实时重排：目标槽位（纯几何，与数组顺序无关 → 无反馈回路）变化 → 被拖卡片就地移动，
      // 布局孔洞跟着卡片中心走；卡片始终处于最终位置，松手时布局零变化
      const target = getTargetIndex(next, live.length);
      const cur = live.findIndex((g) => g.id === d.id);
      if (target !== cur) {
        const nextArr = [...live];
        const [moved] = nextArr.splice(cur, 1);
        nextArr.splice(target, 0, moved);
        setLiveBoth(nextArr);
      }
    }
    setDragBoth({ ...next, active: true });
  };

  const onDragPointerUp = async () => {
    const d = dragRef.current;
    cleanupDrag();
    if (!d) return;
    const live = liveRef.current;
    if (d.active) {
      // 落位锁：与清拖拽同一批次提交，让「拖拽卡 opacity 0→1」在禁过渡帧内完成，松手零反馈
      setDropLock(true);
      window.setTimeout(() => setDropLock(false), 80); // 2~4 帧后释放（此时卡片已全部到位，释放无感知）
      setDragBoth(null);
      setLiveBoth(null);
      // 数组已是最终顺序，只需持久化（store 先本地重排再写入，失败自行回滚）
      if (live && d.from !== live.findIndex((g) => g.id === d.id)) {
        await reorderGames(live.map((g) => g.id));
      }
    } else {
      setDragBoth(null);
      setLiveBoth(null);
    }
  };

  const onDragKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      cleanupDrag();
      setDragBoth(null); // 取消：丢弃工作数组，回到 games 原顺序
      setLiveBoth(null);
    }
  };

  const onDragCancel = () => {
    cleanupDrag();
    setDragBoth(null);
    setLiveBoth(null);
  };

  if (games.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center h-full gap-5"
        onContextMenu={handleBlankContextMenu}
      >
        <div className="relative">
          <div className="w-32 h-32 rounded-3xl bg-gradient-to-br from-[#00d4ff]/10 to-[#0066ff]/10 border border-[rgba(0,212,255,0.15)] flex items-center justify-center animate-float">
            <span className="text-6xl opacity-40">🎮</span>
          </div>
          <div className="absolute -inset-4 rounded-full bg-[#00d4ff]/5 blur-2xl animate-pulse" />
        </div>
        <div className="text-center">
          <p className="text-xl font-semibold text-text-primary/60 mb-2">还没有游戏</p>
          <p className="text-sm text-text-tertiary">添加游戏或扫描 Steam 库开始</p>
        </div>

        {libMenu && (
          <LibraryContextMenu x={libMenu.x} y={libMenu.y} onClose={() => setLibMenu(null)}>
            <button onClick={() => { setLibMenu(null); onAddGame?.(); }} className="context-menu-item">
              <Plus size={14} className="text-[#00d4ff]" />
              添加游戏
            </button>
            <button onClick={() => { setLibMenu(null); onOpenSteam?.(); }} className="context-menu-item">
              <Gamepad2 size={14} className="text-text-secondary" />
              Steam 扫描
            </button>
          </LibraryContextMenu>
        )}
      </div>
    );
  }

  const draggedGame = drag?.active ? displayGames.find((g) => g.id === drag.id) : null;

  // x 轴 hidden：悬停缩放（scale 1.02）会让最右列卡片超出右边界 1~2px，overflow-auto 会因此显示横向滚动条；y 轴仍正常滚动
  return (
    <div
      ref={parentRef}
      className="h-full overflow-y-auto overflow-x-hidden"
      style={{ paddingLeft: padX, paddingRight: padX }}
      onContextMenu={handleBlankContextMenu}
    >
      <div
        ref={spacerRef}
        className={clsx(
          drag?.active && 'drag-active',
          // 入场窗口过期后复用 drag-suppress：animation:none 让滚动挂载的卡不再重播入场
          // （card-enter 是 both，关掉动画直接呈现终态，不会闪）；它连带的 :hover 压制也正是
          // 需要的 —— 动画一关，原本压制悬停上浮的保留帧就消失了，得显式压回才和入场时一致
          (everDragged || !introWindow) && 'drag-suppress',
          dropLock && 'drop-instant',
        )}
        style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}
      >
        {virtualizer.getVirtualItems().map((row, vRowIdx) => {
          const start = row.index * colCount;
          const rowGames = displayGames.slice(start, start + colCount);
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
              {rowGames.map((game, colIndex) => {
                // 延迟按卡片在当前可见批次里的位置算，不用全局索引
                const delay = introWindow
                  ? Math.min((vRowIdx * colCount + colIndex) * 40, 440)
                  : 0;
                const globalIndex = row.index * colCount + colIndex;
                return (
                  <GameCard
                    key={game.id}
                    game={game}
                    onLaunch={(e) => { e.stopPropagation(); onLaunch(game.id); }}
                    onContextMenu={(e) => handleContextMenu(e, game)}
                    onPointerDown={dragEnabled ? (e) => handleCardPointerDown(e, game) : undefined}
                    dragging={drag?.active && drag.id === game.id}
                    previewDisabled={drag?.active === true}
                    animationDelay={delay}
                    focused={globalIndex === focusedIndex}
                  />
                );
              })}
            </div>
          );
        })}
      </div>

      {/* 拖拽克隆：跟随指针 */}
      {drag?.active && draggedGame && createPortal(
        <div
          className="drag-clone"
          style={{ left: drag.x - drag.grabDX, top: drag.y - drag.grabDY, width: drag.width }}
        >
          {/* 与原卡同款禁用悬停预览：当前靠 .drag-clone 的 pointer-events:none 兜着，
              一旦那个样式被改动（克隆卡可 hover），漏传会让拖拽中弹出预览卡 */}
          <GameCard game={draggedGame} onLaunch={() => {}} previewDisabled />
        </div>,
        document.body,
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

      {/* 空白区域库级菜单 */}
      {libMenu && (
        <LibraryContextMenu x={libMenu.x} y={libMenu.y} onClose={() => setLibMenu(null)}>
          <button onClick={() => { setLibMenu(null); onAddGame?.(); }} className="context-menu-item">
            <Plus size={14} className="text-[#00d4ff]" />
            添加游戏
          </button>
          <button onClick={() => { setLibMenu(null); onOpenSteam?.(); }} className="context-menu-item">
            <Gamepad2 size={14} className="text-text-secondary" />
            Steam 扫描
          </button>
          {/* 每行数量已移到「设置 → 外观」，右键菜单只保留库级操作 */}
        </LibraryContextMenu>
      )}
    </div>
  );
}
