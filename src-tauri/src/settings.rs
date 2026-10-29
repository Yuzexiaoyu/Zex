// 设置读写、开机自启（HKCU Run 键）、数据导出/导入、App 信息与外部播放器。
// 同步走 crate::sync；归档守卫 crate::archive；播放预热 crate::mpv；歌单 crate::music。
use std::collections::HashMap;
use std::env;
use std::fs;
use std::sync::atomic::Ordering;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;
use crate::{archive, folders, mpv, music};
use crate::{AppError, AppResult, AppState, Episode, Game, GameFolder, Playlist, Season, Series, Track,
    EPISODE_COLS, SEASON_COLS, SERIES_COLS, TRACK_COLS,
    default_media_type, row_to_episode, row_to_season, row_to_series, row_to_track};

#[tauri::command(async)]
pub fn get_setting(state: State<'_, AppState>, key: String) -> AppResult<Option<String>> {
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
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        params![key, value],
    )?;
    Ok(())
}

/// 肃正协议：手动触发一次跨端进度对账（设置里保存核心位置后立即同步一次）。后台线程跑。
#[tauri::command(async)]
pub fn trigger_sync(app: tauri::AppHandle) -> AppResult<()> {
    crate::sync::sync(app);
    Ok(())
}

/// 肃正协议：关闭同步时删掉核心文件（关了就清干净）。后台线程跑。
#[tauri::command(async)]
pub fn sync_purge(app: tauri::AppHandle) -> AppResult<()> {
    crate::sync::purge(app);
    Ok(())
}

