// ─────────────────────────────────────────────
// Core Types
// ─────────────────────────────────────────────

export interface Game {
  id: string;
  name: string;
  install_dir: string;
  exe_path: string;
  launch_args: string;
  env_vars: string;
  work_dir: string;
  cover_path: string;
  banner_path: string;
  bg_path: string;
  notes: string;
  tags: string;
  favorite: boolean;
  hidden: boolean;
  total_seconds: number;
  play_count: number;
  created_at: string;
  updated_at: string;
  sort_order?: number;
  steam_appid: number;   // >0 = Steam 导入的游戏（移动时目标路径走 SteamLibrary 结构）
}

export interface GameFilter {
  search?: string;
  favorite?: boolean;
  hidden?: boolean;
  sort_by?: 'name' | 'created_at' | 'updated_at' | 'total_seconds' | 'custom';
  sort_order?: 'asc' | 'desc';
}

export interface SteamGame {
  app_id: number;
  name: string;
  install_dir: string;
  exe_path: string;
  playtime_minutes: number;  // Steam 端累计已玩分钟（0 = 未记录）
  already_imported: boolean; // 该 appid 是否已导入 ZEX 游戏库
}

export interface Series {
  id: string;
  title: string;           // 后端使用 title 而不是 name
  aliases: string;         // 别名（TMDB 原名）
  overview: string;        // 剧情简介（TMDB）
  poster_path: string;     // 海报路径
  bg_path: string;         // 背景大图路径（TMDB backdrop，用于 Hero / 详情页）
  first_air_date: string;  // 首播日期
  status: string;          // 状态：连载中 / 已完结 …
  tmdb_id: number;         // TMDB ID (i64)
  tvdb_id: number;         // TVDB ID (i64)
  tags: string;
  favorite: boolean;
  vote_average: number;    // TMDB 评分 0-10
  genres: string;          // 类型，" / " 分隔
  sort_order?: number;     // 拖拽排序位（1 基，0 = 未排过序排末尾）
  media_type: MediaType;   // 剧集 / 电影（电影 = 单个视频文件）
  total_seconds: number;   // 累计观看时长（mpv 播放时增量累加）
  created_at: string;
  updated_at: string;
}

export type MediaType = 'tv' | 'movie';

// TMDB 搜索候选（同名作品由用户挑选）
export interface TmdbSearchResult {
  id: number;
  name: string;
  original_name: string;
  overview: string;
  date: string;
  poster_url: string;
  vote_average: number;
}

// 「继续观看」指向的下一集（后端按季号+集号取第一条未看）
export interface NextEpisode {
  id: string;
  season_id: string;
  season_number: number;
  episode_number: number;
  title: string;
  still_path: string;
  local_path: string;
  runtime_minutes: number;
  watched_ms: number;
}

// 首页卡片：剧集本体 + 观看统计
export interface SeriesCard extends Series {
  season_count: number;
  episode_count: number;
  watched_count: number;
  local_count: number;      // 有本地视频文件的集数
  last_watched_at: string;
  next_episode: NextEpisode | null;
}

export interface SeasonWithEpisodes extends Season {
  episodes: Episode[];
}

// 详情页一次性拉取的完整数据
export interface SeriesDetailData extends Series {
  seasons: SeasonWithEpisodes[];
  next_episode: NextEpisode | null;
  episode_count: number;
  watched_count: number;
}

export interface Season {
  id: string;
  series_id: string;
  season_number: number;
  name: string;            // 后端使用 name
  overview: string;
  poster_path: string;
  first_air_date: string;
}

export interface Episode {
  id: string;
  series_id: string;
  season_id: string;
  episode_number: number;
  title: string;
  overview: string;
  still_path: string;
  air_date: string;
  runtime_minutes: number;
  local_path: string;
  watched_ms: number;
  last_watched_at: string;
  watched: boolean;
  vote_average: number;    // TMDB 单集评分
}

// 统计页条目（游戏 / 剧集 / 曲目共用一个形状）
export interface TopEntry {
  id: string;
  name: string;
  sub: string;          // 曲目为艺术家，剧集为"已看 X/Y 集"，游戏为空
  cover_path: string;
  wide_path: string;    // 宽幅封面：游戏 banner / 影视 bg，音乐为空
  seconds: number;
  count: number;        // 只统计音乐，游戏/影视恒为 0
}

// 单类媒体（游戏 / 影视 / 音乐）的统计聚合
export interface MediaStats {
  total_seconds: number;
  play_count: number;   // 影视不统计次数，恒为 0
  library_count: number;
  played_count: number; // 有时长记录的条目数
  top: TopEntry[];
}

export interface Stats {
  game: MediaStats;
  video: MediaStats;
  music: MediaStats;
  total_episodes: number;
  total_watched_episodes: number;
}

export type ThemeMode = 'light' | 'dark' | 'system';
export type SortField = 'name' | 'created_at' | 'updated_at' | 'total_seconds';
export type SortOrder = 'asc' | 'desc';

export interface Settings {
  theme: ThemeMode;
  default_sort: SortField;
  default_order: SortOrder;
  steam_library_paths: string[];
}

// 磁盘卷（磁盘管理弹窗）：容量单位字节
export interface DiskVolume {
  drive: string;        // 盘符 "C:"
  mount_point: string;  // "C:\"
  file_system: string;  // "NTFS"
  label: string;        // 卷标
  total: number;
  used: number;
  available: number;
  removable: boolean;
}

// 单个游戏移动结果（磁盘管理「应用」）
export interface GameMoveResult {
  gameId: string;
  name: string;
  ok: boolean;
  error?: string | null;
  // Steam 清单 appmanifest_*.acf 已随文件夹搬到目标库：
  // 提示用户重启 Steam 客户端后即可识别
  steamManifestMoved?: boolean;
}

// 影视磁盘管理：单个本地视频文件
export interface SeriesDiskFile {
  localPath: string;
  rel: string;  // 相对剧根目录的路径
  size: number;
}

// 影视磁盘管理：一部剧的磁盘布局
export interface SeriesDiskEntry {
  seriesId: string;
  title: string;
  posterPath: string;
  mediaType: string;  // tv / movie
  root: string;       // 剧根目录（公共父目录）
  drive: string;      // 归属盘 "D:"
  totalSize: number;
  files: SeriesDiskFile[];
}

// 单个影视移动结果（影视磁盘管理「应用」）
export interface SeriesMoveResult {
  seriesId: string;
  title: string;
  ok: boolean;
  error?: string | null;
}

// ─────────────────────────────────────────────
// Music
// ─────────────────────────────────────────────

// 曲目（标签解析后入库，字段与 Rust Track 对齐）
export interface Track {
  id: string;
  file_path: string;
  title: string;
  artist: string;
  album: string;
  album_artist: string;
  track_number: number;
  disc_number: number;
  duration_seconds: number;
  bitrate: number;
  cover_path: string;
  favorite: boolean;
  play_count: number;
  total_seconds: number;
  created_at: string;
  updated_at: string;
  sort_order: number;
}

// 扫描/手动选择后的解析预览（未入库）
export interface TrackPreview {
  file_path: string;
  title: string;
  artist: string;
  album: string;
  album_artist: string;
  track_number: number;
  disc_number: number;
  duration_seconds: number;
  bitrate: number;
  cover_path: string;
  already_exists: boolean;
}

// 歌单：track_ids 为该歌单内曲目 id（按加入先后），一次拉全量，前端本地过滤
export interface Playlist {
  id: string;
  name: string;
  track_ids: string[];
  created_at: string;
  updated_at: string;
}
