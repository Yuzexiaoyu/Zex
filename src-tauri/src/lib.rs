use std::borrow::Cow;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use parking_lot::{Mutex, RwLock};
use percent_encoding::percent_decode_str;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sysinfo::System;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, State, http::Response, Emitter};
use thiserror::Error;
use uuid::Uuid;

mod mpv;
mod gamepad;

// ─────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("Image error: {0}")]
    Image(#[from] image::ImageError),
    #[error("App error: {0}")]
    Custom(String),
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where S: serde::Serializer {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

// ─────────────────────────────────────────────
// App State
// ─────────────────────────────────────────────

pub struct AppState {
    // pub(crate)：mpv 模块的 IPC 线程要直接读写库和会话状态
    pub(crate) db: Arc<Mutex<Connection>>,
    running_games: Arc<RwLock<HashMap<String, GameSession>>>,
    pub(crate) data_dir: PathBuf,
    /// 当前 mpv 播放会话（没在播放时为 None）
    pub(crate) mpv: mpv::MpvHandle,
    /// 空闲预热 mpv（点播放复用它，免去冷启动）
    pub(crate) warm: Arc<mpv::WarmSlot>,
    /// 手柄导航开关：true=ZEX 前台可导航；false=收托盘/播放中（gilrs 线程不推导航事件，
    /// mpv 内建 --input-gamepad 接管播放中的手柄控制）
    pub(crate) gamepad_nav: Arc<AtomicBool>,
    /// 西瓜键唤起开关：true=按 Guide 唤起主窗口（需先关掉 Game Bar 抢键）；
    /// false=让位 Game Bar。由设置项 guide_button_enabled 驱动，启动时从库初始化、切换时即时生效
    pub(crate) guide_enabled: Arc<AtomicBool>,
    /// 与 guide_enabled 同步的门闩：关闭时让 XInput 轮询线程真正阻塞（零 CPU），
    /// 而不是空转采样再丢弃。两者必须一起改 —— set_guide_button_enabled 里成对更新
    pub(crate) guide_gate: Arc<gamepad::EnableGate>,
    /// PS logo 键唤起开关：true=按 DualSense 的 PS 键唤起主窗口（HID 报文直读，
    /// 不涉及 Game Bar 注册表）。由设置项 ps_button_enabled 驱动，与西瓜键独立
    pub(crate) ps_guide_enabled: Arc<AtomicBool>,
    /// 元数据抓取全局锁：同一时刻只允许一个 TMDB 获取在跑（前端切库后
    /// 组件状态丢失，防重入必须落在后端；guard 析构自动释放）
    pub(crate) metadata_fetching: Arc<AtomicBool>,
    /// 磁盘移动取消标志：apply_game_moves / apply_series_moves 开始时复位，
    /// 前端「取消移动」置位；复制循环每复制完一个文件检查一次，置位即中止
    /// （走失败清理路径：删除目标残留副本，源目录/文件原样保留）
    pub(crate) move_cancel: Arc<AtomicBool>,
}

#[derive(Clone)]
pub struct GameSession {
    pub game_id: String,
    pub process_id: u32,
    pub start_time: DateTime<Utc>,   // 累计锚点（实时累加时动态前移）
    pub launch_start: DateTime<Utc>, // 会话真实开始时间（写会话记录用）
    pub exe_path: String,
    pub install_dir: String,
    pub process_seen: bool,
    pub miss_count: u32,
    pub no_window_polls: u32, // 进程在但无可见窗口的连续轮询数
    pub accumulated: i64,     // 本会话已累计的秒数（实时增量写入 total_seconds 的总和）
}

// ─────────────────────────────────────────────
// Database Helpers
// ─────────────────────────────────────────────

fn get_data_dir() -> PathBuf {
    // 优先使用 exe 所在目录的 data/ 文件夹（便携模式）
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(data_dir) = exe_path.parent() {
            let portable = data_dir.join("data");
            if portable.exists() || fs::create_dir_all(&portable).is_ok() {
                return portable;
            }
        }
    }
    // 回退到 AppData
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ZEX")
}

fn init_database(db_path: &PathBuf) -> AppResult<Connection> {
    let conn = Connection::open(db_path)?;

    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA foreign_keys=ON;
         PRAGMA busy_timeout=5000;

         -- 游戏表
         CREATE TABLE IF NOT EXISTS games (
             id TEXT PRIMARY KEY,
             name TEXT NOT NULL,
             install_dir TEXT DEFAULT '',
             exe_path TEXT DEFAULT '',
             launch_args TEXT DEFAULT '',
             env_vars TEXT DEFAULT '{}',
             work_dir TEXT DEFAULT '',
             cover_path TEXT DEFAULT '',
             banner_path TEXT DEFAULT '',
             bg_path TEXT DEFAULT '',
             notes TEXT DEFAULT '',
             tags TEXT DEFAULT '[]',
             favorite INTEGER DEFAULT 0,
             hidden INTEGER DEFAULT 0,
             total_seconds INTEGER DEFAULT 0,
             play_count INTEGER DEFAULT 0,
             created_at TEXT DEFAULT (datetime('now')),
             updated_at TEXT DEFAULT (datetime('now'))
         );

         -- 剧集表
         CREATE TABLE IF NOT EXISTS series (
             id TEXT PRIMARY KEY,
             title TEXT NOT NULL,
             aliases TEXT DEFAULT '',
             overview TEXT DEFAULT '',
             poster_path TEXT DEFAULT '',
             bg_path TEXT DEFAULT '',
             first_air_date TEXT DEFAULT '',
             status TEXT DEFAULT 'airing',
             tmdb_id INTEGER DEFAULT 0,
             tvdb_id INTEGER DEFAULT 0,
             tags TEXT DEFAULT '[]',
             favorite INTEGER DEFAULT 0,
             created_at TEXT DEFAULT (datetime('now')),
             updated_at TEXT DEFAULT (datetime('now'))
         );

         -- 季表
         CREATE TABLE IF NOT EXISTS seasons (
             id TEXT PRIMARY KEY,
             series_id TEXT NOT NULL,
             season_number INTEGER NOT NULL,
             name TEXT DEFAULT '',
             overview TEXT DEFAULT '',
             poster_path TEXT DEFAULT '',
             first_air_date TEXT DEFAULT '',
             FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
         );

         -- 集表
         CREATE TABLE IF NOT EXISTS episodes (
             id TEXT PRIMARY KEY,
             series_id TEXT NOT NULL,
             season_id TEXT NOT NULL,
             episode_number INTEGER NOT NULL,
             title TEXT DEFAULT '',
             overview TEXT DEFAULT '',
             still_path TEXT DEFAULT '',
             air_date TEXT DEFAULT '',
             runtime_minutes INTEGER DEFAULT 0,
             local_path TEXT DEFAULT '',
             watched_ms INTEGER DEFAULT 0,
             last_watched_at TEXT DEFAULT '',
             watched INTEGER DEFAULT 0,
             FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE,
             FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE
         );

         -- 设置表
         CREATE TABLE IF NOT EXISTS settings (
             key TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );

         -- 索引
         CREATE INDEX IF NOT EXISTS idx_games_name ON games(name);
         DROP INDEX IF EXISTS idx_games_platform;
         CREATE INDEX IF NOT EXISTS idx_games_favorite ON games(favorite);
         CREATE INDEX IF NOT EXISTS idx_games_hidden ON games(hidden);
         CREATE INDEX IF NOT EXISTS idx_seasons_series_id ON seasons(series_id);
         CREATE INDEX IF NOT EXISTS idx_episodes_season_id ON episodes(season_id);
         -- 按剧查集：换集、进度统计、继续观看都走 WHERE series_id，只有 season_id
         -- 索引时这些查询要全表扫 episodes（数百行起）
         CREATE INDEX IF NOT EXISTS idx_episodes_series_id ON episodes(series_id);

         -- 音乐曲目表
         CREATE TABLE IF NOT EXISTS tracks (
             id TEXT PRIMARY KEY,
             file_path TEXT NOT NULL UNIQUE,
             title TEXT NOT NULL,
             artist TEXT DEFAULT '',
             album TEXT DEFAULT '',
             album_artist TEXT DEFAULT '',
             track_number INTEGER DEFAULT 0,
             disc_number INTEGER DEFAULT 0,
             duration_seconds INTEGER DEFAULT 0,
             bitrate INTEGER DEFAULT 0,
             cover_path TEXT DEFAULT '',
             favorite INTEGER DEFAULT 0,
             play_count INTEGER DEFAULT 0,
             total_seconds INTEGER DEFAULT 0,
             created_at TEXT DEFAULT (datetime('now')),
             updated_at TEXT DEFAULT (datetime('now'))
         );
         CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album);
         CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);

         -- 歌单表：音乐库按歌单聚合（新库建表；老库由下方迁移补建）
         CREATE TABLE IF NOT EXISTS playlists (
             id TEXT PRIMARY KEY,
             name TEXT NOT NULL,
             created_at TEXT DEFAULT (datetime('now')),
             updated_at TEXT DEFAULT (datetime('now'))
         );
         -- 歌单曲目关联：PRIMARY KEY 天然去重（同一首曲目在一个歌单里只有一份）
         CREATE TABLE IF NOT EXISTS playlist_tracks (
             playlist_id TEXT NOT NULL,
             track_id TEXT NOT NULL,
             sort_order INTEGER DEFAULT 0,
             added_at TEXT DEFAULT (datetime('now')),
             PRIMARY KEY (playlist_id, track_id),
             FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
             FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id);
         CREATE INDEX IF NOT EXISTS idx_playlist_tracks_track ON playlist_tracks(track_id);
        "
    )?;

    // 老库补建歌单表（新库已建则报错忽略；保持与上方 CREATE TABLE 同步）
    let _ = conn.execute(
        "CREATE TABLE IF NOT EXISTS playlists (
             id TEXT PRIMARY KEY,
             name TEXT NOT NULL,
             created_at TEXT DEFAULT (datetime('now')),
             updated_at TEXT DEFAULT (datetime('now'))
         )",
        [],
    );
    let _ = conn.execute(
        "CREATE TABLE IF NOT EXISTS playlist_tracks (
             playlist_id TEXT NOT NULL,
             track_id TEXT NOT NULL,
             sort_order INTEGER DEFAULT 0,
             added_at TEXT DEFAULT (datetime('now')),
             PRIMARY KEY (playlist_id, track_id),
             FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
             FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
         )",
        [],
    );

    // 游戏统一为 PC 平台：旧数据库移除 platform 列（新库无此列，报错忽略）
    let _ = conn.execute("ALTER TABLE games DROP COLUMN platform", []);

    // 音乐比特率列（新库已建；老库补列，已存在时静默跳过）。
    // 存量曲目 bitrate=0（前端不显示），重扫/重新导入后由 parse_audio_tags 填实际值
    let _ = conn.execute("ALTER TABLE tracks ADD COLUMN bitrate INTEGER DEFAULT 0", []);

    // 自定义排序：首次添加列时按名称序播种（新库/老库统一走这条路径；已存在时静默跳过）
    // 注意用 1 基（sort_order=0 专门表示"未参与过排序"→ 排末尾），否则位置 0 会被 CASE 误判
    if conn.execute("ALTER TABLE games ADD COLUMN sort_order INTEGER DEFAULT 0", []).is_ok() {
        let _ = conn.execute(
            "UPDATE games SET sort_order = (
                SELECT COUNT(*) FROM games g2
                WHERE g2.name < games.name OR (g2.name = games.name AND g2.rowid < games.rowid)
            ) + 1",
            [],
        );
    }

    // Steam AppID 独立列：旧版把 appid 写进 notes（"Steam AppID: xxx"），用户不想要自动备注。
    // 迁移：提取回填到 steam_appid 列，清空 notes（后续改由 steam_appid 列承载 appid）
    if conn.execute("ALTER TABLE games ADD COLUMN steam_appid INTEGER DEFAULT 0", []).is_ok() {
        let _ = conn.execute(
            "UPDATE games SET steam_appid = CAST(REPLACE(notes, 'Steam AppID: ', '') AS INTEGER),
                              notes = '' WHERE notes LIKE 'Steam AppID: %'",
            [],
        );
    }

    // 影视元数据扩展列：TMDB 除图片外还带回评分/类型/集评分，老库补列（新库已建则报错忽略）
    let _ = conn.execute("ALTER TABLE series ADD COLUMN vote_average REAL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE series ADD COLUMN genres TEXT DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE episodes ADD COLUMN vote_average REAL DEFAULT 0", []);

    // 媒体类型：tv（剧集）/ movie（电影）。电影用单文件添加，TMDB 走 /search/movie
    let _ = conn.execute("ALTER TABLE series ADD COLUMN media_type TEXT DEFAULT 'tv'", []);

    // 影视自定义排序：与游戏库同款（1 基；0 表示未参与过排序 → 排末尾），首次建列按标题播种
    if conn.execute("ALTER TABLE series ADD COLUMN sort_order INTEGER DEFAULT 0", []).is_ok() {
        let _ = conn.execute(
            "UPDATE series SET sort_order = (
                SELECT COUNT(*) FROM series s2
                WHERE s2.title < series.title OR (s2.title = series.title AND s2.rowid < series.rowid)
            ) + 1",
            [],
        );
    }

    // 音乐自定义排序：与游戏/影视同款（1 基；0 表示未参与过排序 → 排末尾），首次建列按歌名播种
    if conn.execute("ALTER TABLE tracks ADD COLUMN sort_order INTEGER DEFAULT 0", []).is_ok() {
        let _ = conn.execute(
            "UPDATE tracks SET sort_order = (
                SELECT COUNT(*) FROM tracks t2
                WHERE t2.title < tracks.title OR (t2.title = tracks.title AND t2.rowid < tracks.rowid)
            ) + 1",
            [],
        );
    }

    // 剧集累计观看时长：和 games.total_seconds 同构，由观看会话结算时累加
    let _ = conn.execute("ALTER TABLE series ADD COLUMN total_seconds INTEGER DEFAULT 0", []);

    // 会话表下线：统计只保留时长与次数，不再记录「什么时候玩的」。
    // 时长本身写在实体行（games/series/tracks 的 total_seconds）上，与会话表无关，删表不丢时长。
    // 音乐次数改由 tracks.play_count 承载（见 mpv.rs open_music_session），按用户要求从 0 起算
    let _ = conn.execute("DROP TABLE IF EXISTS game_sessions", []);
    let _ = conn.execute("DROP TABLE IF EXISTS series_sessions", []);
    let _ = conn.execute("DROP TABLE IF EXISTS music_sessions", []);

    // 存量曲目比特率回填：只处理 bitrate=0 且有时长的（新导入会填，这里兜底存量），
    // 用文件大小算平均码率 —— 避免库里已有的歌永远显示不出比特率
    {
        let rows = {
            let mut stmt = conn.prepare(
                "SELECT file_path, duration_seconds FROM tracks WHERE bitrate <= 0 AND duration_seconds > 0",
            )?;
            let it = stmt.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i32>(1)?))
            })?;
            it.filter_map(Result::ok).collect::<Vec<_>>()
        };
        for (fp, dur) in rows {
            let size = std::fs::metadata(&fp).map(|m| m.len()).unwrap_or(0);
            if size > 0 {
                let bitrate = ((size * 8) / (dur as u64 * 1000)) as i32;
                let _ = conn.execute(
                    "UPDATE tracks SET bitrate = ?1 WHERE file_path = ?2 AND bitrate <= 0",
                    params![bitrate, fp],
                );
            }
        }
    }

    Ok(conn)
}

// ─────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Game {
    pub id: String,
    pub name: String,
    pub install_dir: String,
    pub exe_path: String,
    pub launch_args: String,
    pub env_vars: String,
    pub work_dir: String,
    pub cover_path: String,
    pub banner_path: String,
    pub bg_path: String,
    pub notes: String,
    pub tags: String,
    pub favorite: bool,
    pub hidden: bool,
    #[serde(default)]
    pub total_seconds: i64,
    #[serde(default)]
    pub play_count: i64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub sort_order: i64,
    // Steam 导入标记：>0 表示来自 Steam（移动游戏时目标路径走 SteamLibrary 结构）
    #[serde(default)]
    pub steam_appid: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SteamGame {
    pub name: String,
    pub app_id: u64,
    pub install_dir: String,
    pub exe_path: String,
    /// Steam 端累计已玩分钟（localconfig.vdf 的 Playtime，多账户求和）；
    /// 0 = 未玩过 / 读不到
    pub playtime_minutes: i64,
    /// 该 appid 是否已导入 ZEX 游戏库（scan 时查 games 表回填；前端据此置底/灰标/不勾选）
    #[serde(default)]
    pub already_imported: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Series {
    pub id: String,
    pub title: String,
    pub aliases: String,
    pub overview: String,
    pub poster_path: String,
    pub bg_path: String,
    pub first_air_date: String,
    pub status: String,
    pub tmdb_id: i64,
    pub tvdb_id: i64,
    pub tags: String,
    pub favorite: bool,
    // TMDB 元数据：评分（0-10）与类型（顿号分隔）。前端创建时不传 → serde 默认值
    #[serde(default)]
    pub vote_average: f64,
    #[serde(default)]
    pub genres: String,
    // 拖拽排序位（1 基，0 = 未参与过排序，排在末尾）
    #[serde(default)]
    pub sort_order: i64,
    // "tv" 剧集 / "movie" 电影（单个视频文件）
    #[serde(default = "default_media_type")]
    pub media_type: String,
    // 累计观看时长，由 mpv 播放时增量累加；与 games.total_seconds 同构
    #[serde(default)]
    pub total_seconds: i64,
    pub created_at: String,
    pub updated_at: String,
}

fn default_media_type() -> String {
    "tv".to_string()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Season {
    pub id: String,
    pub series_id: String,
    pub season_number: i32,
    pub name: String,
    pub overview: String,
    pub poster_path: String,
    pub first_air_date: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Episode {
    pub id: String,
    pub series_id: String,
    pub season_id: String,
    pub episode_number: i32,
    pub title: String,
    pub overview: String,
    pub still_path: String,
    pub air_date: String,
    pub runtime_minutes: i32,
    pub local_path: String,
    pub watched_ms: i64,
    pub last_watched_at: String,
    pub watched: bool,
    #[serde(default)]
    pub vote_average: f64,
}

// 影视三张表的列清单与行映射集中在此：新增列只需改这里，避免 SELECT 顺序与 row.get(n) 错位
const SERIES_COLS: &str = "id, title, aliases, overview, poster_path, bg_path, first_air_date, \
                           status, tmdb_id, tvdb_id, tags, favorite, vote_average, genres, \
                           sort_order, media_type, created_at, updated_at, total_seconds";

// 自定义顺序：sort_order = 0（从未拖动过）排末尾，其余按位次；同位次时按标题稳定排序
const SERIES_ORDER: &str = "ORDER BY CASE WHEN sort_order = 0 THEN 1 ELSE 0 END, sort_order, title";

fn row_to_series(row: &rusqlite::Row) -> rusqlite::Result<Series> {
    Ok(Series {
        id: row.get(0)?,
        title: row.get(1)?,
        aliases: row.get(2)?,
        overview: row.get(3)?,
        poster_path: row.get(4)?,
        bg_path: row.get(5)?,
        first_air_date: row.get(6)?,
        status: row.get(7)?,
        tmdb_id: row.get(8)?,
        tvdb_id: row.get(9)?,
        tags: row.get(10)?,
        favorite: row.get::<_, i32>(11)? != 0,
        vote_average: row.get::<_, Option<f64>>(12)?.unwrap_or(0.0),
        genres: row.get::<_, Option<String>>(13)?.unwrap_or_default(),
        sort_order: row.get::<_, Option<i64>>(14)?.unwrap_or(0),
        media_type: row
            .get::<_, Option<String>>(15)?
            .filter(|s| !s.is_empty())
            .unwrap_or_else(default_media_type),
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
        total_seconds: row.get::<_, Option<i64>>(18)?.unwrap_or(0),
    })
}

const SEASON_COLS: &str = "id, series_id, season_number, name, overview, poster_path, first_air_date";

fn row_to_season(row: &rusqlite::Row) -> rusqlite::Result<Season> {
    Ok(Season {
        id: row.get(0)?,
        series_id: row.get(1)?,
        season_number: row.get(2)?,
        name: row.get(3)?,
        overview: row.get(4)?,
        poster_path: row.get(5)?,
        first_air_date: row.get(6)?,
    })
}

const EPISODE_COLS: &str = "id, series_id, season_id, episode_number, title, overview, still_path, \
                            air_date, runtime_minutes, local_path, watched_ms, last_watched_at, \
                            watched, vote_average";

fn row_to_episode(row: &rusqlite::Row) -> rusqlite::Result<Episode> {
    Ok(Episode {
        id: row.get(0)?,
        series_id: row.get(1)?,
        season_id: row.get(2)?,
        episode_number: row.get(3)?,
        title: row.get(4)?,
        overview: row.get(5)?,
        still_path: row.get(6)?,
        air_date: row.get(7)?,
        runtime_minutes: row.get(8)?,
        local_path: row.get(9)?,
        watched_ms: row.get(10)?,
        last_watched_at: row.get(11)?,
        watched: row.get::<_, i32>(12)? != 0,
        vote_average: row.get::<_, Option<f64>>(13)?.unwrap_or(0.0),
    })
}

// ─────────────────────────────────────────────
// Music (tracks)
// ─────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Track {
    pub id: String,
    pub file_path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub track_number: i32,
    pub disc_number: i32,
    pub duration_seconds: i32,
    pub bitrate: i32,
    pub cover_path: String,
    pub favorite: bool,
    pub play_count: i64,
    pub total_seconds: i64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub sort_order: i64,
}

// 扫描/手动选择后的解析预览（未入库）。already_exists 由 scan 阶段查库填充，前端可勾选跳过
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TrackPreview {
    pub file_path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub track_number: i32,
    pub disc_number: i32,
    pub duration_seconds: i32,
    pub bitrate: i32,
    pub cover_path: String,
    pub already_exists: bool,
}

const TRACK_COLS: &str = "id, file_path, title, artist, album, album_artist, track_number, \
                          disc_number, duration_seconds, bitrate, cover_path, favorite, play_count, \
                          total_seconds, created_at, updated_at, sort_order";

fn row_to_track(row: &rusqlite::Row) -> rusqlite::Result<Track> {
    Ok(Track {
        id: row.get(0)?,
        file_path: row.get(1)?,
        title: row.get(2)?,
        artist: row.get(3)?,
        album: row.get(4)?,
        album_artist: row.get(5)?,
        track_number: row.get(6)?,
        disc_number: row.get(7)?,
        duration_seconds: row.get(8)?,
        bitrate: row.get::<_, i32>(9)?,
        cover_path: row.get(10)?,
        favorite: row.get::<_, i32>(11)? != 0,
        play_count: row.get::<_, Option<i64>>(12)?.unwrap_or(0),
        total_seconds: row.get::<_, Option<i64>>(13)?.unwrap_or(0),
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        sort_order: row.get::<_, Option<i64>>(16)?.unwrap_or(0),
    })
}

// 歌单：track_ids 为该歌单内曲目 id（按加入先后排序），一次拉全量，前端本地过滤
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub track_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// 统计页条目（游戏 / 剧集 / 曲目共用一个形状）
#[derive(Debug, Serialize, Deserialize)]
pub struct TopEntry {
    pub id: String,
    pub name: String,
    /// 副标题：曲目为艺术家，剧集为「已看 X/Y 集」，游戏留空
    pub sub: String,
    pub cover_path: String,
    /// 宽幅封面：游戏取 banner_path，剧集取 bg_path，音乐留空（用方形 cover_path）
    pub wide_path: String,
    pub seconds: i64,
    /// 播放次数。只统计音乐（tracks.play_count），游戏/影视恒为 0
    pub count: i64,
}

/// 单类媒体（游戏 / 影视 / 音乐）的统计聚合
#[derive(Debug, Serialize, Deserialize)]
pub struct MediaStats {
    pub total_seconds: i64,
    /// 总次数。只统计音乐（tracks.play_count 之和），游戏/影视恒为 0
    pub play_count: i64,
    /// 库存量：游戏数 / 剧集数 / 曲目数
    pub library_count: i64,
    /// 有时长记录的条目数
    pub played_count: i64,
    pub top: Vec<TopEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Stats {
    pub game: MediaStats,
    pub video: MediaStats,
    pub music: MediaStats,
    pub total_episodes: i64,
    pub total_watched_episodes: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GameFilter {
    pub tags: Option<Vec<String>>,
    pub min_seconds: Option<i64>,
    pub first_year: Option<i32>,
    pub favorite: Option<bool>,
    pub hidden: Option<bool>,
    pub search: Option<String>,
    pub sort_by: Option<String>,
    pub sort_order: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CoverSearchResult {
    pub url: String,
    pub thumbnail_url: String,
    pub source: String,
    pub width: i32,
    pub height: i32,
}

// 更换封面弹窗里的候选封面（SteamGridDB 600×900 竖版 / 1920×620 横版）
#[derive(Debug, Serialize)]
pub struct CoverOption {
    pub url: String,
    pub thumb: String,
    pub width: i32,
    pub height: i32,
    pub style: String,
    pub author: String,
}

#[derive(Deserialize)]
struct SgdbAuthor {
    name: String,
}

// ─────────────────────────────────────────────
// Tauri Commands - Disk Management
// ─────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct DiskVolume {
    pub drive: String,        // 盘符 "C:"
    pub mount_point: String,  // "C:\\"
    pub file_system: String,  // "NTFS"
    pub label: String,        // 卷标（系统分区常为空）
    pub total: u64,
    pub used: u64,
    pub available: u64,
    pub removable: bool,
}

// 列出所有本地磁盘卷：容量 / 已用 / 可用 / 文件系统 / 是否可移动。
// 用于磁盘管理弹窗的卷卡片（容量条 + 游戏归属）。
// 注意：sysinfo 在 Windows 上 name() 返回的是卷标（GetVolumeInformationW 的 lpVolumeNameBuffer），
// 盘符在 mount_point() 里（"D:\"）——盘符必须从挂载点提取，不能拿 name() 当盘符
#[tauri::command(async)]
fn get_disk_volumes() -> AppResult<Vec<DiskVolume>> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let mut out: Vec<DiskVolume> = disks
        .iter()
        // 跳过总容量为 0 的卷（光驱无盘等没有意义的挂载点）
        .filter(|d| d.total_space() > 0)
        .map(|d| {
            let mount_point = d.mount_point().to_string_lossy().to_string();
            // 盘符：挂载点 "D:\" → "D:"；挂载到文件夹的卷用完整路径标识（不带尾斜杠）
            let drive = mount_point
                .chars()
                .find(|c| c.is_ascii_alphabetic())
                .map(|c| format!("{}:", c.to_ascii_uppercase()))
                .unwrap_or_else(|| mount_point.trim_end_matches('\\').to_string());
            // 卷标：sysinfo 的 name()；与盘符一致（个别情况）或为空 → 当作无卷标
            let raw_label = d.name().to_string_lossy().to_string();
            let label = if raw_label.is_empty() || raw_label.eq_ignore_ascii_case(&drive) {
                String::new()
            } else {
                raw_label
            };
            DiskVolume {
                drive,
                mount_point,
                file_system: d.file_system().to_string_lossy().to_string(),
                label,
                total: d.total_space(),
                used: d.total_space().saturating_sub(d.available_space()),
                available: d.available_space(),
                removable: d.is_removable(),
            }
        })
        .collect();
    out.sort_by_key(|v| v.drive.clone());
    // 同一物理卷挂到多个路径会重复列出，按盘符去重（保留第一个）
    out.dedup_by(|a, b| a.drive == b.drive);
    Ok(out)
}

// 递归计算目录占用字节数（跳过无法读取的项）；文件直接返回自身大小。
// spawn_blocking 后台执行，避免大目录递归阻塞其他命令
/// 统计目录大小（跳过符号链接，与复制范围一致），返回 (总字节, 符号链接数)。
/// symlink_count 供移动前检测：源目录含 junction/软链时拒绝移动（复制会跳过它们，
/// 但校验不计数 → 校验"通过" → 删源 → 链接指向的数据永久丢失）
fn compute_folder_size(path: PathBuf) -> (u64, usize) {
    if !path.exists() {
        return (0, 0);
    }
    if path.is_file() {
        return (path.metadata().map(|m| m.len()).unwrap_or(0), 0);
    }
    let mut total = 0u64;
    let mut symlinks = 0usize;
    let mut stack = vec![path];
    let mut visited = std::collections::HashSet::new();
    while let Some(dir) = stack.pop() {
        if !visited.insert(dir.clone()) {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            // symlink_metadata + 跳过符号链接：与 copy_dir_with_progress 的复制范围一致。
            // 旧版用 entry.metadata()（跟随 junction），会把链接指向的外部目录计入大小，
            // 空间校验分母虚增（可能误报空间不足）
            let Ok(meta) = fs::symlink_metadata(&entry.path()) else { continue };
            if meta.file_type().is_symlink() {
                symlinks += 1;
                continue;
            }
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total = total.saturating_add(meta.len());
            }
        }
    }
    (total, symlinks)
}

#[tauri::command]
async fn get_folder_size(path: String) -> AppResult<u64> {
    tauri::async_runtime::spawn_blocking(move || compute_folder_size(PathBuf::from(&path)).0)
        .await
        .map_err(|e| AppError::Custom(format!("计算目录大小失败: {}", e)))
}

// ─────────────────────────────────────────────
// Tauri Commands - Apply Disk Moves
// ─────────────────────────────────────────────

// 单个游戏的迁移方案（前端按 Steam / 普通游戏规则算好目标完整路径）。
// camelCase：Tauri 顶层参数名自动转，但嵌套结构体需显式声明才能接受 gameId/targetPath
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameMovePlan {
    pub game_id: String,
    pub target_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameMoveResult {
    pub game_id: String,
    pub name: String,
    pub ok: bool,
    pub error: Option<String>,
    // Steam 游戏清单 appmanifest_*.acf 已随文件夹搬到目标库：
    // 前端据此提示「重启 Steam 客户端后即可识别」（Steam 运行时不会实时扫描库）
    pub steam_manifest_moved: bool,
}

// 复制进度事件载荷（每复制完一个文件 emit 一次）
#[derive(Clone, Serialize)]
struct DiskMoveProgress {
    game_id: String,
    name: String,
    done: u64,
    total: u64,
}

// 取消磁盘移动：置位 move_cancel，复制循环在下一个文件检查点中止并走失败清理
//（删除目标残留副本，源目录/文件原样保留）。前端「取消移动」按钮调用；
// apply_game_moves / apply_series_moves 开始时自动复位
#[tauri::command]
fn cancel_disk_move(state: State<'_, AppState>) {
    state.move_cancel.store(true, Ordering::Relaxed);
}

/// Steam 库所在盘符（steam 根 + libraryfolders.vdf 注册的库路径的盘符）：
/// 磁盘管理移动 Steam 游戏前，前端用它判断目标盘是否在 Steam 库中 ——
/// 不在则移动后 Steam 客户端不识别该游戏，提前警告用户（M7）
#[tauri::command]
fn steam_library_drives() -> Vec<String> {
    let Ok(steam_root) = detect_steam_path() else { return Vec::new() };
    let root_path = PathBuf::from(steam_root);
    let mut drives = std::collections::BTreeSet::new();
    if let Some(d) = drive_of_path_str(&root_path.to_string_lossy()) {
        drives.insert(d);
    }
    for lib in steam_library_dirs(&root_path) {
        if let Some(d) = drive_of_path_str(&lib.to_string_lossy()) {
            drives.insert(d);
        }
    }
    drives.into_iter().collect()
}

/// Steam 库根路径列表（steam 根 + libraryfolders.vdf 注册的库，仅保留仍存在的目录）：
/// 磁盘管理移动 Steam 游戏时，目标盘已有 Steam 库则优先移动到其 steamapps\common 下
///（而不是新建一个 SteamLibrary 目录 —— 后者 Steam 客户端不识别）
#[tauri::command]
fn steam_library_paths() -> Vec<String> {
    let Ok(steam_root) = detect_steam_path() else { return Vec::new() };
    let root_path = PathBuf::from(steam_root);
    let mut paths = Vec::new();
    if root_path.is_dir() {
        paths.push(root_path.to_string_lossy().to_string());
    }
    for lib in steam_library_dirs(&root_path) {
        if lib.is_dir() {
            paths.push(lib.to_string_lossy().to_string());
        }
    }
    paths
}

// ─────────────────────────────────────────────
// 重启 Steam 使移动生效（静默 + 影响最小化）
// ─────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartSteamResult {
    pub ok: bool,
    pub error: Option<String>,
}

/// 移动 Steam 游戏后强制重启 Steam 客户端，让新位置被识别。
/// 流程：官方 -shutdown 优雅退出（给 5s）→ 未退出则强杀 steam.exe + steamwebhelper.exe
/// （游戏/下载状态不拦，用户主动要求强制）→ -silent 托盘启动，不弹主窗口。
/// 参数失效兜底：流程每步都以客观事实（进程是否存在）判定，-shutdown 无效时进程不退 → 强杀兜底
#[tauri::command]
fn restart_steam_for_recognition() -> AppResult<RestartSteamResult> {
    // 1. 定位 steam.exe（注册表 SteamPath 优先，Program Files 兜底）
    let steam_root = match detect_steam_path() {
        Ok(p) => PathBuf::from(p),
        Err(e) => return Ok(RestartSteamResult { ok: false, error: Some(format!("找不到 Steam 客户端：{}", e)) }),
    };
    let steam_exe = steam_root.join("steam.exe");

    // 2. 优雅退出：-shutdown（官方参数：Steam 保存状态后自退；已在运行的实例接收参数并退出）。
    //    给 5s —— 正常退出 1-2s 内完成；正在下载/云同步/有游戏在跑时 Steam 可能弹确认框或拒绝，
    //    超时即强制终止（见 3），不让流程卡住
    if std::process::Command::new(&steam_exe).arg("-shutdown").spawn().is_err() {
        return Ok(RestartSteamResult { ok: false, error: Some("无法启动 steam.exe，请手动重启 Steam".into()) });
    }
    if !wait_steam_exit(std::time::Duration::from_secs(5)) {
        // 3. 强制终止：主进程 + UI 渲染进程一起清（webhelper 残留会占端口干扰重启后的实例）。
        //    游戏进程是独立进程不受影响；Steam 断开后反作弊类游戏可能自行退出，属预期
        log::warn!("Steam 未在限时内退出，强制终止");
        let _ = std::process::Command::new("taskkill").args(["/IM", "steam.exe", "/F"]).status();
        let _ = std::process::Command::new("taskkill").args(["/IM", "steamwebhelper.exe", "/F"]).status();
        if !wait_steam_exit(std::time::Duration::from_secs(3)) {
            return Ok(RestartSteamResult {
                ok: false,
                error: Some("Steam 强制退出失败，请手动关闭 Steam 后重试".into()),
            });
        }
    }

    // 4. 静默启动：-silent（Steam 启动到系统托盘，不弹主窗口）
    if std::process::Command::new(&steam_exe).arg("-silent").spawn().is_err() {
        return Ok(RestartSteamResult { ok: false, error: Some("Steam 启动失败，请手动打开 Steam".into()) });
    }
    log::info!("Steam 已重启（使移动生效）");

    Ok(RestartSteamResult { ok: true, error: None })
}

// 等 steam.exe 进程消失：先给 -shutdown 一点反应时间（参数转发/保存状态），
// 超过 timeout 仍未退出返回 false（调用方决定是否强杀）。
// Steam 未运行时 -shutdown 会短暂拉起一个 steam.exe 处理参数后退出，同样等待即可
fn wait_steam_exit(timeout: std::time::Duration) -> bool {
    let mut sys = System::new();
    let start = std::time::Instant::now();
    std::thread::sleep(std::time::Duration::from_millis(800));
    loop {
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let alive = sys.processes().values().any(|p| {
            p.exe()
                .and_then(|e| e.file_name())
                .map(|f| f.eq_ignore_ascii_case("steam.exe"))
                .unwrap_or(false)
        });
        if !alive {
            return true;
        }
        if start.elapsed() > timeout {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

/// 从 exe 路径向上探测「游戏安装根目录」（手动添加游戏时自动填 install_dir）。
/// 商业游戏 exe 常在 bin\x64、win64、boot 等子目录，exe 的直接父目录不是游戏根；
/// install_dir 若只到子目录，磁盘管理移动会漏掉上级数据文件（校验"通过"后删源即损坏）。
/// 启发式：从 exe 父目录向上逐层检查（最多 4 层），某层满足「游戏根特征」即停：
/// - 该层直接子目录中「特征目录」（data/assets/content/bin/engine/r6 等）≥ 2 个
/// - 该层含 ≥2 个 exe（多启动器/主程序+子进程，大概率是根）
/// 到盘根仍未命中则返回 exe 的直接父目录（兜底，用户可在弹窗里手动改）
#[tauri::command]
fn find_game_root(exe_path: String) -> String {
    const FEATURE_DIRS: [&str; 14] = [
        "data", "assets", "content", "bin", "engine", "r6", "redist",
        "sound", "music", "common", "game", "levels", "config", "saves",
    ];
    // canonicalize 解析 .. 等相对成分；但 Windows 上它返回 \\?\ 前缀的 verbatim
    // 路径（用户看到的是 \\?\D:\DSX 这种怪路径），去掉前缀再使用
    let canon = |p: &Path| -> Option<PathBuf> {
        let c = p.canonicalize().ok()?;
        let s = c.to_string_lossy();
        let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
        Some(PathBuf::from(s.to_string()))
    };
    let mut dir = match canon(Path::new(&exe_path)) {
        Some(d) => match d.parent() {
            Some(p) => p.to_path_buf(),
            None => return exe_path, // 盘根无父目录，原样返回
        },
        None => return exe_path, // 路径无效，原样返回（前端填 exe 父目录兜底）
    };
    let mut best = dir.clone();
    // 最多向上 3 层（bin\x64 → bin → 游戏根的典型结构）。
    // 盘根绝不检查也绝不返回：盘根下的特征目录名一抓一大把（data/bin/assets…），
    // 命中就会把整个盘当"游戏根"赋给游戏
    for _ in 0..3 {
        match dir.parent() {
            Some(p) if p != dir => {} // 正常层
            _ => break,               // 已到盘根：不检查不更新，返回 best
        }
        let mut features = 0usize;
        let mut exe_count = 0usize;
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    let name = p
                        .file_name()
                        .map(|n| n.to_string_lossy().to_lowercase())
                        .unwrap_or_default();
                    if FEATURE_DIRS.contains(&name.as_str()) {
                        features += 1;
                    }
                } else if p
                    .extension()
                    .map(|e| e.eq_ignore_ascii_case("exe"))
                    .unwrap_or(false)
                {
                    exe_count += 1;
                }
            }
        }
        if features >= 2 || exe_count >= 2 {
            return dir.to_string_lossy().to_string();
        }
        best = dir.clone();
        dir = dir.parent().unwrap().to_path_buf();
    }
    best.to_string_lossy().to_string()
}

/// 在文件夹内递归查找主可执行文件（复用 Steam 导入的打分启发式，限深 5 层）：
/// 手动添加游戏时选「安装目录」后自动定位启动程序
#[tauri::command]
fn find_main_exe(dir: String, game_name: String) -> String {
    find_steam_exe(&PathBuf::from(&dir), &game_name)
}

// 应用磁盘移动：把一批游戏目录搬到目标路径（前端算好目标路径），逐个执行。
// 同盘 rename（瞬时）；跨盘复制整个目录 + 进度 + 删源。
// 单游戏失败只记入结果，不影响其它游戏
#[tauri::command]
async fn apply_game_moves(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    moves: Vec<GameMovePlan>,
) -> AppResult<Vec<GameMoveResult>> {
    // 新一轮移动开始：复位取消标志（上次取消/完成后的残留状态）
    state.move_cancel.store(false, Ordering::Relaxed);
    let mut results = Vec::with_capacity(moves.len());
    let mut cancelled = false;
    for plan in moves {
        // 逐游戏之间也检查取消：已置位则不再启动后续游戏，
        // 剩余游戏以「已取消，未移动」结果返回 —— 用户能看到哪些没动，不会静默消失
        if state.move_cancel.load(Ordering::Relaxed) {
            cancelled = true;
        }
        if cancelled {
            let name: String = state
                .db
                .lock()
                .query_row(
                    "SELECT name FROM games WHERE id = ?1",
                    params![plan.game_id],
                    |r| r.get(0),
                )
                .unwrap_or_default();
            results.push(GameMoveResult {
                game_id: plan.game_id.clone(),
                name,
                ok: false,
                error: Some("已取消，未移动".to_string()),
                steam_manifest_moved: false,
            });
            continue;
        }
        let game_id = plan.game_id.clone();
        // 游戏名（成功/失败都要展示给前端）
        let name: String = state
            .db
            .lock()
            .query_row(
                "SELECT name FROM games WHERE id = ?1",
                params![game_id],
                |r| r.get(0),
            )
            .unwrap_or_default();
        let result = match move_one_game(&app, &state, &plan).await {
            Ok(manifest_moved) => GameMoveResult {
                game_id,
                name,
                ok: true,
                error: None,
                steam_manifest_moved: manifest_moved,
            },
            Err(e) => GameMoveResult {
                game_id,
                name,
                ok: false,
                error: Some(e.to_string()),
                steam_manifest_moved: false,
            },
        };
        results.push(result);
    }
    Ok(results)
}

// 单个游戏移动。失败返回 Err（原因展示给用户，不影响其它游戏）。
// 成功返回 true = Steam 清单已随文件夹搬到目标库（前端提示重启 Steam 识别）
async fn move_one_game(
    app: &tauri::AppHandle,
    state: &AppState,
    plan: &GameMovePlan,
) -> AppResult<bool> {
    let (name, install_dir, exe_path, work_dir, steam_appid): (String, String, String, String, u64) = {
        let conn = state.db.lock();
        conn.query_row(
            "SELECT name, install_dir, exe_path, work_dir, steam_appid FROM games WHERE id = ?1",
            params![plan.game_id],
            |r| Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, u64>(4)?,
            )),
        )?
    };

    // ── 数据安全防线一：install_dir 为空的手动添加游戏拒绝移动 ──
    // 源只能取到 exe 的父目录（商业游戏常是 bin\x64 等子目录），游戏主体（上级数据文件）
    // 不在复制范围；复制+校验对"复制范围内"两边一致 → 校验"通过" → 删源 → 游戏彻底损坏
    if install_dir.is_empty() {
        return Err(AppError::Custom(
            "该游戏未设置安装目录（手动添加的游戏只记录了启动路径），无法安全移动。请先在详情中设置「安装目录」为游戏整个文件夹，再重试移动".to_string(),
        ));
    }

    // 源目录：优先 install_dir（Steam 游戏带完整目录），否则 exe_path 所在目录
    let src = if !install_dir.is_empty() && Path::new(&install_dir).is_dir() {
        PathBuf::from(&install_dir)
    } else if !exe_path.is_empty() {
        Path::new(&exe_path)
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| AppError::Custom("无法确定游戏源目录".to_string()))?
    } else {
        return Err(AppError::Custom("游戏没有安装目录或启动路径，无法移动".to_string()));
    };

    // ── 数据安全防线二：游戏正在运行则拒绝移动 ──
    // 运行中跨盘复制会因文件锁报错、同盘 rename 失败；主动拦截比事后报错体验更好
    //（running_games 是 parking_lot 锁，read() 直接返回 guard）
    if state.running_games.read().contains_key(&plan.game_id) {
        return Err(AppError::Custom(
            "该游戏正在运行，请先退出游戏再移动（移动需要复制/重命名整个目录）".to_string(),
        ));
    }

    // ── 数据安全防线三：源目录合法性 ──
    // 移动 = 复制整个源目录 + 删源。若源是盘根（"D:\"）会把整个盘复制过去再删掉，
    // 灾难级误删 —— 只允许有明确目录名的源
    if src.components().count() <= 2 {
        return Err(AppError::Custom(format!(
            "源目录 {} 是盘根目录，拒绝移动（防止误删整个磁盘）",
            src.display()
        )));
    }
    // 系统关键目录：精确拒绝目录本身 + 前缀拒绝 windows/users 子树（System32、用户配置等
    // 都在其下）。Program Files 不前缀拒绝 —— 合法游戏也装那里，只挡目录本身
    let src_norm = norm_path(&src);
    let sys_exact = ["c:/windows", "c:/windows.old", "c:/program files", "c:/program files (x86)", "c:/users", "c:/programdata"];
    let sys_prefix = ["c:/windows/", "c:/users/"];
    if sys_exact.contains(&src_norm.as_str())
        || sys_prefix.iter().any(|p| src_norm.starts_with(p))
    {
        return Err(AppError::Custom(format!(
            "源目录 {} 是系统关键目录，拒绝移动",
            src.display()
        )));
    }

    // ── 数据安全防线四：启动程序必须在安装目录内 ──
    // 安装目录被填成别的游戏的目录时，移动会把无关目录复制+删除（如把 D:\Epic 赋给 DSX
    // 会搬走 Epic 的整个目录）。exe 不在 src 内 = 安装目录与启动程序无关 → 拒绝。
    // （极少数"独立启动器"场景可先在详情里把安装目录修正为包含 exe 的目录）
    if !exe_path.is_empty() {
        let exe_norm = norm_path(Path::new(&exe_path));
        let exe_inside = exe_norm.len() > src_norm.len()
            && exe_norm.starts_with(&src_norm)
            && exe_norm.as_bytes()[src_norm.len()] == b'/';
        if !exe_inside {
            return Err(AppError::Custom(format!(
                "启动程序 {} 不在安装目录 {} 内，拒绝移动（安装目录可能是别的游戏的目录）。请先在详情中修正「安装目录」为包含该启动程序的整个游戏文件夹",
                exe_path,
                src.display()
            )));
        }
    }

    let target = PathBuf::from(&plan.target_path);
    let tgt_norm = norm_path(&target);
    if tgt_norm == src_norm {
        return Ok(false); // 目标即当前目录，无需移动
    }
    // 目标与源互相包含（同盘极端情况）：目标在源内部会复制到自己里面、源在目标内部
    // 会随复制被一起删掉 —— 规范化后判重叠（带目录边界）
    if norm_paths_overlap(&tgt_norm, &src_norm) {
        return Err(AppError::Custom(format!(
            "目标路径 {} 与源目录 {} 重叠，拒绝移动",
            plan.target_path,
            src.display()
        )));
    }
    if target.exists() {
        return Err(AppError::Custom(format!(
            "目标目录已存在：{}",
            plan.target_path
        )));
    }

    // 先算源目录总大小（blocking 后台），用于空间校验 + 复制进度分母；
    // 顺带统计符号链接数（S3 防线）
    let (total_size, symlink_count) = {
        let src2 = src.clone();
        tauri::async_runtime::spawn_blocking(move || compute_folder_size(src2))
            .await
            .map_err(|e| AppError::Custom(format!("计算目录大小失败: {}", e)))?
    };
    if symlink_count > 0 {
        return Err(AppError::Custom(format!(
            "源目录包含 {} 个符号链接/junction（如 DLC 或数据目录的链接）。移动不会复制链接指向的内容，\
             删源后这些数据会丢失，已拒绝移动。请先移除源目录中的符号链接，或手动复制这些内容后再移动",
            symlink_count
        )));
    }

    // 创建目标父目录（SteamLibrary\steamapps\common 等）
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }

    let same_drive = src
        .to_string_lossy()
        .chars()
        .next()
        .map(|c| {
            target
                .to_string_lossy()
                .chars()
                .next()
                .map(|t| c.eq_ignore_ascii_case(&t))
                .unwrap_or(false)
        })
        .unwrap_or(false);

    if same_drive {
        // 同盘：rename 瞬时完成（同一文件系统内是改目录项，不拷贝数据）
        fs::rename(&src, &target)?;
    } else {
        // 跨盘：后台复制整目录（逐文件 emit 进度）。
        // 安全原则：只有「复制完整校验通过」后才允许删源；任何失败路径都保证源目录原样保留
        // 空间校验只在跨盘分支做：同盘 rename 不消耗空间，查空间会误拒
        if let Some(free) = drive_free_space(&target) {
            if total_size > free {
                return Err(AppError::Custom(format!(
                    "目标盘可用空间不足（需要 {}，可用 {}）",
                    fmt_size(total_size),
                    fmt_size(free)
                )));
            }
        }
        let app2 = app.clone();
        let game_id = plan.game_id.clone();
        let name2 = name.clone();
        let src2 = src.clone();
        let target2 = target.clone();
        let cancel = state.move_cancel.clone();
        let copy_result: Result<(), String> = tauri::async_runtime::spawn_blocking(move || {
            copy_dir_with_progress(&src2, &target2, &app2, &game_id, &name2, total_size, &cancel)
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| AppError::Custom(format!("复制任务失败: {}", e)))?;
        if let Err(e) = copy_result {
            // 复制中途失败/取消：清理目标残留副本，源目录未动，可重试。
            // 取消是用户主动中止，文案与真实失败区分开
            let _ = fs::remove_dir_all(&target);
            if e.contains("移动已取消") {
                return Err(AppError::Custom(
                    "移动已取消，已清理目标残留副本，游戏留在原目录".to_string(),
                ));
            }
            return Err(AppError::Custom(format!(
                "复制失败，已清理目标残留副本（源目录未动，可重试）：{}",
                e
            )));
        }
        // 完整性校验：文件数 + 总字节一致（跳过符号链接，与复制范围一致）才允许删源
        let (src_files, src_bytes) = count_files(&src);
        let (dst_files, dst_bytes) = count_files(&target);
        if src_files != dst_files || src_bytes != dst_bytes {
            let _ = fs::remove_dir_all(&target);
            return Err(AppError::Custom(format!(
                "复制完整性校验未通过（源 {} 个文件/{}，目标 {} 个文件/{}），已清理目标副本，源目录未动",
                src_files,
                fmt_size(src_bytes),
                dst_files,
                fmt_size(dst_bytes)
            )));
        }
        // 校验通过，此时才删源。删源前最后检查一次取消：
        // 用户取消 = 清理目标残留、源原样保留，移动视为未发生（不允许"复制完了但被取消"走删源）
        if state.move_cancel.load(Ordering::Relaxed) {
            let _ = fs::remove_dir_all(&target);
            return Err(AppError::Custom(
                "移动已取消，已清理目标残留副本，游戏留在原目录".to_string(),
            ));
        }
        // 删源失败（文件被占用）→ 回滚删目标恢复到原状
        if let Err(e) = fs::remove_dir_all(&src) {
            let _ = fs::remove_dir_all(&target);
            return Err(AppError::Custom(format!(
                "文件已复制到目标但源目录删除失败（可能被占用）：{}。已回滚，源目录未动",
                e
            )));
        }
    }

    // ── Steam 识别：把 appmanifest 清单一起搬（源库 → 目标库） ──
    // Steam 靠 steamapps\appmanifest_<appid>.acf 识别已安装游戏：清单在源库、文件夹没了 →
    // 源库显示未安装；目标库有文件夹没清单 → Steam 根本不认识（"移动后不识别"的根因）。
    // 文件夹 + 清单一起搬才完整；目标库已有同名清单（重复安装）则覆盖
    let mut manifest_moved = false;
    if let Some(src_root) = steam_library_root_of(&src) {
        if let Some(dst_root) = steam_library_root_of(&target) {
            manifest_moved = relocate_steam_manifest(steam_appid, &src_root, &dst_root);
        }
    }

    // 更新数据库路径（cover/banner/bg 存 data_dir，不动）。
    // rebase 基准用实际移动的 src 而非 install_dir：手动添加的游戏 install_dir 常为空
    //（源取自 exe_path 父目录），用空串作基准会让 rebase 保持旧路径 → 移动后游戏打不开
    let new_install = target.to_string_lossy().to_string();
    let src_str = src.to_string_lossy().to_string();
    let new_exe = rebase_path(&exe_path, &src_str, &new_install);
    let new_work = if work_dir.is_empty() {
        String::new()
    } else {
        rebase_path(&work_dir, &src_str, &new_install)
    };
    {
        let conn = state.db.lock();
        if let Err(e) = conn.execute(
            "UPDATE games SET install_dir = ?1, exe_path = ?2, work_dir = ?3, updated_at = datetime('now') WHERE id = ?4",
            params![new_install, new_exe, new_work, plan.game_id],
        ) {
            // M4 防线：文件已移动、源已删，此时必须明确告诉用户文件在哪里，
            // 不能只报"更新失败"让用户以为移动没发生（重试也无源可移）
            return Err(AppError::Custom(format!(
                "游戏文件已移动到 {}，但数据库更新失败（{}）。游戏文件在新位置完好，请手动编辑该游戏的「安装目录」和「启动路径」指向新位置",
                new_install, e
            )));
        }
    }
    Ok(manifest_moved)
}

