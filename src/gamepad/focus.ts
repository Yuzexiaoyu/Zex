import { create } from 'zustand';
import { useEffect } from 'react';
import { useInputMode } from './inputMode';

export type Dir = 'up' | 'down' | 'left' | 'right';

/** 一个可导航焦点组：规则网格（cols>1）或列表/横向（cols=1） */
export interface GroupOpts {
  /** 可聚焦项数量 */
  count: number;
  /** 规则网格列数；省略时按单行（cols=count）处理 */
  cols?: number;
  /** A 键按下时激活第 index 项 */
  activate: (index: number) => void;
  /** 焦点移到 index 时保证其可见（如滚动容器 scrollToIndex） */
  scrollIntoView?: (index: number) => void;
  /** 焦点在边界且继续朝 dir 移动时跳转（跨区域）；不定义则停在边界 */
  leave?: (dir: Dir, index: number) => void;
  /** 该组被 B 弹栈时调用（关闭弹层/详情） */
  exit?: () => void;
  /** 左/右键在行内切换时优先调用（如设置页的 chips 开/关）；返回 true 表示已消费、不移动行 */
  horizontal?: (dir: 'left' | 'right', index: number) => boolean;
}

interface FocusItem {
  group: string;
  /** index 为 null = 未聚焦待命态（reset 后还没按过方向键） */
  index: number | null;
}

interface FocusStore {
  /** 焦点层级栈，栈顶为当前焦点；modal/detail 打开时压栈、B 弹栈 */
  stack: FocusItem[];
  register: (id: string, opts: GroupOpts) => void;
  unregister: (id: string) => void;
  /** 清栈到单层并聚焦（视图切换用）。不传 index 时进入「未聚焦」待命态：
   *  启动 / 切换视图不自动选中第一项（避免游戏库首个游戏被手柄默认选中而弹出悬停封面），
   *  首次按方向键才落到第 0 项 */
  reset: (group: string, index?: number | null) => void;
  /** 压栈（打开 modal/detail） */
  push: (group: string, index?: number) => void;
  /** 替换栈顶（同视图内区域切换，如网格 ↔ nav） */
  switchTo: (group: string, index?: number) => void;
  move: (dir: Dir) => void;
  confirm: () => void;
  /** 弹栈；返回 true = 发生了弹栈 */
  back: () => boolean;
}

// 区域注册表放模块级 Map：zustand state 只存可序列化状态，函数不进 store
const registry = new Map<string, GroupOpts>();

/** 栈顶元素（数组 .at(-1) 需要 es2022，项目 target 较低，手写） */
function topItem(stack: FocusItem[]): FocusItem | undefined {
  return stack.length ? stack[stack.length - 1] : undefined;
}

