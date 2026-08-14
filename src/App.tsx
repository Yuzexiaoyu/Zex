import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from './store';
import GameView from './views/GameView';
import SeriesView from './views/SeriesView';
import MusicView from './views/MusicView';
import StatsView, { firstVisibleStatsGroup } from './views/StatsView';
import SettingsView from './views/SettingsView';
import AddGameModal from './components/AddGameModal';
import MusicPlaybackBar from './components/MusicPlaybackBar';
import {
  Gamepad2, Film, Music, BarChart3, Settings,
  Minus, X
} from 'lucide-react';
import zexLogo from './assets/zex-logo.png';
import { clsx } from 'clsx';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import {
  startGamepad, setGamepadEnabled, setInputMode, useFocusStore, useGamepadFocus, useGamepadGroup,
} from './gamepad';
import * as api from './api';
import './index.css';

const navItems = [
  { id: 'games' as const, label: '游戏库', icon: Gamepad2 },
  { id: 'series' as const, label: '影视库', icon: Film },
  { id: 'music' as const, label: '音乐库', icon: Music },
  { id: 'stats' as const, label: '统计', icon: BarChart3 },
  { id: 'settings' as const, label: '设置', icon: Settings },
];

// 各视图内容区的手柄焦点组（视图切换时把焦点落进对应内容）
type View = 'games' | 'series' | 'music' | 'stats' | 'settings';
const VIEW_GROUP: Record<View, string> = {
  games: 'grid:games',
  series: 'grid:series',
  music: 'music-list',
  stats: 'stats:col:game',
  settings: 'settings:rows',
};

function NavPill({ label, icon: Icon, index, active, onClick }: {
  label: string; icon: typeof Gamepad2; index: number; active: boolean; onClick: () => void;
}) {
  const focused = useGamepadFocus('nav', index);
  return (
    <button
      onClick={onClick}
      className={clsx('nav-pill', active && 'active', focused && 'gamepad-focus')}
    >
      <Icon size={16} />
      {label}
    </button>
  );
}

