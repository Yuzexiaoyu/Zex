import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppStore } from '../store';
import GameGrid from '../components/GameGrid';
import GameDetail from './GameDetail';
import AddGameModal from '../components/AddGameModal';
import SteamScanModal from '../components/SteamScanModal';
import {
  Search, Plus, RefreshCw, Filter, SortAsc, SortDesc,
  LayoutGrid, Columns3, X, Gamepad2
} from 'lucide-react';
import { clsx } from 'clsx';

export default function GameView() {
  const {
    games, filter, setFilter, loadGames,
    selectedGameId, setSelectedGameId,
    launchGame, uiMode,
  } = useAppStore();

  const [showAddModal, setShowAddModal] = useState(false);
  const [showSteamModal, setShowSteamModal] = useState(false);
  const [searchInput, setSearchInput] = useState(filter.search || '');
  const [columns, setColumns] = useState(5);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    loadGames();
  }, []);

  // Debounced search
  useEffect(() => {
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setFilter({ search: searchInput || undefined });
    }, 300);
    return () => clearTimeout(searchTimer.current);
  }, [searchInput]);

  const handleLaunch = useCallback(async (id: string) => {
    await launchGame(id);
  }, [launchGame]);

  const sortBy = filter.sort_by || 'name';
  const sortOrder = filter.sort_order || 'asc';
  const toggleSort = (field: typeof sortBy) => {
    if (sortBy === field) {
      setFilter({ sort_order: sortOrder === 'asc' ? 'desc' : 'asc' });
    } else {
      setFilter({ sort_by: field, sort_order: 'asc' });
    }
  };

  const isTenFoot = uiMode === 'ten-foot';

  return (
    <div className="flex h-full">
      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        <div className={clsx(
          'flex items-center gap-3 px-4 py-3 shrink-0',
          'bg-[var(--color-surface-1)] border-b border-[var(--color-border)]',
          isTenFoot && 'py-4 px-6',
        )}>
          {/* Search */}
          <div className="relative flex-1 max-w-md">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)]" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="搜索游戏..."
              className={clsx(
                'w-full pl-9 pr-4 py-2 rounded-lg text-sm',
                'bg-[var(--color-surface-2)] border border-[var(--color-border)]',
                'text-[var(--color-text-primary)] placeholder:text-[var(--color-text-secondary)]',
                'focus:outline-none focus:border-[var(--color-accent)]',
                isTenFoot && 'text-xl py-3 pl-11',
              )}
            />
            {searchInput && (
              <button
                onClick={() => setSearchInput('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Sort buttons */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-[var(--color-text-secondary)] hidden sm:block">排序:</span>
            {(['name', 'created_at', 'play_count'] as const).map((field) => (
              <button
                key={field}
                onClick={() => toggleSort(field)}
                className={clsx(
                  'flex items-center gap-1 px-2 py-1.5 rounded text-xs',
                  sortBy === field
                    ? 'bg-[var(--color-accent)] text-white'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]',
                )}
              >
                {field === 'name' ? '名称' : field === 'created_at' ? '添加时间' : '游玩次数'}
                {sortBy === field && (sortOrder === 'asc' ? <SortAsc size={12} /> : <SortDesc size={12} />)}
              </button>
            ))}
          </div>

          {/* Columns */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setColumns((c) => Math.max(2, c - 1))}
              className="p-1.5 rounded text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"
            >
              <LayoutGrid size={16} />
            </button>
            <span className="text-xs text-[var(--color-text-secondary)] w-4 text-center">{columns}</span>
            <button
              onClick={() => setColumns((c) => Math.min(8, c + 1))}
              className="p-1.5 rounded text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"
            >
              <Columns3 size={16} />
            </button>
          </div>

          {/* Refresh */}
          <button
            onClick={() => loadGames()}
            className="p-2 rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text-primary)] transition-colors"
            title="刷新"
          >
            <RefreshCw size={isTenFoot ? 22 : 18} />
          </button>

          {/* Filter */}
          <button
            onClick={() => setFilter({ favorite: !filter.favorite })}
            className={clsx(
              'p-2 rounded-lg transition-colors',
              filter.favorite
                ? 'text-yellow-400 bg-yellow-400/10'
                : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]',
            )}
            title="只看收藏"
          >
            <Filter size={isTenFoot ? 22 : 18} />
          </button>

          {/* Add */}
          <div className="flex gap-2 ml-auto">
            <button
              onClick={() => setShowSteamModal(true)}
              className={clsx(
                'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                'border border-[var(--color-border)] text-[var(--color-text-secondary)]',
                'hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]',
                isTenFoot && 'px-4 py-3 text-lg',
              )}
            >
              <Gamepad2 size={isTenFoot ? 22 : 16} />
              扫描 Steam
            </button>
            <button
              onClick={() => setShowAddModal(true)}
              className={clsx(
                'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                'bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)]',
                isTenFoot && 'px-4 py-3 text-lg',
              )}
            >
              <Plus size={isTenFoot ? 22 : 16} />
              添加游戏
            </button>
          </div>
        </div>

        {/* Grid */}
        <div className="flex-1 min-h-0">
          <GameGrid
            games={games}
            selectedId={selectedGameId}
            onSelect={setSelectedGameId}
            onLaunch={handleLaunch}
            columns={columns}
          />
        </div>
      </div>

      {/* Detail panel */}
      {selectedGameId && (
        <GameDetail
          gameId={selectedGameId}
          onClose={() => setSelectedGameId(null)}
        />
      )}

      {/* Modals */}
      {showAddModal && <AddGameModal onClose={() => setShowAddModal(false)} />}
      {showSteamModal && <SteamScanModal onClose={() => setShowSteamModal(false)} />}
    </div>
  );
}