export const useFocusStore = create<FocusStore>((set, get) => ({
  stack: [],

  register: (id, opts) => { registry.set(id, opts); },
  unregister: (id) => { registry.delete(id); },

  reset: (group, index = null) => {
    set({ stack: [{ group, index }] });
    if (index != null) registry.get(group)?.scrollIntoView?.(index);
  },

  push: (group, index = 0) => {
    const top = topItem(get().stack);
    if (top?.group === group && top.index === index) return; // 已在同组同项，不重复压
    set((s) => ({ stack: [...s.stack, { group, index }] }));
    registry.get(group)?.scrollIntoView?.(index);
  },

  switchTo: (group, index = 0) => {
    const stack = get().stack;
    const next = stack.length ? [...stack.slice(0, -1), { group, index }] : [{ group, index }];
    set({ stack: next });
    registry.get(group)?.scrollIntoView?.(index);
  },

  move: (dir) => {
    const top = topItem(get().stack);
    if (!top) return;
    const opts = registry.get(top.group);
    if (!opts || opts.count <= 0) return;
    // 未聚焦待命态（reset 后还没按过方向键）：任何方向都落到第 0 项，
    // 避免启动/切视图就自动选中第一项（如游戏库首个游戏弹出悬停封面）
    if (top.index == null) {
      set((s) => {
        const stack = s.stack.slice();
        stack[stack.length - 1] = { ...stack[stack.length - 1], index: 0 };
        return { stack };
      });
      opts.scrollIntoView?.(0);
      return;
    }
    const { count, cols = count } = opts;
    const index = top.index;
    let next = index;
    let crossed = false;
    if (dir === 'left' || dir === 'right') {
      // 行内左右优先交给 horizontal 处理器（设置页 chips 切换等）；未消费才移动行
      if (opts.horizontal?.(dir, index)) return;
    }
    if (cols > 1) {
      const row = Math.floor(index / cols);
      const col = index % cols;
      const lastIdx = count - 1;
      const lastRow = Math.floor(lastIdx / cols);
      const lastRowCol = lastIdx % cols;
      switch (dir) {
        case 'left':
          if (col > 0) next = index - 1; else crossed = true;
          break;
        case 'right':
          if (col < (row === lastRow ? lastRowCol : cols - 1)) next = index + 1; else crossed = true;
          break;
        case 'up':
          if (row > 0) next = index - cols; else crossed = true;
          break;
        case 'down':
          if (row < lastRow) next = Math.min(count - 1, index + cols); else crossed = true;
          break;
      }
    } else {
      switch (dir) {
        case 'left': case 'up':
          if (index > 0) next = index - 1; else crossed = true;
          break;
        case 'right': case 'down':
          if (index < count - 1) next = index + 1; else crossed = true;
          break;
      }
    }
    if (crossed) { opts.leave?.(dir, index); return; }
    if (next !== index) {
      set((s) => {
        const stack = s.stack.slice();
        stack[stack.length - 1] = { ...stack[stack.length - 1], index: next };
        return { stack };
      });
      opts.scrollIntoView?.(next);
    }
  },

  confirm: () => {
    const top = topItem(get().stack);
    if (!top || top.index == null) return;
    registry.get(top.group)?.activate?.(top.index);
  },

  back: () => {
    const stack = get().stack;
    if (stack.length <= 1) return false;
    const popped = stack[stack.length - 1];
    const rest = stack.slice(0, -1);
    set({ stack: rest });
    registry.get(popped.group)?.exit?.(); // 关闭被弹栈的弹层/详情
    const top = rest[rest.length - 1];
    if (top.index != null) registry.get(top.group)?.scrollIntoView?.(top.index);
    return true;
  },
}));

/** 组件读自己是否「当前焦点」（仅手柄模式生效；鼠标模式下隐藏手柄焦点效果） */
export function useGamepadFocus(group: string, index: number): boolean {
  const mode = useInputMode();
  return useFocusStore((s) => {
    const top = topItem(s.stack);
    return mode === 'gamepad' && top?.group === group && top.index === index;
  });
}

/** 当前组在「手柄模式」下的焦点索引；鼠标模式或无焦点时返回 -1。
 *  手柄焦点位置本身在鼠标模式下保留（move 照常更新，只是不对外显示），
 *  切回 gamepad 后原位置高亮立即恢复 —— 两种控制互斥、实时切换 */
export function useFocusIndex(group: string): number {
  const mode = useInputMode();
  return useFocusStore((s) => {
    if (mode !== 'gamepad') return -1;
    const top = topItem(s.stack);
    return top?.group === group ? (top.index ?? -1) : -1;
  });
}

/** 容器注册焦点组；opts 对象每次渲染新引用 → effect 每帧重跑，registry 始终持有最新回调
 *  （若只在 count/cols 变化时注册，会残留旧闭包快照，动态行/列表的行内交互会失效） */
export function useGamepadGroup(id: string, opts: GroupOpts) {
  useEffect(() => {
    useFocusStore.getState().register(id, opts);
    return () => useFocusStore.getState().unregister(id);
  }, [id, opts]);
}
