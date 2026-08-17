import { listen } from '@tauri-apps/api/event';
import { useFocusStore } from './focus';
import { setInputMode } from './inputMode';
import { getScrollTarget } from './scrollTarget';
import { useAppStore } from '../store';
import type { Dir } from './focus';

// 手柄输入来源：Rust 后端 gilrs 线程（src-tauri/src/gamepad.rs）把按键映射为动作
// 事件 emit 到前端。后端线程不受 WebView 窗口隐藏影响 —— 浏览器 Gamepad API 在
// WebView 隐藏后按键数据会冻结，无法用前端解决，故改走 gilrs。
//
// 事件（listen "gamepad-event"，payload 是字符串）：
//   "dir:up"/"dir:down"/"dir:left"/"dir:right"  方向按下（这里做长按连发）
//   "dir-clear"                                  方向全部释放（停连发）
//   "rscroll:<s>"                                右摇杆幅度（-1..1 数字串，正=下；0=回中停）
//   "confirm" (A) / "back" (B) / "alt" (X)
//   "bumper:left"/"bumper:right"                 LB/RB 肩键（循环切库）
// 连接状态：listen "gamepad-status"，payload 是 { xbox, ps } 各品牌已连接数。

const REPEAT_DELAY = 400;     // 方向长按后开始连发
const REPEAT_INTERVAL = 150;  // 连发间隔

// ── 右摇杆滚动：幅度直传 + 幂曲线 + 指数平滑 ──
// 后端发幅度（死区/滞回/量化已处理），这里 幅度 → 目标速度（幂曲线：轻推极慢、
// 推满全速），再用指数平滑逼近目标（τ 常数）：起步/停止圆角、方向反转过零，
// 消除「固定速度阶跃启停」的顿感
const RSCROLL_MAX = 1200;  // 最大速度 px/s（推满时）
const RSCROLL_POW = 1.0;   // 线性曲线：匀速段更快（原 1.2 幂让中段偏慢）
const RSCROLL_TAU = 40;    // 平滑时间常数 ms（圆角但不肉）
const RSCROLL_MIN = 0.15;  // 轻推即有的最低速度比例（曲线低端抬升，不黏滞）
const RSCROLL_STOP = 5;    // 速度低于此停 rAF（省电 + 无残留）

// 肩键循环切换的库（游戏库 ↔ 影视库 ↔ 音乐库 ↔ 统计 ↔ 设置，与顶部导航顺序一致）
const VIEWS = ['games', 'series', 'music', 'stats', 'settings'] as const;

// 影视详情页的焦点组：肩键在这些组上照常切库（切走即卸载详情页）；
// 其它弹层（modal / 右键菜单）压栈时仍拦截，避免从弹层底下切走视图
const DETAIL_GROUPS = ['detail-episodes', 'detail-top', 'detail-hero', 'detail-season-actions'];

function cycleView(dir: 1 | -1) {
  const s = useFocusStore.getState();
  const top = s.stack.length ? s.stack[s.stack.length - 1] : undefined;
  if (s.stack.length > 1 && top && !DETAIL_GROUPS.includes(top.group)) return;
  const { activeView, setActiveView, hiddenLibraries } = useAppStore.getState();
  // 隐藏的入口跳过，只在可见入口（设置页固定可见）间循环
  const views = VIEWS.filter((v) => v === 'settings' || !hiddenLibraries.includes(v));
  const i = views.indexOf(activeView);
  setActiveView(views[(i + dir + views.length) % views.length] ?? 'settings');
}

export interface ConnectedPad {
  id: string;
  name: string;
}

let enabled = true;              // 设置页 gamepad_enabled 开关
let xboxCount = 0;               // 后端报告的 Xbox 手柄数
let psCount = 0;                 // 后端报告的 PS（DualSense）手柄数
const connListeners = new Set<() => void>();

// 方向长按连发（事件驱动：后端只在下/释放时发事件，重复由这里定时器补）
let heldDir: Dir | null = null;
let heldSince = 0;
let repeatTimer: number | null = null;

// 右摇杆滚动：rAF 跟随显示器刷新率（60/120/144Hz 都流畅），每帧按真实时间差
// 推进当前速度（指数平滑后的连续速度）→ 起停无阶跃、幅度可变速
let rTarget = 0;          // 目标速度 px/s（幅度 → 幂曲线映射）
let rVel = 0;             // 当前实际速度（指数平滑逼近目标）
let rScrollRaf = 0;
let rScrollLast = 0;

export function getConnectedPads(): ConnectedPad[] {
  const pads: ConnectedPad[] = [];
  // name 是中英通用的紧凑格式（设置页「已连接」直接显示，不参与翻译）
  if (xboxCount > 0) pads.push({ id: 'xbox', name: `Xbox ×${xboxCount}` });
  if (psCount > 0) pads.push({ id: 'ps', name: `PS ×${psCount}` });
  return pads;
}

