use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use parking_lot::{Mutex, RwLock};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, Emitter};
use thiserror::Error;

mod mpv;
mod archive;
mod gamepad;
mod rtss;
mod sync;
mod stats;
mod lyrics;
mod games;
mod folders;
mod music;
mod metadata;
mod settings;
mod series;
mod steam;
mod disk;

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
    /// 串行化归档与路径/库修改；取消标志不与磁盘移动共用。
    pub(crate) archive_gate: Arc<AtomicBool>,
    pub(crate) archive_cancel: Arc<AtomicBool>,
    /// 应用正在退出标志：托盘「退出」的清理阶段置位（shutdown_all 第一步）。
    /// reader 的 end-file/EOF 分支据此不再唤回主窗口、不再补拉预热 —— 否则退出
    /// 中途窗口被弹出又销毁（闪屏）、预热被拉起来又被强杀
    pub(crate) exiting: Arc<AtomicBool>,
    /// 肃正协议：同步线程在跑 / 有待跑请求。两个原子做「合并去重 + 串行化」，
    /// 保证同一时刻只有一个线程读改写核心文件（见 sync.rs）
    pub(crate) sync_running: Arc<AtomicBool>,
    pub(crate) sync_pending: Arc<AtomicBool>,
}

#[derive(Clone)]
pub struct GameSession {
    pub game_id: String,
    pub process_id: u32,
    pub start_time: DateTime<Utc>,   // 累计锚点（实时累加时动态前移）
    pub launch_start: DateTime<Utc>, // 会话真实开始时间（写会话记录用）
    pub exe_path: String,
    pub install_dir: String,
    pub monitor_process: String, // 用户指定的监听进程（空 = 只按 exe_path/install_dir 匹配）
    pub process_seen: bool,
    pub miss_count: u32,
    pub no_window_polls: u32, // 进程在但无可见窗口的连续轮询数
    pub accumulated: i64,     // 本会话已累计的秒数（实时增量写入 total_seconds 的总和）
}

// ─────────────────────────────────────────────
// Database Helpers
// ─────────────────────────────────────────────

pub fn get_data_dir() -> PathBuf {
    // 优先使用 exe 所在目录的 data/ 文件夹（便携模式）
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(data_dir) = exe_path.parent() {
            let portable = data_dir.join("data");
            // 便携优先，但必须真能写：仅 .exists() 会把只读/无权限目录也选中，之后
            // Connection::open 必然失败（启动即崩）。用建+删探针确认可写，不行则回退 AppData
            if fs::create_dir_all(&portable).is_ok() && dir_writable(&portable) {
                return portable;
            }
        }
    }
    // 回退到 AppData
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ZEX")
}

// 目录是否真的可写：建一个唯一探针文件再删掉。.exists() 判不出只读/无写权限目录
fn dir_writable(dir: &std::path::Path) -> bool {
    let probe = dir.join(format!(".zex-write-probe-{}", uuid::Uuid::new_v4()));
    match fs::File::create(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

// 启动期致命错误：GUI 程序无控制台，panic 只表现为「双击没反应」。弹一个原生错误框
// 说明路径与原因再退出，让用户至少知道发生了什么，而不是进程静默消失
fn fatal_dialog(msg: &str) -> ! {
    log::error!("启动失败: {}", msg);
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let text: Vec<u16> = msg.encode_utf16().chain(std::iter::once(0)).collect();
        let caption: Vec<u16> = "ZEX 启动失败".encode_utf16().chain(std::iter::once(0)).collect();
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), MB_OK | MB_ICONERROR);
    }
    std::process::exit(1);
}

// 求一组文件路径的公共目录前缀（各自去掉文件名后按 '/' 分量取公共前缀）。迁移时直接作每部
// 剧的「剧根」边界传给 season_from_path（不取 .parent()）：扫描器从不解析剧根自身名，迁移
// 同口径才能避免「平铺且剧根名带季标记」的剧被多解析一层而与扫描/电视端分叉（见复核回归）。
fn common_dir_prefix(paths: &[String]) -> String {
    if paths.is_empty() {
        return String::new();
    }
    let dirs: Vec<Vec<String>> = paths
        .iter()
        .map(|p| {
            let n = p.replace('\\', "/");
            let mut c: Vec<String> = n.split('/').map(|s| s.to_string()).collect();
            c.pop(); // 去掉文件名
            c
        })
        .collect();
    let first = &dirs[0];
    let mut len = first.len();
    for d in &dirs[1..] {
        let mut i = 0;
        while i < len && i < d.len() && d[i] == first[i] {
            i += 1;
        }
        len = i;
    }
    first[..len].join("/")
}

