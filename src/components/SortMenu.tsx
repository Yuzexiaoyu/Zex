import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpDown, Check, ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';
import { useEscIntercept } from '../utils/escIntercept';
import { useFocusStore, useGamepadGroup, useFocusIndex } from '../gamepad';

export interface SortOption {
  key: string;
  label: string;
  hint?: string;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
}

interface Props {
  value: string;
  options: SortOption[];
  onChange: (key: string) => void;
  /** 手柄焦点是否停在排序按钮上（加高亮） */
  focused?: boolean;
}

export interface SortMenuHandle {
  toggle: () => void;
}

const MENU_WIDTH = 232;

// 排序下拉：原生 select 的弹层由系统绘制、与玻璃主题格格不入，这里换成自绘菜单。
// 菜单用 portal 挂到 body —— 工具栏是 sticky + backdrop-filter，容器内的绝对定位会被裁切
const SortMenu = forwardRef<SortMenuHandle, Props>(function SortMenu({ value, options, onChange, focused }, ref) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const current = options.find((o) => o.key === value) ?? options[0];

  // 手柄：暴露 toggle 给父组件（工具栏 A 激活排序时开/关菜单）
  useImperativeHandle(ref, () => ({ toggle: () => setOpen((v) => !v) }));

  // 菜单打开时压栈聚焦：上下选、A 确定、B 关闭
  useGamepadGroup('sort-menu', {
    count: open ? options.length : 0,
    cols: 1,
    activate: (i) => { onChange(options[i].key); setOpen(false); },
    exit: () => setOpen(false),
  });
  useEffect(() => {
    if (!open) return;
    useFocusStore.getState().push('sort-menu');
    return () => {
      const s = useFocusStore.getState();
      const top = s.stack.length ? s.stack[s.stack.length - 1] : undefined;
      if (top?.group === 'sort-menu') s.back();
    };
  }, [open]);
  const menuFocused = useFocusIndex('sort-menu');

  // 下拉开着时由它消费 Esc，App 的全局「Esc=收托盘」让位
  useEscIntercept(open);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      left: Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)),
      top: Math.min(rect.bottom + 8, window.innerHeight - 16),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className={clsx('sort-trigger', open && 'active', focused && 'gamepad-focus')}
        title="选择排序方式"
      >
        <ArrowUpDown size={14} />
        <span className="text-text-tertiary">排序</span>
        <span className="font-medium text-text-primary">{current?.label}</span>
        <ChevronDown size={13} className={clsx('transition-transform duration-200', open && 'rotate-180')} />
      </button>

      {open && pos && createPortal(
        <div
          className="fixed z-[150]"
          style={{ left: pos.left, top: pos.top }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="glass-card py-1.5 animate-scale-in shadow-2xl" style={{ width: MENU_WIDTH }}>
            <p className="px-4 pt-1.5 pb-2 text-[11px] font-semibold tracking-[0.12em] text-text-tertiary">
              排序方式
            </p>
            {options.map((o, i) => {
              const Icon = o.icon;
              const active = o.key === value;
              return (
                <button
                  key={o.key}
                  onClick={() => { onChange(o.key); setOpen(false); }}
                  className={clsx('sort-item', active && 'active', menuFocused === i && 'gamepad-focus')}
                >
                  {Icon && <Icon size={15} className="shrink-0" />}
                  <span className="flex-1 min-w-0 text-left">
                    <span className="block text-[13px] font-medium leading-tight">{o.label}</span>
                    {o.hint && (
                      <span className="block mt-0.5 text-[11px] text-text-tertiary leading-tight">{o.hint}</span>
                    )}
                  </span>
                  {active && <Check size={14} className="shrink-0 text-[#00d4ff]" />}
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
});

export default SortMenu;
