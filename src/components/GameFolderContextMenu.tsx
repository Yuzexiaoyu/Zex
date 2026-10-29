import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { message } from '@tauri-apps/plugin-dialog';
import { useAppStore } from '../store';
import { FolderOpen, FolderPen, FolderX } from 'lucide-react';
import type { GameFolder } from '../types';
import { useFocusIndex, useModalGamepad } from '../gamepad';
import { useT } from '../i18n';

interface Props {
  folder: GameFolder;
  x: number;
  y: number;
  onClose: () => void;
  onOpen: () => void;      // 打开文件夹内容弹窗
  onRename: () => void;    // 打开重命名弹窗
}

// 文件夹卡右键菜单：打开 / 重命名 / 解散。与 GameContextMenu 同款（视口夹取 + 完整手柄操作）
export default function GameFolderContextMenu({ folder, x, y, onClose, onOpen, onRename }: Props) {
  const t = useT();
  const dissolveGameFolder = useAppStore((s) => s.dissolveGameFolder);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [measured, setMeasured] = useState(false);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - el.offsetWidth - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - el.offsetHeight - 8)),
    });
    setMeasured(true);
  }, [x, y]);

  const order = ['open', 'rename', 'dissolve'];
  const idx = (key: string) => order.indexOf(key);
  const focused = useFocusIndex('menu:game-folder');
  useModalGamepad('menu:game-folder', {
    onClose,
    count: order.length,
    cols: 1,
    activate: (i) => {
      const k = order[i];
      if (k === 'open') handleOpen();
      else if (k === 'rename') handleRename();
      else void handleDissolve();
    },
  });

  const handleOpen = () => { onClose(); onOpen(); };
  const handleRename = () => { onClose(); onRename(); };

  // 解散 ≠ 删游戏：确认文案要把这点说清楚（里面的游戏回到库里，一个都不会被删）
  const handleDissolve = async () => {
    if (!confirm(t('games.dissolveFolderConfirm', { name: folder.name, n: folder.game_ids.length }))) return;
    try {
      await dissolveGameFolder(folder.id);
    } catch (err) {
      void message(t('games.folderSaveFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
    }
    onClose();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[100]"
      style={{ left: pos.left, top: pos.top, visibility: measured ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="glass-card w-44 py-1.5 animate-scale-in">
        <button onClick={handleOpen} className={clsx('context-menu-item', focused === idx('open') && 'gamepad-focus')}>
          <FolderOpen size={14} className="text-[#00d4ff]" />
          {t('games.folderOpen')}
        </button>
        <button onClick={handleRename} className={clsx('context-menu-item', focused === idx('rename') && 'gamepad-focus')}>
          <FolderPen size={14} className="text-text-secondary" />
          {t('games.renameFolder')}
        </button>
        <div className="context-menu-divider" />
        <button onClick={() => void handleDissolve()} className={clsx('context-menu-item text-danger', focused === idx('dissolve') && 'gamepad-focus')}>
          <FolderX size={14} />
          {t('games.dissolveFolder')}
        </button>
      </div>
    </div>,
    document.body,
  );
}