// 从游戏目录向上找名为 steamapps 的父目录 → 其父即 Steam 库根（D:\Steam、D:\SteamLibrary…）
fn steam_library_root_of(dir: &Path) -> Option<PathBuf> {
    let mut cur = dir;
    loop {
        if let Some(name) = cur.file_name() {
            if name.eq_ignore_ascii_case("steamapps") {
                return cur.parent().map(|p| p.to_path_buf());
            }
        }
        cur = cur.parent()?;
    }
}

// 把 Steam 清单 appmanifest_<appid>.acf 从源库搬到目标库（复制+删源）。
// 移动游戏文件夹后清单不搬 Steam 就不识别；目标库已有同名清单则覆盖（Steam 启动时以磁盘现状为准）。
// 失败不阻断移动主流程（游戏文件与数据库已就绪），仅记日志 —— 用户重启 Steam 后可手动补救。
// 返回 true = 清单已搬迁（前端提示「重启 Steam 客户端后即可识别」）
fn relocate_steam_manifest(steam_appid: u64, src_root: &Path, dst_root: &Path) -> bool {
    if steam_appid == 0 {
        return false; // 非 Steam 游戏无需清单
    }
    if norm_path(src_root) == norm_path(dst_root) {
        return false; // 同一库内移动，清单原位不动
    }
    let src_manifest = src_root
        .join("steamapps")
        .join(format!("appmanifest_{}.acf", steam_appid));
    if !src_manifest.exists() {
        return false; // 源库无清单（非常规 Steam 安装），无需处理
    }
    let dst_manifest = dst_root
        .join("steamapps")
        .join(format!("appmanifest_{}.acf", steam_appid));
    if let Some(parent) = dst_manifest.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(e) = fs::copy(&src_manifest, &dst_manifest) {
        eprintln!(
            "[move] 复制 Steam 清单失败 {} → {}: {}",
            src_manifest.display(),
            dst_manifest.display(),
            e
        );
        return false;
    }
    if let Err(e) = fs::remove_file(&src_manifest) {
        eprintln!("[move] 删除源 Steam 清单失败 {}: {}", src_manifest.display(), e);
    }
    true
}

// 目标盘可用空间：找挂载点能匹配目标路径前缀的卷（sysinfo，跨平台）
fn drive_free_space(path: &Path) -> Option<u64> {
    let target = path.to_string_lossy().to_uppercase();
    let disks = sysinfo::Disks::new_with_refreshed_list();
    for d in &disks {
        let mp = d.mount_point().to_string_lossy().to_uppercase();
        if !mp.is_empty() && target.starts_with(&mp) {
            return Some(d.available_space());
        }
    }
    None
}

// 把 old 相对 old_root 的路径拼到 new_root；old 不以 old_root 开头（exe 在独立位置）则保持原值
fn rebase_path(old: &str, old_root: &str, new_root: &str) -> String {
    if old.is_empty() {
        return String::new();
    }
    let root = old_root.trim_end_matches(['\\', '/']);
    if !root.is_empty() && old.to_lowercase().starts_with(&root.to_lowercase()) {
        let rel = old[root.len()..].trim_start_matches(['\\', '/']);
        Path::new(new_root).join(rel).to_string_lossy().to_string()
    } else {
        old.to_string()
    }
}

// 路径规范化：统一反斜杠为斜杠、去尾部斜杠、转小写。
// Windows 路径比较必须用它：裸 == / starts_with 会把 "D:\Game" vs "d:\game"、
// "D:\Game\" vs "D:\Game" 当不同路径（数据安全相关判断一律走这里）
fn norm_path(p: &Path) -> String {
    p.to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

// 两个规范化路径是否「重叠」：相等，或一个是另一个的目录前缀（带边界 ——
// "d:/a" 与 "d:/ab" 不是重叠，"d:/a" 与 "d:/a/b" 才是）
fn norm_paths_overlap(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let is_dir_prefix = |x: &str, y: &str| {
        x.len() > y.len()
            && x.starts_with(y)
            && x.as_bytes()[y.len()] == b'/'
    };
    is_dir_prefix(a, b) || is_dir_prefix(b, a)
}

// 递归复制目录（跳过符号链接，避免 junction 死循环或复制到外部）。每复制一个文件累计已复制字节并 emit 进度。
// 在 spawn_blocking 线程执行；app 为 AppHandle（Send），emit 可跨线程。
// cancel 为取消标志：每复制完一个文件检查，置位即中止（调用方走失败清理，源目录原样保留）
fn copy_dir_with_progress(
    src: &Path,
    dst: &Path,
    app: &tauri::AppHandle,
    game_id: &str,
    name: &str,
    total: u64,
    cancel: &std::sync::atomic::AtomicBool,
) -> AppResult<()> {
    fs::create_dir_all(dst)?;
    let mut done = 0u64;
    let mut stack = vec![(src.to_path_buf(), dst.to_path_buf())];
    let mut visited = std::collections::HashSet::new();
    while let Some((from, to)) = stack.pop() {
        if !visited.insert(from.clone()) {
            continue;
        }
        // symlink_metadata 才能识别符号链接；junction/软链在此应已被移动前检测拦截
        //（见 move_one_game 的 symlink 防线），这里仍防御性跳过
        let meta = fs::symlink_metadata(&from)
            .map_err(|e| AppError::Custom(format!("读取目录信息失败 {}: {}", from.display(), e)))?;
        if meta.file_type().is_symlink() {
            continue;
        }
        // 不可读目录必须报错而非跳过（S2 防线）：静默跳过会让「复制+校验」两边一致
        // → 校验通过 → 删源 → 该子目录数据永久丢失。读失败立即中止，源原样保留
        let entries = fs::read_dir(&from)
            .map_err(|e| AppError::Custom(format!("读取目录失败 {}: {}", from.display(), e)))?;
        for entry in entries.flatten() {
            // 取消检查点：每文件一次（大目录单层几千文件时取消也能快速响应，
            // 不能只在每目录检查——那会让取消等完整个目录的所有文件）
            if cancel.load(Ordering::Relaxed) {
                return Err(AppError::Custom("移动已取消".to_string()));
            }
            let f = entry.path();
            let t = to.join(entry.file_name());
            let m = entry.metadata()
                .map_err(|e| AppError::Custom(format!("读取文件信息失败 {}: {}", f.display(), e)))?;
            if m.is_dir() {
                let _ = fs::create_dir_all(&t);
                stack.push((f, t));
            } else if m.is_file() {
                fs::copy(&f, &t)
                    .map_err(|e| AppError::Custom(format!("复制失败 {}: {}", f.display(), e)))?;
                done = done.saturating_add(m.len());
                let _ = app.emit(
                    "disk-move-progress",
                    DiskMoveProgress {
                        game_id: game_id.to_string(),
                        name: name.to_string(),
                        done,
                        total,
                    },
                );
            }
        }
    }
    Ok(())
}

fn fmt_size(n: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;
    if n >= GB {
        format!("{:.1} GB", n as f64 / GB as f64)
    } else if n >= MB {
        format!("{:.1} MB", n as f64 / MB as f64)
    } else if n >= KB {
        format!("{:.1} KB", n as f64 / KB as f64)
    } else {
        format!("{} B", n)
    }
}

// 统计目录内文件数与总字节（跳过符号链接，与 copy_dir_with_progress 的复制范围一致），
// 用于跨盘复制后的完整性比对：两边文件数、字节数一致才允许删源
fn count_files(path: &Path) -> (u64, u64) {
    let mut files = 0u64;
    let mut bytes = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let p = entry.path();
            let Ok(meta) = fs::symlink_metadata(&p) else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(p);
            } else if meta.is_file() {
                files += 1;
                bytes += meta.len();
            }
        }
    }
    (files, bytes)
}

// ─────────────────────────────────────────────
// Tauri Commands - Series Disk Layout（影视磁盘管理）
// ─────────────────────────────────────────────

// 单个本地视频文件：完整路径 + 相对剧根的路径 + 大小
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesDiskFile {
    pub local_path: String,
    pub rel: String, // 相对剧根目录的路径（移动后保持这个结构）
    pub size: u64,
}

// 一部剧在磁盘上的布局：剧根目录 + 归属盘 + 本地文件列表 + 总大小
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesDiskEntry {
    pub series_id: String,
    pub title: String,
    pub poster_path: String,
    pub media_type: String, // tv / movie
    pub root: String,       // 剧根目录（所有本地文件的公共父目录）；无文件或跨盘 = 空
    pub drive: String,      // 归属盘 "D:"；无法确定 = "未知"
    pub total_size: u64,
    pub files: Vec<SeriesDiskFile>,
}

// 影视磁盘管理数据：一次返回全部有本地文件的剧（含剧根/归属盘/文件列表/大小）。
// 前端按 drive 分组显示，拖拽整部剧跨盘移动
#[tauri::command(async)]
fn get_series_disk_layout(state: State<'_, AppState>) -> AppResult<Vec<SeriesDiskEntry>> {
    // 先把库里要的东西一次取完就放锁：下面每个文件都要 metadata() 问一次磁盘，
    // 几百集就是几百次 IO，占着锁做会让同期的播放/扫描全排队
    let rows: Vec<(String, String, String, String, Vec<String>)> = {
        let conn = state.db.lock();
        let mut series_stmt = conn.prepare(
            "SELECT id, title, poster_path, media_type FROM series ORDER BY title",
        )?;
        let series_list: Vec<(String, String, String, String)> = series_stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<Result<_, _>>()?;

        let mut ep_stmt = conn.prepare(
            "SELECT e.local_path FROM episodes e JOIN seasons s ON s.id = e.season_id
             WHERE e.series_id = ?1 AND e.local_path <> ''",
        )?;

        let mut acc = Vec::with_capacity(series_list.len());
        for (sid, title, poster, media_type) in series_list {
            let mut paths: Vec<String> = ep_stmt
                .query_map(params![&sid], |r| r.get::<_, String>(0))?
                .collect::<Result<_, _>>()?;
            // 去重（同一文件可能被多集引用）
            paths.sort();
            paths.dedup();
            if paths.is_empty() {
                continue; // 没有本地文件的剧不参与磁盘管理
            }
            acc.push((sid, title, poster, media_type, paths));
        }
        acc
    };

    let mut out = Vec::with_capacity(rows.len());
    for (sid, title, poster, media_type, paths) in rows {

        // 剧根 = 所有 local_path 的公共父目录（用户添加影视时选的文件夹）
        let root = common_parent_of(&paths);
        let drive = root
            .as_ref()
            .and_then(|r| drive_of_path_str(&r.to_string_lossy()))
            .unwrap_or_else(|| "未知".to_string());

        let mut files = Vec::with_capacity(paths.len());
        let mut total = 0u64;
        for p in &paths {
            let pb = PathBuf::from(p);
            let size = pb.metadata().map(|m| m.len()).unwrap_or(0);
            let rel = root
                .as_ref()
                .and_then(|r| pb.strip_prefix(r).ok())
                .map(|r| r.to_string_lossy().to_string())
                .unwrap_or_else(|| p.clone());
            total = total.saturating_add(size);
            files.push(SeriesDiskFile {
                local_path: p.clone(),
                rel,
                size,
            });
        }

        out.push(SeriesDiskEntry {
            series_id: sid,
            title,
            poster_path: poster,
            media_type,
            root: root
                .map(|r| r.to_string_lossy().to_string())
                .unwrap_or_default(),
            drive,
            total_size: total,
            files,
        });
    }
    Ok(out)
}

// 一批文件路径的公共父目录（LCA）。路径跨盘（盘符前缀不同）或无公共前缀时返回 None
fn common_parent_of(paths: &[String]) -> Option<PathBuf> {
    if paths.is_empty() {
        return None;
    }
    let mut root: Option<PathBuf> = None;
    for p in paths {
        let parent = Path::new(p).parent()?;
        root = Some(match root {
            None => parent.to_path_buf(),
            Some(r) => common_dir_prefix(&r, parent),
        });
        // 公共前缀为空 → 没有共同目录（跨盘等），视为无剧根
        if root.as_ref().map(|r| r.as_os_str().is_empty()).unwrap_or(false) {
            return None;
        }
    }
    root
}

// 两个路径逐组件求公共前缀
fn common_dir_prefix(a: &Path, b: &Path) -> PathBuf {
    let ca: Vec<_> = a.components().collect();
    let cb: Vec<_> = b.components().collect();
    let mut out = PathBuf::new();
    for (x, y) in ca.iter().zip(cb.iter()) {
        if x == y {
            out.push(x.as_os_str());
        } else {
            break;
        }
    }
    out
}

// 从路径提取盘符 "D:"；非盘符路径（相对/UNC）返回 None
fn drive_of_path_str(p: &str) -> Option<String> {
    p.chars()
        .find(|c| c.is_ascii_alphabetic())
        .map(|c| format!("{}:", c.to_ascii_uppercase()))
}

// ─────────────────────────────────────────────
// Tauri Commands - Apply Series Moves（影视跨盘移动）
// ─────────────────────────────────────────────

// 一部剧的迁移方案（前端算好目标根目录：目标盘:\剧名）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesMovePlan {
    pub series_id: String,
    pub target_root: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesMoveResult {
    pub series_id: String,
    pub title: String,
    pub ok: bool,
    pub error: Option<String>,
}

// 复制进度事件载荷（每复制完一个文件 emit 一次）
#[derive(Clone, Serialize)]
struct SeriesMoveProgress {
    series_id: String,
    title: String,
    done: u64,
    total: u64,
}

// 应用影视磁盘移动：把一批剧的本地视频文件搬到目标根目录（目标盘:\剧名），
// 保持文件相对剧根的结构。逐文件复制 + 完整性校验 + 删源 + 更新 local_path。
// 单剧失败只记入结果，不影响其它剧
#[tauri::command]
async fn apply_series_moves(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    moves: Vec<SeriesMovePlan>,
) -> AppResult<Vec<SeriesMoveResult>> {
    // 新一轮移动开始：复位取消标志（与游戏移动共用，两个弹窗不可能同时开）
    state.move_cancel.store(false, Ordering::Relaxed);
    let mut results = Vec::with_capacity(moves.len());
    let mut cancelled = false;
    for plan in moves {
        // 逐剧之间也检查取消：已置位则不再启动后续影视，
        // 剩余影视以「已取消，未移动」结果返回
        if state.move_cancel.load(Ordering::Relaxed) {
            cancelled = true;
        }
        if cancelled {
            let title: String = state
                .db
                .lock()
                .query_row("SELECT title FROM series WHERE id = ?1", params![plan.series_id], |r| r.get(0))
                .unwrap_or_default();
            results.push(SeriesMoveResult {
                series_id: plan.series_id.clone(),
                title,
                ok: false,
                error: Some("已取消，未移动".to_string()),
            });
            continue;
        }
        let series_id = plan.series_id.clone();
        let title: String = state
            .db
            .lock()
            .query_row("SELECT title FROM series WHERE id = ?1", params![series_id], |r| r.get(0))
            .unwrap_or_default();
        let result = match move_series_one(&app, &state, &plan, &title).await {
            Ok(()) => SeriesMoveResult {
                series_id,
                title,
                ok: true,
                error: None,
            },
            Err(e) => SeriesMoveResult {
                series_id,
                title,
                ok: false,
                error: Some(e.to_string()),
            },
        };
        results.push(result);
    }
    Ok(results)
}

