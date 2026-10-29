// TMDB 刮削（剧集/电影元数据、精确到集的封面下载）+ 封面搜索（SteamGridDB / Steam CDN / TMDB）。
// JPEG 基线化走 crate::music::{is_progressive_jpeg, to_baseline_jpeg}。
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};
use uuid::Uuid;
use crate::music;
use crate::{AppError, AppResult, AppState, CoverSearchResult};

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

// 生成搜索候选：原标题 + 去脏标题（文件夹名常带 SxxExx / 第N季 / 年份 后缀）
fn search_candidates(title: &str) -> Vec<String> {
    let mut candidates = vec![title.trim().to_string()];
    let cleaned = clean_search_title(title);
    if !cleaned.is_empty() && cleaned != title.trim() {
        candidates.push(cleaned);
    }
    candidates
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
    pub media_type: String, // "tv" / "movie"：混合搜索命中另一类型时，前端据此修正条目类型
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
    #[serde(default)] // /search/multi 每项自带类型；tv/movie 专用端点没有该字段
    media_type: Option<String>,
}

#[derive(Deserialize)]
struct TmdbMultiResponse {
    results: Vec<TmdbMultiItem>,
}

// 候选结果项统一映射。/search/multi 会混入 person 等条目 → 只保留 tv/movie（其余丢弃）；
// tv/movie 专用端点没有 media_type 字段 → 用调用方传入的类型
fn multi_item_to_result(it: TmdbMultiItem, fallback_kind: &str) -> Option<TmdbSearchResult> {
    let media_type = match it.media_type.as_deref() {
        Some(t @ ("tv" | "movie")) => t.to_string(),
        None => fallback_kind.to_string(),
        _ => return None,
    };
    Some(TmdbSearchResult {
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
        media_type,
    })
}

// 请求一个搜索端点并映射结果；非 2xx / 解析失败 / 空结果一律 None（调用方继续下一种尝试）
async fn tmdb_search_endpoint(
    client: &reqwest::Client,
    url: String,
    fallback_kind: &str,
) -> Option<Vec<TmdbSearchResult>> {
    let resp = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return None,
    };
    let parsed: TmdbMultiResponse = match resp.json().await {
        Ok(p) => p,
        Err(_) => return None,
    };
    if parsed.results.is_empty() {
        return None;
    }
    Some(
        parsed
            .results
            .into_iter()
            .filter_map(|it| multi_item_to_result(it, fallback_kind))
            .take(12)
            .collect(),
    )
}

