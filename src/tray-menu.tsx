import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { Gamepad2, Film, Music, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react';
import * as api from './api';
import { coverSrc } from './utils/media';

// ── 托盘菜单的 HTML 底色 —— 必须在任何异步步骤之前执行 ──
// 透明窗口在 WebView2 完成首次绘制前会短暂露出白色表面，
// 同步内联脚本 + !important 是最早的着色时机（早于 CSS 文件加载、早于 React 挂载）
// html/body 必须透明，否则会盖住 .tray-menu 的 border-radius 圆角，
// 在窗口四角显出方角底色。窗口透明 + html/body 透明 → 圆角外直接透桌面。
document.documentElement.style.setProperty('background', 'transparent', 'important');
document.body.style.setProperty('background', 'transparent', 'important');
document.body.style.setProperty('margin', '0', 'important');
document.body.style.setProperty('padding', '0', 'important');

// 事件负载（与后端 MusicProgressPayload 对齐）
interface ProgressPayload {
  track_id: string;
  position_ms: number;
  duration_ms: number;
  playing: boolean;
}

function TrayMenuBody() {
  // wrapper 提供 3px 透明内边距，让 .tray-menu 的 border-radius 抗锯齿边缘像素
  // 不会紧贴窗口边界——DWM 合成器在像素有透明邻居时才能正确混合 alpha
  const wrapperRef = useRef<HTMLDivElement>(null);

  // 当前音乐元数据（标题/歌手/封面）+ 播放状态。meta 里的进度/playing 是初始值，
  // 常驻后由 music-progress 事件的 progress 状态覆盖（progress 每秒推、含真实 playing）
  const [meta, setMeta] = useState<api.MusicNowPlaying | null>(null);
  const [progress, setProgress] = useState<{ positionMs: number; durationMs: number; playing: boolean } | null>(null);
  // 隐藏的库（settings 表 hidden_libraries）：菜单里不再显示对应库项
  const [hiddenLibs, setHiddenLibs] = useState<string[]>([]);
  const metaRef = useRef<api.MusicNowPlaying | null>(null);
  const applyMeta = (m: api.MusicNowPlaying | null) => { metaRef.current = m; setMeta(m); };
  const refreshMeta = () => { void api.getMusicNowPlaying().then(applyMeta).catch(() => {}); };

  // 拉初始状态 + 订阅播放事件（托盘窗口常驻隐藏，事件流持续喂它，弹出即最新）
  useEffect(() => {
    void api.getSetting('hidden_libraries').then((v) => {
      if (v) setHiddenLibs(v.split(',').filter(Boolean));
    }).catch(() => {});
    let stops: Array<() => void> = [];
    let cancelled = false;
    (async () => {
      refreshMeta();
      const subs = await Promise.all([
        // 进度 + 真实播放状态（每秒推，暂停/seek 也会即时推）
        listen<ProgressPayload>('music-progress', (e) => {
          const p = e.payload;
          setProgress({ positionMs: p.position_ms, durationMs: p.duration_ms, playing: p.playing });
          // 拖动 seek 提交后：mpv 落到目标即解除「目标位置显示」锁定，切回实时进度
          if (seekPendingRef.current) {
            const t = seekTargetRef.current;
            if (t && Math.abs(p.position_ms - t.ratio * t.durMs) < 300) {
              seekPendingRef.current = false;
              seekTargetRef.current = null;
              setDragRatio(null);
            }
          }
          // 换曲瞬间 music-track-changed 可能先到（此刻 progress 还是旧曲）：以事件为准刷新元数据
          if (metaRef.current && metaRef.current.track_id !== p.track_id) refreshMeta();
        }),
        // 换曲：清掉旧进度、重置 seek 锁定、重拉元数据
        listen<string>('music-track-changed', () => {
          seekPendingRef.current = false;
          seekTargetRef.current = null;
          setDragRatio(null);
          setProgress(null);
          refreshMeta();
        }),
        // 停止 / 影视接管：清空正在播放区
        listen<void>('mpv-closed', () => { seekPendingRef.current = false; seekTargetRef.current = null; setDragRatio(null); applyMeta(null); setProgress(null); }),
        listen<void>('mpv-ready', () => { seekPendingRef.current = false; seekTargetRef.current = null; setDragRatio(null); applyMeta(null); setProgress(null); }),
        // 每次右键弹出：按当前内容重新校准窗口高度（兜底 ResizeObserver）+ 刷新隐藏库设置
        listen<void>('tray-menu-shown', () => {
          reportHeight();
          void api.getSetting('hidden_libraries').then((v) => {
            setHiddenLibs(v ? v.split(',').filter(Boolean) : []);
          }).catch(() => {});
        }),
      ]);
      if (cancelled) subs.forEach((s) => s()); else stops = subs;
    })();
    return () => { cancelled = true; stops.forEach((s) => s()); };
  }, []);

  // 菜单内容高度随播放状态变化（占位 ↔ 完整信息），实时回报后端修正窗口高度。
  // 只测一次的话：首次挂载还是占位、播放信息加载后菜单变高，底部「音乐库/退出」会被裁掉
  const reportHeight = () => {
    const el = wrapperRef.current;
    if (!el) return;
    invoke('tray_menu_ready', { height: Math.ceil(el.getBoundingClientRect().height) }).catch(() => {});
  };
  useLayoutEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    reportHeight();
    const ro = new ResizeObserver(reportHeight);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const onBlur = () => invoke('close_tray_menu');
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);

  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') invoke('close_tray_menu'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const act = (action: string) => invoke('tray_menu_action', { action }).catch(() => {});
  // 只控制播放器，不跳转、不关菜单（点按按钮不会让窗口失焦 → 不触发 blur 关闭）。
  // value 语义随 op：next/prev 不看它，toggle_pause 要的是「目标 pause 值」
  //（后端 music_control 判的是 value > 0.0 → 暂停），恒传 0 等于永远发「继续播放」
  const ctrl = (op: string, value = 0) => { void api.musicControl(op, value).catch(() => {}); };

  // ── 进度条拖动 seek ──
  // 纯点击：不预览，直接 seek，fill 由 progress 一次性过渡到目标（避免预览弹回 + 二次动画）。
  // 真拖动（位移 >3px 才算）：fill 跟随手指，松手提交后保留目标位置显示，等 progress 确认
  // mpv 已落到目标再切回实时 —— 期间不会被旧进度弹回。
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const movedRef = useRef(false);
  const startXRef = useRef(0);
  const seekPendingRef = useRef(false);
  const seekTargetRef = useRef<{ ratio: number; durMs: number } | null>(null);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const ratioFromX = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };
  const onTrackDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!meta || !durMs) return;
    e.preventDefault();
    dragging.current = true;
    movedRef.current = false;
    startXRef.current = e.clientX;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onTrackMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    if (!movedRef.current && Math.abs(e.clientX - startXRef.current) > 3) {
      movedRef.current = true;
    }
    if (movedRef.current) setDragRatio(ratioFromX(e.clientX));
  };
  const onTrackUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    const r = ratioFromX(e.clientX);
    void api.musicControl('seek', (r * durMs) / 1000).catch(() => {});
    if (movedRef.current) {
      // 真拖动：保留目标显示，等 progress 确认到位再切回实时；2s 兜底防 seek 失败卡住
      setDragRatio(r);
      seekPendingRef.current = true;
      seekTargetRef.current = { ratio: r, durMs };
      window.setTimeout(() => {
        if (seekPendingRef.current) {
          seekPendingRef.current = false;
          seekTargetRef.current = null;
          setDragRatio(null);
        }
      }, 2000);
    } else {
      setDragRatio(null);
    }
  };
  const onTrackCancel = () => {
    dragging.current = false;
    seekPendingRef.current = false;
    seekTargetRef.current = null;
    setDragRatio(null);
  };

  // 展示数据：progress 优先（实时），否则用 meta 里的初始值
  const playing = progress ? progress.playing : (meta?.playing ?? true);
  const posMs = progress ? progress.positionMs : (meta?.position_ms ?? 0);
  const durMs = progress ? progress.durationMs : (meta?.duration_ms ?? 0);
  const pct = durMs > 0 ? Math.min(100, (posMs / durMs) * 100) : 0;

  return (
    <div ref={wrapperRef} style={{ padding: '3px' }}>
      <div className="tray-menu animate-scale-in" style={{ width: 200 }}>
        {/* ─── 正在播放（纯展示，切库走下方菜单项）。音乐库被隐藏时不显示 ─── */}
        {!hiddenLibs.includes('music') && (meta ? (
          <div className="tray-music">
            <div className="tray-music-head">
              <div className="tray-music-cover">
                {meta.cover_path
                  ? <img src={coverSrc(meta.cover_path)} alt="" draggable={false} />
                  : <Music size={14} />}
              </div>
              <div className="tray-music-info">
                <p className="tray-music-title" title={meta.title}>{meta.title}</p>
                <p className="tray-music-artist" title={meta.artist || '未知歌手'}>
                  {meta.artist || '未知歌手'}
                </p>
              </div>
            </div>
            {/* 迷你进度条：点击/拖动 seek */}
            <div
              ref={trackRef}
              className="tray-music-track"
              onPointerDown={onTrackDown}
              onPointerMove={onTrackMove}
              onPointerUp={onTrackUp}
              onPointerCancel={onTrackCancel}
              title="拖动进度"
            >
              <div className="tray-music-track-fill" style={{ width: `${dragRatio != null ? dragRatio * 100 : pct}%` }} />
            </div>
            {/* 控制：上一首 / 播放暂停 / 下一首 */}
            <div className="tray-music-ctrl">
              <button className="tray-music-btn" onClick={() => ctrl('prev')} title="上一首">
                <SkipBack size={13} />
              </button>
              <button className="tray-music-btn tray-music-main" onClick={() => ctrl('toggle_pause', playing ? 1 : 0)} title={playing ? '暂停' : '播放'}>
                {playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
              </button>
              <button className="tray-music-btn" onClick={() => ctrl('next')} title="下一首">
                <SkipForward size={13} />
              </button>
            </div>
          </div>
        ) : (
          <div className="tray-music-empty">
            <Music size={14} />
            <span>未在播放</span>
          </div>
        ))}
        {!hiddenLibs.includes('music') && <div className="tray-menu-sep" />}
        {!hiddenLibs.includes('games') && (
          <button className="tray-menu-item" onClick={() => act('games')}>
            <Gamepad2 size={16} />
            <span>游戏库</span>
          </button>
        )}
        {!hiddenLibs.includes('series') && (
          <button className="tray-menu-item" onClick={() => act('series')}>
            <Film size={16} />
            <span>影视库</span>
          </button>
        )}
        {!hiddenLibs.includes('music') && (
          <button className="tray-menu-item" onClick={() => act('music')}>
            <Music size={16} />
            <span>音乐库</span>
          </button>
        )}
        <div className="tray-menu-sep" />
        <button className="tray-menu-item danger" onClick={() => act('quit')}>
          <X size={16} />
          <span>退出</span>
        </button>
      </div>
    </div>
  );
}

// 导出挂载函数，由 main.tsx 在检测到 ?view=tray-menu 时调用
export function trayMenu(container: HTMLElement) {
  createRoot(container).render(<TrayMenuBody />);
}
