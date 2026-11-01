import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { BarChart3, Gamepad2, Film, Music, Clock, RectangleHorizontal, Trash2 } from 'lucide-react';
import { message } from '@tauri-apps/plugin-dialog';
import { useAppStore } from '../store';
import { useFocusIndex, useFocusStore, useGamepadGroup, useRightStickScrollIf } from '../gamepad';
import type { Stats, TopEntry } from '../types';
import * as api from '../api';
import { RowCard, longDur, MEDIA_COLORS } from '../components/StatsCovers';
import StatsAdjustModal from '../components/StatsAdjustModal';
import CoverPickerModal from '../components/CoverPickerModal';
import { useT } from '../i18n';
import { preloadStatsImages } from '../utils/statsPreload';
import { statsCoverSrc, useStatsCoverScale } from '../utils/statsImages';

// label/unit/countLabel 存 i18n key，渲染时 t() 取词
const SECTIONS = [
  // 次数只统计音乐（games/series 的 count 恒为 0，前端不显示）
  { key: 'game', label: 'stats.game', icon: Gamepad2, color: MEDIA_COLORS.game, unit: 'stats.unitGame' },
  { key: 'video', label: 'stats.video', icon: Film, color: MEDIA_COLORS.video, unit: 'stats.unitVideo' },
  { key: 'music', label: 'stats.music', icon: Music, color: MEDIA_COLORS.music, countLabel: 'stats.playCount', unit: 'stats.unitMusic' },
] as const;

type SectionKey = (typeof SECTIONS)[number]['key'];

// SECTIONS key → hiddenLibraries id：隐藏哪个库，统计页就去掉那一列
const SECTION_LIB: Record<SectionKey, 'games' | 'series' | 'music'> = {
  game: 'games',
  video: 'series',
  music: 'music',
};

// 统计页第一个可见列的焦点组名。App 切视图时把手柄焦点落进该组：
// 若游戏库被隐藏，'stats:col:game' 组不存在，reset 到未注册组会让手柄方向键静默失效
export function firstVisibleStatsGroup(hidden: Array<'games' | 'series' | 'music' | 'stats'>): string {
  const order: Array<[SectionKey, 'games' | 'series' | 'music']> = [
    ['game', 'games'],
    ['video', 'series'],
    ['music', 'music'],
  ];
  for (const [k, lib] of order) {
    if (!hidden.includes(lib)) return `stats:col:${k}`;
  }
  return 'stats:col:game'; // 不可达：主库至少 1 个可见
}

// 各列当前焦点索引（模块级，不是 React state）：跨列切换时要恢复目标列上次的焦点位置。
// scrollIntoView 在每次焦点移动后调用（含 switchTo），所以这里永远是最新值
const colIdx: Record<SectionKey, number> = { game: 0, video: 0, music: 0 };
const NO_UNAVAILABLE_COVERS: ReadonlySet<string> = new Set();

/** 单列：类别标题 + 总时长 + 封面网格。
 *  每个类别一个手柄焦点组（'stats:col:xxx'）——左右键跨列、上下键在列内移动 */
