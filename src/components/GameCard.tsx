import { clsx } from 'clsx';
import { Star, EyeOff, Play } from 'lucide-react';
import type { Game } from '../types';

interface Props {
  game: Game;
  selected?: boolean;
  onClick: () => void;
  onLaunch: (e: React.MouseEvent) => void;
}

function formatTime(seconds: number): string {
  if (seconds === 0) return '未玩过';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function GameCard({ game, selected, onClick, onLaunch }: Props) {
  return (
    <div
      onClick={onClick}
      className={clsx(
        'card group relative rounded-xl overflow-hidden cursor-pointer transition-all duration-150',
        'bg-[var(--color-surface-2)] border-2',
        selected
          ? 'border-[var(--color-accent)] shadow-lg shadow-accent/20'
          : 'border-transparent hover:border-[var(--color-border)] hover:scale-[1.02]',
      )}
    >
      {/* Cover */}
      <div className="relative aspect-[3/4] bg-[var(--color-surface-3)]">
        {game.cover_path ? (
          <img
            src={`file://${game.cover_path}`}
            alt={game.name}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-6xl opacity-30">
            🎮
          </div>
        )}

        {/* Overlay on hover */}
        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3">
          <button
            onClick={onLaunch}
            className={clsx(
              'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold',
              'bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors',
              'active:scale-95',
            )}
          >
            <Play size={16} />
            启动
          </button>
        </div>

        {/* Badges */}
        <div className="absolute top-2 left-2 flex gap-1">
          {game.favorite && (
            <span className="p-1 rounded bg-black/50 text-yellow-400">
              <Star size={12} fill="currentColor" />
            </span>
          )}
          {game.hidden && (
            <span className="p-1 rounded bg-black/50 text-gray-400">
              <EyeOff size={12} />
            </span>
          )}
          {game.play_count > 0 && (
            <span className="badge badge-accent">{game.play_count}次</span>
          )}
        </div>

        {/* Platform */}
        {game.platform && (
          <span className="absolute top-2 right-2 badge bg-black/50 text-white text-[10px]">
            {game.platform}
          </span>
        )}
      </div>

      {/* Info */}
      <div className="p-2">
        <p className="text-sm font-medium truncate leading-tight" title={game.name}>
          {game.name}
        </p>
        {game.total_seconds > 0 && (
          <p className="text-xs text-[var(--color-text-secondary)] mt-1">
            ⏱ {formatTime(game.total_seconds)}
          </p>
        )}
        {game.rating > 0 && (
          <div className="flex items-center gap-1 mt-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <span key={i} className={clsx(
                'text-xs',
                i < Math.round(game.rating / 2) ? 'text-yellow-400' : 'text-gray-600',
              )}>★</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
