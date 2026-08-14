import { useEffect, useRef } from 'react';
import { useEscIntercept } from '../utils/escIntercept';
import { useFocusStore, useGamepadGroup } from './index';

/**
 * 弹窗手柄接入（分层策略，统一修复「弹窗开着时手柄按键穿透到背后视图」——
 * 此前弹窗不压栈，手柄 A 键会直接激活弹窗底下的游戏卡、B 键弹掉背后的详情页）：
 *
 * 弹窗打开时压栈注册本组，手柄输入被本组消费；B 键（exit → onClose）关闭弹窗；
 * Esc 同样关闭，且只在自身是栈顶弹层时响应（嵌套弹窗逐层关闭）。
 *
 * - 不传 count = 屏蔽模式：方向键/A 键无操作。复杂表单弹窗（文件选择、拖拽、多选）
 *   内容用鼠标操作，手柄只保证「不误触背后 + B/Esc 可关闭」
 * - 传 count/activate/… = 完整手柄操作（确认弹窗、简单菜单：方向选 + A 确认 + B 关闭）
 */
export function useModalGamepad(id: string, opts: {
  onClose: () => void;
  /** 弹窗是否打开（条件渲染的确认弹窗用，避免弹窗未开时也占焦点）；默认 true */
  enabled?: boolean;
  /** 可聚焦项数量；不传 = 屏蔽模式（方向/A 无操作，仅 B/Esc 关闭） */
  count?: number;
  cols?: number;
  activate?: (i: number) => void;
  horizontal?: (dir: 'left' | 'right', index: number) => boolean;
  scrollIntoView?: (i: number) => void;
  /** 打开时的初始焦点索引（默认 0；确认弹窗建议传「取消」位） */
  initialIndex?: number;
  /** 是否让 Esc 关闭本弹窗（默认 true）；拖拽等场景可关掉关闭行为但保留拦截 */
  esc?: boolean;
}) {
  const { onClose, enabled = true, esc = true, initialIndex = 0 } = opts;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useGamepadGroup(id, {
    count: enabled ? (opts.count ?? 0) : 0,
    cols: opts.cols ?? 1,
    activate: opts.activate ?? (() => {}),
    horizontal: opts.horizontal,
    scrollIntoView: opts.scrollIntoView,
    exit: () => onCloseRef.current(),
  });

  // 弹窗期间消费 Esc：计数让 App 的全局「Esc=收托盘」让位（无论 esc 开关与否，
  // 否则拖拽中按 Esc 会把整个应用收进托盘）
  useEscIntercept(enabled);
  useEffect(() => {
    if (!enabled || !esc) return;
    // 只响应自己是栈顶弹层时的 Esc：嵌套弹窗（如添加影视里的消歧弹窗）逐层关闭
    const close = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const s = useFocusStore.getState();
      if (s.stack[s.stack.length - 1]?.group !== id) return;
      onCloseRef.current();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [enabled, esc]);

  // 压栈聚焦；卸载时若栈顶仍是本组则静默弹掉（不触发 exit —— 卸载由 onClose 引发，
  // 回调已执行过，再调一次会重复关闭）
  useEffect(() => {
    if (!enabled) return;
    useFocusStore.getState().push(id, initialIndex);
    return () => {
      useFocusStore.setState((s) => {
        if (s.stack[s.stack.length - 1]?.group !== id) return s;
        return { stack: s.stack.slice(0, -1) };
      });
    };
  }, [id, enabled, initialIndex]);
}
