import { invoke } from '@tauri-apps/api/core';
import type {
  Game, GameFilter, SteamGame, Series, Season, Episode, Stats,
  SeriesCard, SeriesDetailData, MediaType, TmdbSearchResult, DiskVolume, GameMoveResult,
  SeriesDiskEntry, SeriesMoveResult, Track, TrackPreview, Playlist,
} from '../types';
export type { SteamGame };

// ─── Types ─────────────────────────────────

export interface ScannedEpisode {
  file_path: string;
  file_name: string;
  season_number: number;
  episode_number: number;
}

export interface ScanResult {
  episodes: ScannedEpisode[];
}

// ─── Games ─────────────────────────────────

export async function getAllGames(): Promise<Game[]> {
  return invoke('get_all_games');
}

export async function getGame(id: string): Promise<Game | null> {
  return invoke('get_game', { id });
}

export async function createGame(game: Omit<Game, 'id' | 'created_at' | 'updated_at' | 'total_seconds' | 'steam_appid'>): Promise<Game> {
  // 补全后端需要的字段
  const fullGame = {
    ...game,
    id: '',  // 后端会生成
    created_at: '',  // 后端会生成
    updated_at: '',  // 后端会生成
    total_seconds: 0,
    steam_appid: 0,
  };
  return invoke('create_game', { game: fullGame });
}

export async function updateGame(id: string, game: Partial<Game>): Promise<Game> {
  return invoke('update_game', { id, game });
}

export async function deleteGame(id: string): Promise<void> {
  return invoke('delete_game', { id });
}

export async function reorderGames(orderedIds: string[]): Promise<void> {
  return invoke('reorder_games', { orderedIds });
}

export async function setGameCover(gameId: string, sourcePath: string): Promise<string> {
  return invoke('set_game_cover', { gameId, sourcePath });
}

export interface CoverOption {
  url: string;
  thumb: string;
  width: number;
  height: number;
  style: string;
  author: string;
}

export type CoverKind = 'portrait' | 'wide';

export async function fetchCoverOptions(gameId: string, kind: CoverKind = 'portrait'): Promise<CoverOption[]> {
  return invoke('fetch_cover_options', { gameId, kind });
}

export async function setGameCoverUrl(gameId: string, url: string): Promise<string> {
  return invoke('set_game_cover_url', { gameId, url });
}

export async function setGameBannerUrl(gameId: string, url: string): Promise<string> {
  return invoke('set_game_banner_url', { gameId, url });
}

export interface CoverFetchResult {
  total: number;
  ok: number;
  fail: number;
}

// 为所有缺封面/横幅的 Steam 游戏从 Steam CDN 下载补齐（设置页按钮）
export async function fetchAllSteamCovers(): Promise<CoverFetchResult> {
  return invoke('fetch_all_steam_covers');
}

export async function filterGames(filter: GameFilter): Promise<Game[]> {
  return invoke('filter_games', { filter });
}

// ─── Steam ─────────────────────────────────

export async function scanSteamLibrary(): Promise<SteamGame[]> {
  return invoke('scan_steam_library');
}

export async function importSteamGames(steamGames: SteamGame[]): Promise<Game[]> {
  return invoke('import_steam_games', { steamGames });
}

// ─── Sessions ──────────────────────────────

export async function launchGame(id: string): Promise<void> {
  return invoke('launch_game', { gameId: id });
}

export async function checkGameRunning(id: string): Promise<boolean> {
  return invoke('check_game_running', { gameId: id });
}

// 结算一次游玩：把尾部时长写入 total_seconds。返回本次时长秒数（会话仍存在时有效）
export async function onGameExit(id: string): Promise<number> {
  return invoke('on_game_exit', { gameId: id });
}

export async function openPath(path: string): Promise<void> {
  return invoke('open_path', { path });
}

// ─── Disk Management ─────────────────────────

export async function getDiskVolumes(): Promise<DiskVolume[]> {
  return invoke('get_disk_volumes');
}

export async function getFolderSize(path: string): Promise<number> {
  return invoke('get_folder_size', { path });
}

export interface GameMovePlan {
  gameId: string;
  targetPath: string;
}

// 应用磁盘移动：后端逐个执行（同盘 rename / 跨盘复制+删源），返回每个游戏结果
export async function applyGameMoves(moves: GameMovePlan[]): Promise<GameMoveResult[]> {
  return invoke('apply_game_moves', { moves });
}

// 取消磁盘移动（游戏/影视共用）：复制循环在下一个文件检查点中止，
// 后端自动清理目标残留副本，源目录/文件原样保留（游戏留在原目录）
export async function cancelDiskMove(): Promise<void> {
  return invoke('cancel_disk_move');
}

