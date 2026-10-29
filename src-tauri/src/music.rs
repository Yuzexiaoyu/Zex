// 音乐库：扫描/导入、封面抽取与压缩（image/lofty）、歌词、歌单，
// 以及 covers:// 协议文件服务。统计存档走 crate::games::archive_stats_entry。
use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};
use chrono::Utc;
use percent_encoding::percent_decode_str;
use rusqlite::{params, OptionalExtension};
use tauri::http::Response;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;
use crate::games;
use crate::{AppError, AppResult, AppState, Playlist, Track, TrackPreview, TRACK_COLS, row_to_track};

// 音频扩展名（lofty 0.24 全格式内置；wma/mp4 不做，避免把视频误当音乐）
const MUSIC_EXTS: &[&str] = &["mp3", "flac", "wav", "ogg", "opus", "m4a", "aac", "ape", "aiff", "mpc", "wv"];

// 解析单个音频文件的内嵌标签 → TrackPreview（title 缺失时用文件名兜底，不落库）
fn parse_audio_tags(path: &Path) -> Option<TrackPreview> {
    use lofty::file::{AudioFile, TaggedFileExt};
    use lofty::prelude::Accessor;
    use lofty::probe::Probe;

    let tagged = Probe::open(path).ok()?.read().ok()?;
    let props = tagged.properties();
    let duration = props.duration().as_secs() as i32;
    // 比特率：优先实际音频码率（VBR 也准）；部分格式（如 FLAC）audio_bitrate 缺失，
    // 退到整体码率 / 平均码率（文件大小 ×8 ÷ 时长）兜底。
    // 注意 lofty 的 audio_bitrate/overall_bitrate 单位已是 kbps，不要再除 1000
    // （曾误除 1000：320kbps → 0 不显示、1411kbps FLAC → 显示 1 kbps）
    let mut bitrate = props
        .audio_bitrate()
        .or_else(|| props.overall_bitrate())
        .map(|b| b as i32)
        .unwrap_or(0);
    if bitrate <= 0 {
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if duration > 0 && size > 0 {
            bitrate = ((size * 8) / (duration as u64 * 1000)) as i32;
        }
    }

    let mut title = String::new();
    let mut artist = String::new();
    let mut album = String::new();
    let mut album_artist = String::new();
    let mut track_number = 0i32;
    let mut disc_number = 0i32;

    // primary_tag 拿第一个内嵌标签；无 primary 时退到 tags 列表（如纯 VorbisComments）
    let tag = tagged.primary_tag().or_else(|| tagged.tags().first());
    if let Some(tag) = tag {
        if let Some(v) = tag.title() { title = v.to_string(); }
        if let Some(v) = tag.artist() { artist = v.to_string(); }
        if let Some(v) = tag.album() { album = v.to_string(); }
        // album_artist 不在 Accessor 里，需按 ItemKey 取文本
        if let Some(v) = tag.get_string(lofty::tag::ItemKey::AlbumArtist) { album_artist = v.to_string(); }
        if let Some(v) = tag.track() { track_number = v as i32; }
        if let Some(v) = tag.disk() { disc_number = v as i32; }
    }

    if title.trim().is_empty() {
        title = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "未知曲目".to_string());
    }

    Some(TrackPreview {
        file_path: path.to_string_lossy().to_string(),
        title,
        artist,
        album,
        album_artist,
        track_number,
        disc_number,
        duration_seconds: duration,
        bitrate,
        cover_path: String::new(),
        already_exists: false,
    })
}

// 音乐封面在 ZEX 里最大只显示到 48×48（播放条），列表行 44×44，托盘更小。而内嵌
// 专辑图常是 1600²~1920² 的 5~8MB PNG —— 原样落盘等于让 WebView 为一个 44px 的框
// 解码 15MB 位图（1920×1920×4），虚拟滚动下行反复挂载就要反复解，这是滚动时封面
// 闪的根因。统一压到 256px（48px 的 5 倍余量，足够 HiDPI）
const MUSIC_COVER_MAX: u32 = 256;

