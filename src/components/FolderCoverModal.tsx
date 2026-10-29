import { useEffect, useState } from 'react';
import { X, ImagePlus, Loader2, Check, FolderOpen, RotateCcw } from 'lucide-react';
import { message, open } from '@tauri-apps/plugin-dialog';
import type { GameFolder } from '../types';
import * as api from '../api';
import { useModalGamepad } from '../gamepad';
import { useT } from '../i18n';
import { coverSrc } from '../utils/media';

interface Props {
  folder: GameFolder;
  onClose: () => void;
  onApplied: () => void;
}

// 文件夹封面窗口：样式与 CoverPickerModal（游戏封面）同一套。
// 候选网格来自随包分发的 folder-covers/（内置分类封面），选中即交给 set_folder_cover
// 复制成该文件夹自己的封面；「添加自定义封面」走本地选图 —— 两条路最终都是
// folders::set_folder_cover 一个命令（见 get_folder_cover_presets 的注释）。
// 层级 z-110：与游戏封面窗口同级，压得住文件夹浮层（z-85）
export default function FolderCoverModal({ folder, onClose, onApplied }: Props) {
  const t = useT();
  // 哪个操作在跑（三个入口互斥禁用）：'local' / 'reset' 是哨兵，其余值是正在应用的预设路径
  const [applying, setApplying] = useState<string | null>(null);
  const [presets, setPresets] = useState<api.FolderCoverPreset[]>([]);
  const [loading, setLoading] = useState(true);

  // 弹窗期间手柄按键不穿透到背后（B/Esc 关闭，封面挑选用鼠标）
  useModalGamepad('modal:folder-cover', { onClose });

  useEffect(() => {
    let cancelled = false;
    api.fetchFolderCoverPresets()
      .then((list) => { if (!cancelled) setPresets(list); })
      // 拉不到就按「没有内置封面」处理：自定义封面这条主路不受影响，不必摆错误页
      .catch(() => { if (!cancelled) setPresets([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

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
    setApplying('local');
    try {
      await api.setFolderCover(folder.id, selected);
      onApplied();
    } catch (err) {
      // 失败走弹窗而不是换掉整个窗口内容：选错一张图不该让窗口变错误页
      setApplying(null);
      await message(typeof err === 'string' ? err : ((err as any)?.message || t('misc.coverSetFailed')), {
        title: t('games.changeFolderCover'),
        kind: 'error',
      });
    }
  };

  const handlePickPreset = async (preset: api.FolderCoverPreset) => {
    if (applying !== null) return;
    setApplying(preset.path);
    try {
      await api.setFolderCover(folder.id, preset.path);
      onApplied();
    } catch (err) {
      setApplying(null);
      await message(typeof err === 'string' ? err : ((err as any)?.message || t('misc.coverSetFailed')), {
        title: t('games.changeFolderCover'),
        kind: 'error',
      });
    }
  };

  // 恢复默认：清掉自定义封面（卡片回到拼图墙），旧图由后端从 covers 目录删除
  const handleReset = async () => {
    if (applying !== null) return;
    setApplying('reset');
    try {
      await api.clearFolderCover(folder.id);
      onApplied();
    } catch (err) {
      setApplying(null);
      await message(typeof err === 'string' ? err : ((err as any)?.message || t('misc.coverSetFailed')), {
        title: t('games.changeFolderCover'),
        kind: 'error',
      });
    }
  };

  return (
    <div
      data-folder-cover-modal
      className="fixed inset-0 z-[110] flex items-center justify-center p-6"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" />
      {/* Modal */}
      <div
        className="relative w-full glass-modal shadow-2xl animate-scale-in max-h-[85vh] max-w-3xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-border-glass shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.2)] flex items-center justify-center shrink-0">
              <ImagePlus size={18} className="text-[#00d4ff]" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-bold leading-tight">{t('games.changeFolderCover')}</h2>
              <p className="text-xs text-text-secondary mt-0.5 truncate">{folder.name}</p>
            </div>
          </div>
          {/* 标题右侧：恢复默认 + 本地选图入口 + 关闭 */}
          <div className="flex items-center gap-2 shrink-0 ml-3">
            <button
              onClick={handleReset}
              disabled={applying !== null}
              className="btn btn-glass gap-2 text-sm px-4 h-9 disabled:opacity-50"
            >
              {applying === 'reset' ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
              {t('games.folderCoverReset')}
            </button>
            <button
              onClick={handlePickLocal}
              disabled={applying !== null}
              className="btn btn-glass gap-2 text-sm px-4 h-9 disabled:opacity-50"
            >
              {applying === 'local' ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
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

        {/* Body：内置封面候选网格（随包分发，见后端 get_folder_cover_presets）。
            取不到时退回原来的空态文案 —— 自定义封面这条路始终可用 */}
        <div className="flex-1 min-h-0 overflow-y-auto p-6">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-text-secondary">
              <Loader2 size={28} className="animate-spin text-[#00d4ff]" />
              <span className="text-sm">{t('misc.coverLoading')}</span>
            </div>
          ) : presets.length === 0 ? (
            <div className="py-16 text-center">
              <p className="text-sm text-text-secondary mb-1">{t('games.folderCoverNone')}</p>
              <p className="text-xs text-text-tertiary">{t('games.folderCoverHint')}</p>
            </div>
          ) : (
            <>
              <p className="text-xs font-medium text-text-tertiary mb-3">{t('games.folderCoverPresets')}</p>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                {presets.map((preset) => (
                  <button
                    key={preset.path}
                    onClick={() => handlePickPreset(preset)}
                    disabled={applying !== null}
                    className="group relative rounded-xl overflow-hidden border border-border-glass hover:border-[#00d4ff]/50 transition-all"
                    title={preset.name}
                  >
                    <img src={coverSrc(preset.path)} alt={preset.name} className="w-full aspect-[2/3] object-cover" />
                    {/* 悬停选中遮罩 */}
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all flex items-center justify-center">
                      {applying === preset.path ? (
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}