// 单部剧移动。安全原则：只有「复制完整校验通过」后才删源；任何失败路径都保证源文件原样保留
async fn move_series_one(
    app: &tauri::AppHandle,
    state: &AppState,
    plan: &SeriesMovePlan,
    title: &str,
) -> AppResult<()> {
    // 1. 该剧所有本地文件（去重）
    let paths: Vec<String> = {
        let conn = state.db.lock();
        let mut stmt = conn.prepare(
            "SELECT e.local_path FROM episodes e JOIN seasons s ON s.id = e.season_id
             WHERE e.series_id = ?1 AND e.local_path <> ''",
        )?;
        let mut p: Vec<String> = stmt
            .query_map(params![plan.series_id], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        p.sort();
        p.dedup();
        p
    };
    if paths.is_empty() {
        return Err(AppError::Custom("该影视没有本地文件".to_string()));
    }

    // 2. 剧根（公共父目录）；跨盘剧无公共根 → 拒绝
    let root = common_parent_of(&paths)
        .ok_or_else(|| AppError::Custom("该影视文件跨盘，无法整体移动".to_string()))?;
    let target_root = PathBuf::from(&plan.target_root);
    // 目标与剧根重叠（同盘极端情况）：规范化比较带目录边界
    let root_norm = norm_path(&root);
    let tgt_norm = norm_path(&target_root);
    if tgt_norm == root_norm {
        return Ok(()); // 目标即当前目录，无需移动
    }
    if norm_paths_overlap(&tgt_norm, &root_norm) {
        return Err(AppError::Custom(format!(
            "目标路径 {} 与剧根 {} 重叠，拒绝移动",
            plan.target_root,
            root.display()
        )));
    }
    if target_root.exists() {
        return Err(AppError::Custom(format!("目标目录已存在：{}", plan.target_root)));
    }

    // 3. 总大小（空间校验 + 进度分母）
    let total_size: u64 = paths
        .iter()
        .filter_map(|p| Path::new(p).metadata().ok().map(|m| m.len()))
        .sum();
    // 4. 目标盘可用空间校验
    if let Some(free) = drive_free_space(&target_root) {
        if total_size > free {
            return Err(AppError::Custom(format!(
                "目标盘可用空间不足（需要 {}，可用 {}）",
                fmt_size(total_size),
                fmt_size(free)
            )));
        }
    }

    // 5. 逐文件复制到 目标根目录\<相对剧根路径>，保持内部结构（spawn_blocking 后台）
    let app2 = app.clone();
    let series_id = plan.series_id.clone();
    let title2 = title.to_string();
    let root2 = root.clone();
    let target2 = target_root.clone();
    let paths2 = paths.clone();
    let cancel = state.move_cancel.clone();
    let copy_result: Result<(), String> = tauri::async_runtime::spawn_blocking(move || {
        copy_series_files_with_progress(
            &paths2,
            &root2,
            &target2,
            &app2,
            &series_id,
            &title2,
            total_size,
            &cancel,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| AppError::Custom(format!("复制任务失败: {}", e)))?;
    if let Err(e) = copy_result {
        // 复制中途失败/取消：清理目标残留，源未动，可重试。
        // 取消是用户主动中止，文案与真实失败区分开
        let _ = fs::remove_dir_all(&target_root);
        if e.contains("移动已取消") {
            return Err(AppError::Custom(
                "移动已取消，已清理目标残留副本，影视留在原目录".to_string(),
            ));
        }
        return Err(AppError::Custom(format!(
            "复制失败，已清理目标残留副本（源未动，可重试）：{}",
            e
        )));
    }

    // 6. 完整性校验：源文件快照 vs 目标目录（文件数 + 字节）
    let (src_files, src_bytes) = count_files_of(&paths);
    let (dst_files, dst_bytes) = count_files(&target_root);
    if src_files != dst_files || src_bytes != dst_bytes {
        let _ = fs::remove_dir_all(&target_root);
        return Err(AppError::Custom(format!(
            "复制完整性校验未通过（源 {} 文件/{}，目标 {} 文件/{}），已清理目标副本，源未动",
            src_files,
            fmt_size(src_bytes),
            dst_files,
            fmt_size(dst_bytes)
        )));
    }

    // 7. 删源文件（全部成功才继续），并清理空的父目录。
    // 删源前最后检查一次取消：用户取消 = 清理目标残留、源文件原样保留，移动视为未发生
    if state.move_cancel.load(Ordering::Relaxed) {
        let _ = fs::remove_dir_all(&target_root);
        return Err(AppError::Custom(
            "移动已取消，已清理目标残留副本，影视留在原目录".to_string(),
        ));
    }
    for p in &paths {
        match fs::remove_file(p) {
            Ok(()) => {}
            Err(_) if !Path::new(p).exists() => {} // 源文件本就不存在，视为已删
            Err(e) => {
                let _ = fs::remove_dir_all(&target_root); // 回滚目标
                return Err(AppError::Custom(format!("删除源文件失败（可能被占用）：{}", e)));
            }
        }
    }
    cleanup_empty_dirs(&root, &paths);

    // 8. 更新 episodes.local_path：相对剧根的路径拼到新根
    let new_root = target_root.to_string_lossy().to_string();
    let conn = state.db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, local_path FROM episodes WHERE series_id = ?1 AND local_path <> ''",
    )?;
    let rows: Vec<(String, String)> = stmt
        .query_map(params![plan.series_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for (ep_id, old_path) in rows {
        let rel = Path::new(&old_path)
            .strip_prefix(&root)
            .map(|r| r.to_string_lossy().to_string())
            .unwrap_or_else(|_| old_path.clone());
        let new_path = Path::new(&new_root).join(&rel).to_string_lossy().to_string();
        if let Err(e) = conn.execute(
            "UPDATE episodes SET local_path = ?1 WHERE id = ?2",
            params![new_path, ep_id],
        ) {
            // M4 防线：文件已移动、源已删，明确告诉用户文件在哪里，可手动修复
            return Err(AppError::Custom(format!(
                "影视文件已移动到 {}，但数据库更新失败（{}）。文件在新位置完好，请手动重新关联本地文件",
                new_root, e
            )));
        }
    }
    Ok(())
}

// 逐文件复制：相对剧根的路径拼到目标根（保持内部结构），每复制完一个 emit 进度。
// spawn_blocking 线程执行；app 为 AppHandle（Send）。
// cancel 为取消标志：每复制完一个文件检查，置位即中止（调用方走失败清理，源文件原样保留）
fn copy_series_files_with_progress(
    paths: &[String],
    root: &Path,
    target_root: &Path,
    app: &tauri::AppHandle,
    series_id: &str,
    title: &str,
    total: u64,
    cancel: &std::sync::atomic::AtomicBool,
) -> AppResult<()> {
    fs::create_dir_all(target_root)?;
    let mut done = 0u64;
    for p in paths {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::Custom("移动已取消".to_string()));
        }
        let from = Path::new(p);
        let rel = from
            .strip_prefix(root)
            .map(|r| r.to_path_buf())
            .unwrap_or_else(|_| from.file_name().map(|f| PathBuf::from(f)).unwrap_or_default());
        let to = target_root.join(&rel);
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        let size = from.metadata().map(|m| m.len()).unwrap_or(0);
        fs::copy(from, &to)
            .map_err(|e| AppError::Custom(format!("复制失败 {}: {}", from.display(), e)))?;
        done = done.saturating_add(size);
        let _ = app.emit(
            "series-move-progress",
            SeriesMoveProgress {
                series_id: series_id.to_string(),
                title: title.to_string(),
                done,
                total,
            },
        );
    }
    Ok(())
}

// 统计一批指定文件的文件数与总字节（只算存在的文件）
fn count_files_of(paths: &[String]) -> (u64, u64) {
    let mut files = 0u64;
    let mut bytes = 0u64;
    for p in paths {
        if let Ok(meta) = Path::new(p).metadata() {
            if meta.is_file() {
                files += 1;
                bytes += meta.len();
            }
        }
    }
    (files, bytes)
}

// 删除剧根下的空目录（从深到浅；非空目录保留）。用于移动后清理源目录骨架
// 清理「paths 文件被删后留下的空父目录链」（最深 → 剧根边界，root 本身非空则保留）。
// 不做全盘扫描：影视文件的公共父目录可能是盘根（文件散落各处），
// 旧实现会遍历整个盘删掉所有空目录（误删其他应用的空目录 + 遍历几十分钟）
fn cleanup_empty_dirs(root: &Path, paths: &[String]) {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for p in paths {
        let mut cur = Path::new(p).parent().map(Path::to_path_buf);
        while let Some(d) = cur {
            if d == root || !dirs.contains(&d) {
                dirs.push(d.clone());
            }
            cur = d.parent().map(Path::to_path_buf);
        }
    }
    // 深度大的先删（先子后父），remove_dir 只在空目录时成功（非空自动跳过）
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for d in dirs {
        let _ = fs::remove_dir(&d);
    }
}

// ─────────────────────────────────────────────
// Tauri Commands - Games
// ─────────────────────────────────────────────

#[tauri::command(async)]
fn get_all_games(state: State<'_, AppState>) -> AppResult<Vec<Game>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, name, install_dir, exe_path, launch_args, env_vars, work_dir,
                cover_path, banner_path, bg_path, notes, tags, favorite, hidden,
                total_seconds, play_count, created_at, updated_at, sort_order, steam_appid
         FROM games WHERE hidden = 0
         ORDER BY CASE WHEN sort_order = 0 THEN 1 ELSE 0 END, sort_order, created_at, id"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Game {
            id: row.get(0)?,
            name: row.get(1)?,
            install_dir: row.get(2)?,
            exe_path: row.get(3)?,
            launch_args: row.get(4)?,
            env_vars: row.get(5)?,
            work_dir: row.get(6)?,
            cover_path: row.get(7)?,
            banner_path: row.get(8)?,
            bg_path: row.get(9)?,
            notes: row.get(10)?,
            tags: row.get(11)?,
            favorite: row.get::<_, i32>(12)? != 0,
            hidden: row.get::<_, i32>(13)? != 0,
            total_seconds: row.get(14)?,
            play_count: row.get(15)?,
            created_at: row.get(16)?,
            updated_at: row.get(17)?,
            sort_order: row.get(18)?,
            steam_appid: row.get::<_, i64>(19)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

#[tauri::command(async)]
fn get_game(state: State<'_, AppState>, id: String) -> AppResult<Game> {
    let conn = state.db.lock();
    let game = conn.query_row(
        "SELECT id, name, install_dir, exe_path, launch_args, env_vars, work_dir,
                cover_path, banner_path, bg_path, notes, tags, favorite, hidden,
                total_seconds, play_count, created_at, updated_at, sort_order, steam_appid
         FROM games WHERE id = ?",
        [&id],
        |row| {
            Ok(Game {
                id: row.get(0)?,
                name: row.get(1)?,
                install_dir: row.get(2)?,
                exe_path: row.get(3)?,
                launch_args: row.get(4)?,
                env_vars: row.get(5)?,
                work_dir: row.get(6)?,
                cover_path: row.get(7)?,
                banner_path: row.get(8)?,
                bg_path: row.get(9)?,
                notes: row.get(10)?,
                tags: row.get(11)?,
                favorite: row.get::<_, i32>(12)? != 0,
                hidden: row.get::<_, i32>(13)? != 0,
                total_seconds: row.get(14)?,
                play_count: row.get(15)?,
                created_at: row.get(16)?,
                updated_at: row.get(17)?,
                sort_order: row.get(18)?,
                steam_appid: row.get::<_, i64>(19)?,
            })
        },
    )?;
    Ok(game)
}

#[tauri::command(async)]
fn create_game(state: State<'_, AppState>, mut game: Game) -> AppResult<Game> {
    if game.id.is_empty() {
        game.id = Uuid::new_v4().to_string();
    }
    let conn = state.db.lock();
    conn.execute(
        "INSERT INTO games (id, name, install_dir, exe_path, launch_args, env_vars,
         work_dir, cover_path, banner_path, bg_path, notes, tags, favorite, hidden,
         total_seconds, play_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            game.id, game.name, game.install_dir, game.exe_path,
            game.launch_args, game.env_vars, game.work_dir, game.cover_path,
            game.banner_path, game.bg_path, game.notes, game.tags,
            game.favorite as i32, game.hidden as i32, game.total_seconds, game.play_count
        ],
    )?;
    drop(conn);
    get_game(state, game.id)
}

#[tauri::command(async)]
fn update_game(state: State<'_, AppState>, game: Game) -> AppResult<Game> {
    let conn = state.db.lock();
    conn.execute(
        "UPDATE games SET name = ?, install_dir = ?, exe_path = ?, launch_args = ?,
         env_vars = ?, work_dir = ?, cover_path = ?, banner_path = ?, bg_path = ?,
         notes = ?, tags = ?, favorite = ?, hidden = ?, total_seconds = ?, play_count = ?,
         updated_at = datetime('now') WHERE id = ?",
        params![
            game.name, game.install_dir, game.exe_path, game.launch_args,
            game.env_vars, game.work_dir, game.cover_path, game.banner_path, game.bg_path,
            game.notes, game.tags, game.favorite as i32, game.hidden as i32,
            game.total_seconds, game.play_count, game.id
        ],
    )?;
    drop(conn);
    get_game(state, game.id)
}

#[tauri::command(async)]
fn delete_game(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM games WHERE id = ?", [&id])?;
    Ok(())
}

// 拖拽排序：按传入的可见游戏 id 顺序批量写入 sort_order（事务原子，不碰 updated_at）
#[tauri::command(async)]
fn reorder_games(state: State<'_, AppState>, ordered_ids: Vec<String>) -> AppResult<()> {
    let mut conn = state.db.lock();
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("UPDATE games SET sort_order = ?1 WHERE id = ?2")?;
        for (i, id) in ordered_ids.iter().enumerate() {
            // 1 基（0 表示未参与排序，排末尾）；拖拽期间被删除的游戏 UPDATE 影响 0 行，跳过无害
            stmt.execute(params![i as i64 + 1, id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

// 把用户选择的本地图片设为游戏封面：复制到 covers/game_{id}.{ext} 并更新 cover_path
#[tauri::command(async)]
fn set_game_cover(state: State<'_, AppState>, game_id: String, source_path: String) -> AppResult<String> {
    let src = Path::new(&source_path);
    if !src.is_file() {
        return Err(AppError::Custom("封面文件不存在".to_string()));
    }
    // 校验图片魔数（JPEG/PNG/GIF/WebP/BMP），防止非图片文件入库
    let mut file = match std::fs::File::open(src) {
        Ok(f) => f,
        Err(_) => return Err(AppError::Custom("无法读取封面文件".to_string())),
    };
    let mut head = [0u8; 12];
    let n = std::io::Read::read(&mut file, &mut head).unwrap_or(0);
    let head = &head[..n];
    let is_image = n >= 4
        && (head.starts_with(&[0xFF, 0xD8, 0xFF]) // JPEG
            || head.starts_with(&[0x89, b'P', b'N', b'G']) // PNG
            || head.starts_with(b"GIF8") // GIF
            || (n >= 12 && head.starts_with(b"RIFF") && head[8..12] == *b"WEBP") // WebP
            || head.starts_with(b"BM")); // BMP
    if !is_image {
        return Err(AppError::Custom("不是有效的图片文件".to_string()));
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .filter(|e| matches!(e.as_str(), "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp"))
        .unwrap_or_else(|| "jpg".to_string());

    let covers_dir = state.data_dir.join("covers");
    let bytes = fs::read(src).map_err(|e| AppError::Custom(format!("读取封面失败: {}", e)))?;
    // 锁由 save_cover_bytes 内部按需短暂持有，写盘在锁外
    let cover = save_cover_bytes(&state.db, &covers_dir, &game_id, &bytes, &ext)?;
    Ok(cover)
}

// 写入封面文件（covers/game_{id}_{时间戳}.{ext}），清理该游戏旧的自定义封面并更新 cover_path。
// 文件名带时间戳：更换封面后路径必变 → 前端 img src 变化 → WebView 才会重新请求新图。
// （同名文件即使内容更新，浏览器也绝不会重新请求已加载的图片 —— 之前同扩展名更换封面不生效的根因）
//
// 锁由本函数自己按需短暂持有（两次，各只做一条 SQL），中间的删旧图/写新图在锁外做：
// 封面动辄几 MB，占着全局 DB 锁写盘会让同期的播放记账、库查询全排队
fn save_cover_bytes(
    db: &Arc<Mutex<Connection>>,
    covers_dir: &Path,
    game_id: &str,
    bytes: &[u8],
    ext: &str,
) -> AppResult<String> {
    if fs::create_dir_all(covers_dir).is_err() {
        return Err(AppError::Custom("无法创建封面目录".to_string()));
    }
    let ts = Utc::now().timestamp_millis();
    let target = covers_dir.join(format!("game_{}_{}.{}", game_id, ts, ext));
    // 删除该游戏之前的自定义封面（steam_* 等共享文件不动）
    let old: Option<String> = {
        let conn = db.lock();
        conn.query_row(
            "SELECT cover_path FROM games WHERE id = ?1",
            params![game_id],
            |r| r.get(0),
        )
        .ok()
    };
    if let Some(old) = old {
        let old_path = Path::new(&old);
        let prefix = format!("game_{}.", game_id);
        if old_path.starts_with(covers_dir)
            && old_path
                .file_name()
                .map(|f| f.to_string_lossy().starts_with(&prefix))
                .unwrap_or(false)
        {
            let _ = fs::remove_file(old_path);
        }
    }
    fs::write(&target, bytes).map_err(|e| AppError::Custom(format!("写入封面失败: {}", e)))?;
    let cover = target.to_string_lossy().to_string();
    {
        let conn = db.lock();
        conn.execute(
            "UPDATE games SET cover_path = ?1, updated_at = datetime('now') WHERE id = ?2",
            params![cover, game_id],
        )?;
    }
    Ok(cover)
}

// 把 API 返回的封面 URL 下载并设为游戏封面（SGDB 封面多为 PNG，按魔数定扩展名）
#[tauri::command]
async fn set_game_cover_url(state: State<'_, AppState>, game_id: String, url: String) -> AppResult<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let resp = client.get(&url).send().await?;
    if !resp.status().is_success() {
        return Err(AppError::Custom("封面下载失败".to_string()));
    }
    let bytes = resp.bytes().await?;
    let ext = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) { "png" } else { "jpg" };
    let covers_dir = state.data_dir.join("covers");
    let cover = save_cover_bytes(&state.db, &covers_dir, &game_id, &bytes, ext)?;
    Ok(cover)
}

// 把 API 返回的横屏封面 URL 下载并设为悬停封面：写 covers/banner_{game_id}_{时间戳}.{ext} 并更新 banner_path
// （时间戳同 save_cover_bytes：路径必变才能让 WebView 重新请求新图；清理旧的 banner_{game_id}.*；不碰 Steam 共享的 banner_{appid}.jpg）
#[tauri::command]
async fn set_game_banner_url(state: State<'_, AppState>, game_id: String, url: String) -> AppResult<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let resp = client.get(&url).send().await?;
    if !resp.status().is_success() {
        return Err(AppError::Custom("封面下载失败".to_string()));
    }
    let bytes = resp.bytes().await?;
    let ext = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) { "png" } else { "jpg" };
    let covers_dir = state.data_dir.join("covers");
    let ts = Utc::now().timestamp_millis();
    let target = covers_dir.join(format!("banner_{}_{}.{}", game_id, ts, ext));
    let target_name = target.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
    // 清理旧的同前缀文件（保留目标文件本身）
    if let Ok(entries) = fs::read_dir(&covers_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&format!("banner_{}.", game_id)) && name != target_name {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    fs::write(&target, &bytes).map_err(|e| AppError::Custom(format!("写入封面失败: {}", e)))?;
    let banner = target.to_string_lossy().to_string();
    let conn = state.db.lock();
    conn.execute(
        "UPDATE games SET banner_path = ?1, updated_at = datetime('now') WHERE id = ?2",
        params![banner, game_id],
    )?;
    Ok(banner)
}

// 拉取指定 SGDB 游戏引用的竖版封面候选（steam/{appid} 或 game/{sgdb_id}）
async fn sgdb_grids(client: &reqwest::Client, key: &str, game_ref: &str) -> AppResult<Vec<CoverOption>> {
    let grids_url = format!(
        "https://www.steamgriddb.com/api/v2/grids/{}?dimensions=600x900",
        game_ref
    );
    let resp = client
        .get(&grids_url)
        .header("Authorization", format!("Bearer {}", key))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(AppError::Custom("SteamGridDB 封面列表获取失败".to_string()));
    }
    #[derive(Deserialize)]
    struct GridsResp {
        data: Vec<GridItem>,
    }
    #[derive(Deserialize)]
    struct GridItem {
        url: String,
        thumb: String,
        width: i32,
        height: i32,
        style: String,
        author: Option<SgdbAuthor>,
    }

    let parsed: GridsResp = resp.json().await?;
    Ok(parsed
        .data
        .into_iter()
        .map(|g| CoverOption {
            url: g.url,
            thumb: g.thumb,
            width: g.width,
            height: g.height,
            style: g.style,
            author: g.author.map(|a| a.name).unwrap_or_default(),
        })
        .collect())
}

// 拉取指定 SGDB 游戏引用的横屏封面候选（heroes，1920×620）
async fn sgdb_heroes(client: &reqwest::Client, key: &str, game_ref: &str) -> AppResult<Vec<CoverOption>> {
    let url = format!(
        "https://www.steamgriddb.com/api/v2/heroes/{}?dimensions=1920x620",
        game_ref
    );
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", key))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(AppError::Custom("SteamGridDB 横屏封面获取失败".to_string()));
    }
    #[derive(Deserialize)]
    struct HeroesResp {
        data: Vec<HeroItem>,
    }
    #[derive(Deserialize)]
    struct HeroItem {
        url: String,
        thumb: String,
        width: i32,
        height: i32,
        style: String,
        author: Option<SgdbAuthor>,
    }

    let parsed: HeroesResp = resp.json().await?;
    Ok(parsed
        .data
        .into_iter()
        .map(|g| CoverOption {
            url: g.url,
            thumb: g.thumb,
            width: g.width,
            height: g.height,
            style: g.style,
            author: g.author.map(|a| a.name).unwrap_or_default(),
        })
        .collect())
}

// SGDB 按名称搜索（自动完成接口）：返回前 5 个匹配（名称完全匹配优先）
async fn sgdb_search_matches(
    client: &reqwest::Client,
    key: &str,
    name: &str,
) -> AppResult<Vec<(i64, String)>> {
    let search_url = format!(
        "https://www.steamgriddb.com/api/v2/search/autocomplete/{}",
        urlencoding::encode(name)
    );
    let resp = client
        .get(&search_url)
        .header("Authorization", format!("Bearer {}", key))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(AppError::Custom("SteamGridDB 搜索失败".to_string()));
    }
    #[derive(Deserialize)]
    struct SearchResp {
        data: Vec<SearchItem>,
    }
    #[derive(Deserialize)]
    struct SearchItem {
        id: i64,
        name: String,
    }
    let parsed: SearchResp = resp.json().await?;
    let mut matches: Vec<SearchItem> = parsed.data.into_iter().take(5).collect();
    matches.sort_by_key(|i| if i.name.to_lowercase() == name.to_lowercase() { 0 } else { 1 });
    Ok(matches.into_iter().map(|i| (i.id, i.name)).collect())
}

// 获取更换封面弹窗的候选列表：kind="wide" 取横屏（悬停封面，SGDB heroes + Steam 头图），
// 否则取竖版主封面。备注里的 Steam AppID 直查，否则按游戏名搜索 SGDB
#[tauri::command]
async fn fetch_cover_options(
    state: State<'_, AppState>,
    game_id: String,
    kind: String,
) -> AppResult<Vec<CoverOption>> {
    let (name, steam_appid, notes) = {
        let conn = state.db.lock();
        conn.query_row(
            "SELECT name, steam_appid, notes FROM games WHERE id = ?1",
            params![game_id],
            |r| Ok((
                r.get::<_, String>(0)?,
                r.get::<_, u64>(1)?,
                r.get::<_, String>(2)?,
            )),
        )?
    };
    let key: String = {
        let conn = state.db.lock();
        conn.query_row(
            "SELECT value FROM settings WHERE key = 'steamgriddb_api_key'",
            [],
            |r| r.get(0),
        )
        .unwrap_or_default()
    };
    if key.is_empty() {
        return Err(AppError::Custom(
            "未配置 SteamGridDB API Key，请到设置页填写".to_string(),
        ));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;
    let is_wide = kind == "wide";

    // Steam 导入的游戏：steam_appid 列直查该 AppID 的封面（旧数据兜底解析 notes）
    let appid = if steam_appid > 0 {
        Some(steam_appid)
    } else {
        notes
            .strip_prefix("Steam AppID: ")
            .and_then(|n| n.trim().parse::<u64>().ok())
    };
    if let Some(appid) = appid {
        if is_wide {
            let mut all = sgdb_heroes(&client, &key, &format!("steam/{}", appid)).await?;
            // Steam 官方头图（460×215）作为兜底选项
            let header_url = format!(
                "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/{}/header.jpg",
                appid
            );
            all.push(CoverOption {
                url: header_url.clone(),
                thumb: header_url,
                width: 460,
                height: 215,
                style: "official".to_string(),
                author: "Steam".to_string(),
            });
            return Ok(all);
        }
        return sgdb_grids(&client, &key, &format!("steam/{}", appid)).await;
    }

    // 手动添加的游戏：按名称搜索 SGDB，把所有匹配的封面合并展示
    // （部分搜索结果没有封面，部分只有少量，合并后用户可挑的更多）
    let matches = sgdb_search_matches(&client, &key, &name).await?;
    let mut all: Vec<CoverOption> = Vec::new();
    for (sgdb_id, _) in matches {
        let game_ref = format!("game/{}", sgdb_id);
        let opts = if is_wide {
            sgdb_heroes(&client, &key, &game_ref).await
        } else {
            sgdb_grids(&client, &key, &game_ref).await
        };
        if let Ok(opts) = opts {
            all.extend(opts);
        }
    }
    // 去重（不同匹配可能引用同一张图）
    all.sort_by(|a, b| a.url.cmp(&b.url));
    all.dedup_by(|a, b| a.url == b.url);
    Ok(all)
}

#[tauri::command(async)]
fn filter_games(state: State<'_, AppState>, filter: GameFilter) -> AppResult<Vec<Game>> {
    let conn = state.db.lock();
    let mut sql = String::from(
        "SELECT id, name, install_dir, exe_path, launch_args, env_vars, work_dir,
                cover_path, banner_path, bg_path, notes, tags, favorite, hidden,
                total_seconds, play_count, created_at, updated_at, sort_order, steam_appid
         FROM games WHERE 1=1"
    );
    let mut args: Vec<String> = Vec::new();

    if let Some(fav) = filter.favorite {
        sql.push_str(" AND favorite = ?");
        args.push(if fav { "1" } else { "0" }.to_string());
    }
    if let Some(hid) = filter.hidden {
        sql.push_str(" AND hidden = ?");
        args.push(if hid { "1" } else { "0" }.to_string());
    }
    if let Some(min_s) = filter.min_seconds {
        sql.push_str(" AND total_seconds >= ?");
        args.push(min_s.to_string());
    }
    if let Some(ref search) = filter.search {
        if !search.is_empty() {
            sql.push_str(" AND (name LIKE ? OR notes LIKE ? OR tags LIKE ?)");
            let pattern = format!("%{}%", search);
            args.push(pattern.clone());
            args.push(pattern.clone());
            args.push(pattern);
        }
    }
    // 排序：白名单字段（name/created_at/updated_at/total_seconds × asc/desc）；自定义/未指定 = 手动顺序
    let dir = if filter.sort_order.as_deref() == Some("desc") { "DESC" } else { "ASC" };
    let order_clause = match filter.sort_by.as_deref() {
        Some("name") | Some("created_at") | Some("updated_at") | Some("total_seconds") => {
            format!(" ORDER BY {} {}, id", filter.sort_by.as_deref().unwrap(), dir)
        }
        _ => " ORDER BY CASE WHEN sort_order = 0 THEN 1 ELSE 0 END, sort_order, created_at, id"
            .to_string(),
    };
    sql.push_str(&order_clause);

    let mut stmt = conn.prepare(&sql)?;
    let params: Vec<&dyn rusqlite::ToSql> = args.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let rows = stmt.query_map(params.as_slice(), |row| {
        Ok(Game {
            id: row.get(0)?,
            name: row.get(1)?,
            install_dir: row.get(2)?,
            exe_path: row.get(3)?,
            launch_args: row.get(4)?,
            env_vars: row.get(5)?,
            work_dir: row.get(6)?,
            cover_path: row.get(7)?,
            banner_path: row.get(8)?,
            bg_path: row.get(9)?,
            notes: row.get(10)?,
            tags: row.get(11)?,
            favorite: row.get::<_, i32>(12)? != 0,
            hidden: row.get::<_, i32>(13)? != 0,
            total_seconds: row.get(14)?,
            play_count: row.get(15)?,
            created_at: row.get(16)?,
            updated_at: row.get(17)?,
            sort_order: row.get(18)?,
            steam_appid: row.get::<_, i64>(19)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

// ─────────────────────────────────────────────
// Tauri Commands - Steam Scanning
// ─────────────────────────────────────────────

// 自动检测 Steam 安装路径
fn detect_steam_path() -> AppResult<String> {
    #[cfg(windows)]
    if let Some(path) = steam_path_from_registry() {
        return Ok(path);
    }

    for candidate in [r"C:\Program Files (x86)\Steam", r"C:\Program Files\Steam"] {
        if Path::new(candidate).join("steam.exe").exists() {
            return Ok(candidate.to_string());
        }
    }

    Err(AppError::Custom(
        "未找到 Steam 安装。请确认 Steam 已安装并至少运行过一次。".to_string(),
    ))
}

// 从注册表 HKCU\Software\Valve\Steam 读取 Steam 安装路径（Steam 以正斜杠写入，需归一化）
#[cfg(windows)]
fn steam_path_from_registry() -> Option<String> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu.open_subkey("Software\\Valve\\Steam").ok()?;
    let path: String = key.get_value("SteamPath").ok()?;
    let path = path.replace('/', "\\");
    if Path::new(&path).join("steam.exe").exists() {
        Some(path)
    } else {
        None
    }
}

#[cfg(not(windows))]
fn steam_path_from_registry() -> Option<String> {
    None
}

/// 读取 Steam 端累计已玩分钟（localconfig.vdf 的 Playtime）。
///
/// 路径不固定：`<steam_root>/userdata/<account_id32>/config/localconfig.vdf`，
/// 每账户一个目录 → **遍历全部账户并求和**（同游戏多账户合并 = 这台机器的总时长）。
///
/// 可读性保障（逐层降级，任何一层失败都不向调用方传播错误）：
/// - userdata 不存在 / 无 localconfig.vdf → 返回空 map（调用方按 0 处理）
/// - 单个文件损坏（Steam 写入中间态 / 半截文件）→ 跳过该账户，其余照常合并
/// - 单条目缺 Playtime 字段 → 该游戏记 0
fn read_steam_playtimes(steam_root: &str) -> HashMap<i64, i64> {
    let mut merged: HashMap<i64, i64> = HashMap::new();
    let re_appid = regex::Regex::new(r#"^"(\d+)"\s*\{?"#).unwrap();
    let re_playtime = regex::Regex::new(r#"^"Playtime"\s*"(\d+)""#).unwrap();

    let userdata = Path::new(steam_root).join("userdata");
    let Ok(entries) = fs::read_dir(&userdata) else { return merged };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let lc = entry.path().join("config").join("localconfig.vdf");
        let Ok(content) = fs::read_to_string(&lc) else { continue };
        // 定位 "apps" 段（Software → Valve → Steam → apps）的起始花括号
        let Some(apps_pos) = content.find(r#""apps""#) else { continue };
        let rest = &content[apps_pos..];
        let Some(open) = rest.find('{') else { continue };
        // 段内逐行扫描：括号计数圈定 apps 段边界（VDF 每行一个元素）。
        // Playtime2wks 不匹配 re_playtime（"Playtime" 后必须紧跟引号），天然跳过
        let mut cur: Option<i64> = None; // 当前 appid 块
        let mut depth = 0usize;
        for line in rest[open..].lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Some(cap) = re_appid.captures(line) {
                cur = cap[1].parse::<i64>().ok();
            } else if let Some(cap) = re_playtime.captures(line) {
                if let Some(appid) = cur {
                    if let Ok(pt) = cap[1].parse::<i64>() {
                        *merged.entry(appid).or_insert(0) += pt; // 多账户求和
                    }
                }
            }
            let opens = line.matches('{').count();
            let closes = line.matches('}').count();
            if opens > 0 {
                depth += opens;
            }
            if closes > 0 {
                depth = depth.saturating_sub(closes);
                if depth == 0 {
                    break; // apps 段收尾
                }
            }
        }
    }
    merged
}

#[tauri::command(async)]
fn scan_steam_library(
    state: State<'_, AppState>,
    steam_path: Option<String>,
) -> AppResult<Vec<SteamGame>> {
    // 未传入路径时自动检测 Steam 安装位置
    let steam_path = match steam_path {
        Some(p) if !p.trim().is_empty() => p,
        _ => detect_steam_path()?,
    };

    let steam_root = PathBuf::from(&steam_path);
    if !steam_root.join("steam.exe").exists() {
        return Err(AppError::Custom(format!(
            "指定的 Steam 路径不存在: {}",
            steam_path
        )));
    }

    let libraryfolders_path = steam_root.join("steamapps\\libraryfolders.vdf");
    if !libraryfolders_path.exists() {
        return Err(AppError::Custom(
            "未找到 libraryfolders.vdf。请先运行一次 Steam 以初始化游戏库。".to_string(),
        ));
    }

    let content = fs::read_to_string(&libraryfolders_path)?;
    let mut games = Vec::new();

    // 解析 libraryfolders.vdf 获取所有游戏库路径
    let mut lib_paths = vec![steam_path.clone()];
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with("\"path\"") {
            if let Some(path) = line.split("\"path\"").nth(1) {
                let parts: Vec<&str> = path.split('"').collect();
                if parts.len() >= 2 {
                    let p = parts[1].replace("\\\\", "\\");
                    if !p.is_empty() && std::path::Path::new(&p).exists() {
                        lib_paths.push(p);
                    }
                }
            }
        }
    }

    // 扫描每个库目录
    for lib_path in &lib_paths {
        let steamapps = PathBuf::from(lib_path).join("steamapps");
        if !steamapps.exists() {
            continue;
        }

        if let Ok(entries) = fs::read_dir(&steamapps) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("appmanifest_") && name.ends_with(".acf") {
                    if let Ok(acf_content) = fs::read_to_string(entry.path()) {
                        if let Some(game) = parse_acf(&acf_content, lib_path) {
                            games.push(game);
                        }
                    }
                }
            }
        }
    }

    // 填充 Steam 端已玩时长（localconfig.vdf，多账户求和；读不到则全 0）
    let playtimes = read_steam_playtimes(&steam_path);
    for g in &mut games {
        g.playtime_minutes = playtimes.get(&(g.app_id as i64)).copied().unwrap_or(0);
    }

    // 标记已导入：一次查库收集全部 steam_appid（手动添加的 appid=0 天然不算）
    let imported_ids: std::collections::HashSet<i64> = {
        let conn = state.db.lock();
        let mut stmt = conn.prepare("SELECT steam_appid FROM games WHERE steam_appid > 0")?;
        let ids = stmt
            .query_map([], |r| r.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().collect()
    };
    for g in &mut games {
        g.already_imported = imported_ids.contains(&(g.app_id as i64));
    }

    games.sort_by(|a, b| a.name.cmp(&b.name));
    games.dedup_by(|a, b| a.app_id == b.app_id);
    Ok(games)
}

fn parse_acf(acf_content: &str, lib_path: &str) -> Option<SteamGame> {
    let mut name = String::new();
    let mut app_id = String::new();
    let mut install_dir = String::new();

    for line in acf_content.lines() {
        let line = line.trim();
        if line.starts_with("\"name\"") {
            let parts: Vec<&str> = line.splitn(2, "\t").collect();
            if parts.len() > 1 {
                name = parts[1].trim().trim_matches('"').trim_matches(',').to_string();
            }
        } else if line.starts_with("\"appid\"") {
            let parts: Vec<&str> = line.splitn(2, "\t").collect();
            if parts.len() > 1 {
                app_id = parts[1].trim().trim_matches('"').trim_matches(',').to_string();
            }
        } else if line.starts_with("\"installdir\"") {
            let parts: Vec<&str> = line.splitn(2, "\t").collect();
            if parts.len() > 1 {
                install_dir = parts[1].trim().trim_matches('"').trim_matches(',').to_string();
            }
        }
    }

    if name.is_empty() || app_id.is_empty() || install_dir.is_empty() {
        return None;
    }

    let game_path = PathBuf::from(lib_path)
        .join("steamapps\\common")
        .join(&install_dir);

    // 尝试找可执行文件
    let exe_path = find_steam_exe(&game_path, &name);

    Some(SteamGame {
        name,
        app_id: app_id.parse().unwrap_or(0),
        install_dir: game_path.to_string_lossy().to_string(),
        exe_path,
        playtime_minutes: 0, // 由 scan_steam_library 末尾统一回填
        already_imported: false, // 同上
    })
}

// 在游戏目录内递归查找主可执行文件（限深 5 层，很多游戏 exe 在 game/bin/win64 等深层目录）。
// 过滤常见非主程序（服务器/卸载器/崩溃处理器/工具链等），打分：文件名与游戏名匹配 > 名称含 x64 > 路径浅。
// 找不到返回空字符串（不再返回目录路径——那会让启动时报「拒绝访问」）
fn find_steam_exe(game_path: &PathBuf, game_name: &str) -> String {
    let game_key: String = game_name
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect();
    let junk = [
        "unins", "crash", "redist", "setup", "installer", "launcher", "dedicated", "server",
        "battleye", "battle", "beclient", "unity", "console", "vconsole", "mdl", "dmx",
        "compiler", "build_econ", "workshop", "handler", "cfg", "ggsetup", "dxset", "shim",
        "nullrenderer", "test",
    ];
    let mut best: Option<(i32, PathBuf)> = None;
    let mut stack = vec![(game_path.clone(), 0usize)];
    let mut visited = std::collections::HashSet::new();
    while let Some((dir, depth)) = stack.pop() {
        if depth > 5 || !visited.insert(dir.clone()) {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push((path, depth + 1));
                continue;
            }
            let Some(ext) = path.extension() else { continue };
            if !ext.eq_ignore_ascii_case("exe") {
                continue;
            }
            let name_lower = path
                .file_name()
                .map(|n| n.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if junk.iter().any(|k| name_lower.contains(k)) {
                continue;
            }
            let stem_key: String = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_lowercase())
                .unwrap_or_default()
                .chars()
                .filter(|c| c.is_alphanumeric())
                .collect();
            let mut score = 0i32;
            if !game_key.is_empty() && stem_key.contains(&game_key) {
                score += 100; // 文件名包含完整游戏名（如 helldivers2 / kenshi_x64）
            } else if !game_key.is_empty() && game_key.contains(&stem_key) && !stem_key.is_empty() {
                score += 60; // 游戏名包含文件名（如 cs2 / deadlock / dontstarve）
            }
            if name_lower.contains("x64") || name_lower.contains("_64") {
                score += 5;
            }
            score -= (depth as i32) * 3; // 浅层优先
            match &best {
                Some((bs, _)) if *bs >= score => {}
                _ => best = Some((score, path)),
            }
        }
    }
    best.map(|(_, p)| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

// 解析 steamapps/libraryfolders.vdf，返回所有游戏库路径（每行形如 `"path"	"D:\\SteamLibrary"`）
fn steam_library_dirs(steam_root: &Path) -> Vec<PathBuf> {
    let Ok(content) = fs::read_to_string(steam_root.join("steamapps/libraryfolders.vdf")) else {
        return Vec::new();
    };
    let mut dirs = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if let Some(i) = line.find("\"path\"") {
            let rest = &line[i + 6..];
            if let Some(q1) = rest.find('"') {
                let inner = &rest[q1 + 1..];
                if let Some(q2) = inner.find('"') {
                    let p = inner[..q2].replace("\\\\", "\\");
                    if !p.is_empty() {
                        dirs.push(PathBuf::from(p));
                    }
                }
            }
        }
    }
    dirs
}

// 在目录里按文件名前缀找第一张图片。
// 新 Steam 客户端每游戏目录内的文件带语言后缀（如 library_600x900_schinese.jpg / header_schinese.jpg），
// 前缀匹配兼容所有语言（schinese / english / 无后缀等）
fn first_matching_file(dir: &Path, prefixes: &[&str]) -> Option<PathBuf> {
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path.file_name()?.to_string_lossy().to_lowercase();
        for p in prefixes {
            let p = p.to_lowercase();
            if name.starts_with(&p)
                && (name.ends_with(".jpg") || name.ends_with(".jpeg") || name.ends_with(".png"))
            {
                return Some(path);
            }
        }
    }
    None
}

// 从 Steam 本地缓存复制封面/头图到 covers/（纯本地，零网络），候选依次为：
// 1) <steam_root>/appcache/librarycache/{appid}/ 目录内前缀匹配 —— 新客户端结构（实测文件名带 _schinese 语言后缀）
// 2) <steam_root>/appcache/librarycache/{appid}_{flat} —— 旧客户端平铺文件（扩展名 .jpeg 不是 .jpg）
// 3) <steam_root>/userdata/*/config/grid/{appid}{grid_name} —— 用户自定义封面（SteamGridDB 等工具写入）
// 4) 各游戏库 <lib>/steamapps/librarycache/{appid}/ 目录内前缀匹配
// 目标文件已存在（之前复制过）直接复用；所有候选都不存在返回 None（不设封面，可右键手动更换）
fn local_cover(
    data_dir: &Path,
    app_id: u64,
    steam_root: Option<&Path>,
    library_dirs: &[PathBuf],
    cache_prefixes: &[&str],
    flat_names: &[&str],
    grid_names: &[&str],
    out_name: &str,
) -> Option<String> {
    let covers_dir = data_dir.join("covers");
    let out = covers_dir.join(out_name);
    if out.exists() {
        return Some(out.to_string_lossy().to_string());
    }
    if fs::create_dir_all(&covers_dir).is_err() {
        return None;
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(root) = steam_root {
        // 1) 新客户端每游戏目录（语言后缀命名）
        let app_dir = root
            .join("appcache")
            .join("librarycache")
            .join(app_id.to_string());
        if let Some(f) = first_matching_file(&app_dir, cache_prefixes) {
            candidates.push(f);
        }
        // 2) 旧客户端平铺文件
        for name in flat_names {
            candidates.push(
                root.join("appcache")
                    .join("librarycache")
                    .join(format!("{}_{}", app_id, name)),
            );
        }
        // 3) 用户自定义封面（遍历所有账号的 userdata）
        if let Ok(entries) = fs::read_dir(root.join("userdata")) {
            for entry in entries.flatten() {
                let grid_dir = entry.path().join("config").join("grid");
                if !grid_dir.is_dir() {
                    continue;
                }
                for name in grid_names {
                    candidates.push(grid_dir.join(format!("{}{}", app_id, name)));
                }
            }
        }
        // 4) 各游戏库的每游戏资产目录
        for lib in library_dirs {
            let app_dir2 = lib
                .join("steamapps")
                .join("librarycache")
                .join(app_id.to_string());
            if let Some(f) = first_matching_file(&app_dir2, cache_prefixes) {
                candidates.push(f);
            }
        }
    }
    for c in candidates {
        if c.exists() && fs::copy(&c, &out).is_ok() {
            return Some(out.to_string_lossy().to_string());
        }
    }
    None
}

// Steam CDN 下载竖版封面：依次尝试 600x900 → 600x900_2x（高清）→ header 兜底
// 下载 URL 到字节（仅 200 + 非空视为成功）
async fn download_bytes(client: &reqwest::Client, url: &str) -> Option<Vec<u8>> {
    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    if bytes.is_empty() { None } else { Some(bytes.to_vec()) }
}

/// 商店页 og:image 兜底：新上架游戏的资产可能不在标准 CDN 路径
/// （如 Escape from Tarkov 的图片带 hash 子路径），从商店页 meta 标签解析真实图片 URL。
/// 校验 URL 必须包含 `/apps/{app_id}/`——无效 AppID 会被重定向到首页，
/// 首页 og:image 不含该路径，据此拦截。
async fn fetch_steam_og_image(app_id: u64, client: &reqwest::Client) -> Option<String> {
    let page = client
        .get(format!("https://store.steampowered.com/app/{}/", app_id))
        .send()
        .await
        .ok()?;
    if !page.status().is_success() {
        return None;
    }
    let html = page.text().await.ok()?;
    let re_tag = regex::Regex::new(r#"<meta[^>]*og:image[^>]*>"#).unwrap();
    let re_content = regex::Regex::new(r#"content="([^"]+)""#).unwrap();
    let tag = re_tag.captures(&html)?;
    let url = re_content.captures(&tag[0])?.get(1)?.as_str().to_string();
    if url.contains(&format!("/apps/{}/", app_id)) {
        Some(url)
    } else {
        None
    }
}

async fn download_steam_cover(
    app_id: u64,
    covers_dir: PathBuf,
    client: reqwest::Client,
    sgdb_key: Option<&str>,
) -> Option<PathBuf> {
    let path = covers_dir.join(format!("steam_{}.jpg", app_id));
    if path.exists() {
        return Some(path);
    }
    for url in [
        format!(
            "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/{}/library_600x900.jpg",
            app_id
        ),
        format!(
            "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/{}/library_600x900_2x.jpg",
            app_id
        ),
        format!(
            "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/{}/header.jpg",
            app_id
        ),
    ] {
        let resp = match client.get(&url).send().await {
            Ok(r) => r,
            Err(_) => continue, // 网络错误尝试下一个候选
        };
        if !resp.status().is_success() {
            continue; // 404/403 等，换下一个
        }
        let bytes = match resp.bytes().await {
            Ok(b) if !b.is_empty() => b,
            _ => continue,
        };
        if fs::write(&path, &bytes).is_ok() {
            return Some(path);
        }
    }
    // 兜底：SGDB 竖版封面（官方没有竖版资产的游戏，如 Escape from Tarkov）。
    // 优先于 og:image——后者是横图，只能当最后保底。
    // 需要设置里配过 steamgriddb_api_key；SGDB 多为 PNG，按魔数定扩展名
    if let Some(key) = sgdb_key {
        if let Ok(options) = sgdb_grids(&client, key, &format!("steam/{}", app_id)).await {
            if let Some(first) = options.into_iter().next() {
                if let Some(bytes) = download_bytes(&client, &first.url).await {
                    let ext = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
                        "png"
                    } else {
                        "jpg"
                    };
                    let file = covers_dir.join(format!("steam_{}_sgdb.{}", app_id, ext));
                    if fs::write(&file, &bytes).is_ok() {
                        return Some(file);
                    }
                }
            }
        }
    }
    // 兜底：商店页 og:image（hash 子路径等非标准结构的资产；横图，仅作最后保底）
    let fallback = covers_dir.join(format!("steam_{}_og.jpg", app_id));
    if fallback.exists() {
        return Some(fallback);
    }
    if let Some(og_url) = fetch_steam_og_image(app_id, &client).await {
        if let Some(bytes) = download_bytes(&client, &og_url).await {
            if fs::write(&fallback, &bytes).is_ok() {
                return Some(fallback);
            }
        }
    }
    None
}

// Steam CDN 下载横屏头图（header.jpg）
/// 官方 appdetails API 拉取资产 URL：新上架游戏（如 Escape from Tarkov）的资产
/// 带 hash 子路径、标准 CDN 路径 404，但 API 的 header_image 就是 460×215 官方 header，
/// 与其他游戏同比例。
struct SteamApiAssets {
    header_image: Option<String>,
}

async fn fetch_steam_api_assets(app_id: u64, client: &reqwest::Client) -> Option<SteamApiAssets> {
    let resp = client
        .get(format!(
            "https://store.steampowered.com/api/appdetails?appids={}",
            app_id
        ))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let text = resp.text().await.ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let data = v.get(&app_id.to_string())?.get("data")?;
    Some(SteamApiAssets {
        header_image: data.get("header_image").and_then(|v| v.as_str()).map(String::from),
    })
}

async fn download_steam_banner(app_id: u64, covers_dir: PathBuf, client: reqwest::Client) -> Option<PathBuf> {
    let path = covers_dir.join(format!("banner_{}.jpg", app_id));
    if path.exists() {
        return Some(path);
    }
    // 1) 标准 CDN 路径（绝大多数游戏）
    let url = format!(
        "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/{}/header.jpg",
        app_id
    );
    if let Ok(resp) = client.get(&url).send().await {
        if resp.status().is_success() {
            if let Ok(bytes) = resp.bytes().await {
                if !bytes.is_empty() && fs::write(&path, &bytes).is_ok() {
                    return Some(path);
                }
            }
        }
    }
    // 2) appdetails API 的 header_image（hash 子路径资产，460×215 同比例，如 Tarkov）
    if let Some(api_url) = fetch_steam_api_assets(app_id, &client)
        .await
        .and_then(|a| a.header_image)
    {
        if let Some(bytes) = download_bytes(&client, &api_url).await {
            if fs::write(&path, &bytes).is_ok() {
                return Some(path);
            }
        }
    }
    // 3) 最后保底：商店页 og:image（capsule 横图，比例不同但至少有一张）
    let fallback = covers_dir.join(format!("banner_{}_og.jpg", app_id));
    if fallback.exists() {
        return Some(fallback);
    }
    if let Some(og_url) = fetch_steam_og_image(app_id, &client).await {
        if let Some(bytes) = download_bytes(&client, &og_url).await {
            if fs::write(&fallback, &bytes).is_ok() {
                return Some(fallback);
            }
        }
    }
    None
}

#[derive(Clone, Serialize)]
struct CoverFetchProgress {
    done: usize,
    total: usize,
    ok: usize,
    fail: usize,
}

#[derive(Serialize)]
struct CoverFetchResult {
    total: usize,
    ok: usize,
    fail: usize,
}

// 手动触发（设置页按钮）：为所有缺封面/横幅的 Steam 游戏从 Steam CDN 下载补齐。
// 只处理 steam_appid 列 > 0 的游戏（旧数据兜底匹配 notes = "Steam AppID: {appid}"），
// 并发 8；每完成一个 emit "cover-fetch-progress" 事件刷新进度
#[tauri::command]
async fn fetch_all_steam_covers(app: tauri::AppHandle, state: State<'_, AppState>) -> AppResult<CoverFetchResult> {
    let jobs: Vec<(String, u64, bool, bool)> = {
        let conn = state.db.lock();
        let mut stmt = conn.prepare(
            "SELECT id, steam_appid, notes, cover_path, banner_path FROM games
             WHERE steam_appid > 0 OR notes LIKE 'Steam AppID: %'",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?;
        rows.filter_map(Result::ok)
            .filter_map(|(id, steam_appid, notes, cover, banner)| {
                let app_id = if steam_appid > 0 {
                    steam_appid
                } else {
                    notes.trim_start_matches("Steam AppID: ").trim().parse().ok()?
                };
                Some((id, app_id, cover.is_empty(), banner.is_empty()))
            })
            .filter(|(_, _, need_cover, need_banner)| *need_cover || *need_banner)
            .collect()
    };
    let total = jobs.len();
    let data_dir = state.data_dir.clone();
    let db = state.db.clone();
    // SGDB key：官方无竖版资产的游戏（如 Tarkov）兜底用社区竖版封面
    let sgdb_key: Option<String> = {
        let conn = state.db.lock();
        conn.query_row(
            "SELECT value FROM settings WHERE key = 'steamgriddb_api_key'",
            [],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten()
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;
    let sem = Arc::new(tokio::sync::Semaphore::new(8));
    let mut handles = Vec::with_capacity(jobs.len());
    for (id, app_id, need_cover, need_banner) in jobs {
        let (sem_c, data_c, db_c, client_c, key_c) =
            (sem.clone(), data_dir.clone(), db.clone(), client.clone(), sgdb_key.clone());
        handles.push(tokio::spawn(async move {
            let _permit = sem_c.acquire_owned().await.ok()?;
            let covers_dir = data_c.join("covers");
            let _ = fs::create_dir_all(&covers_dir);
            let mut ok = 0usize;
            let mut fail = 0usize;
            if need_cover {
                if let Some(path) = download_steam_cover(app_id, covers_dir.clone(), client_c.clone(), key_c.as_deref()).await {
                    let conn = db_c.lock();
                    let _ = conn.execute(
                        "UPDATE games SET cover_path = ?1, updated_at = ?2 WHERE id = ?3",
                        params![path.to_string_lossy().to_string(), Utc::now().to_rfc3339(), id],
                    );
                    ok += 1;
                } else {
                    fail += 1;
                }
            }
            if need_banner {
                if let Some(path) = download_steam_banner(app_id, covers_dir, client_c).await {
                    let conn = db_c.lock();
                    let _ = conn.execute(
                        "UPDATE games SET banner_path = ?1, updated_at = ?2 WHERE id = ?3",
                        params![path.to_string_lossy().to_string(), Utc::now().to_rfc3339(), id],
                    );
                    ok += 1;
                } else {
                    fail += 1;
                }
            }
            Some((ok, fail))
        }));
    }
    let mut ok = 0usize;
    let mut fail = 0usize;
    let mut done = 0usize;
    for handle in handles {
        if let Some((o, f)) = handle.await.ok().flatten() {
            ok += o;
            fail += f;
        }
        done += 1;
        // 主循环累计进度：done 是已完成的游戏数（每游戏封面+横幅算一档）
        let _ = app.emit("cover-fetch-progress", CoverFetchProgress { done, total, ok, fail });
    }
    Ok(CoverFetchResult { total, ok, fail })
}

#[tauri::command]
async fn import_steam_games(state: State<'_, AppState>, steam_games: Vec<SteamGame>) -> AppResult<Vec<Game>> {
    // 封面下载任务：existing_id 命中 = 老游戏补封面；game 有值 = 新游戏待插入
    struct CoverJob {
        app_id: u64,
        existing_id: Option<String>,
        game: Option<Game>,
    }

    // 第一阶段：逐个查库判断去重，收集需要下载封面的任务（锁只在单次查询内持有）
    let mut jobs: Vec<CoverJob> = Vec::new();
    for sg in steam_games {
        let existing: Option<(String, String)> = {
            let conn = state.db.lock();
            conn.query_row(
                "SELECT id, cover_path FROM games WHERE steam_appid = ?1",
                params![sg.app_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
        };
        match existing {
            // 已导入且有封面：跳过
            Some((_, cover)) if !cover.is_empty() => continue,
            // 已导入但缺封面：补下载
            Some((id, _)) => {
                jobs.push(CoverJob {
                    app_id: sg.app_id,
                    existing_id: Some(id),
                    game: None,
                });
            }
            // 未导入：新游戏
            None => {
                let game = Game {
                    id: Uuid::new_v4().to_string(),
                    name: sg.name,
                    install_dir: sg.install_dir.clone(),
                    exe_path: sg.exe_path,
                    launch_args: String::new(), // 直接启动游戏 exe，不传 steam.exe 专用的 -applaunch
                    env_vars: "{}".to_string(),
                    work_dir: sg.install_dir,
                    cover_path: String::new(),
                    banner_path: String::new(),
                    bg_path: String::new(),
                    notes: String::new(), // 不再自动写入 "Steam AppID: xxx"，appid 存 steam_appid 列
                    tags: "[]".to_string(),
                    favorite: false,
                    hidden: false,
                    // 同步 Steam 端已玩时长：Playtime(分钟) × 60 秒；读不到时为 0（与手动添加一致）
                    total_seconds: sg.playtime_minutes * 60,
                    play_count: 0,
                    created_at: Utc::now().to_rfc3339(),
                    updated_at: Utc::now().to_rfc3339(),
                    sort_order: 0,
                    steam_appid: sg.app_id as i64,
                };
                jobs.push(CoverJob {
                    app_id: sg.app_id,
                    existing_id: None,
                    game: Some(game),
                });
            }
        }
    }

    // 第二阶段：仅从 Steam 本地缓存复制封面与横屏头图（纯本地，零网络）。
    // 本地没有的封面就不设，之后可在右键菜单里手动更换
    let data_dir = state.data_dir.clone();
    let steam_root = detect_steam_path().ok().map(PathBuf::from);
    let library_dirs = steam_root
        .as_ref()
        .map(|r| steam_library_dirs(r))
        .unwrap_or_default();
    let mut cover_paths = Vec::with_capacity(jobs.len());
    let mut banner_paths = Vec::with_capacity(jobs.len());
    for job in &jobs {
        cover_paths.push(local_cover(
            &data_dir,
            job.app_id,
            steam_root.as_deref(),
            &library_dirs,
            &["library_600x900"], // 新客户端：每游戏目录内前缀匹配（可能带 _schinese 等语言后缀）
            &["library_600x900.jpeg", "library_600x900.jpg"], // 旧客户端平铺
            &["p.jpg", "p.png"], // 自定义竖版封面
            &format!("steam_{}.jpg", job.app_id),
        ));
        banner_paths.push(local_cover(
            &data_dir,
            job.app_id,
            steam_root.as_deref(),
            &library_dirs,
            &["header"], // 新客户端：目录内前缀匹配
            &["header.jpeg", "header.jpg"], // 旧客户端平铺
            &["header.jpg", "_hero.jpg"], // 自定义横屏头图
            &format!("banner_{}.jpg", job.app_id),
        ));
    }

    // 第三阶段：写库（锁只在单次执行内持有）
    let mut imported = Vec::new();
    for (job, (cover, banner)) in jobs
        .into_iter()
        .zip(cover_paths.into_iter().zip(banner_paths))
    {
        if let Some(id) = job.existing_id {
            // 老游戏补封面 / 横屏头图（两者独立，谁下载成功写谁）
            let conn = state.db.lock();
            if let Some(cover) = cover {
                conn.execute(
                    "UPDATE games SET cover_path = ?1, updated_at = ?2 WHERE id = ?3",
                    params![cover, Utc::now().to_rfc3339(), id],
                )?;
            }
            if let Some(banner) = banner {
                conn.execute(
                    "UPDATE games SET banner_path = ?1, updated_at = ?2 WHERE id = ?3",
                    params![banner, Utc::now().to_rfc3339(), id],
                )?;
            }
            drop(conn);
            continue;
        }
        let mut game = match job.game {
            Some(g) => g,
            None => continue,
        };
        game.cover_path = cover.unwrap_or_default();
        game.banner_path = banner.unwrap_or_default();
        let conn = state.db.lock();
        conn.execute(
            "INSERT OR IGNORE INTO games (id, name, install_dir, exe_path, launch_args,
             env_vars, work_dir, cover_path, banner_path, bg_path, notes, tags,
             favorite, hidden, total_seconds, play_count, steam_appid)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                game.id, game.name, game.install_dir, game.exe_path,
                game.launch_args, game.env_vars, game.work_dir, game.cover_path,
                game.banner_path, game.bg_path, game.notes, game.tags,
                game.favorite as i32, game.hidden as i32, game.total_seconds, game.play_count,
                job.app_id
            ],
        )?;
        drop(conn);
        imported.push(game);
    }
    Ok(imported)
}

// ─────────────────────────────────────────────
// Tauri Commands - Game Sessions / Process Tracking
// ─────────────────────────────────────────────

#[tauri::command(async)]
fn launch_game(state: State<'_, AppState>, game_id: String) -> AppResult<String> {
    let game = get_game(state.clone(), game_id.clone())?;

    // 统一直接启动 exe，永远不走 steam://rungameid：
    // Steam 客户端按自己的 libraryfolders.vdf 找游戏文件，游戏被磁盘管理移动后 Steam 找不到位置（报缺失文件）。
    // 直接启动 exe 只依赖 ZEX 数据库里的 exe_path，移动时已更新为新路径，可靠。
    let exe = &game.exe_path;
    let args = &game.launch_args;
    // 工作目录：work_dir → install_dir → exe 所在目录。
    // 手动添加的游戏常只填了 exe 路径（install/work_dir 均空），空字符串
    // current_dir 会让 spawn 直接失败（ERROR_INVALID_NAME，此前 DSX 打不开的根因）
    let work_dir = if !game.work_dir.is_empty() {
        game.work_dir.clone()
    } else if !game.install_dir.is_empty() {
        game.install_dir.clone()
    } else {
        Path::new(exe)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default()
    };

    let exe_path = Path::new(exe);
    let exe_usable = !exe.is_empty() && exe_path.exists() && !exe_path.is_dir();
    if !exe_usable {
        return Err(AppError::Custom(
            if exe.is_empty() {
                "未设置游戏可执行文件，请在详情中编辑「启动路径」".to_string()
            } else if exe_path.is_dir() {
                "启动路径指向的是文件夹而非可执行文件，请在详情中编辑「启动路径」".to_string()
            } else {
                "游戏可执行文件不存在，请在详情中编辑「启动路径」".to_string()
            },
        ));
    }

    let mut cmd = std::process::Command::new(exe);
    if !args.is_empty() {
        // 解析 launch_args，支持空格分隔
        for arg in args.split_whitespace() {
            cmd.arg(arg);
        }
    }
    // 工作目录可能为空（兜底也解析失败等极端情况）：不设置 current_dir，
    // 让进程继承 ZEX 的工作目录即可，绝不能再传空字符串（spawn 会失败）
    if !work_dir.is_empty() {
        cmd.current_dir(&work_dir);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // 解析环境变量
    if !game.env_vars.is_empty() && game.env_vars != "{}" {
        if let Ok(vars) = serde_json::from_str::<HashMap<String, String>>(&game.env_vars) {
            for (k, v) in vars {
                cmd.env(&k, &v);
            }
        }
    }

    let child = cmd.spawn()?;
    let pid = child.id();

    let session = GameSession {
        game_id: game_id.clone(),
        process_id: pid,
        start_time: Utc::now(),
        launch_start: Utc::now(),
        exe_path: exe.clone(),
        install_dir: game.install_dir.clone(),
        process_seen: true, // 直接 spawn 的进程，PID 即运行证据
        miss_count: 0,
        no_window_polls: 0,
        accumulated: 0,
    };

    {
        let mut sessions = state.running_games.write();
        sessions.insert(game_id.clone(), session);
    }

    // 次数只统计音乐（tracks.play_count）；游戏不再累计启动次数

    Ok(format!("Game launched with PID: {}", pid))
}

// 返回命中游戏的进程 PID 列表。命中条件：
// 1) 进程 exe 路径与 exe_path 完全一致
// 2) 进程 exe 路径位于 install_dir 目录内（深层 bin 目录、子进程都算）
// 3) 进程名与 exe_path 文件名一致（管理员权限进程读不到 exe 路径时的兜底）
fn game_process_matches(sys: &System, exe_path: &str, install_dir: &str) -> Vec<u32> {
    let exe_key = normalize_win_path(exe_path);
    let install_key = normalize_win_path(install_dir);
    let name_key: String = Path::new(exe_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    sys.processes()
        .values()
        .filter(|p| {
            if let Some(exe) = p.exe() {
                let e = normalize_win_path(&exe.to_string_lossy());
                if !exe_key.is_empty() && e == exe_key {
                    return true;
                }
                if !install_key.is_empty() && path_under_dir(&e, &install_key) {
                    return true;
                }
            }
            if !name_key.is_empty() {
                let n = p.name().to_string_lossy().to_lowercase();
                if n == name_key {
                    return true;
                }
            }
            false
        })
        .map(|p| p.pid().as_u32())
        .collect()
}

// 进程是否带"活跃"主窗口：可见（含最小化——最小化窗口保留 WS_VISIBLE，实测确认；
// 再加 IsIconic 兜底，某些程序最小化时窗口样式不标准）即视为游戏开着。
// 后台驻留型进程（渲染器/更新器等）的窗口全部隐藏（实测 Wallpaper Engine 关窗后有 3 个
// 隐藏窗口、无可见/最小化窗口）→ 不算——这是区分"游戏真的开着"与"驻留进程还活着"的依据
#[cfg(windows)]
fn process_has_visible_window(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    };

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = lparam as *mut (u32, bool);
        let mut wnd_pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut wnd_pid);
        if wnd_pid == (*ctx).0 && (IsWindowVisible(hwnd) != 0 || IsIconic(hwnd) != 0) {
            (*ctx).1 = true;
            return 0; // 找到了，停止枚举
        }
        1
    }

    let mut ctx: (u32, bool) = (pid, false);
    unsafe {
        EnumWindows(Some(enum_proc), &mut ctx as *mut (u32, bool) as isize);
    }
    ctx.1
}

#[cfg(not(windows))]
fn process_has_visible_window(_pid: u32) -> bool {
    true // 非 Windows 平台没有窗口概念，保持原有进程判定行为
}

// 结算会话：从运行表取出会话，把尾部增量写入 total_seconds（实时增量已在轮询时写入）。
// 返回本次时长；会话不存在返回 None。写库失败仅记日志，不阻塞轮询
fn close_session(state: &AppState, game_id: &str) -> Option<i64> {
    let session = state.running_games.write().remove(game_id)?;
    let tail = (Utc::now() - session.start_time).num_seconds().max(0);
    let duration = session.accumulated + tail;
    {
        let conn = state.db.lock();
        if let Err(e) = conn.execute(
            "UPDATE games SET total_seconds = total_seconds + ? WHERE id = ?",
            params![tail, session.game_id],
        ) {
            log::error!("close_session: update games failed: {}", e);
        }
    }
    Some(duration)
}

#[tauri::command(async)]
fn check_game_running(state: State<'_, AppState>, game_id: String) -> AppResult<bool> {
    Ok(poll_game_session(state.inner(), &game_id))
}

// 轮询单个会话：累计时长 / 判定退出 / 结算。返回是否仍在运行。
// 由后端 4 秒定时线程驱动（见 run() 里的 spawn）——最小化到托盘后 WebView 的 setTimeout
// 会被节流甚至冻结，时长累计和结算不能依赖前端轮询；命令入口仅作前端主动查询用
fn poll_game_session(state: &AppState, game_id: &str) -> bool {
    let game_id = game_id.to_string();
    // 短锁取会话快照（进程扫描较慢，不长时间持锁）
    let snapshot = {
        let sessions = state.running_games.read();
        sessions.get(&game_id).cloned()
    };
    let Some(session) = snapshot else {
        return false; // 会话不存在：已过期清理或从未启动
    };

    // 找出命中游戏的进程：直接启动的先用 PID（死了再用路径/名称兜底——启动器型游戏
    // 主进程先退、子进程接着跑）；Steam 游戏（rungameid，explorer 毫秒级退出）按路径/名称
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let matched = if session.process_id != 0
        && sys.process(sysinfo::Pid::from_u32(session.process_id)).is_some()
    {
        vec![session.process_id]
    } else {
        game_process_matches(&sys, &session.exe_path, &session.install_dir)
    };

    if !matched.is_empty() {
        // 有进程命中：只有带可见/最小化主窗口才算"游戏真的开着"。
        // 无窗口的驻留进程（如 Wallpaper Engine 的渲染进程）视为已关闭，尽快结算，
        // 避免关掉游戏后时长还在涨
        let has_window = matched.iter().any(|&pid| process_has_visible_window(pid));
        let mut sessions = state.running_games.write();
        let mut should_close = false;
        if let Some(s) = sessions.get_mut(&game_id) {
            if !s.process_seen {
                // 首次看到进程：计时起点锚定到此刻（rungameid 到游戏真正打开之间不算游玩时长）
                s.process_seen = true;
                s.start_time = Utc::now();
            } else if has_window {
                // 带窗口：实时累加增量（窗口空窗期不累计；回窗后起点重锚，空窗不计入时长）
                let now = Utc::now();
                if s.no_window_polls > 0 {
                    s.start_time = now;
                    s.no_window_polls = 0;
                }
                let delta = (now - s.start_time).num_seconds().max(0);
                if delta >= 1 {
                    let conn = state.db.lock();
                    let _ = conn.execute(
                        "UPDATE games SET total_seconds = total_seconds + ? WHERE id = ?",
                        params![delta, game_id],
                    );
                    drop(conn);
                    s.accumulated += delta;
                    s.start_time = now;
                }
            } else {
                // 进程在但没有任何可见/最小化窗口：游戏窗口已关、驻留进程还在（如
                // Wallpaper Engine 的渲染进程）——不累计时长，宽限一轮（约 8 秒）后结算；
                // 一轮缓冲只够覆盖窗口切换的瞬间空窗，游戏真的关了能很快停止
                s.no_window_polls += 1;
                if s.no_window_polls >= 2 {
                    s.start_time = Utc::now(); // 尾部清零：空窗期不计入时长
                    should_close = true;
                }
            }
        }
        drop(sessions);
        if should_close {
            let _ = close_session(state, &game_id);
            return false;
        }
        return true;
    }

    // 没有任何进程命中
    if !session.process_seen {
        // 从未出现过：仍在等待 Steam 启动（返回 true 让轮询继续）；
        // 超过 3 分钟判定启动失败（Steam 未登录 / 未拥有该游戏等），过期清理
        if (Utc::now() - session.start_time).num_seconds() > 180 {
            state.running_games.write().remove(&game_id);
            return false;
        }
        return true;
    }
    // 曾经运行过、现在探测不到：先宽限一轮（启动器/子进程切换的空窗），连续两轮才结算
    if session.miss_count == 0 {
        let mut sessions = state.running_games.write();
        if let Some(s) = sessions.get_mut(&game_id) {
            s.miss_count += 1;
        }
        return true;
    }
    let _ = close_session(state, &game_id);
    false
}

// 路径归一化：统一反斜杠 + 小写，供进程路径比对
fn normalize_win_path(p: &str) -> String {
    p.trim().replace('/', "\\").to_lowercase()
}

// path 是否位于 dir 内部（含相等）。基于已归一化路径做前缀匹配，且必须切在分隔符上，
// 避免 C:\Games\CS 误匹配 C:\Games\CS2\game.exe
fn path_under_dir(path: &str, dir: &str) -> bool {
    match path.strip_prefix(dir) {
        Some(rest) => rest.is_empty() || rest.starts_with('\\'),
        None => false,
    }
}

#[tauri::command(async)]
fn on_game_exit(state: State<'_, AppState>, game_id: String) -> AppResult<i64> {
    // 会话的结束与结算现在由 check_game_running 在轮询时完成（带窗口判定）；
    // 此命令仅作前端兜底调用，会话已不存在时返回错误
    close_session(&state, &game_id)
        .ok_or_else(|| AppError::Custom("No active session found".to_string()))
}

// ─────────────────────────────────────────────
// Tauri Commands - Series / Seasons / Episodes
// ─────────────────────────────────────────────

#[tauri::command(async)]
fn get_all_series(state: State<'_, AppState>) -> AppResult<Vec<Series>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(&format!("SELECT {} FROM series {}", SERIES_COLS, SERIES_ORDER))?;
    let rows = stmt.query_map([], |row| row_to_series(row))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

#[tauri::command(async)]
fn create_series(state: State<'_, AppState>, mut series: Series) -> AppResult<Series> {
    if series.id.is_empty() {
        series.id = Uuid::new_v4().to_string();
    }
    let conn = state.db.lock();
    conn.execute(
        // sort_order 取当前最大值 +1：新加的剧排在自定义顺序末尾
        "INSERT INTO series (id, title, aliases, overview, poster_path, bg_path, first_air_date,
         status, tmdb_id, tvdb_id, tags, favorite, vote_average, genres, media_type, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM series))",
        params![
            series.id, series.title, series.aliases, series.overview, series.poster_path,
            series.bg_path, series.first_air_date, series.status, series.tmdb_id,
            series.tvdb_id, series.tags, series.favorite as i32, series.vote_average, series.genres,
            if series.media_type.is_empty() { default_media_type() } else { series.media_type.clone() }
        ],
    )?;
    // 读回复用同一把锁：放锁再重取会留出空隙，命令异步化后并发的 delete_series
    // 能正好落在里面，写明明成功了却查不到 → 前端收到「新建失败」
    conn.query_row(
        &format!("SELECT {} FROM series WHERE id = ?", SERIES_COLS),
        [&series.id],
        |row| row_to_series(row),
    ).map_err(AppError::from)
}

#[tauri::command(async)]
fn update_series(state: State<'_, AppState>, series: Series) -> AppResult<Series> {
    let conn = state.db.lock();
    let affected = conn.execute(
        "UPDATE series SET title = ?, aliases = ?, overview = ?, poster_path = ?, bg_path = ?,
         first_air_date = ?, status = ?, tmdb_id = ?, tvdb_id = ?, tags = ?, favorite = ?,
         vote_average = ?, genres = ?,
         media_type = CASE WHEN ? <> '' THEN ? ELSE media_type END,
         sort_order = CASE WHEN ? > 0 THEN ? ELSE sort_order END,
         updated_at = datetime('now') WHERE id = ?",
        params![
            series.title, series.aliases, series.overview, series.poster_path, series.bg_path,
            series.first_air_date, series.status, series.tmdb_id, series.tvdb_id,
            series.tags, series.favorite as i32, series.vote_average, series.genres,
            series.media_type, series.media_type,
            series.sort_order, series.sort_order, series.id
        ],
    )?;
    if affected == 0 {
        return Err(AppError::Custom("该影视已被删除".into()));
    }
    // 读回复用同一把锁（同 create_series）：中间放锁会给并发删除留出空隙
    conn.query_row(
        &format!("SELECT {} FROM series WHERE id = ?", SERIES_COLS),
        [&series.id],
        |row| row_to_series(row),
    ).map_err(AppError::from)
}

// 影视拖拽排序：按传入顺序批量写 sort_order（事务原子，不碰 updated_at）
#[tauri::command(async)]
fn reorder_series(state: State<'_, AppState>, ordered_ids: Vec<String>) -> AppResult<()> {
    let mut conn = state.db.lock();
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("UPDATE series SET sort_order = ?1 WHERE id = ?2")?;
        for (i, id) in ordered_ids.iter().enumerate() {
            // 1 基（0 表示未参与排序，排末尾）；拖拽期间被删除的剧影响 0 行，跳过无害
            stmt.execute(params![i as i64 + 1, id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

// 收藏开关：只改一列。旧路径是前端把 Partial<Series> 回传给 update_series，
// 而该命令要求完整 Series → 反序列化失败、收藏点了没反应
#[tauri::command(async)]
fn set_series_favorite(state: State<'_, AppState>, series_id: String, favorite: bool) -> AppResult<()> {
    let conn = state.db.lock();
    let changed = conn.execute(
        "UPDATE series SET favorite = ?1 WHERE id = ?2",
        params![favorite as i32, series_id],
    )?;
    if changed == 0 {
        return Err(AppError::Custom("影视不存在".to_string()));
    }
    Ok(())
}

#[tauri::command(async)]
fn delete_series(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM series WHERE id = ?", [&id])?;
    Ok(())
}

#[tauri::command(async)]
fn get_seasons(state: State<'_, AppState>, series_id: String) -> AppResult<Vec<Season>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM seasons WHERE series_id = ? ORDER BY season_number",
        SEASON_COLS
    ))?;
    let rows = stmt.query_map([&series_id], |row| row_to_season(row))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

#[tauri::command(async)]
fn create_season(state: State<'_, AppState>, mut season: Season) -> AppResult<Season> {
    if season.id.is_empty() {
        season.id = Uuid::new_v4().to_string();
    }
    let conn = state.db.lock();
    conn.execute(
        "INSERT INTO seasons (id, series_id, season_number, name, overview, poster_path, first_air_date)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![
            season.id, season.series_id, season.season_number, season.name,
            season.overview, season.poster_path, season.first_air_date
        ],
    )?;
    Ok(season)
}

#[tauri::command(async)]
fn delete_season(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM seasons WHERE id = ?", [&id])?;
    Ok(())
}

#[tauri::command(async)]
fn get_episodes(state: State<'_, AppState>, season_id: String) -> AppResult<Vec<Episode>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM episodes WHERE season_id = ? ORDER BY episode_number",
        EPISODE_COLS
    ))?;
    let rows = stmt.query_map([&season_id], |row| row_to_episode(row))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

#[tauri::command(async)]
fn create_episode(state: State<'_, AppState>, mut episode: Episode) -> AppResult<Episode> {
    if episode.id.is_empty() {
        episode.id = Uuid::new_v4().to_string();
    }
    let conn = state.db.lock();
    conn.execute(
        "INSERT INTO episodes (id, series_id, season_id, episode_number, title, overview,
         still_path, air_date, runtime_minutes, local_path, watched_ms, last_watched_at, watched,
         vote_average)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            episode.id, episode.series_id, episode.season_id, episode.episode_number,
            episode.title, episode.overview, episode.still_path, episode.air_date,
            episode.runtime_minutes, episode.local_path, episode.watched_ms,
            episode.last_watched_at, episode.watched as i32, episode.vote_average
        ],
    )?;
    Ok(episode)
}

#[tauri::command(async)]
fn update_episode(state: State<'_, AppState>, episode: Episode) -> AppResult<Episode> {
    let conn = state.db.lock();
    conn.execute(
        "UPDATE episodes SET episode_number = ?, title = ?, overview = ?, still_path = ?,
         air_date = ?, runtime_minutes = ?, local_path = ?, watched_ms = ?,
         last_watched_at = ?, watched = ?, vote_average = ? WHERE id = ?",
        params![
            episode.episode_number, episode.title, episode.overview, episode.still_path,
            episode.air_date, episode.runtime_minutes, episode.local_path, episode.watched_ms,
            episode.last_watched_at, episode.watched as i32, episode.vote_average, episode.id
        ],
    )?;
    Ok(episode)
}

#[tauri::command(async)]
fn delete_episode(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM episodes WHERE id = ?", &[&id])?;
    Ok(())
}

#[tauri::command(async)]
fn update_watch_progress(state: State<'_, AppState>, episode_id: String, watched_ms: i64) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute(
        "UPDATE episodes SET watched_ms = ?, last_watched_at = datetime('now') WHERE id = ?",
        params![watched_ms, episode_id],
    )?;
    Ok(())
}

#[tauri::command(async)]
fn mark_episode_watched(state: State<'_, AppState>, episode_id: String, watched: bool) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute(
        // 标记已看时把续播点清 0（与 mpv 自动看完一致）；取消已看也清零，未看从 0 开始
        "UPDATE episodes SET watched = ?1, watched_ms = 0, last_watched_at = CASE WHEN ?1 = 1
            THEN datetime('now') ELSE last_watched_at END WHERE id = ?2",
        params![watched as i32, episode_id],
    )?;
    drop(conn);
    // 播放器开着时，播放列表抽屉里的勾要立刻跟上
    mpv::refresh_playlist_meta_for_episode(&state.data_dir, &state.mpv, &episode_id, watched);
    Ok(())
}

// 整季批量标记已看/未看（详情页季操作）
#[tauri::command(async)]
fn mark_season_watched(state: State<'_, AppState>, season_id: String, watched: bool) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute(
        // 标记已看时把整季的续播点清 0（与 mpv 自动看完一致），取消已看也清零，未看从 0 开始
        "UPDATE episodes SET watched = ?1, watched_ms = 0, last_watched_at = CASE WHEN ?1 = 1
            THEN datetime('now') ELSE last_watched_at END WHERE season_id = ?2",
        params![watched as i32, season_id],
    )?;
    // 整季标记会改一批集 —— 播放器开着时直接把当前剧的边车整份重写
    let series_id = conn
        .query_row("SELECT series_id FROM seasons WHERE id = ?1", [&season_id], |r| {
            r.get::<_, String>(0)
        })
        .ok();
    drop(conn);
    if let Some(sid) = series_id {
        if state.mpv.lock().as_ref().is_some() {
            mpv::refresh_playlist_meta(&state.db, &state.data_dir, &sid);
        }
    }
    Ok(())
}

// 播放某一集：记录观看时间（用于「继续观看」排序），不改变已看标记
#[tauri::command(async)]
fn touch_episode_played(state: State<'_, AppState>, episode_id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute(
        "UPDATE episodes SET last_watched_at = datetime('now') WHERE id = ?1",
        params![episode_id],
    )?;
    Ok(())
}

// ─────────────────────────────────────────────
// Tauri Commands - 影视库聚合查询（首页 Hero / 卡片进度 / 详情页）
// ─────────────────────────────────────────────

// 「继续观看」指向的下一集：该剧按季号+集号排序的第一条未看
#[derive(Debug, Serialize, Clone)]
pub struct NextEpisode {
    pub id: String,
    pub season_id: String,
    pub season_number: i32,
    pub episode_number: i32,
    pub title: String,
    pub still_path: String,
    pub local_path: String,
    pub runtime_minutes: i32,
    pub watched_ms: i64,
}

// 首页卡片/Hero 需要的剧集 + 统计（季数、集数、已看数、有本地文件的集数、最近观看）
#[derive(Debug, Serialize)]
pub struct SeriesCard {
    #[serde(flatten)]
    pub series: Series,
    pub season_count: i64,
    pub episode_count: i64,
    pub watched_count: i64,
    pub local_count: i64,
    pub last_watched_at: String,
    pub next_episode: Option<NextEpisode>,
}

#[derive(Debug, Serialize)]
pub struct SeasonWithEpisodes {
    #[serde(flatten)]
    pub season: Season,
    pub episodes: Vec<Episode>,
}

#[derive(Debug, Serialize)]
pub struct SeriesDetailData {
    #[serde(flatten)]
    pub series: Series,
    pub seasons: Vec<SeasonWithEpisodes>,
    pub next_episode: Option<NextEpisode>,
    pub episode_count: i64,
    pub watched_count: i64,
}

// 每部剧的第一条未看集（一次查询覆盖全库，前端不必逐剧请求）。
// 旧版把全库所有未看集排序后拉进 Rust，再靠 or_insert 丢掉 99%（每次进首页都跑）。
// 改成窗口函数在库内分组取第一条：只返回每剧 1 行，排序也由 SQLite 在分区内做
fn query_next_episodes(conn: &Connection) -> AppResult<HashMap<String, NextEpisode>> {
    let mut stmt = conn.prepare(
        "SELECT series_id, id, season_id, season_number, episode_number, title,
                still_path, local_path, runtime_minutes, watched_ms
         FROM (
             SELECT e.series_id, e.id, e.season_id, s.season_number, e.episode_number, e.title,
                    e.still_path, e.local_path, e.runtime_minutes, e.watched_ms,
                    ROW_NUMBER() OVER (
                        PARTITION BY e.series_id
                        ORDER BY s.season_number, e.episode_number
                    ) AS rn
             FROM episodes e JOIN seasons s ON s.id = e.season_id
             WHERE e.watched = 0
         )
         WHERE rn = 1",
    )?;
    let mut out: HashMap<String, NextEpisode> = HashMap::new();
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            NextEpisode {
                id: row.get(1)?,
                season_id: row.get(2)?,
                season_number: row.get(3)?,
                episode_number: row.get(4)?,
                title: row.get(5)?,
                still_path: row.get(6)?,
                local_path: row.get(7)?,
                runtime_minutes: row.get(8)?,
                watched_ms: row.get(9)?,
            },
        ))
    })?;
    for row in rows {
        let (series_id, ep) = row?;
        out.insert(series_id, ep); // SQL 已保证每剧只有一行
    }
    Ok(out)
}

