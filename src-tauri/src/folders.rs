// 游戏库文件夹：把多个游戏收成顶层的一格。
//
// 两张表（建表见 lib.rs init_database）：
//   game_folders       —— 文件夹本体，slot = 绝对格号
//   game_folder_items  —— 成员，game_id 做主键 = 单一归属；两个 ON DELETE CASCADE
//                         负责「删游戏 / 删文件夹」之后的清理
//
// 布局模型（改动前先读，这是各个位置字段的职责）：
//   整库自由摆放：游戏和文件夹共用一个「绝对格号」空间，拖到哪格就钉在哪格，
//   任何一格都能空着，谁都不会自动往前堆。
//   · 游戏位置     = games.slot（0 基格号；-1 = 未定位的新游戏 → 落进第一个空格）
//   · 文件夹位置   = game_folders.slot（同一个格号空间）
//   · 文件夹内顺序 = game_folder_items.sort_order（文件夹内部仍是一条列表，密排 1..n）
//   落到已被占的格上 = 两者交换（见前端 GameGrid 的拖拽分支 + set_library_slots）。
//   游戏拖进文件夹时它的 slot 一律不动 —— 那是它的「原位记忆」，移出 / 解散时先试着
//   回那一格，被占了才顺延。
//   实际落格由前端的 buildLibraryLayout（src/utils/libraryCells.ts）算，后端只存格号。
//
//   games.sort_order / game_folders.sort_order 都是早期「连续序列」模型的遗留列，
//   已废弃：只在迁移和导入老数据时被读一次用来回填 slot，之后谁都不碰。
use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use crate::{AppError, AppResult, AppState, GameFolder};

/// 读全部文件夹（含成员 id）。按格号排序，未定位（slot<0）的排末尾。
/// 导出数据（settings::export_data）复用这个函数，与歌单的 music::load_playlists 同款
pub(crate) fn load_game_folders(conn: &Connection) -> AppResult<Vec<GameFolder>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, slot, color, cover_path, created_at, updated_at FROM game_folders
         ORDER BY CASE WHEN slot < 0 THEN 1 ELSE 0 END, slot, created_at, id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(GameFolder {
            id: row.get(0)?,
            name: row.get(1)?,
            slot: row.get(2)?,
            color: row.get(3)?,
            cover_path: row.get(4)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
            game_ids: Vec::new(),
        })
    })?;
    let mut folders = rows.collect::<Result<Vec<_>, _>>()?;

    let mut items = conn.prepare(
        "SELECT game_id FROM game_folder_items WHERE folder_id = ?1
         ORDER BY sort_order, added_at, game_id",
    )?;
    for folder in &mut folders {
        folder.game_ids = items
            .query_map([&folder.id], |r| r.get::<_, String>(0))?
            .filter_map(Result::ok)
            .collect();
    }
    Ok(folders)
}

#[tauri::command(async)]
pub fn get_game_folders(state: State<'_, AppState>) -> AppResult<Vec<GameFolder>> {
    let conn = state.db.lock();
    load_game_folders(&conn)
}

/// 重名校验（忽略大小写与首尾空格，与 music::create_playlist 同款）。
/// 表上不加 UNIQUE：老库可能已有重名数据，加约束会让建表静默失败。
/// exclude_id 用于重命名时跳过自己
fn ensure_name_free(conn: &Connection, name: &str, exclude_id: Option<&str>) -> AppResult<()> {
    let dup: Option<bool> = conn
        .query_row(
            "SELECT 1 FROM game_folders WHERE name = ?1 COLLATE NOCASE AND id <> ?2",
            params![name, exclude_id.unwrap_or("")],
            |r| r.get(0),
        )
        .optional()?;
    if dup.unwrap_or(false) {
        return Err(AppError::Custom(format!("文件夹「{}」已存在", name)));
    }
    Ok(())
}

