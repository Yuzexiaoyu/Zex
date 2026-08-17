import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { useAppStore } from '../store';
import * as api from '../api';
import { message } from '@tauri-apps/plugin-dialog';
import { Play, Info, Trash2, ImagePlus, RectangleHorizontal, HardDrive, FolderOpen } from 'lucide-react';
import type { Game } from '../types';
import { useFocusIndex, useModalGamepad } from '../gamepad';
import { useT } from '../i18n';

interface Props {
  game: Game;
  x: number;
  y: number;
  onClose: () => void;
  onChangeCover: () => void;   // 主封面（竖版）
  onChangeBanner: () => void;  // 悬停封面（横屏）
  onDiskManage: () => void;    // 磁盘管理（跨盘移动游戏）
}

export default function GameContextMenu({ game, x, y, onClose, onChangeCover, onChangeBanner, onDiskManage }: Props) {
  const t = useT();
  const deleteGame = useAppStore((s) => s.deleteGame);
  const launchGame = useAppStore((s) => s.launchGame);
  const setSelectedGameId = useAppStore((s) => s.setSelectedGameId);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [measured, setMeasured] = useState(false);

  // Clamp to viewport after measuring real size (first frame hidden)
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - el.offsetWidth - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - el.offsetHeight - 8)),
    });
    setMeasured(true);
  }, [x, y]);

  // 手柄完整操作：方向上下选、A 执行、B/Esc 关闭（右键菜单在 10 尺界面同样手柄可达）
  const focused = useFocusIndex('menu:game');
  useModalGamepad('menu:game', {
    onClose,
    count: 7,
    cols: 1,
    activate: (i) => {
      if (i === 0) void handleLaunch();
      else if (i === 1) handleDetail();
      else if (i === 2) handleChangeCover();
      else if (i === 3) handleChangeBanner();
      else if (i === 4) void handleBrowseFiles();
      else if (i === 5) handleDiskManage();
      else void handleDelete();
    },
  });

  const handleLaunch = async () => {
    await launchGame(game.id);
    onClose();
  };

  const handleDetail = () => {
    setSelectedGameId(game.id);
    onClose();
  };

  const handleChangeCover = () => {
    onChangeCover();
    onClose();
  };

  const handleChangeBanner = () => {
    onChangeBanner();
    onClose();
  };

  // 浏览本地文件：打开游戏安装目录（资源管理器）
  const handleBrowseFiles = () => {
    onClose();
    const target = game.install_dir || game.exe_path;
    void api.openPath(target).catch((e: any) => {
      void message(t('games.openFailed', { msg: typeof e === 'string' ? e : (e?.message ?? String(e)) }), {
        title: t('games.browseFiles'),
        kind: 'error',
      });
    });
  };

  // 磁盘管理：跨盘移动游戏（打开磁盘管理弹窗）
  const handleDiskManage = () => {
    onClose();
    onDiskManage();
  };

  const handleDelete = async () => {
    if (!confirm(t('games.deleteConfirm', { name: game.name }))) return;
    await deleteGame(game.id);
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
        <button onClick={handleLaunch} className={clsx('context-menu-item', focused === 0 && 'gamepad-focus')}>
          <Play size={14} className="text-[#00d4ff]" fill="currentColor" />
          {t('games.launch')}
        </button>
        <button onClick={handleDetail} className={clsx('context-menu-item', focused === 1 && 'gamepad-focus')}>
          <Info size={14} className="text-text-secondary" />
          {t('games.viewDetail')}
        </button>
        <button onClick={handleChangeCover} className={clsx('context-menu-item', focused === 2 && 'gamepad-focus')}>
          <ImagePlus size={14} className="text-text-secondary" />
          {t('games.changeCover')}
        </button>
        <button onClick={handleChangeBanner} className={clsx('context-menu-item', focused === 3 && 'gamepad-focus')}>
          <RectangleHorizontal size={14} className="text-text-secondary" />
          {t('games.changeBanner')}
        </button>
        <button onClick={handleBrowseFiles} className={clsx('context-menu-item', focused === 4 && 'gamepad-focus')}>
          <FolderOpen size={14} className="text-text-secondary" />
          {t('games.browseFiles')}
        </button>
        <button onClick={handleDiskManage} className={clsx('context-menu-item', focused === 5 && 'gamepad-focus')}>
          <HardDrive size={14} className="text-text-secondary" />
          {t('games.diskManage')}
        </button>
        <div className="context-menu-divider" />
        <button onClick={handleDelete} className={clsx('context-menu-item text-danger', focused === 6 && 'gamepad-focus')}>
          <Trash2 size={14} />
          {t('games.deleteGame')}
        </button>
      </div>
    </div>,
    document.body,
  );
}