#[tauri::command(async)]
fn get_series_library(state: State<'_, AppState>) -> AppResult<Vec<SeriesCard>> {
    let conn = state.db.lock();

    let all: Vec<Series> = {
        let mut stmt = conn.prepare(&format!("SELECT {} FROM series {}", SERIES_COLS, SERIES_ORDER))?;
        let rows = stmt.query_map([], |row| row_to_series(row))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let mut season_counts: HashMap<String, i64> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT series_id, COUNT(*) FROM seasons GROUP BY series_id")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        for row in rows {
            let (k, v) = row?;
            season_counts.insert(k, v);
        }
    }

    // (总集数, 已看数, 有本地文件数, 最近观看时间)
    let mut ep_stats: HashMap<String, (i64, i64, i64, String)> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT series_id, COUNT(*), COALESCE(SUM(watched), 0),
                    COALESCE(SUM(CASE WHEN local_path <> '' THEN 1 ELSE 0 END), 0),
                    COALESCE(MAX(last_watched_at), '')
             FROM episodes GROUP BY series_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, String>(4)?),
            ))
        })?;
        for row in rows {
            let (k, v) = row?;
            ep_stats.insert(k, v);
        }
    }

    let mut next_map = query_next_episodes(&conn)?;

    Ok(all
        .into_iter()
        .map(|series| {
            let stats = ep_stats.get(&series.id).cloned().unwrap_or((0, 0, 0, String::new()));
            SeriesCard {
                season_count: *season_counts.get(&series.id).unwrap_or(&0),
                episode_count: stats.0,
                watched_count: stats.1,
                local_count: stats.2,
                last_watched_at: stats.3,
                next_episode: next_map.remove(&series.id),
                series,
            }
        })
        .collect())
}

