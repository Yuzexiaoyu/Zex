import { create } from 'zustand';

// 游戏库每行卡片数的可调范围（设置页滑杆）
export const MIN_GAME_COLUMNS = 3;
export const MAX_GAME_COLUMNS = 12;
import type { Game, GameFilter, Playlist, Series, SeriesCard, Stats, ThemeMode, Track } from '../types';
import * as api from '../api';
import { parseLrc, type LrcLine } from '../utils/lyrics';

// 音乐播放条的当前状态（展示数据冗余，避免每次都要回查 tracks）
export interface MusicNowPlayingState {
  trackId: string;
  title: string;
  artist: string;
  coverPath: string;
  positionMs: number;
  durationMs: number;
  playing: boolean;
}

// 音量持久化防抖：拖动时 commit 节流调用，这里只写最终值（避免高频写 SQLite）
let musicVolPersistTimer: number | null = null;

// 当前曲的带时间轴内嵌歌词行；无播放 / 无词 / 请求失败 → null（自动开词与词按钮共用校验）
async function currentTimedLyrics(): Promise<LrcLine[] | null> {
  const np = useAppStore.getState().nowPlaying;
  if (!np) return null;
  const raw = await api.getTrackLyrics(np.trackId).catch(() => null);
  if (!raw) return null;
  const lines = parseLrc(raw);
  return lines.length > 0 ? lines : null;
}

interface AppState {
  // ─── Data ───────────────────────────────
  games: Game[];
  series: SeriesCard[];   // 含季数/集数/已看数等统计（get_series_library）
  tracks: Track[];        // 音乐曲目
  playlists: Playlist[];  // 歌单（含每歌单曲目 id，前端本地过滤）
  stats: Stats | null;
  runningGameId: string | null;

  // ─── Music Playback ──────────────────────
  nowPlaying: MusicNowPlayingState | null;
  musicQueue: Track[];    // 当前队列（播放条上一首/下一首的上下文）
  musicShuffle: boolean;
  musicLoop: 0 | 1 | 2;   // 0 关 / 1 列表循环 / 2 单曲循环
  musicVolume: number;
  musicSeekTarget: number | null; // 最近一次 seek 的目标 ms；progress 位置接近它之前，position 不被覆盖
  musicSeekLockUntil: number;     // seek 态绝对超时（ms 时间戳）：超时强制采纳 progress 位置（seek 异常兜底）
  lyricsOpen: boolean;            // 桌面歌词窗是否开着（权威来源 = 后端广播的 lyrics-visibility-changed）
  lyricsDismissed: boolean;       // 本次播放会话内已手动关过词，抑制自动弹出（内存态，重启清零）

  // ─── UI State ───────────────────────────
  activeView: 'games' | 'series' | 'music' | 'stats' | 'settings';
  // 隐藏的库（主库最多 2 个 + 统计页可单独隐藏；settings 表 hidden_libraries 持久化；设置页本身固定可见）
  hiddenLibraries: Array<'games' | 'series' | 'music' | 'stats'>;
  filter: GameFilter;
  selectedGameId: string | null;
  selectedSeriesId: string | null;
  selectedSeasonId: string | null;
  theme: ThemeMode;
  gameColumns: number;   // 游戏库每行卡片数（设置页可调，写入 settings 表持久化）
  contentVisible: boolean; // false = 界面画成空白帧，收进托盘前的准备动作
  escInterceptCount: number; // >0 = 有浮层在消费 Esc，全局「Esc=收托盘」让位
  // 元数据抓取进度（全局，跨库保留）：切库再回来面板不丢、防二次触发
  metadataFetchingTitle: string | null;
  fetchPct: number;

  // ─── Actions ────────────────────────────
  loadGames: () => Promise<void>;
  loadSeries: () => Promise<void>;
  loadTracks: () => Promise<void>;
  loadPlaylists: () => Promise<void>;
  loadStats: () => Promise<void>;

