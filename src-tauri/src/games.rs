// 游戏库：CRUD、封面抓取（SteamGridDB）、启动（直启 / Steam 协议）、
// 会话与进程追踪（计时、帧数绑定）。归档守卫走 crate::archive。
use std::collections::{HashMap, HashSet};
use std::fs::{self};
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use chrono::Utc;
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde::Deserialize;
use sysinfo::System;
use tauri::{AppHandle, State};
use uuid::Uuid;
use crate::{archive, rtss};
use crate::{AppError, AppResult, AppState, CoverOption, Game, GameFilter, GameSession, SgdbAuthor};
use crate::disk::steam_library_root_of;

#[tauri::command(async)]
pub fn get_all_games(state: State<'_, AppState>) -> AppResult<Vec<Game>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, name, install_dir, exe_path, launch_args, env_vars, work_dir,
                cover_path, banner_path, bg_path, notes, tags, favorite, hidden,
                total_seconds, play_count, created_at, updated_at, sort_order, steam_appid,
                rtss_profile_name, monitor_process, archive_status, archive_path, archive_size, archive_original_size,
                slot
         FROM games WHERE hidden = 0
         ORDER BY CASE WHEN slot < 0 THEN 1 ELSE 0 END, slot, created_at, id"
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
            rtss_profile_name: row.get(20)?,
            monitor_process: row.get(21)?,
                archive_status: row.get(22)?,
                archive_path: row.get(23)?,
                archive_size: row.get(24)?,
                archive_original_size: row.get(25)?,
                slot: row.get(26)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

#[tauri::command(async)]
pub fn get_game(state: State<'_, AppState>, id: String) -> AppResult<Game> {
    let conn = state.db.lock();
    let game = conn.query_row(
        "SELECT id, name, install_dir, exe_path, launch_args, env_vars, work_dir,
                cover_path, banner_path, bg_path, notes, tags, favorite, hidden,
                total_seconds, play_count, created_at, updated_at, sort_order, steam_appid,
                rtss_profile_name, monitor_process, archive_status, archive_path, archive_size, archive_original_size,
                slot
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
                rtss_profile_name: row.get(20)?,
                monitor_process: row.get(21)?,
                archive_status: row.get(22)?,
                archive_path: row.get(23)?,
                archive_size: row.get(24)?,
                archive_original_size: row.get(25)?,
                slot: row.get(26)?,
            })
        },
    )?;
    Ok(game)
}

#[tauri::command(async)]
pub fn create_game(state: State<'_, AppState>, mut game: Game) -> AppResult<Game> {
    let _operation = archive::OperationGuard::acquire(&state.archive_gate)?;
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
    // 名称若对上已删除游戏留下的历史统计，并入本游戏 —— 手动添加也要走这一步，
    // 否则统计页会同时出现「存档行」与「库内行」两条同名条目（且存档行没有实体可换封面）
    absorb_orphan_stats(&conn, &game.id, &game.name);
    drop(conn);
    get_game(state, game.id)
}

#[tauri::command(async)]
pub fn update_game(state: State<'_, AppState>, game: Game) -> AppResult<Game> {
    let _operation = archive::OperationGuard::acquire(&state.archive_gate)?;
    archive::check_edit(&state, &game)?;
    let conn = state.db.lock();
    conn.execute(
        "UPDATE games SET name = ?, install_dir = ?, exe_path = ?, launch_args = ?,
         env_vars = ?, work_dir = ?, cover_path = ?, banner_path = ?, bg_path = ?,
         notes = ?, tags = ?, favorite = ?, hidden = ?, total_seconds = ?, play_count = ?,
         monitor_process = ?, updated_at = datetime('now') WHERE id = ?",
        params![
            game.name, game.install_dir, game.exe_path, game.launch_args,
            game.env_vars, game.work_dir, game.cover_path, game.banner_path, game.bg_path,
            game.notes, game.tags, game.favorite as i32, game.hidden as i32,
            game.total_seconds, game.play_count, game.monitor_process, game.id
        ],
    )?;
    // 归档游戏改名后：名称若对上已删除游戏的历史统计，并入本游戏（解压恢复后继续累计）
    let status: String = conn
        .query_row("SELECT archive_status FROM games WHERE id = ?1", [&game.id], |r| r.get(0))
        .unwrap_or_default();
    if !status.is_empty() {
        absorb_orphan_stats(&conn, &game.id, &game.name);
    }
    drop(conn);
    get_game(state, game.id)
}