// Steam 库所在盘符（steam 根 + libraryfolders.vdf 注册的库）：
// 磁盘管理判断目标盘是否在 Steam 库中（不在则 Steam 不识别移动后的游戏）
export async function steamLibraryDrives(): Promise<string[]> {
  return invoke('steam_library_drives');
}

// Steam 库根路径列表（仅仍存在的目录）：
// 磁盘管理移动 Steam 游戏时优先移动到目标盘已有库的 steamapps\common 下
export async function steamLibraryPaths(): Promise<string[]> {
  return invoke('steam_library_paths');
}

// 移动 Steam 游戏后静默重启 Steam 客户端的执行结果
export interface RestartSteamResult {
  ok: boolean;
  error?: string | null;
}

// 静默重启 Steam：安全检查（游戏在跑→拒绝）→ -shutdown 优雅退出 → -silent 托盘启动，
// 让 appmanifest 搬迁立即生效。失败返回具体原因（游戏在跑 / Steam 未退出等），前端提示手动处理
export async function restartSteamForRecognition(): Promise<RestartSteamResult> {
  return invoke('restart_steam_for_recognition');
}

// 从 exe 路径向上探测游戏安装根目录（手动添加时自动填 install_dir）
export async function findGameRoot(exePath: string): Promise<string> {
  return invoke('find_game_root', { exePath });
}

// 在文件夹内递归查找主可执行文件（手动添加时选安装目录后自动定位启动程序）
export async function findMainExe(dir: string, gameName: string): Promise<string> {
  return invoke('find_main_exe', { dir, gameName });
}

// ─── Series Disk Management ─────────────────

// 影视磁盘管理数据：每部有本地文件的剧（剧根/归属盘/文件列表/大小）
export async function getSeriesDiskLayout(): Promise<SeriesDiskEntry[]> {
  return invoke('get_series_disk_layout');
}

export interface SeriesMovePlan {
  seriesId: string;
  targetRoot: string;
}

// 应用影视磁盘移动：后端逐部剧移动本地文件，返回每部剧结果
export async function applySeriesMoves(moves: SeriesMovePlan[]): Promise<SeriesMoveResult[]> {
  return invoke('apply_series_moves', { moves });
}

// 播放视频：走设置里配置的外部播放器（带全屏开关），没配则退回系统默认关联程序
export async function playVideo(path: string): Promise<void> {
  return invoke('play_video', { path });
}

// ─── 播放（内置 mpv） ──────────────────────
// 唯一的播放入口：后端按 player_engine 设置分派到内置 mpv 或外部播放器，
// mpv 没拉取到时也会自动回退，前端不用自己判断
export async function playEpisode(episodeId: string): Promise<void> {
  return invoke('play_episode', { episodeId });
}

// 随包的 mpv 是否就位（设置页据此提示要不要先跑 fetch-mpv.sh）
export async function mpvAvailable(): Promise<boolean> {
  return invoke('mpv_available');
}

// ─── 音乐播放（复用同一 mpv，video=no） ─────

// queue 项字段对齐后端 MusicQueueInput（snake_case）
export interface MusicQueueItem {
  track_id: string;
  local_path: string;
  title: string;
}

// 从某首曲目开始播整份队列（当前排序/筛选后的曲目列表）
export async function playMusic(trackId: string, queue: MusicQueueItem[]): Promise<void> {
  return invoke('play_music', { trackId, queue });
}

// 播放条控制：op ∈ toggle_pause/seek/volume/next/prev/shuffle/loop，value 语义随 op
export async function musicControl(op: string, value: number): Promise<void> {
  return invoke('music_control', { op, value });
}

// 当前音乐播放状态（ZEX 重启/刷新后恢复播放条用）
export interface MusicNowPlaying {
  track_id: string;
  title: string;
  artist: string;
  album: string;
  cover_path: string;
  position_ms: number;
  duration_ms: number;
  playing: boolean;
}
export async function getMusicNowPlaying(): Promise<MusicNowPlaying | null> {
  return invoke('get_music_now_playing');
}

// 停止/退出播放器（音乐停止按钮；mpv 退出后 reader 结算并 emit mpv-closed）
export async function mpvQuit(): Promise<void> {
  return invoke('mpv_quit');
}

// 曲目的内嵌歌词原文（LRC 或纯文本；无内嵌歌词返回 null）
export async function getTrackLyrics(trackId: string): Promise<string | null> {
  return invoke('get_track_lyrics', { trackId });
}

// 桌面歌词窗显隐（后端广播 lyrics-visibility-changed 同步所有窗口的按钮态）
export async function setDesktopLyricsVisible(visible: boolean): Promise<void> {
  return invoke('set_desktop_lyrics_visible', { visible });
}

// 桌面歌词锁定（true=鼠标穿透；解锁走托盘菜单）
export async function setDesktopLyricsLocked(locked: boolean): Promise<void> {
  return invoke('set_desktop_lyrics_locked', { locked });
}

