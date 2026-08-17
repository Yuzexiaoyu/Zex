import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BarChart3, Gamepad2, Film, Music, Clock } from 'lucide-react';
import { useAppStore } from '../store';
import { useFocusIndex, useFocusStore, useGamepadGroup, useRightStickScrollIf } from '../gamepad';
import type { Stats, TopEntry } from '../types';
import { RowCard, longDur, MEDIA_COLORS } from '../components/StatsCovers';
import StatsAdjustModal from '../components/StatsAdjustModal';
import { useT } from '../i18n';

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

/** 单列：类别标题 + 总时长 + 封面网格。
 *  每个类别一个手柄焦点组（'stats:col:xxx'）——左右键跨列、上下键在列内移动 */
function ColSection({ stats, section, colOrder, onOpenMenu }: {
  stats: Stats;
  section: (typeof SECTIONS)[number];
  colOrder: SectionKey[];  // 可见列顺序（隐藏的库不在内），手柄左右跨列按它跳转
  onOpenMenu: (e: React.MouseEvent, entry: TopEntry) => void; // 行右键（仅游戏列绑定）
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
  const isTopGroup = useFocusStore((s) => s.stack[s.stack.length - 1]?.group === group);
  useRightStickScrollIf(rowsRef, isTopGroup);

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
    count: top.length,
    cols: 1,
    scrollIntoView: (i) => {
      colIdx[section.key] = i;
      document.querySelector(`[data-stat-cover="${section.key}-${i}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    activate: () => {},
    horizontal: (dir) => {
      // 一行只有一项，左右没有列内移动可言：直接跳到相邻列
      jumpCol(colOrder.indexOf(section.key), dir === 'right' ? 1 : -1);
      return true;
    },
    leave: (dir) => {
      // 列顶再上 → 回顶部导航
      if (dir === 'up') useFocusStore.getState().switchTo('nav');
    },
  });

  return (
    <section className="stats-col" style={{ ['--cc' as string]: section.color }}>
      <div className="stats-col-head">
        <h2><Icon size={15} />{section.label}</h2>
        <span className="stats-col-total">{longDur(d.total_seconds)}</span>
      </div>

      <div className="stats-col-sub">
        {/* 次数只给音乐；游戏/影视只有时长和库存 */
        section.key === 'music' && d.play_count > 0 && <b>{d.play_count.toLocaleString()} {t(section.countLabel!)}</b>}
        <span>{d.played_count}/{d.library_count} {t(section.unit)}</span>
        {section.key === 'video' && (
          <span>{t('stats.watchedEpisodes', { watched: stats.total_watched_episodes, total: stats.total_episodes })}</span>
        )}
      </div>

      {top.length > 0 ? (
        <div className="stats-col-rows" ref={rowsRef}>
          {top.map((e, i) => (
            <RowCard
              key={e.id}
              entry={e}
              media={section.key}
              color={section.color}
              rank={i + 1}
              focused={focusedIndex === i}
              anchor={`${section.key}-${i}`}
              // 右键调整时长只给游戏列（影视/音乐行不绑，保持无右键行为）
              onContextMenu={section.key === 'game' ? (ev) => onOpenMenu(ev, e) : undefined}
            />
          ))}
        </div>
      ) : (
        <div className="stats-col-empty">{t('stats.noRecords')}</div>
      )}
    </section>
  );
}

export default function StatsView() {
  const t = useT();
  const stats = useAppStore((s) => s.stats);
  const loadStats = useAppStore((s) => s.loadStats);
  // 隐藏的库 → 统计页去掉对应列（数据一次拉全量，只影响展示）
  const hiddenLibraries = useAppStore((s) => s.hiddenLibraries);
  const [error, setError] = useState<string | null>(null);
  // 游戏行右键菜单与「调整时长」弹窗（均为纯鼠标功能，不注册手柄组）
  const [menu, setMenu] = useState<{ x: number; y: number; entry: TopEntry } | null>(null);
  const [adjusting, setAdjusting] = useState<TopEntry | null>(null);

  useEffect(() => {
    setError(null);
    loadStats().catch((e) => setError(typeof e === 'string' ? e : (e?.message ?? String(e))));
  }, []);

  const refreshStats = async () => {
    setError(null);
    try {
      await loadStats();
    } catch (e) {
      setError(typeof e === 'string' ? e : (e instanceof Error ? e.message : String(e)));
    }
  };

  // 游戏行右键：记菜单位置（事件需 stopPropagation，否则冒泡到页面容器被当成空白右键关掉）
  const openRowMenu = (e: React.MouseEvent, entry: TopEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entry });
  };

  // 空态判断看库存量而非总时长：添加了游戏但还没玩过（总时长为 0）时，
  // 游戏列仍要展示「未游玩」条目，不能整页显示「还没有任何记录」
  const hasData = !!stats
    && (stats.game.library_count + stats.video.library_count + stats.music.library_count) > 0;

  if (error) {
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
    return (
      <div className="h-full flex items-center justify-center">
        <div className="stats-skeleton-pulse text-text-tertiary text-sm">{t('stats.loading')}</div>
      </div>
    );
  }

  if (!hasData) {
    return (
      <div className="h-full flex items-center justify-center px-8">
        <div className="text-center animate-fade-up">
          <div className="stats-empty-orb mx-auto mb-6"><BarChart3 size={38} /></div>
          <h2 className="text-xl font-bold mb-2">{t('stats.emptyTitle')}</h2>
          <p className="text-sm text-text-secondary max-w-sm mx-auto leading-relaxed">
            {t('stats.emptyDesc')}
          </p>
        </div>
      </div>
    );
  }

  // 可见列与跨列顺序：按 hiddenLibraries 过滤，隐藏的库不进统计页
  const visibleSections = SECTIONS.filter((s) => !hiddenLibraries.includes(SECTION_LIB[s.key]));
  const visibleOrder = visibleSections.map((s) => s.key);

  return (
    <div className="h-full">
      <div className="stats-page">
        {/* 列数走 CSS 变量而非内联 gridTemplateColumns：内联会压过窄窗口（≤1200px）的单列媒体查询 */}
        <div
          className="stats-cols"
          style={{ ['--cols' as string]: visibleSections.length }}
          // 右键空白区域关菜单（与游戏库/影视库容器行为一致）
          onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
        >
          {visibleSections.map((s) => (
            <ColSection key={s.key} stats={stats} section={s} colOrder={visibleOrder} onOpenMenu={openRowMenu} />
          ))}
        </div>
      </div>

      {/* 游戏行右键菜单（纯鼠标：外部点击 / Esc / 空白右键关闭） */}
      {menu && (
        <StatsRowMenu
          x={menu.x}
          y={menu.y}
          name={menu.entry.name}
          onClose={() => setMenu(null)}
          onAdjust={() => setAdjusting(menu.entry)}
        />
      )}

      {/* 调整时长弹窗 */}
      {adjusting && (
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
function StatsRowMenu({ x, y, name, onAdjust, onClose }: {
  x: number;
  y: number;
  name: string;
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
        <button
          onClick={() => { onClose(); onAdjust(); }}
          className="context-menu-item"
          title={name}
        >
          <Clock size={14} className="text-[#00d4ff]" />
          {t('stats.adjustDuration')}
        </button>
      </div>
    </div>,
    document.body,
  );
}