// 详情页一次取全：剧集 + 全部季 + 全部集（避免逐季 IPC 往返）
#[tauri::command(async)]
fn get_series_detail(state: State<'_, AppState>, series_id: String) -> AppResult<SeriesDetailData> {
    let conn = state.db.lock();

    let series = conn.query_row(
        &format!("SELECT {} FROM series WHERE id = ?", SERIES_COLS),
        [&series_id],
        |row| row_to_series(row),
    )?;

    let seasons: Vec<Season> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM seasons WHERE series_id = ? ORDER BY season_number",
            SEASON_COLS
        ))?;
        let rows = stmt.query_map([&series_id], |row| row_to_season(row))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let mut episodes: Vec<Episode> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM episodes WHERE series_id = ? ORDER BY episode_number",
            EPISODE_COLS
        ))?;
        let rows = stmt.query_map([&series_id], |row| row_to_episode(row))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let episode_count = episodes.len() as i64;
    let watched_count = episodes.iter().filter(|e| e.watched).count() as i64;

    let mut next_episode: Option<NextEpisode> = None;
    let mut out = Vec::with_capacity(seasons.len());
    for season in seasons {
        let mut mine: Vec<Episode> = Vec::new();
        let mut rest: Vec<Episode> = Vec::new();
        for ep in episodes.drain(..) {
            if ep.season_id == season.id {
                mine.push(ep);
            } else {
                rest.push(ep);
            }
        }
        episodes = rest;
        mine.sort_by_key(|e| e.episode_number);
        if next_episode.is_none() {
            if let Some(e) = mine.iter().find(|e| !e.watched) {
                next_episode = Some(NextEpisode {
                    id: e.id.clone(),
                    season_id: e.season_id.clone(),
                    season_number: season.season_number,
                    episode_number: e.episode_number,
                    title: e.title.clone(),
                    still_path: e.still_path.clone(),
                    local_path: e.local_path.clone(),
                    runtime_minutes: e.runtime_minutes,
                    watched_ms: e.watched_ms,
                });
            }
        }
        out.push(SeasonWithEpisodes { season, episodes: mine });
    }

    Ok(SeriesDetailData {
        series,
        seasons: out,
        next_episode,
        episode_count,
        watched_count,
    })
}

// ─────────────────────────────────────────────
// Tauri Commands - TMDB 自动封面（精确到集）
// ─────────────────────────────────────────────

#[derive(Deserialize)]
struct TmdbSearchResponse {
    results: Vec<TmdbSearchItem>,
}

#[derive(Deserialize)]
struct TmdbSearchItem {
    id: i64,
    #[allow(dead_code)]
    name: Option<String>,
    #[allow(dead_code)]
    poster_path: Option<String>,
}

#[derive(Deserialize)]
struct TmdbSeasonResponse {
    #[allow(dead_code)]
    poster_path: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    overview: Option<String>,
    #[serde(default)]
    air_date: Option<String>,
    episodes: Vec<TmdbEpisodeItem>,
}

#[derive(Deserialize)]
struct TmdbEpisodeItem {
    episode_number: i32,
    still_path: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    overview: Option<String>,
    #[serde(default)]
    air_date: Option<String>,
    #[serde(default)]
    runtime: Option<i32>,
    #[serde(default)]
    vote_average: Option<f64>,
}

// 剧集详情：简介/评分/类型/状态/背景图等「更多数据」的来源
#[derive(Deserialize, Default)]
struct TmdbTvDetail {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    original_name: Option<String>,
    #[serde(default)]
    overview: Option<String>,
    #[serde(default)]
    poster_path: Option<String>,
    #[serde(default)]
    backdrop_path: Option<String>,
    #[serde(default)]
    first_air_date: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    vote_average: Option<f64>,
    #[serde(default)]
    genres: Vec<TmdbGenre>,
}

#[derive(Deserialize)]
struct TmdbGenre {
    name: String,
}

// TMDB 英文状态 → 中文（未知值原样返回）
fn map_tmdb_status(status: &str) -> String {
    match status {
        "Returning Series" => "连载中",
        "Ended" => "已完结",
        "Canceled" | "Cancelled" => "已取消",
        "In Production" => "制作中",
        "Planned" => "筹备中",
        "Pilot" => "试播",
        "Released" => "已上映",
        "Post Production" => "后期制作",
        "Rumored" => "待定",
        other => other,
    }
    .to_string()
}

// 文件夹/文件名常带 SxxExx、第N季、年份、压制标记等杂质，去掉后再拿去搜索
fn clean_search_title(title: &str) -> String {
    regex::Regex::new(
        r"(?i)(?:s\d{1,2}e?\d*|\d{1,2}[x×]\d{1,2}|第\s*\d+\s*季|(?:19|20)\d{2}|1080p|720p|2160p|4k|bluray|web-?dl|hdr|x26[45]|h\.?26[45])",
    )
    .unwrap()
    .replace_all(title.trim(), " ")
    .split_whitespace()
    .collect::<Vec<_>>()
    .join(" ")
    .trim()
    .to_string()
}

// ─────────────────────────────────────────────
// TMDB 搜索候选（同名作品交给用户选，避免盲取第一条选错）
// ─────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct TmdbSearchResult {
    pub id: i64,
    pub name: String,
    pub original_name: String,
    pub overview: String,
    pub date: String,       // 首播 / 上映日期
    pub poster_url: String, // 完整 https 地址，前端直接用
    pub vote_average: f64,
}

// tv 用 name/first_air_date，movie 用 title/release_date —— 用 alias 统一成一套字段
#[derive(Deserialize)]
struct TmdbMultiItem {
    id: i64,
    #[serde(default, alias = "title")]
    name: Option<String>,
    #[serde(default, alias = "original_title")]
    original_name: Option<String>,
    #[serde(default)]
    overview: Option<String>,
    #[serde(default)]
    poster_path: Option<String>,
    #[serde(default, alias = "release_date")]
    first_air_date: Option<String>,
    #[serde(default)]
    vote_average: Option<f64>,
}

#[derive(Deserialize)]
struct TmdbMultiResponse {
    results: Vec<TmdbMultiItem>,
}

// 搜索 TMDB：返回候选列表供前端选择。中文无结果时回退英文，原标题无结果时再试去脏标题
#[tauri::command]
async fn search_tmdb(
    state: State<'_, AppState>,
    query: String,
    media_type: String,
) -> AppResult<Vec<TmdbSearchResult>> {
    let key: String = {
        let conn = state.db.lock();
        conn.query_row("SELECT value FROM settings WHERE key = 'tmdb_api_key'", [], |r| r.get(0))
            .unwrap_or_default()
    };
    if key.is_empty() {
        return Err(AppError::Custom("未配置 TMDB API Key，请到设置页填写".to_string()));
    }
    let kind = if media_type == "movie" { "movie" } else { "tv" };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;

    let mut queries = vec![query.trim().to_string()];
    let cleaned = clean_search_title(&query);
    if !cleaned.is_empty() && cleaned != query.trim() {
        queries.push(cleaned);
    }

    for q in queries {
        if q.is_empty() {
            continue;
        }
        for lang in ["zh-CN", "en-US"] {
            let url = format!(
                "https://api.tmdb.org/3/search/{}?query={}&api_key={}&language={}",
                kind,
                urlencoding::encode(&q),
                key,
                lang
            );
            let resp = match client.get(&url).send().await {
                Ok(r) if r.status().is_success() => r,
                _ => continue,
            };
            let parsed: TmdbMultiResponse = match resp.json().await {
                Ok(p) => p,
                Err(_) => continue,
            };
            if parsed.results.is_empty() {
                continue;
            }
            return Ok(parsed
                .results
                .into_iter()
                .take(12)
                .map(|it| TmdbSearchResult {
                    id: it.id,
                    name: it.name.unwrap_or_default(),
                    original_name: it.original_name.unwrap_or_default(),
                    overview: it.overview.unwrap_or_default(),
                    date: it.first_air_date.unwrap_or_default(),
                    poster_url: it
                        .poster_path
                        .map(|p| format!("https://image.tmdb.org/t/p/w185{}", p))
                        .unwrap_or_default(),
                    vote_average: it.vote_average.unwrap_or(0.0),
                })
                .collect());
        }
    }
    Ok(Vec::new())
}

// 拉取剧集详情：优先中文，中文简介为空时用英文补（TMDB 中文条目常缺简介）
async fn tmdb_tv_detail(client: &reqwest::Client, key: &str, tmdb_id: i64) -> TmdbTvDetail {
    let fetch = |lang: &'static str| {
        let url = format!(
            "https://api.tmdb.org/3/tv/{}?api_key={}&language={}",
            tmdb_id, key, lang
        );
        let client = client.clone();
        async move {
            let resp = client.get(&url).send().await.ok()?;
            if !resp.status().is_success() {
                return None;
            }
            resp.json::<TmdbTvDetail>().await.ok()
        }
    };
    let mut detail = fetch("zh-CN").await.unwrap_or_default();
    if detail.overview.as_deref().unwrap_or("").trim().is_empty() {
        if let Some(en) = fetch("en-US").await {
            if detail.overview.as_deref().unwrap_or("").trim().is_empty() {
                detail.overview = en.overview;
            }
            if detail.backdrop_path.is_none() {
                detail.backdrop_path = en.backdrop_path;
            }
            if detail.poster_path.is_none() {
                detail.poster_path = en.poster_path;
            }
        }
    }
    detail
}

// 搜索影视：language=zh-CN 未命中时回退默认语言（en-US）重试；失败/无结果返回 None
async fn tmdb_search_tv(
    client: &reqwest::Client,
    key: &str,
    query: &str,
) -> AppResult<Option<TmdbSearchItem>> {
    let candidates = [
        format!(
            "https://api.tmdb.org/3/search/tv?query={}&api_key={}&language=zh-CN",
            urlencoding::encode(query),
            key
        ),
        format!(
            "https://api.tmdb.org/3/search/tv?query={}&api_key={}",
            urlencoding::encode(query),
            key
        ),
    ];
    for url in candidates {
        let resp = match client.get(&url).send().await {
            Ok(r) => r,
            Err(_) => continue, // 网络错误也尝试下一个
        };
        if !resp.status().is_success() {
            continue;
        }
        let parsed: TmdbSearchResponse = match resp.json().await {
            Ok(p) => p,
            Err(_) => continue,
        };
        if let Some(item) = parsed.results.into_iter().next() {
            return Ok(Some(item));
        }
    }
    Ok(None)
}

// 拉取某一季详情（含全部集的剧照与标题/简介）；404/非 200 返回 None（本地季多于 TMDB 时静默跳过）。
// 中文条目常缺集简介 → 缺失时再拉一次英文，按集号逐条补空字段（只补空，不覆盖已有中文）
async fn tmdb_season_episodes(
    client: &reqwest::Client,
    key: &str,
    tmdb_id: i64,
    season_number: i32,
) -> AppResult<Option<TmdbSeasonResponse>> {
    let fetch = |lang: &'static str| {
        let url = format!(
            "https://api.tmdb.org/3/tv/{}/season/{}?api_key={}&language={}",
            tmdb_id, season_number, key, lang
        );
        let client = client.clone();
        async move {
            let resp = client.get(&url).send().await.ok()?;
            if !resp.status().is_success() {
                return None;
            }
            resp.json::<TmdbSeasonResponse>().await.ok()
        }
    };

    let mut zh = match fetch("zh-CN").await {
        Some(v) => v,
        None => return Ok(None),
    };

    let is_blank = |v: &Option<String>| v.as_deref().unwrap_or("").trim().is_empty();
    let needs_en = is_blank(&zh.overview) || zh.episodes.iter().any(|e| is_blank(&e.overview));
    if needs_en {
        if let Some(en) = fetch("en-US").await {
            if is_blank(&zh.overview) {
                zh.overview = en.overview;
            }
            let en_map: HashMap<i32, TmdbEpisodeItem> = en
                .episodes
                .into_iter()
                .map(|e| (e.episode_number, e))
                .collect();
            for ep in &mut zh.episodes {
                if let Some(en_ep) = en_map.get(&ep.episode_number) {
                    if is_blank(&ep.overview) {
                        ep.overview = en_ep.overview.clone();
                    }
                    if is_blank(&ep.name) {
                        ep.name = en_ep.name.clone();
                    }
                    if ep.still_path.is_none() {
                        ep.still_path = en_ep.still_path.clone();
                    }
                }
            }
        }
    }
    Ok(Some(zh))
}

// 下载单张图片到固定路径；文件已存在则跳过网络；失败返回 None（静默降级）
async fn fetch_tmdb_image(client: &reqwest::Client, url: &str, target: &Path) -> Option<()> {
    if target.exists() {
        return Some(());
    }
    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    fs::write(target, &bytes).ok()
}

// 图片下载任务：固定文件名覆盖写（幂等无残留），带库表目标
struct TmdbImageJob {
    url: String,
    target: PathBuf,
    series_id: Option<String>, // 系列海报
    season_id: Option<String>, // 季海报
    episode_id: Option<String>, // 集剧照
    backdrop: bool,             // 系列背景大图（详情页/首页 Hero 用）
}

// 并发下载一组图片（Semaphore 限流 8），返回与 jobs 顺序对齐的成功标记。
// on_done 每完成一张回调一次已完成数（用于发射进度事件）
async fn download_tmdb_images(
    client: &reqwest::Client,
    sem: &Arc<tokio::sync::Semaphore>,
    jobs: &[TmdbImageJob],
    on_done: Option<&(dyn Fn(usize) + Send + Sync)>,
) -> Vec<bool> {
    let mut handles = Vec::with_capacity(jobs.len());
    for job in jobs {
        let sem = sem.clone();
        let client = client.clone();
        let url = job.url.clone();
        let target = job.target.clone();
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire_owned().await.ok()?;
            fetch_tmdb_image(&client, &url, &target).await
        }));
    }
    let mut out = Vec::with_capacity(handles.len());
    for handle in handles {
        out.push(handle.await.ok().flatten().is_some());
        if let Some(f) = on_done {
            f(out.len());
        }
    }
    out
}

// 自动获取封面进度事件载荷（每完成一季/一张图 emit 一次，前端进度条）
#[derive(Clone, Serialize)]
struct SeriesCoverProgress {
    done: usize,
    total: usize,
}

// 影视库自动封面：搜索 TMDB 并按季号/集号精确匹配，下载系列海报、季海报、集剧照。
// 进度：total 按「1 海报 + 季数 + 集数」预估上限，季处理/图片下载各 +1，结束补满 → 单调逼近 100%
// tmdb_id：用户在候选列表里选定的条目（同名作品消歧）。为 None 时沿用库里已有的，再没有才自动搜索
#[tauri::command]
async fn auto_fetch_series_metadata(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    series_id: String,
    tmdb_id: Option<i64>,
) -> AppResult<String> {
    // 全局防重入：前端切库会丢组件状态，这里兜底——同一时刻只允许一个抓取在跑
    if state.metadata_fetching.swap(true, Ordering::SeqCst) {
        return Err(AppError::Custom("正在获取其他影视的元数据，请稍候".to_string()));
    }
    // RAII guard：函数任何出口（成功/失败/panic 前正常返回）都释放锁
    struct FetchGuard<'a>(&'a AtomicBool);
    impl Drop for FetchGuard<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _guard = FetchGuard(&state.metadata_fetching);

    let media_type: String = {
        let conn = state.db.lock();
        conn.query_row(
            "SELECT COALESCE(NULLIF(media_type, ''), 'tv') FROM series WHERE id = ?1",
            params![series_id],
            |r| r.get(0),
        )?
    };
    if media_type == "movie" {
        auto_fetch_movie_metadata_inner(&state.db, &state.data_dir, &series_id, tmdb_id, Some(&app)).await
    } else {
        auto_fetch_series_metadata_inner(&state.db, &state.data_dir, &series_id, tmdb_id, Some(&app)).await
    }
}