export function onConnectedChange(cb: () => void): () => void {
  connListeners.add(cb);
  return () => { connListeners.delete(cb); };
}

export function isGamepadEnabled(): boolean {
  return enabled;
}

export function setGamepadEnabled(v: boolean) {
  enabled = v;
  if (!v) {
    stopRepeat();
    clearRScroll();
  }
}

function emitDir(dir: Dir) {
  useFocusStore.getState().move(dir);
}

/** 方向按下：立即移动一次，并启动长按连发 */
function startRepeat(dir: Dir) {
  stopRepeat();
  heldDir = dir;
  heldSince = performance.now();
  repeatTimer = window.setInterval(() => {
    if (heldDir && performance.now() - heldSince >= REPEAT_DELAY) {
      emitDir(heldDir);
    }
  }, REPEAT_INTERVAL);
}

function stopRepeat() {
  if (repeatTimer !== null) { window.clearInterval(repeatTimer); repeatTimer = null; }
  heldDir = null;
}

function rscrollFrame(ts: number) {
  // 指数平滑逼近目标速度：dt 真实（首帧/暂停后重启用 1 帧基准；封顶 50ms 防切后台回来猛跳）
  const dt = rScrollLast > 0 ? Math.min(ts - rScrollLast, 50) : 16.7;
  rVel += (rTarget - rVel) * (1 - Math.exp(-dt / RSCROLL_TAU));
  if (rTarget === 0 && Math.abs(rVel) < RSCROLL_STOP) {
    // 回中且速度已衰减到阈值：停 rAF（等价带阻尼的收尾，不残留不滑过头）
    rVel = 0;
    rScrollRaf = 0;
    return;
  }
  const el = getScrollTarget();
  if (el) el.scrollBy({ top: (rVel * dt) / 1000 });
  rScrollLast = ts;
  rScrollRaf = requestAnimationFrame(rscrollFrame);
}
function setRScroll(s: number) {
  // 幅度 → 目标速度：符号 × 最大速度 × max(低端垫底, |s|^POW)（死区已在后端处理）
  const mag = Math.pow(Math.abs(s), RSCROLL_POW);
  rTarget = Math.sign(s) * RSCROLL_MAX * Math.max(mag, RSCROLL_MIN);
  if (!rScrollRaf) {
    rScrollLast = 0;
    rScrollRaf = requestAnimationFrame(rscrollFrame);
  }
}
function clearRScroll() {
  rTarget = 0; // 目标归零，速度按 τ 自然衰减到阈值自停
}

function handleAction(action: string) {
  if (!enabled) return;
  // 任何手柄输入都是「切到手柄控制」的信号：显示手柄焦点高亮/封面，
  // 同时抑制鼠标 hover 封面（见 GameCard 按输入模式选预览来源）
  setInputMode('gamepad');
  switch (action) {
    case 'dir:up': emitDir('up'); startRepeat('up'); break;
    case 'dir:down': emitDir('down'); startRepeat('down'); break;
    case 'dir:left': emitDir('left'); startRepeat('left'); break;
    case 'dir:right': emitDir('right'); startRepeat('right'); break;
    case 'dir-clear': stopRepeat(); clearRScroll(); break;
    case 'rscroll:0': clearRScroll(); break;
    case 'rscroll:up': setRScroll(-1); break;   // 兼容旧事件（升级期防御）
    case 'rscroll:down': setRScroll(1); break;  // 兼容旧事件（升级期防御）
    case 'confirm': useFocusStore.getState().confirm(); break;
    case 'back': useFocusStore.getState().back(); break;
    case 'alt': /* X 键：暂无绑定 */ break;
    case 'bumper:left': cycleView(-1); break;
    case 'bumper:right': cycleView(1); break;
    default:
      // rscroll:<s>：幅度直传（-1..1 数字串，正=下）
      if (action.startsWith('rscroll:')) setRScroll(parseFloat(action.slice(8)));
      break;
  }
}

let started = false;

/** App 启动时挂载一次：订阅后端 gilrs 事件（幂等，重复调用无副作用） */
export function startGamepad() {
  if (started) return;
  started = true;
  void Promise.all([
    listen<string>('gamepad-event', (e) => handleAction(e.payload)),
    listen<{ xbox: number; ps: number }>('gamepad-status', (e) => {
      const prev = xboxCount + psCount;
      xboxCount = e.payload.xbox;
      psCount = e.payload.ps;
      if (xboxCount + psCount !== prev) connListeners.forEach((cb) => cb());
    }),
  ]);
}

/** 兼容旧接口：gilrs 后端线程常驻，无需前端重启轮询 */
export function restartGamepad() {
  /* no-op：事件订阅始终在 */
}