/// 把一个即将删除的媒体条目对统计的贡献写入 stats_archive（统计「只加不删」）。
/// key 为去重键；seconds/play_count 累加到已有记录（同一作品多次删除累积历史），
/// 展示信息与集数快照取最新一次删除时的值。没有任何时长/次数的条目不入档（删从没玩过的
/// 条目不该往封面墙塞空条目）。best-effort：存档失败不阻断删除本身。
#[allow(clippy::too_many_arguments)]
pub(crate) fn archive_stats_entry(
    conn: &Connection,
    key: &str,
    media: &str,
    name: &str,
    sub: &str,
    cover_path: &str,
    wide_path: &str,
    seconds: i64,
    play_count: i64,
    ext_id: i64,
    episodes: i64,
    watched_episodes: i64,
) {
    if seconds <= 0 && play_count <= 0 {
        return;
    }
    let _ = conn.execute(
        "INSERT INTO stats_archive
             (key, media, name, sub, cover_path, wide_path, seconds, play_count, ext_id, episodes, watched_episodes, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
             seconds = seconds + excluded.seconds,
             play_count = play_count + excluded.play_count,
             name = excluded.name,
             sub = excluded.sub,
             cover_path = excluded.cover_path,
             wide_path = excluded.wide_path,
             ext_id = excluded.ext_id,
             episodes = excluded.episodes,
             watched_episodes = excluded.watched_episodes,
             deleted_at = excluded.deleted_at",
        params![key, media, name, sub, cover_path, wide_path, seconds, play_count, ext_id, episodes, watched_episodes],
    );
}

/// 导入 / 改名归档游戏时：把名称匹配的「孤儿」历史统计（已删除游戏留下、当前没有任何实体游戏
/// 指向的 stats_archive 行）并入这个游戏——时长/次数累加到实体，删除孤儿行。于是统计里的历史
/// 就「指向」了这个游戏，解压恢复后在它上面继续累计（将来删除时再写回 stats_archive 合并）。
/// 已与实体关联（非孤儿，例如重装的 Steam 游戏）的历史一律不动，避免张冠李戴。
pub(crate) fn absorb_orphan_stats(conn: &Connection, game_id: &str, name: &str) {
    if name.trim().is_empty() {
        return;
    }
    let sum: (i64, i64) = conn
        .query_row(
            "SELECT COALESCE(SUM(seconds),0), COALESCE(SUM(play_count),0) FROM stats_archive a \
             WHERE a.media='game' AND lower(trim(a.name))=lower(trim(?1)) \
             AND NOT EXISTS (SELECT 1 FROM games g WHERE (a.ext_id>0 AND g.steam_appid=a.ext_id) \
             OR (a.ext_id=0 AND a.key='game:id:' || g.id))",
            [name],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, 0));
    if sum.0 <= 0 && sum.1 <= 0 {
        return;
    }
    let _ = conn.execute(
        "UPDATE games SET total_seconds = total_seconds + ?1, play_count = play_count + ?2 WHERE id = ?3",
        params![sum.0, sum.1, game_id],
    );
    let _ = conn.execute(
        "DELETE FROM stats_archive \
         WHERE media='game' AND lower(trim(name))=lower(trim(?1)) \
         AND NOT EXISTS (SELECT 1 FROM games g WHERE (stats_archive.ext_id>0 AND g.steam_appid=stats_archive.ext_id) \
         OR (stats_archive.ext_id=0 AND stats_archive.key='game:id:' || g.id))",
        [name],
    );
}

/// 把「库外时长」存档行（key = game:app:<appid>）并进刚入库的同 appid 游戏：
/// 游戏 total_seconds 取两者较大值，随后删掉存档行 —— 同一口径的时长两边只算一次
/// （统计页总时长 = 库内 total + 全部存档行；两边都留就是双计）。
/// Steam 导入 / Steam 游玩数据导入都会走这里；之后游戏再被删除时，会以当前 total 重新入档。
pub(crate) fn fold_archive_playtime(conn: &Connection, game_id: &str, appid: i64) {
    if appid <= 0 {
        return;
    }
    let key = format!("game:app:{}", appid);
    let secs: i64 = conn
        .query_row("SELECT seconds FROM stats_archive WHERE key = ?1", [&key], |r| r.get(0))
        .unwrap_or(0);
    if secs > 0 {
        let _ = conn.execute(
            "UPDATE games SET total_seconds = MAX(total_seconds, ?1) WHERE id = ?2",
            params![secs, game_id],
        );
    }
    let _ = conn.execute("DELETE FROM stats_archive WHERE key = ?1", [&key]);
}

