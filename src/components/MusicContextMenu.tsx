import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { useAppStore } from '../store';
import { FolderOpen, Star, Trash2, Play, CheckSquare, ListPlus } from 'lucide-react';
import AddToPlaylistFlyout from './AddToPlaylistFlyout';
import type { Track } from '../types';
import * as api from '../api';
import { useFocusIndex, useModalGamepad } from '../gamepad';

interface Props {
  track: Track;
  x: number;
  y: number;
  onPlay: () => void;
  onDelete: () => void;
  onMultiSelect: () => void;
  onNewPlaylist: (trackIds: string[]) => void;
  onClose: () => void;
}

export default function MusicContextMenu({ track, x, y, onPlay, onDelete, onMultiSelect, onNewPlaylist, onClose }: Props) {
  const toggleTrackFavorite = useAppStore((s) => s.toggleTrackFavorite);
  const playlists = useAppStore((s) => s.playlists);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [measured, setMeasured] = useState(false);
  // 手柄激活「添加到歌单」时展开二级菜单（hover 是鼠标路径，手柄走这个 state）
  const [flyoutOpen, setFlyoutOpen] = useState(false);

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

  // 手柄完整操作：方向上下选、A 执行、B/Esc 关闭。项数与二级菜单（「添加到歌单」）是否
  // 显示联动 —— 还没有任何歌单时不显示该入口，菜单项顺移
  const focused = useFocusIndex('menu:music');
  const hasFlyout = playlists.length > 0;
  useModalGamepad('menu:music', {
    onClose,
    count: hasFlyout ? 7 : 6,
    cols: 1,
    activate: (i) => {
      if (hasFlyout) {
        if (i === 0) { onClose(); onPlay(); }
        else if (i === 1) void toggleFavorite();
        else if (i === 2) { onClose(); onNewPlaylist([track.id]); }
        else if (i === 3) setFlyoutOpen(true);
        else if (i === 4) openFolder();
        else if (i === 5) { onClose(); onMultiSelect(); }
        else onDelete();
      } else {
        if (i === 0) { onClose(); onPlay(); }
        else if (i === 1) void toggleFavorite();
        else if (i === 2) { onClose(); onNewPlaylist([track.id]); }
        else if (i === 3) openFolder();
        else if (i === 4) { onClose(); onMultiSelect(); }
        else onDelete();
      }
    },
  });

  const toggleFavorite = async () => {
    onClose();
    await toggleTrackFavorite(track.id);
  };

  // 打开所在文件夹：取父目录交给系统资源管理器
  const openFolder = () => {
    onClose();
    const dir = track.file_path.split(/[/\\]/).slice(0, -1).join('\\') || track.file_path;
    void api.openPath(dir).catch(() => {});
  };

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[100]"
      style={{ left: pos.left, top: pos.top, visibility: measured ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="glass-card w-56 py-1.5 animate-scale-in">
        <button onClick={() => { onClose(); onPlay(); }} className={clsx('context-menu-item', focused === 0 && 'gamepad-focus')}>
          <Play size={14} className="text-[#00d4ff]" />
          播放
        </button>
        <button onClick={toggleFavorite} className={clsx('context-menu-item', focused === 1 && 'gamepad-focus')}>
          <Star
            size={14}
            className={track.favorite ? 'text-yellow-400' : 'text-text-secondary'}
            fill={track.favorite ? 'currentColor' : 'none'}
          />
          {track.favorite ? '取消收藏' : '收藏'}
        </button>
        <button onClick={() => { onClose(); onNewPlaylist([track.id]); }} className={clsx('context-menu-item', focused === 2 && 'gamepad-focus')}>
          <ListPlus size={14} className="text-text-secondary" />
          新建歌单
        </button>
        {/* 还没有任何歌单时没有可添加的目标，「添加到歌单」不显示（悬浮二级菜单往右展开） */}
        {hasFlyout && (
          <AddToPlaylistFlyout
            trackIds={[track.id]}
            onClose={onClose}
            forcedOpen={flyoutOpen}
            onForcedClose={() => setFlyoutOpen(false)}
            focused={focused === 3}
          />
        )}
        <button onClick={openFolder} className={clsx('context-menu-item', focused === (hasFlyout ? 4 : 3) && 'gamepad-focus')}>
          <FolderOpen size={14} className="text-text-secondary" />
          打开所在文件夹
        </button>
        <div className="context-menu-divider" />
        <button onClick={() => { onClose(); onMultiSelect(); }} className={clsx('context-menu-item', focused === (hasFlyout ? 5 : 4) && 'gamepad-focus')}>
          <CheckSquare size={14} className="text-text-secondary" />
          多选
        </button>
        <div className="context-menu-divider" />
        <button onClick={onDelete} className={clsx('context-menu-item text-danger', focused === (hasFlyout ? 6 : 5) && 'gamepad-focus')}>
          <Trash2 size={14} />
          从库移除
        </button>
      </div>
    </div>,
    document.body,
  );
}