/// 新建文件夹并把 game_ids 收进去（按入参顺序写文件夹内 sort_order）。
/// slot 由前端给：右键那张卡当前所在的格号 —— 新文件夹就出现在那张卡的格位上，
/// 它收进去的游戏连同后面的游戏往后流一格
#[tauri::command(async)]
pub fn create_game_folder(
    state: State<'_, AppState>,
    name: String,
    game_ids: Vec<String>,
    slot: i64,
) -> AppResult<GameFolder> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Custom("文件夹名不能为空".to_string()));
    }
    let id = Uuid::new_v4().to_string();
    let slot = slot.max(-1);
    let mut conn = state.db.lock();
    ensure_name_free(&conn, &name, None)?;
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO game_folders (id, name, slot) VALUES (?1, ?2, ?3)",
        params![id, name, slot],
    )?;

    // 实际收进去的游戏（按入参顺序）：OR REPLACE 让「已在别的文件夹里」的游戏直接改归属。
    // WHERE EXISTS 挡住不存在的 game_id —— 没有它的话 FK 会让整个事务失败
    let mut inserted: Vec<String> = Vec::new();
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO game_folder_items (game_id, folder_id, sort_order)
             SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM games WHERE id = ?1)",
        )?;
        for (i, gid) in game_ids.iter().enumerate() {
            if stmt.execute(params![gid, id, i as i64 + 1])? > 0 {
                inserted.push(gid.clone());
            }
        }
    }
    // 时间戳由表默认值生成，事务内读回，保证与后续 get_game_folders 一致
    let (created_at, updated_at): (String, String) = tx.query_row(
        "SELECT created_at, updated_at FROM game_folders WHERE id = ?1",
        [&id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    tx.commit()?;
    Ok(GameFolder {
        id,
        name,
        slot,
        color: String::new(),
        cover_path: String::new(),
        created_at,
        updated_at,
        game_ids: inserted,
    })
}

#[tauri::command(async)]
pub fn rename_game_folder(state: State<'_, AppState>, id: String, name: String) -> AppResult<()> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Custom("文件夹名不能为空".to_string()));
    }
    let conn = state.db.lock();
    ensure_name_free(&conn, &name, Some(&id))?;
    conn.execute(
        "UPDATE game_folders SET name = ?1, updated_at = datetime('now') WHERE id = ?2",
        params![name, id],
    )?;
    Ok(())
}

/// 解散文件夹：只删文件夹本体，成员行由 ON DELETE CASCADE 清掉 →
/// 游戏各自按 games.sort_order（收进来时没动过）散回顶层原来的位置。游戏本身不受影响
#[tauri::command(async)]
pub fn dissolve_game_folder(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM game_folders WHERE id = ?1", [&id])?;
    Ok(())
}

/// 放入 / 移出文件夹。folder_id = Some → 放进该文件夹末尾；None → 移出回顶层。
/// 移出时不碰 games.sort_order，游戏回到它进文件夹之前的那一带
#[tauri::command(async)]
pub fn set_games_folder(
    state: State<'_, AppState>,
    game_ids: Vec<String>,
    folder_id: Option<String>,
) -> AppResult<()> {
    if game_ids.is_empty() {
        return Ok(());
    }
    let mut conn = state.db.lock();
    if let Some(ref fid) = folder_id {
        let exists: Option<bool> = conn
            .query_row("SELECT 1 FROM game_folders WHERE id = ?1", [fid], |r| r.get(0))
            .optional()?;
        if !exists.unwrap_or(false) {
            return Err(AppError::Custom("文件夹不存在".to_string()));
        }
    }
    let tx = conn.transaction()?;
    match folder_id {
        Some(fid) => {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO game_folder_items (game_id, folder_id, sort_order)
                 SELECT ?1, ?2, (SELECT COALESCE(MAX(sort_order), 0) + 1
                                 FROM game_folder_items WHERE folder_id = ?2)
                 WHERE EXISTS (SELECT 1 FROM games WHERE id = ?1)",
            )?;
            for gid in &game_ids {
                stmt.execute(params![gid, fid])?;
            }
        }
        None => {
            let mut stmt = tx.prepare("DELETE FROM game_folder_items WHERE game_id = ?1")?;
            for gid in &game_ids {
                stmt.execute([gid])?;
            }
        }
    }
    tx.commit()?;
    Ok(())
}

