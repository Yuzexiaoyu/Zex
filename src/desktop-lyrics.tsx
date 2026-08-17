import { CSSProperties, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { listen, emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Lock, X } from 'lucide-react';
import * as api from './api';
import { initLang, useT } from './i18n';
import { activeLineIndex, LrcLine, parseLrc } from './utils/lyrics';

// ── 透明窗底色 —— 必须在任何异步步骤之前执行（同托盘菜单窗）──
// 窗口 transparent + html/body 透明 → 文字直接浮在桌面/游戏画面上
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

const FONT_MIN = 18;
const FONT_MAX = 40;
const FONT_DEFAULT = 26;

function DesktopLyricsBody() {
  const t = useT();
  const [lines, setLines] = useState<LrcLine[]>([]);
  const [idx, setIdx] = useState(-1);
  const [fontSize, setFontSize] = useState(FONT_DEFAULT);
  const [locked, setLocked] = useState(false);
  // locked 的 ref 镜像（事件回调注册一次，读 state 会闭包过期）
  const lockedRef = useRef(false);
  const unlockBtnRef = useRef<HTMLButtonElement>(null);

  // 插值基准：最近一次 music-progress 的 (position_ms, 本地收到时刻, playing)。
  // mpv 约每秒推一次，rAF 之间用本地时钟外推，行高亮扫过才顺滑；暂停即停表，
  // seek 后由下一次 progress 纠偏（后端已丢弃 seek 前的滞留旧位置）
  const baseRef = useRef({ posMs: 0, atPerf: 0, playing: true });
  const linesRef = useRef<LrcLine[]>([]);
  const trackIdRef = useRef<string | null>(null);
  const idxRef = useRef(-1);
  // 窗口常驻（显隐切换）：本地记可见性，隐藏时别做无谓的自关 IPC
  const visibleRef = useRef(false);
  const curLineRef = useRef<HTMLDivElement>(null);

  const hide = () => {
    if (!visibleRef.current) return;
    visibleRef.current = false;
    void invoke('set_desktop_lyrics_visible', { visible: false }).catch(() => {});
  };

  // 用户手动关闭（区别于自动场景的 hide：mpv-closed/无词/影视接管都不置抑制位）：
  // 广播给主窗口，置位「本会话不再自动弹出」
  const closeManual = () => {
    void emit('lyrics-manual-dismiss');
    hide();
  };

  // 拉歌词 → 解析；无内嵌同步歌词 = 直接不显示桌面歌词（产品决策），关窗收尾
  const loadTrack = async (id: string) => {
    try {
      const raw = await api.getTrackLyrics(id);
      const parsed = raw ? parseLrc(raw) : [];
      if (parsed.length === 0) {
        hide();
        return;
      }
      trackIdRef.current = id;
      linesRef.current = parsed;
      idxRef.current = -2; // 强制 rAF 重算当前行（即便下标与上一首巧合相同）
      setLines(parsed);
    } catch {
      hide();
    }
  };

  // 重新可见时刷新快照：停的这段时间里可能换了曲、暂停了、甚至已经停止播放
  const refresh = async () => {
    try {
      const np = await api.getMusicNowPlaying();
      if (!np) {
        hide();
        return;
      }
      baseRef.current = { posMs: np.position_ms, atPerf: performance.now(), playing: np.playing };
      if (np.track_id !== trackIdRef.current) await loadTrack(np.track_id);
    } catch {
      hide();
    }
  };

  // 上报解锁钮热区（物理屏幕坐标）给后端：锁定态下轮询只放行这一小块，
  // 光标移上去才临时关穿透让按钮吃住点击，其余区域永远穿透到后面的窗口
  const reportHotspot = async () => {
    const el = unlockBtnRef.current;
    if (!el) return;
    try {
      const win = getCurrentWindow();
      const [scale, outer] = await Promise.all([win.scaleFactor(), win.outerPosition()]);
      const r = el.getBoundingClientRect();
      const pad = 4 * scale; // 热区外扩一点，小按钮好够
      await invoke('set_lyrics_unlock_hotspot', {
        x: Math.round(outer.x + r.left * scale - pad),
        y: Math.round(outer.y + r.top * scale - pad),
        w: Math.round(r.width * scale + pad * 2),
        h: Math.round(r.height * scale + pad * 2),
      });
    } catch { /* 上报失败：后端退回整条歌词兜底 */ }
  };

  // 锁定后量一次按钮位置上报（等渲染完成再量）；解锁由后端清热区
  useEffect(() => {
    lockedRef.current = locked;
    if (!locked) return;
    const t = window.setTimeout(() => void reportHotspot(), 50);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked]);

  // 歌词窗口同样收口右键：透明窗上弹浏览器默认菜单最碍眼，原生菜单一律不出现
  useEffect(() => {
    const block = (e: Event) => e.preventDefault();
    window.addEventListener('contextmenu', block);
    return () => window.removeEventListener('contextmenu', block);
  }, []);

  // 初始快照 + 设置 + 事件订阅
  useEffect(() => {
    void refresh();
    void api.getSetting('lyrics_font_size').then((v) => {
      const n = Number(v);
      if (Number.isFinite(n) && n >= FONT_MIN && n <= FONT_MAX) setFontSize(n);
    }).catch(() => {});
    void api.getSetting('lyrics_locked').then((v) => setLocked(v === '1')).catch(() => {});

    let stops: Array<() => void> = [];
    let cancelled = false;
    (async () => {
      const subs = await Promise.all([
        listen<ProgressPayload>('music-progress', (e) => {
          const p = e.payload;
          baseRef.current = { posMs: p.position_ms, atPerf: performance.now(), playing: p.playing };
          // 兜底：track-changed 漏了也能靠进度里的 track_id 发现换曲
          if (trackIdRef.current && p.track_id !== trackIdRef.current) void loadTrack(p.track_id);
        }),
        listen<string>('music-track-changed', (e) => {
          baseRef.current = { posMs: 0, atPerf: performance.now(), playing: true };
          void loadTrack(e.payload);
        }),
        // 停止播放 / 影视接管：歌词窗一起关（产品决策）
        listen<void>('mpv-closed', hide),
        listen<void>('mpv-ready', hide),
        listen<boolean>('lyrics-lock-changed', (e) => setLocked(e.payload)),
        listen<boolean>('lyrics-visibility-changed', (e) => {
          visibleRef.current = e.payload;
          if (e.payload) {
            void refresh();
            // 重开时位置可能变了，锁着的话重报一次解锁钮热区
            if (lockedRef.current) window.setTimeout(() => void reportHotspot(), 50);
          }
        }),
      ]);
      if (cancelled) subs.forEach((s) => s()); else stops = subs;
    })();
    return () => { cancelled = true; stops.forEach((s) => s()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // rAF 插值：外推当前进度 → 当前行变化才 setState；行内高亮扫过直接写 CSS 变量（不重渲染）
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const b = baseRef.current;
      const pos = b.playing ? b.posMs + (performance.now() - b.atPerf) : b.posMs;
      const ls = linesRef.current;
      const i = ls.length > 0 ? activeLineIndex(ls, pos) : -1;
      if (i !== idxRef.current) {
        idxRef.current = i;
        setIdx(i);
      }
      let fill = 0;
      if (i >= 0) {
        const start = ls[i].timeMs;
        const end = i + 1 < ls.length ? ls[i + 1].timeMs : start + 4000;
        fill = Math.min(1, Math.max(0, (pos - start) / Math.max(1, end - start)));
      }
      curLineRef.current?.style.setProperty('--fill', `${(fill * 100).toFixed(1)}%`);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const changeFont = (delta: number) => {
    const next = Math.min(FONT_MAX, Math.max(FONT_MIN, fontSize + delta));
    if (next === fontSize) return;
    setFontSize(next);
    void api.setSetting('lyrics_font_size', String(next)).catch(() => {});
  };

  const cur = idx >= 0 && idx < lines.length ? lines[idx] : null;
  const nextIdx = idx < 0 ? 0 : idx + 1;
  const next = nextIdx < lines.length ? lines[nextIdx] : null;

  return (
    <div
      className="lyrics-root"
      style={{ '--lyrics-font': `${fontSize}px` } as CSSProperties}
    >
      {/* 拖拽层：覆盖整条，按住空白处即可拖动窗口（位置在隐藏时由后端记忆）。
          锁定时摘掉拖拽属性：悬停浮出解锁钮期间窗口恢复可点，但不该能拖动 */}
      <div className="lyrics-drag" {...(locked ? {} : { 'data-tauri-drag-region': true })} />
      <div className="lyrics-lines">
        <div ref={curLineRef} className="lyrics-line lyrics-current" style={{ '--fill': '0%' } as CSSProperties}>
          <span className="lyrics-text">{cur ? cur.text || '···' : '···'}</span>
        </div>
        <div className="lyrics-line lyrics-next">{next ? next.text || '···' : ''}</div>
      </div>
      {/* 锁定态常驻的半透小锁钮：整条歌词只有它能吃住点击（后端只放行它的热区），
          点了即解锁；其余区域点击全部穿透到后面的窗口 */}
      {locked && (
        <button
          ref={unlockBtnRef}
          className="lyrics-unlock"
          onClick={() => void invoke('set_desktop_lyrics_locked', { locked: false }).catch(() => {})}
          title={t('misc.unlockLyrics')}
        >
          <Lock size={11} />
        </button>
      )}
      {/* 悬停工具栏：锁定时整窗鼠标穿透，工具栏理论上也到不了，双保险不渲染 */}
      {!locked && (
        <div className="lyrics-toolbar">
          <button onClick={() => changeFont(-2)} title={t('misc.fontSmaller')}>A-</button>
          <button onClick={() => changeFont(2)} title={t('misc.fontLarger')}>A+</button>
          <button
            onClick={() => void invoke('set_desktop_lyrics_locked', { locked: true }).catch(() => {})}
            title={t('misc.lockLyrics')}
          >
            <Lock size={12} />
          </button>
          <button onClick={closeManual} title={t('misc.closeLyrics')}>
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

// 导出挂载函数，由 main.tsx 在检测到 ?view=desktop-lyrics 时调用
export function desktopLyrics(container: HTMLElement) {
  // 语言：localStorage 镜像已在模块加载时同步生效，这里再按数据库纠偏
  void initLang();
  createRoot(container).render(<DesktopLyricsBody />);
}
