// 肃正协议：跨端观看进度同步（桌面端 D:\ZEX ⇄ 电视 D:\ZEX-TV）。
// 见电视端同名模块的详细说明。桌面直接用文件系统读写 NAS 上的核心文件
//（UNC 或映射盘路径，用户在设置里指定 sync_dir），不需要 SMB 客户端。
//
// 单文件「肃正核心.json」= 两端进度并集：读 → 比本地新的并进库 → 本库全量并回 → 原子覆盖。
// 自然键：优先 tmdb_id+季+集，无 tmdb 兜底文件名（两端指向 NAS 同一文件，文件名相同）。
// 触发（见 lib.rs）：冷启动、窗口重新获得焦点（从 mpv 回到 ZEX）、标记看完。

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::Ordering;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::{AppResult, AppState};

const CORE_FILE: &str = "肃正核心.json";
// schema=2：季号修复版——兜底键格式变更（tmdb=0 从「文件名」改为「父目录/文件名」）。
// 两端一起升到 2 后，旧 schema=1 核心文件（含被压扁的错季旧键）会被两端自动忽略、
// 用各自本地的正确进度重建并集，避免旧错键污染真实进度（见 sync_once 的 schema 过滤）。
pub const SNAP_SCHEMA: u32 = 2;

/// 单集进度记录（字段名压到最短，快照可能上千条）
#[derive(Serialize, Deserialize)]
struct Rec {
    #[serde(default)] tmdb_id: i64,
    #[serde(default)] s: i32,        // season_number
    #[serde(default)] e: i32,        // episode_number
    #[serde(default)] base: String,  // 视频文件 basename（兜底键）
    #[serde(default)] watched: bool,
    #[serde(default)] watched_ms: i64,
    #[serde(default)] at: String,    // last_watched_at（SQLite datetime，UTC，可字符串比较）
}

#[derive(Serialize, Deserialize)]
struct Snapshot {
    schema: u32,
    device: String,
    updated_at: String,
    episodes: Vec<Rec>,
}

// 跨端稳定键：文件路径的「父目录名/文件名」。两端指向 NAS 同一文件、路径尾必然一致，
// 比单纯 basename 多带一层父目录，能把 Season 1/01.mkv 与 Season 2/01.mkv 区分开
// （同名跨季不再串档）。两端必须同算法（桌面/电视 sync 共用同一实现）。
fn lasttwo(p: &str) -> String {
    let n = p.replace('\\', "/");
    let mut it = n.rsplit('/');
    let file = it.next().unwrap_or("");
    match it.next() {
        Some(parent) if !parent.is_empty() => format!("{}/{}", parent, file),
        _ => file.to_string(),
    }
}

fn canon(r: &Rec) -> String {
    if r.tmdb_id > 0 {
        format!("t:{}:{}:{}", r.tmdb_id, r.s, r.e)
    } else {
        format!("b:{}", r.base)
    }
}

fn setting_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).ok()
}

fn setting_set(conn: &Connection, key: &str, value: &str) {
    let _ = conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)", rusqlite::params![key, value]);
}

/// 本端稳定标识：settings.sync_device_id，首次生成后固定（决定 device 字段）
fn device_id(conn: &Connection) -> String {
    if let Some(id) = setting_get(conn, "sync_device_id") {
        if !id.is_empty() {
            return id;
        }
    }
    let id = format!("pc-{}", uuid::Uuid::new_v4());
    setting_set(conn, "sync_device_id", &id);
    id
}

/// 桌面默认**关**：只有显式存过 "1" 才开（电视端默认开）。用户在设置里开启后才参与同步。
fn enabled(conn: &Connection) -> bool {
    setting_get(conn, "sync_enabled").map(|v| v == "1").unwrap_or(false)
}

/// 肃正核心目录：用户在设置里指定的文件系统路径（UNC 或映射盘）。未填 = 未配置 = 不同步。
fn core_dir(conn: &Connection) -> Option<PathBuf> {
    let dir = setting_get(conn, "sync_dir").unwrap_or_default();
    let dir = dir.trim();
    if dir.is_empty() {
        None
    } else {
        Some(PathBuf::from(dir))
    }
}

/// 并集（后写者胜）：同一自然键保留 last_watched_at 最大的那条
fn union(file_recs: Vec<Rec>, my_recs: Vec<Rec>) -> Vec<Rec> {
    use std::collections::HashMap;
    let mut m: HashMap<String, Rec> = HashMap::new();
    for r in file_recs.into_iter().chain(my_recs) {
        let k = canon(&r);
        match m.get(&k) {
            Some(prev) if prev.at.as_str() >= r.at.as_str() => {}
            _ => {
                m.insert(k, r);
            }
        }
    }
    m.into_values().collect()
}

/// 本端所有「有进度」的集 → 记录列表
fn build_records(conn: &Connection) -> (Vec<Rec>, String) {
    let updated_at: String = conn
        .query_row("SELECT datetime('now')", [], |r| r.get(0))
        .unwrap_or_default();
    let mut episodes = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT s.tmdb_id, se.season_number, e.episode_number, e.local_path,
                e.watched, e.watched_ms, e.last_watched_at
         FROM episodes e
         JOIN seasons se ON se.id = e.season_id
         JOIN series s ON s.id = e.series_id
         WHERE (e.watched = 1 OR e.watched_ms > 0) AND e.last_watched_at <> ''",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| {
            let lp: String = r.get(3)?;
            Ok(Rec {
                tmdb_id: r.get(0)?,
                s: r.get(1)?,
                e: r.get(2)?,
                base: lasttwo(&lp),
                watched: r.get::<_, i32>(4)? != 0,
                watched_ms: r.get(5)?,
                at: r.get(6)?,
            })
        }) {
            episodes = rows.filter_map(|r| r.ok()).collect();
        }
    }
    (episodes, updated_at)
}