  setActiveView: (view: AppState['activeView']) => void;
  setMetadataFetching: (title: string | null) => void;
  setFetchPct: (p: number) => void;
  setFilter: (filter: Partial<GameFilter>) => void;
  setSelectedGameId: (id: string | null) => void;
  setSelectedSeriesId: (id: string | null) => void;
  setSelectedSeasonId: (id: string | null) => void;
  setTheme: (theme: ThemeMode) => void;
  setGameColumns: (n: number) => void;
  setLibraryHidden: (id: 'games' | 'series' | 'music' | 'stats', hidden: boolean) => void;
  loadPreferences: () => Promise<void>;
  setContentVisible: (v: boolean) => void;
  hideToTray: () => void;
  escInterceptInc: () => void;
  escInterceptDec: () => void;

  createGame: (game: Omit<Game, 'id' | 'created_at' | 'updated_at' | 'total_seconds' | 'steam_appid'>) => Promise<Game>;
  updateGame: (id: string, game: Partial<Game>) => Promise<void>;
  deleteGame: (id: string) => Promise<void>;
  reorderGames: (orderedIds: string[]) => Promise<void>;
  launchGame: (id: string) => Promise<void>;
  setRunningGameId: (id: string | null) => void;

  createSeries: (series: Omit<Series, 'id' | 'created_at' | 'updated_at'>) => Promise<Series>;
  updateSeries: (id: string, series: Partial<Series>) => Promise<void>;
  toggleSeriesFavorite: (id: string) => Promise<void>;
  reorderSeries: (orderedIds: string[]) => Promise<void>;
  deleteSeries: (id: string) => Promise<void>;

  updateWatchProgress: (episodeId: string, watchedMs: number) => Promise<void>;
  deleteTrack: (id: string) => Promise<void>;
  toggleTrackFavorite: (id: string) => Promise<void>;
  reorderTracks: (orderedIds: string[]) => Promise<void>;
  createPlaylist: (name: string, trackIds?: string[]) => Promise<Playlist>;
  addTracksToPlaylist: (playlistId: string, trackIds: string[]) => Promise<number>;
  deletePlaylist: (id: string) => Promise<void>;

  playTrack: (track: Track, queue: Track[]) => Promise<void>;
  updateMusicProgress: (p: { trackId: string; positionMs: number; durationMs: number; playing?: boolean }) => void;
  updateMusicTrack: (trackId: string) => void;
  restoreMusicNowPlaying: (np: {
    track_id: string; title: string; artist: string; cover_path: string;
    position_ms: number; duration_ms: number; playing: boolean;
  }) => void;
  musicTogglePause: () => Promise<void>;
  musicSeek: (ms: number) => Promise<void>;
  musicNext: () => Promise<void>;
  musicPrev: () => Promise<void>;
  setMusicVolumeLocal: (v: number) => void;
  commitMusicVolume: (v: number) => Promise<void>;
  toggleMusicShuffle: () => Promise<void>;
  cycleMusicLoop: () => Promise<void>;
  stopMusic: () => Promise<void>;
  clearMusicPlaying: () => void;
  setLyricsOpen: (v: boolean) => void;
  // 播放开始时静默尝试自动开词（设置开 + 未手动关过 + 当前曲有带时间轴歌词）
  autoShowLyrics: () => Promise<void>;
  // 歌词窗手动关闭信号（X 按钮）→ 本次会话内不再自动弹出
  dismissLyricsAutoShow: () => void;
  // 桌面歌词开关：返回 false = 当前曲无内嵌同步歌词、未开窗（播放条据此弹提示）
  toggleDesktopLyrics: () => Promise<boolean>;
}

