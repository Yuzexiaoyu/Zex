import { useSyncExternalStore } from 'react';
import * as api from '../api';
import { zh, en } from './dict';

// ── 轻量语言状态 ──────────────────────────────────────────
// 不进 useAppStore：桌面歌词 / 托盘菜单是独立小窗，各自 import 这份模块
// 状态（同 bundle 内每个窗口一份），避免和主窗 store 耦合。
// 权威值在 settings 表 language 键；localStorage 存镜像供首帧同步读取
// （读数据库是异步的，等它回来界面早渲染了，会闪一次语言切换）

export type Lang = 'zh' | 'en';
const LS_KEY = 'zex-lang';

export const LANGUAGES: Array<{ code: Lang; label: string }> = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: 'English' },
];

function readInitialLang(): Lang {
  try {
    return window.localStorage.getItem(LS_KEY) === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

let currentLang: Lang = readInitialLang();
const listeners = new Set<() => void>();
function emit() { listeners.forEach((l) => l()); }

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getLang(): Lang {
  return currentLang;
}

// 切语言：立即生效（emit 触发所有 useT/useLang 组件重渲染）+ 落库落镜像。
// 落库失败只影响下次启动的默认值，不打断当前切换
export function setLang(l: Lang) {
  if (l === currentLang) return;
  currentLang = l;
  try { window.localStorage.setItem(LS_KEY, l); } catch { /* 隐私模式写不进，无所谓 */ }
  void api.setSetting('language', l).catch(() => {});
  emit();
}

// 启动时按数据库校正（数据库是权威；localStorage 镜像缺失/过期时纠偏）
export async function initLang() {
  const v = await api.getSetting('language').catch(() => null);
  if (v !== 'en' && v !== 'zh') return;
  if (v === currentLang) return;
  currentLang = v;
  try { window.localStorage.setItem(LS_KEY, v); } catch { /* ignore */ }
  emit();
}

// ── 词典 ──────────────────────────────────────────────────
const DICTS: Record<Lang, Record<string, string>> = { zh, en };

// 取词：当前语言 → 中文兜底 → key 本身（开发期漏词条直接显示 key，便于发现）
export function t(key: string, vars?: Record<string, string | number>): string {
  let s = DICTS[currentLang][key] ?? DICTS.zh[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

// 组件内用（订阅语言变化，切语言时重渲染）；事件回调等非渲染上下文
// 直接 import 模块级 t 调用，永远读到当前语言
export function useT(): typeof t {
  useSyncExternalStore(subscribe, () => currentLang);
  return t;
}

// 需要拿语言本身（而非取词）的组件用，如设置页语言行的激活态
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, () => currentLang);
}