// 已解码的图 → ≤256px 的 JPEG 字节。缩放用 thumbnail 而非 resize+Lanczos3：
// 大比例缩小下两者肉眼无差，但 thumbnail 的快速整数算法在 1920² 上快一个量级
// （迁移几百张时是几十秒的差别）
fn encode_cover_jpeg(img: &image::DynamicImage) -> Option<Vec<u8>> {
    use image::codecs::jpeg::JpegEncoder;
    use image::{ExtendedColorType, ImageEncoder};

    let scaled = if img.width() > MUSIC_COVER_MAX || img.height() > MUSIC_COVER_MAX {
        img.thumbnail(MUSIC_COVER_MAX, MUSIC_COVER_MAX) // 等比缩放到框内
    } else {
        img.clone()
    };
    // JPEG 没有 alpha 通道，带透明的图会丢掉透明度（专辑图里极罕见，接受）
    let rgb = scaled.to_rgb8();
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 88)
        .write_image(rgb.as_raw(), rgb.width(), rgb.height(), ExtendedColorType::Rgb8)
        .ok()?;
    Some(out)
}

// 扫 JPEG 段标记判断是否 progressive（多遍扫描）：SOF2=0xC2 即 progressive，
// SOF0/1/3 为 baseline。不解码、只走段头，微秒级。非 JPEG（PNG 魔数等）一律 false。
// covers 里有些 .jpg 实为 PNG（SGDB 兜底，见 serve_covers_file），FFD8 判头天然放过。
pub(crate) fn is_progressive_jpeg(b: &[u8]) -> bool {
    if b.len() < 4 || b[0] != 0xFF || b[1] != 0xD8 {
        return false; // 不是 JPEG（SOI=FFD8）
    }
    let mut i = 2;
    while i + 1 < b.len() {
        if b[i] != 0xFF {
            i += 1;
            continue;
        }
        // 跳过填充的连续 0xFF，定位真正的段标记
        let mut j = i + 1;
        while j < b.len() && b[j] == 0xFF {
            j += 1;
        }
        if j >= b.len() {
            return false;
        }
        let marker = b[j];
        match marker {
            0xC2 => return true,                // SOF2 progressive
            0xC0 | 0xC1 | 0xC3 => return false, // SOF0/1/3 baseline/lossless
            0xDA => return false,               // SOS：进入压缩数据，之前没见 SOF2
            0xD8 | 0xD9 => i = j + 1,            // SOI/EOI 无长度字段
            0xD0..=0xD7 => i = j + 1,           // RSTn 无长度字段
            _ => {
                // 其余段带 2 字节长度（含自身）
                if j + 2 >= b.len() {
                    return false;
                }
                let len = ((b[j + 1] as usize) << 8) | (b[j + 2] as usize);
                if len < 2 {
                    return false;
                }
                i = j + 1 + len;
            }
        }
    }
    false
}

// 原样尺寸重编码为 baseline JPEG（q90，不缩放——剧集背景/海报/剧照要保留分辨率）。
// 解码失败返回 None，调用方退回原字节。与 encode_cover_jpeg 的区别：那个专供音乐封面、
// 会缩到 256px；这里只改扫描方式不动尺寸。image crate 的 JpegEncoder 只出 baseline。
pub(crate) fn to_baseline_jpeg(bytes: &[u8]) -> Option<Vec<u8>> {
    use image::codecs::jpeg::JpegEncoder;
    use image::{ExtendedColorType, ImageEncoder};

    let img = image::load_from_memory(bytes).ok()?;
    let rgb = img.to_rgb8(); // JPEG 无 alpha，TMDB 图本就无透明
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 90)
        .write_image(rgb.as_raw(), rgb.width(), rgb.height(), ExtendedColorType::Rgb8)
        .ok()?;
    Some(out)
}

// 把封面字节压成 ≤256px 的 JPEG。解码/编码任一步失败返回 None，调用方退回原字节
fn shrink_cover(bytes: &[u8]) -> Option<Vec<u8>> {
    encode_cover_jpeg(&image::load_from_memory(bytes).ok()?)
}

