import { Check, Film, Star, X } from 'lucide-react';
import { clsx } from 'clsx';
import type { TmdbSearchResult } from '../types';
import { useFocusIndex, useModalGamepad } from '../gamepad';
import { useT } from '../i18n';

interface Props {
  title: string;                 // 用于搜索的原标题
  results: TmdbSearchResult[];
  currentId?: number;            // 已关联的 TMDB ID（若有则标出来）
  onPick: (id: number) => void;
  onClose: () => void;
}

// 同名作品消歧：搜索命中多条时让用户挑正确的那一部（只有一条时调用方不会打开本弹窗）
export default function TmdbPickerModal({ title, results, currentId, onPick, onClose }: Props) {
  const t = useT();
  // 手柄完整操作：方向选条目、A 确认、B/Esc 关闭（Esc 只响应自身是栈顶时，
  // 本弹窗可能叠在添加影视弹窗之上，逐层关闭）
  const focused = useFocusIndex('modal:tmdb-picker');
  useModalGamepad('modal:tmdb-picker', {
    onClose,
    count: results.length,
    cols: 1,
    scrollIntoView: (i) => document.querySelector(`[data-tmdb-opt="${i}"]`)?.scrollIntoView({ block: 'nearest' }),
    activate: (i) => onPick(results[i].id),
  });

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-6" onClick={onClose}>
      <div className="absolute inset-0 bg-black/75 backdrop-blur-md animate-fade-in" />

      <div
        className="relative w-full max-w-3xl max-h-[85vh] flex flex-col glass-modal shadow-2xl animate-scale-in overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-6 py-5 border-b border-border-glass shrink-0">
          <div>
            <h2 className="text-lg font-bold">{t('misc.tmdbPickTitle')}</h2>
            <p className="mt-1 text-xs text-text-secondary">
              {t('misc.tmdbPickDesc', { title, n: results.length })}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-xl flex items-center justify-center text-text-secondary hover:text-white hover:bg-bg-surface-active transition-all"
            title={t('common.cancel')}
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-2.5">
          {results.map((r, i) => {
            const isCurrent = currentId !== undefined && currentId > 0 && currentId === r.id;
            return (
              <button
                key={r.id}
                data-tmdb-opt={i}
                onClick={() => onPick(r.id)}
                className={clsx('tmdb-option', isCurrent && 'current', focused === i && 'gamepad-focus')}
              >
                {r.poster_url ? (
                  <img src={r.poster_url} alt="" className="tmdb-option-poster" loading="lazy" />
                ) : (
                  <div className="tmdb-option-poster flex items-center justify-center bg-gradient-to-br from-[#2a1a4e] to-[#0d0d2b] tmdb-option-poster-fallback">
                    <Film size={20} className="text-text-tertiary" />
                  </div>
                )}

                <div className="min-w-0 flex-1 text-left">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-text-primary">{r.name || r.original_name}</span>
                    {r.date && <span className="text-xs text-text-tertiary tabular-nums">{r.date.slice(0, 4)}</span>}
                    {r.vote_average > 0 && (
                      <span className="flex items-center gap-1 text-xs text-yellow-400/90">
                        <Star size={10} fill="currentColor" />
                        {r.vote_average.toFixed(1)}
                      </span>
                    )}
                    {isCurrent && <span className="badge badge-accent">{t('misc.tmdbCurrent')}</span>}
                  </div>
                  {r.original_name && r.original_name !== r.name && (
                    <p className="mt-0.5 text-xs text-text-tertiary truncate">{r.original_name}</p>
                  )}
                  <p className="mt-1.5 text-xs leading-relaxed text-text-secondary line-clamp-2">
                    {r.overview || t('misc.tmdbNoOverview')}
                  </p>
                </div>

                <span className="tmdb-option-pick">
                  <Check size={15} />
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