/// 存量「压扁多季」修复（修正版）。整段事务包裹，失败回滚；body 见 resplit_body。
/// 只改 episodes.season_id —— watched/watched_ms/last_watched_at 一律不动，进度不丢。
fn migrate_resplit_seasons(conn: &Connection) -> AppResult<()> {
    conn.execute("BEGIN", [])?;
    match resplit_body(conn) {
        Ok(()) => match conn.execute("COMMIT", []) {
            Ok(_) => Ok(()),
            // COMMIT 失败（磁盘 I/O / BUSY）时 SQLite 可能仍留着活动事务：补一次 ROLLBACK，
            // 否则后续 init_database 的比特率回填 UPDATE 会落进这个悬挂事务、污染整条启动链
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                Err(e.into())
            }
        },
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

/// 迁移主体：只处理 tv 剧中 season_number==1 的集（旧扫描压扁的默认值；2/3/0 的不动），
/// 且文件名无显式 SxxExx/NxM（有则信任文件名、不动）。按该剧（季1）集 local_path 的公共
/// 目录前缀作剧根边界，从目录名推真实季号（0 或 2..50，其余不动），改挂到正确季（缺则建），
/// 末尾清掉被挪空的旧季。幂等。
fn resplit_body(conn: &Connection) -> AppResult<()> {
    let rows: Vec<(String, String, String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT e.id, e.series_id, e.season_id, e.local_path
             FROM episodes e
             JOIN seasons se ON se.id = e.season_id
             JOIN series s ON s.id = e.series_id
             WHERE s.media_type <> 'movie' AND e.local_path <> '' AND se.season_number = 1",
        )?;
        let it = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))
        })?;
        it.filter_map(Result::ok).collect()
    };
    if rows.is_empty() {
        return Ok(());
    }
    // 每部剧的剧根 = 其所有（季1）集 local_path 的公共目录前缀（边界，防越界上溯）
    let mut paths_by_series: HashMap<String, Vec<String>> = HashMap::new();
    for (_, sid, _, lp) in &rows {
        paths_by_series.entry(sid.clone()).or_default().push(lp.clone());
    }
    let roots: HashMap<String, String> = paths_by_series
        .iter()
        .map(|(sid, ps)| (sid.clone(), common_dir_prefix(ps)))
        .collect();
    // 已有季缓存 (series_id, season_number) → season_id
    let mut season_ids: HashMap<(String, i32), String> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT series_id, season_number, id FROM seasons")?;
        let it = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i32>(1)?, r.get::<_, String>(2)?))
        })?;
        for row in it.flatten() {
            season_ids.insert((row.0, row.1), row.2);
        }
    }
    // 文件名显式季识别（与扫描 scan_dir 口径一致：有显式季就信任文件名、不改挂）
    let re_s_e = regex::Regex::new(r"[Ss](\d{1,2})[Ee](\d{1,3})").unwrap();
    let re_x = regex::Regex::new(r"(?:^|[^0-9])(\d{1,2})[xX](\d{1,3})").unwrap();
    let mut emptied: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (ep_id, series_id, old_sid, local_path) in &rows {
        let stem = std::path::Path::new(local_path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if re_s_e.is_match(&stem) || re_x.is_match(&stem) {
            continue; // 文件名有显式季，信任文件名、不改挂
        }
        let root = roots
            .get(series_id)
            .map(|s| s.as_str())
            .filter(|s| !s.is_empty())
            .map(std::path::Path::new);
        let desired = match crate::settings::season_from_path(std::path::Path::new(local_path), root) {
            Some(d) if d != 1 && (0..=50).contains(&d) => d,
            _ => continue, // 推不出 / 仍是季1 / 超上限 → 不动
        };
        let key = (series_id.clone(), desired);
        let target_sid = if let Some(sid) = season_ids.get(&key) {
            sid.clone()
        } else {
            let sid = uuid::Uuid::new_v4().to_string();
            let name = if desired == 0 { "特别篇".to_string() } else { format!("第 {} 季", desired) };
            conn.execute(
                "INSERT INTO seasons (id, series_id, season_number, name, overview, poster_path, first_air_date)
                 VALUES (?1, ?2, ?3, ?4, '', '', '')",
                params![sid, series_id, desired, name],
            )?;
            season_ids.insert(key, sid.clone());
            sid
        };
        conn.execute("UPDATE episodes SET season_id = ?1 WHERE id = ?2", params![target_sid, ep_id])?;
        emptied.insert(old_sid.clone());
    }
    // 清掉被本次迁移挪空的旧季（只删挪出过、且确无集残留的，不碰其它空季）
    for sid in &emptied {
        conn.execute(
            "DELETE FROM seasons WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM episodes WHERE season_id = ?1)",
            params![sid],
        )?;
    }
    Ok(())
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
             updated_at TEXT DEFAULT (datetime('now')),
             -- 绝对格号（0 基）：拖到哪格就钉在哪格；-1 = 未定位（新游戏）→ 落进第一个空格
             slot INTEGER NOT NULL DEFAULT -1
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

         -- 统计存档：游戏/影视/音乐删除后，把它对统计的贡献（时长/次数/集数快照）永久留在这里，
         -- 让统计页「只加不删」——即使实体被删，统计的总时长、封面墙、游玩数都不减少。
         -- key 去重：Steam 游戏用 ext_id=appid、影视用 ext_id=tmdb 合并同一作品的多次删除，
         -- 其余用实体 id；seconds/play_count 每次删除时累加（历史累积），集数取最新快照。
         -- 见 games::archive_stats_entry / delete_game / delete_series / delete_track / get_stats。
         CREATE TABLE IF NOT EXISTS stats_archive (
             key TEXT PRIMARY KEY,
             media TEXT NOT NULL,
             name TEXT NOT NULL DEFAULT '',
             sub TEXT NOT NULL DEFAULT '',
             cover_path TEXT NOT NULL DEFAULT '',
             wide_path TEXT NOT NULL DEFAULT '',
             seconds INTEGER NOT NULL DEFAULT 0,
             play_count INTEGER NOT NULL DEFAULT 0,
             ext_id INTEGER NOT NULL DEFAULT 0,
             episodes INTEGER NOT NULL DEFAULT 0,
             watched_episodes INTEGER NOT NULL DEFAULT 0,
             deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
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

         -- 游戏库文件夹：把多个游戏收成顶层的一格（新库建表；老库由下方迁移补建）。
         -- slot = 绝对格号（0 基）：文件夹钉死在那一格，游戏顺序流动时绕开它。
         -- sort_order 列是旧的「连续序列」模型遗留，已废弃不读（见 folders.rs 顶部）
         CREATE TABLE IF NOT EXISTS game_folders (
             id TEXT PRIMARY KEY,
             name TEXT NOT NULL,
             sort_order INTEGER DEFAULT 0,
             slot INTEGER NOT NULL DEFAULT -1,
             color TEXT DEFAULT '',
             cover_path TEXT DEFAULT '',
             created_at TEXT DEFAULT (datetime('now')),
             updated_at TEXT DEFAULT (datetime('now'))
         );
         -- 文件夹成员：game_id 做主键 = 单一归属（一个游戏最多在一个文件夹里，是收纳不是打标签）。
         -- 两个 ON DELETE CASCADE 把清理交给 SQLite：删游戏 → 成员行消失；删文件夹 → 游戏自动回到顶层
         CREATE TABLE IF NOT EXISTS game_folder_items (
             game_id TEXT PRIMARY KEY,
             folder_id TEXT NOT NULL,
             sort_order INTEGER DEFAULT 0,
             added_at TEXT DEFAULT (datetime('now')),
             FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
             FOREIGN KEY (folder_id) REFERENCES game_folders(id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_game_folder_items_folder ON game_folder_items(folder_id);
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

    // 游戏库文件夹表补建（与上方 CREATE TABLE 保持同步）。这两张表在 execute_batch 的最末尾，
    // 老库若在前面某条语句上报错整批就会中断，这里单独再建一次兜底
    let _ = conn.execute(
        "CREATE TABLE IF NOT EXISTS game_folders (
             id TEXT PRIMARY KEY,
             name TEXT NOT NULL,
             sort_order INTEGER DEFAULT 0,
             slot INTEGER NOT NULL DEFAULT -1,
             color TEXT DEFAULT '',
             cover_path TEXT DEFAULT '',
             created_at TEXT DEFAULT (datetime('now')),
             updated_at TEXT DEFAULT (datetime('now'))
         )",
        [],
    );
    // 文件夹从「连续序列」改为「钉在绝对格号上」：补列并把旧的 1 基混合编号回填成 0 基格号
    // （旧 sort_order 就是当时那一格的 1 基格号）。已有 slot 的库这两条都是空操作
    let _ = conn.execute("ALTER TABLE game_folders ADD COLUMN slot INTEGER NOT NULL DEFAULT -1", []);
    let _ = conn.execute(
        "UPDATE game_folders SET slot = sort_order - 1 WHERE slot < 0 AND sort_order > 0",
        [],
    );
    // 文件夹自定义封面（空 = 显示拼图墙）。与 games.cover_path 同款：covers 目录下的绝对路径
    let _ = conn.execute("ALTER TABLE game_folders ADD COLUMN cover_path TEXT DEFAULT ''", []);
    // 游戏同样改为钉在绝对格号上（整库自由摆放：任何一格都能空着，谁都不往前堆）。
    // 旧的 sort_order 是 1..n 的密集序列，正好等于格号 + 1 → 回填后库里的排布一模一样
    let _ = conn.execute("ALTER TABLE games ADD COLUMN slot INTEGER NOT NULL DEFAULT -1", []);
    let _ = conn.execute(
        "UPDATE games SET slot = sort_order - 1 WHERE slot < 0 AND sort_order > 0",
        [],
    );
    let _ = conn.execute(
        "CREATE TABLE IF NOT EXISTS game_folder_items (
             game_id TEXT PRIMARY KEY,
             folder_id TEXT NOT NULL,
             sort_order INTEGER DEFAULT 0,
             added_at TEXT DEFAULT (datetime('now')),
             FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
             FOREIGN KEY (folder_id) REFERENCES game_folders(id) ON DELETE CASCADE
         )",
        [],
    );
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_game_folder_items_folder ON game_folder_items(folder_id)",
        [],
    );
    // 悬空成员清理：极早期版本/外部改库可能留下指向已删游戏或已删文件夹的成员行
    // （正常路径由 ON DELETE CASCADE 兜住，这里是每次启动的一次性体检）
    let _ = conn.execute(
        "DELETE FROM game_folder_items WHERE game_id NOT IN (SELECT id FROM games)
            OR folder_id NOT IN (SELECT id FROM game_folders)",
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

    // RTSS profile 绑定的真身进程 exe 名：空 = 用 exe_path 文件名。由启动后的
    // 真身检测线程回填（见 rtss::bind_profile_to_real_process），只增不改不删
    let _ = conn.execute("ALTER TABLE games ADD COLUMN rtss_profile_name TEXT DEFAULT ''", []);

    // 用户手动指定的「监听进程」：计时命中 + RTSS（帧数/限帧）profile 绑定名都以它为准。
    // 用于启动器型/多进程游戏，或启动程序与真正渲染进程不同名/不同目录的情况（如脚本、
    // 包装器、私服转发拉起的另一个 exe）。空 = 走 exe_path/install_dir/rtss_profile_name
    // 的自动识别。值可为进程名（nikke.exe）或完整路径
    let _ = conn.execute("ALTER TABLE games ADD COLUMN monitor_process TEXT DEFAULT ''", []);
    // 幂等、检查列的迁移；失败不得伪装成功（归档状态是删源前的持久化屏障）。
    archive::migrate(&conn)?;
    // 一次性兜底：库内游戏若与统计存档里的「同名已删除游戏」并存，把那段历史时长并回来
    // （否则统计页同名两行，且存档行右键没有「更换悬停封面」）。幂等，每次启动跑一遍。
    games::absorb_all_orphans(&conn);
    // 映射盘（SMB）上的游戏曾被 canonicalize 写坏成 "UNC\192.168.5.151…" —— \\?\UNC\…
    // 剥掉 \\?\ 的残骸，既不是盘符也不是 UNC，启动/移动/归档全都失效。这里用 exe_path
    // 重推安装目录还原。幂等：只碰以 "UNC\" 开头的值
    let repaired = disk::repair_broken_paths(&conn);
    if repaired > 0 {
        log::info!("路径修复：{repaired} 条 canonicalize 残骸（UNC\\…）已还原");
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

    // 存量「压扁多季」修复：旧扫描把无 SxxExx 的多季全塞进季1，这里按 local_path 目录名
    // 把各集改挂回正确季（见 migrate_resplit_seasons，整段事务、只改 season_id、不碰进度）。
    // 失败只记日志不阻断启动（幂等，下次启动再试）。须排在 media_type 列（上方 ALTER）之后
    if let Err(e) = migrate_resplit_seasons(&conn) {
        log::warn!("存量多季修复迁移失败(不影响启动): {}", e);
    }

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

    // 误除 1000 的存量修正：旧版导入把 lofty 的 kbps 又除了一次 1000（320kbps → 0、
    // 1411kbps FLAC → 1）。等于 0 的被上面回填修掉了，这里处理非 0 错误值：
    // 错误值 = 真实码率 / 1000，真实码率上限 ~20000kbps → 错误值都落在 [1, 20]；
    // 落入该区间的真实值只有 ≤20kbps 的超低码率语音（它们的 audio_bitrate 路径
    // 除 1000 后必为 0，不可能非 0 入库），重算用同一公式 → 幂等无害
    {
        let rows = {
            let mut stmt = conn.prepare(
                "SELECT file_path, duration_seconds FROM tracks WHERE bitrate > 0 AND bitrate <= 20 AND duration_seconds > 0",
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
                    "UPDATE tracks SET bitrate = ?1 WHERE file_path = ?2 AND bitrate > 0 AND bitrate <= 20",
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
    /// 绝对格号（0 基）：游戏钉死在库里第 slot 格，拖到哪就永远在哪，前面空着也不往前堆。
    /// -1 = 未定位（新添加的游戏）→ 渲染时落进第一个空格。详见 folders.rs 顶部的布局模型。
    /// sort_order 是旧的「连续序列」模型遗留列，只在迁移/导入老数据时被读一次用来回填 slot
    #[serde(default = "default_folder_slot")]
    pub slot: i64,
    // Steam 导入标记：>0 表示来自 Steam（移动游戏时目标路径走 SteamLibrary 结构）
    #[serde(default)]
    pub steam_appid: i64,
    // RTSS profile 绑定的进程 exe 名（如 SB-Win64-Shipping.exe）。启动器型游戏
    // （exe_path 是 SB.exe 这类启动器）在首次启动后由检测线程回填真身名 —— RTSS
    // 按真实渲染进程的 exe 名匹配 profile，绑启动器名单游戏设置永远到不了真身。
    // 空 = 用 exe_path 的文件名（非启动器型游戏的常态）
    #[serde(default)]
    pub rtss_profile_name: String,
    // 用户手动指定的监听进程（计时命中 + RTSS 帧数/限帧的目标进程）。进程名或完整路径；
    // 空 = 自动识别（exe_path / install_dir / rtss_profile_name）。见 monitor_process 迁移注释
    #[serde(default)]
    pub monitor_process: String,
    #[serde(default)]
    pub archive_status: String,
    #[serde(default)]
    pub archive_path: String,
    #[serde(default)]
    pub archive_size: u64,
    #[serde(default)]
    pub archive_original_size: u64,
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

/// 游戏库文件夹：把多个游戏收成顶层的一格。game_ids 为文件夹内成员（按文件夹内顺序），
/// 与 Playlist.track_ids 同款——一次拉全量，前端本地分组，不往 Game 上挂字段。
/// 归属关系存在 game_folder_items（game_id 主键 = 一个游戏最多在一个文件夹里）。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GameFolder {
    pub id: String,
    pub name: String,
    /// 绝对格号（0 基）：文件夹钉死在第 slot 格，游戏顺序流动时绕开它。
    /// -1 = 未定位（导入老数据等），渲染时顺延到末尾。详见 folders.rs 顶部的布局模型
    #[serde(default = "default_folder_slot")]
    pub slot: i64,
    /// 预留：文件夹强调色（空 = 默认青）
    #[serde(default)]
    pub color: String,
    /// 自定义封面（covers 目录下的绝对路径，空 = 卡片显示拼图墙）
    #[serde(default)]
    pub cover_path: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub game_ids: Vec<String>,
}

pub fn default_folder_slot() -> i64 {
    -1
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
// App Entry Point
// ─────────────────────────────────────────────

const TRAY_ID: &str = "zex-tray";
const TRAY_MENU_LABEL: &str = "tray-menu";
const TRAY_MENU_WIDTH: f64 = 200.0;
// 窗口比菜单宽 6px（左右各 3px）：前端 wrapper 用 3px 透明内边距给圆角留
// 抗锯齿缓冲，窗口若与菜单同宽，右侧圆角会被窗口边缘裁平（症状 = 左圆右方）
const TRAY_MENU_WINDOW_WIDTH: f64 = TRAY_MENU_WIDTH + 6.0;
static TRAY_MENU_CURSOR: Mutex<Option<tauri::PhysicalPosition<f64>>> = Mutex::new(None);
static TRAY_MENU_PENDING_SHOW: AtomicBool = AtomicBool::new(false);

// 自绘托盘菜单：系统原生菜单没法定制外观，这里用一个无边框透明置顶小窗承载
// （右键托盘时按光标位置弹出，失焦自动收起）
fn build_tray_menu_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    tauri::WebviewWindowBuilder::new(
        app,
        TRAY_MENU_LABEL,
        tauri::WebviewUrl::App("index.html?view=tray-menu".into()),
    )
    .title("ZEX 托盘菜单")
    .inner_size(TRAY_MENU_WINDOW_WIDTH, 60.0) // React 挂载后由 tray_menu_ready 修正确高度
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
    let Some(_window) = app.get_webview_window(TRAY_MENU_LABEL) else {
        log::warn!("托盘菜单窗口尚未就绪，请稍后再试");
        return;
    };
    *TRAY_MENU_CURSOR.lock() = Some(*cursor);
    // 首次显示前先等待前端回报真实高度，避免临时高度定位后再调整造成闪动。
    TRAY_MENU_PENDING_SHOW.store(true, Ordering::SeqCst);
    let _ = app.emit("tray-menu-shown", ());
}

// 前端挂载后回报菜单真实高度：修正窗口尺寸，后续弹出就能定到正确高度
// 以下几个命令刻意不加 (async)：窗口显隐 / 抢焦点 / 改尺寸在 Windows 上要求
// 在主线程（UI 线程）执行，挪到工作线程会出现 set_focus 抢不到前台、show 后闪帧。
// 它们本身也只是几个 Win32 调用，不碰数据库，留在主线程不会卡界面
#[tauri::command]
fn tray_menu_ready(app: tauri::AppHandle, height: f64) {
    let Some(window) = app.get_webview_window(TRAY_MENU_LABEL) else { return };
    let _ = window.set_size(tauri::LogicalSize::new(TRAY_MENU_WINDOW_WIDTH, height.max(80.0)));
    if let Some(cursor) = *TRAY_MENU_CURSOR.lock() {
        place_tray_menu(&window, cursor);
    }
    if TRAY_MENU_PENDING_SHOW.swap(false, Ordering::SeqCst) {
        let _ = window.show();
        let _ = window.set_focus();
    }
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

// 强制把主窗口唤到最前并抢焦点。Windows 有前台锁：后台进程（收进托盘后 ZEX 就是后台）
// 直接 SetForegroundWindow / set_focus 常被系统拒绝，只闪一下任务栏图标，窗口 show 出来却
// 压在别的窗口后面 —— 正是"点托盘窗口有时不在最上层"的根因。绕过办法：
//   1) 把本线程输入状态挂到当前前台窗口所属线程（AttachThreadInput），共享输入队列后
//      本进程才被允许改前台；
//   2) 瞬时置顶再取消（HWND_TOPMOST → HWND_NOTOPMOST），无论抢没抢到焦点都把窗口抬到
//      Z 序最前，保证"在最上层"；
//   3) 随后 BringWindowToTop + SetForegroundWindow 补焦点，最后解除线程挂接。
// 必须在拥有窗口消息队列的 UI（主）线程调用 —— show_main_window 走的正是非 async 命令，留在主线程。
#[cfg(windows)]
fn force_foreground(hwnd: *mut std::ffi::c_void) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
        SetWindowPos, ShowWindow, HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, SW_SHOW,
    };
    let hwnd = hwnd as HWND;
    if hwnd.is_null() {
        return;
    }
    unsafe {
        let fg = GetForegroundWindow();
        let our_tid = GetCurrentThreadId();
        let fg_tid = if fg.is_null() {
            0
        } else {
            GetWindowThreadProcessId(fg, std::ptr::null_mut())
        };
        // 已是前台线程就不用挂接（挂到自己会失败）；否则挂上以借用其前台权限
        let attached = fg_tid != 0 && fg_tid != our_tid && AttachThreadInput(our_tid, fg_tid, 1) != 0;

        ShowWindow(hwnd, SW_SHOW);
        // 抬到 Z 序最前：瞬时置顶再撤销，等效"置于最前"而不常驻置顶
        SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
        SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);

        if attached {
            AttachThreadInput(our_tid, fg_tid, 0);
        }
    }
}

// 从托盘唤回主窗口：隐藏 / 最小化两种状态都要复原并抢到焦点，随后收起托盘图标
#[tauri::command]
fn show_main_window_cmd(app: tauri::AppHandle) {
    show_main_window(&app);
}

fn show_main_window(app: &tauri::AppHandle) {
    // 应用正在退出（托盘「退出」的清理阶段）：拒绝唤回。主窗口收进托盘后 WebView2
    // 仍活着，reader 的 mpv-closed 事件照样派发、前端照样调 show_main_window_cmd ——
    // 此时把窗口 show 出来会被立刻销毁，屏幕上闪现一帧再消失
    if app.state::<AppState>().exiting.load(Ordering::Relaxed) {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        // set_focus 在后台进程会被 Windows 前台锁拦下（窗口压在别人后面）——
        // 走 force_foreground 挂线程输入 + 瞬时置顶强制抬到最前；拿不到 hwnd 才退回 set_focus
        #[cfg(windows)]
        match window.hwnd() {
            Ok(h) => force_foreground(h.0 as isize as *mut std::ffi::c_void),
            Err(_) => {
                let _ = window.set_focus();
            }
        }
        #[cfg(not(windows))]
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
    if let Err(e) = fs::create_dir_all(&data_dir) {
        fatal_dialog(&format!("无法创建数据目录：\n{}\n\n{}", data_dir.display(), e));
    }

    let db_path = data_dir.join("zex.db");
    log::info!("ZEX data directory: {:?}", data_dir);
    log::info!("ZEX database: {:?}", db_path);

    // 初始化数据库
    let db = match init_database(&db_path) {
        Ok(db) => db,
        Err(e) => fatal_dialog(&format!(
            "数据库初始化失败：\n{}\n\n{}\n\n可能原因：数据库文件损坏、被安全软件锁定，或目录不可写。",
            db_path.display(),
            e
        )),
    };

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
        archive_gate: Arc::new(AtomicBool::new(false)),
        archive_cancel: Arc::new(AtomicBool::new(false)),
        exiting: Arc::new(AtomicBool::new(false)),
        sync_running: Arc::new(AtomicBool::new(false)),
        sync_pending: Arc::new(AtomicBool::new(false)),
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
            music::serve_covers_file(&covers_dir, &request)
        })
        .manage(app_state)
        // 点右上角的叉（以及 Alt+F4）不退出，只隐藏到托盘：游戏时长由后端线程继续累计
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    hide_to_tray(window.app_handle());
                }
                // 肃正协议：从 mpv / 其它窗口回到 ZEX，跟核心文件对一次账
                //（把刚看的进度带过去 + 拉回对端的进度）
                tauri::WindowEvent::Focused(true) => {
                    crate::sync::sync(window.app_handle().clone());
                }
                _ => {}
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
            settings::repair_autostart_registry();

            // ── 游玩时长轮询（后端驱动）──
            // 窗口隐藏到托盘后 WebView 的定时器会被节流甚至冻结，前端轮询不可靠；
            // 时长累加与会话结算固定由这个线程每 30 秒推进一次，与窗口可见性无关。
            // 间隔的代价：会话首尾各最多损失一个间隔的时长（首见锚定 / 尾轮空窗），
            // 换来全进程扫描频率降到原来的 1/8。会话结束时 emit 事件，前端只负责刷新界面
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(30));
                    let state = handle.state::<AppState>();
                    let ids: Vec<String> = {
                        let sessions = state.running_games.read();
                        sessions.keys().cloned().collect()
                    };
                    for id in ids {
                        if !games::poll_game_session(state.inner(), &id) {
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
                if let Err(e) = lyrics::build_desktop_lyrics_window(&app_handle) {
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

            // 旧模型（一份全局广播到所有 profile）迁到 Global + 单游戏 profile。
            // 必须排在预热判断之前 —— 预热读的就是迁移写出来的 Profiles/Global
            rtss::migrate_profile_model(app.handle(), &app.state::<AppState>());

            // ── 存量音乐封面降级（一次性）──
            // 早期版本把内嵌专辑图原样落盘，几百张 1600²+ 大图让音乐库滚动时反复解码。
            // 放后台线程 + 起始让开首帧：单张要读数 MB、解码、重编码，几百张要几十秒
            let covers_app = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                music::migrate_music_covers(&covers_app, &covers_app.state::<AppState>());
            });

            // ── 存量剧集图 progressive→baseline（一次性）──
            // progressive 背景大图在详情页滚动时反复解码 → 卡。独立后台线程跑：只解码库里
            // 少量 progressive 图，比音乐迁移轻得多，单开一条不与其抢核、也不被它拖住。
            let baseline_app = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1000));
                music::migrate_covers_baseline(&baseline_app, &baseline_app.state::<AppState>());
            });

            // ── RTSS 预热 ──
            // 与 mpv 预热同款：后台先把 RTSS 拉起来（含托盘图标秒删 + 关警告框），
            // 点游戏时它已经在跑。判断连单游戏 profile 一起看（全局关、单游戏开
            // 的库也预热）—— 游戏进程先于 RTSS 创建会被补注入，正是
            // "components cannot be hooked" 弹窗的来源。全部没开才不拉：RTSS 是
            // 全局注入型进程，用不上就不该常驻（真要用，launch_game 的同步门会补拉）
            if rtss::preheat_wants_rtss(app.handle(), &app.state::<AppState>()) {
                let rtss_app = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    match rtss::ensure_rtss_running(&rtss_app) {
                        Ok(s) if s.running => log::info!("RTSS 预热完成"),
                        Ok(_) => log::warn!("RTSS 预热：进程未就绪"),
                        Err(e) => log::warn!("RTSS 预热失败：{e}"),
                    }
                });
            }

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
            if let Err(e) = settings::apply_guide_registry(guide_enabled) {
                log::warn!("西瓜键注册表同步失败：{}", e);
            }
            let guide_app = app.handle().clone();
            let guide_gate = app.state::<AppState>().guide_gate.clone();
            gamepad::spawn_guide_watch(guide_app, guide_gate, Box::new(on_guide_pressed));

            // 肃正协议：冷启动先对一次账（把对端进度拉进来）
            crate::sync::sync(app.handle().clone());

            log::info!("ZEX started successfully");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            archive::compress_game, archive::cancel_game_archive, archive::decompress_game, archive::import_archive,
            // Disk Management
            disk::get_disk_volumes, disk::get_folder_size, disk::apply_game_moves, disk::cancel_disk_move, disk::steam_library_drives,
            disk::steam_library_paths, disk::find_game_root, disk::find_main_exe,
            // Series Disk Management
            disk::get_series_disk_layout, disk::apply_series_moves,
            // Games
            games::get_all_games, games::get_game, games::create_game, games::update_game, games::delete_game, games::delete_game_and_files, games::filter_games,
            games::set_game_cover, games::set_game_banner, games::fetch_cover_options, games::set_game_cover_url, games::set_game_banner_url,
            steam::fetch_all_steam_covers,
            // Steam
            steam::scan_steam_library, steam::import_steam_games, steam::import_steam_playtime,
            // 移动 Steam 游戏后静默重启 Steam（安全检查 + -shutdown 优雅退出 + -silent 托盘启动）
            disk::restart_steam_for_recognition,
            // Sessions
            games::launch_game, games::check_game_running, games::on_game_exit,
            // Series
            series::get_all_series, series::create_series, series::update_series, series::delete_series,
            series::get_series_library, series::get_series_detail, series::set_series_favorite, series::reorder_series,
            // TMDB 自动封面 + 元数据
            metadata::auto_fetch_series_metadata, metadata::search_tmdb,
            // Seasons
            series::get_seasons, series::create_season, series::delete_season, series::mark_season_watched,
            // Episodes
            series::get_episodes, series::create_episode, series::update_episode, series::delete_episode,
            series::update_watch_progress, series::mark_episode_watched, series::touch_episode_played,
            // Covers
            metadata::search_covers, metadata::download_cover, metadata::set_brand_cover,
            // Stats
            stats::get_stats, stats::set_game_seconds, stats::delete_stats_entry,
            // Settings
            settings::get_setting, settings::set_setting, settings::set_hidden_libraries, settings::set_guide_button_enabled, settings::set_ps_button_enabled,
            // 肃正协议（跨端进度同步）
            settings::trigger_sync,
            settings::sync_purge,
            // Autostart
            settings::get_autostart_enabled, settings::set_autostart,
            // Data
            settings::export_data, settings::import_data, settings::clear_all_data,
            // Music
            music::get_all_tracks, music::scan_music_paths, music::import_music_tracks, music::delete_track, music::reorder_tracks, music::set_track_favorite,
            music::get_track_lyrics,
            // Playlists
            music::get_playlists, music::create_playlist, music::add_tracks_to_playlist, music::remove_track_from_playlist, music::rename_playlist, music::delete_playlist,
            // 游戏库文件夹（多个游戏收成顶层一格）
            folders::get_game_folders, folders::create_game_folder, folders::rename_game_folder,
            folders::dissolve_game_folder, folders::set_games_folder,
            folders::set_library_slots, folders::reorder_folder_games,
            folders::set_folder_cover, folders::clear_folder_cover,
            folders::get_folder_cover_presets,
            // App
            // 内置播放器（mpv + IPC）
            mpv::play_episode, mpv::mpv_load_subtitle, mpv::mpv_quit, mpv::mpv_available,
            // 音乐播放（复用同一 mpv，video=no）
            mpv::play_music, mpv::music_control, mpv::get_music_now_playing,
            // App
            settings::get_data_dir_cmd, settings::get_version, settings::open_path, settings::play_video, settings::scan_video_folder, hide_window_to_tray,
            tray_menu_ready, tray_menu_action, close_tray_menu,
            lyrics::set_desktop_lyrics_visible, lyrics::set_desktop_lyrics_locked, lyrics::set_lyrics_unlock_hotspot,
            show_main_window_cmd,
            // RTSS 帧数 OSD（随包便携 RTSS 驱动）
            rtss::rtss_status, rtss::rtss_launch, rtss::rtss_open_download_page,
            rtss::rtss_list_targets, rtss::rtss_read_profile, rtss::rtss_write_profile,
            rtss::rtss_clear_profile,
            rtss::rtss_default_profile,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 退出时结算仍在运行中的会话（游戏可能还开着，但 ZEX 要关了）：
            // 把已观测到的时长写入数据库，否则这次游玩时间会全部丢失。
            // 从未看到游戏进程的会话（启动失败）不写记录
            if let tauri::RunEvent::Exit = event {
                let state = app_handle.state::<AppState>();
                // 自己拉起的 RTSS 跟着一起销毁（复用别人的那份不动）。放在 Exit 而不是
                // 托盘「退出」分支里：这样任何退出路径都能收干净
                rtss::shutdown_rtss();
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
                        let _ = games::close_session(&state, &session.game_id);
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

        let next = series::query_next_episodes(&conn).expect("next episode query");
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

        match metadata::auto_fetch_series_metadata_inner(&db, &data_dir, series_id, None, None).await {
            Ok(msg) => println!("SUCCESS: {}", msg),
            Err(e) => println!("ERROR: {:?}", e),
        }
    }
}