// 把内嵌封面提取为 data/covers/music_<track_id>.jpg（失败返回空串，不影响入库）
fn extract_track_cover(data_dir: &Path, file_path: &Path, track_id: &str) -> String {
    use lofty::file::TaggedFileExt;
    use lofty::probe::Probe;

    let Ok(tagged) = Probe::open(file_path).and_then(|p| p.read()) else {
        return String::new();
    };
    let Some(pic) = tagged.primary_tag().and_then(|t| t.pictures().first()) else {
        return String::new();
    };
    // 正常路径写压缩后的 JPEG；只有解码失败（畸形/罕见格式）才退回原字节 + 原扩展名
    let (bytes, ext): (Cow<'_, [u8]>, &str) = match shrink_cover(pic.data()) {
        Some(jpg) => (Cow::Owned(jpg), "jpg"),
        None => (
            Cow::Borrowed(pic.data()),
            match pic.mime_type().map(|m| m.as_str()) {
                Some("image/png") => "png",
                _ => "jpg",
            },
        ),
    };
    let covers_dir = data_dir.join("covers");
    if fs::create_dir_all(&covers_dir).is_err() {
        return String::new();
    }
    let dest = covers_dir.join(format!("music_{}.{}", track_id, ext));
    if fs::write(&dest, &bytes).is_ok() {
        dest.to_string_lossy().to_string()
    } else {
        String::new()
    }
}

// 存量封面降级：早期版本把内嵌专辑图原样落盘（实测 519 张共 254MB，单张 1600²~1920²），
// 音乐库滚动时 WebView 反复解大图 → 封面闪。一次性压成 256px JPEG。
//
// 标志位范式抄 rtss::migrate_profile_model：settings 表存一行，成功才落标志位，
// 有失败就不落、下次启动重试。走 tracks 表驱动，covers/ 里的孤儿图（delete_track
// 只删库行不删文件）天然不碰
pub(crate) fn migrate_music_covers(app: &AppHandle, state: &AppState) {
    // v1 用文件体积判「已是小图」，漏掉了 73 张 500~800px 但压得很小的图；v2 改按像素判；
    // v3 追加孤儿封面清理（delete_track 只删库行不删文件，历年积累了几百个孤儿）
    const FLAG: &str = "music_cover_thumbs_v3";

    // 读标志位 + 取任务清单，锁只在这一段里握着 —— 解码/编码是重活，绝不能跨锁
    let jobs: Vec<(String, String)> = {
        let conn = state.db.lock();
        let done: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = ?", [FLAG], |r| r.get(0))
            .ok();
        if done.is_some() {
            return;
        }
        let Ok(mut stmt) = conn.prepare("SELECT id, cover_path FROM tracks WHERE cover_path <> ''")
        else {
            return;
        };
        let Ok(rows) = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))) else {
            return;
        };
        rows.filter_map(|r| r.ok()).collect()
    };

    let mut changed = 0usize;
    let mut failed = 0usize;
    for (id, old_path) in &jobs {
        let old = Path::new(old_path);
        if !old.exists() {
            continue; // 文件已不在（用户清过 covers/），没什么可修的
        }
        let Ok(bytes) = fs::read(old) else {
            failed += 1;
            continue;
        };
        // 「已经是小图」按像素判，不按体积。解码成本是像素数（800² 就是 2.6MB 位图），
        // 而 PNG 对纯色/平涂专辑图压得极狠 —— 实测有 800px 的图只占 196KB、
        // 720px 的只占 74KB，用体积阈值会把它们全放过去
        let Some(img) = image::load_from_memory(&bytes).ok() else {
            log::warn!("封面降级失败（无法解码）：{}", old_path);
            failed += 1;
            continue;
        };
        if img.width() <= MUSIC_COVER_MAX && img.height() <= MUSIC_COVER_MAX {
            continue; // 新导入的，或上一轮迁移处理过的
        }
        let Some(jpg) = encode_cover_jpeg(&img) else {
            log::warn!("封面降级失败（无法重编码）：{}", old_path);
            failed += 1;
            continue;
        };
        let new_path = old.with_extension("jpg");
        if let Err(e) = fs::write(&new_path, &jpg) {
            log::warn!("封面降级写入失败 {}：{}", new_path.display(), e);
            failed += 1;
            continue;
        }
        // 先落库再删旧文件。反过来的话，进程在两步之间被杀（用户关窗/taskkill）会留下
        // 指向已删文件的 cover_path —— 那张封面就永远是空框了。反着来最坏只是留个孤儿文件。
        // updated_at 是前端 ?v= 的缓存键（见 utils/media.ts coverSrc），必须一起 bump，
        // 否则 WebView 拿着强缓存里的旧大图不放
        let conn = state.db.lock();
        let updated = conn.execute(
            "UPDATE tracks SET cover_path = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_path.to_string_lossy().to_string(), Utc::now().to_rfc3339(), id],
        );
        drop(conn);
        if let Err(e) = updated {
            log::warn!("封面降级落库失败 {}：{}", id, e);
            let _ = fs::remove_file(&new_path); // 库没改成，新文件是垃圾，撤掉
            failed += 1;
            continue;
        }
        // 扩展名变了（.png → .jpg）：原文件是纯派生物，源音频还在盘上，删掉不丢数据
        if new_path != old {
            let _ = fs::remove_file(old);
        }
        changed += 1;
        // 分批通知前端重拉曲目。旧的 .png 是当场删的 —— 前端还拿着旧 cover_path 时
        // covers 协议会 404，那一格就是空框。攒够一批就让前端换成新路径，把这个
        // 窗口压到一两秒，而不是等整轮几十秒跑完
        if changed % 40 == 0 {
            log::info!("音乐封面降级进度：{}/{}", changed, jobs.len());
            let _ = app.emit("music-covers-migrated", changed);
        }
        // 单张要读数 MB + 解码 + 编码，连着跑会占满一个核。让一让，反正是后台一次性活
        std::thread::sleep(std::time::Duration::from_millis(5));
    }

    if changed > 0 {
        log::info!("音乐封面降级完成：{} 张（失败 {}）", changed, failed);
        // 前端只在 MusicView 挂载/启动预载时 loadTracks()，不通知的话要重进库才看到新图
        let _ = app.emit("music-covers-migrated", changed);
    }

    // 顺手清理孤儿封面：delete_track 只删库行不删封面文件，历年积累了一堆
    // covers/music_* 没有任何曲目引用（本次实测 344 个、154MB —— 含本轮转换后
    // 留下的旧 .png 与早已删除曲目的图）。封面是纯派生物，源音频还在盘上，删了不丢
    // 数据。与并发导入的竞争窗口不存在：迁移只在启动后 1.5s 跑一次
    if failed == 0 {
        let live: std::collections::HashSet<String> = {
            let conn = state.db.lock();
            let Ok(mut stmt) =
                conn.prepare("SELECT cover_path FROM tracks WHERE cover_path <> ''")
            else {
                return;
            };
            let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) else {
                return;
            };
            rows.filter_map(|r| r.ok())
                .filter_map(|p| Path::new(&p).file_name().map(|f| f.to_string_lossy().to_string()))
                .collect()
        };
        let covers_dir = state.data_dir.join("covers");
        let mut removed = 0usize;
        let mut freed = 0u64;
        if let Ok(entries) = fs::read_dir(&covers_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.starts_with("music_") || live.contains(&name) {
                    continue;
                }
                if let Ok(meta) = entry.metadata() {
                    freed += meta.len();
                }
                if fs::remove_file(entry.path()).is_ok() {
                    removed += 1;
                }
            }
        }
        if removed > 0 {
            log::info!("清理孤儿音乐封面：{} 个（{} MB）", removed, freed / 1048576);
        }
    }
    if failed == 0 {
        let conn = state.db.lock();
        let _ = conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')",
            [FLAG],
        );
    }
}

