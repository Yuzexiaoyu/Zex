import { useEffect } from 'react';
import { useAppStore } from '../store';
import { BarChart3, Clock, Gamepad2, Film, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';
import type { GameSession, Game } from '../types';

function formatDuration(seconds: number): string {
  if (!seconds) return '-';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

export default function StatsView() {
  const { stats, loadStats } = useAppStore();

  useEffect(() => { loadStats(); }, []);

  if (!stats) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw size={32} className="animate-spin text-[var(--color-accent)]" />
      </div>
    );
  }

  const weekHours = Math.round(stats.week_play_time_seconds / 3600 * 10) / 10;
  const monthHours = Math.round(stats.month_play_time_seconds / 3600 * 10) / 10;

  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="text-2xl font-bold mb-6">📊 统计数据</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="p-5 rounded-2xl bg-[var(--color-surface-2)] border border-[var(--color-border)]">
          <div className="flex items-center gap-3 mb-2">
            <Gamepad2 size={20} className="text-[var(--color-accent)]" />
            <span className="text-sm text-[var(--color-text-secondary)]">游戏库</span>
          </div>
          <div className="text-3xl font-bold">{stats.total_games}</div>
          <div className="text-xs text-[var(--color-text-secondary)] mt-1">个游戏</div>
        </div>

        <div className="p-5 rounded-2xl bg-[var(--color-surface-2)] border border-[var(--color-border)]">
          <div className="flex items-center gap-3 mb-2">
            <Film size={20} className="text-purple-400" />
            <span className="text-sm text-[var(--color-text-secondary)]">影视库</span>
          </div>
          <div className="text-3xl font-bold">{stats.total_series}</div>
          <div className="text-xs text-[var(--color-text-secondary)] mt-1">个剧集</div>
        </div>

        <div className="p-5 rounded-2xl bg-[var(--color-surface-2)] border border-[var(--color-border)]">
          <div className="flex items-center gap-3 mb-2">
            <Clock size={20} className="text-green-400" />
            <span className="text-sm text-[var(--color-text-secondary)]">本周游戏</span>
          </div>
          <div className="text-3xl font-bold">{weekHours}h</div>
          <div className="text-xs text-[var(--color-text-secondary)] mt-1">游戏时长</div>
        </div>

        <div className="p-5 rounded-2xl bg-[var(--color-surface-2)] border border-[var(--color-border)]">
          <div className="flex items-center gap-3 mb-2">
            <BarChart3 size={20} className="text-yellow-400" />
            <span className="text-sm text-[var(--color-text-secondary)]">本月游戏</span>
          </div>
          <div className="text-3xl font-bold">{monthHours}h</div>
          <div className="text-xs text-[var(--color-text-secondary)] mt-1">游戏时长</div>
        </div>
      </div>

      {/* Top games */}
      {stats.top_games.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-4">🏆 游戏时长排行</h2>
          <div className="rounded-2xl bg-[var(--color-surface-2)] border border-[var(--color-border)] overflow-hidden">
            {stats.top_games.map((game: Game & { total_seconds: number }, i: number) => (
              <div key={game.id} className="flex items-center gap-4 px-5 py-3 border-b border-[var(--color-border)] last:border-0">
                <span className={clsx(
                  'text-lg font-bold w-8 text-center',
                  i === 0 ? 'text-yellow-400' : i === 1 ? 'text-gray-300' : i === 2 ? 'text-amber-600' : 'text-[var(--color-text-secondary)]',
                )}>
                  {i + 1}
                </span>
                <div className="w-10 h-14 rounded overflow-hidden bg-[var(--color-surface-3)] shrink-0">
                  {game.cover_path ? (
                    <img src={`file://${game.cover_path}`} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-lg opacity-30">🎮</div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{game.name}</p>
                  <p className="text-xs text-[var(--color-text-secondary)]">{game.play_count} 次游玩</p>
                </div>
                <span className="text-sm font-semibold shrink-0">{formatDuration(game.total_seconds)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent sessions */}
      {stats.recent_sessions.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-4">🕐 最近游玩记录</h2>
          <div className="rounded-2xl bg-[var(--color-surface-2)] border border-[var(--color-border)] overflow-hidden">
            {stats.recent_sessions.map((s: GameSession, i: number) => (
              <div key={i} className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-border)] last:border-0">
                <span className="text-sm text-[var(--color-text-secondary)]">{formatDate(s.started_at)}</span>
                <span className="text-sm font-medium">{formatDuration(s.duration_seconds)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {stats.total_games === 0 && (
        <div className="text-center py-16 text-[var(--color-text-secondary)]">
          <BarChart3 size={64} className="mx-auto mb-4 opacity-20" />
          <p className="text-lg">还没有游玩数据</p>
          <p className="text-sm mt-2">启动游戏后这里会显示你的游玩统计</p>
        </div>
      )}
    </div>
  );
}
