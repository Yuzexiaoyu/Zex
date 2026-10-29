import { useEffect, useState } from 'react';
import { X, ImagePlus, Loader2, Check, FolderOpen } from 'lucide-react';
import { clsx } from 'clsx';
import { message, open } from '@tauri-apps/plugin-dialog';
import * as api from '../api';
import { useModalGamepad } from '../gamepad';
import { useT } from '../i18n';

// applying 的哨兵值：标记「正在应用本地选的图」。用假路径而非真实路径，
// 免得某个候选的 url 碰巧等于它而让网格里误转菊花
const LOCAL_PICK = '__local_pick__';

interface Props {
  // 只用到 id 和 name：统计页的 TopEntry 行也能直接传进来换悬停封面
  game: { id: string; name: string };
  kind?: api.CoverKind; // portrait 主封面（竖版）/ wide 悬停封面（横屏）
  onClose: () => void;
  onApplied: () => void;
}

export default function CoverPickerModal({ game, kind = 'portrait', onClose, onApplied }: Props) {
  const t = useT();
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
        if (!cancelled) setError(typeof err === 'string' ? err : ((err as any)?.message || t('misc.coverFetchFailed')));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [game.id, kind]);

  // 本地选图 → 后端校验魔数后复制进 covers 目录（主封面写 cover_path，悬停封面写 banner_path）。
  // SGDB 没有合适候选、或根本没配 API Key 时，这是唯一的换封面途径
  const handlePickLocal = async () => {
    if (applying !== null) return;
    let selected: string;
    try {
      const sel = await open({
        multiple: false,
        directory: false,
        filters: [{ name: t('settings.filterImage'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
      });
      if (typeof sel !== 'string') return; // 取消
      selected = sel;
    } catch {
      return;
    }
    setApplying(LOCAL_PICK);
    try {
      if (kind === 'wide') {
        await api.setGameBanner(game.id, selected);
      } else {
        await api.setGameCover(game.id, selected);
      }
      onApplied();
    } catch (err) {
      // 失败走弹窗而不是 setError：error 态会把整个候选网格换成错误页，
      // 选错一张图不该让已经拉到的 SGDB 候选消失
      setApplying(null);
      await message(typeof err === 'string' ? err : ((err as any)?.message || t('misc.coverSetFailed')), {
        title: t('games.customCover'),
        kind: 'error',
      });
    }
  };

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
      setError(typeof err === 'string' ? err : ((err as any)?.message || t('misc.coverSetFailed')));
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
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.2)] flex items-center justify-center shrink-0">
              <ImagePlus size={18} className="text-[#00d4ff]" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-bold leading-tight">{kind === 'wide' ? t('games.changeBanner') : t('games.changeCover')}</h2>
              <p className="text-xs text-text-secondary mt-0.5 truncate">{game.name}</p>
            </div>
          </div>
          {/* 标题右侧：本地选图兜底入口 + 关闭 */}
          <div className="flex items-center gap-2 shrink-0 ml-3">
            <button
              onClick={handlePickLocal}
              disabled={applying !== null}
              className="btn btn-glass gap-2 text-sm px-4 h-9 disabled:opacity-50"
            >
              {applying === LOCAL_PICK
                ? <Loader2 size={14} className="animate-spin" />
                : <FolderOpen size={14} />}
              {t('games.customCover')}
            </button>
            <button
              onClick={onClose}
              className="w-9 h-9 rounded-xl flex items-center justify-center text-text-secondary hover:text-white hover:bg-bg-surface-active transition-all"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-6">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-text-secondary">
              <Loader2 size={28} className="animate-spin text-[#00d4ff]" />
              <span className="text-sm">{t('misc.coverLoading')}</span>
            </div>
          ) : error ? (
            <div className="py-16 text-center">
              <p className="text-sm text-[#ef4444] mb-3">{error}</p>
              <button onClick={onClose} className="btn btn-glass text-sm px-5">{t('common.close')}</button>
            </div>
          ) : options.length === 0 ? (
            <div className="py-16 text-center">
              <p className="text-sm text-text-secondary mb-1">
                {t(kind === 'wide' ? 'misc.coverNoneWide' : 'misc.coverNonePortrait')}
              </p>
              <p className="text-xs text-text-tertiary">
                {t(kind === 'wide' ? 'misc.coverNoneSgdbWide' : 'misc.coverNoneSgdb')}
              </p>
            </div>
          ) : (
            <div className={kind === 'wide' ? 'grid grid-cols-1 md:grid-cols-2 gap-3' : 'grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3'}>
              {options.map((opt) => (
                <button
                  key={opt.url}
                  onClick={() => handlePick(opt)}
                  disabled={applying !== null}
                  className="group relative rounded-xl overflow-hidden border border-border-glass hover:border-[#00d4ff]/50 transition-all text-left"
                  title={`${opt.width}×${opt.height} · ${opt.author || t('misc.unknownAuthor')}`}
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
