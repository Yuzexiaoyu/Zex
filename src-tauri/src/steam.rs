// Steam 库扫描/导入、封面与元数据抓取（Steam CDN / API / og:image）。
// 封面候选走 crate::games::sgdb_grids；归档守卫 crate::archive。
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use tauri::{Emitter, State};
use uuid::Uuid;
use crate::{archive, games};
use crate::{AppError, AppResult, AppState, Game, SteamGame};

// 自动检测 Steam 安装路径
pub(crate) fn detect_steam_path() -> AppResult<String> {
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
pub fn scan_steam_library(
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
pub(crate) fn find_steam_exe(game_path: &PathBuf, game_name: &str) -> String {
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
pub(crate) fn steam_library_dirs(steam_root: &Path) -> Vec<PathBuf> {
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
        if let Ok(options) = games::sgdb_grids(&client, key, &format!("steam/{}", app_id)).await {
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
    /// 商店名称：导入 Steam 游玩数据时给"库外时长"条目起名用；查不到 = 非商店条目
    name: Option<String>,
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
        name: data.get("name").and_then(|v| v.as_str()).map(String::from),
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
pub(crate) struct CoverFetchResult {
    total: usize,
    ok: usize,
    fail: usize,
}

// 手动触发（设置页按钮）：为所有缺封面/横幅的 Steam 游戏从 Steam CDN 下载补齐。
// 只处理 steam_appid 列 > 0 的游戏（旧数据兜底匹配 notes = "Steam AppID: {appid}"），
// 并发 8；每完成一个 emit "cover-fetch-progress" 事件刷新进度
#[tauri::command]
pub async fn fetch_all_steam_covers(app: tauri::AppHandle, state: State<'_, AppState>) -> AppResult<CoverFetchResult> {
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
pub async fn import_steam_games(state: State<'_, AppState>, steam_games: Vec<SteamGame>) -> AppResult<Vec<Game>> {
    let _operation = archive::OperationGuard::acquire(&state.archive_gate)?;
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
                    slot: -1, // 未定位：落进库里第一个空格
                    steam_appid: sg.app_id as i64,
                    rtss_profile_name: String::new(),
                    monitor_process: String::new(),
                    archive_status: String::new(),
                    archive_path: String::new(),
                    archive_size: 0,
                    archive_original_size: 0,
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
        // 「导入 Steam 游玩数据」早先为这个 appid 写过库外时长条目：并进来（取较大值）并删掉，
        // 否则统计页总时长会把同一段 Steam 时长算两次
        games::fold_archive_playtime(&conn, &game.id, job.app_id as i64);
        drop(conn);
        imported.push(game);
    }
    Ok(imported)
}

#[derive(Clone, Serialize)]
struct PlaytimeImportProgress {
    done: usize,
    total: usize,
    added: usize,
}

#[derive(Serialize)]
pub(crate) struct PlaytimeImportResult {
    /// localconfig 里有时长的 appid 数
    total: usize,
    /// 库里已有该 appid、按 Steam 时长校准过的
    updated: usize,
    /// 写进统计页「库外时长」条目的
    added: usize,
    /// 商店里查不到的条目（Spacewar / 运行库 / 下架）跳过数
    skipped: usize,
    /// 实际导入的时长合计（秒）
    seconds: i64,
}

/// 导入本机 Steam 的游玩数据（设置页按钮）。数据源是 localconfig.vdf 的 Playtime（多账号求和），
/// 覆盖"启动过"的全部 appid —— 包括已卸载、连 Steam 库里都看不到的那些。
///
/// - 库里已有同 appid → 校准 total_seconds（取较大值：绝不把用户自己记录的时长改小）
/// - 库里没有 → 写统计存档 stats_archive（key=game:app:<appid>、ext_id=appid）。
///   统计页的总时长/封面墙立刻算上它们；以后真把游戏导进库时，get_stats 的 game_gone 判定
///   与 games::absorb_orphan_stats 会自动接上这段历史，不会重复计。
///
/// 名称取 store 的 appdetails（顺带拿封面：600×900 竖版 + 官方短横头图），并发 8，每完成一个 emit 进度。
/// 商店查不到的 appid（Spacewar、运行库、下架条目）直接跳过并计入 skipped：宁可少算这点杂项时长，
/// 也不往统计封面墙里塞 "App 480" 这种空壳。
#[tauri::command]
pub async fn import_steam_playtime(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> AppResult<PlaytimeImportResult> {
    let steam_path = detect_steam_path()?;
    let mut jobs: Vec<(i64, i64)> = read_steam_playtimes(&steam_path)
        .into_iter()
        .filter(|(_, minutes)| *minutes > 0)
        .collect();
    jobs.sort_by_key(|(appid, _)| *appid);
    let total = jobs.len();

    // 库里已有该 appid：只校准时长，不写存档条目（否则统计页会出现同名两行）
    let known: std::collections::HashSet<i64> = {
        let conn = state.db.lock();
        let mut stmt = conn.prepare("SELECT steam_appid FROM games WHERE steam_appid > 0")?;
        let ids = stmt
            .query_map([], |r| r.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter().collect()
    };
    let (inside, outside): (Vec<(i64, i64)>, Vec<(i64, i64)>) =
        jobs.into_iter().partition(|(appid, _)| known.contains(appid));
    let updated = inside.len();
    let mut seconds = 0i64;
    for (appid, minutes) in &inside {
        let conn = state.db.lock();
        conn.execute(
            "UPDATE games SET total_seconds = MAX(total_seconds, ?1), updated_at = ?2 WHERE steam_appid = ?3",
            params![minutes * 60, Utc::now().to_rfc3339(), appid],
        )?;
        // 该 appid 若还留着「库外时长」存档行（上次导入或删除留下的），并进来并删掉 —— 避免双计
        let gid: Option<String> = conn
            .query_row("SELECT id FROM games WHERE steam_appid = ?1", [appid], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        if let Some(gid) = gid {
            games::fold_archive_playtime(&conn, &gid, *appid);
        }
        seconds += minutes * 60;
    }

    let job_total = outside.len();
    let data_dir = state.data_dir.clone();
    let db = state.db.clone();
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
        .filter(|s: &String| !s.trim().is_empty())
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;
    let sem = Arc::new(tokio::sync::Semaphore::new(8));
    let mut handles = Vec::with_capacity(outside.len());
    for (appid, minutes) in outside {
        let (sem_c, data_c, db_c, client_c, key_c) = (
            sem.clone(),
            data_dir.clone(),
            db.clone(),
            client.clone(),
            sgdb_key.clone(),
        );
        handles.push(tokio::spawn(async move {
            let _permit = sem_c.acquire_owned().await.ok()?;
            // 名称（顺带头图 URL）：查不到 = 非商店条目 → 返回 None 计入 skipped
            let assets = fetch_steam_api_assets(appid as u64, &client_c).await?;
            let name = assets.name.clone().unwrap_or_default();
            if name.trim().is_empty() {
                return None;
            }
            let covers_dir = data_c.join("covers");
            let _ = fs::create_dir_all(&covers_dir);
            let cover = download_steam_cover(
                appid as u64,
                covers_dir.clone(),
                client_c.clone(),
                key_c.as_deref(),
            )
            .await
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
            let wide = download_steam_banner(appid as u64, covers_dir, client_c)
                .await
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let conn = db_c.lock();
            // 幂等 upsert：重复导入不翻倍（取较大值），名称/封面只在这次拿到时覆盖
            conn.execute(
                "INSERT INTO stats_archive (key, media, name, sub, cover_path, wide_path, seconds, play_count, ext_id)
                 VALUES (?1, 'game', ?2, '', ?3, ?4, ?5, 0, ?6)
                 ON CONFLICT(key) DO UPDATE SET
                   name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE name END,
                   cover_path = CASE WHEN excluded.cover_path <> '' THEN excluded.cover_path ELSE cover_path END,
                   wide_path = CASE WHEN excluded.wide_path <> '' THEN excluded.wide_path ELSE wide_path END,
                   seconds = MAX(seconds, excluded.seconds)",
                params![
                    format!("game:app:{}", appid),
                    name,
                    cover,
                    wide,
                    minutes * 60,
                    appid
                ],
            )
            .ok()?;
            Some(minutes * 60)
        }));
    }

    let mut added = 0usize;
    let mut skipped = 0usize;
    let mut done = 0usize;
    for handle in handles {
        match handle.await.ok().flatten() {
            Some(secs) => {
                added += 1;
                seconds += secs;
            }
            None => skipped += 1,
        }
        done += 1;
        let _ = app.emit(
            "steam-playtime-progress",
            PlaytimeImportProgress { done, total: job_total, added },
        );
    }

    Ok(PlaytimeImportResult { total, updated, added, skipped, seconds })
}
