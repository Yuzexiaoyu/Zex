import { useState, useEffect } from 'react';
import { useAppStore } from '../store';
import { Film, Search, ChevronRight, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';

function formatDuration(seconds: number): string {
  if (!seconds) return '-';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function SeriesView() {
  const { series, loadSeries } = useAppStore();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => { loadSeries(); }, []);

  const filtered = series.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex h-full">
      {/* List */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-4 px-4 py-3 border-b border-[var(--color-border)]">
          <div className="relative flex-1 max-w-md">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索影视..."
              className="w-full pl-9 pr-4 py-2 rounded-lg text-sm bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-secondary)] focus:outline-none focus:border-[var(--color-accent)]"
            />
          </div>
          <button onClick={() => loadSeries()} className="p-2 rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]">
            <RefreshCw size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-secondary)] gap-4">
              <Film size={64} className="opacity-20" />
              <p className="text-lg">还没有影视内容</p>
              <p className="text-sm">点击上方按钮添加剧集</p>
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((s) => (
                <div
                  key={s.id}
                  onClick={() => setSelected(selected === s.id ? null : s.id)}
                  className={clsx(
                    'flex items-center gap-4 p-4 rounded-xl cursor-pointer transition-all',
                    'bg-[var(--color-surface-2)] border-2',
                    selected === s.id ? 'border-[var(--color-accent)]' : 'border-transparent hover:border-[var(--color-border)]',
                  )}
                >
                  {/* Cover */}
                  <div className="w-20 h-28 rounded-lg overflow-hidden shrink-0 bg-[var(--color-surface-3)]">
                    {s.cover_path ? (
                      <img src={`file://${s.cover_path}`} alt={s.name} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-2xl opacity-30">📺</div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold truncate">{s.name}</h3>
                      {s.favorite && <span className="text-yellow-400 text-sm">★</span>}
                    </div>
                    {s.year && <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">{s.year}年</p>}
                    {s.overview && <p className="text-xs text-[var(--color-text-secondary)] mt-1 line-clamp-2">{s.overview}</p>}
                  </div>

                  <div className="shrink-0 text-right">
                    {s.total_seconds > 0 && (
                      <p className="text-xs text-[var(--color-text-secondary)]">⏱ {formatDuration(s.total_seconds)}</p>
                    )}
                    <ChevronRight size={16} className={clsx(
                      'ml-auto mt-1 text-[var(--color-text-secondary)] transition-transform',
                      selected === s.id && 'rotate-90',
                    )} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