// 存量 progressive JPEG 转 baseline（一次性）：早期版本把 TMDB 图原样落盘，其中
// progressive 编码的背景大图在详情页滚动时被反复解码 → 卡（实测同库里只有 progressive
// 背景的那部剧卡，baseline 的不卡）。扫 covers/ 就地把 progressive 转成 baseline。
// series 背景/海报走 ?v=updated_at 强缓存（immutable，见 serve_covers_file），文件原地
// 覆盖后 URL 不变、WebView 会吃旧缓存 → 被转过的 series 要 bump updated_at 翻新缓存键；
// 剧照多为 no-cache 协商缓存，改文件即生效。标志位/失败重试范式同 migrate_music_covers。
pub(crate) fn migrate_covers_baseline(app: &AppHandle, state: &AppState) {
    const FLAG: &str = "covers_baseline_v1";

    {
        let conn = state.db.lock();
        let done: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = ?", [FLAG], |r| r.get(0))
            .ok();
        if done.is_some() {
            return;
        }
    }

    let covers_dir = state.data_dir.join("covers");
    let mut converted: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut failed = 0usize;
    if let Ok(entries) = fs::read_dir(&covers_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jpg") {
                continue;
            }
            let Ok(bytes) = fs::read(&path) else { continue };
            if !is_progressive_jpeg(&bytes) {
                continue; // baseline / 实为 PNG 的 .jpg：不碰，零二次压缩
            }
            let Some(baseline) = to_baseline_jpeg(&bytes) else {
                log::warn!("baseline 转换失败（无法解码）：{}", path.display());
                failed += 1;
                continue;
            };
            if let Err(e) = fs::write(&path, &baseline) {
                log::warn!("baseline 写入失败 {}：{}", path.display(), e);
                failed += 1;
                continue;
            }
            converted.insert(entry.file_name().to_string_lossy().to_string());
            std::thread::sleep(std::time::Duration::from_millis(3)); // 让核，后台一次性活
        }
    }

    // 被转过背景/海报的 series bump updated_at，让强缓存的 ?v= 翻新（先读齐再写，避免借用纠缠）
    if !converted.is_empty() {
        let rows: Vec<(String, String, String)> = {
            let conn = state.db.lock();
            // 绑到局部再作块值：让借用了 conn 的 Statement 临时量在 conn 之前析构
            let out = match conn.prepare("SELECT id, poster_path, bg_path FROM series") {
                Ok(mut stmt) => stmt
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                    .map(|it| it.filter_map(|r| r.ok()).collect())
                    .unwrap_or_default(),
                Err(_) => Vec::new(),
            };
            out
        };
        let base = |p: &str| Path::new(p).file_name().map(|f| f.to_string_lossy().to_string());
        let conn = state.db.lock();
        for (id, poster, bg) in rows {
            let hit = base(&poster).map(|n| converted.contains(&n)).unwrap_or(false)
                || base(&bg).map(|n| converted.contains(&n)).unwrap_or(false);
            if hit {
                let _ = conn.execute(
                    "UPDATE series SET updated_at = ?1 WHERE id = ?2",
                    params![Utc::now().to_rfc3339(), id],
                );
            }
        }
    }

    if !converted.is_empty() {
        log::info!("progressive→baseline：转换 {} 张（失败 {}）", converted.len(), failed);
        let _ = app.emit("series-covers-migrated", converted.len());
    }

    // 有失败就不落标志位，下次启动重试
    if failed == 0 {
        let conn = state.db.lock();
        let _ = conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')",
            [FLAG],
        );
    }
}