export default function App() {
  // 逐字段订阅：无 selector 的 useAppStore() 会订阅整个 store，任一字段变都重渲染。
  // App 是根组件，音乐播放时 nowPlaying.positionMs 每秒变一次会带着整棵树重画
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const theme = useAppStore((s) => s.theme);
  const hiddenLibraries = useAppStore((s) => s.hiddenLibraries);
  // 隐藏的库 → 统计页去掉对应列；切到统计页时手柄焦点必须落在第一个可见列的组上
  // （'stats:col:game' 在游戏库隐藏时未注册，reset 过去会让方向键静默失效）
  const statsGroup = firstVisibleStatsGroup(hiddenLibraries);
  const groupOf = (v: View) => (v === 'stats' ? statsGroup : VIEW_GROUP[v]);
  const runningGameId = useAppStore((s) => s.runningGameId);
  const appWindow = getCurrentWindow();
  const [showAddModal, setShowAddModal] = useState(false);
  // 顶部导航按隐藏库过滤（设置页固定可见）；activeView 若落在隐藏入口上由下方 effect 修正。
  // useMemo 稳住引用：它进了下方 effect 的依赖，每次渲染新建数组会让那个 effect 每渲染都跑
  const visibleNav = useMemo(
    () => navItems.filter((item) => item.id === 'settings'
      || !hiddenLibraries.includes(item.id as 'games' | 'series' | 'music' | 'stats')),
    [hiddenLibraries],
  );
  // 收起前把界面画成空白：窗口 hide() 后 WebView2 不再合成新帧，
  // GPU 缓冲里永远是隐藏前最后一帧。隐藏后托盘唤出时旧帧为空白→不闪旧视图。
  // 用 visibility 而不是卸载，这样详情页/滚动位置等界面状态能原样留到下次唤回
  const setContentVisible = useAppStore((s) => s.setContentVisible);
  const hideToTray = useAppStore((s) => s.hideToTray);
  // 从托盘恢复时跳过入场动画（hero-in / fade-up 等），避免 mid-animation 的遮罩错位闪烁
  const skipAnimRef = useRef(false);

  // ── Xbox 手柄：挂载轮询服务 + 读开关；无手柄时服务零开销 ──
  useEffect(() => {
    startGamepad();
    api.getSetting('gamepad_enabled').then((v) => setGamepadEnabled(v !== '0')).catch(() => {});
  }, []);

  // ── 输入模式检测：鼠标移动/点击 → mouse；手柄按键由 gamepad service 设 → gamepad ──
  // 两个模式互斥、实时切换：鼠标一动，手柄的选中高亮和悬停封面立即消失（焦点位置保留）；
  // 手柄一按键，鼠标 hover 封面让位给手柄焦点封面
  useEffect(() => {
    const toMouse = () => setInputMode('mouse');
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener('pointermove', toMouse, opts);
    window.addEventListener('pointerdown', toMouse, opts);
    window.addEventListener('wheel', toMouse, opts);
    return () => {
      window.removeEventListener('pointermove', toMouse, { capture: true } as EventListenerOptions);
      window.removeEventListener('pointerdown', toMouse, { capture: true } as EventListenerOptions);
      window.removeEventListener('wheel', toMouse, { capture: true } as EventListenerOptions);
    };
  }, []);

  // 顶部导航（游戏库/影视库/设置）注册为手柄焦点组；「下」进入当前视图内容
  useGamepadGroup('nav', {
    count: visibleNav.length,
    cols: visibleNav.length,
    activate: (i) => setActiveView(visibleNav[i].id),
    leave: (dir) => {
      if (dir === 'down') useFocusStore.getState().switchTo(groupOf(activeView));
    },
  });

  // 视图切换（手柄或鼠标）→ 手柄焦点落进该视图内容区
  useEffect(() => {
    useFocusStore.getState().reset(groupOf(activeView));
  }, [activeView, statsGroup]);

  // 当前入口被隐藏时：自动切到第一个可见入口（设置页固定可见，兜底不会死循环）
  useEffect(() => {
    if (activeView === 'settings') return;
    if (hiddenLibraries.includes(activeView)) {
      const fallback = visibleNav[0]?.id ?? 'settings';
      if (fallback !== activeView) setActiveView(fallback);
    }
  }, [hiddenLibraries, activeView, visibleNav]);

  // 启动时读回持久化的界面偏好（游戏库列数等）
  useEffect(() => {
    void useAppStore.getState().loadPreferences();
  }, []);

  // 启动预加载：各库数据常驻 store 后再让用户切页。
  // 各视图只在 mount 时才 loadX，首次切到影视/音乐库要先等 IPC 往返，
  // 期间 store 还是空数组 → 会闪一帧「空库」占位 UI。
  // 本地 SQLite 查询毫秒级，启动时并行拉全量代价可忽略（游戏库启动反正要显示）
  useEffect(() => {
    const store = useAppStore.getState();
    void Promise.all([
      store.loadGames(),
      store.loadSeries(),
      store.loadTracks(),
      store.loadPlaylists(),
      store.loadStats(),
    ]).catch(() => {});
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const isDark = theme === 'dark' || (theme === 'system' && mq.matches);
      document.documentElement.classList.toggle('dark', isDark);
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  // 游玩时长的累计与结算全部由后端 4 秒定时线程完成（最小化到托盘后照常记录）。
  // 这里只在游戏运行期间定时刷新列表，让悬停/详情里的时长跟着涨；窗口隐藏时
  // 这个定时器被 WebView 节流也无所谓，数据早已写库
  useEffect(() => {
    if (!runningGameId) return;
    const timer = window.setInterval(() => {
      useAppStore.getState().loadGames().catch(() => {});
    }, 4000);
    return () => window.clearInterval(timer);
  }, [runningGameId]);

  // 后端结算完会话后发事件：清掉运行状态并刷新一次时长
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const stop = await listen<string>('game-session-ended', (e) => {
        const store = useAppStore.getState();
        if (store.runningGameId && store.runningGameId === e.payload) {
          store.setRunningGameId(null);
        }
        store.loadGames().catch(() => {});
      });
      if (cancelled) stop(); else unlisten = stop;
    })();
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // 唤回窗口：先恢复内容区 → 等浏览器合成完这一帧 → 才让后端 show()。
  // 顺序反了就会闪出隐藏前的旧画面（窗口 hide 期间 WebView2 不合成新帧）
  const restoreWindow = useCallback(() => {
    skipAnimRef.current = true;
    setContentVisible(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        invoke('show_main_window_cmd');
        requestAnimationFrame(() => {
          skipAnimRef.current = false;
        });
      });
    });
  }, [setContentVisible]);

  // 托盘右键菜单的「游戏库 / 影视库」
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const stop = await listen<string>('tray-navigate', (e) => {
        if (e.payload === 'games' || e.payload === 'series' || e.payload === 'music') {
          useAppStore.getState().setActiveView(e.payload);
          restoreWindow();
        }
      });
      if (cancelled) stop(); else unlisten = stop;
    })();
    return () => { cancelled = true; unlisten?.(); };
  }, [restoreWindow]);

  // 托盘左键单击（唤回窗口，不切换视图）
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const stop = await listen<string>('tray-restore', () => restoreWindow());
      if (cancelled) stop(); else unlisten = stop;
    })();
    return () => { cancelled = true; unlisten?.(); };
  }, [restoreWindow]);

  // ── 内置播放器（mpv）的事件 ──
  // 播放期间 ZEX 已经收进托盘，进度记录全在后端 IPC 线程里完成；
  // 这里只负责把最新状态同步给界面，供用户中途唤回窗口时看到实时进度
  useEffect(() => {
    let stops: Array<() => void> = [];
    let cancelled = false;
    (async () => {
      const subs = await Promise.all([
        // 自动续播下一集：刷新库让「继续观看」跟着走
        listen<string>('episode-changed', () => {
          useAppStore.getState().loadSeries().catch(() => {});
        }),
        // mpv 窗口已全屏就绪（首次启动 = 文件加载完成；换集 = 立即）：
        // 此刻才收 ZEX，进播放器不再闪桌面。影视接管时清音乐播放条
        listen<void>('mpv-ready', () => {
          useAppStore.getState().hideToTray();
          useAppStore.getState().clearMusicPlaying();
        }),
        // mpv 退出 → 结算已落库，刷新一遍并把窗口唤回来
        listen<void>('mpv-closed', () => {
          useAppStore.getState().loadSeries().catch(() => {});
          useAppStore.getState().clearMusicPlaying();
          restoreWindow();
        }),
        // 音乐进度：每秒推一次，播放条刷新进度 + 真实播放状态（playing 以 mpv 为准）
        listen<{ track_id: string; position_ms: number; duration_ms: number; playing: boolean }>('music-progress', (e) => {
          useAppStore.getState().updateMusicProgress({
            trackId: e.payload.track_id,
            positionMs: e.payload.position_ms,
            durationMs: e.payload.duration_ms,
            playing: e.payload.playing,
          });
        }),
        // 音乐换曲（playlist-pos 变化 → 后端开新会话）：播放条切歌
        listen<string>('music-track-changed', (e) => {
          useAppStore.getState().updateMusicTrack(e.payload);
        }),
        // 桌面歌词显隐（开窗/关窗/停止联动都来自后端广播）：同步播放条「词」按钮态
        listen<boolean>('lyrics-visibility-changed', (e) => {
          useAppStore.getState().setLyricsOpen(e.payload);
        }),
        // 歌词窗 X 被用户点掉 → 本次播放会话内不再自动弹出（dismissed 为内存态）
        listen<void>('lyrics-manual-dismiss', () => {
          useAppStore.getState().dismissLyricsAutoShow();
        }),
      ]);
      if (cancelled) subs.forEach((s) => s()); else stops = subs;
    })();
    return () => { cancelled = true; stops.forEach((s) => s()); };
  }, [restoreWindow]);

  // ZEX 重启/刷新后恢复音乐播放条（音乐播放时 mpv 还在后台跑）
  useEffect(() => {
    void api.getMusicNowPlaying().then((np) => {
      if (np) useAppStore.getState().restoreMusicNowPlaying(np);
    }).catch(() => {});
  }, []);

  const handleMinimize = () => {
    appWindow.minimize();
  };

  // 主界面 Esc = 等效点右上角的叉 → 收进托盘。
  // 详情/弹窗/菜单/拖拽开着时由它们消费 Esc（见 useEscIntercept），这里让位
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (useAppStore.getState().escInterceptCount > 0) return;
      hideToTray();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hideToTray]);

  // 叉 = 收进托盘继续后台运行（真正退出走托盘右键「退出」）
  const handleClose = () => hideToTray();

  return (
    <div className="relative flex flex-col h-screen w-screen overflow-hidden">
      {/* Ambient background */}
      <div className="bg-ambient" />

      {/* Window controls (top-right) */}
      <div className="fixed top-3.5 right-4 z-50 flex items-center gap-1.5">
        <button
          onClick={handleMinimize}
          className="w-10 h-10 rounded-xl flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-bg-surface-active transition-all"
          title="最小化"
        >
          <Minus size={18} />
        </button>
        <button
          onClick={handleClose}
          className="w-10 h-10 rounded-xl flex items-center justify-center text-text-secondary hover:text-red-400 hover:bg-red-500/15 transition-all"
          title="最小化到系统托盘（右键托盘图标可退出）"
        >
          <X size={18} />
        </button>
      </div>

      {/* Top navigation bar */}
      <header className="relative z-10 shrink-0 glass border-b border-border-glass" data-tauri-drag-region>
        <div className="flex items-center h-16 px-6 gap-6">
          {/* Logo */}
          <div className="flex items-center gap-2.5 mr-2">
            <img
              src={zexLogo}
              alt="ZEX"
              draggable={false}
              className="w-8 h-8 object-contain"
              style={{ filter: 'drop-shadow(0 0 5px rgba(0,212,255,0.35))' }}
            />
            <span className="text-lg font-bold tracking-tight text-glow-accent">ZEX</span>
          </div>

          {/* Nav pills（隐藏的库不渲染） */}
          <nav className="flex items-center gap-1">
            {visibleNav.map((item, i) => (
              <NavPill
                key={item.id}
                label={item.label}
                icon={item.icon}
                index={i}
                active={activeView === item.id}
                onClick={() => setActiveView(item.id)}
              />
            ))}
          </nav>

        </div>
      </header>

      {/* Main content —— app-blank 时整棵子树 visibility:hidden，GPU 缓冲存空白帧 */}
      <main
        className="relative z-10 flex-1 min-h-0 overflow-hidden"
        data-skip-animations={skipAnimRef.current ? '' : undefined}
      >
        {/* 这层刻意不做入场动画：外层 translateY/opacity 会把整棵子树（含 hero
            的渐变遮罩）逐帧重新光栅化，遮罩边缘会出现抖动。各视图内部
            （hero-in / hero-content / card-enter）已有自己的入场动画 */}
        <div className="h-full">
          {activeView === 'games' && <GameView onAddGame={() => setShowAddModal(true)} />}
          {activeView === 'series' && <SeriesView />}
          {activeView === 'music' && <MusicView />}
          {activeView === 'stats' && <StatsView />}
          {activeView === 'settings' && <SettingsView />}
        </div>
      </main>

      {/* Modals */}
      {showAddModal && <AddGameModal onClose={() => setShowAddModal(false)} />}

      {/* 全局音乐播放条（nowPlaying 为空时不渲染） */}
      <MusicPlaybackBar />
    </div>
  );
}
