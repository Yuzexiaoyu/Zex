// 统计：游戏 / 影视 / 音乐三类的总时长、游玩数、封面墙 Top 列表
// （含 stats_archive 里已删除实体的续计；game_gone/video_gone/music_gone 用于去重）
use rusqlite::params;
use std::path::Path;
use tauri::State;
use crate::{AppError, AppResult, AppState, MediaStats, Stats, TopEntry};

/// 手动调整游戏累计时长（统计页右键「调整时长」）：直接覆盖 total_seconds，
/// 与播放会话结算共用同一字段，下次游玩增量照常累加。负数钳制为 0
#[tauri::command(async)]
pub fn set_game_seconds(state: State<'_, AppState>, id: String, seconds: i64) -> AppResult<()> {
    let seconds = seconds.max(0);
    let conn = state.db.lock();
    // 封面墙上已删除的游戏是统计存档条目（id 形如 "game:..."）：调时长改存档行；否则改 games 实体。
    let changed = if id.starts_with("game:") {
        conn.execute(
            "UPDATE stats_archive SET seconds = ?1 WHERE key = ?2 AND media = 'game'",
            params![seconds, id],
        )?
    } else {
        conn.execute(
            "UPDATE games SET total_seconds = ?1 WHERE id = ?2",
            params![seconds, id],
        )?
    };
    if changed == 0 {
        return Err(AppError::Custom("该游戏已被删除".to_string()));
    }
    Ok(())
}

/// 是不是用户手动设过的悬停封面：路径非空、文件还在、且不是 Steam 共享头图
/// （covers/banner_{appid}.jpg 与商店页 og 兜底 banner_{appid}_og.jpg，即 steam.rs
/// local_cover / download_steam_banner 落盘、banner_path 指向的那两个名字）。
/// 是 → 统计页封面墙显示用户那张；不是 → 交回下面的官方头图兜底
fn is_custom_banner(wide_path: &str, appid: i64) -> bool {
    if wide_path.is_empty() {
        return false;
    }
    let path = Path::new(wide_path);
    if !path.is_file() {
        return false;
    }
    let name = path.file_name().and_then(|f| f.to_str()).unwrap_or_default();
    !(name == format!("banner_{}.jpg", appid) || name == format!("banner_{}_og.jpg", appid))
}

/// 删掉统计页上的一条「库外」记录（stats_archive 行）—— 库里没有这个游戏、也没有它的归档
/// （归档游戏在库里，走的是游戏行），所以删除按钮只给这类行。封面文件留在 covers 目录不动：
/// 同一个 appid 以后真导进库里还能直接用。
#[tauri::command(async)]
pub fn delete_stats_entry(state: State<'_, AppState>, key: String) -> AppResult<()> {
    let conn = state.db.lock();
    let n = conn.execute(
        "DELETE FROM stats_archive WHERE key = ?1 AND media = 'game'",
        [&key],
    )?;
    if n == 0 {
        return Err(AppError::Custom("这条记录已不存在".to_string()));
    }
    Ok(())
}