export const useAppStore = create<AppState>((set, get) => ({
  // ─── Initial Data ──────────────────────
  games: [],
  series: [],
  tracks: [],
  playlists: [],
  stats: null,
  runningGameId: null,

  // ─── Initial Music Playback ────────────
  nowPlaying: null,
  musicQueue: [],
  musicShuffle: false,
  musicLoop: 0,
  musicVolume: 70,
  musicSeekTarget: null,
  musicSeekLockUntil: 0,
  lyricsOpen: false,
  lyricsDismissed: false,

  // ─── Initial UI State ───────────────────
  activeView: 'games',
  hiddenLibraries: [],
  filter: {},
  selectedGameId: null,
  selectedSeriesId: null,
  selectedSeasonId: null,
  theme: 'dark',
  gameColumns: 8,
  contentVisible: true,
  escInterceptCount: 0,
  metadataFetchingTitle: null,
  fetchPct: 0,

  // ─── Actions ────────────────────────────
  // 直接摸 DOM 而不是靠 React 渲染：类名必须在下面两帧 rAF 之前就生效，
  // 而且 modal / 右键菜单都是 portal 到 body 的，挂在 #root 上盖不住它们
  setContentVisible: (v) => {
    document.documentElement.classList.toggle('app-blank', !v);
    set({ contentVisible: v });
  },

  // 收进托盘（等效点右上角的叉）：窗口 hide() 后 WebView2 停止合成新帧，
  // GPU 缓冲里会一直留着隐藏前的最后一帧。所以先把界面画成空白，
  // 等浏览器实际合成完这一帧再 hide，托盘唤回时就不会闪出旧视图
  hideToTray: () => {
    get().setContentVisible(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        void api.hideWindowToTray();
      });
    });
  },

  // 浮层计数：详情/弹窗/菜单/拖拽开着时 +1，让 App 的全局「Esc=收托盘」让位。
  // 用计数而不是布尔，详情 + 弹窗可以叠加（比如详情里打开 TMDB 选择器）
  escInterceptInc: () => set((s) => ({ escInterceptCount: s.escInterceptCount + 1 })),
  escInterceptDec: () => set((s) => ({ escInterceptCount: Math.max(0, s.escInterceptCount - 1) })),

  loadGames: async () => {
    const { filter } = get();
    const games = Object.keys(filter).length > 0
      ? await api.filterGames(filter)
      : await api.getAllGames();
    set({ games });
  },

  loadSeries: async () => {
    const series = await api.getSeriesLibrary();
    set({ series });
  },

  loadTracks: async () => {
    const tracks = await api.getAllTracks();
    set({ tracks });
  },

  loadPlaylists: async () => {
    const playlists = await api.getPlaylists();
    set({ playlists });
  },

  loadStats: async () => {
    const stats = await api.getStats();
    set({ stats });
  },

  setActiveView: (activeView) => set({ activeView }),
  setMetadataFetching: (metadataFetchingTitle) => set({ metadataFetchingTitle }),
  setFetchPct: (fetchPct) => set({ fetchPct }),
  setFilter: (partial) => set((s) => ({ filter: { ...s.filter, ...partial } })),
  setSelectedGameId: (selectedGameId) => set({ selectedGameId }),
  setSelectedSeriesId: (selectedSeriesId) => set({ selectedSeriesId }),
  setSelectedSeasonId: (selectedSeasonId) => set({ selectedSeasonId }),
  setTheme: (theme) => {
    const dark = window.matchMedia('(prefers-color-scheme: dark)');
    const isDark = theme === 'dark' || (theme === 'system' && dark.matches);
    document.documentElement.classList.toggle('dark', isDark);
    set({ theme });
    // 落库，否则重启回默认的 dark（选了浅色 → 重启变深色）。
    // 失败只影响下次启动的默认值，不打断当前切换
    void api.setSetting('theme', theme).catch(() => {});
    // 再往 localStorage 存一份镜像：index.html 的内联脚本要在 CSS 到达之前就定好
    // 深浅（读数据库是异步的，等它回来早就闪过去了）。数据库仍是权威，这份只是给首帧用
    try { window.localStorage.setItem('zex-theme', theme); } catch { /* 隐私模式等写不进去，无所谓 */ }
  },

  // 列数：立即生效 + 落库（失败只影响下次启动的默认值，不打断当前操作）
  setGameColumns: (n) => {
    const clamped = Math.max(MIN_GAME_COLUMNS, Math.min(MAX_GAME_COLUMNS, Math.round(n)));
    set({ gameColumns: clamped });
    void api.setSetting('game_columns', String(clamped)).catch(() => {});
  },

  // 隐藏库：三个主库最多 2 个（至少保留 1 个可见），统计页不占名额可单独隐藏；
  // 走后端命令（联动 mpv 预加载）
  setLibraryHidden: (id, hidden) => {
    const cur = get().hiddenLibraries;
    if (hidden && id !== 'stats' && cur.filter((x) => x !== 'stats').length >= 2) return;  // 已隐藏 2 个主库，拒绝再隐藏
    const next = hidden
      ? cur.includes(id) ? cur : [...cur, id]
      : cur.filter((x) => x !== id);
    set({ hiddenLibraries: next });
    void api.setHiddenLibraries(next).catch(() => {});
  },

  loadPreferences: async () => {
    // 主题：读回上次的选择（未存过则保持默认 dark）。set 即可，
    // App 里 [theme] 的 effect 会跟着把 .dark 类刷上去
    const th = await api.getSetting('theme').catch(() => null);
    if (th === 'light' || th === 'dark' || th === 'system') {
      set({ theme: th });
      // 同步 localStorage 镜像：换机器/清过缓存时首帧脚本读不到，下次启动就对了
      try { window.localStorage.setItem('zex-theme', th); } catch { /* 忽略 */ }
    }
    const raw = await api.getSetting('game_columns').catch(() => null);
    const n = Number(raw);
    if (Number.isFinite(n) && n >= MIN_GAME_COLUMNS && n <= MAX_GAME_COLUMNS) {
      set({ gameColumns: n });
    }
    // 音乐音量：0-100。先判空再转换 —— getSetting 对未存过的 key 返回 null，
    // Number(null) === 0 恰好通过 0~100 检查，会把首次启动的音量误设成静音
    // （后端 mpv 实际是 70，UI 与听感脱节）；与 theme 的白名单防护同款
    const volRaw = await api.getSetting('music_volume').catch(() => null);
    if (volRaw !== null) {
      const vol = Number(volRaw);
      if (Number.isFinite(vol) && vol >= 0 && vol <= 100) {
        set({ musicVolume: vol });
      }
    }
    // 隐藏库：主库最多 2 个，统计页可单独隐藏（老数据可能超过，顺带收敛）
    const hid = await api.getSetting('hidden_libraries').catch(() => null);
    if (hid) {
      const valid = hid.split(',').filter((x): x is 'games' | 'series' | 'music' | 'stats' =>
        x === 'games' || x === 'series' || x === 'music' || x === 'stats');
      const libs = valid.filter((x) => x !== 'stats').slice(0, 2);
      const statsHidden = valid.includes('stats') ? (['stats'] as const) : ([] as const);
      set({ hiddenLibraries: [...libs, ...statsHidden] });
    }
  },

  createGame: async (game) => {
    const created = await api.createGame(game);
    set((s) => ({ games: [...s.games, created] }));
    return created;
  },

  updateGame: async (id, game) => {
    await api.updateGame(id, game);
    set((s) => ({
      games: s.games.map((g) => (g.id === id ? { ...g, ...game } : g)),
    }));
  },

  deleteGame: async (id) => {
    await api.deleteGame(id);
    set((s) => ({ games: s.games.filter((g) => g.id !== id), selectedGameId: null }));
  },

  // 拖拽排序：先本地重排（与清拖拽同帧渲染，卡片从让位位置直接过渡到最终位置，避免先弹回再落位的闪烁），再持久化
  reorderGames: async (orderedIds) => {
    set((s) => {
      const byId = new Map(s.games.map((g) => [g.id, g]));
      const head = orderedIds.map((id) => byId.get(id)).filter((g): g is Game => Boolean(g));
      const rest = s.games.filter((g) => !orderedIds.includes(g.id)); // 拖拽期间新增的追加末尾
      return { games: [...head, ...rest] };
    });
    try {
      await api.reorderGames(orderedIds);
    } catch {
      await get().loadGames(); // 失败回滚到后端顺序
    }
  },

  launchGame: async (id) => {
    await api.launchGame(id);
    set({ runningGameId: id });
    // 游戏起来了就把窗口让出去，等效点右上角的叉（时长仍由后端线程照常累计）
    get().hideToTray();
  },

  setRunningGameId: (id) => set({ runningGameId: id }),

  createSeries: async (series) => {
    const created = await api.createSeries(series);
    // 统计字段由 get_series_library 提供，新建时先补零，随后的 loadSeries 会带回真实值
    set((s) => ({
      series: [
        ...s.series,
        { ...created, season_count: 0, episode_count: 0, watched_count: 0, local_count: 0, last_watched_at: '', next_episode: null },
      ],
    }));
    return created;
  },

  // 后端要完整 Series 对象：用当前缓存合并补齐（多出来的统计字段 serde 会忽略）
  updateSeries: async (id, patch) => {
    const current = get().series.find((s) => s.id === id);
    if (!current) return;
    await api.updateSeries({ ...current, ...patch });
    set((s) => ({
      series: s.series.map((s2) => (s2.id === id ? { ...s2, ...patch } : s2)),
    }));
  },

  // 拖拽排序：先本地重排（与松手同帧渲染，避免先弹回再落位），再持久化
  reorderSeries: async (orderedIds) => {
    set((s) => {
      const byId = new Map(s.series.map((x) => [x.id, x]));
      const head = orderedIds.map((id) => byId.get(id)).filter((x): x is SeriesCard => Boolean(x));
      const rest = s.series.filter((x) => !orderedIds.includes(x.id)); // 拖拽期间新增的追加末尾
      return { series: [...head, ...rest] };
    });
    try {
      await api.reorderSeries(orderedIds);
    } catch {
      await get().loadSeries(); // 失败回滚到后端顺序
    }
  },

  // 收藏：先本地翻转（点击即时反馈），失败回滚
  toggleSeriesFavorite: async (id) => {
    const current = get().series.find((s) => s.id === id);
    if (!current) return;
    const next = !current.favorite;
    set((s) => ({ series: s.series.map((s2) => (s2.id === id ? { ...s2, favorite: next } : s2)) }));
    try {
      await api.setSeriesFavorite(id, next);
    } catch (err) {
      set((s) => ({ series: s.series.map((s2) => (s2.id === id ? { ...s2, favorite: !next } : s2)) }));
      throw err;
    }
  },

  deleteSeries: async (id) => {
    await api.deleteSeries(id);
    set((s) => ({ series: s.series.filter((s2) => s2.id !== id), selectedSeriesId: null }));
  },

  updateWatchProgress: async (episodeId, watchedMs) => {
    await api.updateWatchProgress(episodeId, watchedMs);
  },

  deleteTrack: async (id) => {
    await api.deleteTrack(id);
    set((s) => ({
      tracks: s.tracks.filter((t) => t.id !== id),
      // 后端 CASCADE 删了歌单关联，这里同步本地歌单的 track_ids
      playlists: s.playlists.map((p) =>
        p.track_ids.includes(id) ? { ...p, track_ids: p.track_ids.filter((tid) => tid !== id) } : p
      ),
    }));
  },

  // 新建歌单：trackIds 可选（右键「新建歌单」把当前曲目一起加进去）
  createPlaylist: async (name, trackIds) => {
    const pl = await api.createPlaylist(name, trackIds);
    set((s) => ({ playlists: [...s.playlists, pl] }));
    return pl;
  },

  // 添加曲目到歌单：先本地合并 track_ids（去重，即时反馈），再落库；失败回滚本地合并
  addTracksToPlaylist: async (playlistId, trackIds) => {
    const prev = get().playlists;
    set((s) => ({
      playlists: s.playlists.map((p) => {
        if (p.id !== playlistId) return p;
        const cur = new Set(p.track_ids);
        const next = [...p.track_ids, ...trackIds.filter((id) => !cur.has(id))];
        return { ...p, track_ids: next };
      }),
    }));
    try {
      const added = await api.addTracksToPlaylist(playlistId, trackIds);
      return added;
    } catch (err) {
      set({ playlists: prev }); // 失败回滚到添加前
      throw err;
    }
  },

  // 删除歌单：级联删除歌单内曲目关联（仅删关联，不动曲目本身）
  deletePlaylist: async (id) => {
    await api.deletePlaylist(id);
    set((s) => ({ playlists: s.playlists.filter((p) => p.id !== id) }));
  },

  // 收藏：先本地翻转（点击即时反馈），失败回滚
  toggleTrackFavorite: async (id) => {
    const current = get().tracks.find((t) => t.id === id);
    if (!current) return;
    const next = !current.favorite;
    set((s) => ({ tracks: s.tracks.map((t) => (t.id === id ? { ...t, favorite: next } : t)) }));
    try {
      await api.setTrackFavorite(id, next);
    } catch (err) {
      set((s) => ({ tracks: s.tracks.map((t) => (t.id === id ? { ...t, favorite: !next } : t)) }));
      throw err;
    }
  },

  // 拖拽排序：先本地重排（与清拖拽同帧渲染，避免先弹回再落位），再持久化
  reorderTracks: async (orderedIds) => {
    set((s) => {
      const byId = new Map(s.tracks.map((t) => [t.id, t]));
      const head = orderedIds.map((id) => byId.get(id)).filter((t): t is Track => Boolean(t));
      const rest = s.tracks.filter((t) => !orderedIds.includes(t.id)); // 拖拽期间新增的追加末尾
      return { tracks: [...head, ...rest] };
    });
    try {
      await api.reorderTracks(orderedIds);
    } catch {
      await get().loadTracks(); // 失败回滚到后端顺序
    }
  },

  // ─── Music Playback ─────────────────────

  playTrack: async (track, queue) => {
    // playMusic 失败（mpv 未响应、切换命令发送失败）时后端会返回错误：
    // 此时 mpv 实际还在放旧曲，绝不能把 nowPlaying 换成新曲 —— 否则之后的
    // music-progress 带的是旧 track_id，被 id 校验挡掉 → 进度条停在 0 再不动。
    // 失败就把异常抛给调用方（MusicView 里冒泡成未处理），界面保持旧曲状态
    await api.playMusic(track.id, queue.map((t) => ({
      track_id: t.id,
      local_path: t.file_path,
      title: t.title,
    })));
    set({
      nowPlaying: {
        trackId: track.id,
        title: track.title,
        artist: track.artist || track.album_artist,
        coverPath: track.cover_path,
        positionMs: 0,
        durationMs: track.duration_seconds * 1000,
        playing: true,
      },
      musicQueue: queue,
      musicSeekTarget: null,
      musicSeekLockUntil: 0,
    });
    // 播放开始 → 按「播放音乐时默认显示歌词」开关尝试自动开词（静默，不打断播放）
    void get().autoShowLyrics();
  },

  updateMusicProgress: (p) => {
    set((s) => {
      if (!s.nowPlaying || p.trackId !== s.nowPlaying.trackId) return s;
      // seek 未结算（progress 还没证明 mpv 落到 seek 目标）时：position 保持 seek 目标，
      // progress 只校准 duration/playing —— 免疫 seek 期间推来的中间/旧位置（弹回的根因）。
      // seek 生效 = progress 位置已接近目标 → 采纳真实位置并解除；超过绝对超时 → 强制采纳兜底
      const target = s.musicSeekTarget;
      let positionMs = p.positionMs;
      let seekTarget = s.musicSeekTarget;
      let seekLockUntil = s.musicSeekLockUntil;
      if (target != null) {
        const reached = Math.abs(p.positionMs - target) < 200;
        const timedOut = Date.now() >= (s.musicSeekLockUntil || 0);
        if (!reached && !timedOut) {
          positionMs = s.nowPlaying.positionMs;
        } else {
          seekTarget = null;
          seekLockUntil = 0;
        }
      }
      return {
        nowPlaying: {
          ...s.nowPlaying,
          positionMs,
          // 防 duration 未加载（progress 的 duration_ms=0）时 input max 变 1 → 进度条闪
          durationMs: p.durationMs > 0 ? p.durationMs : s.nowPlaying.durationMs,
          playing: p.playing ?? s.nowPlaying.playing,
        },
        musicSeekTarget: seekTarget,
        musicSeekLockUntil: seekLockUntil,
      };
    });
  },

  // 换曲：从库中取新曲信息更新播放条（进度由后续 music-progress 覆盖）
  updateMusicTrack: (trackId) => {
    const track = useAppStore.getState().tracks.find((t) => t.id === trackId);
    if (!track) return;
    set((s) => (s.nowPlaying ? {
      nowPlaying: {
        ...s.nowPlaying,
        trackId: track.id,
        title: track.title,
        artist: track.artist || track.album_artist,
        coverPath: track.cover_path,
        positionMs: 0,
        durationMs: track.duration_seconds * 1000,
        playing: true,
      },
      // 换曲会清掉旧 seek 目标，否则新曲 progress 会被旧 target 挡住 3 秒
      musicSeekTarget: null,
      musicSeekLockUntil: 0,
    } : s));
    // 换曲（含队列自动下一首）→ 同样尝试自动开词：无词曲自动隐藏后，下首有词能恢复弹出
    void get().autoShowLyrics();
  },

  // ZEX 重启/刷新后恢复播放条。playing 用后端快照的真实值（后端 MusicSnapshot
  // 专门为暂停状态恢复携带 playing）—— 硬编码 true 会让「暂停中重启」闪 1 秒假播放，
  // 且 mpv 会话异常死亡（mpv-closed 事件错过）时永久显示假播放、无 progress 事件纠正
  restoreMusicNowPlaying: (np) => {
    set({
      nowPlaying: {
        trackId: np.track_id,
        title: np.title,
        artist: np.artist,
        coverPath: np.cover_path,
        positionMs: np.position_ms,
        durationMs: np.duration_ms,
        playing: np.playing,
      },
      musicSeekTarget: null,
      musicSeekLockUntil: 0,
    });
  },

  musicTogglePause: async () => {
    // 本地先翻转（点按即时反馈），后端失败回滚；真实状态由 music-progress 的 playing 持续纠正（以 mpv 为准）
    const prev = get().nowPlaying?.playing;
    const nextPlaying = !prev;
    set((s) => (s.nowPlaying ? { nowPlaying: { ...s.nowPlaying, playing: nextPlaying } } : s));
    try {
      // 直接传目标 pause 值（1=暂停 / 0=继续），比后端从快照反推更可靠
      //（快照可能滞后前端乐观翻转，导致反推出错，点暂停发成"继续"）。
      // ⚠️ 曾写反成 `nextPlaying ? 1 : 0`：点暂停发 0=继续、点播放发 1=暂停，
      // 表现为"图标闪一下又回暂停"。nextPlaying=true 目标"播放"→0，false 目标"暂停"→1
      await api.musicControl('toggle_pause', nextPlaying ? 0 : 1);
    } catch {
      // 后端会话已死（mpv 没了但前端残留）：直接清掉悬空的播放条，别让按钮点了没反应
      if (!get().nowPlaying?.trackId) return;
      const dead = (await api.getMusicNowPlaying().catch(() => null)) === null;
      if (dead) set({ nowPlaying: null, musicQueue: [], musicSeekTarget: null, musicSeekLockUntil: 0 });
      else if (prev !== undefined) {
        set((s) => (s.nowPlaying ? { nowPlaying: { ...s.nowPlaying, playing: prev } } : s));
      }
    }
  },

  musicSeek: async (ms) => {
    // 乐观落位 + 记录 seek 目标：progress 证明 mpv 已落到目标（位置接近）前，position 一律不被覆盖，
    // 免疫 seek 期间 progress 推的中间/旧位置 → 根治「点击后弹回/乱跳」。3s 绝对超时兜底（seek 失败）
    set((s) => {
      if (!s.nowPlaying) return s;
      const dur = s.nowPlaying.durationMs;
      const target = dur > 0 ? Math.min(ms, dur) : ms;
      return {
        nowPlaying: { ...s.nowPlaying, positionMs: target },
        musicSeekTarget: target,
        musicSeekLockUntil: Date.now() + 3000,
      };
    });
    await api.musicControl('seek', ms / 1000);
  },

  musicNext: async () => { await api.musicControl('next', 0); },
  musicPrev: async () => { await api.musicControl('prev', 0); },

  // 音量：拖动时只更新本地（UI 即时），commit 由组件防抖后调用一次 ——
  // 避免拖动的高频 onChange 往 mpv 塞一堆 set_property 造成积压（听感滞后）
  setMusicVolumeLocal: (v) => {
    const clamped = Math.max(0, Math.min(100, Math.round(v)));
    set({ musicVolume: clamped });
  },

  commitMusicVolume: async (v) => {
    const clamped = Math.max(0, Math.min(100, Math.round(v)));
    set({ musicVolume: clamped });
    await api.musicControl('volume', clamped);
    // 持久化防抖：只写最终值（200ms 内多次 commit 只落一次库）
    if (musicVolPersistTimer != null) window.clearTimeout(musicVolPersistTimer);
    musicVolPersistTimer = window.setTimeout(() => {
      musicVolPersistTimer = null;
      void api.setSetting('music_volume', String(clamped)).catch(() => {});
    }, 200);
  },

  toggleMusicShuffle: async () => {
    const next = !get().musicShuffle;
    set({ musicShuffle: next });
    await api.musicControl('shuffle', next ? 1 : 0);
  },

  cycleMusicLoop: async () => {
    const next = ((get().musicLoop + 1) % 3) as 0 | 1 | 2;
    set({ musicLoop: next });
    await api.musicControl('loop', next);
  },

  // 停止：本地立即清（反馈即时），mpv 退出后后端 emit mpv-closed 再清一遍（幂等）。
  // 歌词窗靠 mpv-closed 自关，lyricsOpen 靠 lyrics-visibility-changed 复位，这里只是先乐观清一下
  stopMusic: async () => {
    // lyricsDismissed 同步清：会话结束 = 下一次播放恢复自动显示（不等异步的 mpv-closed）
    set({ nowPlaying: null, musicQueue: [], musicSeekTarget: null, musicSeekLockUntil: 0, lyricsOpen: false, lyricsDismissed: false });
    await api.mpvQuit();
  },

  // 影视接管 / mpv 退出时清音乐播放条（mpv-ready 表示音乐已让位）
  clearMusicPlaying: () => set({ nowPlaying: null, musicQueue: [], musicSeekTarget: null, musicSeekLockUntil: 0, lyricsOpen: false, lyricsDismissed: false }),

  setLyricsOpen: (v) => set({ lyricsOpen: v }),

  // 桌面歌词开关：开窗前先验证当前曲有「带时间轴」的内嵌歌词，没有就不开（用户选定的行为），
  // 返回 false 让播放条弹「该曲无内嵌同步歌词」提示
  toggleDesktopLyrics: async () => {
    if (get().lyricsOpen) {
      // 用户点词按钮关窗 → 手动关闭，本会话内不再自动弹出
      set({ lyricsDismissed: true });
      await api.setDesktopLyricsVisible(false).catch(() => {});
      return true;
    }
    const lines = await currentTimedLyrics();
    if (!lines) return false;
    await api.setDesktopLyricsVisible(true).catch(() => {});
    return true;
  },

  // 播放开始时静默尝试自动开词（设置开 + 未手动关过 + 有带时间轴歌词）。
  // 保留 lyricsOpen 早退：已开窗时换曲由歌词窗自身 loadTrack 接管，
  // 且重复 show(true) 会把拖动后的窗口位置弹回记忆值（后端每次 true 重放位置）
  autoShowLyrics: async () => {
    try {
      if (get().lyricsDismissed) return;
      if (get().lyricsOpen) return;
      const setting = await api.getSetting('lyrics_auto_show').catch(() => null);
      if (setting !== '1') return;               // 默认关：未存过 = null ≠ '1'
      const lines = await currentTimedLyrics();  // 内部已含 nowPlaying 空判
      if (!lines) return;                        // 无词静默跳过：不弹提示、不开窗
      await api.setDesktopLyricsVisible(true).catch(() => {});
    } catch { /* 全部静默：失败只影响本次自动显示，不打断播放 */ }
  },

  // 歌词窗 X 被用户点掉 → 本次播放会话内不再自动弹出（dismissed 为内存态，停止/重启恢复）
  dismissLyricsAutoShow: () => set({ lyricsDismissed: true }),
}));
