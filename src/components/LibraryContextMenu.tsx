import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalGamepad } from '../gamepad';

// 库级右键菜单（空白区域）：与卡片右键菜单同款样式，内容由调用方传入。
// 内容不定（children 由调用方拼），手柄只做屏蔽：菜单开着时按键不穿透到背后网格，
// B/Esc 关闭；菜单项本身用鼠标（低频操作，完整手柄留给固定的卡片菜单）
interface Props {
  x: number;
  y: number;
  children: React.ReactNode;
  onClose: () => void;
}

export default function LibraryContextMenu({ x, y, children, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [measured, setMeasured] = useState(false);
  useModalGamepad('menu:library', { onClose });

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

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[100]"
      style={{ left: pos.left, top: pos.top, visibility: measured ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="glass-card w-52 py-1.5 animate-scale-in">
        {children}
      </div>
    </div>,
    document.body,
  );
}
