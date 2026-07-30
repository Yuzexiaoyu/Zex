import { useState, useEffect } from 'react';
import { useAppStore } from '../store';
import * as api from '../api';
import type { Game, GameSession } from '../types';
import {
  X, Play, Pencil, Trash2, Star, Eye, EyeOff, Calendar,
  FileText, Folder
} from 'lucide-react';
import { clsx } from 'clsx';

interface Props {
  gameId: string;
  onClose: () => void;
}

function formatDuration(seconds: number): string {
  if (!seconds) return '-';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDate(iso: string): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function GameDetail({ gameId, onClose }: Props) {
  const { games, updateGame, deleteGame, launchGame } = useAppStore();
  const game = games.find((g) => g.id === gameId);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Game>>({});
  const [sessions, setSessions] = useState<GameSession[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (game) {
      setForm({ ...game });
      api.getGameSessions(gameId).then(setSessions).catch(() => {});
    }
  }, [gameId]);

  if (!game) return null;

  const handleSave = async () => {
    setLoading(true);
    try {
      await updateGame(gameId, form);
      setEditing(false);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`确定要删除 "${game.name}" 吗？`)) return;
    setDeleting(true);
    try {
      await deleteGame(gameId);
    } finally {
      setDeleting(false);
    }
  };

  const handleLaunch = async () => {
    await launchGame(gameId);
  };

  const toggleFavorite = async () => {
    await updateGame(gameId, { favorite: !game.favorite });
  };

  const toggleHidden = async () => {
    await updateGame(gameId, { hidden: !game.hidden });
  };

  const tags: string[] = JSON.parse(game.tags || '[]');

  return (
    <div className="w-80 shrink-0 h-full overflow-y-auto bg-[var(--color-surface-2)] border-l border-[var(--color-border)] animate-slide-in">
      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between p-3 bg-[var(--color-surface-2)] border-b border-[var(--color-border)]">
        <h2 className="font-semibold text-sm truncate">游戏详情</h2>
        <div className="flex items-center gap-1">
          <button onClick={toggleFavorite} className={clsx(
            'p-1.5 rounded transition-colors',
            game.favorite ? 'text-yellow-400' : 'text-[var(--color-text-secondary)]',
          )} title="收藏">
            <Star size={16} fill={game.favorite ? 'currentColor' : 'none'} />
          </button>
          <button onClick={toggleHidden} className={clsx(
            'p-1.5 rounded transition-colors',
            game.hidden ? 'text-gray-500' : 'text-[var(--color-text-secondary)]',
          )} title="隐藏">
            {game.hidden ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          <button onClick={onClose} className="p-1.5 rounded text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Cover */}
      <div className="relative">
        {game.cover_path ? (
          <img src={`file://${game.cover_path}`} alt={game.name} className="w-full aspect-[3/4] object-cover" />
        ) : (
          <div className="w-full aspect-[3/4] bg-[var(--color-surface-3)] flex items-center justify-center text-8xl opacity-30">
            🎮
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-3 space-y-3">
        {/* Name */}
        {editing ? (
          <input
            value={form.name || ''}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full px-3 py-2 rounded-lg bg-[var(--color-surface-3)] border border-[var(--color-border)] text-sm"
          />
        ) : (
          <h3 className="font-bold text-base">{game.name}</h3>
        )}

        {/* Quick stats */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="p-2 rounded-lg bg-[var(--color-surface-3)]">
            <div className="text-sm font-semibold">{formatDuration(game.total_seconds)}</div>
            <div className="text-[10px] text-[var(--color-text-secondary)]">总时长</div>
          </div>
          <div className="p-2 rounded-lg bg-[var(--color-surface-3)]">
            <div className="text-sm font-semibold">{game.play_count}</div>
            <div className="text-[10px] text-[var(--color-text-secondary)]">启动次数</div>
          </div>
          <div className="p-2 rounded-lg bg-[var(--color-surface-3)]">
            <div className="text-sm font-semibold">{game.rating > 0 ? `${game.rating}/10` : '-'}</div>
            <div className="text-[10px] text-[var(--color-text-secondary)]">评分</div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={handleLaunch}
            className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg bg-[var(--color-accent)] text-white text-sm font-medium hover:bg-[var(--color-accent-hover)] transition-colors"
          >
            <Play size={16} /> 启动游戏
          </button>
          <button
            onClick={() => setEditing(!editing)}
            className="p-2 rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors"
          >
            <Pencil size={16} />
          </button>
        </div>

        {/* Edit fields */}
        {editing && (
          <div className="space-y-2 p-3 rounded-lg bg-[var(--color-surface-3)]">
            <label className="text-xs text-[var(--color-text-secondary)]">
              平台 <input value={form.platform || ''} onChange={(e) => setForm({ ...form, platform: e.target.value })} className="w-full mt-1 px-2 py-1 rounded bg-[var(--color-surface-1)] border border-[var(--color-border)] text-xs" />
            </label>
            <label className="text-xs text-[var(--color-text-secondary)]">
              评分 <input type="number" min={0} max={10} value={form.rating || 0} onChange={(e) => setForm({ ...form, rating: Number(e.target.value) })} className="w-full mt-1 px-2 py-1 rounded bg-[var(--color-surface-1)] border border-[var(--color-border)] text-xs" />
            </label>
            <label className="text-xs text-[var(--color-text-secondary)]">
              备注 <textarea value={form.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={3} className="w-full mt-1 px-2 py-1 rounded bg-[var(--color-surface-1)] border border-[var(--color-border)] text-xs resize-none" />
            </label>
            <div className="flex gap-2">
              <button onClick={handleSave} disabled={loading} className="flex-1 py-1.5 rounded bg-[var(--color-accent)] text-white text-xs font-medium">
                {loading ? '保存中...' : '保存'}
              </button>
              <button onClick={() => setEditing(false)} className="flex-1 py-1.5 rounded border border-[var(--color-border)] text-xs">取消</button>
            </div>
          </div>
        )}

        {/* Details */}
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">详情</h4>
          {game.exe_path && (
            <div className="flex items-start gap-2 text-xs">
              <Folder size={12} className="mt-0.5 shrink-0 text-[var(--color-text-secondary)]" />
              <span className="text-[var(--color-text-secondary)] truncate" title={game.exe_path}>{game.exe_path}</span>
            </div>
          )}
          {game.notes && (
            <div className="flex items-start gap-2 text-xs">
              <FileText size={12} className="mt-0.5 shrink-0 text-[var(--color-text-secondary)]" />
              <span className="text-[var(--color-text-secondary)]">{game.notes}</span>
            </div>
          )}
          <div className="flex items-center gap-2 text-xs">
            <Calendar size={12} className="text-[var(--color-text-secondary)]" />
            <span className="text-[var(--color-text-secondary)]">添加于 {formatDate(game.created_at)}</span>
          </div>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {tags.map((tag) => (
                <span key={tag} className="badge">{tag}</span>
              ))}
            </div>
          )}
        </div>

        {/* Session history */}
        {sessions.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">最近游玩</h4>
            {sessions.slice(0, 5).map((s) => (
              <div key={s.id} className="flex items-center justify-between text-xs py-1 border-b border-[var(--color-border)]">
                <span className="text-[var(--color-text-secondary)]">{formatDate(s.started_at)}</span>
                <span className="font-medium">{formatDuration(s.duration_seconds)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Delete */}
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border border-[var(--color-danger)] text-[var(--color-danger)] text-sm hover:bg-[var(--color-danger)] hover:text-white transition-colors"
        >
          <Trash2 size={14} />
          {deleting ? '删除中...' : '删除游戏'}
        </button>
      </div>
    </div>
  );
}