/// 启动时的一次性兜底：把「已删除的同名游戏」留在统计存档里的时长并回库内同名的游戏。
/// 新增 / 导入游戏时走 absorb_orphan_stats，但历史库里会残留同名存档行 —— 那时统计页同名两行，
/// 右键还没有「更换悬停封面」（存档行没有实体可写 banner_path）。幂等：并完即删存档行。
/// 只处理 ext_id=0（按实体 id 存档）的条目；Steam 那类按 appid 存档的交给 appid 去重。
pub(crate) fn absorb_all_orphans(conn: &Connection) {
    let pairs: Vec<(String, String)> = {
        let mut stmt = match conn.prepare(
            "SELECT g.id, g.name FROM games g
             WHERE trim(g.name) <> '' AND EXISTS (
                 SELECT 1 FROM stats_archive a
                 WHERE a.media = 'game' AND a.ext_id = 0
                   AND lower(trim(a.name)) = lower(trim(g.name))
                   AND a.key <> 'game:id:' || g.id
             )",
        ) {
            Ok(s) => s,
            Err(_) => return,
        };
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)));
        match rows {
            Ok(it) => it.filter_map(Result::ok).collect(),
            Err(_) => return,
        }
    };
    for (id, name) in pairs {
        absorb_orphan_stats(conn, &id, &name);
    }
}

#[tauri::command(async)]
pub fn delete_game(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let _operation = archive::OperationGuard::acquire(&state.archive_gate)?;
    archive::require_unarchived(&state, &id)?;
    let conn = state.db.lock();
    // 删除前存档统计贡献：Steam 游戏按 appid 合并（删了又重装能累积历史），普通游戏按 id。
    // wide_path 存 banner_path 兜底；get_stats 会对 appid>0 的动态重建 Steam 短横封面。
    if let Ok((name, cover, banner, appid, secs)) = conn.query_row(
        "SELECT name, cover_path, banner_path, steam_appid, total_seconds FROM games WHERE id = ?1",
        [&id],
        |r| Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?,
        )),
    ) {
        let key = if appid > 0 { format!("game:app:{appid}") } else { format!("game:id:{id}") };
        archive_stats_entry(&conn, &key, "game", &name, "", &cover, &banner, secs, 0, appid, 0, 0);
    }
    conn.execute("DELETE FROM games WHERE id = ?", [&id])?;
    Ok(())
}

// 磁盘管理里的「删除」：连同盘上文件一起删（已归档删 .7z，普通游戏删整个安装目录），再删库记录。
// 与库主页右键的 delete_game（只删记录、且禁止已归档）不同——这里是回收磁盘空间的强删，前端有二次确认。
#[tauri::command(async)]
pub fn delete_game_and_files(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let _operation = archive::OperationGuard::acquire(&state.archive_gate)?;
    let (name, cover, banner, appid, secs, status, archive_path, install_dir): (
        String, String, String, i64, i64, String, String, String,
    ) = {
        let conn = state.db.lock();
        conn.query_row(
            "SELECT name, cover_path, banner_path, steam_appid, total_seconds, archive_status, archive_path, install_dir FROM games WHERE id = ?1",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
        )?
    };
    // 先删盘上文件：失败则保留库记录并报错，避免「库里消失但空间没释放」的错觉。
    if !status.is_empty() {
        let p = archive_path.trim();
        if !p.is_empty() && Path::new(p).exists() {
            std::fs::remove_file(p)
                .map_err(|e| AppError::Custom(format!("删除压缩包失败：{e}")))?;
        }
    } else {
        let d = install_dir.trim();
        if !d.is_empty() && Path::new(d).exists() {
            std::fs::remove_dir_all(d)
                .map_err(|e| AppError::Custom(format!("删除游戏目录失败：{e}")))?;
        }
    }
    // 文件已清理，再删库记录 + 存档统计贡献（与 delete_game 一致）。
    let conn = state.db.lock();
    let key = if appid > 0 { format!("game:app:{appid}") } else { format!("game:id:{id}") };
    archive_stats_entry(&conn, &key, "game", &name, "", &cover, &banner, secs, 0, appid, 0, 0);
    conn.execute("DELETE FROM games WHERE id = ?", [&id])?;
    Ok(())
}


// 读取并校验用户选择的本地图片，返回 (字节, 规范扩展名)。
// 主封面（set_game_cover）、悬停封面（set_game_banner）、文件夹封面（folders::set_folder_cover）共用：
// 都是「本地选图 → 落 covers 目录」
pub(crate) fn read_local_image(source_path: &str) -> AppResult<(Vec<u8>, String)> {
    let src = Path::new(source_path);
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
    let bytes = fs::read(src).map_err(|e| AppError::Custom(format!("读取封面失败: {}", e)))?;
    Ok((bytes, ext))
}

// 把用户选择的本地图片设为主封面（竖版）：复制到 covers/game_{id}_{时间戳}.{ext} 并更新 cover_path
#[tauri::command(async)]
pub fn set_game_cover(state: State<'_, AppState>, game_id: String, source_path: String) -> AppResult<String> {
    let (bytes, ext) = read_local_image(&source_path)?;
    let covers_dir = state.data_dir.join("covers");
    // 锁由 save_cover_bytes 内部按需短暂持有，写盘在锁外
    let cover = save_cover_bytes(&state.db, &covers_dir, &game_id, &bytes, &ext)?;
    Ok(cover)
}

