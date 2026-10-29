import { useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderPlus, FolderPen, X } from 'lucide-react';
import { message } from '@tauri-apps/plugin-dialog';
import { useAppStore } from '../store';
import { useModalGamepad } from '../gamepad';
import { useT } from '../i18n';

interface Props {
  mode: 'create' | 'rename';
  /** rename：要改名的文件夹 id；create 时忽略 */
  folderId?: string;
  /** 两种模式都用它当输入框初值：create 时是建议名（右键那个游戏的名字），rename 时是现名 */
  initialName?: string;
  /** create：建好后一起收进去的游戏 */
  initialGameIds?: string[];
  /** create：新文件夹钉在哪一格（右键那张卡原来的格号） */
  initialSlot?: number;
  onClose: () => void;
  onDone?: (folderId: string) => void;
}

// 新建 / 重命名文件夹：一个输入框。重名在前端就拦住（与后端 COLLATE NOCASE 同规则）——
// 网格里两个同名文件夹没法区分，与其建完报错不如从源头不让提交
export default function GameFolderNameModal({
  mode, folderId, initialName = '', initialGameIds = [], initialSlot = -1, onClose, onDone,
}: Props) {
  const t = useT();
  const folders = useAppStore((s) => s.gameFolders);
  const createGameFolder = useAppStore((s) => s.createGameFolder);
  const renameGameFolder = useAppStore((s) => s.renameGameFolder);
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);

  // 弹窗期间手柄按键不穿透到背后网格（B/Esc 关闭，名称用键盘输入）
  useModalGamepad('modal:game-folder-name', { onClose });

  const trimmed = name.trim();
  const duplicate = trimmed.length > 0 && folders.some(
    (f) => f.id !== folderId && f.name.trim().toLowerCase() === trimmed.toLowerCase(),
  );

  const submit = async () => {
    if (!trimmed || busy || duplicate) return;
    setBusy(true);
    try {
      if (mode === 'create') {
        const folder = await createGameFolder(trimmed, initialGameIds, initialSlot);
        onDone?.(folder.id);
      } else if (folderId) {
        await renameGameFolder(folderId, trimmed);
        onDone?.(folderId);
      }
      onClose();
    } catch (err) {
      await message(t('games.folderSaveFailed', { msg: typeof err === 'string' ? err : (err as any)?.message ?? String(err) }), {
        title: t('common.error'),
        kind: 'error',
      });
      setBusy(false);
    }
  };

  const creating = mode === 'create';

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div className="relative w-full max-w-sm glass-modal shadow-2xl animate-scale-in">
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-glass">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.2)] flex items-center justify-center">
              {creating
                ? <FolderPlus size={16} className="text-[#00d4ff]" />
                : <FolderPen size={16} className="text-[#00d4ff]" />}
            </div>
            <h3 className="text-base font-semibold">{creating ? t('games.newFolder') : t('games.renameFolder')}</h3>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center text-text-tertiary hover:bg-bg-surface-active">
            <X size={16} />
          </button>
        </div>
        {/* 表单 */}
        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="text-xs text-text-secondary mb-1.5 block">{t('games.folderName')}</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
              placeholder={t('games.folderNamePlaceholder')}
              className="input w-full"
            />
          </div>
          {duplicate && <p className="text-xs text-danger">{t('games.folderNameDuplicate')}</p>}
          {creating && initialGameIds.length > 0 && (
            <p className="text-xs text-text-tertiary">{t('games.folderCreateNote', { n: initialGameIds.length })}</p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="btn btn-ghost">{t('common.cancel')}</button>
            <button onClick={() => void submit()} disabled={busy || !trimmed || duplicate} className="btn btn-accent">
              {creating ? t('games.folderCreate') : t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