function ColSection({ stats, section, colOrder, onOpenMenu, ready, unavailableCovers, coverScale }: {
  stats: Stats;
  section: (typeof SECTIONS)[number];
  colOrder: SectionKey[];  // 可见列顺序（隐藏的库不在内），手柄左右跨列按它跳转
  onOpenMenu: (e: React.MouseEvent, entry: TopEntry) => void; // 行右键（仅游戏列绑定）
  ready: boolean;
  unavailableCovers: ReadonlySet<string>;
  coverScale: number;
}) {
  const t = useT();
  const d = stats[section.key];
  const Icon = section.icon;
  const top = d.top;
  const group = `stats:col:${section.key}`;
  const focusedIndex = useFocusIndex(group);
  // 行列表容器：每列独立滚动（页面本身不滚动）。右摇杆只滚当前焦点列 ——
  // 本列是焦点栈顶时注册为滚动目标，焦点跨列后自动撤销
  const rowsRef = useRef<HTMLDivElement>(null);
  const rowKey = useCallback((i: number) => top[i].id, [top]);
  const virtualizer = useVirtualizer({
    count: top.length,
    getScrollElement: () => rowsRef.current,
    estimateSize: () => 88,
    gap: 6,
    overscan: 3,
    getItemKey: rowKey,
    // 隐藏常驻也预先建立首屏行，首次显示无需先等 ResizeObserver 回调。
    initialRect: { width: 0, height: window.innerHeight },
  });
  const isTopGroup = useFocusStore((s) => s.stack[s.stack.length - 1]?.group === group);
  useRightStickScrollIf(rowsRef, ready && isTopGroup);

  // 跳到相邻有内容的列（循环跳过空列），焦点落在该列上次的位置
  const jumpCol = (from: number, dir: 1 | -1) => {
    for (let step = 1; step <= colOrder.length; step++) {
      const n = (from + dir * step + colOrder.length) % colOrder.length;
      const nk = colOrder[n];
      if (stats[nk].top.length > 0) {
        useFocusStore.getState().switchTo(
          `stats:col:${nk}`,
          Math.min(colIdx[nk], stats[nk].top.length - 1),
        );
        return;
      }
    }
  };

  useGamepadGroup(group, {
    // 每列是纵向行列表（一行一个项目）：上下在列内移动，左右直接跨列
    count: ready ? top.length : 0,
    cols: 1,
    scrollIntoView: (i) => {
      if (!ready) return;
      colIdx[section.key] = i;
      // 目标可能尚未挂载，先滚到对应虚拟行，再由虚拟列表挂载并显示焦点。
      virtualizer.scrollToIndex(i, { align: 'auto' });
    },
    activate: () => {},
    horizontal: (dir) => {
      if (!ready) return true;
      // 一行只有一项，左右没有列内移动可言：直接跳到相邻列
      jumpCol(colOrder.indexOf(section.key), dir === 'right' ? 1 : -1);
      return true;
    },
    leave: (dir) => {
      // 列顶再上 → 回顶部导航
      if (dir === 'up') useFocusStore.getState().switchTo('nav');
    },
  });

  // 只挂载可见行及缓冲区，避免首次显示时整列 500 行参与样式计算与绘制。
  const virtualRows = virtualizer.getVirtualItems();
  const rows = useMemo(() => virtualRows.map((row) => {
    const i = row.index;
    const e = top[i];
    return (
      <div key={row.key} className="stats-virtual-row" style={{ top: row.start }}>
        <RowCard
          entry={e}
          media={section.key}
          color={section.color}
          rank={i + 1}
          focused={focusedIndex === i}
          anchor={`${section.key}-${i}`}
          coverUnavailable={unavailableCovers.has(statsCoverSrc(e, coverScale))}
          coverScale={coverScale}
          onContextMenu={section.key === 'game' ? onOpenMenu : undefined}
        />
      </div>
    );
  }), [virtualRows, top, section, focusedIndex, onOpenMenu, unavailableCovers, coverScale]);

  // 每次切入只编排当前可视的行；滚动/刷新后新挂载的行直接显示，不重复入场。
  // 先批量读取几何信息，再写入标记，避免逐行读写引起反复布局。
  useLayoutEffect(() => {
    const container = rowsRef.current;
    if (!ready || !container) return;
    const bounds = container.getBoundingClientRect();
    const visibleTop = Math.max(bounds.top, 0);
    const visibleBottom = Math.min(bounds.bottom, window.innerHeight);
    if (visibleBottom <= visibleTop) return;
    const enteringRows = Array.from(container.querySelectorAll<HTMLElement>('.stats-virtual-row')).filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > visibleTop && rect.top < visibleBottom;
    });
    enteringRows.forEach((row, index) => {
      row.style.setProperty('--stats-row-delay', `${85 + Math.min(index, 7) * 22}ms`);
      row.setAttribute('data-stats-row-enter', '');
    });
    return () => {
      enteringRows.forEach((row) => {
        row.removeAttribute('data-stats-row-enter');
        row.style.removeProperty('--stats-row-delay');
      });
    };
  }, [ready]);

  return (
    <section className="stats-col" style={{ ['--cc' as string]: section.color }}>
      {/* 标题行下面原本有一行小字（次数 / 已玩 X/Y / 已看集数），已按要求删掉；
          间距由 .stats-col-head 的下外边距接管 */}
      <div className="stats-col-head">
        <h2><Icon size={15} />{t(section.label)}</h2>
        <span className="stats-col-total">{longDur(d.total_seconds)}</span>
      </div>

      {top.length > 0 ? (
        <div className="stats-col-rows" ref={rowsRef}>
          <div className="stats-virtual-space" style={{ height: virtualizer.getTotalSize() }}>
            {rows}
          </div>
        </div>
      ) : (
        <div className="stats-col-empty">{t('stats.noRecords')}</div>
      )}
    </section>
  );
}

