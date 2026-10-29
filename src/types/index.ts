// ─────────────────────────────────────────────
// Core Types
// ─────────────────────────────────────────────

export interface Game {
  archive_status?: '' | 'cleanup_pending' | 'archived';
  archive_path?: string;
  archive_size?: number;
  archive_original_size?: number;
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
  // 绝对格号（0 基）：游戏钉死在库里第 slot 格，拖到哪就永远在哪，前面空着也不往前堆。
  // -1 / 缺省 = 未定位（新添加的游戏）→ 落进第一个空格。与 GameFolder.slot 同一个格号空间
  slot?: number;
  steam_appid: number;   // >0 = Steam 导入的游戏（移动时目标路径走 SteamLibrary 结构）
  rtss_profile_name?: string; // RTSS profile 绑定的真身进程 exe 名；空 = 用 exe_path 文件名
  monitor_process?: string;   // 手动指定的监听进程（计时 + 帧数/RTSS 目标）；空 = 自动识别
}

export interface GameFilter {
  search?: string;
  favorite?: boolean;
  hidden?: boolean;
  sort_by?: 'name' | 'created_at' | 'updated_at' | 'total_seconds' | 'custom';
  sort_order?: 'asc' | 'desc';
}

// 游戏库文件夹：把多个游戏收成顶层的一格。game_ids 为文件夹内成员（已按文件夹内顺序），
// 与 Playlist.track_ids 同款——一次拉全量，前端本地分组（见 utils/libraryCells.ts）。
// 归属是排他的：一个游戏最多在一个文件夹里，进了文件夹就不在顶层单独占格
export interface GameFolder {
  id: string;
  name: string;
  // 绝对格号（0 基）：文件夹钉死在第 slot 格，游戏顺序流动时绕开它。-1 = 未定位（排末尾）
  slot: number;
  color: string;       // 预留：文件夹强调色（空 = 默认青）
  cover_path: string;  // 自定义封面（covers 目录绝对路径，空 = 卡片显示拼图墙）
  created_at: string;
  updated_at: string;
  game_ids: string[];
}

// 游戏库网格里的「一格」：一个游戏，或一个文件夹。
// key 同时用作 React key 与拖拽标识（g:<id> / f:<id>）
export type LibraryCell =
  | { kind: 'game'; key: string; game: Game }
  | { kind: 'folder'; key: string; folder: GameFolder; games: Game[] };

// 布局里的一格：null = 空格（文件夹钉得靠后、游戏填不满时的留白，也是合法落点）
export type LibrarySlot = LibraryCell | null;

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
  media_type?: MediaType; // 混合搜索时命中项的实际类型
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
// 音乐库列表形态：single = 原单列（信息列最全）/ multi = 紧凑多列（一屏曲目数约 3.6 倍）
export type MusicLayout = 'single' | 'multi';
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
  label: string;        // 卷标；网络盘为 UNC 路径（\\NAS\share）
  total: number;
  used: number;
  available: number;
  removable: boolean;
  remote: boolean;      // SMB 等网络映射盘
  unc: string;          // 远程映射盘的 UNC 根（\\server\share）；本地盘为空
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
  // 移动已成功（数据完整落在目标）但源目录被占用未删净，残留需手动清理。有值 → 警告色展示。
  warning?: string | null;
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
  // 同 GameMoveResult.warning：移动成功但源被占用未删净，残留需手动清理。
  warning?: string | null;
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