// 读曲目的内嵌歌词原文（多为带时间轴的 LRC，也可能是纯文本）。有没有时间轴、
// 怎么解析是前端的事，后端只负责把标签里的歌词文本原样掏出来。
// 内嵌位置随格式不同：ID3v2=USLT、Vorbis(FLAC/OGG)=LYRICS、MP4=©lyr，
// lofty 统一映射到 ItemKey::Lyrics。遍历所有标签段：有的文件 primary 段无词、次级段有
#[tauri::command(async)]
pub fn get_track_lyrics(state: State<'_, AppState>, track_id: String) -> AppResult<Option<String>> {
    use lofty::file::TaggedFileExt;
    use lofty::probe::Probe;

    let file_path = {
        let conn = state.db.lock();
        conn.query_row(
            "SELECT file_path FROM tracks WHERE id = ?1",
            [&track_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    };
    let Some(fp) = file_path else { return Ok(None) };

    let Ok(tagged) = Probe::open(Path::new(&fp)).and_then(|p| p.read()) else {
        return Ok(None);
    };
    for tag in tagged.tags() {
        if let Some(v) = tag.get_string(lofty::tag::ItemKey::Lyrics) {
            let v = v.trim();
            if !v.is_empty() {
                return Ok(Some(v.to_string()));
            }
        }
    }
    Ok(None)
}

// 扫描文件夹（递归）/ 手动选择的文件 → 解析预览列表（不落库，前端勾选后走 import_music_tracks）
#[tauri::command(async)]
pub fn scan_music_paths(state: State<'_, AppState>, paths: Vec<String>) -> AppResult<Vec<TrackPreview>> {
    // 注意：整个扫盘 + 标签解析都在锁外做。旧版在函数开头就拿 DB 锁并持有到返回，
    // 扫几百首期间界面上任何要读库的操作全部排队（第 1 项异步化后更明显）。
    // 现在只在最后查一次「哪些已入库」时短暂加锁

    // 递归收集目录下的音频文件（目录外散落的文件也接受，手动选择场景）
    fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    collect(&p, out);
                } else if let Some(ext) = p.extension().map(|e| e.to_string_lossy().to_lowercase()) {
                    if MUSIC_EXTS.contains(&ext.as_str()) {
                        out.push(p);
                    }
                }
            }
        }
    }

    let mut files: Vec<PathBuf> = Vec::new();
    for p in &paths {
        let path = Path::new(p);
        if path.is_dir() {
            collect(path, &mut files);
        } else if let Some(ext) = path.extension().map(|e| e.to_string_lossy().to_lowercase()) {
            if MUSIC_EXTS.contains(&ext.as_str()) {
                files.push(path.to_path_buf());
            }
        }
    }
    files.sort();

    let mut previews: Vec<TrackPreview> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for f in files {
        let fp = f.to_string_lossy().to_string();
        if !seen.insert(fp.clone()) { continue; }
        if let Some(preview) = parse_audio_tags(&f) {
            previews.push(preview);
        }
    }

    // 已入库判断：一次性拿全部 file_path 建集合，替代逐首 query_row。
    // 锁只在这一小段内持有，且不做任何文件 IO
    let existing: std::collections::HashSet<String> = {
        let conn = state.db.lock();
        let mut stmt = conn.prepare("SELECT file_path FROM tracks")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for p in previews.iter_mut() {
        p.already_exists = existing.contains(&p.file_path);
    }
    Ok(previews)
}

