import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ListPlus, X } from 'lucide-react';
import { message } from '@tauri-apps/plugin-dialog';
import { useAppStore } from '../store';
import { useModalGamepad } from '../gamepad';
import { useT } from '../i18n';
import type { Playlist } from '../types';

interface Props {
  initialTrackIds: string[];  // 创建后要一起加入的曲目（右键「新建歌单」场景）
  onClose: () => void;
  onCreated?: (pl: Playlist) => void;
}

// 新建歌单：输入名称 → 创建 → 可选把当前曲目一起加进去
export default function CreatePlaylistModal({ initialTrackIds, onClose, onCreated }: Props) {
  const t = useT();
  const createPlaylist = useAppStore((s) => s.createPlaylist);
  const playlists = useAppStore((s) => s.playlists);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  // 弹窗期间手柄按键不穿透到背后（B/Esc 关闭，名称输入用键盘）
  useModalGamepad('modal:create-playlist', { onClose });

  // 重名（忽略大小写与首尾空格，与后端 COLLATE NOCASE 一致）：直接不让提交。
  // 侧栏里两个同名歌单没法区分，与其建完再报错不如从源头拦住
  const trimmed = name.trim();
  const duplicate = trimmed.length > 0
    && playlists.some((p) => p.name.trim().toLowerCase() === trimmed.toLowerCase());

  const submit = async () => {
    const n = name.trim();
    if (!n || busy || duplicate) return;
    setBusy(true);
    try {
      const pl = await createPlaylist(n, initialTrackIds);
      // 创建后自动筛选到新歌单（onCreated），不弹提示
      onCreated?.(pl);
    } catch (err) {
      void message(t('music.createPlaylistFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div className="relative w-full max-w-sm glass-modal shadow-2xl animate-scale-in">
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-glass">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.2)] flex items-center justify-center">
              <ListPlus size={16} className="text-[#00d4ff]" />
            </div>
            <h3 className="text-base font-semibold">{t('music.newPlaylist')}</h3>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center text-text-tertiary hover:bg-bg-surface-active">
            <X size={16} />
          </button>
        </div>
        {/* 表单 */}
        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="text-xs text-text-secondary mb-1.5 block">{t('music.playlistName')}</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
              placeholder={t('music.playlistNamePlaceholder')}
              className="input w-full"
            />
          </div>
          {initialTrackIds.length > 0 && (
            <p className="text-xs text-text-tertiary">{t('music.createPlaylistNote', { n: initialTrackIds.length })}</p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="btn btn-ghost">{t('common.cancel')}</button>
            <button onClick={() => void submit()} disabled={busy || !trimmed || duplicate} className="btn btn-accent">
              {busy ? t('music.creatingPlaylist') : t('music.createPlaylist')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
