import { useEffect, useState } from 'react';
import { X, ImagePlus, Loader2, Check } from 'lucide-react';
import { clsx } from 'clsx';
import type { Game } from '../types';
import * as api from '../api';
import { useModalGamepad } from '../gamepad';

interface Props {
  game: Game;
  kind?: api.CoverKind; // portrait 主封面（竖版）/ wide 悬停封面（横屏）
  onClose: () => void;
  onApplied: () => void;
}

export default function CoverPickerModal({ game, kind = 'portrait', onClose, onApplied }: Props) {
  const [options, setOptions] = useState<api.CoverOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [applying, setApplying] = useState<string | null>(null);

  // 弹窗期间手柄按键不穿透到背后（B/Esc 关闭，封面挑选用鼠标）
  useModalGamepad('modal:cover-picker', { onClose });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api.fetchCoverOptions(game.id, kind)
      .then((opts) => { if (!cancelled) setOptions(opts); })
      .catch((err) => {
        if (!cancelled) setError(typeof err === 'string' ? err : ((err as any)?.message || '获取封面失败'));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [game.id, kind]);

  const handlePick = async (opt: api.CoverOption) => {
    setApplying(opt.url);
    try {
      if (kind === 'wide') {
        await api.setGameBannerUrl(game.id, opt.url);
      } else {
        await api.setGameCoverUrl(game.id, opt.url);
      }
      onApplied();
    } catch (err) {
      setError(typeof err === 'string' ? err : ((err as any)?.message || '设置封面失败'));
      setApplying(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-6" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" />
      {/* Modal */}
      <div
        className={clsx(
          'relative w-full glass-modal shadow-2xl animate-scale-in max-h-[85vh] flex flex-col',
          kind === 'wide' ? 'max-w-6xl' : 'max-w-3xl',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-border-glass shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.2)] flex items-center justify-center">
              <ImagePlus size={18} className="text-[#00d4ff]" />
            </div>
            <div>
              <h2 className="text-lg font-bold leading-tight">{kind === 'wide' ? '更换悬停封面' : '更换主封面'}</h2>
              <p className="text-xs text-text-secondary mt-0.5">{game.name}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-xl flex items-center justify-center text-text-secondary hover:text-white hover:bg-bg-surface-active transition-all"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-6">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-text-secondary">
              <Loader2 size={28} className="animate-spin text-[#00d4ff]" />
              <span className="text-sm">正在获取封面...</span>
            </div>
          ) : error ? (
            <div className="py-16 text-center">
              <p className="text-sm text-[#ef4444] mb-3">{error}</p>
              <button onClick={onClose} className="btn btn-glass text-sm px-5">关闭</button>
            </div>
          ) : options.length === 0 ? (
            <div className="py-16 text-center">
              <p className="text-sm text-text-secondary mb-1">没有找到可用的竖版封面</p>
              <p className="text-xs text-text-tertiary">该游戏在 SteamGridDB 上没有 600×900 封面</p>
            </div>
          ) : (
            <div className={kind === 'wide' ? 'grid grid-cols-1 md:grid-cols-2 gap-3' : 'grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3'}>
              {options.map((opt) => (
                <button
                  key={opt.url}
                  onClick={() => handlePick(opt)}
                  disabled={applying !== null}
                  className="group relative rounded-xl overflow-hidden border border-border-glass hover:border-[#00d4ff]/50 transition-all text-left"
                  title={`${opt.width}×${opt.height} · ${opt.author || '未知作者'}`}
                >
                  <img
                    src={opt.thumb}
                    alt=""
                    className={kind === 'wide' ? 'w-full aspect-[1920/620] object-cover' : 'w-full aspect-[2/3] object-cover'}
                    loading="lazy"
                  />
                  {/* 悬停选中遮罩 */}
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all flex items-center justify-center">
                    {applying === opt.url ? (
                      <Loader2 size={22} className="text-white animate-spin" />
                    ) : (
                      <span className="opacity-0 group-hover:opacity-100 transition-opacity w-9 h-9 rounded-full bg-[#00d4ff] flex items-center justify-center">
                        <Check size={16} className="text-black" />
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
