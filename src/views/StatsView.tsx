import { useEffect, useRef, useState } from 'react';
import { BarChart3, Gamepad2, Film, Music } from 'lucide-react';
import { useAppStore } from '../store';
import { useFocusIndex, useFocusStore, useGamepadGroup, useRightStickScrollIf } from '../gamepad';
import type { Stats } from '../types';
import { RowCard, longDur, MEDIA_COLORS } from '../components/StatsCovers';

const SECTIONS = [
  // 次数只统计音乐（games/series 的 count 恒为 0，前端不显示）
  { key: 'game', label: '游戏', icon: Gamepad2, color: MEDIA_COLORS.game, unit: '款' },
  { key: 'video', label: '影视', icon: Film, color: MEDIA_COLORS.video, unit: '部' },
  { key: 'music', label: '音乐', icon: Music, color: MEDIA_COLORS.music, countLabel: '次播放', unit: '首' },
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
function ColSection({ stats, section, colOrder }: {
  stats: Stats;
  section: (typeof SECTIONS)[number];
  colOrder: SectionKey[];  // 可见列顺序（隐藏的库不在内），手柄左右跨列按它跳转
}) {
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
        section.key === 'music' && d.play_count > 0 && <b>{d.play_count.toLocaleString()} {section.countLabel}</b>}
        <span>{d.played_count}/{d.library_count} {section.unit}</span>
        {section.key === 'video' && (
          <span>已看 {stats.total_watched_episodes}/{stats.total_episodes} 集</span>
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
            />
          ))}
        </div>
      ) : (
        <div className="stats-col-empty">还没有记录</div>
      )}
    </section>
  );
}

export default function StatsView() {
  const stats = useAppStore((s) => s.stats);
  const loadStats = useAppStore((s) => s.loadStats);
  // 隐藏的库 → 统计页去掉对应列（数据一次拉全量，只影响展示）
  const hiddenLibraries = useAppStore((s) => s.hiddenLibraries);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    loadStats().catch((e) => setError(typeof e === 'string' ? e : (e?.message ?? String(e))));
  }, []);

  // 空态判断看库存量而非总时长：添加了游戏但还没玩过（总时长为 0）时，
  // 游戏列仍要展示「未游玩」条目，不能整页显示「还没有任何记录」
  const hasData = !!stats
    && (stats.game.library_count + stats.video.library_count + stats.music.library_count) > 0;

  if (error) {
    return (
      <div className="h-full flex items-center justify-center px-8">
        <div className="text-center">
          <BarChart3 size={40} className="mx-auto mb-3 text-text-tertiary" />
          <p className="text-base font-semibold mb-1">统计数据读取失败</p>
          <p className="text-sm text-text-secondary">{error}</p>
        </div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="stats-skeleton-pulse text-text-tertiary text-sm">正在统计…</div>
      </div>
    );
  }

  if (!hasData) {
    return (
      <div className="h-full flex items-center justify-center px-8">
        <div className="text-center animate-fade-up">
          <div className="stats-empty-orb mx-auto mb-6"><BarChart3 size={38} /></div>
          <h2 className="text-xl font-bold mb-2">还没有任何记录</h2>
          <p className="text-sm text-text-secondary max-w-sm mx-auto leading-relaxed">
            玩一局游戏、看一集剧、听一首歌，这里就会开始记录你的时间。
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
        <div className="stats-cols" style={{ ['--cols' as string]: visibleSections.length }}>
          {visibleSections.map((s) => (
            <ColSection key={s.key} stats={stats} section={s} colOrder={visibleOrder} />
          ))}
        </div>
      </div>
    </div>
  );
}
