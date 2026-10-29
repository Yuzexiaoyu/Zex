import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { useAppStore } from '../store';
import * as api from '../api';
import { message } from '@tauri-apps/plugin-dialog';
import { Play, Info, Trash2, ImagePlus, RectangleHorizontal, HardDrive, FolderOpen, Gauge, ArchiveRestore, FolderPlus, FolderMinus } from 'lucide-react';
import type { Game } from '../types';
import { useFocusIndex, useModalGamepad } from '../gamepad';
import { useT } from '../i18n';
import MoveToFolderFlyout from './MoveToFolderFlyout';

interface Props {
  game: Game;
  x: number;
  y: number;
  onClose: () => void;
  onChangeCover: () => void;   // 主封面（竖版）
  onChangeBanner: () => void;  // 悬停封面（横屏）
  onDiskManage: () => void;    // 磁盘管理（跨盘移动游戏）
  onFpsSettings: () => void;   // 打开帧数面板并选中这个游戏
  onRestore: () => void;       // 解压恢复（已归档游戏）
  onNewFolder: () => void;     // 新建文件夹并把本游戏收进去
}

export default function GameContextMenu({ game, x, y, onClose, onChangeCover, onChangeBanner, onDiskManage, onFpsSettings, onRestore, onNewFolder }: Props) {
  const t = useT();
  const deleteGame = useAppStore((s) => s.deleteGame);
  const launchGame = useAppStore((s) => s.launchGame);
  const setSelectedGameId = useAppStore((s) => s.setSelectedGameId);
  const folders = useAppStore((s) => s.gameFolders);
  const setGamesFolder = useAppStore((s) => s.setGamesFolder);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [measured, setMeasured] = useState(false);
  // 手柄在「加入文件夹」上按 A → 强制展开二级菜单（鼠标走 hover）
  const [flyoutOpen, setFlyoutOpen] = useState(false);

  // 本游戏当前所在文件夹（null = 在顶层）：决定是否出现「移出文件夹」，
  // 以及二级菜单里要跳过哪一个
  const currentFolderId = folders.find((f) => f.game_ids.includes(game.id))?.id ?? null;

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
  const archived = !!game.archive_status;
  // 焦点顺序随「是否已归档 / 有没有文件夹 / 本游戏在不在文件夹里」动态变化。
  // 已归档在启动项后插入「解压恢复」；文件夹相关三项按实际渲染情况出现
  const order = [
    ...(archived ? ['restore'] : ['launch']),
    'detail', 'newFolder',
    ...(folders.length > 0 ? ['addFolder'] : []),
    ...(currentFolderId ? ['removeFolder'] : []),
    'cover', 'banner', 'browse', 'fps', 'disk', 'delete',
  ];
  const idx = (key: string) => order.indexOf(key);
  const focused = useFocusIndex('menu:game');
  useModalGamepad('menu:game', {
    onClose,
    count: order.length,
    cols: 1,
    activate: (i) => {
      const k = order[i];
      if (k === 'launch') void handleLaunch();
      else if (k === 'restore') handleRestore();
      else if (k === 'detail') handleDetail();
      else if (k === 'newFolder') handleNewFolder();
      else if (k === 'addFolder') setFlyoutOpen(true); // 展开二级菜单，焦点交给它
      else if (k === 'removeFolder') void handleRemoveFromFolder();
      else if (k === 'cover') handleChangeCover();
      else if (k === 'banner') handleChangeBanner();
      else if (k === 'browse') void handleBrowseFiles();
      else if (k === 'fps') handleFpsSettings();
      else if (k === 'disk') handleDiskManage();
      else void handleDelete();
    },
  });

  const handleLaunch = async () => {
    if (game.archive_status) return;
    try {
      await launchGame(game.id);
      onClose();
    } catch (err) {
      await message(t('games.launchFailed', { msg: String(err) }), { kind: 'error' });
    }
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

  // 浏览本地文件：普通游戏打开安装目录；归档游戏没有可用安装目录（已删/未解压），改为打开压缩包所在文件夹
  const handleBrowseFiles = () => {
    onClose();
    let target = game.install_dir || game.exe_path;
    if (game.archive_status) {
      const p = (game.archive_path || '').replace(/[\\/]+$/, '');
      const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
      target = i > 0 ? p.slice(0, i) : p;
      if (/^[A-Za-z]:$/.test(target)) target += '\\'; // 盘根要补反斜杠，explorer 才认
    }
    if (!target) return;
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

  // 帧数设置：入口唯一 —— 全局和单游戏都在那个面板里改（这里只负责选中本游戏）
  const handleFpsSettings = () => {
    onClose();
    onFpsSettings();
  };

  const handleRestore = () => {
    onClose();
    onRestore();
  };

  // 新建文件夹：命名弹窗由 GameGrid 持有（菜单马上要关掉，弹窗不能挂在它身上）
  const handleNewFolder = () => {
    onClose();
    onNewFolder();
  };

  const handleRemoveFromFolder = async () => {
    onClose();
    try {
      await setGamesFolder([game.id], null);
    } catch (err) {
      await message(t('games.folderMoveFailed', { msg: String(err) }), { title: t('common.error'), kind: 'error' });
    }
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
        {!archived && (
          <button onClick={handleLaunch} className={clsx('context-menu-item', focused === idx('launch') && 'gamepad-focus')}>
            <Play size={14} className="text-[#00d4ff]" fill="currentColor" />
            {t('games.launch')}
          </button>
        )}
        {archived && (
          <button onClick={handleRestore} className={clsx('context-menu-item', focused === idx('restore') && 'gamepad-focus')}>
            <ArchiveRestore size={14} className="text-[#00d4ff]" />
            {t('games.restore')}
          </button>
        )}
        <button onClick={handleDetail} className={clsx('context-menu-item', focused === idx('detail') && 'gamepad-focus')}>
          <Info size={14} className="text-text-secondary" />
          {t('games.viewDetail')}
        </button>
        <div className="context-menu-divider" />
        {/* ── 文件夹：新建（把本游戏收进去）/ 加入已有 / 移出 ── */}
        <button onClick={handleNewFolder} className={clsx('context-menu-item', focused === idx('newFolder') && 'gamepad-focus')}>
          <FolderPlus size={14} className="text-text-secondary" />
          {t('games.newFolder')}
        </button>
        {folders.length > 0 && (
          <MoveToFolderFlyout
            gameIds={[game.id]}
            currentFolderId={currentFolderId}
            onClose={onClose}
            forcedOpen={flyoutOpen}
            onForcedClose={() => setFlyoutOpen(false)}
            focused={focused === idx('addFolder')}
          />
        )}
        {currentFolderId && (
          <button onClick={() => void handleRemoveFromFolder()} className={clsx('context-menu-item', focused === idx('removeFolder') && 'gamepad-focus')}>
            <FolderMinus size={14} className="text-text-secondary" />
            {t('games.removeFromFolder')}
          </button>
        )}
        <div className="context-menu-divider" />
        <button onClick={handleChangeCover} className={clsx('context-menu-item', focused === idx('cover') && 'gamepad-focus')}>
          <ImagePlus size={14} className="text-text-secondary" />
          {t('games.changeCover')}
        </button>
        <button onClick={handleChangeBanner} className={clsx('context-menu-item', focused === idx('banner') && 'gamepad-focus')}>
          <RectangleHorizontal size={14} className="text-text-secondary" />
          {t('games.changeBanner')}
        </button>
        <button onClick={handleBrowseFiles} className={clsx('context-menu-item', focused === idx('browse') && 'gamepad-focus')}>
          <FolderOpen size={14} className="text-text-secondary" />
          {t('games.browseFiles')}
        </button>
        <button onClick={handleFpsSettings} className={clsx('context-menu-item', focused === idx('fps') && 'gamepad-focus')}>
          <Gauge size={14} className="text-text-secondary" />
          {t('games.fpsSettingsItem')}
        </button>
        <button onClick={handleDiskManage} className={clsx('context-menu-item', focused === idx('disk') && 'gamepad-focus')}>
          <HardDrive size={14} className="text-text-secondary" />
          {t('games.diskManage')}
        </button>
        <div className="context-menu-divider" />
        <button onClick={handleDelete} className={clsx('context-menu-item text-danger', focused === idx('delete') && 'gamepad-focus')}>
          <Trash2 size={14} />
          {t('games.deleteGame')}
        </button>
      </div>
    </div>,
    document.body,
  );
}