async fn auto_fetch_series_metadata_inner(
    db: &Mutex<Connection>,
    data_dir: &Path,
    series_id: &str,
    tmdb_id_override: Option<i64>,
    app: Option<&tauri::AppHandle>,
) -> AppResult<String> {
    // 阶段一：短锁读库（不跨 await）
    let (title, tmdb_id, seasons, episodes) = {
        let conn = db.lock();
        let (title, tmdb_id): (String, i64) = conn.query_row(
            "SELECT title, tmdb_id FROM series WHERE id = ?1",
            params![series_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let mut seasons: Vec<(String, i32)> = Vec::new();
        let mut stmt = conn.prepare(
            "SELECT id, season_number FROM seasons WHERE series_id = ?1 ORDER BY season_number",
        )?;
        for row in stmt.query_map(params![series_id], |r| Ok((r.get(0)?, r.get(1)?)))? {
            seasons.push(row?);
        }
        let mut episodes: Vec<(String, String, i32)> = Vec::new();
        let mut stmt = conn.prepare(
            "SELECT id, season_id, episode_number FROM episodes WHERE series_id = ?1",
        )?;
        for row in stmt.query_map(params![series_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))? {
            episodes.push(row?);
        }
        (title, tmdb_id, seasons, episodes)
    };

    // 阶段二：读 key + 确定 TMDB id
    let key: String = {
        let conn = db.lock();
        conn.query_row(
            "SELECT value FROM settings WHERE key = 'tmdb_api_key'",
            [],
            |r| r.get(0),
        )
        .unwrap_or_default()
    };
    if key.is_empty() {
        return Err(AppError::Custom(
            "未配置 TMDB API Key，请到设置页填写".to_string(),
        ));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;

    // 用户选定 > 库里已有（重试稳定，不重新搜索）> 按标题搜索
    let found_tmdb_id = if let Some(id) = tmdb_id_override.filter(|v| *v > 0) {
        id
    } else if tmdb_id > 0 {
        tmdb_id
    } else {
        // 文件夹名常带 SxxExx / 第N季 / 年份 后缀，生成去脏候选
        let mut candidates = vec![title.trim().to_string()];
        let cleaned = clean_search_title(&title);
        if !cleaned.is_empty() && cleaned != title.trim() {
            candidates.push(cleaned);
        }
        let mut found: Option<i64> = None;
        for cand in candidates {
            if let Some(item) = tmdb_search_tv(&client, &key, &cand).await? {
                found = Some(item.id);
                break;
            }
        }
        match found {
            Some(v) => v,
            None => {
                return Err(AppError::Custom(format!("未找到匹配影视：{}", title)));
            }
        }
    };

    // 剧集详情：简介 / 评分 / 类型 / 状态 / 首播日期 / 海报 / 背景图 —— 图片之外的「更多数据」都来自这里
    let tv = tmdb_tv_detail(&client, &key, found_tmdb_id).await;
    let poster_path = tv.poster_path.clone();

    // 阶段三：季详情（串行）+ 构建图片任务
    // 进度权重模型：每季 2（1 季请求 + 1 季海报下载）、每集 2（1 集匹配 + 1 剧照下载）、海报 1。
    // 阶段三每完成一季消耗 (1+集数)、阶段四每张下载 +1 → 全部匹配时完成数恰等于 total，
    // 单调平滑不跳变、不提前满格；未匹配项（无剧照/无海报）的权重由收尾 emit 补齐
    let covers_dir = data_dir.join("covers");
    let total: usize = 2 + seasons.len() * 2 + episodes.len() * 2; // +1 海报 +1 背景大图
    let done = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let emit_progress = |n: usize| {
        done.store(n, std::sync::atomic::Ordering::Relaxed);
        if let Some(app) = app {
            let _ = app.emit(
                "series-cover-progress",
                SeriesCoverProgress { done: n, total },
            );
        }
    };
    let mut jobs: Vec<TmdbImageJob> = Vec::new();
    let mut season_miss = 0usize; // 本地季在 TMDB 缺失
    let mut episodes_skip = 0usize; // 集号未匹配或 TMDB 无剧照
    // 文字元数据（与图片下载解耦：图片失败也照样写库）
    let mut season_meta: Vec<(String, String, String, String)> = Vec::new(); // id, 名称, 简介, 首播
    let mut episode_meta: Vec<(String, String, String, String, i32, f64)> = Vec::new(); // id, 标题, 简介, 播出, 时长, 评分
    if let Some(p) = poster_path {
        jobs.push(TmdbImageJob {
            url: format!("https://image.tmdb.org/t/p/w500{}", p),
            target: covers_dir.join(format!("series_{}.jpg", series_id)),
            series_id: Some(series_id.to_string()),
            season_id: None,
            episode_id: None,
            backdrop: false,
        });
    }
    if let Some(b) = &tv.backdrop_path {
        jobs.push(TmdbImageJob {
            url: format!("https://image.tmdb.org/t/p/w1280{}", b),
            target: covers_dir.join(format!("series_bg_{}.jpg", series_id)),
            series_id: None,
            season_id: None,
            episode_id: None,
            backdrop: true,
        });
    }
    for (season_id, season_number) in &seasons {
        // 该季进度权重 = 1（季请求）+ 该季集数（集匹配工作）
        let season_weight = 1
            + episodes
                .iter()
                .filter(|(_, sid, _)| sid == season_id)
                .count();
        let detail = match tmdb_season_episodes(&client, &key, found_tmdb_id, *season_number).await? {
            Some(d) => d,
            None => {
                season_miss += 1;
                emit_progress(done.load(std::sync::atomic::Ordering::Relaxed) + season_weight);
                continue;
            }
        };
        season_meta.push((
            season_id.clone(),
            detail.name.clone().unwrap_or_default(),
            detail.overview.clone().unwrap_or_default(),
            detail.air_date.clone().unwrap_or_default(),
        ));
        if let Some(p) = detail.poster_path {
            jobs.push(TmdbImageJob {
                url: format!("https://image.tmdb.org/t/p/w500{}", p),
                target: covers_dir.join(format!("season_{}.jpg", season_id)),
                series_id: None,
                season_id: Some(season_id.clone()),
                episode_id: None,
                backdrop: false,
            });
        }
        // 该季的本地集按集号匹配 TMDB：标题/简介/时长/播出日期 + 剧照
        let local: Vec<(String, i32)> = episodes
            .iter()
            .filter(|(_, sid, _)| sid == season_id)
            .map(|(eid, _, ep)| (eid.clone(), *ep))
            .collect();
        for (episode_id, episode_number) in local {
            let matched = detail
                .episodes
                .iter()
                .find(|e| e.episode_number == episode_number);
            if let Some(e) = matched {
                episode_meta.push((
                    episode_id.clone(),
                    e.name.clone().unwrap_or_default(),
                    e.overview.clone().unwrap_or_default(),
                    e.air_date.clone().unwrap_or_default(),
                    e.runtime.unwrap_or(0),
                    e.vote_average.unwrap_or(0.0),
                ));
            }
            match matched.and_then(|e| e.still_path.clone()) {
                Some(p) => jobs.push(TmdbImageJob {
                    url: format!("https://image.tmdb.org/t/p/w342{}", p),
                    target: covers_dir.join(format!("episode_{}.jpg", episode_id)),
                    series_id: None,
                    season_id: None,
                    episode_id: Some(episode_id),
                    backdrop: false,
                }),
                None => episodes_skip += 1,
            }
        }
        emit_progress(done.load(std::sync::atomic::Ordering::Relaxed) + season_weight); // 该季完整权重
    }

    // 阶段四：并发下载。节流 emit：每 20 张或每 100ms 一次 —— 几百张图时事件数量
    // 从「每张一个」降到几十个，避免 WebView2 前端事件积压导致进度显示滞后
    let last_emit_ms = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let sem = Arc::new(tokio::sync::Semaphore::new(8));
    let results = download_tmdb_images(
        &client,
        &sem,
        &jobs,
        Some(&|n: usize| {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            let last = last_emit_ms.load(std::sync::atomic::Ordering::Relaxed);
            if n % 20 == 0 || now_ms.saturating_sub(last) >= 100 {
                last_emit_ms.store(now_ms, std::sync::atomic::Ordering::Relaxed);
                emit_progress(done.load(std::sync::atomic::Ordering::Relaxed) + n);
            }
        }),
    ).await;

    // 阶段五：短锁写库。单事务批量提交：autocommit 模式下每条 UPDATE 独立事务 + fsync，
    // 数百条时耗时数秒（「封面替换慢」的根源）；BEGIN/COMMIT 包裹后毫秒级完成
    let mut poster_path: Option<String> = None;
    let mut bg_path: Option<String> = None;
    let mut seasons_ok = 0usize;
    let mut episodes_ok = 0usize;
    let mut failed = 0usize;
    let conn = db.lock();
    conn.execute("BEGIN TRANSACTION", [])?;
    for job in jobs.into_iter().zip(results) {
        let (job, ok) = job;
        if !ok {
            failed += 1;
            continue;
        }
        let path = job.target.to_string_lossy().to_string();
        if job.backdrop {
            bg_path = Some(path);
        } else if job.series_id.is_some() {
            poster_path = Some(path);
        } else if let Some(id) = job.season_id {
            conn.execute(
                "UPDATE seasons SET poster_path = ?1 WHERE id = ?2",
                params![path, id],
            )?;
            seasons_ok += 1;
        } else if let Some(id) = job.episode_id {
            conn.execute(
                "UPDATE episodes SET still_path = ?1 WHERE id = ?2",
                params![path, id],
            )?;
            episodes_ok += 1;
        }
    }
    // 季/集文字元数据：TMDB 有值才覆盖（空值不清空本地已有内容，如扫描出的文件名标题）
    for (id, name, overview, air_date) in &season_meta {
        conn.execute(
            "UPDATE seasons SET
                name = CASE WHEN ?1 <> '' THEN ?1 ELSE name END,
                overview = CASE WHEN ?2 <> '' THEN ?2 ELSE overview END,
                first_air_date = CASE WHEN ?3 <> '' THEN ?3 ELSE first_air_date END
             WHERE id = ?4",
            params![name, overview, air_date, id],
        )?;
    }
    let mut episode_meta_ok = 0usize;
    for (id, title, overview, air_date, runtime, vote) in &episode_meta {
        conn.execute(
            "UPDATE episodes SET
                title = CASE WHEN ?1 <> '' THEN ?1 ELSE title END,
                overview = CASE WHEN ?2 <> '' THEN ?2 ELSE overview END,
                air_date = CASE WHEN ?3 <> '' THEN ?3 ELSE air_date END,
                runtime_minutes = CASE WHEN ?4 > 0 THEN ?4 ELSE runtime_minutes END,
                vote_average = CASE WHEN ?5 > 0 THEN ?5 ELSE vote_average END
             WHERE id = ?6",
            params![title, overview, air_date, runtime, vote, id],
        )?;
        episode_meta_ok += 1;
    }

    // 剧集元数据 + 图片路径：tmdb_id 命中即写，其余字段 TMDB 有值才覆盖
    let genres = tv
        .genres
        .iter()
        .map(|g| g.name.as_str())
        .collect::<Vec<_>>()
        .join(" / ");
    let status_cn = tv.status.as_deref().map(map_tmdb_status).unwrap_or_default();
    let overview = tv.overview.clone().unwrap_or_default();
    let has_overview = !overview.trim().is_empty();
    conn.execute(
        "UPDATE series SET
            overview = CASE WHEN ?1 <> '' THEN ?1 ELSE overview END,
            first_air_date = CASE WHEN ?2 <> '' THEN ?2 ELSE first_air_date END,
            status = CASE WHEN ?3 <> '' THEN ?3 ELSE status END,
            genres = CASE WHEN ?4 <> '' THEN ?4 ELSE genres END,
            vote_average = CASE WHEN ?5 > 0 THEN ?5 ELSE vote_average END,
            aliases = CASE WHEN aliases = '' THEN ?6 ELSE aliases END,
            title = CASE WHEN ?7 <> '' THEN ?7 ELSE title END,
            poster_path = CASE WHEN ?8 <> '' THEN ?8 ELSE poster_path END,
            bg_path = CASE WHEN ?9 <> '' THEN ?9 ELSE bg_path END,
            tmdb_id = ?10,
            updated_at = datetime('now')
         WHERE id = ?11",
        params![
            overview,
            tv.first_air_date.clone().unwrap_or_default(),
            status_cn,
            genres,
            tv.vote_average.unwrap_or(0.0),
            tv.original_name.clone().unwrap_or_default(),
            tv.name.clone().unwrap_or_default(),
            poster_path.clone().unwrap_or_default(),
            bg_path.clone().unwrap_or_default(),
            found_tmdb_id,
            series_id
        ],
    )?;
    conn.execute("COMMIT", [])?;
    drop(conn);

    let skipped = season_miss + episodes_skip + failed;
    let mut msg = format!(
        "已获取：海报 {} 张、背景图 {} 张、季封面 {} 张、剧照 {} 张；{}集信息 {} 条",
        poster_path.is_some() as usize,
        bg_path.is_some() as usize,
        seasons_ok,
        episodes_ok,
        if has_overview { "剧集简介、" } else { "" },
        episode_meta_ok
    );
    if skipped > 0 {
        msg.push_str(&format!("（{} 项未匹配或下载失败）", skipped));
    }
    // 收尾：补满进度（预估 total 可能略高于实际下载数，结束时强制到 100%）
    emit_progress(total);
    Ok(msg)
}

// ─────────────────────────────────────────────
// TMDB 电影元数据（单个视频文件 = 一部电影）
// ─────────────────────────────────────────────

#[derive(Deserialize, Default)]
struct TmdbMovieDetail {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    original_title: Option<String>,
    #[serde(default)]
    overview: Option<String>,
    #[serde(default)]
    poster_path: Option<String>,
    #[serde(default)]
    backdrop_path: Option<String>,
    #[serde(default)]
    release_date: Option<String>,
    #[serde(default)]
    runtime: Option<i32>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    vote_average: Option<f64>,
    #[serde(default)]
    genres: Vec<TmdbGenre>,
}

// 电影详情：中文优先，简介为空时用英文补
async fn tmdb_movie_detail(client: &reqwest::Client, key: &str, movie_id: i64) -> TmdbMovieDetail {
    let fetch = |lang: &'static str| {
        let url = format!(
            "https://api.tmdb.org/3/movie/{}?api_key={}&language={}",
            movie_id, key, lang
        );
        let client = client.clone();
        async move {
            let resp = client.get(&url).send().await.ok()?;
            if !resp.status().is_success() {
                return None;
            }
            resp.json::<TmdbMovieDetail>().await.ok()
        }
    };
    let mut detail = fetch("zh-CN").await.unwrap_or_default();
    if detail.overview.as_deref().unwrap_or("").trim().is_empty() {
        if let Some(en) = fetch("en-US").await {
            detail.overview = en.overview;
            if detail.backdrop_path.is_none() {
                detail.backdrop_path = en.backdrop_path;
            }
            if detail.poster_path.is_none() {
                detail.poster_path = en.poster_path;
            }
        }
    }
    detail
}

async fn auto_fetch_movie_metadata_inner(
    db: &Mutex<Connection>,
    data_dir: &Path,
    series_id: &str,
    tmdb_id_override: Option<i64>,
    app: Option<&tauri::AppHandle>,
) -> AppResult<String> {
    let (title, tmdb_id): (String, i64) = {
        let conn = db.lock();
        conn.query_row(
            "SELECT title, tmdb_id FROM series WHERE id = ?1",
            params![series_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?
    };
    let key: String = {
        let conn = db.lock();
        conn.query_row("SELECT value FROM settings WHERE key = 'tmdb_api_key'", [], |r| r.get(0))
            .unwrap_or_default()
    };
    if key.is_empty() {
        return Err(AppError::Custom("未配置 TMDB API Key，请到设置页填写".to_string()));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;

    // 进度：搜索 1 + 海报 1 + 背景图 1
    let total = 3usize;
    let emit = |n: usize| {
        if let Some(app) = app {
            let _ = app.emit("series-cover-progress", SeriesCoverProgress { done: n, total });
        }
    };

    // 用户选定 > 库里已有 > 按标题搜索
    let found_id = if let Some(id) = tmdb_id_override.filter(|v| *v > 0) {
        id
    } else if tmdb_id > 0 {
        tmdb_id
    } else {
        let mut candidates = vec![title.trim().to_string()];
        let cleaned = clean_search_title(&title);
        if !cleaned.is_empty() && cleaned != title.trim() {
            candidates.push(cleaned);
        }
        let mut found: Option<i64> = None;
        'outer: for q in candidates {
            for lang in ["zh-CN", "en-US"] {
                let url = format!(
                    "https://api.tmdb.org/3/search/movie?query={}&api_key={}&language={}",
                    urlencoding::encode(&q),
                    key,
                    lang
                );
                if let Ok(resp) = client.get(&url).send().await {
                    if resp.status().is_success() {
                        if let Ok(parsed) = resp.json::<TmdbMultiResponse>().await {
                            if let Some(item) = parsed.results.into_iter().next() {
                                found = Some(item.id);
                                break 'outer;
                            }
                        }
                    }
                }
            }
        }
        match found {
            Some(v) => v,
            None => return Err(AppError::Custom(format!("未找到匹配电影：{}", title))),
        }
    };
    emit(1);

    let detail = tmdb_movie_detail(&client, &key, found_id).await;
    let covers_dir = data_dir.join("covers");

    // 海报与背景图（固定文件名覆盖写，与剧集同规则）
    let poster_target = covers_dir.join(format!("series_{}.jpg", series_id));
    let bg_target = covers_dir.join(format!("series_bg_{}.jpg", series_id));
    let mut poster_ok = false;
    let mut bg_ok = false;
    if let Some(p) = &detail.poster_path {
        let _ = fs::remove_file(&poster_target); // 换匹配后要覆盖旧图，不能命中 exists 提前返回
        poster_ok = fetch_tmdb_image(
            &client,
            &format!("https://image.tmdb.org/t/p/w500{}", p),
            &poster_target,
        )
        .await
        .is_some();
    }
    emit(2);
    if let Some(b) = &detail.backdrop_path {
        let _ = fs::remove_file(&bg_target);
        bg_ok = fetch_tmdb_image(
            &client,
            &format!("https://image.tmdb.org/t/p/w1280{}", b),
            &bg_target,
        )
        .await
        .is_some();
    }
    emit(3);

    let genres = detail
        .genres
        .iter()
        .map(|g| g.name.as_str())
        .collect::<Vec<_>>()
        .join(" / ");
    let status_cn = detail.status.as_deref().map(map_tmdb_status).unwrap_or_default();
    let overview = detail.overview.clone().unwrap_or_default();
    let movie_title = detail.title.clone().unwrap_or_default();
    let release = detail.release_date.clone().unwrap_or_default();
    let runtime = detail.runtime.unwrap_or(0);

    let conn = db.lock();
    conn.execute("BEGIN TRANSACTION", [])?;
    conn.execute(
        "UPDATE series SET
            overview = CASE WHEN ?1 <> '' THEN ?1 ELSE overview END,
            first_air_date = CASE WHEN ?2 <> '' THEN ?2 ELSE first_air_date END,
            status = CASE WHEN ?3 <> '' THEN ?3 ELSE status END,
            genres = CASE WHEN ?4 <> '' THEN ?4 ELSE genres END,
            vote_average = CASE WHEN ?5 > 0 THEN ?5 ELSE vote_average END,
            aliases = CASE WHEN aliases = '' THEN ?6 ELSE aliases END,
            title = CASE WHEN ?7 <> '' THEN ?7 ELSE title END,
            poster_path = CASE WHEN ?8 <> '' THEN ?8 ELSE poster_path END,
            bg_path = CASE WHEN ?9 <> '' THEN ?9 ELSE bg_path END,
            tmdb_id = ?10,
            updated_at = datetime('now')
         WHERE id = ?11",
        params![
            overview,
            release,
            status_cn,
            genres,
            detail.vote_average.unwrap_or(0.0),
            detail.original_title.clone().unwrap_or_default(),
            movie_title,
            if poster_ok { poster_target.to_string_lossy().to_string() } else { String::new() },
            if bg_ok { bg_target.to_string_lossy().to_string() } else { String::new() },
            found_id,
            series_id
        ],
    )?;
    // 电影只有一条 episode（承载本地文件与观看状态）：补时长/标题/上映日期，剧照用背景图
    conn.execute(
        "UPDATE episodes SET
            runtime_minutes = CASE WHEN ?1 > 0 THEN ?1 ELSE runtime_minutes END,
            title = CASE WHEN ?2 <> '' THEN ?2 ELSE title END,
            air_date = CASE WHEN ?3 <> '' THEN ?3 ELSE air_date END,
            still_path = CASE WHEN ?4 <> '' THEN ?4 ELSE still_path END,
            overview = CASE WHEN ?5 <> '' THEN ?5 ELSE overview END
         WHERE series_id = ?6",
        params![
            runtime,
            detail.title.clone().unwrap_or_default(),
            release,
            if bg_ok { bg_target.to_string_lossy().to_string() } else { String::new() },
            overview,
            series_id
        ],
    )?;
    conn.execute("COMMIT", [])?;
    drop(conn);

    Ok(format!(
        "已获取电影信息：海报 {} 张、背景图 {} 张{}",
        poster_ok as usize,
        bg_ok as usize,
        if overview.is_empty() { "" } else { "、剧情简介" }
    ))
}

// ─────────────────────────────────────────────
// Tauri Commands - Cover Search
// ─────────────────────────────────────────────

#[tauri::command]
async fn search_covers(query: String, source: String) -> AppResult<Vec<CoverSearchResult>> {
    match source.as_str() {
        "steamgriddb" => search_steamgriddb(&query).await,
        "steam" => search_steam_cdn(&query).await,
        _ => search_steamgriddb(&query).await,
    }
}

async fn search_steamgriddb(query: &str) -> AppResult<Vec<CoverSearchResult>> {
    // SteamGridDB API（需要 API key，这里用公开端点）
    let url = format!(
        "https://www.steamgriddb.com/api/v2/search/autocomplete/{}",
        urlencoding::encode(query)
    );
    // 注意：实际使用时需要配置 API key
    // 这里返回空结果，实际实现中应通过前端配置 key
    let _ = url;
    Ok(Vec::new())
}

async fn search_steam_cdn(query: &str) -> AppResult<Vec<CoverSearchResult>> {
    // 通过 Steam Search API 搜索游戏，获取 AppID
    let search_url = format!(
        "https://store.steampowered.com/api/storesearch/?term={}&cc=cn&l=schinese",
        urlencoding::encode(query)
    );
    let client = reqwest::Client::new();
    let resp = client.get(&search_url).send().await?;

    #[derive(Deserialize)]
    struct SteamSearchResp {
        items: Vec<SteamSearchItem>,
    }
    #[derive(Deserialize)]
    struct SteamSearchItem {
        id: u64,
        #[allow(dead_code)]
        name: String,
    }

    let search_result: SteamSearchResp = resp.json().await.unwrap_or(SteamSearchResp { items: vec![] });

    let mut results = Vec::new();
    for item in search_result.items.iter().take(5) {
        let cover_url = format!(
            "https://steamcdn-a.akamaihd.net/steam/apps/{}/header.jpg",
            item.id
        );
        results.push(CoverSearchResult {
            url: cover_url.clone(),
            thumbnail_url: format!(
                "https://steamcdn-a.akamaihd.net/steam/apps/{}/header_292x136.jpg",
                item.id
            ),
            source: "steam".to_string(),
            width: 460,
            height: 215,
        });
    }
    Ok(results)
}

#[tauri::command]
async fn download_cover(state: State<'_, AppState>, url: String, game_id: String) -> AppResult<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let resp = client.get(&url).send().await?;
    let bytes = resp.bytes().await?;

    // 保存到 data/covers/
    let covers_dir = state.data_dir.join("covers");
    fs::create_dir_all(&covers_dir)?;

    let extension = if url.contains(".png") { "png" } else { "jpg" };
    let filename = format!("{}_{}.{}", game_id, Uuid::new_v4().to_string()[..8].to_string(), extension);
    let path = covers_dir.join(&filename);
    fs::write(&path, &bytes)?;

    Ok(path.to_string_lossy().to_string())
}

// ─────────────────────────────────────────────
// Tauri Commands - Stats
// ─────────────────────────────────────────────


#[tauri::command(async)]
fn get_stats(state: State<'_, AppState>) -> AppResult<Stats> {
    let conn = state.db.lock();

    // ── 单值查询小工具：失败一律退化成 0，统计页不该因为某张表异常整页报错 ──
    let scalar = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap_or(0) };

    // ── 条目列表：三类共用 TopEntry 形状，列顺序固定 id/name/sub/cover/wide/seconds/count ──
    let top_of = |sql: &str| -> Vec<TopEntry> {
        let mut stmt = match conn.prepare(sql) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([], |row| {
            Ok(TopEntry {
                id: row.get(0)?,
                name: row.get(1)?,
                sub: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                cover_path: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                wide_path: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                seconds: row.get(5)?,
                count: row.get(6)?,
            })
        });
        match rows {
            Ok(it) => it.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        }
    };

    // 封面墙上限：够铺满几屏，又不至于让一次查询拖慢进页面
    const WALL_LIMIT: i64 = 60;

    // ── 游戏：只统计时长（次数只留给音乐）──
    let game = MediaStats {
        total_seconds: scalar("SELECT COALESCE(SUM(total_seconds), 0) FROM games"),
        play_count: 0,
        library_count: scalar("SELECT COUNT(*) FROM games WHERE hidden = 0"),
        played_count: scalar("SELECT COUNT(*) FROM games WHERE hidden = 0 AND total_seconds > 0"),
        // Steam 游戏统一显示 Steam 短横封面（官方 header 460×215，即 banner_{appid}.jpg）：
        // 优先取本地已下载的该文件；没有时回退 banner_path（可能是手动设置的图）。
        // 未玩过的（total_seconds = 0）也进列表：DESC 排序自然沉底，前端显示「未游玩」
        top: {
            let covers_dir = state.data_dir.join("covers");
            let mut stmt = conn.prepare(&format!(
                "SELECT g.id, g.name, '', g.cover_path, g.banner_path, g.total_seconds, 0, g.steam_appid
                 FROM games g
                 WHERE g.hidden = 0
                 ORDER BY g.total_seconds DESC LIMIT {WALL_LIMIT}",
            ))?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    TopEntry {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        sub: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                        cover_path: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                        wide_path: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                        seconds: row.get(5)?,
                        count: row.get(6)?,
                    },
                    row.get::<_, i64>(7)?,
                ))
            })?;
            rows.filter_map(Result::ok)
                .map(|(mut e, appid)| {
                    if appid > 0 {
                        let header = covers_dir.join(format!("banner_{}.jpg", appid));
                        if header.is_file() {
                            e.wide_path = header.to_string_lossy().to_string();
                        }
                    }
                    e
                })
                .collect()
        },
    };

    // ── 影视：只统计时长，不统计次数（count 恒为 0）──
    // 时长口径：剧集按集计——看完的集按完整时长（runtime×60），没看完的按实际进度
    // （watched_ms/1000，看哪算哪）；电影不建 episodes，回退 series.total_seconds 实际时长
    let video_dur_secs = |alias: &str| format!(
        "CASE WHEN {a}.media_type = 'movie' THEN {a}.total_seconds
              ELSE (SELECT COALESCE(SUM(
                  CASE WHEN e.watched = 1 THEN e.runtime_minutes * 60
                       ELSE e.watched_ms / 1000 END
              ), 0) FROM episodes e WHERE e.series_id = {a}.id) END",
        a = alias,
    );
    let video = MediaStats {
        total_seconds: scalar(
            "SELECT COALESCE(SUM(CASE WHEN media_type = 'movie' THEN total_seconds
                 ELSE (SELECT COALESCE(SUM(
                     CASE WHEN e.watched = 1 THEN e.runtime_minutes * 60
                          ELSE e.watched_ms / 1000 END
                 ), 0) FROM episodes e WHERE e.series_id = series.id) END), 0) FROM series",
        ),
        play_count: 0,
        library_count: scalar("SELECT COUNT(*) FROM series"),
        played_count: scalar(&format!(
            "SELECT COUNT(*) FROM series s WHERE {} > 0",
            video_dur_secs("s"),
        )),
        // sub 显示「已看 X/Y 集」：两个相关子查询各数一次 episodes
        top: top_of(&format!(
            "SELECT s.id, s.title,
                    '已看 ' || (SELECT COUNT(*) FROM episodes e WHERE e.series_id = s.id AND e.watched = 1)
                            || '/' || (SELECT COUNT(*) FROM episodes e2 WHERE e2.series_id = s.id) || ' 集',
                    s.poster_path, s.bg_path, {}, 0
             FROM series s
             WHERE {} > 0
             ORDER BY {} DESC LIMIT {WALL_LIMIT}",
            video_dur_secs("s"),
            video_dur_secs("s"),
            video_dur_secs("s"),
        )),
    };

    // ── 音乐：时长 + 播放次数（次数由 mpv.rs 开播时写 tracks.play_count）──
    let music = MediaStats {
        total_seconds: scalar("SELECT COALESCE(SUM(total_seconds), 0) FROM tracks"),
        play_count: scalar("SELECT COALESCE(SUM(play_count), 0) FROM tracks"),
        library_count: scalar("SELECT COUNT(*) FROM tracks"),
        played_count: scalar("SELECT COUNT(*) FROM tracks WHERE total_seconds > 0"),
        top: top_of(&format!(
            "SELECT t.id, t.title, t.artist, t.cover_path, '', t.total_seconds, t.play_count
             FROM tracks t
             WHERE t.total_seconds > 0
             ORDER BY t.total_seconds DESC LIMIT {WALL_LIMIT}",
        )),
    };

    Ok(Stats {
        game,
        video,
        music,
        total_episodes: scalar("SELECT COUNT(*) FROM episodes"),
        total_watched_episodes: scalar("SELECT COUNT(*) FROM episodes WHERE watched = 1"),
    })
}

// ─────────────────────────────────────────────
// Tauri Commands - Settings
// ─────────────────────────────────────────────

#[tauri::command(async)]
fn get_setting(state: State<'_, AppState>, key: String) -> AppResult<Option<String>> {
    let conn = state.db.lock();
    let result = conn.query_row(
        "SELECT value FROM settings WHERE key = ?",
        [&key],
        |row| row.get::<_, String>(0),
    );
    match result {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(AppError::from(e)),
    }
}

#[tauri::command(async)]
fn set_setting(state: State<'_, AppState>, key: String, value: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        params![key, value],
    )?;
    Ok(())
}

/// 隐藏库设置：写入 settings + 联动 mpv 预加载。
/// 影视/音乐库全隐藏（没有任何媒体播放入口）→ 停掉空闲 mpv 预热（省内存）；
/// 任一媒体库可见 → 恢复预加载并立即补拉一个（下次点播仍热启动）。
/// 只影响空闲预热，正在播放的会话绝不动
#[tauri::command(async)]
fn set_hidden_libraries(app: tauri::AppHandle, state: State<'_, AppState>, libs: Vec<String>) -> AppResult<()> {
    let value = libs.join(",");
    let conn = state.db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('hidden_libraries', ?1)",
        [&value],
    )?;
    drop(conn);
    let media_hidden = libs.iter().any(|l| l == "series") && libs.iter().any(|l| l == "music");
    if media_hidden {
        state.warm.deactivate();
    } else {
        state.warm.resume();
        mpv::ensure_warm_bg(app, state.warm.clone(), state.data_dir.clone());
    }
    Ok(())
}

/// 西瓜键注册表同步：开=写 UseNexusForGameBarEnabled=0（禁 Game Bar 抢 Guide，
/// ZEX 独占唤起）；关=写 1（恢复 Game Bar 用西瓜键打开）。等效「设置→游戏→Xbox Game
/// Bar→使用 Xbox 键打开游戏栏」开关。改的是当前用户的 HKCU 键，不需要管理员权限；
/// Game Bar 进程重启后才完全重新读注册表（ZEX 自己的轮询不依赖它，即时生效）
fn apply_guide_registry(enabled: bool) -> std::io::Result<()> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags("Software\\Microsoft\\GameBar", KEY_READ | KEY_WRITE)?;
    key.set_value("UseNexusForGameBarEnabled", &if enabled { 0u32 } else { 1u32 })?;
    Ok(())
}

// ─────────────────────────────────────────────
// 开机自启（HKCU Run 键）
// ─────────────────────────────────────────────

// 值格式："<exe绝对路径>" --autostart [--show-window]
//   --autostart 自启启动标记；--show-window 自启时直接显示主窗口（不带 = 驻留托盘）
// 当前用户级注册表，无需管理员权限；NSIS 用户级安装路径固定，更新不失效
const AUTOSTART_RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const AUTOSTART_VALUE: &str = "ZEX";

// 读：Run 键里 ZEX 值是否存在（设置页显示以注册表为权威 —— 备份恢复/外部清理
// 后库里的旧值与系统实际状态可能不一致，不能误报「已开启」）
fn autostart_registry_enabled() -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;
    let key = match RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(AUTOSTART_RUN_KEY, KEY_READ)
    {
        Ok(k) => k,
        Err(_) => return false,
    };
    key.get_value::<String, _>(AUTOSTART_VALUE)
        .map(|_| true)
        .unwrap_or(false)
}

// 写/删 Run 键。enabled=false 删值（值不存在视为成功）；enabled=true 写当前 exe
// + 行为参数。返回是否成功：失败时设置库已保存但自启不生效（调用方负责提示）
fn apply_autostart_registry(enabled: bool, show: bool) -> std::io::Result<()> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(AUTOSTART_RUN_KEY, KEY_READ | KEY_WRITE)?;
    if !enabled {
        match key.delete_value(AUTOSTART_VALUE) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(std::io::Error::other(e)),
        }
    } else {
        let mut cmd = format!("\"{}\" --autostart", std::env::current_exe()?.display());
        if show {
            cmd.push_str(" --show-window");
        }
        key.set_value(AUTOSTART_VALUE, &cmd)?;
        Ok(())
    }
}

// 自愈：Run 值指向的 exe 已不存在（用户移动/换目录了程序位置）→ 用当前 exe 重写，
// 并保留值里的行为参数（--show-window）。真实场景：移动后自启静默失效，设置页却
// 还显示「已开启」——启动时修掉，下次自启即生效
fn repair_autostart_registry() {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;
    let key = match RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(AUTOSTART_RUN_KEY, KEY_READ | KEY_WRITE)
    {
        Ok(k) => k,
        Err(_) => return,
    };
    // 没开自启就不管
    let Ok(existing) = key.get_value::<String, _>(AUTOSTART_VALUE) else {
        return;
    };
    // 值格式是 "…\exe" --autostart[…]，第一段引号内是 exe 路径
    let Some(existing_exe) = existing.split('"').nth(1) else {
        return;
    };
    if std::path::Path::new(existing_exe).exists() {
        return; // 值仍指向存在的 exe，无需修复
    }
    let show = existing.contains("--show-window");
    let mut cmd = format!("\"{}\" --autostart", std::env::current_exe().unwrap_or_default().display());
    if show {
        cmd.push_str(" --show-window");
    }
    match key.set_value(AUTOSTART_VALUE, &cmd) {
        Ok(()) => log::info!("开机自启自愈：{} → 当前 exe", existing_exe),
        Err(e) => log::warn!("开机自启自愈失败：{}", e),
    }
}

/// 开机自启开关：落库（导出/导入一致性）+ 写/删注册表 Run 键。
/// 返回注册表同步是否成功：false 时设置已保存但自启不会生效（与西瓜键同语义）
#[tauri::command(async)]
fn set_autostart(state: State<'_, AppState>, enabled: bool, show: bool) -> AppResult<bool> {
    let conn = state.db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('autostart_enabled', ?1)",
        [if enabled { "1" } else { "0" }],
    )?;
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('autostart_show_window', ?1)",
        [if show { "1" } else { "0" }],
    )?;
    drop(conn);
    match apply_autostart_registry(enabled, show) {
        Ok(()) => Ok(true),
        Err(e) => {
            log::warn!("开机自启注册表同步失败：{}", e);
            Ok(false)
        }
    }
}

/// 开机自启当前状态：读注册表为权威（防外部改动/清理/备份恢复后与库不一致）
#[tauri::command]
fn get_autostart_enabled() -> bool {
    autostart_registry_enabled()
}

/// 西瓜键唤起开关：写库 + 同步注册表 + 更新运行时标志。
/// 开=按 Guide 唤起 ZEX（注册表禁 Game Bar 抢键）；关=让位 Game Bar（注册表恢复）。
/// 返回注册表同步是否成功：false 时设置已保存但 Game Bar 可能仍抢西瓜键
/// （注册表写入失败，如键被占用，或 Game Bar 未重启仍用旧值）
#[tauri::command(async)]
fn set_guide_button_enabled(state: State<'_, AppState>, enabled: bool) -> AppResult<bool> {
    let conn = state.db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('guide_button_enabled', ?1)",
        [if enabled { "1" } else { "0" }],
    )?;
    drop(conn);
    state.guide_enabled.store(enabled, Ordering::Relaxed);
    // 同步门闩：关 → 轮询线程下一圈进入阻塞；开 → 立刻唤醒它
    state.guide_gate.set(enabled);
    match apply_guide_registry(enabled) {
        Ok(()) => Ok(true),
        Err(e) => {
            log::warn!("西瓜键注册表同步失败：{}", e);
            Ok(false)
        }
    }
}

/// PS logo 键唤起开关：写库 + 更新运行时标志。
/// 与西瓜键不同：PS 键走 HID 报文直读，不涉及 Game Bar 注册表，无同步失败路径
#[tauri::command(async)]
fn set_ps_button_enabled(state: State<'_, AppState>, enabled: bool) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('ps_button_enabled', ?1)",
        [if enabled { "1" } else { "0" }],
    )?;
    drop(conn);
    state.ps_guide_enabled.store(enabled, Ordering::Relaxed);
    Ok(())
}

// ─────────────────────────────────────────────
// Tauri Commands - Data Export / Import
// ─────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct ExportData {
    games: Vec<Game>,
    series: Vec<Series>,
    seasons: Vec<Season>,
    episodes: Vec<Episode>,
    tracks: Vec<Track>,
    playlists: Vec<Playlist>,
    settings: HashMap<String, String>,
}

#[tauri::command(async)]
fn export_data(state: State<'_, AppState>) -> AppResult<String> {
    // 查库全程持锁（必要），但序列化在锁外做：to_string_pretty 要把整库拼成
    // 带缩进的 JSON（几 MB 字符串），占着全局锁做这件事会让期间所有操作排队
    let export = {
        let conn = state.db.lock();

        // 读取所有数据
        let mut games_stmt = conn.prepare(
            "SELECT id, name, install_dir, exe_path, launch_args, env_vars, work_dir,
                    cover_path, banner_path, bg_path, notes, tags, favorite, hidden,
                    total_seconds, play_count, created_at, updated_at, sort_order, steam_appid FROM games"
        )?;
        let games: Vec<Game> = games_stmt
            .query_map([], |row| {
                Ok(Game {
                    id: row.get(0)?, name: row.get(1)?,
                    install_dir: row.get(2)?, exe_path: row.get(3)?, launch_args: row.get(4)?,
                    env_vars: row.get(5)?, work_dir: row.get(6)?, cover_path: row.get(7)?,
                    banner_path: row.get(8)?, bg_path: row.get(9)?,
                    notes: row.get(10)?, tags: row.get(11)?,
                    favorite: row.get::<_, i32>(12)? != 0, hidden: row.get::<_, i32>(13)? != 0,
                    total_seconds: row.get(14)?, play_count: row.get(15)?,
                    created_at: row.get(16)?, updated_at: row.get(17)?,
                    sort_order: row.get(18)?,
                    steam_appid: row.get::<_, i64>(19)?,
                })
            })?
            .filter_map(Result::ok)
            .collect();

        let mut series_stmt = conn.prepare(&format!("SELECT {} FROM series", SERIES_COLS))?;
        let series: Vec<Series> = series_stmt
            .query_map([], |row| row_to_series(row))?
            .filter_map(Result::ok)
            .collect();

        let mut seasons_stmt = conn.prepare(&format!("SELECT {} FROM seasons", SEASON_COLS))?;
        let seasons: Vec<Season> = seasons_stmt
            .query_map([], |row| row_to_season(row))?
            .filter_map(Result::ok)
            .collect();

        let mut episodes_stmt = conn.prepare(&format!("SELECT {} FROM episodes", EPISODE_COLS))?;
        let episodes: Vec<Episode> = episodes_stmt
            .query_map([], |row| row_to_episode(row))?
            .filter_map(Result::ok)
            .collect();

        let mut tracks_stmt = conn.prepare(&format!("SELECT {} FROM tracks", TRACK_COLS))?;
        let tracks: Vec<Track> = tracks_stmt
            .query_map([], |row| row_to_track(row))?
            .filter_map(Result::ok)
            .collect();

        let playlists = load_playlists(&conn)?;

        let mut settings_stmt = conn.prepare("SELECT key, value FROM settings")?;
        let settings: HashMap<String, String> = settings_stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
            .filter_map(Result::ok)
            .collect();

        ExportData { games, series, seasons, episodes, tracks, playlists, settings }
    };
    Ok(serde_json::to_string_pretty(&export)?)
}