// 批量导入（预览勾选后）：已存在跳过，其余入库并提取内嵌封面；返回新导入的曲目
#[tauri::command(async)]
pub fn import_music_tracks(state: State<'_, AppState>, previews: Vec<TrackPreview>) -> AppResult<Vec<Track>> {
    let data_dir = state.data_dir.clone();
    let mut imported = Vec::new();

    for preview in &previews {
        if preview.already_exists { continue; }
        let id = Uuid::new_v4().to_string();
        let title = if preview.title.trim().is_empty() {
            "未知曲目".to_string()
        } else {
            preview.title.trim().to_string()
        };

        // 封面提取在锁外做（纯 IO + 标签读取，不碰库）
        let cover_path = extract_track_cover(&data_dir, Path::new(&preview.file_path), &id);

        let conn = state.db.lock();
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO tracks (id, file_path, title, artist, album, album_artist,
             track_number, disc_number, duration_seconds, bitrate, cover_path, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                     (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM tracks))",
            params![
                id, &preview.file_path, &title, &preview.artist, &preview.album,
                &preview.album_artist, preview.track_number, preview.disc_number,
                preview.duration_seconds, preview.bitrate, &cover_path
            ],
        )?;
        drop(conn);
        if inserted == 0 { continue; } // file_path UNIQUE 冲突（already_exists 标记可能滞后）

        let conn = state.db.lock();
        let track: Track = conn.query_row(
            &format!("SELECT {} FROM tracks WHERE id = ?", TRACK_COLS),
            [&id],
            |row| row_to_track(row),
        )?;
        drop(conn);
        imported.push(track);
    }

    Ok(imported)
}

#[tauri::command(async)]
pub fn get_all_tracks(state: State<'_, AppState>) -> AppResult<Vec<Track>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM tracks ORDER BY CASE WHEN sort_order = 0 THEN 1 ELSE 0 END, sort_order, created_at, id",
        TRACK_COLS
    ))?;
    let rows = stmt.query_map([], |row| row_to_track(row))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

#[tauri::command(async)]
pub fn delete_track(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock();
    // 删除前存档统计：时长 + 播放次数都留住（音乐是唯一统计次数的类别）。曲目无稳定外部 id，按 id 存档。
    if let Ok((title, artist, cover, secs, plays)) = conn.query_row(
        "SELECT title, artist, cover_path, total_seconds, play_count FROM tracks WHERE id = ?1",
        [&id],
        |r| Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?,
        )),
    ) {
        let key = format!("music:id:{id}");
        games::archive_stats_entry(&conn, &key, "music", &title, &artist, &cover, "", secs, plays, 0, 0, 0);
    }
    conn.execute("DELETE FROM tracks WHERE id = ?", [&id])?;
    Ok(())
}