// 搜索 TMDB：返回候选列表供前端选择。先按条目类型的专用端点搜（中文无结果回退英文），
// 都没有再用 /search/multi 混合兜底——条目类型标错时（如电影被当成剧集录入）也能命中，
// 命中项自带 media_type，前端选中后据此修正条目类型
#[tauri::command]
pub async fn search_tmdb(
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

    let queries = search_candidates(&query);

    // 第一轮：按条目类型的专用端点（相关性最好）
    for q in &queries {
        if q.is_empty() {
            continue;
        }
        for lang in ["zh-CN", "en-US"] {
            let url = format!(
                "https://api.tmdb.org/3/search/{}?query={}&api_key={}&language={}",
                kind,
                urlencoding::encode(q),
                key,
                lang
            );
            if let Some(list) = tmdb_search_endpoint(&client, url, kind).await {
                return Ok(list);
            }
        }
    }
    // 第二轮：混合搜索兜底（跨类型）
    for q in &queries {
        if q.is_empty() {
            continue;
        }
        for lang in ["zh-CN", "en-US"] {
            let url = format!(
                "https://api.tmdb.org/3/search/multi?query={}&api_key={}&language={}",
                urlencoding::encode(q),
                key,
                lang
            );
            if let Some(list) = tmdb_search_endpoint(&client, url, kind).await {
                return Ok(list);
            }
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

// 搜索电影：中文未命中回退英文；命中返回第一条的 id
async fn tmdb_search_movie(
    client: &reqwest::Client,
    key: &str,
    query: &str,
) -> AppResult<Option<i64>> {
    for lang in ["zh-CN", "en-US"] {
        let url = format!(
            "https://api.tmdb.org/3/search/movie?query={}&api_key={}&language={}",
            urlencoding::encode(query),
            key,
            lang
        );
        let resp = match client.get(&url).send().await {
            Ok(r) => r,
            Err(_) => continue, // 网络错误也尝试下一个
        };
        if !resp.status().is_success() {
            continue;
        }
        let parsed: TmdbMultiResponse = match resp.json().await {
            Ok(p) => p,
            Err(_) => continue,
        };
        if let Some(item) = parsed.results.into_iter().next() {
            return Ok(Some(item.id));
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
    // TMDB 部分图是 progressive JPEG（多遍扫描），WebView 在带进场动画的全幅背景图上
    // 反复光栅化时每次都要重解码，比 baseline 贵得多 → 详情页「上下翻页卡」。落盘前统一
    // 转成 baseline；只动 progressive 的，baseline / PNG 原样写，不做无谓的二次压缩。
    if music::is_progressive_jpeg(&bytes) {
        if let Some(baseline) = music::to_baseline_jpeg(&bytes) {
            return fs::write(target, &baseline).ok();
        }
    }
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
pub async fn auto_fetch_series_metadata(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    series_id: String,
    tmdb_id: Option<i64>,
    media_type: Option<String>, // 候选列表选中项的实际类型：与库里不同时按它抓取并修正条目
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

    let (db_media_type, title, stored_tmdb_id): (String, String, i64) = {
        let conn = state.db.lock();
        conn.query_row(
            "SELECT COALESCE(NULLIF(media_type, ''), 'tv'), title, tmdb_id FROM series WHERE id = ?1",
            params![series_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?
    };

    // 抓取类型：候选列表选定的实际类型 > 库里已有类型
    let kind = match media_type.as_deref() {
        Some(m) if m == "movie" || m == "tv" => m,
        _ => db_media_type.as_str(),
    };

    let result = if kind == "movie" {
        auto_fetch_movie_metadata_inner(&state.db, &state.data_dir, &series_id, tmdb_id, Some(&app)).await
    } else if tmdb_id.filter(|v| *v > 0).is_some() || stored_tmdb_id > 0 {
        // 已有明确 TMDB id（用户选定或此前匹配过）：就是剧集，直接抓
        auto_fetch_series_metadata_inner(&state.db, &state.data_dir, &series_id, tmdb_id, Some(&app)).await
    } else {
        // 没有 id：先按剧集搜，搜不到再按电影搜——电影被误录成剧集时自动兜底
        resolve_and_fetch(&state.db, &state.data_dir, &series_id, &title, Some(&app)).await
    };

    // 混合搜索命中了另一类型：抓取成功才把 media_type 修正落库，下次直接走对的端点；失败不动
    if result.is_ok() && kind != db_media_type.as_str() {
        let conn = state.db.lock();
        conn.execute(
            "UPDATE series SET media_type = ?1 WHERE id = ?2",
            params![kind, series_id],
        )?;
    }
    result
}

// 无明确 TMDB id 时的混合解析：先按剧集搜，未命中再按电影搜，各自命中后走对应抓取流程
async fn resolve_and_fetch(
    db: &Mutex<Connection>,
    data_dir: &Path,
    series_id: &str,
    title: &str,
    app: Option<&tauri::AppHandle>,
) -> AppResult<String> {
    let key: String = {
        let conn = db.lock();
        conn.query_row("SELECT value FROM settings WHERE key = 'tmdb_api_key'", [], |r| r.get(0))
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

    for cand in search_candidates(title) {
        if let Some(item) = tmdb_search_tv(&client, &key, &cand).await? {
            return auto_fetch_series_metadata_inner(db, data_dir, series_id, Some(item.id), app).await;
        }
    }
    for cand in search_candidates(title) {
        if let Some(id) = tmdb_search_movie(&client, &key, &cand).await? {
            return auto_fetch_movie_metadata_inner(db, data_dir, series_id, Some(id), app).await;
        }
    }
    Err(AppError::Custom(format!("未找到匹配影视：{}", title)))
}

pub(crate) async fn auto_fetch_series_metadata_inner(
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
        let candidates = search_candidates(&title);
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
        let mut found: Option<i64> = None;
        for cand in search_candidates(&title) {
            if let Some(id) = tmdb_search_movie(&client, &key, &cand).await? {
                found = Some(id);
                break;
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
pub async fn search_covers(query: String, source: String) -> AppResult<Vec<CoverSearchResult>> {
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
pub async fn download_cover(state: State<'_, AppState>, url: String, game_id: String) -> AppResult<String> {
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

/// 自定义品牌封面（设置页「软件标识」）：把本地图片复制进 covers 目录
/// （固定名 brand.<ext>，替换时清掉旧的 brand.*，不残留），返回存储路径。
/// 前端 convertFileSrc('covers') 直接可显示；格式 png/jpg/webp，上限 10MB
#[tauri::command(async)]
pub fn set_brand_cover(state: State<'_, AppState>, source: String) -> AppResult<String> {
    let src = std::path::Path::new(&source);
    if !src.is_file() {
        return Err(AppError::Custom("图片文件不存在".into()));
    }
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        return Err(AppError::Custom("仅支持 png / jpg / webp 图片".into()));
    }
    if src.metadata().map(|m| m.len() > 10 * 1024 * 1024).unwrap_or(false) {
        return Err(AppError::Custom("图片不能超过 10MB".into()));
    }
    let covers_dir = state.data_dir.join("covers");
    fs::create_dir_all(&covers_dir)?;
    // 清掉旧品牌图（用户可能换过扩展名），再写新文件
    if let Ok(entries) = fs::read_dir(&covers_dir) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with("brand.") {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    let target = covers_dir.join(format!("brand.{}", ext));
    fs::copy(src, &target)?;
    Ok(target.to_string_lossy().to_string())
}
