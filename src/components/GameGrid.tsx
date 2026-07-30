import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import GameCard from './GameCard';
import type { Game } from '../types';

interface Props {
  games: Game[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onLaunch: (id: string) => void;
  columns?: number;
}

export default function GameGrid({ games, selectedId, onSelect, onLaunch, columns = 5 }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const colCount = Math.max(1, columns);

  const rows = Math.ceil(games.length / colCount);
  const rowHeight = 360;

  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 2,
  });

  if (games.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-secondary)] gap-4">
        <span className="text-6xl opacity-30">🎮</span>
        <p className="text-lg">还没有游戏</p>
        <p className="text-sm">点击上方按钮添加游戏或扫描 Steam 库</p>
      </div>
    );
  }

  return (
    <div ref={parentRef} className="h-full overflow-auto p-4">
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
        {virtualizer.getVirtualItems().map((row) => {
          const start = row.index * colCount;
          const rowGames = games.slice(start, start + colCount);
          return (
            <div
              key={row.key}
              className="absolute w-full grid gap-4 px-1"
              style={{
                top: `${row.start}px`,
                gridTemplateColumns: `repeat(${colCount}, minmax(0, 1fr))`,
              }}
            >
              {rowGames.map((game) => (
                <GameCard
                  key={game.id}
                  game={game}
                  selected={game.id === selectedId}
                  onClick={() => onSelect(game.id)}
                  onLaunch={(e) => { e.stopPropagation(); onLaunch(game.id); }}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
