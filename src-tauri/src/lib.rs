use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use parking_lot::{Mutex, RwLock};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use sysinfo::System;
use tauri::{Manager, State};
use thiserror::Error;
use uuid::Uuid;

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
    db: Arc<Mutex<Connection>>,
    running_games: Arc<RwLock<HashMap<String, GameSession>>>,
    data_dir: PathBuf,
}

pub struct GameSession {
    pub game_id: String,
    pub process_id: u32,
    pub start_time: DateTime<Utc>,
    pub exe_path: String,
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
             platform TEXT DEFAULT 'PC',
             install_dir TEXT DEFAULT '',
             exe_path TEXT DEFAULT '',
             launch_args TEXT DEFAULT '',
             env_vars TEXT DEFAULT '{}',
             work_dir TEXT DEFAULT '',
             cover_path TEXT DEFAULT '',
             banner_path TEXT DEFAULT '',
             bg_path TEXT DEFAULT '',
             rating INTEGER DEFAULT 0,
             notes TEXT DEFAULT '',
             tags TEXT DEFAULT '[]',
             favorite INTEGER DEFAULT 0,
             hidden INTEGER DEFAULT 0,
             total_seconds INTEGER DEFAULT 0,
             play_count INTEGER DEFAULT 0,
             created_at TEXT DEFAULT (datetime('now')),
             updated_at TEXT DEFAULT (datetime('now'))
         );

         -- 游戏会话表
         CREATE TABLE IF NOT EXISTS game_sessions (
             id TEXT PRIMARY KEY,
             game_id TEXT NOT NULL,
             start_time TEXT NOT NULL,
             end_time TEXT DEFAULT '',
             duration_seconds INTEGER DEFAULT 0,
             exit_code INTEGER DEFAULT 0,
             crashed INTEGER DEFAULT 0,
             FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
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
         CREATE INDEX IF NOT EXISTS idx_games_platform ON games(platform);
         CREATE INDEX IF NOT EXISTS idx_games_favorite ON games(favorite);
         CREATE INDEX IF NOT EXISTS idx_games_hidden ON games(hidden);
         CREATE INDEX IF NOT EXISTS idx_game_sessions_game_id ON game_sessions(game_id);
         CREATE INDEX IF NOT EXISTS idx_seasons_series_id ON seasons(series_id);
         CREATE INDEX IF NOT EXISTS idx_episodes_season_id ON episodes(season_id);
        "
    )?;

    Ok(conn)
}