// 音乐拖拽排序：按传入顺序批量写 sort_order（事务原子，不碰 updated_at）
#[tauri::command(async)]
pub fn reorder_tracks(state: State<'_, AppState>, ordered_ids: Vec<String>) -> AppResult<()> {
    let mut conn = state.db.lock();
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("UPDATE tracks SET sort_order = ?1 WHERE id = ?2")?;
        for (i, id) in ordered_ids.iter().enumerate() {
            // 1 基（0 表示未参与排序，排末尾）；拖拽期间被删除的曲目 UPDATE 影响 0 行，跳过无害
            stmt.execute(params![i as i64 + 1, id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command(async)]
pub fn set_track_favorite(state: State<'_, AppState>, id: String, favorite: bool) -> AppResult<()> {
    let conn = state.db.lock();
    let changed = conn.execute(
        "UPDATE tracks SET favorite = ?1 WHERE id = ?2",
        params![favorite as i32, id],
    )?;
    if changed == 0 {
        return Err(AppError::Custom("曲目不存在".to_string()));
    }
    Ok(())
}

// ─────────────────────────────────────────────
// Playlists（歌单）
// ─────────────────────────────────────────────

// 歌单 + 其曲目 id 列表（一次查询，前端本地过滤无需逐歌单回查）
pub(crate) fn load_playlists(conn: &rusqlite::Connection) -> AppResult<Vec<Playlist>> {
    let mut stmt = conn.prepare("SELECT id, name, created_at, updated_at FROM playlists ORDER BY created_at, id")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, name, created_at, updated_at) = row?;
        // 按加入先后（sort_order, added_at, track_id）取曲目 id
        let ids: Vec<String> = {
            let mut s = conn.prepare(
                "SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY sort_order, added_at, track_id",
            )?;
            let it = s.query_map([&id], |r| r.get::<_, String>(0))?;
            it.filter_map(Result::ok).collect()
        };
        out.push(Playlist { id, name, track_ids: ids, created_at, updated_at });
    }
    Ok(out)
}

#[tauri::command(async)]
pub fn get_playlists(state: State<'_, AppState>) -> AppResult<Vec<Playlist>> {
    let conn = state.db.lock();
    load_playlists(&conn)
}

// 新建歌单：track_ids 可选（右键「新建歌单」会把当前曲目一起加进去）
#[tauri::command(async)]
pub fn create_playlist(state: State<'_, AppState>, name: String, track_ids: Option<Vec<String>>) -> AppResult<Playlist> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Custom("歌单名不能为空".to_string()));
    }
    let id = Uuid::new_v4().to_string();
    let mut conn = state.db.lock();
    let tx = conn.transaction()?;
    // 重名兜底：正常路径由前端拦住（CreatePlaylistModal 里同名直接不提交），
    // 这里防的是其它入口和并发 —— 两次创建同名歌单会让侧栏出现两条无法区分的项。
    // 表上没加 UNIQUE：老库里可能已经存在重名数据，加约束会让建表静默失败
    let dup: Option<bool> = tx
        .query_row(
            "SELECT 1 FROM playlists WHERE name = ?1 COLLATE NOCASE",
            [&name],
            |r| r.get(0),
        )
        .optional()?;
    if dup.unwrap_or(false) {
        return Err(AppError::Custom(format!("歌单「{}」已存在", name)));
    }
    tx.execute(
        "INSERT INTO playlists (id, name) VALUES (?1, ?2)",
        params![id, name],
    )?;
    // 实际写进去的曲目 id（按 sort_order 顺序）——直接用它构造返回值，
    // 不必再查库。去重（PRIMARY KEY 兜底）：按入参顺序写 sort_order（1 基）
    let mut inserted: Vec<String> = Vec::new();
    if let Some(ids) = track_ids {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?1, ?2, ?3)",
        )?;
        for (i, tid) in ids.iter().enumerate() {
            if stmt.execute(params![id, tid, i as i64 + 1])? > 0 {
                inserted.push(tid.clone());
            }
        }
    }
    // 时间戳由表默认值生成，取回来保证与后续 get_playlists 一致
    let (created_at, updated_at): (String, String) = tx.query_row(
        "SELECT created_at, updated_at FROM playlists WHERE id = ?1",
        [&id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    tx.commit()?;
    // 事务内读回：原先 commit 后放锁再重取，命令异步化后并发的 delete_playlist
    // 能落在空隙里，歌单明明建好了却报「创建失败」
    Ok(Playlist { id, name, track_ids: inserted, created_at, updated_at })
}

// 添加曲目到歌单：已存在的跳过（PRIMARY KEY 兜底），返回实际新增数
#[tauri::command(async)]
pub fn add_tracks_to_playlist(state: State<'_, AppState>, playlist_id: String, track_ids: Vec<String>) -> AppResult<i64> {
    let mut conn = state.db.lock();
    // 校验歌单存在
    let exists: Option<bool> = conn
        .query_row("SELECT 1 FROM playlists WHERE id = ?1", [&playlist_id], |r| r.get(0))
        .optional()?;
    if !exists.unwrap_or(false) {
        return Err(AppError::Custom("歌单不存在".to_string()));
    }
    let tx = conn.transaction()?;
    let mut added: usize = 0;
    {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, sort_order)
             VALUES (?1, ?2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM playlist_tracks WHERE playlist_id = ?1))",
        )?;
        for tid in &track_ids {
            added += stmt.execute(params![playlist_id, tid])?;
        }
    }
    tx.commit()?;
    Ok(added as i64)
}