/** 启动后台预渲染的静态布局；数据未就绪时由 App 保留此前页面。 */
function StatsPlaceholder({ sections }: { sections: readonly (typeof SECTIONS)[number][] }) {
  const t = useT();
  return (
    <div className="stats-page stats-placeholder" aria-busy="true" aria-label={t('stats.loading')}>
      <div className="stats-cols" style={{ ['--cols' as string]: sections.length }}>
        {sections.map((section) => {
          const Icon = section.icon;
          return (
            <section key={section.key} className="stats-col" style={{ ['--cc' as string]: section.color }}>
              <div className="stats-col-head">
                <h2><Icon size={15} />{t(section.label)}</h2>
                <span className="stats-placeholder-total" />
              </div>
              <div className="stats-placeholder-rows" aria-hidden="true">
                {Array.from({ length: 8 }, (_, index) => (
                  <div key={index} className="stats-row stats-placeholder-row">
                    <div className={`stats-placeholder-cover ${section.key === 'music' ? 'stats-row-cover-square' : 'stats-row-cover-wide'}`} />
                    <div className="stats-row-body"><span className="stats-placeholder-name" /></div>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export default function StatsView({ active }: { active: boolean }) {
  const t = useT();
  const coverScale = useStatsCoverScale();
  const stats = useAppStore((s) => s.stats);
  const loadStats = useAppStore((s) => s.loadStats);
  const preparePresentation = useAppStore((s) => s.prepareStatsPresentation);
  const unavailableCovers = useAppStore((s) => s.statsPresentation?.unavailableCovers ?? NO_UNAVAILABLE_COVERS);
  // 隐藏的库 → 统计页去掉对应列（数据一次拉全量，只影响展示）
  const hiddenLibraries = useAppStore((s) => s.hiddenLibraries);
  const visibleSections = useMemo(() => SECTIONS.filter((s) => !hiddenLibraries.includes(SECTION_LIB[s.key])), [hiddenLibraries]);
  const visibleOrder = useMemo(() => visibleSections.map((s) => s.key), [visibleSections]);
  const [error, setError] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  // 游戏行右键菜单、「调整时长」弹窗、换悬停封面弹窗（均为纯鼠标功能，不注册手柄组）
  const [menu, setMenu] = useState<{ x: number; y: number; entry: TopEntry } | null>(null);
  const [adjusting, setAdjusting] = useState<TopEntry | null>(null);
  const [coverEntry, setCoverEntry] = useState<TopEntry | null>(null);

  // 和三个库共用 App 启动预载的 store；切页不再刷新已缓存的数据。
  // 后台在库数据/播放状态改变时更新统计，这里只处理启动尚未完成或失败的兜底。
  useEffect(() => {
    if (useAppStore.getState().stats) return;
    let alive = true;
    void loadStats().then(
      () => { if (alive) setError(null); },
      (e) => { if (alive) setError(typeof e === 'string' ? e : (e?.message ?? String(e))); },
    );
    return () => { alive = false; };
  }, [active, loadStats]);

  useEffect(() => {
    if (active) return;
    setMenu(null);
    setAdjusting(null);
    setCoverEntry(null);
  }, [active]);

  const refreshStats = async () => {
    setError(null);
    try {
      await loadStats();
    } catch (e) {
      setError(typeof e === 'string' ? e : (e instanceof Error ? e.message : String(e)));
    }
  };

  // 删掉一条「库外」统计记录：库里没有这个游戏、也没有它的归档，删的就是统计页这条历史本身
  const deleteRecord = async (entry: TopEntry) => {
    if (!confirm(t('stats.deleteRecordConfirm', { name: entry.name }))) return;
    try {
      await api.deleteStatsEntry(entry.id);
      await refreshStats();
    } catch (err) {
      await message(
        t('stats.deleteRecordFailed', { msg: typeof err === 'string' ? err : ((err as any)?.message ?? String(err)) }),
        { title: t('stats.deleteRecord'), kind: 'error' },
      );
    }
  };

  // 游戏行右键：记菜单位置（事件需 stopPropagation，否则冒泡到页面容器被当成空白右键关掉）
  const openRowMenu = useCallback((e: React.MouseEvent, entry: TopEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);

  // 实体已删除时，历史统计仍由 stats_archive 续存；未游玩的实体也属于有效数据。
  const hasData = !!stats && [stats.game, stats.video, stats.music].some((media) =>
    media.library_count > 0 || media.top.length > 0 || media.total_seconds > 0 || media.play_count > 0);

  // 隐藏期间也有真实布局，启动即可解码首屏；仅数据/可见库变化时更新预热。
  // active 不参与依赖，缓存切页不重新读图、不卸载行；首次就绪再交接显示。
  useLayoutEffect(() => {
    if ((!stats && error) || (stats && !hasData)) {
      preparePresentation(stats, hiddenLibraries);
      return;
    }
    if (!stats || !pageRef.current) return;
    let firstFrame = 0;
    let secondFrame = 0;
    const dispose = preloadStatsImages(pageRef.current, ({ unavailableSources }) => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => preparePresentation(stats, hiddenLibraries, unavailableSources));
      });
    });
    return () => {
      dispose();
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [stats, hasData, hiddenLibraries, error, preparePresentation, coverScale]);

  if (error && !stats) {
    return (
      <div className="h-full flex items-center justify-center px-8">
        <div className="text-center">
          <BarChart3 size={40} className="mx-auto mb-3 text-text-tertiary" />
          <p className="text-base font-semibold mb-1">{t('stats.loadFailed')}</p>
          <p className="text-sm text-text-secondary">{error}</p>
        </div>
      </div>
    );
  }

  if (!stats) {
    return <StatsPlaceholder sections={visibleSections} />;
  }

  if (!hasData) {
    return (
      <div className="h-full flex items-center justify-center px-8">
        <div className={`text-center${active ? ' stats-empty-enter' : ''}`}>
          <div className="empty-orb mx-auto mb-6"><BarChart3 size={38} /></div>
          <h2 className="text-xl font-bold mb-2">{t('stats.emptyTitle')}</h2>
          <p className="text-sm text-text-secondary max-w-sm mx-auto leading-relaxed">
            {t('stats.emptyDesc')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full">
      {/* 数据、行和封面常驻；进入时同一帧启用动画，切走移除，下一次进入重新播放。 */}
      <div
        ref={pageRef}
        className="stats-page"
        data-stats-enter={active ? '' : undefined}
      >
        {/* 列数走 CSS 变量而非内联 gridTemplateColumns：内联会压过窄窗口（≤1200px）的单列媒体查询 */}
        <div
          className="stats-cols"
          style={{ ['--cols' as string]: visibleSections.length }}
          // 右键空白区域关菜单（与游戏库/影视库容器行为一致）
          onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
        >
          {visibleSections.map((s) => (
            <ColSection key={s.key} stats={stats} section={s} colOrder={visibleOrder} onOpenMenu={openRowMenu} ready={active} unavailableCovers={unavailableCovers} coverScale={coverScale} />
          ))}
        </div>
      </div>

      {/* 游戏行右键菜单（纯鼠标：外部点击 / Esc / 空白右键关闭） */}
      {active && menu && (
        <StatsRowMenu
          x={menu.x}
          y={menu.y}
          name={menu.entry.name}
          onClose={() => setMenu(null)}
          onAdjust={() => setAdjusting(menu.entry)}
          // 「库外记录」（存档行，id 形如 game:app:<appid>）也能换封面 —— 后端认这种 key，
          // 写的是 stats_archive 的 wide_path；库里没有这个游戏/归档时才给「删去这条记录」
          onChangeBanner={() => setCoverEntry(menu.entry)}
          onDelete={menu.entry.id.startsWith('game:') ? () => void deleteRecord(menu.entry) : null}
        />
      )}

      {/* 更换悬停封面弹窗：行上的封面就是横屏图，所以只取横屏候选（等效游戏库的「更换悬停封面」） */}
      {active && coverEntry && (
        <CoverPickerModal
          game={coverEntry}
          kind="wide"
          onClose={() => setCoverEntry(null)}
          onApplied={() => {
            setCoverEntry(null);
            void refreshStats();
          }}
        />
      )}

      {/* 调整时长弹窗 */}
      {active && adjusting && (
        <StatsAdjustModal
          entry={adjusting}
          onClose={() => setAdjusting(null)}
          onSaved={() => {
            setAdjusting(null);
            void refreshStats();
          }}
        />
      )}
    </div>
  );
}

/** 游戏行右键菜单：样式对齐 SeriesContextMenu（glass-card + context-menu-item + 视口 clamp）。
 *  纯鼠标功能，不注册手柄焦点组；统计页只有行上有右键，空白右键/外部点击/Esc 都可关闭 */
function StatsRowMenu({ x, y, name, onChangeBanner, onDelete, onAdjust, onClose }: {
  x: number;
  y: number;
  name: string;
  onChangeBanner: () => void | null;
  onDelete: (() => void) | null; // null = 库里的游戏（行有实体，删除走右键菜单里那套）
  onAdjust: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [measured, setMeasured] = useState(false);

  // Clamp to viewport after measuring real size (first frame hidden)
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - el.offsetWidth - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - el.offsetHeight - 8)),
    });
    setMeasured(true);
  }, [x, y]);

  // 外部点击 / Esc 关闭（菜单只有一项，无手柄组可兜底，鼠标路径必须闭环）
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[100]"
      style={{ left: pos.left, top: pos.top, visibility: measured ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="glass-card w-52 py-1.5 animate-scale-in">
        {/* 换悬停封面：图标/文案与游戏库卡片右键菜单那一项对齐（同一件事） */}
        {onChangeBanner && (
          <>
            <button
              onClick={() => { onClose(); onChangeBanner(); }}
              className="context-menu-item"
              title={name}
            >
              <RectangleHorizontal size={14} className="text-text-secondary" />
              {t('games.changeBanner')}
            </button>
            <div className="context-menu-divider" />
          </>
        )}
        <button
          onClick={() => { onClose(); onAdjust(); }}
          className="context-menu-item"
          title={name}
        >
          <Clock size={14} className="text-[#00d4ff]" />
          {t('stats.adjustDuration')}
        </button>
        {/* 库外记录才有：库里既没有这个游戏、也没有它的归档 —— 删的就是统计页这条历史 */}
        {onDelete && (
          <>
            <div className="context-menu-divider" />
            <button
              onClick={() => { onClose(); onDelete(); }}
              className="context-menu-item text-danger"
              title={name}
            >
              <Trash2 size={14} />
              {t('stats.deleteRecord')}
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