#[tauri::command(async)]
pub fn get_stats(state: State<'_, AppState>) -> AppResult<Stats> {
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

    // 封面墙上限：三列统一 500 条。列内不是虚拟滚动（逐行挂 DOM + 图片），
    // 需要个兜底量；60 条太少——导入 Steam 游玩数据后游戏列会一次多出上百条库外时长，
    // 截断看起来就是「条目缺了」
    const WALL_LIMIT: i64 = 500;

    // 「已不在库」判定：某条统计存档对应的实体是否已从库中删除。Steam/tmdb 用 ext_id 认作品，
    // 其余用存档 key 里的实体 id。仍在库的存档条目从封面墙/游玩数里排除，避免与实体重复计。
    // 总时长不需要排除：存档存的是删除那刻的历史值，重装后的实体行从 0 起累加，两者相加不重复。
    let game_gone = "NOT EXISTS (SELECT 1 FROM games g WHERE (a.ext_id > 0 AND g.steam_appid = a.ext_id) OR (a.ext_id = 0 AND a.key = 'game:id:' || g.id))";
    let video_gone = "NOT EXISTS (SELECT 1 FROM series s WHERE (a.ext_id > 0 AND s.tmdb_id = a.ext_id) OR (a.ext_id = 0 AND a.key = 'video:id:' || s.id))";
    let music_gone = "NOT EXISTS (SELECT 1 FROM tracks t WHERE a.key = 'music:id:' || t.id)";

    // ── 游戏：只统计时长（次数只留给音乐）。删除的游戏由 stats_archive 续上，只加不删 ──
    let game = MediaStats {
        total_seconds: scalar(
            "SELECT (SELECT COALESCE(SUM(total_seconds), 0) FROM games)
                  + (SELECT COALESCE(SUM(seconds), 0) FROM stats_archive WHERE media = 'game')",
        ),
        play_count: 0,
        library_count: scalar("SELECT COUNT(*) FROM games WHERE hidden = 0"),
        played_count: scalar(&format!(
            "SELECT (SELECT COUNT(*) FROM games WHERE hidden = 0 AND total_seconds > 0)
                  + (SELECT COUNT(*) FROM stats_archive a WHERE a.media = 'game' AND a.seconds > 0 AND {game_gone})",
        )),
        // Steam 游戏统一显示 Steam 短横封面（官方 header 460×215，即 banner_{appid}.jpg）：
        // 优先取本地已下载的该文件；没有时回退 banner_path（可能是手动设置的图）。
        // 未玩过的（total_seconds = 0）实体也进列表（DESC 沉底，前端显示「未游玩」）；
        // 已删除的游戏取自 stats_archive（只收有时长的），与实体合并后统一按时长排名。
        top: {
            let covers_dir = state.data_dir.join("covers");
            let mut stmt = conn.prepare(&format!(
                "SELECT id, name, sub, cover_path, wide_path, seconds, count, ext_id FROM (
                     SELECT g.id AS id, g.name AS name, '' AS sub, g.cover_path AS cover_path,
                            g.banner_path AS wide_path, g.total_seconds AS seconds, 0 AS count,
                            g.steam_appid AS ext_id
                     FROM games g WHERE g.hidden = 0
                     UNION ALL
                     SELECT a.key, a.name, a.sub, a.cover_path, a.wide_path, a.seconds, a.play_count, a.ext_id
                     FROM stats_archive a
                     WHERE a.media = 'game' AND a.seconds > 0 AND {game_gone}
                 ) ORDER BY seconds DESC LIMIT {WALL_LIMIT}",
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
                    // 手动换过悬停封面的优先：统计页也和游戏库一样能换这张图，
                    // 若被官方头图盖掉，换完在当前页面看不出任何变化
                    if appid > 0 && !is_custom_banner(&e.wide_path, appid) {
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
        total_seconds: scalar(&format!(
            "SELECT (SELECT COALESCE(SUM({}), 0) FROM series s)
                  + (SELECT COALESCE(SUM(seconds), 0) FROM stats_archive WHERE media = 'video')",
            video_dur_secs("s"),
        )),
        play_count: 0,
        library_count: scalar("SELECT COUNT(*) FROM series"),
        played_count: scalar(&format!(
            "SELECT (SELECT COUNT(*) FROM series s WHERE {} > 0)
                  + (SELECT COUNT(*) FROM stats_archive a WHERE a.media = 'video' AND a.seconds > 0 AND {video_gone})",
            video_dur_secs("s"),
        )),
        // sub 显示「已看 X/Y 集」：两个相关子查询各数一次 episodes。已删除的剧取自 stats_archive
        // （时长按删除时刻快照、sub 用当时的已看/总集数），与在库的剧合并后按时长排名。
        top: top_of(&format!(
            "SELECT id, name, sub, cover_path, wide_path, seconds, count FROM (
                 SELECT s.id AS id, s.title AS name,
                        '已看 ' || (SELECT COUNT(*) FROM episodes e WHERE e.series_id = s.id AND e.watched = 1)
                                || '/' || (SELECT COUNT(*) FROM episodes e2 WHERE e2.series_id = s.id) || ' 集' AS sub,
                        s.poster_path AS cover_path, s.bg_path AS wide_path, {dur} AS seconds, 0 AS count
                 FROM series s WHERE {dur} > 0
                 UNION ALL
                 SELECT a.key, a.name, a.sub, a.cover_path, a.wide_path, a.seconds, a.play_count
                 FROM stats_archive a WHERE a.media = 'video' AND a.seconds > 0 AND {video_gone}
             ) ORDER BY seconds DESC LIMIT {WALL_LIMIT}",
            dur = video_dur_secs("s"),
        )),
    };

    // ── 音乐：时长 + 播放次数（次数由 mpv.rs 开播时写 tracks.play_count）。
    //    删除的曲目由 stats_archive 续上时长与次数，只加不删 ──
    let music = MediaStats {
        total_seconds: scalar(
            "SELECT (SELECT COALESCE(SUM(total_seconds), 0) FROM tracks)
                  + (SELECT COALESCE(SUM(seconds), 0) FROM stats_archive WHERE media = 'music')",
        ),
        play_count: scalar(
            "SELECT (SELECT COALESCE(SUM(play_count), 0) FROM tracks)
                  + (SELECT COALESCE(SUM(play_count), 0) FROM stats_archive WHERE media = 'music')",
        ),
        library_count: scalar("SELECT COUNT(*) FROM tracks"),
        played_count: scalar(&format!(
            "SELECT (SELECT COUNT(*) FROM tracks WHERE total_seconds > 0)
                  + (SELECT COUNT(*) FROM stats_archive a WHERE a.media = 'music' AND a.seconds > 0 AND {music_gone})",
        )),
        top: top_of(&format!(
            "SELECT id, name, sub, cover_path, wide_path, seconds, count FROM (
                 SELECT t.id AS id, t.title AS name, t.artist AS sub, t.cover_path AS cover_path,
                        '' AS wide_path, t.total_seconds AS seconds, t.play_count AS count
                 FROM tracks t WHERE t.total_seconds > 0
                 UNION ALL
                 SELECT a.key, a.name, a.sub, a.cover_path, a.wide_path, a.seconds, a.play_count
                 FROM stats_archive a WHERE a.media = 'music' AND a.seconds > 0 AND {music_gone}
             ) ORDER BY seconds DESC LIMIT {WALL_LIMIT}",
        )),
    };

    Ok(Stats {
        game,
        video,
        music,
        // 集数统计同样续上已删除的剧（快照，排除仍在库的以免重复）
        total_episodes: scalar(&format!(
            "SELECT (SELECT COUNT(*) FROM episodes)
                  + (SELECT COALESCE(SUM(episodes), 0) FROM stats_archive a WHERE a.media = 'video' AND {video_gone})",
        )),
        total_watched_episodes: scalar(&format!(
            "SELECT (SELECT COUNT(*) FROM episodes WHERE watched = 1)
                  + (SELECT COALESCE(SUM(watched_episodes), 0) FROM stats_archive a WHERE a.media = 'video' AND {video_gone})",
        )),
    })
}