// 从歌单移除一首曲目
#[tauri::command(async)]
pub fn remove_track_from_playlist(state: State<'_, AppState>, playlist_id: String, track_id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute(
        "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2",
        params![playlist_id, track_id],
    )?;
    Ok(())
}

#[tauri::command(async)]
pub fn rename_playlist(state: State<'_, AppState>, id: String, name: String) -> AppResult<()> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Custom("歌单名不能为空".to_string()));
    }
    let conn = state.db.lock();
    conn.execute(
        "UPDATE playlists SET name = ?1, updated_at = datetime('now') WHERE id = ?2",
        params![name, id],
    )?;
    Ok(())
}

#[tauri::command(async)]
pub fn delete_playlist(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM playlists WHERE id = ?", [&id])?; // 关联行 ON DELETE CASCADE
    Ok(())
}

// covers 协议：只允许读取 data/covers 下的文件（请求路径百分号解码后取文件名，
// 绕过 asset 协议作用域的 glob 匹配——后者在 Windows 上因 \\?\ 前缀永远拒绝）
pub(crate) fn serve_covers_file(covers_dir: &Path, request: &tauri::http::Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let encoded = request.uri().path().trim_start_matches('/');
    let decoded = percent_decode_str(encoded).decode_utf8_lossy().to_string();
    let file_name = Path::new(&decoded)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();
    let path = covers_dir.join(&file_name);
    if file_name.is_empty() || !path.exists() || !path.starts_with(covers_dir) {
        return Response::builder()
            .status(404)
            .body(Cow::Borrowed(&b"not found"[..]))
            .unwrap();
    }

    // 缓存策略：不加缓存头时 WebView 每次滚动都重新读盘（封面目录上千张、数百 MB）。
    // 但 series_{id}.jpg / music_{id}.jpg 这类文件名在重新获取元数据后会被原地覆盖，
    // 文件名不变 —— 所以只有带 ?v= 版本号的请求（见 utils/media.ts coverSrc）才能强缓存；
    // 不带版本号的用 mtime+size 做 ETag 走协商缓存：命中时回 304，不读文件内容。
    let versioned = request.uri().query().map(|q| q.contains("v=")).unwrap_or(false);
    let etag = fs::metadata(&path).ok().and_then(|m| {
        let len = m.len();
        let ms = m
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis();
        Some(format!("\"{:x}-{:x}\"", ms, len))
    });
    let cache_control = if versioned {
        "public, max-age=31536000, immutable"
    } else {
        "public, no-cache"
    };
    // If-None-Match 命中 → 304，连 fs::read 都省掉
    if let Some(tag) = &etag {
        let matched = request
            .headers()
            .get("if-none-match")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.split(',').any(|e| e.trim() == tag.as_str()))
            .unwrap_or(false);
        if matched {
            return Response::builder()
                .status(304)
                .header("Cache-Control", cache_control)
                .header("ETag", tag.clone())
                .header("Access-Control-Allow-Origin", "*") // 前端 fetch 转 objectURL 内存缓存用
                .body(Cow::Borrowed(&b""[..]))
                .unwrap();
        }
    }

    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(_) => {
            return Response::builder()
                .status(404)
                .body(Cow::Borrowed(&b"not found"[..]))
                .unwrap()
        }
    };
    // SGDB 兜底下载的是 PNG，按魔数判断真实类型（文件名统一 .jpg 便于共享复用）
    let mime = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else {
        "image/jpeg"
    };
    let mut builder = Response::builder()
        .header("Content-Type", mime)
        .header("Cache-Control", cache_control)
        .header("Access-Control-Allow-Origin", "*"); // 前端 fetch 转 objectURL 内存缓存用
    if let Some(tag) = etag {
        builder = builder.header("ETag", tag);
    }
    builder.body(Cow::Owned(bytes)).unwrap()
}
