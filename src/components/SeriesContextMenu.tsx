import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { useAppStore } from '../store';
import { Info, Star, Trash2, Sparkles, HardDrive } from 'lucide-react';
import type { Series } from '../types';
import { useFocusIndex, useModalGamepad } from '../gamepad';

interface Props {
  series: Series;
  x: number;
  y: number;
  onOpen: () => void;
  onDelete: () => void;
  onAutoFetch: () => void;
  onDiskManage: () => void; // 磁盘管理（跨盘移动游戏，与游戏库同款入口）
  onClose: () => void;
}

export default function SeriesContextMenu({ series, x, y, onOpen, onDelete, onAutoFetch, onDiskManage, onClose }: Props) {
  const toggleSeriesFavorite = useAppStore((s) => s.toggleSeriesFavorite);
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

  // 手柄完整操作：方向上下选、A 执行、B/Esc 关闭
  const focused = useFocusIndex('menu:series');
  useModalGamepad('menu:series', {
    onClose,
    count: 5,
    cols: 1,
    activate: (i) => {
      if (i === 0) handleOpen();
      else if (i === 1) { onClose(); onAutoFetch(); }
      else if (i === 2) { onClose(); onDiskManage(); }
      else if (i === 3) void toggleFavorite();
      else handleDelete();
    },
  });

  const toggleFavorite = async () => {
    onClose();
    await toggleSeriesFavorite(series.id);
  };

  const handleOpen = () => {
    onClose();
    onOpen();
  };

  const handleDelete = () => {
    onClose();
    onDelete();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[100]"
      style={{ left: pos.left, top: pos.top, visibility: measured ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="glass-card w-52 py-1.5 animate-scale-in">
        <button onClick={handleOpen} className={clsx('context-menu-item', focused === 0 && 'gamepad-focus')}>
          <Info size={14} className="text-[#00d4ff]" />
          查看详情
        </button>
        <button
          onClick={() => { onClose(); onAutoFetch(); }}
          className={clsx('context-menu-item', focused === 1 && 'gamepad-focus')}
        >
          <Sparkles size={14} className="text-text-secondary" />
          获取元数据（TMDB）
        </button>
        <button
          onClick={() => { onClose(); onDiskManage(); }}
          className={clsx('context-menu-item', focused === 2 && 'gamepad-focus')}
        >
          <HardDrive size={14} className="text-text-secondary" />
          磁盘管理
        </button>
        <div className="context-menu-divider" />
        <button onClick={toggleFavorite} className={clsx('context-menu-item', focused === 3 && 'gamepad-focus')}>
          <Star
            size={14}
            className={series.favorite ? 'text-yellow-400' : 'text-text-secondary'}
            fill={series.favorite ? 'currentColor' : 'none'}
          />
          {series.favorite ? '取消收藏' : '收藏'}
        </button>
        <div className="context-menu-divider" />
        <button onClick={handleDelete} className={clsx('context-menu-item text-danger', focused === 4 && 'gamepad-focus')}>
          <Trash2 size={14} />
          删除影视
        </button>
      </div>
    </div>,
    document.body,
  );
}