/// 统计存档行（stats_archive）的 id：game:id:<uuid> / game:app:<appid>，与 games 表的 uuid 不冲突。
/// 封面相关命令据此分流 —— 统计页上的「库外记录」也要能换封面，而它只有 stats_archive 一行。
pub(crate) fn is_archive_id(id: &str) -> bool {
    id.starts_with("game:")
}

/// 封面文件名用的 id：存档 key 里带 ':'，是 Windows 非法文件名字符
fn safe_file_id(id: &str) -> String {
    id.replace(':', "_")
}

// 把用户选择的本地图片设为悬停封面（横屏）：复制到 covers/banner_{id}_{时间戳}.{ext} 并更新 banner_path
#[tauri::command(async)]
pub fn set_game_banner(state: State<'_, AppState>, game_id: String, source_path: String) -> AppResult<String> {
    let (bytes, ext) = read_local_image(&source_path)?;
    let covers_dir = state.data_dir.join("covers");
    let banner = save_banner_bytes(&state.db, &covers_dir, &game_id, &bytes, &ext)?;
    Ok(banner)
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
    let archive = is_archive_id(game_id); // 统计存档行（库外记录）
    let file_id = safe_file_id(game_id);
    let target = covers_dir.join(format!("game_{}_{}.{}", file_id, ts, ext));
    // 删除该游戏之前的自定义封面（steam_* 等共享文件不动）
    let old: Option<String> = {
        let conn = db.lock();
        if archive {
            conn.query_row(
                "SELECT cover_path FROM stats_archive WHERE key = ?1",
                params![game_id],
                |r| r.get(0),
            )
            .ok()
        } else {
            conn.query_row(
                "SELECT cover_path FROM games WHERE id = ?1",
                params![game_id],
                |r| r.get(0),
            )
            .ok()
        }
    };
    if let Some(old) = old {
        let old_path = Path::new(&old);
        let prefix = format!("game_{}.", file_id);
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
        if archive {
            conn.execute(
                "UPDATE stats_archive SET cover_path = ?1 WHERE key = ?2",
                params![cover, game_id],
            )?;
        } else {
            conn.execute(
                "UPDATE games SET cover_path = ?1, updated_at = datetime('now') WHERE id = ?2",
                params![cover, game_id],
            )?;
        }
    }
    Ok(cover)
}