#[tauri::command(async)]
fn import_data(state: State<'_, AppState>, json_data: String) -> AppResult<()> {
    let data: ExportData = serde_json::from_str(&json_data)?;

    let conn = state.db.lock();
    // 单事务批量提交：autocommit 下每条 INSERT 各自一个事务 + fsync，600+ 条要好几秒
    // （同 lib.rs:4240 的封面批量写库）。中途出错整份回滚，不留半份数据
    conn.execute("BEGIN TRANSACTION", [])?;
    let result = import_rows(&conn, data);
    match result {
        Ok(()) => {
            conn.execute("COMMIT", [])?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

/// import_data 的写库主体。单独拆出来是为了让中途的 `?` 短路回到调用方统一 ROLLBACK ——
/// 直接写在命令里的话，出错会带着未提交的事务返回，锁和事务都悬着
fn import_rows(conn: &Connection, data: ExportData) -> AppResult<()> {
    for game in data.games {
        conn.execute(
            "INSERT OR REPLACE INTO games (id, name, install_dir, exe_path, launch_args,
             env_vars, work_dir, cover_path, banner_path, bg_path, notes, tags,
             favorite, hidden, total_seconds, play_count, created_at, updated_at, sort_order,
             steam_appid)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                game.id, game.name, game.install_dir, game.exe_path,
                game.launch_args, game.env_vars, game.work_dir, game.cover_path,
                game.banner_path, game.bg_path, game.notes, game.tags,
                game.favorite as i32, game.hidden as i32, game.total_seconds, game.play_count,
                game.created_at, game.updated_at, game.sort_order, game.steam_appid
            ],
        )?;
    }

    for series in data.series {
        conn.execute(
            "INSERT OR REPLACE INTO series (id, title, aliases, overview, poster_path, bg_path,
             first_air_date, status, tmdb_id, tvdb_id, tags, favorite, vote_average, genres,
             sort_order, media_type, created_at, updated_at, total_seconds)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                series.id, series.title, series.aliases, series.overview, series.poster_path,
                series.bg_path, series.first_air_date, series.status, series.tmdb_id,
                series.tvdb_id, series.tags, series.favorite as i32, series.vote_average,
                series.genres, series.sort_order,
                if series.media_type.is_empty() { default_media_type() } else { series.media_type.clone() },
                series.created_at, series.updated_at, series.total_seconds
            ],
        )?;
    }

    for season in data.seasons {
        conn.execute(
            "INSERT OR REPLACE INTO seasons (id, series_id, season_number, name, overview, poster_path, first_air_date)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                season.id, season.series_id, season.season_number, season.name,
                season.overview, season.poster_path, season.first_air_date
            ],
        )?;
    }

    for episode in data.episodes {
        conn.execute(
            "INSERT OR REPLACE INTO episodes (id, series_id, season_id, episode_number, title,
             overview, still_path, air_date, runtime_minutes, local_path, watched_ms,
             last_watched_at, watched, vote_average)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                episode.id, episode.series_id, episode.season_id, episode.episode_number,
                episode.title, episode.overview, episode.still_path, episode.air_date,
                episode.runtime_minutes, episode.local_path, episode.watched_ms,
                episode.last_watched_at, episode.watched as i32, episode.vote_average
            ],
        )?;
    }

    for track in data.tracks {
        conn.execute(
            "INSERT OR REPLACE INTO tracks (id, file_path, title, artist, album, album_artist,
             track_number, disc_number, duration_seconds, bitrate, cover_path, favorite, play_count,
             total_seconds, created_at, updated_at, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                track.id, track.file_path, track.title, track.artist, track.album,
                track.album_artist, track.track_number, track.disc_number,
                track.duration_seconds, track.bitrate, track.cover_path, track.favorite as i32,
                track.play_count, track.total_seconds, track.created_at, track.updated_at,
                track.sort_order
            ],
        )?;
    }

    for (key, value) in data.settings {
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            params![key, value],
        )?;
    }

    // 歌单：先清掉旧关联（歌单可能已被用户删改），再按导出内容重建
    conn.execute("DELETE FROM playlist_tracks", [])?;
    conn.execute("DELETE FROM playlists", [])?;
    for playlist in data.playlists {
        conn.execute(
            "INSERT OR REPLACE INTO playlists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
            params![playlist.id, playlist.name, playlist.created_at, playlist.updated_at],
        )?;
        for (i, tid) in playlist.track_ids.iter().enumerate() {
            conn.execute(
                "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?, ?, ?)",
                params![playlist.id, tid, i as i64 + 1],
            )?;
        }
    }

    Ok(())
}

// 清除所有数据：清空集/季/影视/游戏/音乐，删除全部封面文件（保留设置项如 API Key）
#[tauri::command(async)]
fn clear_all_data(state: State<'_, AppState>) -> AppResult<String> {
    {
        let conn = state.db.lock();
        conn.execute_batch(
            "DELETE FROM episodes;
             DELETE FROM seasons;
             DELETE FROM series;
             DELETE FROM games;
             DELETE FROM playlist_tracks;
             DELETE FROM playlists;
             DELETE FROM tracks;",
        )?;
    }
    let covers_dir = state.data_dir.join("covers");
    if let Ok(entries) = fs::read_dir(&covers_dir) {
        for entry in entries.flatten() {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok("所有数据已清除".to_string())
}

// ─────────────────────────────────────────────
// Tauri Commands - App Info
// ─────────────────────────────────────────────

#[tauri::command(async)]
fn get_data_dir_cmd(state: State<'_, AppState>) -> String {
    state.data_dir.to_string_lossy().to_string()
}

#[tauri::command(async)]
fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command(async)]
fn open_path(path: String) -> AppResult<()> {
    use std::process::Command;

    if path.is_empty() {
        return Err(AppError::Custom("路径为空".to_string()));
    }

    let path_buf = std::path::PathBuf::from(&path);

    if !path_buf.exists() {
        return Err(AppError::Custom(format!("路径不存在: {}", path)));
    }

    #[cfg(target_os = "windows")]
    {
        // Windows: 使用 explorer 打开文件或文件夹
        if path_buf.is_dir() {
            Command::new("explorer")
                .arg(&path)
                .spawn()
                .map_err(|e| AppError::Custom(format!("无法打开文件夹: {}", e)))?;
        } else {
            // 对于文件，使用默认程序打开
            Command::new("cmd")
                .args(&["/C", "start", "", &path])
                .spawn()
                .map_err(|e| AppError::Custom(format!("无法打开文件: {}", e)))?;
        }
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| AppError::Custom(format!("无法打开路径: {}", e)))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| AppError::Custom(format!("无法打开路径: {}", e)))?;
    }

    Ok(())
}

/// 常见播放器的「启动即全屏」命令行开关。
/// 系统默认关联程序是没法控制全屏的（cmd /C start 只能把文件丢过去），
/// 所以要全屏就必须直接拉起播放器 exe 并带上它自己的开关。
///
/// 注意 PotPlayer 不在此列：它压根没有全屏开关。安装目录的 CmdLine64.txt
/// （播放器自带的命令行文档）只列了 filedlg/urldlg/folderdlg/simple/cap/cam/atv/
/// dtv/dvd/cd/add/insert/autoplay/same/sort/randomize/new/current/clipboard/seek/
/// sub/aud/user_agent/referer/headers/title/volume 这些，exe 二进制里也搜不到
/// "fullscreen" 字样 —— 传 /fullscreen 会被静默忽略。这类播放器无法经命令行进入全屏，
/// 全屏设置对它们不生效。
fn player_fullscreen_args(player: &std::path::Path) -> &'static [&'static str] {
    let name = player
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name.contains("mpc-hc") || name.contains("mpc-be") || name.contains("mpc64") {
        &["/fullscreen"]
    } else if name.contains("vlc") {
        &["--fullscreen"]
    } else if name.contains("mpv") {
        &["--fs"]
    } else {
        &[]
    }
}

/// 播放视频：优先用 settings 里配置的外部播放器（可全屏），没配就退回系统默认关联程序
#[tauri::command(async)]
fn play_video(state: State<'_, AppState>, path: String) -> AppResult<()> {
    play_video_impl(state, path)
}

/// 实现体单独拆出来：`#[tauri::command]` 的函数不能是 `pub(crate)`（生成的辅助宏会重名），
/// 而 mpv 模块在「播放引擎 = 外部」或 mpv 缺失时需要回退到这里
pub(crate) fn play_video_impl(state: State<'_, AppState>, path: String) -> AppResult<()> {
    use std::process::Command;

    if path.is_empty() {
        return Err(AppError::Custom("路径为空".to_string()));
    }
    if !std::path::Path::new(&path).exists() {
        return Err(AppError::Custom(format!("视频文件不存在: {}", path)));
    }

    let (player, fullscreen, extra) = {
        let conn = state.db.lock();
        let get = |key: &str| -> Option<String> {
            conn.query_row(
                "SELECT value FROM settings WHERE key = ?",
                [key],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten()
            .filter(|v| !v.trim().is_empty())
        };
        (
            get("player_path"),
            // 缺省即全屏；显式存 "0" 才关掉
            get("player_fullscreen").map(|v| v != "0").unwrap_or(true),
            get("player_args"),
        )
    };

    let Some(player) = player else {
        return open_path(path);
    };
    let player_path = std::path::PathBuf::from(player.trim());
    if !player_path.exists() {
        return Err(AppError::Custom(format!(
            "播放器不存在: {}（可在设置里重新指定）",
            player_path.display()
        )));
    }

    let fs_args = if fullscreen {
        player_fullscreen_args(&player_path)
    } else {
        &[]
    };

    let mut cmd = Command::new(&player_path);
    cmd.arg(&path);
    cmd.args(fs_args);
    if let Some(extra) = extra {
        cmd.args(extra.split_whitespace());
    }
    // 工作目录设成播放器自己的目录：PotPlayer 之类会在同目录找配置和解码器
    if let Some(dir) = player_path.parent() {
        cmd.current_dir(dir);
    }
    cmd.spawn()
        .map_err(|e| AppError::Custom(format!("无法启动播放器: {}", e)))?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
struct ScannedEpisode {
    file_path: String,
    file_name: String,
    season_number: i32,
    episode_number: i32,
}

#[derive(Debug, Serialize, Deserialize)]
struct ScanResult {
    episodes: Vec<ScannedEpisode>,
}

/// 扫描视频文件夹，识别季和集
#[tauri::command(async)]
fn scan_video_folder(folder_path: String) -> AppResult<ScanResult> {
    use std::path::Path;
    use regex::Regex;

    let path = Path::new(&folder_path);
    if !path.exists() || !path.is_dir() {
        return Err(AppError::Custom("路径不存在或不是文件夹".to_string()));
    }

    // 视频文件扩展名
    let video_exts = ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "ts", "rmvb"];

    // 正则表达式匹配季和集
    // 支持格式：S01E01, s01e01, 1x01, ep01, 第1集, E01, 01等
    let re_s_e = Regex::new(r"[Ss](\d{1,2})[Ee](\d{1,3})").unwrap();
    let re_x = Regex::new(r"(\d{1,2})[xX](\d{1,3})").unwrap();
    let re_ep = Regex::new(r"[Ee][Pp]?(\d{1,3})").unwrap();
    let re_chinese = Regex::new(r"第(\d{1,3})[集话話]").unwrap();
    let re_bracket = Regex::new(r"\[(\d{1,3})\]").unwrap();
    let re_number = Regex::new(r"(?:^|[^\d])(\d{1,3})(?:[^\d]|$)").unwrap();

    let mut episodes = Vec::new();

    // 递归扫描文件夹
    fn scan_dir(
        dir: &Path,
        episodes: &mut Vec<ScannedEpisode>,
        video_exts: &[&str],
        re_s_e: &Regex,
        re_x: &Regex,
        re_ep: &Regex,
        re_chinese: &Regex,
        re_bracket: &Regex,
        re_number: &Regex,
    ) -> Result<(), std::io::Error> {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    scan_dir(&path, episodes, video_exts, re_s_e, re_x, re_ep, re_chinese, re_bracket, re_number)?;
                } else if let Some(ext) = path.extension() {
                    if video_exts.contains(&ext.to_string_lossy().to_lowercase().as_str()) {
                        if let Some(file_name) = path.file_name() {
                            let file_name_str = file_name.to_string_lossy().to_string();

                            // 尝试匹配季和集
                            let (season, episode) = if let Some(caps) = re_s_e.captures(&file_name_str) {
                                // S01E01 格式
                                (caps[1].parse().unwrap_or(1), caps[2].parse().unwrap_or(1))
                            } else if let Some(caps) = re_x.captures(&file_name_str) {
                                // 1x01 格式
                                (caps[1].parse().unwrap_or(1), caps[2].parse().unwrap_or(1))
                            } else if let Some(caps) = re_ep.captures(&file_name_str) {
                                // EP01 格式（默认第1季）
                                (1, caps[1].parse().unwrap_or(1))
                            } else if let Some(caps) = re_chinese.captures(&file_name_str) {
                                // 第1集 格式（默认第1季）
                                (1, caps[1].parse().unwrap_or(1))
                            } else if let Some(caps) = re_bracket.captures(&file_name_str) {
                                // [01] 格式（默认第1季）
                                (1, caps[1].parse().unwrap_or(1))
                            } else if let Some(caps) = re_number.captures(&file_name_str) {
                                // 纯数字（默认第1季）
                                (1, caps[1].parse().unwrap_or(1))
                            } else {
                                // 无法识别，跳过
                                continue;
                            };

                            episodes.push(ScannedEpisode {
                                file_path: path.to_string_lossy().to_string(),
                                file_name: file_name_str,
                                season_number: season,
                                episode_number: episode,
                            });
                        }
                    }
                }
            }
        }
        Ok(())
    }

    scan_dir(path, &mut episodes, &video_exts, &re_s_e, &re_x, &re_ep, &re_chinese, &re_bracket, &re_number)
        .map_err(|e| AppError::Custom(format!("扫描文件夹失败: {}", e)))?;

    // 按季号和集号排序
    episodes.sort_by(|a, b| {
        a.season_number.cmp(&b.season_number)
            .then(a.episode_number.cmp(&b.episode_number))
    });

    Ok(ScanResult { episodes })
}

// ─────────────────────────────────────────────
// Music Commands
// ─────────────────────────────────────────────

// 音频扩展名（lofty 0.24 全格式内置；wma/mp4 不做，避免把视频误当音乐）
const MUSIC_EXTS: &[&str] = &["mp3", "flac", "wav", "ogg", "opus", "m4a", "aac", "ape", "aiff", "mpc", "wv"];

// 解析单个音频文件的内嵌标签 → TrackPreview（title 缺失时用文件名兜底，不落库）
fn parse_audio_tags(path: &Path) -> Option<TrackPreview> {
    use lofty::file::{AudioFile, TaggedFileExt};
    use lofty::prelude::Accessor;
    use lofty::probe::Probe;

    let tagged = Probe::open(path).ok()?.read().ok()?;
    let props = tagged.properties();
    let duration = props.duration().as_secs() as i32;
    // 比特率：优先实际音频码率（VBR 也准）；部分格式（如 FLAC）audio_bitrate 缺失，
    // 退到整体码率 / 平均码率（文件大小 ×8 ÷ 时长）兜底
    let mut bitrate = props
        .audio_bitrate()
        .or_else(|| props.overall_bitrate())
        .map(|b| (b / 1000) as i32)
        .unwrap_or(0);
    if bitrate <= 0 {
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if duration > 0 && size > 0 {
            bitrate = ((size * 8) / (duration as u64 * 1000)) as i32;
        }
    }

    let mut title = String::new();
    let mut artist = String::new();
    let mut album = String::new();
    let mut album_artist = String::new();
    let mut track_number = 0i32;
    let mut disc_number = 0i32;

    // primary_tag 拿第一个内嵌标签；无 primary 时退到 tags 列表（如纯 VorbisComments）
    let tag = tagged.primary_tag().or_else(|| tagged.tags().first());
    if let Some(tag) = tag {
        if let Some(v) = tag.title() { title = v.to_string(); }
        if let Some(v) = tag.artist() { artist = v.to_string(); }
        if let Some(v) = tag.album() { album = v.to_string(); }
        // album_artist 不在 Accessor 里，需按 ItemKey 取文本
        if let Some(v) = tag.get_string(lofty::tag::ItemKey::AlbumArtist) { album_artist = v.to_string(); }
        if let Some(v) = tag.track() { track_number = v as i32; }
        if let Some(v) = tag.disk() { disc_number = v as i32; }
    }

    if title.trim().is_empty() {
        title = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "未知曲目".to_string());
    }

    Some(TrackPreview {
        file_path: path.to_string_lossy().to_string(),
        title,
        artist,
        album,
        album_artist,
        track_number,
        disc_number,
        duration_seconds: duration,
        bitrate,
        cover_path: String::new(),
        already_exists: false,
    })
}

// 把内嵌封面提取为 data/covers/music_<track_id>.jpg（失败返回空串，不影响入库）
fn extract_track_cover(data_dir: &Path, file_path: &Path, track_id: &str) -> String {
    use lofty::file::TaggedFileExt;
    use lofty::probe::Probe;

    let Ok(tagged) = Probe::open(file_path).and_then(|p| p.read()) else {
        return String::new();
    };
    let Some(pic) = tagged.primary_tag().and_then(|t| t.pictures().first()) else {
        return String::new();
    };
    let ext = match pic.mime_type().map(|m| m.as_str()) {
        Some("image/png") => "png",
        _ => "jpg",
    };
    let covers_dir = data_dir.join("covers");
    if fs::create_dir_all(&covers_dir).is_err() {
        return String::new();
    }
    let dest = covers_dir.join(format!("music_{}.{}", track_id, ext));
    if fs::write(&dest, pic.data()).is_ok() {
        dest.to_string_lossy().to_string()
    } else {
        String::new()
    }
}

// 读曲目的内嵌歌词原文（多为带时间轴的 LRC，也可能是纯文本）。有没有时间轴、
// 怎么解析是前端的事，后端只负责把标签里的歌词文本原样掏出来。
// 内嵌位置随格式不同：ID3v2=USLT、Vorbis(FLAC/OGG)=LYRICS、MP4=©lyr，
// lofty 统一映射到 ItemKey::Lyrics。遍历所有标签段：有的文件 primary 段无词、次级段有
#[tauri::command(async)]
fn get_track_lyrics(state: State<'_, AppState>, track_id: String) -> AppResult<Option<String>> {
    use lofty::file::TaggedFileExt;
    use lofty::probe::Probe;

    let file_path = {
        let conn = state.db.lock();
        conn.query_row(
            "SELECT file_path FROM tracks WHERE id = ?1",
            [&track_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    };
    let Some(fp) = file_path else { return Ok(None) };

    let Ok(tagged) = Probe::open(Path::new(&fp)).and_then(|p| p.read()) else {
        return Ok(None);
    };
    for tag in tagged.tags() {
        if let Some(v) = tag.get_string(lofty::tag::ItemKey::Lyrics) {
            let v = v.trim();
            if !v.is_empty() {
                return Ok(Some(v.to_string()));
            }
        }
    }
    Ok(None)
}

// 扫描文件夹（递归）/ 手动选择的文件 → 解析预览列表（不落库，前端勾选后走 import_music_tracks）
#[tauri::command(async)]
fn scan_music_paths(state: State<'_, AppState>, paths: Vec<String>) -> AppResult<Vec<TrackPreview>> {
    // 注意：整个扫盘 + 标签解析都在锁外做。旧版在函数开头就拿 DB 锁并持有到返回，
    // 扫几百首期间界面上任何要读库的操作全部排队（第 1 项异步化后更明显）。
    // 现在只在最后查一次「哪些已入库」时短暂加锁

    // 递归收集目录下的音频文件（目录外散落的文件也接受，手动选择场景）
    fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    collect(&p, out);
                } else if let Some(ext) = p.extension().map(|e| e.to_string_lossy().to_lowercase()) {
                    if MUSIC_EXTS.contains(&ext.as_str()) {
                        out.push(p);
                    }
                }
            }
        }
    }

    let mut files: Vec<PathBuf> = Vec::new();
    for p in &paths {
        let path = Path::new(p);
        if path.is_dir() {
            collect(path, &mut files);
        } else if let Some(ext) = path.extension().map(|e| e.to_string_lossy().to_lowercase()) {
            if MUSIC_EXTS.contains(&ext.as_str()) {
                files.push(path.to_path_buf());
            }
        }
    }
    files.sort();

    let mut previews: Vec<TrackPreview> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for f in files {
        let fp = f.to_string_lossy().to_string();
        if !seen.insert(fp.clone()) { continue; }
        if let Some(preview) = parse_audio_tags(&f) {
            previews.push(preview);
        }
    }

    // 已入库判断：一次性拿全部 file_path 建集合，替代逐首 query_row。
    // 锁只在这一小段内持有，且不做任何文件 IO
    let existing: std::collections::HashSet<String> = {
        let conn = state.db.lock();
        let mut stmt = conn.prepare("SELECT file_path FROM tracks")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for p in previews.iter_mut() {
        p.already_exists = existing.contains(&p.file_path);
    }
    Ok(previews)
}

// 批量导入（预览勾选后）：已存在跳过，其余入库并提取内嵌封面；返回新导入的曲目
#[tauri::command(async)]
fn import_music_tracks(state: State<'_, AppState>, previews: Vec<TrackPreview>) -> AppResult<Vec<Track>> {
    let data_dir = state.data_dir.clone();
    let mut imported = Vec::new();

    for preview in &previews {
        if preview.already_exists { continue; }
        let id = Uuid::new_v4().to_string();
        let title = if preview.title.trim().is_empty() {
            "未知曲目".to_string()
        } else {
            preview.title.trim().to_string()
        };

        // 封面提取在锁外做（纯 IO + 标签读取，不碰库）
        let cover_path = extract_track_cover(&data_dir, Path::new(&preview.file_path), &id);

        let conn = state.db.lock();
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO tracks (id, file_path, title, artist, album, album_artist,
             track_number, disc_number, duration_seconds, bitrate, cover_path, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                     (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM tracks))",
            params![
                id, &preview.file_path, &title, &preview.artist, &preview.album,
                &preview.album_artist, preview.track_number, preview.disc_number,
                preview.duration_seconds, preview.bitrate, &cover_path
            ],
        )?;
        drop(conn);
        if inserted == 0 { continue; } // file_path UNIQUE 冲突（already_exists 标记可能滞后）

        let conn = state.db.lock();
        let track: Track = conn.query_row(
            &format!("SELECT {} FROM tracks WHERE id = ?", TRACK_COLS),
            [&id],
            |row| row_to_track(row),
        )?;
        drop(conn);
        imported.push(track);
    }

    Ok(imported)
}

#[tauri::command(async)]
fn get_all_tracks(state: State<'_, AppState>) -> AppResult<Vec<Track>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM tracks ORDER BY CASE WHEN sort_order = 0 THEN 1 ELSE 0 END, sort_order, created_at, id",
        TRACK_COLS
    ))?;
    let rows = stmt.query_map([], |row| row_to_track(row))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

#[tauri::command(async)]
fn delete_track(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM tracks WHERE id = ?", [&id])?;
    Ok(())
}

// 音乐拖拽排序：按传入顺序批量写 sort_order（事务原子，不碰 updated_at）
#[tauri::command(async)]
fn reorder_tracks(state: State<'_, AppState>, ordered_ids: Vec<String>) -> AppResult<()> {
    let mut conn = state.db.lock();
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("UPDATE tracks SET sort_order = ?1 WHERE id = ?2")?;
        for (i, id) in ordered_ids.iter().enumerate() {
            // 1 基（0 表示未参与排序，排末尾）；拖拽期间被删除的曲目 UPDATE 影响 0 行，跳过无害
            stmt.execute(params![i as i64 + 1, id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command(async)]
fn set_track_favorite(state: State<'_, AppState>, id: String, favorite: bool) -> AppResult<()> {
    let conn = state.db.lock();
    let changed = conn.execute(
        "UPDATE tracks SET favorite = ?1 WHERE id = ?2",
        params![favorite as i32, id],
    )?;
    if changed == 0 {
        return Err(AppError::Custom("曲目不存在".to_string()));
    }
    Ok(())
}

// ─────────────────────────────────────────────
// Playlists（歌单）
// ─────────────────────────────────────────────

// 歌单 + 其曲目 id 列表（一次查询，前端本地过滤无需逐歌单回查）
fn load_playlists(conn: &rusqlite::Connection) -> AppResult<Vec<Playlist>> {
    let mut stmt = conn.prepare("SELECT id, name, created_at, updated_at FROM playlists ORDER BY created_at, id")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, name, created_at, updated_at) = row?;
        // 按加入先后（sort_order, added_at, track_id）取曲目 id
        let ids: Vec<String> = {
            let mut s = conn.prepare(
                "SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY sort_order, added_at, track_id",
            )?;
            let it = s.query_map([&id], |r| r.get::<_, String>(0))?;
            it.filter_map(Result::ok).collect()
        };
        out.push(Playlist { id, name, track_ids: ids, created_at, updated_at });
    }
    Ok(out)
}

#[tauri::command(async)]
fn get_playlists(state: State<'_, AppState>) -> AppResult<Vec<Playlist>> {
    let conn = state.db.lock();
    load_playlists(&conn)
}

// 新建歌单：track_ids 可选（右键「新建歌单」会把当前曲目一起加进去）
#[tauri::command(async)]
fn create_playlist(state: State<'_, AppState>, name: String, track_ids: Option<Vec<String>>) -> AppResult<Playlist> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Custom("歌单名不能为空".to_string()));
    }
    let id = Uuid::new_v4().to_string();
    let mut conn = state.db.lock();
    let tx = conn.transaction()?;
    // 重名兜底：正常路径由前端拦住（CreatePlaylistModal 里同名直接不提交），
    // 这里防的是其它入口和并发 —— 两次创建同名歌单会让侧栏出现两条无法区分的项。
    // 表上没加 UNIQUE：老库里可能已经存在重名数据，加约束会让建表静默失败
    let dup: Option<bool> = tx
        .query_row(
            "SELECT 1 FROM playlists WHERE name = ?1 COLLATE NOCASE",
            [&name],
            |r| r.get(0),
        )
        .optional()?;
    if dup.unwrap_or(false) {
        return Err(AppError::Custom(format!("歌单「{}」已存在", name)));
    }
    tx.execute(
        "INSERT INTO playlists (id, name) VALUES (?1, ?2)",
        params![id, name],
    )?;
    // 实际写进去的曲目 id（按 sort_order 顺序）——直接用它构造返回值，
    // 不必再查库。去重（PRIMARY KEY 兜底）：按入参顺序写 sort_order（1 基）
    let mut inserted: Vec<String> = Vec::new();
    if let Some(ids) = track_ids {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?1, ?2, ?3)",
        )?;
        for (i, tid) in ids.iter().enumerate() {
            if stmt.execute(params![id, tid, i as i64 + 1])? > 0 {
                inserted.push(tid.clone());
            }
        }
    }
    // 时间戳由表默认值生成，取回来保证与后续 get_playlists 一致
    let (created_at, updated_at): (String, String) = tx.query_row(
        "SELECT created_at, updated_at FROM playlists WHERE id = ?1",
        [&id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    tx.commit()?;
    // 事务内读回：原先 commit 后放锁再重取，命令异步化后并发的 delete_playlist
    // 能落在空隙里，歌单明明建好了却报「创建失败」
    Ok(Playlist { id, name, track_ids: inserted, created_at, updated_at })
}

// 添加曲目到歌单：已存在的跳过（PRIMARY KEY 兜底），返回实际新增数
#[tauri::command(async)]
fn add_tracks_to_playlist(state: State<'_, AppState>, playlist_id: String, track_ids: Vec<String>) -> AppResult<i64> {
    let mut conn = state.db.lock();
    // 校验歌单存在
    let exists: Option<bool> = conn
        .query_row("SELECT 1 FROM playlists WHERE id = ?1", [&playlist_id], |r| r.get(0))
        .optional()?;
    if !exists.unwrap_or(false) {
        return Err(AppError::Custom("歌单不存在".to_string()));
    }
    let tx = conn.transaction()?;
    let mut added: usize = 0;
    {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, sort_order)
             VALUES (?1, ?2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM playlist_tracks WHERE playlist_id = ?1))",
        )?;
        for tid in &track_ids {
            added += stmt.execute(params![playlist_id, tid])?;
        }
    }
    tx.commit()?;
    Ok(added as i64)
}

// 从歌单移除一首曲目
#[tauri::command(async)]
fn remove_track_from_playlist(state: State<'_, AppState>, playlist_id: String, track_id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute(
        "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2",
        params![playlist_id, track_id],
    )?;
    Ok(())
}

#[tauri::command(async)]
fn rename_playlist(state: State<'_, AppState>, id: String, name: String) -> AppResult<()> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Custom("歌单名不能为空".to_string()));
    }
    let conn = state.db.lock();
    conn.execute(
        "UPDATE playlists SET name = ?1, updated_at = datetime('now') WHERE id = ?2",
        params![name, id],
    )?;
    Ok(())
}

#[tauri::command(async)]
fn delete_playlist(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM playlists WHERE id = ?", [&id])?; // 关联行 ON DELETE CASCADE
    Ok(())
}

// covers 协议：只允许读取 data/covers 下的文件（请求路径百分号解码后取文件名，
// 绕过 asset 协议作用域的 glob 匹配——后者在 Windows 上因 \\?\ 前缀永远拒绝）
fn serve_covers_file(covers_dir: &Path, request: &tauri::http::Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let encoded = request.uri().path().trim_start_matches('/');
    let decoded = percent_decode_str(encoded).decode_utf8_lossy().to_string();
    let file_name = Path::new(&decoded)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();
    let path = covers_dir.join(&file_name);
    if file_name.is_empty() || !path.exists() || !path.starts_with(covers_dir) {
        return Response::builder()
            .status(404)
            .body(Cow::Borrowed(&b"not found"[..]))
            .unwrap();
    }

    // 缓存策略：不加缓存头时 WebView 每次滚动都重新读盘（封面目录上千张、数百 MB）。
    // 但 series_{id}.jpg / music_{id}.jpg 这类文件名在重新获取元数据后会被原地覆盖，
    // 文件名不变 —— 所以只有带 ?v= 版本号的请求（见 utils/media.ts coverSrc）才能强缓存；
    // 不带版本号的用 mtime+size 做 ETag 走协商缓存：命中时回 304，不读文件内容。
    let versioned = request.uri().query().map(|q| q.contains("v=")).unwrap_or(false);
    let etag = fs::metadata(&path).ok().and_then(|m| {
        let len = m.len();
        let ms = m
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis();
        Some(format!("\"{:x}-{:x}\"", ms, len))
    });
    let cache_control = if versioned {
        "public, max-age=31536000, immutable"
    } else {
        "public, no-cache"
    };
    // If-None-Match 命中 → 304，连 fs::read 都省掉
    if let Some(tag) = &etag {
        let matched = request
            .headers()
            .get("if-none-match")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.split(',').any(|e| e.trim() == tag.as_str()))
            .unwrap_or(false);
        if matched {
            return Response::builder()
                .status(304)
                .header("Cache-Control", cache_control)
                .header("ETag", tag.clone())
                .body(Cow::Borrowed(&b""[..]))
                .unwrap();
        }
    }

    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(_) => {
            return Response::builder()
                .status(404)
                .body(Cow::Borrowed(&b"not found"[..]))
                .unwrap()
        }
    };
    // SGDB 兜底下载的是 PNG，按魔数判断真实类型（文件名统一 .jpg 便于共享复用）
    let mime = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else {
        "image/jpeg"
    };
    let mut builder = Response::builder()
        .header("Content-Type", mime)
        .header("Cache-Control", cache_control);
    if let Some(tag) = etag {
        builder = builder.header("ETag", tag);
    }
    builder.body(Cow::Owned(bytes)).unwrap()
}

// ─────────────────────────────────────────────
// App Entry Point
// ─────────────────────────────────────────────

const TRAY_ID: &str = "zex-tray";
const TRAY_MENU_LABEL: &str = "tray-menu";
const TRAY_MENU_WIDTH: f64 = 200.0;

// 自绘托盘菜单：系统原生菜单没法定制外观，这里用一个无边框透明置顶小窗承载
// （右键托盘时按光标位置弹出，失焦自动收起）
fn build_tray_menu_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    tauri::WebviewWindowBuilder::new(
        app,
        TRAY_MENU_LABEL,
        tauri::WebviewUrl::App("index.html?view=tray-menu".into()),
    )
    .title("ZEX 托盘菜单")
    .inner_size(TRAY_MENU_WIDTH, 60.0) // React 挂载后由 tray_menu_ready 修正确高度
    .decorations(false)
    .transparent(true)   // 让 CSS border-radius 的圆角透明像素不被窗口裁掉
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .visible(false)
    .focused(false)
    .build()
}