/// 一次写若干格子的归属（游戏与文件夹共用一个格号空间）。key 形如 "g:<游戏 id>" / "f:<文件夹 id>"。
/// 拖一张卡落位是 1 条；落到已被占的格上 = 两者交换，是 2 条 —— 一个命令一个事务，
/// 不会出现「交换写了一半」的半截状态
#[derive(Deserialize)]
pub struct SlotItem {
    pub key: String,
    pub slot: i64,
}

#[tauri::command(async)]
pub fn set_library_slots(state: State<'_, AppState>, items: Vec<SlotItem>) -> AppResult<()> {
    if items.is_empty() {
        return Ok(());
    }
    let mut conn = state.db.lock();
    let tx = conn.transaction()?;
    {
        let mut game_stmt = tx.prepare("UPDATE games SET slot = ?1 WHERE id = ?2")?;
        let mut folder_stmt = tx.prepare(
            "UPDATE game_folders SET slot = ?1, updated_at = datetime('now') WHERE id = ?2",
        )?;
        for it in &items {
            let slot = it.slot.max(-1);
            if let Some(id) = it.key.strip_prefix("g:") {
                game_stmt.execute(params![slot, id])?;
            } else if let Some(id) = it.key.strip_prefix("f:") {
                folder_stmt.execute(params![slot, id])?;
            }
        }
    }
    tx.commit()?;
    Ok(())
}