/// 隐藏库设置：写入 settings + 联动 mpv 预加载。
/// 影视/音乐库全隐藏（没有任何媒体播放入口）→ 停掉空闲 mpv 预热（省内存）；
/// 任一媒体库可见 → 恢复预加载并立即补拉一个（下次点播仍热启动）。
/// 只影响空闲预热，正在播放的会话绝不动
#[tauri::command(async)]
pub fn set_hidden_libraries(app: tauri::AppHandle, state: State<'_, AppState>, libs: Vec<String>) -> AppResult<()> {
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
pub(crate) fn apply_guide_registry(enabled: bool) -> std::io::Result<()> {
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
pub(crate) fn repair_autostart_registry() {
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
pub fn set_autostart(state: State<'_, AppState>, enabled: bool, show: bool) -> AppResult<bool> {
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
pub fn get_autostart_enabled() -> bool {
    autostart_registry_enabled()
}

/// 西瓜键唤起开关：写库 + 同步注册表 + 更新运行时标志。
/// 开=按 Guide 唤起 ZEX（注册表禁 Game Bar 抢键）；关=让位 Game Bar（注册表恢复）。
/// 返回注册表同步是否成功：false 时设置已保存但 Game Bar 可能仍抢西瓜键
/// （注册表写入失败，如键被占用，或 Game Bar 未重启仍用旧值）
#[tauri::command(async)]
pub fn set_guide_button_enabled(state: State<'_, AppState>, enabled: bool) -> AppResult<bool> {
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
pub fn set_ps_button_enabled(state: State<'_, AppState>, enabled: bool) -> AppResult<()> {
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

// 统计存档行：删除游戏/影视/音乐后，其对统计的贡献永久留在 stats_archive（统计页「只加
// 不删」的唯一数据源）。备份必须带上它，否则导入/恢复后已删条目的历史统计永久归零。
#[derive(Serialize, Deserialize)]
struct StatsArchiveRow {
    key: String,
    media: String,
    name: String,
    sub: String,
    cover_path: String,
    wide_path: String,
    seconds: i64,
    play_count: i64,
    ext_id: i64,
    episodes: i64,
    watched_episodes: i64,
    deleted_at: String,
}

#[derive(Serialize, Deserialize)]
struct ExportData {
    games: Vec<Game>,
    series: Vec<Series>,
    seasons: Vec<Season>,
    episodes: Vec<Episode>,
    tracks: Vec<Track>,
    playlists: Vec<Playlist>,
    // 游戏库文件夹。serde default：旧版本导出的 JSON 没有这个字段，缺了也要能导入
    #[serde(default)]
    game_folders: Vec<GameFolder>,
    // 统计存档（见上）。serde default 兼容不含此字段的旧备份
    #[serde(default)]
    stats_archive: Vec<StatsArchiveRow>,
    settings: HashMap<String, String>,
}

#[tauri::command(async)]
pub fn export_data(state: State<'_, AppState>) -> AppResult<String> {
    // 查库全程持锁（必要），但序列化在锁外做：to_string_pretty 要把整库拼成
    // 带缩进的 JSON（几 MB 字符串），占着全局锁做这件事会让期间所有操作排队
    let export = {
        let conn = state.db.lock();

        // 读取所有数据
        let mut games_stmt = conn.prepare(
            "SELECT id, name, install_dir, exe_path, launch_args, env_vars, work_dir,
                    cover_path, banner_path, bg_path, notes, tags, favorite, hidden,
                    total_seconds, play_count, created_at, updated_at, sort_order, steam_appid,
                    rtss_profile_name, monitor_process, archive_status, archive_path, archive_size, archive_original_size,
                    slot FROM games"
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
                    rtss_profile_name: row.get(20)?,
                    monitor_process: row.get(21)?,
                archive_status: row.get(22)?,
                archive_path: row.get(23)?,
                archive_size: row.get(24)?,
                archive_original_size: row.get(25)?,
                slot: row.get(26)?,
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

        let playlists = music::load_playlists(&conn)?;
        let game_folders = folders::load_game_folders(&conn)?;

        let mut settings_stmt = conn.prepare("SELECT key, value FROM settings")?;
        let settings: HashMap<String, String> = settings_stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
            .filter_map(Result::ok)
            .collect();

        // 统计存档：删除实体后留存的统计贡献（见 StatsArchiveRow）。不导出 → 恢复后归零
        let mut sa_stmt = conn.prepare(
            "SELECT key, media, name, sub, cover_path, wide_path, seconds, play_count,
                    ext_id, episodes, watched_episodes, deleted_at FROM stats_archive",
        )?;
        let stats_archive: Vec<StatsArchiveRow> = sa_stmt
            .query_map([], |row| {
                Ok(StatsArchiveRow {
                    key: row.get(0)?, media: row.get(1)?, name: row.get(2)?, sub: row.get(3)?,
                    cover_path: row.get(4)?, wide_path: row.get(5)?, seconds: row.get(6)?,
                    play_count: row.get(7)?, ext_id: row.get(8)?, episodes: row.get(9)?,
                    watched_episodes: row.get(10)?, deleted_at: row.get(11)?,
                })
            })?
            .filter_map(Result::ok)
            .collect();

        ExportData { games, series, seasons, episodes, tracks, playlists, game_folders, stats_archive, settings }
    };
    Ok(serde_json::to_string_pretty(&export)?)
}

#[tauri::command(async)]
pub fn import_data(state: State<'_, AppState>, json_data: String) -> AppResult<()> {
    let _operation = archive::OperationGuard::acquire(&state.archive_gate)?;
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
             steam_appid, rtss_profile_name, monitor_process, archive_status, archive_path, archive_size, archive_original_size, slot)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                game.id, game.name, game.install_dir, game.exe_path,
                game.launch_args, game.env_vars, game.work_dir, game.cover_path,
                game.banner_path, game.bg_path, game.notes, game.tags,
                game.favorite as i32, game.hidden as i32, game.total_seconds, game.play_count,
                game.created_at, game.updated_at, game.sort_order, game.steam_appid,
                game.rtss_profile_name, game.monitor_process,
                game.archive_status, game.archive_path, game.archive_size, game.archive_original_size,
                game.slot
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

    // 统计存档：删除实体后留存的统计贡献，按 key 覆盖恢复。旧备份无此字段 → serde
    // default 为空、循环不执行，不影响老 JSON 导入
    for sa in data.stats_archive {
        conn.execute(
            "INSERT OR REPLACE INTO stats_archive
             (key, media, name, sub, cover_path, wide_path, seconds, play_count, ext_id, episodes, watched_episodes, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                sa.key, sa.media, sa.name, sa.sub, sa.cover_path, sa.wide_path,
                sa.seconds, sa.play_count, sa.ext_id, sa.episodes, sa.watched_episodes, sa.deleted_at
            ],
        )?;
    }

    // 导入上一版（甚至更早）导出的 JSON：那时还没有 slot 字段，serde 默认填 -1 = 未定位。
    // 用它们自带的 sort_order（当年的 1..n 密集序列，正好 = 格号 + 1）回填，
    // 库的排布就与导出时一致；真正没排过序的（sort_order=0）保持未定位，落进第一个空格
    conn.execute(
        "UPDATE games SET slot = sort_order - 1 WHERE slot < 0 AND sort_order > 0",
        [],
    )?;

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

    // 游戏库文件夹：与歌单同款「先清后建」。必须排在上面的 games 插入之后 —— 成员行有
    // FOREIGN KEY(game_id) REFERENCES games(id)，游戏还没进库时插成员会整份回滚。
    // 成员用 OR IGNORE：导出文件里指向已不存在游戏的成员行跳过，不让整次导入失败
    conn.execute("DELETE FROM game_folder_items", [])?;
    conn.execute("DELETE FROM game_folders", [])?;
    for folder in data.game_folders {
        conn.execute(
            "INSERT OR REPLACE INTO game_folders (id, name, slot, color, cover_path, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![folder.id, folder.name, folder.slot, folder.color, folder.cover_path,
                folder.created_at, folder.updated_at],
        )?;
        for (i, gid) in folder.game_ids.iter().enumerate() {
            conn.execute(
                "INSERT OR IGNORE INTO game_folder_items (game_id, folder_id, sort_order)
                 SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM games WHERE id = ?1)",
                params![gid, folder.id, i as i64 + 1],
            )?;
        }
    }

    Ok(())
}

// 清除所有数据：清空集/季/影视/游戏/音乐，删除全部封面文件（保留设置项如 API Key）
#[tauri::command(async)]
pub fn clear_all_data(state: State<'_, AppState>) -> AppResult<String> {
    let _operation = archive::OperationGuard::acquire(&state.archive_gate)?;
    {
        let conn = state.db.lock();
        conn.execute_batch(
            "DELETE FROM episodes;
             DELETE FROM seasons;
             DELETE FROM series;
             DELETE FROM game_folder_items;
             DELETE FROM game_folders;
             DELETE FROM games;
             DELETE FROM playlist_tracks;
             DELETE FROM playlists;
             DELETE FROM tracks;
             DELETE FROM stats_archive;",
        )?;
        // 清掉封面降级迁移的标志位：清数据后下次启动的迁移要能重跑 —— 它现在只剩
        // 「清理孤儿封面」的职责，正好兜住下面删除失败/残留的文件。settings 其余
        // 设置项（API Key 等）按设计保留
        let _ = conn.execute(
            "DELETE FROM settings WHERE key IN ('music_cover_thumbs_v1','music_cover_thumbs_v2','music_cover_thumbs_v3')",
            [],
        );
    }
    let covers_dir = state.data_dir.join("covers");
    let mut removed = 0usize;
    let mut failed = 0usize;
    if let Ok(entries) = fs::read_dir(&covers_dir) {
        for entry in entries.flatten() {
            if fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            } else {
                failed += 1;
            }
        }
    }
    if failed > 0 {
        // 删不掉通常是文件正被占用（杀软扫描、刚启动的迁移线程在读）。不静默：
        // 下次启动的迁移（标志位已清）会扫掉残留
        log::warn!("清除封面文件失败 {} 个（可能被占用），已删 {}. 残留文件由下次启动的孤儿清理兜底", failed, removed);
    }
    Ok("所有数据已清除".to_string())
}

// ─────────────────────────────────────────────
// Tauri Commands - App Info
// ─────────────────────────────────────────────

#[tauri::command(async)]
pub fn get_data_dir_cmd(state: State<'_, AppState>) -> String {
    state.data_dir.to_string_lossy().to_string()
}

#[tauri::command(async)]
pub fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command(async)]
pub fn open_path(path: String) -> AppResult<()> {
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
pub fn play_video(state: State<'_, AppState>, path: String) -> AppResult<()> {
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
pub(crate) struct ScanResult {
    episodes: Vec<ScannedEpisode>,
}

// ── 季号识别:目录名 → 季号 ──（扫描 scan_dir 与"存量压扁剧"迁移共用；且与电视端
// D:\ZEX-TV smb.rs 的 parse_dir_season/cn_numeral 逐字一致 —— 两端对同一目录名必须
// 算出同一季号,否则 tmdb>0 的跨端同步键会分叉）。
// 中文数字 → 整数（0..99 够季号）：零一二…九、十、十X、X十、X十Y。认不出返回 None。
pub(crate) fn cn_num(s: &str) -> Option<i32> {
    const DIGITS: [(char, i32); 10] = [
        ('零', 0), ('一', 1), ('二', 2), ('三', 3), ('四', 4),
        ('五', 5), ('六', 6), ('七', 7), ('八', 8), ('九', 9),
    ];
    let digit = |c: char| DIGITS.iter().find(|(d, _)| *d == c).map(|(_, v)| *v);
    let chars: Vec<char> = s.chars().collect();
    match chars.as_slice() {
        ['十'] => Some(10),
        ['十', b] => digit(*b).map(|v| 10 + v),
        [a, '十'] => digit(*a).map(|v| v * 10),
        [a, '十', b] => Some(digit(*a)? * 10 + digit(*b)?),
        [a] => digit(*a),
        _ => None,
    }
}

/// 从单个目录名解析季号：第N季(阿拉伯) / 第&lt;中文&gt;季 / Season N / S0N。认不出返回 None
/// （调用方据此回退默认季 1）。三条正则、顺序、语义与电视端 parse_dir_season 完全一致。
pub(crate) fn parse_season_from_dirname(name: &str) -> Option<i32> {
    use std::sync::OnceLock;
    static RE_CN: OnceLock<regex::Regex> = OnceLock::new();
    static RE_CN_NUM: OnceLock<regex::Regex> = OnceLock::new();
    static RE_EN: OnceLock<regex::Regex> = OnceLock::new();
    let re_cn = RE_CN.get_or_init(|| regex::Regex::new(r"第\s*(\d{1,2})\s*季").unwrap());
    let re_cn_num =
        RE_CN_NUM.get_or_init(|| regex::Regex::new(r"第\s*([一二三四五六七八九十]{1,4})\s*季").unwrap());
    let re_en = RE_EN.get_or_init(|| regex::Regex::new(r"(?i)(?:season|s)\s*(\d{1,2})\b").unwrap());
    if let Some(c) = re_cn.captures(name) {
        return c[1].parse().ok();
    }
    if let Some(c) = re_cn_num.captures(name) {
        return cn_num(&c[1]);
    }
    if let Some(c) = re_en.captures(name) {
        return c[1].parse().ok();
    }
    None
}

/// 从文件路径向上回溯祖先目录名，取最近一个能解析出季号的；root 为停止边界
/// （扫描时传剧根，防越界；迁移时无根，传 None 并靠层数上限兜底）。
/// 从文件路径向上回溯祖先目录名，取最近一个能解析出季号的；root 为停止边界：到达剧根即停、
/// **不解析剧根自身名**（扁平布局回退默认季；与电视端"根目录不计季、只认其下的季目录"一致）。
pub(crate) fn season_from_path(file_path: &std::path::Path, root: Option<&std::path::Path>) -> Option<i32> {
    let mut cur = file_path.parent();
    let mut depth = 0;
    while let Some(dir) = cur {
        if depth >= 6 {
            break;
        }
        if root == Some(dir) {
            break; // 到剧根:不解析剧根自身名,扁平布局回退默认季
        }
        let hit = dir.file_name().and_then(|nm| parse_season_from_dirname(&nm.to_string_lossy()));
        if hit.is_some() {
            return hit;
        }
        cur = dir.parent();
        depth += 1;
    }
    None
}

/// 扫描视频文件夹，识别季和集
#[tauri::command(async)]
pub fn scan_video_folder(folder_path: String) -> AppResult<ScanResult> {
    use std::path::Path;
    use regex::Regex;

    let path = Path::new(&folder_path);
    if !path.exists() || !path.is_dir() {
        return Err(AppError::Custom("路径不存在或不是文件夹".to_string()));
    }

    // 视频文件扩展名
    let video_exts = ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "ts", "rmvb"];

    // 正则：季集识别。只在"去掉扩展名的文件名主干"上跑，避免 .m4v→集4 这类扩展名污染。
    // re_x / re_ep 加了边界约束：re_x 防 1920x1080 被当成 S20E108，re_ep 防 Scene5 被当成集5
    let re_s_e = Regex::new(r"[Ss](\d{1,2})[Ee](\d{1,3})").unwrap();
    let re_x = Regex::new(r"(?:^|[^0-9])(\d{1,2})[xX](\d{1,3})").unwrap();
    let re_ep = Regex::new(r"(?:^|[^A-Za-z])[Ee][Pp]?(\d{1,3})").unwrap();
    let re_chinese = Regex::new(r"第(\d{1,3})[集话話]").unwrap();
    let re_bracket = Regex::new(r"\[(\d{1,3})\]").unwrap();
    let re_number = Regex::new(r"(?:^|[^\d])(\d{1,3})(?:[^\d]|$)").unwrap();

    let mut episodes = Vec::new();

    // 递归扫描。root = 本次扫描的剧根：文件名只有集号时，从父/祖先目录名推季
    // （Season N / 第N季 / S0N / 特别篇→0），到剧根为止；拿不到才回退默认季 1。
    #[allow(clippy::too_many_arguments)]
    fn scan_dir(
        dir: &Path,
        root: &Path,
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
                    scan_dir(&path, root, episodes, video_exts, re_s_e, re_x, re_ep, re_chinese, re_bracket, re_number)?;
                } else if let Some(ext) = path.extension() {
                    if video_exts.contains(&ext.to_string_lossy().to_lowercase().as_str()) {
                        if let Some(file_name) = path.file_name() {
                            let file_name_str = file_name.to_string_lossy().to_string();
                            // 匹配用去扩展名的主干，展示仍用完整文件名
                            let stem = path
                                .file_stem()
                                .map(|s| s.to_string_lossy().to_string())
                                .unwrap_or_else(|| file_name_str.clone());

                            let (season, episode) = if let Some(caps) = re_s_e.captures(&stem) {
                                // S01E01：季来自文件名（显式季最优先）
                                (caps[1].parse().unwrap_or(1), caps[2].parse().unwrap_or(1))
                            } else if let Some(caps) = re_x.captures(&stem) {
                                // 1x01：季来自文件名
                                (caps[1].parse().unwrap_or(1), caps[2].parse().unwrap_or(1))
                            } else {
                                // 文件名只有集号：季号改从父/祖先目录名推，拿不到才默认 1
                                let ep = if let Some(caps) = re_ep.captures(&stem) {
                                    caps[1].parse().unwrap_or(1)
                                } else if let Some(caps) = re_chinese.captures(&stem) {
                                    caps[1].parse().unwrap_or(1)
                                } else if let Some(caps) = re_bracket.captures(&stem) {
                                    caps[1].parse().unwrap_or(1)
                                } else if let Some(caps) = re_number.captures(&stem) {
                                    caps[1].parse().unwrap_or(1)
                                } else {
                                    continue; // 无法识别集号，跳过
                                };
                                let season = season_from_path(&path, Some(root)).unwrap_or(1);
                                (season, ep)
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

    scan_dir(path, path, &mut episodes, &video_exts, &re_s_e, &re_x, &re_ep, &re_chinese, &re_bracket, &re_number)
        .map_err(|e| AppError::Custom(format!("扫描文件夹失败: {}", e)))?;

    // 按季号和集号排序
    episodes.sort_by(|a, b| {
        a.season_number.cmp(&b.season_number)
            .then(a.episode_number.cmp(&b.episode_number))
    });

    Ok(ScanResult { episodes })
}