/// 把一批进度记录合并进本库：按自然键找到本地集，incoming 更新才覆盖。返回改动条数。
fn merge(conn: &Connection, recs: &[Rec]) -> AppResult<usize> {
    use std::collections::HashMap;
    let mut by_key: HashMap<(i64, i32, i32), (String, String)> = HashMap::new();
    let mut by_base: HashMap<String, (String, String)> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT e.id, s.tmdb_id, se.season_number, e.episode_number, e.local_path, e.last_watched_at
             FROM episodes e
             JOIN seasons se ON se.id = e.season_id
             JOIN series s ON s.id = e.series_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i32>(2)?,
                r.get::<_, i32>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?;
        for row in rows {
            let (id, tmdb, s, e, lp, last) = row?;
            if tmdb > 0 {
                by_key.insert((tmdb, s, e), (id.clone(), last.clone()));
            }
            by_base.entry(lasttwo(&lp)).or_insert((id, last));
        }
    }
    let mut changed = 0usize;
    for rec in recs {
        let local = if rec.tmdb_id > 0 { by_key.get(&(rec.tmdb_id, rec.s, rec.e)) } else { None }
            .or_else(|| by_base.get(&rec.base));
        if let Some((id, local_last)) = local {
            if rec.at.as_str() > local_last.as_str() {
                conn.execute(
                    "UPDATE episodes SET watched = ?1, watched_ms = ?2, last_watched_at = ?3 WHERE id = ?4",
                    rusqlite::params![rec.watched as i32, rec.watched_ms, rec.at, id],
                )?;
                changed += 1;
            }
        }
    }
    Ok(changed)
}

/// 一次完整对账（同步 fs I/O，放后台线程跑）：读核心文件 → 并进库 → 本库全量并回 → 原子覆盖。
fn sync_once(app: &AppHandle) -> AppResult<()> {
    let state = app.state::<AppState>();
    // 配置 + 目录（短锁）
    let (dir, dev) = {
        let conn = state.db.lock();
        if !enabled(&conn) {
            return Ok(());
        }
        match core_dir(&conn) {
            Some(d) => (d, device_id(&conn)),
            None => return Ok(()), // 未配置肃正核心位置
        }
    };
    let core = dir.join(CORE_FILE);
    // 读回核心文件（不存在/损坏都当空，随后整份重写）
    let file_recs: Vec<Rec> = fs::read(&core)
        .ok()
        .and_then(|b| serde_json::from_slice::<Snapshot>(&b).ok())
        .filter(|s| s.schema == SNAP_SCHEMA)
        .map(|s| s.episodes)
        .unwrap_or_default();
    // 并进本库 + 取本库全量进度（短锁）
    let (changed, my_recs, updated_at) = {
        let conn = state.db.lock();
        let changed = merge(&conn, &file_recs)?;
        let (recs, at) = build_records(&conn);
        (changed, recs, at)
    };
    // 并集后整份覆盖写回（临时文件 + rename = 原子替换，安全版「删光重写」）
    let out = Snapshot { schema: SNAP_SCHEMA, device: dev, updated_at, episodes: union(file_recs, my_recs) };
    let bytes = serde_json::to_vec(&out)?;
    fs::create_dir_all(&dir)?;
    let tmp = dir.join(".肃正核心.json.tmp");
    fs::write(&tmp, &bytes)?;
    fs::rename(&tmp, &core)?;
    if changed > 0 {
        log::info!("肃正协议·合并 {changed} 条进度");
        let _ = app.emit("progress-synced", changed);
    }
    Ok(())
}

/// 触发一次对账。合并去重 + 串行化：进行中再调只置 pending，让在跑的线程收尾时补跑一轮，
/// 保证同一时刻只有一个线程读改写核心文件。后台线程跑，不阻塞命令/UI。
/// 调用点：冷启动、窗口重新获得焦点（从 mpv 回到 ZEX）、标记看完。
pub fn sync(app: AppHandle) {
    {
        let state = app.state::<AppState>();
        state.sync_pending.store(true, Ordering::Release);
        if state
            .sync_running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return; // 已有线程在跑，它会看到 pending 再补一轮
        }
    }
    std::thread::spawn(move || loop {
        while app.state::<AppState>().sync_pending.swap(false, Ordering::AcqRel) {
            if let Err(e) = sync_once(&app) {
                log::warn!("肃正协议·同步失败：{e}");
            }
        }
        app.state::<AppState>().sync_running.store(false, Ordering::Release);
        // 收尾竞态：swap(false) 与 store(false) 之间若又来请求，抢回执行权补跑
        let state = app.state::<AppState>();
        if state.sync_pending.load(Ordering::Acquire)
            && state
                .sync_running
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
        {
            continue;
        }
        break;
    });
}

/// 关闭同步时删掉核心文件（best-effort，后台线程）。配置路径仍在，所以能定位删掉。
pub fn purge(app: AppHandle) {
    std::thread::spawn(move || {
        let dir = {
            let state = app.state::<AppState>();
            let conn = state.db.lock();
            match core_dir(&conn) {
                Some(d) => d,
                None => return, // 没配置过路径，无从删起
            }
        };
        let core = dir.join(CORE_FILE);
        match fs::remove_file(&core) {
            Ok(()) => log::info!("肃正协议·已删除核心文件"),
            Err(e) => log::info!("肃正协议·删除核心文件跳过（可能本就不存在）：{e}"),
        }
    });
}



