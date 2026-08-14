import { create } from 'zustand';

// 当前活跃的输入模式：手柄操作 → 'gamepad'，鼠标移动/点击 → 'mouse'。
// 两个模式的选中效果互斥：手柄焦点高亮与悬停封面只在 gamepad 模式显示，
// 鼠标 hover 封面只在 mouse 模式显示。焦点位置本身在两个模式间保留——
// 切换只隐藏/显示视觉，不丢位置，按一次手柄键立即恢复原焦点高亮。
export type InputMode = 'mouse' | 'gamepad';

interface InputModeState {
  mode: InputMode;
}

export const useInputModeStore = create<InputModeState>(() => ({ mode: 'mouse' }));

/** 切模式；值未变时直接忽略，避免无谓的订阅通知 */
export function setInputMode(mode: InputMode) {
  if (useInputModeStore.getState().mode === mode) return;
  useInputModeStore.setState({ mode });
}

export function useInputMode(): InputMode {
  return useInputModeStore((s) => s.mode);
}