// 把 API 返回的封面 URL 下载并设为游戏封面（SGDB 封面多为 PNG，按魔数定扩展名）
#[tauri::command]
pub async fn set_game_cover_url(state: State<'_, AppState>, game_id: String, url: String) -> AppResult<String> {
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

// 把 API 返回的横屏封面 URL 下载并设为悬停封面
#[tauri::command]
pub async fn set_game_banner_url(state: State<'_, AppState>, game_id: String, url: String) -> AppResult<String> {
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
    let banner = save_banner_bytes(&state.db, &covers_dir, &game_id, &bytes, ext)?;
    Ok(banner)
}

// 写入悬停封面文件（covers/banner_{game_id}_{时间戳}.{ext}）并更新 banner_path。
// 时间戳同 save_cover_bytes：路径必变才能让 WebView 重新请求新图；
// 清理旧的 banner_{game_id}.*；不碰 Steam 共享的 banner_{appid}.jpg。
// SGDB 下载（set_game_banner_url）与本地选图（set_game_banner）共用这一条落盘路径。
fn save_banner_bytes(
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
    let archive = is_archive_id(game_id); // 统计存档行（库外记录）
    let file_id = safe_file_id(game_id);
    let target = covers_dir.join(format!("banner_{}_{}.{}", file_id, ts, ext));
    let target_name = target.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
    // 清理旧的同前缀文件（保留目标文件本身）
    if let Ok(entries) = fs::read_dir(covers_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&format!("banner_{}.", file_id)) && name != target_name {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    fs::write(&target, bytes).map_err(|e| AppError::Custom(format!("写入封面失败: {}", e)))?;
    let banner = target.to_string_lossy().to_string();
    // 写盘在锁外，锁只盖一条 UPDATE（封面动辄几 MB，别占着全局 DB 锁）
    {
        let conn = db.lock();
        if archive {
            conn.execute(
                "UPDATE stats_archive SET wide_path = ?1 WHERE key = ?2",
                params![banner, game_id],
            )?;
        } else {
            conn.execute(
                "UPDATE games SET banner_path = ?1, updated_at = datetime('now') WHERE id = ?2",
                params![banner, game_id],
            )?;
        }
    }
    Ok(banner)
}

// 拉取指定 SGDB 游戏引用的竖版封面候选（steam/{appid} 或 game/{sgdb_id}）
pub(crate) async fn sgdb_grids(client: &reqwest::Client, key: &str, game_ref: &str) -> AppResult<Vec<CoverOption>> {
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
pub async fn fetch_cover_options(
    state: State<'_, AppState>,
    game_id: String,
    kind: String,
) -> AppResult<Vec<CoverOption>> {
    // 统计页上的「库外记录」（stats_archive 行）也要能换封面：名称/AppID 从那行取
    let (name, steam_appid, notes) = {
        let conn = state.db.lock();
        if is_archive_id(&game_id) {
            let (n, ext): (String, i64) = conn
                .query_row(
                    "SELECT name, ext_id FROM stats_archive WHERE key = ?1 AND media = 'game'",
                    [&game_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(|_| AppError::Custom("这条统计记录已不存在".to_string()))?;
            (n, ext.max(0) as u64, String::new())
        } else {
            conn.query_row(
                "SELECT name, steam_appid, notes FROM games WHERE id = ?1",
                params![game_id],
                |r| Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, u64>(1)?,
                    r.get::<_, String>(2)?,
                )),
            )?
        }
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
pub fn filter_games(state: State<'_, AppState>, filter: GameFilter) -> AppResult<Vec<Game>> {
    let conn = state.db.lock();
    let mut sql = String::from(
        "SELECT id, name, install_dir, exe_path, launch_args, env_vars, work_dir,
                cover_path, banner_path, bg_path, notes, tags, favorite, hidden,
                total_seconds, play_count, created_at, updated_at, sort_order, steam_appid,
                rtss_profile_name, monitor_process, archive_status, archive_path, archive_size, archive_original_size,
                slot
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
        _ => " ORDER BY CASE WHEN slot < 0 THEN 1 ELSE 0 END, slot, created_at, id"
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
            rtss_profile_name: row.get(20)?,
            monitor_process: row.get(21)?,
                archive_status: row.get(22)?,
                archive_path: row.get(23)?,
                archive_size: row.get(24)?,
                archive_original_size: row.get(25)?,
                slot: row.get(26)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}
#[tauri::command(async)]
pub fn launch_game(app: AppHandle, state: State<'_, AppState>, game_id: String) -> AppResult<String> {
    let _operation = archive::OperationGuard::acquire(&state.archive_gate)?;
    archive::require_unarchived(&state, &game_id)?;
    let game = get_game(state.clone(), game_id.clone())?;

    // RTSS 帧数 OSD：该游戏会用到 OSD 或限帧时过一道同步门 —— 游戏进程必须创建
    // 在 RTSS 之后，注入才走新进程钩子；后到的 RTSS 对已在跑的进程补注入挂不上
    // d3d8，会弹 "components cannot be hooked" 警告框。常态预热已把 RTSS 拉起，
    // 这里零等待；2 秒等不到照样启动游戏（那一次没 OSD）。样式取哪一份由配置对象
    // 决定（游戏有自己的 profile 就用它的，否则跟随全局），这里不写任何文件。
    // Steam 分支同样适用 —— profile 按 exe 名匹配，与拿不拿得到 PID 无关
    // 用户手动指定了监听进程时，RTSS profile 名以它为准（取文件名）—— 它就是真正的
    // 渲染进程；否则用回填的 rtss_profile_name，仍空则由 ensure_osd_ready 取 exe_path 文件名
    let rtss_name = if !game.monitor_process.trim().is_empty() {
        Path::new(&game.monitor_process)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default()
    } else {
        game.rtss_profile_name.clone()
    };
    rtss::ensure_osd_ready(&app, &game.exe_path, &rtss_name);

    // 启动器型游戏（exe_path 是 SB.exe 这类启动器，真身是 SB-Win64-Shipping.exe）：
    // RTSS 按真身 exe 名匹配 profile，绑在启动器名上的单游戏设置永远到不了真身。
    // 启动后盯一会进程表，发现真身就把 profile 重定向过去 + 热重载 + 回填真身名，
    // 之后每次启动 RTSS 在真身创建瞬间就命中配置。已回填过则无事可做。
    // 用户已手动指定监听进程时跳过自动检测（真身已知，不必扫）
    if game.rtss_profile_name.is_empty() && game.monitor_process.trim().is_empty() {
        rtss::bind_profile_to_real_process(
            app.clone(),
            game.exe_path.clone(),
            game.install_dir.clone(),
            game_id.clone(),
        );
    }

    // ── Steam 游戏：优先交给 Steam 客户端启动（steam://rungameid/<appid>）──
    // Steam 游戏只有经 Steam 启动才带 DRM 校验 / 反作弊 / 成就 / 云存档上下文；
    // 仅当 Steam 已识别游戏当前位置时走这条（识别判断见 steam_recognizes_game），
    // 否则回退 exe 直启 —— 启动经 explorer 转发，会话无 PID，靠轮询按路径匹配
    if game.steam_appid > 0 && steam_recognizes_game(game.steam_appid as u64, &game.install_dir) {
        launch_via_steam(&state, &game, &game_id);
        return Ok(String::new());
    }

    // ── 直接启动 exe（普通游戏；Steam 游戏的兜底）──
    let pid = launch_exe(&game)?;
    // 指定了监听进程时，被启动的 exe（启动器 / 包装器 / 脚本）本身不是要计时的对象 ——
    // 按监听进程锚定（走与 Steam rungameid 相同的路径）：process_seen=false，轮询等真身
    // 出现，宽限约 3 分钟，且计时从真身出现那刻起算（不含服务端 / 启动器拉起的等待）
    if game.monitor_process.trim().is_empty() {
        start_session(&state, &game, &game_id, pid, true);
    } else {
        start_session(&state, &game, &game_id, 0, false);
    }
    Ok(String::new())
}

// 直接 spawn 游戏 exe，返回子进程 PID。
// 工作目录：work_dir → install_dir → exe 所在目录。手动添加的游戏常只填了 exe 路径
// （install/work_dir 均空），空字符串 current_dir 会让 spawn 直接失败（ERROR_INVALID_NAME）
fn launch_exe(game: &Game) -> AppResult<u32> {
    let exe = &game.exe_path;
    let args = &game.launch_args;
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

    Ok(cmd.spawn()?.id())
}

// 建会话并登记到 running_games（由 30 秒轮询线程跟踪/结算）
fn start_session(
    state: &State<'_, AppState>,
    game: &Game,
    game_id: &str,
    process_id: u32,
    process_seen: bool,
) {
    state.running_games.write().insert(
        game_id.to_string(),
        GameSession {
            game_id: game_id.to_string(),
            process_id,
            start_time: Utc::now(),
            launch_start: Utc::now(),
            exe_path: game.exe_path.clone(),
            install_dir: game.install_dir.clone(),
            monitor_process: game.monitor_process.clone(),
            process_seen,
            miss_count: 0,
            no_window_polls: 0,
            accumulated: 0,
        },
    );
}

// 通过 steam://rungameid/<appid> 协议交给 Steam 客户端启动：
// 启动经 explorer 转发（explorer 毫秒级退出，不是游戏进程），拿不到游戏 PID →
// 会话 process_seen=false，由轮询线程按 exe 路径/名称匹配锚定（首见时才开始计时）
fn launch_via_steam(state: &State<'_, AppState>, game: &Game, game_id: &str) {
    let url = format!("steam://rungameid/{}", game.steam_appid);
    let _ = std::process::Command::new("explorer")
        .arg(&url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    start_session(state, game, game_id, 0, false);
}

// Steam 是否已识别游戏当前位置（决定 steam://rungameid 能否成功拉起）：
// 1) 游戏目录必须在某个 Steam 库根（steamapps 结构）下 —— 移到普通目录 Steam 不认识
// 2) 该库必须有 appmanifest_<appid>.acf（磁盘管理移动时已随文件夹搬迁）
// 3) 清单在 Steam 启动之后未被改动：Steam 启动时全量扫描建内存快照、运行中不监听
//    文件变化，移动后没重启 Steam 时快照过期，rungameid 会按旧路径报「缺少文件」
//    （重启 Steam 后快照刷新，自动恢复 Steam 启动）
// Steam 未运行视为识别：rungameid 会先拉起 Steam，其启动扫描会发现新位置
fn steam_recognizes_game(steam_appid: u64, install_dir: &str) -> bool {
    let Some(lib_root) = steam_library_root_of(Path::new(install_dir)) else {
        return false;
    };
    let manifest = lib_root
        .join("steamapps")
        .join(format!("appmanifest_{}.acf", steam_appid));
    let Ok(meta) = std::fs::metadata(&manifest) else {
        return false; // 清单缺失：未搬迁成功（或非常规安装），Steam 快照仍指向旧位置
    };
    let Some(steam_start) = steam_process_start_time() else {
        return true; // Steam 未运行：拉起时重新扫描
    };
    // 清单 mtime 与 Steam 启动时间同为 unix 秒；mtime 读失败保守判「过期」→ 走 exe 兜底
    let manifest_mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(u64::MAX);
    manifest_mtime <= steam_start
}

// steam.exe 进程创建时间（unix 秒）；Steam 未运行 → None
fn steam_process_start_time() -> Option<u64> {
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    sys.processes()
        .values()
        .find(|p| p.name().eq_ignore_ascii_case("steam.exe"))
        .map(|p| p.start_time())
}

// 返回命中游戏的进程 PID 列表。命中条件：
// 1) 进程 exe 路径与 exe_path 完全一致
// 2) 进程 exe 路径位于 install_dir 目录内（深层 bin 目录、子进程都算）
// 3) 进程名与 exe_path 文件名一致（管理员权限进程读不到 exe 路径时的兜底）
// 4) monitor（用户手动指定的监听进程）：含分隔符按路径/目录匹配，纯文件名按进程名匹配。
//    这是唯一能命中「与启动程序不同名且不同目录」真身的规则（如私服 wrapper → nikke.exe）
// pub(crate)：RTSS 真身 profile 检测（rtss::bind_profile_to_real_process）复用同一
// 套规则 —— 计时靠它找到 SB-Win64-Shipping.exe 这类真身，profile 重定向同理
pub(crate) fn game_process_matches(sys: &System, exe_path: &str, install_dir: &str, monitor: &str) -> Vec<u32> {
    let exe_key = normalize_win_path(exe_path);
    let install_key = normalize_win_path(install_dir);
    let name_key: String = Path::new(exe_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    // 手动指定的监听进程：路径形式（含分隔符）额外按路径/目录匹配；进程名兜底一律取
    // monitor 的文件名 —— 管理员权限进程读不到 exe 路径时，名字匹配是唯一能命中的途径
    // （所以路径形式也保留名字兜底，别让「填了全路径」反而在提权游戏上失配）
    let monitor = monitor.trim();
    let monitor_path_key = if monitor.contains('\\') || monitor.contains('/') {
        normalize_win_path(monitor)
    } else {
        String::new()
    };
    let monitor_name_key = Path::new(monitor)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    // 第一遍：游戏自身的 exe 全路径 / 安装目录 / 进程名（+ 用户指定的监听进程）直接命中。
    // 命中的是启动器本体和安装目录内的进程
    let is_direct = |p: &sysinfo::Process| -> bool {
        if let Some(exe) = p.exe() {
            let e = normalize_win_path(&exe.to_string_lossy());
            if !exe_key.is_empty() && e == exe_key {
                return true;
            }
            if !install_key.is_empty() && path_under_dir(&e, &install_key) {
                return true;
            }
            if !monitor_path_key.is_empty()
                && (e == monitor_path_key || path_under_dir(&e, &monitor_path_key))
            {
                return true;
            }
        }
        // 进程名匹配：exe_path 文件名 或 用户指定的监听进程名。管理员进程读不到
        // exe 路径时，这是唯一兜底（monitor 常填进程名，如 nikke.exe）
        let n = p.name().to_string_lossy().to_lowercase();
        if !name_key.is_empty() && n == name_key {
            return true;
        }
        if !monitor_name_key.is_empty() && n == monitor_name_key {
            return true;
        }
        false
    };
    let mut matched: HashSet<u32> = sys
        .processes()
        .values()
        .filter(|p| is_direct(p))
        .map(|p| p.pid().as_u32())
        .collect();

    // 第二遍：父链闭包。真身渲染进程常是启动器拉起的子进程（PlayGTAV.exe →
    // GTA5_Enhanced.exe、SB.exe → SB-Win64-Shipping.exe）。这类进程往往读不到自己的
    // exe 路径（受保护 / 提权，p.exe()=None），上面「exe 全路径」「安装目录」两条规则
    // 全失效，名字又跟启动器不同 —— 唯独「父进程是已命中进程」这条不依赖读路径：
    // PPID 和进程名在系统快照里对所有进程都可得。迭代到不动点，覆盖多级启动器链。
    // 种子全来自游戏自身，闭包只扩到启动器自己拉起的子孙，不会误伤无关进程。
    // 计时与真身检测共用本函数：对两边都是增益（启动器常驻、真身另名时不再漏）
    loop {
        let grown: Vec<u32> = sys
            .processes()
            .values()
            .filter(|p| {
                !matched.contains(&p.pid().as_u32())
                    && p.parent()
                        .map(|pp| matched.contains(&pp.as_u32()))
                        .unwrap_or(false)
            })
            .map(|p| p.pid().as_u32())
            .collect();
        if grown.is_empty() {
            break;
        }
        matched.extend(grown);
    }

    matched.into_iter().collect()
}

// 进程是否带"活跃"主窗口：可见（含最小化——最小化窗口保留 WS_VISIBLE，实测确认；
// 再加 IsIconic 兜底，某些程序最小化时窗口样式不标准）即视为游戏开着。
// 后台驻留型进程（渲染器/更新器等）的窗口全部隐藏（实测 Wallpaper Engine 关窗后有 3 个
// 隐藏窗口、无可见/最小化窗口）→ 不算——这是区分"游戏真的开着"与"驻留进程还活着"的依据
// pub(crate)：RTSS 真身识别复用 —— 启动器（SB.exe）无窗口、真身有，是区分二者的依据
#[cfg(windows)]
pub(crate) fn process_has_visible_window(pid: u32) -> bool {
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
pub(crate) fn process_has_visible_window(_pid: u32) -> bool {
    true // 非 Windows 平台没有窗口概念，保持原有进程判定行为
}

// 结算会话：从运行表取出会话，把尾部增量写入 total_seconds（实时增量已在轮询时写入）。
// 返回本次时长；会话不存在返回 None。写库失败仅记日志，不阻塞轮询
pub(crate) fn close_session(state: &AppState, game_id: &str) -> Option<i64> {
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
pub fn check_game_running(state: State<'_, AppState>, game_id: String) -> AppResult<bool> {
    Ok(poll_game_session(state.inner(), &game_id))
}

// 轮询单个会话：累计时长 / 判定退出 / 结算。返回是否仍在运行。
// 由后端 30 秒定时线程驱动（见 run() 里的 spawn）——最小化到托盘后 WebView 的 setTimeout
// 会被节流甚至冻结，时长累计和结算不能依赖前端轮询；命令入口仅作前端主动查询用
pub(crate) fn poll_game_session(state: &AppState, game_id: &str) -> bool {
    let game_id = game_id.to_string();
    // 短锁取会话快照（进程扫描较慢，不长时间持锁）
    let snapshot = {
        let sessions = state.running_games.read();
        sessions.get(&game_id).cloned()
    };
    let Some(session) = snapshot else {
        return false; // 会话不存在：已过期清理或从未启动
    };

    // 找出命中游戏的进程：锚定 PID + 路径/目录/名称匹配取并集。只盯 PID 不够——
    // SB.exe（Stellar Blade）这类无窗口启动器拉起真身后自己不退出（窗口消失），
    // 若只认 PID，会话会在两轮无窗口宽限后被误判成「驻留进程残留」结算掉，
    // 真身（SB-Win64-Shipping.exe，靠 install_dir 规则才能命中）的时长全部丢失；
    // 反过来启动器先退、子进程接跑的启动器型游戏则靠路径/名称兜底。
    // Steam 游戏（rungameid，explorer 毫秒级退出）PID 恒为 0，完全靠路径/名称匹配
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let launcher_alive = session.process_id != 0
        && sys.process(sysinfo::Pid::from_u32(session.process_id)).is_some();
    let mut matched: Vec<u32> = if launcher_alive {
        vec![session.process_id]
    } else {
        Vec::new()
    };
    for pid in game_process_matches(&sys, &session.exe_path, &session.install_dir, &session.monitor_process) {
        if !matched.contains(&pid) {
            matched.push(pid);
        }
    }

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
                // Wallpaper Engine 的渲染进程）——不累计时长，宽限后结算；
                // 尾部清零后结算不写入幻影时长，宽限长短只影响「运行中」标记的滞留。
                // 轮询间隔 30 秒/轮。锚定的启动器还活着时放宽到 3 轮（约 90 秒）：
                // 给 SB.exe→SB-Win64-Shipping.exe 这类「无窗口启动器→真身」的拉起链
                // 留出窗口出现时间（冷盘加载首窗可能接近分钟级）；启动器已死（游戏
                // 真的关了）2 轮（约 60 秒）结算，与 miss_count 全进程消失路径节奏一致
                s.no_window_polls += 1;
                let grace = if launcher_alive { 3 } else { 2 };
                if s.no_window_polls >= grace {
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
pub(crate) fn normalize_win_path(p: &str) -> String {
    p.trim().replace('/', "\\").to_lowercase()
}

// path 是否位于 dir 内部（含相等）。基于已归一化路径做前缀匹配，且必须切在分隔符上，
// 避免 C:\Games\CS 误匹配 C:\Games\CS2\game.exe
pub(crate) fn path_under_dir(path: &str, dir: &str) -> bool {
    match path.strip_prefix(dir) {
        Some(rest) => rest.is_empty() || rest.starts_with('\\'),
        None => false,
    }
}

#[tauri::command(async)]
pub fn on_game_exit(state: State<'_, AppState>, game_id: String) -> AppResult<i64> {
    // 会话的结束与结算现在由 check_game_running 在轮询时完成（带窗口判定）；
    // 此命令仅作前端兜底调用，会话已不存在时返回错误
    close_session(&state, &game_id)
        .ok_or_else(|| AppError::Custom("No active session found".to_string()))
}