// ─────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Game {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub install_dir: String,
    pub exe_path: String,
    pub launch_args: String,
    pub env_vars: String,
    pub work_dir: String,
    pub cover_path: String,
    pub banner_path: String,
    pub bg_path: String,
    pub rating: i32,
    pub notes: String,
    pub tags: String,
    pub favorite: bool,
    pub hidden: bool,
    pub total_seconds: i64,
    pub play_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SteamGame {
    pub name: String,
    pub app_id: u64,
    pub install_dir: String,
    pub exe_path: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GameSessionRecord {
    pub id: String,
    pub game_id: String,
    pub start_time: String,
    pub end_time: String,
    pub duration_seconds: i64,
    pub exit_code: i32,
    pub crashed: bool,
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
    pub created_at: String,
    pub updated_at: String,
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
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Stats {
    pub total_game_seconds: i64,
    pub total_games: i64,
    pub total_series: i64,
    pub total_episodes: i64,
    pub total_watched_episodes: i64,
    pub recent_games: Vec<GameSessionRecord>,
    pub week_game_seconds: i64,
    pub month_game_seconds: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GameFilter {
    pub platform: Option<String>,
    pub tags: Option<Vec<String>>,
    pub min_rating: Option<i32>,
    pub min_seconds: Option<i64>,
    pub first_year: Option<i32>,
    pub favorite: Option<bool>,
    pub hidden: Option<bool>,
    pub search: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CoverSearchResult {
    pub url: String,
    pub thumbnail_url: String,
    pub source: String,
    pub width: i32,
    pub height: i32,
}

// ─────────────────────────────────────────────
// Tauri Commands - Games
// ─────────────────────────────────────────────

#[tauri::command]
fn get_all_games(state: State<'_, AppState>) -> AppResult<Vec<Game>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, name, platform, install_dir, exe_path, launch_args, env_vars, work_dir,
                cover_path, banner_path, bg_path, rating, notes, tags, favorite, hidden,
                total_seconds, play_count, created_at, updated_at
         FROM games WHERE hidden = 0 ORDER BY name"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Game {
            id: row.get(0)?,
            name: row.get(1)?,
            platform: row.get(2)?,
            install_dir: row.get(3)?,
            exe_path: row.get(4)?,
            launch_args: row.get(5)?,
            env_vars: row.get(6)?,
            work_dir: row.get(7)?,
            cover_path: row.get(8)?,
            banner_path: row.get(9)?,
            bg_path: row.get(10)?,
            rating: row.get(11)?,
            notes: row.get(12)?,
            tags: row.get(13)?,
            favorite: row.get::<_, i32>(14)? != 0,
            hidden: row.get::<_, i32>(15)? != 0,
            total_seconds: row.get(16)?,
            play_count: row.get(17)?,
            created_at: row.get(18)?,
            updated_at: row.get(19)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

#[tauri::command]
fn get_game(state: State<'_, AppState>, id: String) -> AppResult<Game> {
    let conn = state.db.lock();
    let game = conn.query_row(
        "SELECT id, name, platform, install_dir, exe_path, launch_args, env_vars, work_dir,
                cover_path, banner_path, bg_path, rating, notes, tags, favorite, hidden,
                total_seconds, play_count, created_at, updated_at
         FROM games WHERE id = ?",
        [&id],
        |row| {
            Ok(Game {
                id: row.get(0)?,
                name: row.get(1)?,
                platform: row.get(2)?,
                install_dir: row.get(3)?,
                exe_path: row.get(4)?,
                launch_args: row.get(5)?,
                env_vars: row.get(6)?,
                work_dir: row.get(7)?,
                cover_path: row.get(8)?,
                banner_path: row.get(9)?,
                bg_path: row.get(10)?,
                rating: row.get(11)?,
                notes: row.get(12)?,
                tags: row.get(13)?,
                favorite: row.get::<_, i32>(14)? != 0,
                hidden: row.get::<_, i32>(15)? != 0,
                total_seconds: row.get(16)?,
                play_count: row.get(17)?,
                created_at: row.get(18)?,
                updated_at: row.get(19)?,
            })
        },
    )?;
    Ok(game)
}

#[tauri::command]
fn create_game(state: State<'_, AppState>, mut game: Game) -> AppResult<Game> {
    if game.id.is_empty() {
        game.id = Uuid::new_v4().to_string();
    }
    let conn = state.db.lock();
    conn.execute(
        "INSERT INTO games (id, name, platform, install_dir, exe_path, launch_args, env_vars,
         work_dir, cover_path, banner_path, bg_path, rating, notes, tags, favorite, hidden,
         total_seconds, play_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            game.id, game.name, game.platform, game.install_dir, game.exe_path,
            game.launch_args, game.env_vars, game.work_dir, game.cover_path,
            game.banner_path, game.bg_path, game.rating, game.notes, game.tags,
            game.favorite as i32, game.hidden as i32, game.total_seconds, game.play_count
        ],
    )?;
    drop(conn);
    get_game(state, game.id)
}

#[tauri::command]
fn update_game(state: State<'_, AppState>, game: Game) -> AppResult<Game> {
    let conn = state.db.lock();
    conn.execute(
        "UPDATE games SET name = ?, platform = ?, install_dir = ?, exe_path = ?, launch_args = ?,
         env_vars = ?, work_dir = ?, cover_path = ?, banner_path = ?, bg_path = ?, rating = ?,
         notes = ?, tags = ?, favorite = ?, hidden = ?, total_seconds = ?, play_count = ?,
         updated_at = datetime('now') WHERE id = ?",
        params![
            game.name, game.platform, game.install_dir, game.exe_path, game.launch_args,
            game.env_vars, game.work_dir, game.cover_path, game.banner_path, game.bg_path,
            game.rating, game.notes, game.tags, game.favorite as i32, game.hidden as i32,
            game.total_seconds, game.play_count, game.id
        ],
    )?;
    drop(conn);
    get_game(state, game.id)
}

#[tauri::command]
fn delete_game(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM games WHERE id = ?", [&id])?;
    Ok(())
}

#[tauri::command]
fn filter_games(state: State<'_, AppState>, filter: GameFilter) -> AppResult<Vec<Game>> {
    let conn = state.db.lock();
    let mut sql = String::from(
        "SELECT id, name, platform, install_dir, exe_path, launch_args, env_vars, work_dir,
                cover_path, banner_path, bg_path, rating, notes, tags, favorite, hidden,
                total_seconds, play_count, created_at, updated_at
         FROM games WHERE 1=1"
    );
    let mut args: Vec<String> = Vec::new();

    if filter.platform.is_some() {
        sql.push_str(" AND platform = ?");
        args.push(filter.platform.unwrap());
    }
    if let Some(fav) = filter.favorite {
        sql.push_str(" AND favorite = ?");
        args.push(if fav { "1" } else { "0" }.to_string());
    }
    if let Some(hid) = filter.hidden {
        sql.push_str(" AND hidden = ?");
        args.push(if hid { "1" } else { "0" }.to_string());
    }
    if let Some(min_r) = filter.min_rating {
        sql.push_str(" AND rating >= ?");
        args.push(min_r.to_string());
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
    sql.push_str(" ORDER BY name");

    let mut stmt = conn.prepare(&sql)?;
    let params: Vec<&dyn rusqlite::ToSql> = args.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let rows = stmt.query_map(params.as_slice(), |row| {
        Ok(Game {
            id: row.get(0)?,
            name: row.get(1)?,
            platform: row.get(2)?,
            install_dir: row.get(3)?,
            exe_path: row.get(4)?,
            launch_args: row.get(5)?,
            env_vars: row.get(6)?,
            work_dir: row.get(7)?,
            cover_path: row.get(8)?,
            banner_path: row.get(9)?,
            bg_path: row.get(10)?,
            rating: row.get(11)?,
            notes: row.get(12)?,
            tags: row.get(13)?,
            favorite: row.get::<_, i32>(14)? != 0,
            hidden: row.get::<_, i32>(15)? != 0,
            total_seconds: row.get(16)?,
            play_count: row.get(17)?,
            created_at: row.get(18)?,
            updated_at: row.get(19)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

// ─────────────────────────────────────────────
// Tauri Commands - Steam Scanning
// ─────────────────────────────────────────────

#[tauri::command]
fn scan_steam_library(steam_path: String) -> AppResult<Vec<SteamGame>> {
    let libraryfolders_path = PathBuf::from(&steam_path).join("steamapps\\libraryfolders.vdf");
    if !libraryfolders_path.exists() {
        return Ok(Vec::new());
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
                name = parts[1].trim_matches('"').trim_matches(',').to_string();
            }
        } else if line.starts_with("\"appid\"") {
            let parts: Vec<&str> = line.splitn(2, "\t").collect();
            if parts.len() > 1 {
                app_id = parts[1].trim_matches('"').trim_matches(',').to_string();
            }
        } else if line.starts_with("\"installdir\"") {
            let parts: Vec<&str> = line.splitn(2, "\t").collect();
            if parts.len() > 1 {
                install_dir = parts[1].trim_matches('"').trim_matches(',').to_string();
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
    })
}

fn find_steam_exe(game_path: &PathBuf, _game_name: &str) -> String {
    // 扫描游戏目录找 .exe 文件
    if let Ok(entries) = fs::read_dir(game_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e == "exe").unwrap_or(false) {
                let name_lower = path.file_name()
                    .map(|n| n.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                // 跳过常见的非主程序
                if !name_lower.contains("unins") && !name_lower.contains("crash")
                    && !name_lower.contains("redist") && !name_lower.contains("vc_redist")
                    && !name_lower.contains("setup") && !name_lower.contains("installer")
                    && !name_lower.contains("launcher") {
                    return path.to_string_lossy().to_string();
                }
            }
        }
    }
    // 没找到就返回目录路径（用户手动选择）
    game_path.to_string_lossy().to_string()
}

#[tauri::command]
fn import_steam_games(state: State<'_, AppState>, steam_games: Vec<SteamGame>) -> AppResult<Vec<Game>> {
    let mut imported = Vec::new();
    for sg in steam_games {
        let game = Game {
            id: Uuid::new_v4().to_string(),
            name: sg.name,
            platform: "PC".to_string(),
            install_dir: sg.install_dir.clone(),
            exe_path: sg.exe_path,
            launch_args: format!("-applaunch {}", sg.app_id),
            env_vars: "{}".to_string(),
            work_dir: sg.install_dir,
            cover_path: String::new(),
            banner_path: String::new(),
            bg_path: String::new(),
            rating: 0,
            notes: format!("Steam AppID: {}", sg.app_id),
            tags: "[]".to_string(),
            favorite: false,
            hidden: false,
            total_seconds: 0,
            play_count: 0,
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };
        let conn = state.db.lock();
        conn.execute(
            "INSERT OR IGNORE INTO games (id, name, platform, install_dir, exe_path, launch_args,
             env_vars, work_dir, cover_path, banner_path, bg_path, rating, notes, tags,
             favorite, hidden, total_seconds, play_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                game.id, game.name, game.platform, game.install_dir, game.exe_path,
                game.launch_args, game.env_vars, game.work_dir, game.cover_path,
                game.banner_path, game.bg_path, game.rating, game.notes, game.tags,
                game.favorite as i32, game.hidden as i32, game.total_seconds, game.play_count
            ],
        )?;
        imported.push(game);
    }
    Ok(imported)
}

// ─────────────────────────────────────────────
// Tauri Commands - Game Sessions / Process Tracking
// ─────────────────────────────────────────────

#[tauri::command]
fn launch_game(state: State<'_, AppState>, game_id: String) -> AppResult<String> {
    let game = get_game(state.clone(), game_id.clone())?;

    let exe = &game.exe_path;
    let args = &game.launch_args;
    let work_dir = if game.work_dir.is_empty() { &game.install_dir } else { &game.work_dir };

    let mut cmd = std::process::Command::new(exe);
    if !args.is_empty() {
        // 解析 launch_args，支持空格分隔
        for arg in args.split_whitespace() {
            cmd.arg(arg);
        }
    }
    cmd.current_dir(work_dir)
        .stdin(Stdio::null())
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
        exe_path: exe.clone(),
    };

    {
        let mut sessions = state.running_games.write();
        sessions.insert(game_id.clone(), session);
    }

    // 更新 play_count
    {
        let conn = state.db.lock();
        conn.execute(
            "UPDATE games SET play_count = play_count + 1 WHERE id = ?",
            [&game_id],
        )?;
    }

    Ok(format!("Game launched with PID: {}", pid))
}

#[tauri::command]
fn check_game_running(state: State<'_, AppState>, game_id: String) -> AppResult<bool> {
    let sessions = state.running_games.read();
    if let Some(session) = sessions.get(&game_id) {
        let mut sys = System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        if sys.process(sysinfo::Pid::from_u32(session.process_id)).is_some() {
            return Ok(true);
        }
    }
    Ok(false)
}

#[tauri::command]
fn on_game_exit(state: State<'_, AppState>, game_id: String) -> AppResult<GameSessionRecord> {
    let session = {
        let mut sessions = state.running_games.write();
        sessions.remove(&game_id)
    };

    if let Some(session) = session {
        let end_time = Utc::now();
        let duration = (end_time - session.start_time).num_seconds();

        // 查询进程退出码（如果可能）
        let exit_code = 0i32;

        let record = GameSessionRecord {
            id: Uuid::new_v4().to_string(),
            game_id: game_id.clone(),
            start_time: session.start_time.to_rfc3339(),
            end_time: end_time.to_rfc3339(),
            duration_seconds: duration,
            exit_code,
            crashed: false,
        };

        // 更新游戏总时长
        {
            let conn = state.db.lock();
            conn.execute(
                "UPDATE games SET total_seconds = total_seconds + ? WHERE id = ?",
                params![duration, game_id],
            )?;
        }

        // 写入会话记录
        {
            let conn = state.db.lock();
            conn.execute(
                "INSERT INTO game_sessions (id, game_id, start_time, end_time, duration_seconds, exit_code, crashed)
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
                params![
                    record.id, record.game_id, record.start_time, record.end_time,
                    record.duration_seconds, record.exit_code, record.crashed as i32
                ],
            )?;
        }

        Ok(record)
    } else {
        Err(AppError::Custom("No active session found".to_string()))
    }
}

#[tauri::command]
fn get_game_sessions(state: State<'_, AppState>, game_id: String) -> AppResult<Vec<GameSessionRecord>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, game_id, start_time, end_time, duration_seconds, exit_code, crashed
         FROM game_sessions WHERE game_id = ? ORDER BY start_time DESC"
    )?;
    let rows = stmt.query_map([&game_id], |row| {
        Ok(GameSessionRecord {
            id: row.get(0)?,
            game_id: row.get(1)?,
            start_time: row.get(2)?,
            end_time: row.get(3)?,
            duration_seconds: row.get(4)?,
            exit_code: row.get(5)?,
            crashed: row.get::<_, i32>(6)? != 0,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

// ─────────────────────────────────────────────
// Tauri Commands - Series / Seasons / Episodes
// ─────────────────────────────────────────────

#[tauri::command]
fn get_all_series(state: State<'_, AppState>) -> AppResult<Vec<Series>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, title, aliases, overview, poster_path, bg_path, first_air_date, status,
                tmdb_id, tvdb_id, tags, favorite, created_at, updated_at
         FROM series ORDER BY title"
    )?;
    let rows = stmt.query_map([], |row| {
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
            created_at: row.get(12)?,
            updated_at: row.get(13)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

#[tauri::command]
fn create_series(state: State<'_, AppState>, mut series: Series) -> AppResult<Series> {
    if series.id.is_empty() {
        series.id = Uuid::new_v4().to_string();
    }
    let conn = state.db.lock();
    conn.execute(
        "INSERT INTO series (id, title, aliases, overview, poster_path, bg_path, first_air_date,
         status, tmdb_id, tvdb_id, tags, favorite)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            series.id, series.title, series.aliases, series.overview, series.poster_path,
            series.bg_path, series.first_air_date, series.status, series.tmdb_id,
            series.tvdb_id, series.tags, series.favorite as i32
        ],
    )?;
    drop(conn);
    let conn2 = state.db.lock();
    conn2.query_row(
        "SELECT id, title, aliases, overview, poster_path, bg_path, first_air_date, status,
                tmdb_id, tvdb_id, tags, favorite, created_at, updated_at
         FROM series WHERE id = ?",
        [&series.id],
        |row| {
            Ok(Series {
                id: row.get(0)?, title: row.get(1)?, aliases: row.get(2)?,
                overview: row.get(3)?, poster_path: row.get(4)?, bg_path: row.get(5)?,
                first_air_date: row.get(6)?, status: row.get(7)?, tmdb_id: row.get(8)?,
                tvdb_id: row.get(9)?, tags: row.get(10)?, favorite: row.get::<_, i32>(11)? != 0,
                created_at: row.get(12)?, updated_at: row.get(13)?,
            })
        },
    ).map_err(AppError::from)
}

#[tauri::command]
fn update_series(state: State<'_, AppState>, series: Series) -> AppResult<Series> {
    let conn = state.db.lock();
    conn.execute(
        "UPDATE series SET title = ?, aliases = ?, overview = ?, poster_path = ?, bg_path = ?,
         first_air_date = ?, status = ?, tmdb_id = ?, tvdb_id = ?, tags = ?, favorite = ?,
         updated_at = datetime('now') WHERE id = ?",
        params![
            series.title, series.aliases, series.overview, series.poster_path, series.bg_path,
            series.first_air_date, series.status, series.tmdb_id, series.tvdb_id,
            series.tags, series.favorite as i32, series.id
        ],
    )?;
    drop(conn);
    let conn2 = state.db.lock();
    conn2.query_row(
        "SELECT id, title, aliases, overview, poster_path, bg_path, first_air_date, status,
                tmdb_id, tvdb_id, tags, favorite, created_at, updated_at
         FROM series WHERE id = ?",
        [&series.id],
        |row| {
            Ok(Series {
                id: row.get(0)?, title: row.get(1)?, aliases: row.get(2)?,
                overview: row.get(3)?, poster_path: row.get(4)?, bg_path: row.get(5)?,
                first_air_date: row.get(6)?, status: row.get(7)?, tmdb_id: row.get(8)?,
                tvdb_id: row.get(9)?, tags: row.get(10)?, favorite: row.get::<_, i32>(11)? != 0,
                created_at: row.get(12)?, updated_at: row.get(13)?,
            })
        },
    ).map_err(AppError::from)
}

#[tauri::command]
fn delete_series(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM series WHERE id = ?", [&id])?;
    Ok(())
}

#[tauri::command]
fn get_seasons(state: State<'_, AppState>, series_id: String) -> AppResult<Vec<Season>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, series_id, season_number, name, overview, poster_path, first_air_date
         FROM seasons WHERE series_id = ? ORDER BY season_number"
    )?;
    let rows = stmt.query_map([&series_id], |row| {
        Ok(Season {
            id: row.get(0)?,
            series_id: row.get(1)?,
            season_number: row.get(2)?,
            name: row.get(3)?,
            overview: row.get(4)?,
            poster_path: row.get(5)?,
            first_air_date: row.get(6)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

#[tauri::command]
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

#[tauri::command]
fn delete_season(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM seasons WHERE id = ?", [&id])?;
    Ok(())
}

#[tauri::command]
fn get_episodes(state: State<'_, AppState>, season_id: String) -> AppResult<Vec<Episode>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, series_id, season_id, episode_number, title, overview, still_path,
                air_date, runtime_minutes, local_path, watched_ms, last_watched_at, watched
         FROM episodes WHERE season_id = ? ORDER BY episode_number"
    )?;
    let rows = stmt.query_map([&season_id], |row| {
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
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

#[tauri::command]
fn create_episode(state: State<'_, AppState>, mut episode: Episode) -> AppResult<Episode> {
    if episode.id.is_empty() {
        episode.id = Uuid::new_v4().to_string();
    }
    let conn = state.db.lock();
    conn.execute(
        "INSERT INTO episodes (id, series_id, season_id, episode_number, title, overview,
         still_path, air_date, runtime_minutes, local_path, watched_ms, last_watched_at, watched)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            episode.id, episode.series_id, episode.season_id, episode.episode_number,
            episode.title, episode.overview, episode.still_path, episode.air_date,
            episode.runtime_minutes, episode.local_path, episode.watched_ms,
            episode.last_watched_at, episode.watched as i32
        ],
    )?;
    Ok(episode)
}

#[tauri::command]
fn update_episode(state: State<'_, AppState>, episode: Episode) -> AppResult<Episode> {
    let conn = state.db.lock();
    conn.execute(
        "UPDATE episodes SET episode_number = ?, title = ?, overview = ?, still_path = ?,
         air_date = ?, runtime_minutes = ?, local_path = ?, watched_ms = ?,
         last_watched_at = ?, watched = ? WHERE id = ?",
        params![
            episode.episode_number, episode.title, episode.overview, episode.still_path,
            episode.air_date, episode.runtime_minutes, episode.local_path, episode.watched_ms,
            episode.last_watched_at, episode.watched as i32, episode.id
        ],
    )?;
    Ok(episode)
}

#[tauri::command]
fn delete_episode(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM episodes WHERE id = ?", &[&id])?;
    Ok(())
}

#[tauri::command]
fn update_watch_progress(state: State<'_, AppState>, episode_id: String, watched_ms: i64) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute(
        "UPDATE episodes SET watched_ms = ?, last_watched_at = datetime('now') WHERE id = ?",
        params![watched_ms, episode_id],
    )?;
    Ok(())
}

#[tauri::command]
fn mark_episode_watched(state: State<'_, AppState>, episode_id: String, watched: bool) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute(
        "UPDATE episodes SET watched = ? WHERE id = ?",
        params![watched as i32, episode_id],
    )?;
    Ok(())
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

#[tauri::command]
fn get_stats(state: State<'_, AppState>) -> AppResult<Stats> {
    let conn = state.db.lock();

    let total_game_seconds: i64 = conn
        .query_row("SELECT COALESCE(SUM(total_seconds), 0) FROM games", [], |r| r.get(0))
        .unwrap_or(0);
    let total_games: i64 = conn
        .query_row("SELECT COUNT(*) FROM games WHERE hidden = 0", [], |r| r.get(0))
        .unwrap_or(0);
    let total_series: i64 = conn
        .query_row("SELECT COUNT(*) FROM series", [], |r| r.get(0))
        .unwrap_or(0);
    let total_episodes: i64 = conn
        .query_row("SELECT COUNT(*) FROM episodes", [], |r| r.get(0))
        .unwrap_or(0);
    let total_watched_episodes: i64 = conn
        .query_row("SELECT COUNT(*) FROM episodes WHERE watched = 1", [], |r| r.get(0))
        .unwrap_or(0);

    // 最近游玩
    let mut stmt = conn.prepare(
        "SELECT id, game_id, start_time, end_time, duration_seconds, exit_code, crashed
         FROM game_sessions ORDER BY start_time DESC LIMIT 10"
    )?;
    let recent_games: Vec<GameSessionRecord> = stmt
        .query_map([], |row| {
            Ok(GameSessionRecord {
                id: row.get(0)?,
                game_id: row.get(1)?,
                start_time: row.get(2)?,
                end_time: row.get(3)?,
                duration_seconds: row.get(4)?,
                exit_code: row.get(5)?,
                crashed: row.get::<_, i32>(6)? != 0,
            })
        })?
        .filter_map(Result::ok)
        .collect();

    // 本周时长
    let week_seconds: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(duration_seconds), 0) FROM game_sessions
             WHERE start_time >= datetime('now', '-7 days')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    // 本月时长
    let month_seconds: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(duration_seconds), 0) FROM game_sessions
             WHERE start_time >= datetime('now', '-30 days')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    Ok(Stats {
        total_game_seconds,
        total_games,
        total_series,
        total_episodes,
        total_watched_episodes,
        recent_games,
        week_game_seconds: week_seconds,
        month_game_seconds: month_seconds,
    })
}

// ─────────────────────────────────────────────
// Tauri Commands - Settings
// ─────────────────────────────────────────────

#[tauri::command]
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

#[tauri::command]
fn set_setting(state: State<'_, AppState>, key: String, value: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        params![key, value],
    )?;
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
    settings: HashMap<String, String>,
}

#[tauri::command]
fn export_data(state: State<'_, AppState>) -> AppResult<String> {
    let conn = state.db.lock();

    // 读取所有数据
    let mut games_stmt = conn.prepare(
        "SELECT id, name, platform, install_dir, exe_path, launch_args, env_vars, work_dir,
                cover_path, banner_path, bg_path, rating, notes, tags, favorite, hidden,
                total_seconds, play_count, created_at, updated_at FROM games"
    )?;
    let games: Vec<Game> = games_stmt
        .query_map([], |row| {
            Ok(Game {
                id: row.get(0)?, name: row.get(1)?, platform: row.get(2)?,
                install_dir: row.get(3)?, exe_path: row.get(4)?, launch_args: row.get(5)?,
                env_vars: row.get(6)?, work_dir: row.get(7)?, cover_path: row.get(8)?,
                banner_path: row.get(9)?, bg_path: row.get(10)?, rating: row.get(11)?,
                notes: row.get(12)?, tags: row.get(13)?,
                favorite: row.get::<_, i32>(14)? != 0, hidden: row.get::<_, i32>(15)? != 0,
                total_seconds: row.get(16)?, play_count: row.get(17)?,
                created_at: row.get(18)?, updated_at: row.get(19)?,
            })
        })?
        .filter_map(Result::ok)
        .collect();

    let mut series_stmt = conn.prepare(
        "SELECT id, title, aliases, overview, poster_path, bg_path, first_air_date, status,
                tmdb_id, tvdb_id, tags, favorite, created_at, updated_at FROM series"
    )?;
    let series: Vec<Series> = series_stmt
        .query_map([], |row| {
            Ok(Series {
                id: row.get(0)?, title: row.get(1)?, aliases: row.get(2)?,
                overview: row.get(3)?, poster_path: row.get(4)?, bg_path: row.get(5)?,
                first_air_date: row.get(6)?, status: row.get(7)?, tmdb_id: row.get(8)?,
                tvdb_id: row.get(9)?, tags: row.get(10)?, favorite: row.get::<_, i32>(11)? != 0,
                created_at: row.get(12)?, updated_at: row.get(13)?,
            })
        })?
        .filter_map(Result::ok)
        .collect();

    let mut seasons_stmt = conn.prepare(
        "SELECT id, series_id, season_number, name, overview, poster_path, first_air_date FROM seasons"
    )?;
    let seasons: Vec<Season> = seasons_stmt
        .query_map([], |row| {
            Ok(Season {
                id: row.get(0)?, series_id: row.get(1)?, season_number: row.get(2)?,
                name: row.get(3)?, overview: row.get(4)?, poster_path: row.get(5)?,
                first_air_date: row.get(6)?,
            })
        })?
        .filter_map(Result::ok)
        .collect();

    let mut episodes_stmt = conn.prepare(
        "SELECT id, series_id, season_id, episode_number, title, overview, still_path,
                air_date, runtime_minutes, local_path, watched_ms, last_watched_at, watched FROM episodes"
    )?;
    let episodes: Vec<Episode> = episodes_stmt
        .query_map([], |row| {
            Ok(Episode {
                id: row.get(0)?, series_id: row.get(1)?, season_id: row.get(2)?,
                episode_number: row.get(3)?, title: row.get(4)?, overview: row.get(5)?,
                still_path: row.get(6)?, air_date: row.get(7)?, runtime_minutes: row.get(8)?,
                local_path: row.get(9)?, watched_ms: row.get(10)?, last_watched_at: row.get(11)?,
                watched: row.get::<_, i32>(12)? != 0,
            })
        })?
        .filter_map(Result::ok)
        .collect();

    let mut settings_stmt = conn.prepare("SELECT key, value FROM settings")?;
    let settings: HashMap<String, String> = settings_stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .filter_map(Result::ok)
        .collect();

    let export = ExportData { games, series, seasons, episodes, settings };
    Ok(serde_json::to_string_pretty(&export)?)
}

#[tauri::command]
fn import_data(state: State<'_, AppState>, json_data: String) -> AppResult<()> {
    let data: ExportData = serde_json::from_str(&json_data)?;

    let conn = state.db.lock();

    for game in data.games {
        conn.execute(
            "INSERT OR REPLACE INTO games (id, name, platform, install_dir, exe_path, launch_args,
             env_vars, work_dir, cover_path, banner_path, bg_path, rating, notes, tags,
             favorite, hidden, total_seconds, play_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                game.id, game.name, game.platform, game.install_dir, game.exe_path,
                game.launch_args, game.env_vars, game.work_dir, game.cover_path,
                game.banner_path, game.bg_path, game.rating, game.notes, game.tags,
                game.favorite as i32, game.hidden as i32, game.total_seconds, game.play_count,
                game.created_at, game.updated_at
            ],
        )?;
    }

    for series in data.series {
        conn.execute(
            "INSERT OR REPLACE INTO series (id, title, aliases, overview, poster_path, bg_path,
             first_air_date, status, tmdb_id, tvdb_id, tags, favorite, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                series.id, series.title, series.aliases, series.overview, series.poster_path,
                series.bg_path, series.first_air_date, series.status, series.tmdb_id,
                series.tvdb_id, series.tags, series.favorite as i32, series.created_at,
                series.updated_at
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
             last_watched_at, watched)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                episode.id, episode.series_id, episode.season_id, episode.episode_number,
                episode.title, episode.overview, episode.still_path, episode.air_date,
                episode.runtime_minutes, episode.local_path, episode.watched_ms,
                episode.last_watched_at, episode.watched as i32
            ],
        )?;
    }

    for (key, value) in data.settings {
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            params![key, value],
        )?;
    }

    Ok(())
}

// ─────────────────────────────────────────────
// Tauri Commands - App Info
// ─────────────────────────────────────────────

#[tauri::command]
fn get_data_dir_cmd(state: State<'_, AppState>) -> String {
    state.data_dir.to_string_lossy().to_string()
}

#[tauri::command]
fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// ─────────────────────────────────────────────
// App Entry Point
// ─────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 初始化日志
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
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
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .manage(app_state)
        .setup(move |app| {
            // 多实例守护：持有锁文件直到进程退出
            use std::os::windows::io::AsRawHandle;
            let lock_path = data_dir.join(".lock");
            let lock_file = match fs::File::create(&lock_path) {
                Ok(f) => f,
                Err(_) => {
                    log::warn!("无法创建锁文件，跳过多实例检查");
                    log::info!("ZEX started successfully");
                    return Ok(());
                }
            };
            let handle = lock_file.as_raw_handle();
            let locked = unsafe {
                windows_sys::Win32::Storage::FileSystem::LockFileEx(
                    handle as _,
                    windows_sys::Win32::Storage::FileSystem::LOCKFILE_EXCLUSIVE_LOCK,
                    0, 0, !0u32,
                    std::ptr::null_mut(),
                )
            };
            if locked == 0 {
                // 已有实例在运行，尝试聚焦并退出
                drop(lock_file);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_focus();
                }
                std::process::exit(0);
            }
            // 泄漏句柄让锁保持到进程退出
            Box::leak(Box::new(lock_file));
            log::info!("ZEX started successfully");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Games
            get_all_games, get_game, create_game, update_game, delete_game, filter_games,
            // Steam
            scan_steam_library, import_steam_games,
            // Sessions
            launch_game, check_game_running, on_game_exit, get_game_sessions,
            // Series
            get_all_series, create_series, update_series, delete_series,
            // Seasons
            get_seasons, create_season, delete_season,
            // Episodes
            get_episodes, create_episode, update_episode, delete_episode,
            update_watch_progress, mark_episode_watched,
            // Covers
            search_covers, download_cover,
            // Stats
            get_stats,
            // Settings
            get_setting, set_setting,
            // Data
            export_data, import_data,
            // App
            get_data_dir_cmd, get_version,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