/// 文件夹内重排：文件夹内部仍是一条列表（密排的 1..n），不做自由摆放
#[tauri::command(async)]
pub fn reorder_folder_games(
    state: State<'_, AppState>,
    folder_id: String,
    ordered_ids: Vec<String>,
) -> AppResult<()> {
    let mut conn = state.db.lock();
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "UPDATE game_folder_items SET sort_order = ?1 WHERE game_id = ?2 AND folder_id = ?3",
        )?;
        for (i, gid) in ordered_ids.iter().enumerate() {
            stmt.execute(params![i as i64 + 1, gid, folder_id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// 把用户选择的本地图片设为文件夹封面：复制到 covers/folder_{id}_{时间戳}.{ext} 并更新 cover_path。
/// 与 games::save_cover_bytes 同款：文件名带时间戳 —— 换封面后路径必变，前端 img src 变化，
/// WebView 才会重新请求新图（同名文件即使内容更新，浏览器也绝不会重新加载）。
/// 写盘在 DB 锁外做：封面动辄几 MB，占着全局锁写盘会让同期的库查询全排队
#[tauri::command(async)]
pub fn set_folder_cover(
    state: State<'_, AppState>,
    folder_id: String,
    source_path: String,
) -> AppResult<String> {
    let (bytes, ext) = crate::games::read_local_image(&source_path)?;
    let covers_dir = state.data_dir.join("covers");
    if fs::create_dir_all(&covers_dir).is_err() {
        return Err(AppError::Custom("无法创建封面目录".to_string()));
    }
    let ts = Utc::now().timestamp_millis();
    let target = covers_dir.join(format!("folder_{}_{}.{}", folder_id, ts, ext));
    // 删除该文件夹之前的自定义封面（前缀匹配，共享的 steam_* 等文件不动）
    let old: Option<String> = {
        let conn = state.db.lock();
        conn.query_row(
            "SELECT cover_path FROM game_folders WHERE id = ?1",
            params![folder_id],
            |r| r.get(0),
        )
        .optional()?
    };
    if let Some(old) = old {
        let old_path = Path::new(&old);
        let prefix = format!("folder_{}.", folder_id);
        if old_path.starts_with(&covers_dir)
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
        let conn = state.db.lock();
        conn.execute(
            "UPDATE game_folders SET cover_path = ?1, updated_at = datetime('now') WHERE id = ?2",
            params![cover, folder_id],
        )?;
    }
    Ok(cover)
}

/// 恢复默认封面：清空 cover_path（卡片回到拼图墙）并删掉 covers 目录里的自定义封面文件。
/// 与 set_folder_cover 同款的前缀匹配 —— 只删本文件夹自己的图，别的文件不动
#[tauri::command(async)]
pub fn clear_folder_cover(state: State<'_, AppState>, folder_id: String) -> AppResult<()> {
    let covers_dir = state.data_dir.join("covers");
    let old: Option<String> = {
        let conn = state.db.lock();
        conn.query_row(
            "SELECT cover_path FROM game_folders WHERE id = ?1",
            params![folder_id],
            |r| r.get(0),
        )
        .optional()?
    };
    if let Some(old) = old {
        let old_path = Path::new(&old);
        let prefix = format!("folder_{}.", folder_id);
        if old_path.starts_with(&covers_dir)
            && old_path
                .file_name()
                .map(|f| f.to_string_lossy().starts_with(&prefix))
                .unwrap_or(false)
        {
            let _ = fs::remove_file(old_path);
        }
    }
    let conn = state.db.lock();
    conn.execute(
        "UPDATE game_folders SET cover_path = '', updated_at = datetime('now') WHERE id = ?1",
        params![folder_id],
    )?;
    Ok(())
}

/// 内置封面预设的来源目录：随包分发的 folder-covers/（与 ZEX.exe 同级），
/// 查找顺序与 mpv / skin / rtss 同一套 —— Resource 基目录 → exe 旁，同样没有开发树兜底
fn resolve_folder_covers(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(p) = app
        .path()
        .resolve("folder-covers", tauri::path::BaseDirectory::Resource)
    {
        if p.is_dir() {
            return Some(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("folder-covers");
            if p.is_dir() {
                return Some(p);
            }
        }
    }
    None
}

/// 一张内置封面预设。name 取文件名（图上本来就印着分类名），path 是 covers 目录里的副本 ——
/// covers 协议只按文件名在 covers 目录里取图（music::serve_covers_file），不复制一份过去
/// 前端连缩略图都显示不出来。副本名以 preset_ 开头，与 set_folder_cover / clear_folder_cover
/// 只删 folder_{id}.* 的前缀匹配互不干扰
#[derive(Serialize)]
pub struct FolderCoverPreset {
    pub name: String,
    pub path: String,
}

/// 列出内置封面预设（文件夹封面窗口的候选网格）。前端选中后把 path 原样交给 set_folder_cover，
/// 于是「预览用的图」和「设成封面的图」是同一条路径；被复制成 folder_{id}_{ts}.* 之后，
/// 文件夹就不再依赖 covers 里的 preset_ 副本了
#[tauri::command(async)]
pub fn get_folder_cover_presets(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<Vec<FolderCoverPreset>> {
    let Some(src_dir) = resolve_folder_covers(&app) else {
        return Ok(Vec::new()); // 随包组件缺失：网格留空，自定义封面照旧可用
    };
    let covers_dir = state.data_dir.join("covers");
    let _ = fs::create_dir_all(&covers_dir);

    let mut presets = Vec::new();
    let Ok(entries) = fs::read_dir(&src_dir) else {
        return Ok(Vec::new());
    };
    for entry in entries.flatten() {
        let src = entry.path();
        if !src.is_file() {
            continue;
        }
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_default();
        if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp") {
            continue;
        }
        let Some(stem) = src.file_stem().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        let dest = covers_dir.join(format!("preset_{}.{}", stem, ext));
        // 副本缺失、或比源旧才复制。fs::copy 走 CopyFileEx、时间戳跟着源走，
        // 所以复制完这个比较自然成立，不会每开一次弹窗就重写一遍图
        let stale = match (fs::metadata(&dest), fs::metadata(&src)) {
            (Ok(d), Ok(s)) => d.modified().ok() < s.modified().ok(),
            _ => true,
        };
        if stale {
            let _ = fs::copy(&src, &dest);
        }
        if dest.is_file() {
            presets.push(FolderCoverPreset {
                name: stem,
                path: dest.to_string_lossy().to_string(),
            });
        }
    }
    presets.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(presets)
}