// 收进系统托盘：隐藏窗口并亮出托盘图标（窗口开着时托盘不显示图标）
export async function hideWindowToTray(): Promise<void> {
  return invoke('hide_window_to_tray');
}

export async function scanVideoFolder(folderPath: string): Promise<ScanResult> {
  return invoke('scan_video_folder', { folderPath });
}

// ─── Series ────────────────────────────────

export async function getAllSeries(): Promise<Series[]> {
  return invoke('get_all_series');
}

// 首页用：剧集 + 季数/集数/已看数/下一集（一次查询，前端不再逐剧请求）
export async function getSeriesLibrary(): Promise<SeriesCard[]> {
  return invoke('get_series_library');
}

// 详情页用：剧集 + 全部季 + 全部集
export async function getSeriesDetail(seriesId: string): Promise<SeriesDetailData> {
  return invoke('get_series_detail', { seriesId });
}

export async function createSeries(series: Omit<Series, 'id' | 'created_at' | 'updated_at'>): Promise<Series> {
  return invoke('create_series', { series });
}

// 后端 update_series 接收完整 Series（无独立 id 参数）：只传 Partial 会反序列化失败
export async function updateSeries(series: Series): Promise<Series> {
  return invoke('update_series', { series });
}

// 收藏开关：单列更新，不需要回传整个对象
export async function setSeriesFavorite(seriesId: string, favorite: boolean): Promise<void> {
  return invoke('set_series_favorite', { seriesId, favorite });
}

// 拖拽排序：按可见顺序批量写 sort_order
export async function reorderSeries(orderedIds: string[]): Promise<void> {
  return invoke('reorder_series', { orderedIds });
}

export async function deleteSeries(id: string): Promise<void> {
  return invoke('delete_series', { id });
}

// tmdbId：用户在候选里选定的条目（同名作品消歧）；不传则沿用已有 ID 或自动搜索
export async function autoFetchSeriesMetadata(seriesId: string, tmdbId?: number): Promise<string> {
  return invoke('auto_fetch_series_metadata', { seriesId, tmdbId: tmdbId ?? null });
}

// 搜索 TMDB 候选（mediaType: 'tv' | 'movie'）
export async function searchTmdb(query: string, mediaType: MediaType): Promise<TmdbSearchResult[]> {
  return invoke('search_tmdb', { query, mediaType });
}

export async function getSeasons(seriesId: string): Promise<Season[]> {
  return invoke('get_seasons', { seriesId });
}

export async function createSeason(season: Omit<Season, 'id' | 'created_at' | 'updated_at' | 'total_seconds'>): Promise<Season> {
  return invoke('create_season', { season });
}

export async function updateSeason(id: string, season: Partial<Season>): Promise<Season> {
  return invoke('update_season', { id, season });
}

export async function deleteSeason(id: string): Promise<void> {
  return invoke('delete_season', { id });
}

export async function getEpisodes(seasonId: string): Promise<Episode[]> {
  return invoke('get_episodes', { seasonId });
}

export async function createEpisode(episode: Omit<Episode, 'id' | 'created_at' | 'updated_at'>): Promise<Episode> {
  return invoke('create_episode', { episode });
}

export async function updateEpisode(id: string, episode: Partial<Episode>): Promise<Episode> {
  return invoke('update_episode', { id, episode });
}

export async function deleteEpisode(id: string): Promise<void> {
  return invoke('delete_episode', { id });
}

// 参数名必须与后端命令签名一致（episodeId / watchedMs），否则 invoke 报缺参
export async function updateWatchProgress(episodeId: string, watchedMs: number): Promise<void> {
  return invoke('update_watch_progress', { episodeId, watchedMs });
}

export async function markEpisodeWatched(episodeId: string, watched: boolean): Promise<void> {
  return invoke('mark_episode_watched', { episodeId, watched });
}

export async function markSeasonWatched(seasonId: string, watched: boolean): Promise<void> {
  return invoke('mark_season_watched', { seasonId, watched });
}

// 播放时记录观看时间（用于「继续观看」排序），不改变已看标记
export async function touchEpisodePlayed(episodeId: string): Promise<void> {
  return invoke('touch_episode_played', { episodeId });
}

// ─── Music ──────────────────────────────────

export async function getAllTracks(): Promise<Track[]> {
  return invoke('get_all_tracks');
}

// 扫描文件夹（递归）/ 手动选择的文件 → 解析预览列表（不落库）
export async function scanMusicPaths(paths: string[]): Promise<TrackPreview[]> {
  return invoke('scan_music_paths', { paths });
}

// 批量导入（预览勾选后）：返回新入库的曲目
export async function importMusicTracks(previews: TrackPreview[]): Promise<Track[]> {
  return invoke('import_music_tracks', { previews });
}

