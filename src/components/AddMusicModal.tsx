import { useState } from 'react';
import { X, Folder, FileAudio, Loader2, CheckSquare, Square, Music } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { scanMusicPaths, importMusicTracks } from '../api';
import type { TrackPreview } from '../types';
import { useModalGamepad } from '../gamepad';
import { clsx } from 'clsx';
import { useT } from '../i18n';

interface AddMusicModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

type AddMode = 'folder' | 'files';

// 与后端 MUSIC_EXTS 保持一致
const MUSIC_EXTS = ['mp3', 'flac', 'wav', 'ogg', 'opus', 'm4a', 'aac', 'ape', 'aiff', 'mpc', 'wv'];

function fmtTime(s: number): string {
  if (!s || s <= 0) return '-:--';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export default function AddMusicModal({ onClose, onSuccess }: AddMusicModalProps) {
  const t = useT();
  const [mode, setMode] = useState<AddMode>('folder');
  const [previews, setPreviews] = useState<TrackPreview[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [isScanning, setIsScanning] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [folderName, setFolderName] = useState('');

  // 弹窗期间手柄按键不穿透到背后（B/Esc 关闭，扫描与勾选用鼠标）
  useModalGamepad('modal:add-music', { onClose });

  // 扫描结果落地：默认勾选所有「未在库中」的曲目（已存在的默认跳过）
  const applyPreviews = (result: TrackPreview[]) => {
    setPreviews(result);
    setChecked(new Set(result.filter((p) => !p.already_exists).map((p) => p.file_path)));
  };

  const handleSelectFolder = async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected && typeof selected === 'string') {
        setFolderName(selected.split(/[/\\]/).pop() || '');
        setIsScanning(true);
        try {
          applyPreviews(await scanMusicPaths([selected]));
        } catch (err) {
          console.error('扫描音乐文件夹失败:', err);
          alert(t('music.scanFailedFolder'));
        } finally {
          setIsScanning(false);
        }
      }
    } catch (err) {
      console.error('选择文件夹失败:', err);
    }
  };

  const handleSelectFiles = async () => {
    try {
      const selected = await open({
        multiple: true,
        filters: [{ name: t('music.audioFilter'), extensions: MUSIC_EXTS }],
      });
      if (selected && Array.isArray(selected) && selected.length > 0) {
        setIsScanning(true);
        try {
          applyPreviews(await scanMusicPaths(selected));
        } catch (err) {
          console.error('解析音乐文件失败:', err);
          alert(t('music.scanFailedFiles'));
        } finally {
          setIsScanning(false);
        }
      }
    } catch (err) {
      console.error('选择文件失败:', err);
    }
  };

  const toggle = (path: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const toggleAll = () => {
    setChecked((prev) => (prev.size === previews.length ? new Set() : new Set(previews.map((p) => p.file_path))));
  };

  const handleSubmit = async () => {
    const selected = previews.filter((p) => checked.has(p.file_path));
    if (selected.length === 0) return;
    setIsSubmitting(true);
    try {
      await importMusicTracks(selected);
      onSuccess();
      onClose();
    } catch (err) {
      console.error('导入音乐失败:', err);
      alert(t('music.importFailedRetry'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const newCount = previews.filter((p) => !p.already_exists).length;
  const selectedCount = checked.size;

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" />
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto glass-modal shadow-2xl animate-scale-in">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-border-glass sticky top-0 glass-modal" style={{ background: 'inherit' }}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.2)] flex items-center justify-center">
              <Music size={18} className="text-[#00d4ff]" />
            </div>
            <h2 className="text-lg font-bold">{t('music.addMusic')}</h2>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-xl flex items-center justify-center text-text-secondary hover:text-white hover:bg-bg-surface-active transition-all"
            title={t('common.close')}
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {/* 模式选择 */}
          <div className="flex gap-3">
            {([
              { key: 'folder' as const, icon: Folder, label: 'music.scanFolder' },
              { key: 'files' as const, icon: FileAudio, label: 'music.selectFiles' },
            ]).map(({ key, icon: Icon, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => setMode(key)}
                className={clsx('flex-1 py-3 px-3 rounded-xl border transition-all flex items-center justify-center gap-2 text-sm font-medium', mode === key
                  ? 'bg-[rgba(0,212,255,0.12)] border-[#00d4ff]/40 text-[#00d4ff]'
                  : 'bg-bg-surface border-border-glass text-text-secondary hover:border-border-glass-hover hover:text-text-primary')}
              >
                <Icon size={16} />
                {t(label)}
              </button>
            ))}
          </div>

          {/* 选择入口 */}
          <div>
            <label className="block text-xs text-text-secondary mb-1.5">
              {mode === 'folder' ? t('music.folderHint') : t('music.filesHint')}
            </label>
            <button
              type="button"
              onClick={mode === 'folder' ? handleSelectFolder : handleSelectFiles}
              disabled={isScanning}
              className="flex-shrink-0 px-4 py-3 rounded-xl bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.2)] hover:bg-[rgba(0,212,255,0.2)] flex items-center justify-center gap-2 text-sm text-[#00d4ff] transition-all disabled:opacity-50"
            >
              {isScanning ? (<><Loader2 size={16} className="animate-spin" /> {t('music.scanning')}</>) : (<><Folder size={16} /> {mode === 'folder' ? t('music.pickFolder') : t('music.selectFiles')}</>)}
            </button>
            {folderName && mode === 'folder' && (
              <p className="mt-2 text-xs text-[#00d4ff]">
                {t('music.scannedFolder', { folder: folderName })}
              </p>
            )}
          </div>

          {/* 预览列表 */}
          {previews.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs text-text-secondary">
                  {t('music.parsePrefix')} <b className="text-text-primary">{previews.length}</b> {t('music.parseMid')} <b className="text-[#00d4ff]">{newCount}</b> {t('music.parseNew')}
                </p>
                <button
                  type="button"
                  onClick={toggleAll}
                  className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-[#00d4ff] transition-colors"
                >
                  {checked.size === previews.length ? <CheckSquare size={14} /> : <Square size={14} />}
                  {checked.size === previews.length ? t('music.deselectAll') : t('music.selectAll')}
                </button>
              </div>
              <div className="max-h-72 overflow-y-auto rounded-xl border border-border-glass divide-y divide-border-glass bg-bg-surface">
                {previews.map((p) => {
                  const on = checked.has(p.file_path);
                  return (
                    <div
                      key={p.file_path}
                      className={clsx('flex items-center gap-3 px-3 py-2 transition-colors', on ? 'bg-[rgba(0,212,255,0.04)]' : 'opacity-55')}
                      onClick={() => toggle(p.file_path)}
                      title={p.file_path}
                    >
                      <button type="button" onClick={(e) => { e.stopPropagation(); toggle(p.file_path); }}>
                        {on ? <CheckSquare size={16} className="text-[#00d4ff]" /> : <Square size={16} className="text-text-tertiary" />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-sm font-medium text-text-primary">{p.title}</p>
                        <p className="truncate text-xs text-text-secondary">{(p.artist || t('music.unknownArtist'))}{p.album ? ` · ${p.album}` : ''}</p>
                      </div>
                      {p.already_exists && <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-full bg-bg-surface-active text-text-tertiary">{t('music.alreadyInLibrary')}</span>}
                      <span className="shrink-0 text-xs text-text-tertiary tabular-nums">{fmtTime(p.duration_seconds)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 按钮 */}
          <div className="flex gap-4 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="flex-1 btn btn-ghost py-3 px-6 text-sm"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={isSubmitting || selectedCount === 0 || previews.length === 0}
              className="flex-1 btn btn-accent py-3 px-6 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? t('music.importing') : t('music.importCount', { n: selectedCount })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
