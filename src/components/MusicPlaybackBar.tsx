import { useCallback, useEffect, useRef, useState } from 'react';
import { Music2, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume1, Volume2, VolumeX, X } from 'lucide-react';
import { clsx } from 'clsx';
import { useAppStore } from '../store';
import { coverSrc } from '../utils/media';

// 底部全局音乐播放条：任何视图都显示（nowPlaying 为空时不渲染）。
// 播放核心是 mpv（video=no），这里只负责控制与进度展示；
// 进度由后端每秒推 music-progress，拖动 seek 时本地显示、松手提交一次
function fmtTime(ms: number): string {
  if (!ms || ms < 0) return '0:00';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export default function MusicPlaybackBar() {
  // 逐字段订阅：播放条本来就要跟进度走，但不该被 games 轮询等无关字段带着重画
  const nowPlaying = useAppStore((s) => s.nowPlaying);
  const musicShuffle = useAppStore((s) => s.musicShuffle);
  const musicLoop = useAppStore((s) => s.musicLoop);
  const musicVolume = useAppStore((s) => s.musicVolume);
  const musicTogglePause = useAppStore((s) => s.musicTogglePause);
  const musicSeek = useAppStore((s) => s.musicSeek);
  const musicNext = useAppStore((s) => s.musicNext);
  const musicPrev = useAppStore((s) => s.musicPrev);
  const setMusicVolumeLocal = useAppStore((s) => s.setMusicVolumeLocal);
  const commitMusicVolume = useAppStore((s) => s.commitMusicVolume);
  const toggleMusicShuffle = useAppStore((s) => s.toggleMusicShuffle);
  const cycleMusicLoop = useAppStore((s) => s.cycleMusicLoop);
  const stopMusic = useAppStore((s) => s.stopMusic);

  // 进度条拖动：拖动中本地显示 seekPos，松手才发一次 seek（避免高频 set time-pos 积压）
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekPos, setSeekPos] = useState(0);
  // 音量：悬停音量按钮弹出浮层调节。拖动中鼠标移出浮层也保持浮层（否则 range 卸载、
  // 拖动中断），松手后再按鼠标是否还在音量控件上决定收起。
  // 收起有 200ms 延迟：鼠标从按钮穿过「浮层与按钮之间的空隙」时浮层不闪没，进入浮层即取消
  const [volOpen, setVolOpen] = useState(false);
  const [volDragging, setVolDragging] = useState(false);
  const volWrapRef = useRef<HTMLDivElement | null>(null);
  const volHideTimer = useRef<number | null>(null);
  const showVol = useCallback(() => {
    if (volHideTimer.current != null) { window.clearTimeout(volHideTimer.current); volHideTimer.current = null; }
    setVolOpen(true);
  }, []);
  const scheduleHideVol = useCallback(() => {
    if (volHideTimer.current != null) window.clearTimeout(volHideTimer.current);
    volHideTimer.current = window.setTimeout(() => {
      volHideTimer.current = null;
      setVolOpen(false);
    }, 200);
  }, []);
  useEffect(() => () => {
    if (volHideTimer.current != null) window.clearTimeout(volHideTimer.current);
  }, []);
  // 音量：拖动中节流提交（每 80ms 把当前值发给 mpv → 实时变声但不积压命令），
  // 尾部再补一次，保证拖到最终值停手时一定到达
  const VOL_THROTTLE = 80;
  const lastVolCommit = useRef(0);
  const volPendingTimer = useRef<number | null>(null);
  const volPendingValue = useRef(0);
  useEffect(() => () => {
    if (volPendingTimer.current) window.clearTimeout(volPendingTimer.current);
  }, []);

  // 换曲/停止时重置拖动状态（isSeeking 残留会导致进度条卡在旧位置）
  const trackId = nowPlaying?.trackId;
  useEffect(() => {
    setIsSeeking(false);
    setSeekPos(0);
  }, [trackId]);

  // 点击/拖动开始：先把 seekPos 同步成当前位置，displayPos 从 positionMs 切到 seekPos 时无跳变
  // （否则点击瞬间进度条会闪到 0/上次残留值，然后才跳到点击位置）
  const onSeekStart = () => {
    setSeekPos(nowPlaying?.positionMs ?? 0);
    setIsSeeking(true);
  };
  const onSeekChange = (v: number) => {
    if (isSeeking) setSeekPos(v);            // 拖动中：本地显示，不打扰 mpv
    else void musicSeek(v);                  // 键盘/点按：直接 seek
  };
  const onSeekCommit = () => {
    setIsSeeking(false);
    void musicSeek(seekPos);
  };
  const onVolChange = (v: number) => {
    setMusicVolumeLocal(v);                  // UI 即时跟手
    const now = Date.now();
    volPendingValue.current = v;
    if (now - lastVolCommit.current >= VOL_THROTTLE) {
      lastVolCommit.current = now;
      void commitMusicVolume(v);
    } else if (volPendingTimer.current == null) {
      // 距上次提交不足节流间隔：挂一个尾部队列，停手后补发最新值
      volPendingTimer.current = window.setTimeout(() => {
        volPendingTimer.current = null;
        lastVolCommit.current = Date.now();
        void commitMusicVolume(volPendingValue.current);
      }, Math.max(1, VOL_THROTTLE - (now - lastVolCommit.current)));
    }
  };

  if (!nowPlaying) return null;

  const displayPos = isSeeking ? seekPos : nowPlaying.positionMs;
  const pct = nowPlaying.durationMs > 0
    ? Math.min(100, (displayPos / nowPlaying.durationMs) * 100)
    : 0;
  const volPct = musicVolume;

  const iconBtn = 'w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-bg-surface-active transition-all';
  const iconBtnActive = 'w-8 h-8 rounded-lg flex items-center justify-center text-[#00d4ff] bg-[rgba(0,212,255,0.10)] transition-all';

  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[120] glass-card shadow-2xl animate-fade-up"
      style={{ width: 'min(900px, calc(100vw - 48px))' }}
    >
      <div className="px-4 py-3 flex items-center gap-4">
        {/* 封面 */}
        <div className="w-12 h-12 rounded-xl overflow-hidden shrink-0 bg-bg-surface border border-border-glass flex items-center justify-center">
          {nowPlaying.coverPath ? (
            <img src={coverSrc(nowPlaying.coverPath)} alt="" className="w-full h-full object-cover" draggable={false} />
          ) : (
            <Music2 size={20} className="text-text-tertiary" />
          )}
        </div>

        {/* 歌名 / 歌手 */}
        <div className="shrink-0" style={{ width: 180 }}>
          <p className="truncate text-sm font-semibold text-text-primary">{nowPlaying.title}</p>
          <p className="truncate text-xs text-text-secondary">{nowPlaying.artist || '未知歌手'}</p>
        </div>

        {/* 控制 */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => void toggleMusicShuffle()}
            className={musicShuffle ? iconBtnActive : iconBtn}
            title={musicShuffle ? '随机播放：开' : '随机播放：关'}
          >
            <Shuffle size={15} />
          </button>
          <button onClick={() => void musicPrev()} className={iconBtn} title="上一首">
            <SkipBack size={16} />
          </button>
          <button
            onClick={() => void musicTogglePause()}
            className="w-10 h-10 rounded-full bg-[#00d4ff] hover:bg-[#00b8e6] text-black flex items-center justify-center shadow-lg glow-accent transition-all"
            title={nowPlaying.playing ? '暂停' : '播放'}
          >
            {nowPlaying.playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}
          </button>
          <button onClick={() => void musicNext()} className={iconBtn} title="下一首">
            <SkipForward size={16} />
          </button>
          <button
            onClick={() => void cycleMusicLoop()}
            className={musicLoop ? iconBtnActive : iconBtn}
            title={musicLoop === 2 ? '单曲循环' : musicLoop === 1 ? '列表循环' : '循环：关'}
          >
            {musicLoop === 2 ? <Repeat1 size={15} /> : <Repeat size={15} />}
          </button>
        </div>

        {/* 进度 */}
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="text-[11px] text-text-tertiary tabular-nums shrink-0">{fmtTime(displayPos)}</span>
          <input
            type="range"
            min={0}
            max={nowPlaying.durationMs || 1}
            value={displayPos}
            onPointerDown={onSeekStart}
            onChange={(e) => onSeekChange(Number(e.target.value))}
            onPointerUp={onSeekCommit}
            onPointerCancel={onSeekCommit}
            className="music-range flex-1 min-w-0"
            style={{ background: `linear-gradient(to right, var(--color-accent) ${pct}%, var(--color-bg-surface-active) ${pct}%)` }}
          />
          <span className="text-[11px] text-text-tertiary tabular-nums shrink-0">{fmtTime(nowPlaying.durationMs)}</span>
        </div>

        {/* 音量：悬停按钮向上弹出竖条调节（图标随音量大小变化） */}
        <div
          ref={volWrapRef}
          className="relative hidden md:block shrink-0"
          onMouseEnter={showVol}
          onMouseLeave={(e) => {
            // 浮层是容器的 absolute 子元素、渲染在按钮上方：鼠标从按钮滑到浮层会先离开
            // 容器盒触发 mouseleave。relatedTarget 仍是容器后代（浮层）时保持展开，否则收起
            const next = e.relatedTarget as Node | null;
            if (volWrapRef.current && next && volWrapRef.current.contains(next)) return;
            if (!volDragging) scheduleHideVol();
          }}
        >
          <button
            onClick={showVol}
            className={volOpen ? iconBtnActive : iconBtn}
            title="音量"
          >
            {volPct === 0 ? <VolumeX size={15} /> : volPct < 50 ? <Volume1 size={15} /> : <Volume2 size={15} />}
          </button>
          {volOpen && (
            <div
              className="absolute bottom-full mb-3 left-1/2 -translate-x-1/2 z-20 glass-card shadow-2xl animate-fade-in px-2.5 py-3 flex flex-col items-center gap-2"
              onMouseEnter={showVol}
              onMouseLeave={(e) => {
                const next = e.relatedTarget as Node | null;
                if (volWrapRef.current && next && volWrapRef.current.contains(next)) return;
                if (!volDragging) scheduleHideVol();
              }}
            >
              {/* 竖向滑杆：range rotate(-90deg) 后横变竖，min 在下、max 在上（上拖=大声），
                  蓝色 accent 渐变铺在底部。transform 会同步旋转命中区域，上下拖动正确映射到 0-100 */}
              <div className="relative" style={{ width: 28, height: 140 }}>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={volPct}
                  onChange={(e) => onVolChange(Number(e.target.value))}
                  onPointerDown={() => setVolDragging(true)}
                  onPointerUp={() => {
                    setVolDragging(false);
                    // 拖动中 mouseleave 被忽略会漏关：松手时若鼠标已不在音量控件上，立即收起
                    requestAnimationFrame(() => {
                      if (volWrapRef.current && !volWrapRef.current.matches(':hover')) setVolOpen(false);
                    });
                  }}
                  onPointerCancel={() => setVolDragging(false)}
                  className="music-range music-range-nothumb"
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    width: 140,
                    height: 28,
                    marginLeft: -70,
                    marginTop: -14,
                    transform: 'rotate(-90deg)',
                    background: `linear-gradient(to right, var(--color-accent) ${volPct}%, var(--color-bg-surface-active) ${volPct}%)`,
                  }}
                  title="音量"
                />
              </div>
              <span className="text-[11px] text-text-tertiary tabular-nums">{volPct}%</span>
            </div>
          )}
        </div>

        {/* 停止 */}
        <button onClick={() => void stopMusic()} className={clsx(iconBtn, 'hover:text-red-400')} title="停止播放">
          <X size={15} />
        </button>
      </div>

      </div>
  );
}