export async function deleteTrack(id: string): Promise<void> {
  return invoke('delete_track', { id });
}

// 拖拽排序：按可见顺序批量写 sort_order
export async function reorderTracks(orderedIds: string[]): Promise<void> {
  return invoke('reorder_tracks', { orderedIds });
}

export async function setTrackFavorite(id: string, favorite: boolean): Promise<void> {
  return invoke('set_track_favorite', { id, favorite });
}

// ─── Playlists（歌单） ─────────────────────

// 全部歌单（含每歌单的曲目 id 列表）
export async function getPlaylists(): Promise<Playlist[]> {
  return invoke('get_playlists');
}

// 新建歌单：trackIds 可选（右键「新建歌单」把当前曲目一起加进去），返回新建的歌单
export async function createPlaylist(name: string, trackIds?: string[]): Promise<Playlist> {
  return invoke('create_playlist', { name, trackIds: trackIds ?? null });
}

// 添加曲目到歌单：已存在跳过，返回实际新增数
export async function addTracksToPlaylist(playlistId: string, trackIds: string[]): Promise<number> {
  return invoke('add_tracks_to_playlist', { playlistId, trackIds });
}

// 从歌单移除一首曲目
export async function removeTrackFromPlaylist(playlistId: string, trackId: string): Promise<void> {
  return invoke('remove_track_from_playlist', { playlistId, trackId });
}

export async function renamePlaylist(id: string, name: string): Promise<void> {
  return invoke('rename_playlist', { id, name });
}

export async function deletePlaylist(id: string): Promise<void> {
  return invoke('delete_playlist', { id });
}

// ─── Covers ────────────────────────────────

export async function searchCovers(query: string, type: 'game' | 'series'): Promise<Array<{ url: string; width: number; height: number }>> {
  return invoke('search_covers', { query, coverType: type });
}

export async function downloadCover(url: string, name: string, type: 'cover' | 'banner' | 'bg'): Promise<string> {
  return invoke('download_cover', { url, name, coverType: type });
}

// 自定义品牌封面（设置页「软件标识」）：把本地图片复制进 covers 目录（brand.<ext>），返回存储路径
export async function setBrandCover(source: string): Promise<string> {
  return invoke('set_brand_cover', { source });
}

// ─── Stats ────────────────────────────────

export async function getStats(): Promise<Stats> {
  return invoke('get_stats');
}

// 手动调整游戏累计时长（统计页右键「调整时长」）；秒数由后端钳制为 ≥ 0
export async function setGameSeconds(id: string, seconds: number): Promise<void> {
  return invoke('set_game_seconds', { id, seconds });
}

// ─── Settings ─────────────────────────────

export async function getSetting(key: string): Promise<string | null> {
  return invoke('get_setting', { key });
}

export async function setSetting(key: string, value: string): Promise<void> {
  return invoke('set_setting', { key, value });
}

// 隐藏库（最多 2 个）：写入设置 + 后端联动 mpv 预加载（媒体库全隐藏时停掉空闲预热）
export async function setHiddenLibraries(libs: string[]): Promise<void> {
  return invoke('set_hidden_libraries', { libs });
}

// 西瓜键唤起开关：开=按 Xbox 西瓜键从托盘唤起 ZEX（后端同步注册表关掉 Game Bar 抢键）
// 返回注册表同步是否成功（false = Game Bar 可能仍会抢西瓜键）
export async function setGuideButtonEnabled(enabled: boolean): Promise<boolean> {
  return invoke('set_guide_button_enabled', { enabled });
}

// PS logo 键唤起开关：开=按 DualSense / DualSense Edge 的 PS 键从托盘唤起 ZEX
// （后端 HID 报文直读，无注册表联动，与西瓜键独立）
export async function setPsButtonEnabled(enabled: boolean): Promise<void> {
  return invoke('set_ps_button_enabled', { enabled });
}

// ─── Autostart ─────────────────────────────

// 开机自启当前状态：读注册表为权威（防外部改动/清理/备份恢复后与库不一致）
export async function isAutostartEnabled(): Promise<boolean> {
  return invoke('get_autostart_enabled');
}

// 开机自启开关：enabled=是否自启，show=自启时直接显示主窗口（false=驻留托盘）。
// 后端写库 + 写/删注册表 Run 键；返回注册表同步是否成功
// （false = 设置已保存但自启不会生效，前端提示并回滚 UI）
export async function setAutostart(enabled: boolean, show: boolean): Promise<boolean> {
  return invoke('set_autostart', { enabled, show });
}

// ─── Data Export/Import ───────────────────

export async function exportData(): Promise<string> {
  return invoke('export_data');
}

export async function importData(jsonData: string): Promise<void> {
  return invoke('import_data', { jsonData });
}

export async function clearAllData(): Promise<string> {
  return invoke('clear_all_data');
}