// 把菜单放在光标左上方展开，并夹进当前显示器工作区（work_area 已排除任务栏）
fn place_tray_menu(window: &tauri::WebviewWindow, cursor: tauri::PhysicalPosition<f64>) {
    let size = window.outer_size().unwrap_or(tauri::PhysicalSize::new(TRAY_MENU_WIDTH as u32, 140));
    let (w, h) = (size.width as f64, size.height as f64);
    let mut x = (cursor.x - w + 12.0).max(8.0);
    let mut y = cursor.y - h - 12.0;
    if let Ok(Some(monitor)) = window.monitor_from_point(cursor.x, cursor.y) {
        let area = monitor.work_area();
        let ax = area.position.x as f64;
        let ay = area.position.y as f64;
        let aw = area.size.width as f64;
        let ah = area.size.height as f64;
        // work_area 底边 = 任务栏顶部 → 菜单底边停在上方 12px
        y = (ay + ah) - h - 12.0;
        x = x.clamp(ax + 8.0, ax + aw - w - 8.0);
        y = y.clamp(ay, ay + ah - h);
    }
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

fn hide_tray_menu(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(TRAY_MENU_LABEL) {
        let _ = window.hide();
    }
}

// 预渲染：setup() 结束时窗口已建好并挂载完毕，后续每次右键只是 move + show
fn show_tray_menu(app: &tauri::AppHandle, cursor: &tauri::PhysicalPosition<f64>) {
    let Some(window) = app.get_webview_window(TRAY_MENU_LABEL) else {
        log::warn!("托盘菜单窗口尚未就绪，请稍后再试");
        return;
    };
    // 先算位置（此时窗口可能还在上次的 size，先设位置再 show 防止闪一下旧坐标）
    place_tray_menu(&window, *cursor);
    let _ = window.show();
    let _ = window.set_focus();
    // 前端据此重新测量内容高度并回报 tray_menu_ready：菜单高度随播放状态变化
    // （占位 ↔ 完整信息），不校准的话底部「音乐库/退出」会被裁掉
    let _ = app.emit("tray-menu-shown", ());
    // show 之后 outer_size 已是当前真实值，再算一次兜底：窗口尺寸没变时是空操作，
    // 尺寸在渲染过程中变了（比如图片加载撑高）时保证最终位置正确
    place_tray_menu(&window, *cursor);
}

// 前端挂载后回报菜单真实高度：修正窗口尺寸，后续弹出就能定到正确高度
// 以下几个命令刻意不加 (async)：窗口显隐 / 抢焦点 / 改尺寸在 Windows 上要求
// 在主线程（UI 线程）执行，挪到工作线程会出现 set_focus 抢不到前台、show 后闪帧。
// 它们本身也只是几个 Win32 调用，不碰数据库，留在主线程不会卡界面
#[tauri::command]
fn tray_menu_ready(app: tauri::AppHandle, height: f64) {
    let Some(window) = app.get_webview_window(TRAY_MENU_LABEL) else { return };
    let _ = window.set_size(tauri::LogicalSize::new(TRAY_MENU_WIDTH, height.max(80.0)));
    // 建窗时标记为 prebuild 状态（visible=false 且 focused=false），
    // 尺寸修正后继续保持隐藏 —— 等用户真正右键时才显示
}

#[tauri::command]
fn tray_menu_action(app: tauri::AppHandle, action: String) {
    hide_tray_menu(&app);
    match action.as_str() {
        "games" => {
            let _ = app.emit("tray-navigate", "games");
            // 前端切完视图 + 绘制完成后会回调 show_main_window
        }
        "series" => {
            let _ = app.emit("tray-navigate", "series");
        }
        "music" => {
            let _ = app.emit("tray-navigate", "music");
        }
        "quit" => {
            // 真正退出：连播放中的 mpv 一起销毁（区别于「收进托盘」只隐藏窗口）。
            //
            // 顺序要紧：shutdown_all 会轮询等 mpv 进程消失（上限 1.5s，另加强杀后的
            // 150ms），这段时间里主窗口若还在屏幕上，就会和 mpv 全屏窗口的销毁撞在一起
            // —— 播放器是 d3d11 全屏置顶（vo=gpu-next / --ontop / --fullscreen），
            // 它销毁时 DWM 要切回正常合成，屏幕本就会重排一次；ZEX 窗口拖到 1.5s 后
            // 才随进程消失，于是看到两次画面变化叠在一起 = 用过播放器后退出的「黑闪」。
            // 先隐藏窗口，让屏幕在清理开始前就交还给桌面，DWM 的切换落在一次重绘里。
            // 托盘图标也一并去掉，避免退出过程中残留一个点不动的图标
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
            set_tray_visible(&app, false);
            let state = app.state::<AppState>();
            mpv::shutdown_all(&state);
            app.exit(0);
        }
        _ => {}
    }
}

#[tauri::command]
fn close_tray_menu(app: tauri::AppHandle) {
    hide_tray_menu(&app);
}

// ─────────────────────────────────────────────
// 桌面歌词窗口
// ─────────────────────────────────────────────

const LYRICS_LABEL: &str = "desktop-lyrics";
const LYRICS_WIDTH: f64 = 880.0;
const LYRICS_HEIGHT: f64 = 132.0;

// 桌面歌词：无边框透明置顶横条，与托盘菜单一样启动时预建常驻、显隐切换。
// focusable(false)：焦点永不落它身上（游戏时不抢输入焦点）；鼠标事件照常可达，
// 悬停工具栏、拖拽区域都能用。锁定时再叠 set_ignore_cursor_events 变纯展示
fn build_desktop_lyrics_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    tauri::WebviewWindowBuilder::new(
        app,
        LYRICS_LABEL,
        tauri::WebviewUrl::App("index.html?view=desktop-lyrics".into()),
    )
    .title("ZEX 桌面歌词")
    .inner_size(LYRICS_WIDTH, LYRICS_HEIGHT)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .visible(false)
    .focused(false)
    .focusable(false)
    .build()
}

fn lyrics_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
}

// 锁定态内存镜像（权威值在 settings.lyrics_locked）：悬停轮询线程据此判断退出
static LYRICS_LOCKED: AtomicBool = AtomicBool::new(false);
// 悬停轮询线程防重入守卫
static LYRICS_HOVER_POLLING: AtomicBool = AtomicBool::new(false);
// 解锁钮热区（物理屏幕坐标 x,y,w,h），前端量好按钮位置上报。
// 锁定后穿透只放行这一小块：光标进热区才临时关穿透（按钮吃住点击），其余区域永远穿透
static LYRICS_UNLOCK_HOTSPOT: Mutex<Option<(i32, i32, i32, i32)>> = Mutex::new(None);

// 前端上报解锁钮热区（锁定态下轮询线程的放行区域）
#[tauri::command]
fn set_lyrics_unlock_hotspot(x: i32, y: i32, w: i32, h: i32) {
    *LYRICS_UNLOCK_HOTSPOT.lock() = Some((x, y, w, h));
}

// 应用锁定态 + 广播（歌词窗据此切换工具栏/解锁钮渲染）。
// 锁定时顺带起轮询：穿透态下 webview 收不到任何鼠标事件，「只有解锁钮可点」
// 只能由后端盯光标位置实现；解锁时清热区
fn lyrics_set_lock_state(app: &tauri::AppHandle, locked: bool) {
    LYRICS_LOCKED.store(locked, Ordering::SeqCst);
    if !locked {
        *LYRICS_UNLOCK_HOTSPOT.lock() = None;
    }
    if let Some(w) = app.get_webview_window(LYRICS_LABEL) {
        let _ = w.set_ignore_cursor_events(locked);
    }
    let _ = app.emit("lyrics-lock-changed", locked);
    if locked {
        lyrics_start_hover_poll(app);
    }
}

// 锁定悬停轮询：光标进入解锁钮热区 → 临时关穿透（按钮可点）；离开 → 立刻恢复穿透。
// 热区未上报时退回整条歌词矩形兜底（保证一定有解锁入口）。解锁后线程退出。
// 窗口操作一律 run_on_main_thread 回主线程
fn lyrics_start_hover_poll(app: &tauri::AppHandle) {
    if LYRICS_HOVER_POLLING.swap(true, Ordering::SeqCst) {
        return; // 已有线程在跑
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut revealed = false;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(120));
            if !LYRICS_LOCKED.load(Ordering::SeqCst) {
                break; // 已解锁
            }
            let Some(w) = app.get_webview_window(LYRICS_LABEL) else { break };
            if !w.is_visible().unwrap_or(false) {
                continue; // 隐藏时不盯（带锁关窗再开仍锁定，线程不退）
            }
            let mut pt = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
            unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut pt) };
            let hotspot = *LYRICS_UNLOCK_HOTSPOT.lock();
            let inside = match hotspot {
                // 只放行解锁钮这一小块
                Some((hx, hy, hw, hh)) => {
                    pt.x >= hx && pt.x < hx + hw && pt.y >= hy && pt.y < hy + hh
                }
                // 热区还没上报（锁定瞬间/刚重开）：整条歌词兜底，避免没有解锁入口
                None => match (w.outer_position(), w.outer_size()) {
                    (Ok(p), Ok(s)) => {
                        pt.x >= p.x
                            && pt.x < p.x + s.width as i32
                            && pt.y >= p.y
                            && pt.y < p.y + s.height as i32
                    }
                    _ => false,
                },
            };
            if inside != revealed {
                revealed = inside;
                let passthrough = !inside; // 进热区 → 关穿透（按钮可点）；离开 → 恢复
                let w2 = w.clone();
                let _ = app.run_on_main_thread(move || {
                    let _ = w2.set_ignore_cursor_events(passthrough);
                });
            }
        }
        LYRICS_HOVER_POLLING.store(false, Ordering::SeqCst);
    });
}

// 显隐唯一入口：播放条「词」按钮、歌词窗自身 X、停止联动全走这里，状态广播给所有窗口。
// 刻意不加 (async)：窗口显隐在 Windows 上要求主线程执行（见 tray_menu_ready 注释）
#[tauri::command]
fn set_desktop_lyrics_visible(app: tauri::AppHandle, visible: bool) {
    let state = app.state::<AppState>();
    let Some(window) = app.get_webview_window(LYRICS_LABEL) else { return };
    if visible {
        // 位置：优先记忆值（物理坐标 "x,y"），否则主屏工作区底部居中、离底 56px
        let saved = {
            let conn = state.db.lock();
            lyrics_setting(&conn, "lyrics_pos")
        };
        let mut placed = false;
        if let Some(p) = saved {
            if let Some((xs, ys)) = p.split_once(',') {
                if let (Ok(x), Ok(y)) = (xs.trim().parse::<i32>(), ys.trim().parse::<i32>()) {
                    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
                    placed = true;
                }
            }
        }
        if !placed {
            if let Ok(Some(monitor)) = window.primary_monitor() {
                let area = monitor.work_area();
                let scale = monitor.scale_factor();
                let x = area.position.x as f64
                    + (area.size.width as f64 - LYRICS_WIDTH * scale) / 2.0;
                let y = area.position.y as f64 + area.size.height as f64
                    - LYRICS_HEIGHT * scale
                    - 56.0 * scale;
                let _ = window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
            }
        }
        // 重应用持久化的锁定态（重启/重开后穿透状态不丢），锁定则起悬停解锁轮询
        let locked = {
            let conn = state.db.lock();
            lyrics_setting(&conn, "lyrics_locked").as_deref() == Some("1")
        };
        lyrics_set_lock_state(&app, locked);
        let _ = window.show();
    } else {
        // 隐藏前记忆当前位置（物理坐标），下次原位打开。
        // 只在窗口确实可见时记：隐藏态的 outer_position 可能是 0,0 之类的无意义值，
        // 覆盖掉有效记忆（比如歌词窗挂载自检时对已隐藏的窗口再发一次 hide）
        if window.is_visible().unwrap_or(false) {
            if let Ok(pos) = window.outer_position() {
                let conn = state.db.lock();
                let _ = conn.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES ('lyrics_pos', ?1)",
                    [format!("{},{}", pos.x, pos.y)],
                );
            }
        }
        let _ = window.hide();
    }
    {
        // 可见性也持久化：托盘菜单据此决定要不要露出「锁定桌面歌词」项
        let conn = state.db.lock();
        let _ = conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('lyrics_visible', ?1)",
            [if visible { "1" } else { "0" }],
        );
    }
    let _ = app.emit("lyrics-visibility-changed", visible);
}

// 锁定 = 鼠标穿透（点不到歌词窗，直接落到后面的窗口，防游戏/工作误触）。
// 穿透后窗口自己收不到任何点击，解锁走托盘菜单；播放条「词」按钮随时能关窗兜底
#[tauri::command]
fn set_desktop_lyrics_locked(app: tauri::AppHandle, locked: bool) {
    let state = app.state::<AppState>();
    {
        let conn = state.db.lock();
        let _ = conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('lyrics_locked', ?1)",
            [if locked { "1" } else { "0" }],
        );
    }
    lyrics_set_lock_state(&app, locked);
}

// 托盘图标只在「窗口已收起」时出现：窗口开着的时候任务栏已有入口，托盘再放一个是重复的
pub(crate) fn set_tray_visible(app: &tauri::AppHandle, visible: bool) {
    match app.tray_by_id(TRAY_ID) {
        Some(tray) => {
            if let Err(e) = tray.set_visible(visible) {
                log::warn!("托盘图标显隐失败: {}", e);
            }
        }
        None => log::warn!("找不到托盘图标 {}（收进托盘后将无法唤回）", TRAY_ID),
    }
}

// 从托盘唤回主窗口：隐藏 / 最小化两种状态都要复原并抢到焦点，随后收起托盘图标
#[tauri::command]
fn show_main_window_cmd(app: tauri::AppHandle) {
    show_main_window(&app);
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    set_tray_visible(app, false);
    // 窗口唤回 → 恢复手柄导航（gilrs 线程重新推导航事件）
    app.state::<AppState>().gamepad_nav.store(true, Ordering::Relaxed);
    // 收起可能开着的托盘菜单
    hide_tray_menu(app);
}

// 手柄 logo 键（Xbox 西瓜键 / PS 键）按下判定：各自独立开关开时唤起主窗口，
// 除非正在播影视（让位 mpv）或前台已可见。由 gamepad 通道回调：
//   Xbox —— gamepad::spawn_guide_watch 的 XInput 轮询线程（后台/托盘时照常收到）
//   PS   —— gamepad::spawn_ps 的 HID 轮询线程（USB 有线报文，与导航事件分开）
// 公共判定（开关检查由各品牌入口完成）：影视播放让位 + 前台可见性 + 唤起
fn guide_raise(app: &tauri::AppHandle) {
    // 影视播放中（mpv 会话且 mode=Video）：logo 键交给 mpv 内建（播放列表菜单等），不唤起
    let playing_video = app
        .state::<AppState>()
        .mpv
        .lock()
        .as_ref()
        .map(|s| s.mode == mpv::SessionMode::Video)
        .unwrap_or(false);
    if playing_video {
        return;
    }
    // 前台已可见（未最小化）：已在 ZEX 界面，不响应
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        let minimized = window.is_minimized().unwrap_or(false);
        if visible && !minimized {
            return;
        }
    }
    log::debug!("手柄 logo 键唤起主窗口");
    // 与托盘唤回同路径：先发 tray-restore 让前端恢复内容区（contentVisible=true +
    // 两帧绘制完成）再回调 show_main_window_cmd —— 直接 show() 会闪出隐藏前的空白帧
    let _ = app.emit("tray-restore", "");
}

/// Xbox 西瓜键（Guide）：guide_button_enabled 开才唤起，关时让位 Game Bar
fn on_guide_pressed(app: &tauri::AppHandle) {
    // 设置关闭（默认）：西瓜键不唤起 ZEX，让位 Game Bar
    if !app.state::<AppState>().guide_enabled.load(Ordering::Relaxed) {
        return;
    }
    guide_raise(app);
}

/// PS logo 键：ps_button_enabled 开才唤起（HID 直读，不涉及 Game Bar 注册表）
fn on_ps_guide_pressed(app: &tauri::AppHandle) {
    if !app.state::<AppState>().ps_guide_enabled.load(Ordering::Relaxed) {
        return;
    }
    guide_raise(app);
}

// 收进托盘：隐藏窗口 + 亮出托盘图标（点叉、Alt+F4 与前端按钮共用这一条路径）
fn hide_to_tray(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    set_tray_visible(app, true);
    // 收托盘（游戏/播放）→ 暂停手柄导航：mpv 内建 --input-gamepad 接管播放中的手柄
    app.state::<AppState>().gamepad_nav.store(false, Ordering::Relaxed);
}

#[tauri::command]
fn hide_window_to_tray(app: tauri::AppHandle) {
    hide_to_tray(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 初始化日志：同时输出到 stderr 与 data/zex-debug.log（GUI 程序无控制台、stderr 丢失，
    // 复现后读此文件定位。修复稳定后可移除）
    let log_path = {
        let exe = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("."));
        let dir = exe.parent().unwrap_or(std::path::Path::new(".")).join("data");
        let _ = std::fs::create_dir_all(&dir);
        dir.join("zex-debug.log")
    };
    let log_target = match std::fs::OpenOptions::new()
        .create(true).append(true).open(&log_path)
    {
        Ok(f) => env_logger::Target::Pipe(Box::new(f)),
        Err(_) => env_logger::Target::Stderr,
    };
    // 日志文件只增不减，正式版按 warn 收口（异常仍完整留痕）；调试版留 info。
    // 想临时看细节：设环境变量 RUST_LOG=debug 覆盖，无需改代码重编
    let default_level = if cfg!(debug_assertions) { "info" } else { "warn" };
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or(default_level))
        .format_timestamp_millis()
        .target(log_target)
        .init();

    // 获取数据目录
    let data_dir = get_data_dir();
    fs::create_dir_all(&data_dir).expect("Failed to create data directory");

    let db_path = data_dir.join("zex.db");
    log::info!("ZEX data directory: {:?}", data_dir);
    log::info!("ZEX database: {:?}", db_path);

    // 初始化数据库
    let db = init_database(&db_path).expect("Failed to initialize database");

    let app_state = AppState {
        db: Arc::new(Mutex::new(db)),
        running_games: Arc::new(RwLock::new(HashMap::new())),
        data_dir: data_dir.clone(),
        mpv: Arc::new(Mutex::new(None)),
        warm: Arc::new(mpv::WarmSlot::new()),
        gamepad_nav: Arc::new(AtomicBool::new(true)),
        guide_enabled: Arc::new(AtomicBool::new(false)),
        // setup 里读完设置项再按实际值放行
        guide_gate: Arc::new(gamepad::EnableGate::new(false)),
        ps_guide_enabled: Arc::new(AtomicBool::new(false)),
        metadata_fetching: Arc::new(AtomicBool::new(false)),
        move_cancel: Arc::new(AtomicBool::new(false)),
    };

    let covers_dir = data_dir.join("covers");

    tauri::Builder::default()
        // 单实例保护必须第一个注册（插件生效要求）：开机自启后用户再双击 exe 时，
        // 第二个实例启动即退出，这里把已有实例从托盘唤回。回调里不直接操作窗口 ——
        // 走 tray-restore 前端流程（恢复 contentVisible 后两帧再 show+focus），
        // 与托盘左键/手柄 logo 键同一路径，避免闪出隐藏前的空白帧
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = app.emit("tray-restore", "");
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        // 本地图片协议：http://covers.localhost/<编码后的绝对路径>
        .register_uri_scheme_protocol("covers", move |_ctx, request| {
            serve_covers_file(&covers_dir, &request)
        })
        .manage(app_state)
        // 点右上角的叉（以及 Alt+F4）不退出，只隐藏到托盘：游戏时长由后端线程继续累计
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                hide_to_tray(window.app_handle());
            }
        })
        .setup(move |app| {
            // ── 系统托盘：左键唤回窗口，右键菜单进游戏库 / 影视库 / 退出 ──
            let mut tray = TrayIconBuilder::with_id(TRAY_ID)
                .tooltip("ZEX - 游戏与影视库")
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } => {
                        // 不直接 show：前端可能还在 contentVisible=false 的状态，
                        // 先发事件等 React 恢复内容区再回调 show_main_window_cmd
                        let _ = tray.app_handle().emit("tray-restore", "");
                    }
                    // Windows 右键 → 自绘菜单。把光标位置传给 show_tray_menu
                    TrayIconEvent::Click {
                        button: MouseButton::Right,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } => show_tray_menu(tray.app_handle(), &position),
                    TrayIconEvent::Click {
                        button: MouseButton::Right,
                        button_state: MouseButtonState::Down,
                        position,
                        ..
                    } => show_tray_menu(tray.app_handle(), &position),
                    _ => {}
                });
            // 托盘图标用自绘新封面（与顶栏/设置里一致），编译期内嵌，不走 icons/ 应用图标
            tray = tray.icon(tauri::include_image!("resources/tray-icon.png"));
            let tray = tray.build(app)?;

            // ── 启动行为分支 ──
            // 窗口在 tauri.conf.json 里 visible:false（自启驻留托盘需要），这里按启动方式显隐：
            //   手动启动（无 --autostart）          → 显示窗口 + 托盘藏（现状）
            //   --autostart（自启驻留托盘）         → 窗口不显示 + 托盘亮（后台照常记录/预热）
            //   --autostart --show-window（直接显示）→ 与手动启动等价
            // show 发生在 WebView 首帧合成前，手动启动无黑闪、无行为差异
            let is_autostart = std::env::args().any(|a| a == "--autostart");
            let autostart_show = std::env::args().any(|a| a == "--show-window");
            if is_autostart && !autostart_show {
                let _ = tray.set_visible(true);
            } else {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                }
                let _ = tray.set_visible(false);
            }

            // ── 开机自启自愈 ──
            // Run 值指向的 exe 已不存在（用户移动了程序位置）→ 用当前 exe + 值里
            // 保留的行为参数重写。真实场景：移动后自启失效但设置页还显示「已开启」
            repair_autostart_registry();

            // ── 游玩时长轮询（后端驱动）──
            // 窗口隐藏到托盘后 WebView 的定时器会被节流甚至冻结，前端轮询不可靠；
            // 时长累加与会话结算固定由这个线程每 4 秒推进一次，与窗口可见性无关。
            // 会话结束时 emit 事件，前端只负责刷新界面
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    let state = handle.state::<AppState>();
                    let ids: Vec<String> = {
                        let sessions = state.running_games.read();
                        sessions.keys().cloned().collect()
                    };
                    for id in ids {
                        if !poll_game_session(state.inner(), &id) {
                            let _ = handle.emit("game-session-ended", id);
                        }
                    }
                }
            });

            // ── 预渲染托盘菜单 ──
            // WebView2 首次创建窗口需要拉起全栈渲染管线（进程、HTML 解析、JS 执行、
            // React 挂载），耗时通常在 1–3 秒。如果等用户右键时才建窗，第一次弹菜单会有
            // 明显延迟。这里在启动时就创建并挂载好，后续每次右键只需 move + show。
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                // 等主窗口首帧渲染完成再建菜单窗（避免两个 WebView 争初始化资源）
                std::thread::sleep(std::time::Duration::from_millis(1200));
                if let Err(e) = build_tray_menu_window(&app_handle) {
                    log::warn!("预建托盘菜单窗失败: {}", e);
                }
                // 桌面歌词窗同样预建常驻（显隐切换）；错开 400ms 不与菜单窗争 WebView2 初始化
                std::thread::sleep(std::time::Duration::from_millis(400));
                if let Err(e) = build_desktop_lyrics_window(&app_handle) {
                    log::warn!("预建桌面歌词窗失败: {}", e);
                }
                // 歌词窗每次启动都是隐藏态：上次的可见性记忆已失效，清零
                // （托盘菜单靠这个设置决定要不要露出「锁定桌面歌词」项）
                let state = app_handle.state::<AppState>();
                let conn = state.db.lock();
                let _ = conn.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES ('lyrics_visible', '0')",
                    [],
                );
            });

            // ── mpv 预热 ──
            // 后台拉一个空闲 mpv（不弹窗、不占任务栏），点播放直接复用它，消灭
            // "点播放等几百毫秒"的冷启动。后台线程 + 延迟：不抢 ZEX 首帧与托盘
            // 菜单窗的初始化资源，ZEX 照常秒开。先回收上一轮崩溃遗留的空闲孤儿
            // （idle-active 判活，绝不误杀崩溃时正在播放的实例）
            let warm = app.state::<AppState>().warm.clone();
            let warm_app = app.handle().clone();
            let warm_data_dir = data_dir.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(300));
                // 启动即清理上一轮所有遗留 mpv（孤儿会话 + 孤儿预热）：全新 ZEX 进程
                // 会话必然为空，任何 zex-mpv 都是孤儿 —— 否则强杀 ZEX 后旧 mpv 继续
                // 在播（用户"以为停了"），新进程点播放又拉新 mpv → 双 mpv 控制错位，
                // 表现为"播放条无法控制播放"
                mpv::kill_stale_session_mpv();
                if warm.ensure(&warm_app, &warm_data_dir).is_some() {
                    log::info!("mpv 预热完成");
                }
            });

            // ── 手柄（XInput + DualSense 双通道）──
            // XInput（gilrs）轮询 Xbox 系手柄；hidapi 补充通道直读 DualSense 有线报文。
            // nav_enabled 控制是否推给前端（收托盘/播放中 = false，mpv 内建手柄接管）。
            // 两通道共享 PadCounts，任一变化时 emit 完整 { xbox, ps } 连接快照。
            let gamepad_app = app.handle().clone();
            let gamepad_nav = app.state::<AppState>().gamepad_nav.clone();
            let gamepad_counts = std::sync::Arc::new(std::sync::Mutex::new(gamepad::PadCounts::default()));
            gamepad::spawn(gamepad_app.clone(), gamepad_nav.clone(), gamepad_counts.clone());
            // PS 通道除导航外还承担 PS logo 键唤起（on_ps_guide_pressed，独立开关 ps_button_enabled）
            gamepad::spawn_ps(gamepad_app, gamepad_nav, gamepad_counts, Box::new(on_ps_guide_pressed));

            // ── 西瓜键（Guide）唤起主窗口 ──
            // XInput wButtons Guide 位轮询（RAW Input 读不到）；按下时按规则判定是否唤起：
            // 影视播放中（mpv 会话 mode=Video）→ 让位 mpv；前台可见 → 不响应；
            // 最小化/收托盘（含音乐播放中）→ 唤起主窗口。
            // 受设置项 guide_button_enabled 控制（默认关）：关时西瓜键让位 Game Bar
            let guide_enabled = {
                let st = app.state::<AppState>();
                let conn = st.db.lock();
                conn.query_row(
                    "SELECT value FROM settings WHERE key = 'guide_button_enabled'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .map(|v| v == "1")
                .unwrap_or(false)
            };
            app.state::<AppState>().guide_enabled.store(guide_enabled, Ordering::Relaxed);
            // 门闩与开关同步：默认关 → 轮询线程一直阻塞，不空转
            app.state::<AppState>().guide_gate.set(guide_enabled);
            // PS logo 键唤起开关（独立于西瓜键）：默认关；HID 直读无注册表联动
            let ps_guide_enabled = {
                let st = app.state::<AppState>();
                let conn = st.db.lock();
                conn.query_row(
                    "SELECT value FROM settings WHERE key = 'ps_button_enabled'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .map(|v| v == "1")
                .unwrap_or(false)
            };
            app.state::<AppState>().ps_guide_enabled.store(ps_guide_enabled, Ordering::Relaxed);
            // 注册表与设置联动：系统默认 UseNexusForGameBarEnabled=1 时按 Guide 会抢焦点
            // 打开 Game Bar（ZEX 的轮询拦不住系统行为）。开=写 0 禁 Game Bar 抢键（西瓜键
            // 独占给 ZEX 唤起），关=写 1 恢复；不改其它 Game Bar 设置
            if let Err(e) = apply_guide_registry(guide_enabled) {
                log::warn!("西瓜键注册表同步失败：{}", e);
            }
            let guide_app = app.handle().clone();
            let guide_gate = app.state::<AppState>().guide_gate.clone();
            gamepad::spawn_guide_watch(guide_app, guide_gate, Box::new(on_guide_pressed));

            log::info!("ZEX started successfully");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Disk Management
            get_disk_volumes, get_folder_size, apply_game_moves, cancel_disk_move, steam_library_drives,
            steam_library_paths, find_game_root, find_main_exe,
            // Series Disk Management
            get_series_disk_layout, apply_series_moves,
            // Games
            get_all_games, get_game, create_game, update_game, delete_game, filter_games, reorder_games,
            set_game_cover, fetch_cover_options, set_game_cover_url, set_game_banner_url,
            fetch_all_steam_covers,
            // Steam
            scan_steam_library, import_steam_games,
            // 移动 Steam 游戏后静默重启 Steam（安全检查 + -shutdown 优雅退出 + -silent 托盘启动）
            restart_steam_for_recognition,
            // Sessions
            launch_game, check_game_running, on_game_exit,
            // Series
            get_all_series, create_series, update_series, delete_series,
            get_series_library, get_series_detail, set_series_favorite, reorder_series,
            // TMDB 自动封面 + 元数据
            auto_fetch_series_metadata, search_tmdb,
            // Seasons
            get_seasons, create_season, delete_season, mark_season_watched,
            // Episodes
            get_episodes, create_episode, update_episode, delete_episode,
            update_watch_progress, mark_episode_watched, touch_episode_played,
            // Covers
            search_covers, download_cover,
            // Stats
            get_stats,
            // Settings
            get_setting, set_setting, set_hidden_libraries, set_guide_button_enabled, set_ps_button_enabled,
            // Autostart
            get_autostart_enabled, set_autostart,
            // Data
            export_data, import_data, clear_all_data,
            // Music
            get_all_tracks, scan_music_paths, import_music_tracks, delete_track, reorder_tracks, set_track_favorite,
            get_track_lyrics,
            // Playlists
            get_playlists, create_playlist, add_tracks_to_playlist, remove_track_from_playlist, rename_playlist, delete_playlist,
            // App
            // 内置播放器（mpv + IPC）
            mpv::play_episode, mpv::mpv_load_subtitle, mpv::mpv_quit, mpv::mpv_available,
            // 音乐播放（复用同一 mpv，video=no）
            mpv::play_music, mpv::music_control, mpv::get_music_now_playing,
            // App
            get_data_dir_cmd, get_version, open_path, play_video, scan_video_folder, hide_window_to_tray,
            tray_menu_ready, tray_menu_action, close_tray_menu,
            set_desktop_lyrics_visible, set_desktop_lyrics_locked, set_lyrics_unlock_hotspot,
            show_main_window_cmd,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 退出时结算仍在运行中的会话（游戏可能还开着，但 ZEX 要关了）：
            // 把已观测到的时长写入数据库，否则这次游玩时间会全部丢失。
            // 从未看到游戏进程的会话（启动失败）不写记录
            if let tauri::RunEvent::Exit = event {
                let state = app_handle.state::<AppState>();
                // mpv 预热实例收尾：置位 shutdown（防止 reader 的 EOF 补拉再拉起）
                // 并收掉空闲实例。活跃会话（正在播放的 mpv）不动 —— 保持现有
                // "关 ZEX 后播放器继续"的行为
                state.warm.set_shutdown();
                state.warm.quit_idle();
                // 退出时结算仍在运行中的会话（游戏可能还开着，但 ZEX 要关了）：
                // 把已观测到的时长写入数据库，否则这次游玩时间会全部丢失。
                // 从未看到游戏进程的会话（启动失败）不写记录
                let sessions: Vec<GameSession> = {
                    let s = state.running_games.read();
                    s.values().cloned().collect()
                };
                for session in sessions {
                    if session.process_seen {
                        let _ = close_session(&state, &session.game_id);
                    }
                }
            }
        });
}

#[cfg(test)]
mod library_query_tests {
    use super::*;

    // 列清单 / 行映射 / 聚合查询与真实 schema 对齐（列写错只会在运行时炸，这里提前拦住）
    #[test]
    fn series_library_queries_match_schema() {
        let path = std::env::temp_dir().join("zex_library_query_test.db");
        let _ = fs::remove_file(&path);
        let conn = init_database(&path).expect("init database");

        conn.execute("INSERT INTO series (id, title) VALUES ('s1', '测试剧')", []).unwrap();
        conn.execute(
            "INSERT INTO seasons (id, series_id, season_number, name) VALUES ('se1','s1',1,'第 1 季')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO episodes (id, series_id, season_id, episode_number, title, watched)
             VALUES ('e1','s1','se1',1,'第一集',1)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO episodes (id, series_id, season_id, episode_number, title, watched)
             VALUES ('e2','s1','se1',2,'第二集',0)",
            [],
        ).unwrap();

        let series = conn
            .query_row(&format!("SELECT {} FROM series WHERE id='s1'", SERIES_COLS), [], |r| row_to_series(r))
            .expect("series columns");
        assert_eq!(series.title, "测试剧");
        assert_eq!(series.vote_average, 0.0);

        conn.query_row(&format!("SELECT {} FROM seasons WHERE id='se1'", SEASON_COLS), [], |r| row_to_season(r))
            .expect("season columns");
        conn.query_row(&format!("SELECT {} FROM episodes WHERE id='e1'", EPISODE_COLS), [], |r| row_to_episode(r))
            .expect("episode columns");

        let (total, watched, local, last): (i64, i64, i64, String) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(watched), 0),
                        COALESCE(SUM(CASE WHEN local_path <> '' THEN 1 ELSE 0 END), 0),
                        COALESCE(MAX(last_watched_at), '')
                 FROM episodes WHERE series_id = 's1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .expect("aggregate stats");
        assert_eq!((total, watched, local), (2, 1, 0));
        assert_eq!(last, "");

        let next = query_next_episodes(&conn).expect("next episode query");
        assert_eq!(next.get("s1").map(|e| e.episode_number), Some(2));

        drop(conn);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn tracks_query_matches_schema() {
        let path = std::env::temp_dir().join("zex_tracks_test.db");
        let _ = fs::remove_file(&path);
        let conn = init_database(&path).expect("init database");

        conn.execute(
            "INSERT INTO tracks (id, file_path, title, artist, album, track_number, duration_seconds)
             VALUES ('t1', 'C:/music/01.mp3', '歌', '歌手', '专辑', 1, 180)",
            [],
        ).unwrap();

        let track = conn
            .query_row(&format!("SELECT {} FROM tracks WHERE id='t1'", TRACK_COLS), [], |r| row_to_track(r))
            .expect("track columns");
        assert_eq!(track.title, "歌");
        assert_eq!(track.artist, "歌手");
        assert_eq!(track.track_number, 1);
        assert_eq!(track.duration_seconds, 180);
        assert!(!track.favorite);

        // 删曲目连带清歌单引用（playlist_tracks 外键 CASCADE）
        conn.execute(
            "INSERT INTO playlists (id, name) VALUES ('p1', '测试歌单')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO playlist_tracks (playlist_id, track_id, sort_order)
             VALUES ('p1', 't1', 0)",
            [],
        ).unwrap();
        conn.execute("DELETE FROM tracks WHERE id='t1'", []).unwrap();
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM playlist_tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 0);

        drop(conn);
        let _ = fs::remove_file(&path);
    }
}

#[cfg(test)]
mod auto_fetch_tests {
    use super::*;

    #[tokio::test]
    async fn test_auto_fetch_series_metadata() {
        let db_path = "D:/ZEX/src-tauri/target/debug/data/zex.db";
        let data_dir = PathBuf::from("D:/ZEX/src-tauri/target/debug/data");
        let conn = Connection::open(db_path).unwrap();
        let db = Mutex::new(conn);
        let series_id = "d7116109-397a-4dbb-9cb6-70f12679772e";

        match auto_fetch_series_metadata_inner(&db, &data_dir, series_id, None, None).await {
            Ok(msg) => println!("SUCCESS: {}", msg),
            Err(e) => println!("ERROR: {:?}", e),
        }
    }
}
