// 影视库：剧集/季/集 CRUD、观看进度、首页聚合查询（Hero / 卡片进度 / 详情页）。
// 统计存档走 crate::games::archive_stats_entry；播放列表元数据刷新走 crate::mpv。
use std::collections::HashMap;
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;
use crate::{games, mpv};
use crate::{AppError, AppResult, AppState, Episode, Season, Series,
    EPISODE_COLS, SEASON_COLS, SERIES_COLS, SERIES_ORDER,
    default_media_type, row_to_episode, row_to_season, row_to_series};

#[tauri::command(async)]
pub fn get_all_series(state: State<'_, AppState>) -> AppResult<Vec<Series>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(&format!("SELECT {} FROM series {}", SERIES_COLS, SERIES_ORDER))?;
    let rows = stmt.query_map([], |row| row_to_series(row))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

#[tauri::command(async)]
pub fn create_series(state: State<'_, AppState>, mut series: Series) -> AppResult<Series> {
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
pub fn update_series(state: State<'_, AppState>, series: Series) -> AppResult<Series> {
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
pub fn reorder_series(state: State<'_, AppState>, ordered_ids: Vec<String>) -> AppResult<()> {
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
pub fn set_series_favorite(state: State<'_, AppState>, series_id: String, favorite: bool) -> AppResult<()> {
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
pub fn delete_series(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock();
    // 删除前存档统计：时长口径与 get_stats 完全一致（电影取 total_seconds，剧集按集算——
    // 看完的按完整时长，没看完的按实际进度），并快照集数/已看集数保住顶部「共X集/已看Y集」。
    // 有 tmdb 的按 tmdb 合并（同一作品重复导入删除时累积），否则按 id。
    if let Ok((title, poster, bg, tmdb, secs, eps, watched_eps)) = conn.query_row(
        "SELECT s.title, s.poster_path, s.bg_path, s.tmdb_id,
                CASE WHEN s.media_type = 'movie' THEN s.total_seconds
                     ELSE (SELECT COALESCE(SUM(
                         CASE WHEN e.watched = 1 THEN e.runtime_minutes * 60
                              ELSE e.watched_ms / 1000 END
                     ), 0) FROM episodes e WHERE e.series_id = s.id) END,
                (SELECT COUNT(*) FROM episodes e WHERE e.series_id = s.id),
                (SELECT COUNT(*) FROM episodes e WHERE e.series_id = s.id AND e.watched = 1)
         FROM series s WHERE s.id = ?1",
        [&id],
        |r| Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, i64>(6)?,
        )),
    ) {
        let key = if tmdb > 0 { format!("video:tmdb:{tmdb}") } else { format!("video:id:{id}") };
        let sub = format!("已看 {watched_eps}/{eps} 集");
        games::archive_stats_entry(&conn, &key, "video", &title, &sub, &poster, &bg, secs, 0, tmdb, eps, watched_eps);
    }
    conn.execute("DELETE FROM series WHERE id = ?", [&id])?;
    Ok(())
}

#[tauri::command(async)]
pub fn get_seasons(state: State<'_, AppState>, series_id: String) -> AppResult<Vec<Season>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM seasons WHERE series_id = ? ORDER BY season_number",
        SEASON_COLS
    ))?;
    let rows = stmt.query_map([&series_id], |row| row_to_season(row))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

#[tauri::command(async)]
pub fn create_season(state: State<'_, AppState>, mut season: Season) -> AppResult<Season> {
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
pub fn delete_season(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM seasons WHERE id = ?", [&id])?;
    Ok(())
}

#[tauri::command(async)]
pub fn get_episodes(state: State<'_, AppState>, season_id: String) -> AppResult<Vec<Episode>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM episodes WHERE season_id = ? ORDER BY episode_number",
        EPISODE_COLS
    ))?;
    let rows = stmt.query_map([&season_id], |row| row_to_episode(row))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

#[tauri::command(async)]
pub fn create_episode(state: State<'_, AppState>, mut episode: Episode) -> AppResult<Episode> {
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
pub fn update_episode(state: State<'_, AppState>, episode: Episode) -> AppResult<Episode> {
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
pub fn delete_episode(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM episodes WHERE id = ?", &[&id])?;
    Ok(())
}

#[tauri::command(async)]
pub fn update_watch_progress(state: State<'_, AppState>, episode_id: String, watched_ms: i64) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute(
        "UPDATE episodes SET watched_ms = ?, last_watched_at = datetime('now') WHERE id = ?",
        params![watched_ms, episode_id],
    )?;
    Ok(())
}

#[tauri::command(async)]
pub fn mark_episode_watched(app: tauri::AppHandle, state: State<'_, AppState>, episode_id: String, watched: bool) -> AppResult<()> {
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
    crate::sync::sync(app); // 肃正协议：标记看完即时对账
    Ok(())
}

// 整季批量标记已看/未看（详情页季操作）
#[tauri::command(async)]
pub fn mark_season_watched(app: tauri::AppHandle, state: State<'_, AppState>, season_id: String, watched: bool) -> AppResult<()> {
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
    crate::sync::sync(app); // 肃正协议：整季标记后即时对账
    Ok(())
}

// 播放某一集：记录观看时间（用于「继续观看」排序），不改变已看标记
#[tauri::command(async)]
pub fn touch_episode_played(state: State<'_, AppState>, episode_id: String) -> AppResult<()> {
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
pub(crate) fn query_next_episodes(conn: &Connection) -> AppResult<HashMap<String, NextEpisode>> {
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
pub fn get_series_library(state: State<'_, AppState>) -> AppResult<Vec<SeriesCard>> {
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
pub fn get_series_detail(state: State<'_, AppState>, series_id: String) -> AppResult<SeriesDetailData> {
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
