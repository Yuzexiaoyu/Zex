//! 内置播放引擎：随包分发的 mpv + JSON IPC 遥控。
//!
//! ## 为什么是外挂进程而不是嵌进主窗口
//! WebView2 走 DirectComposition 合成，原生视频子窗口没法和它的图层混合（airspace
//! 问题）。嵌进来就必须放弃 React 自绘控制条，只能用 mpv 自己的 OSC —— 那还不如
//! 让 mpv 独立开窗，省掉 HWND 父子关系、z-order、resize 同步这一整套麻烦。
//!
//! ## 为什么进度记录放在 Rust 侧
//! 播放时 ZEX 窗口已经收进托盘，WebView 会被系统节流甚至完全停止渲染，挂在 JS
//! 定时器上的进度记录必然丢数据。这和游戏时长由后端线程累计是同一个理由。

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use parking_lot::{Mutex, RwLock};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sysinfo::System;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::{AppError, AppResult, AppState};

// 进度落库间隔。太密集会让 SQLite 频繁 fsync，太稀疏则强杀 mpv 时丢得多
const FLUSH_INTERVAL: Duration = Duration::from_secs(5);
// 相邻两次 time-pos 事件间隔超过这个值，就认为中间暂停/卡顿过，不计入观看时长
const TICK_GAP_MAX: f64 = 2.0;
// 看到这个比例之后退出，就算作看完（片尾曲通常不会看到最后一秒）
const WATCHED_THRESHOLD: f64 = 0.92;

// ─────────────────────────────────────────────
// 会话状态
// ─────────────────────────────────────────────

/// 会话模式：影视（视频）或音乐（纯音频）。reader 线程按 mode 分派记账与事件。
/// 音乐播放时 mpv 以 video=no 运行（不建窗），ZEX 窗口保持前台（要操作播放条）
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum SessionMode {
    Video,
    Music,
}

pub struct Session {
    pipe: String,
    /// 命令写端。连接线程建立后回填，所以启动瞬间可能还是 None
    writer: Option<File>,
    /// 当前条目 id：影视 = episodes.id，音乐 = tracks.id
    episode_id: String,
    label: String,
    /// 影视 = series_id；音乐 = 空串（不用）
    series_id: String,
    /// 本次播放的标识（会话表已下线，只用于 flush 判断是否同一次播放）
    session_id: String,
    /// 当前会话模式
    pub(crate) mode: SessionMode,
    /// 整季本地剧集列表（顺序与传给 mpv 的 m3u 一致）。
    /// 播放器的 prev/next 和自动连播都靠它 + mpv 的 playlist-pos 定位
    playlist: Vec<PlaylistEntry>,
    /// 会话当前跟踪的集在 playlist 中的下标
    playlist_pos: usize,
    /// 文件加载完成后要 seek 到的位置（续播；等 file-loaded 事件再发 seek）
    pending_seek: Option<f64>,
    /// 用户拖动播放条触发的 seek：(目标秒, 截止时刻)。mpv 的 time-pos 观察事件存在
    /// 「seek 前的旧位置滞留在管道里、seek 后才送达」的时序问题（见 mpv#15253），
    /// reader 据此丢弃 target 之前的位置推送，前端就不会弹回旧位置。pos 落到 ≥ target
    /// 即视为 seek 完成、清空；3 秒内一直没到位则超时兜底强制清空（seek 异常兜底）。
    seek: Option<(f64, Instant)>,
    /// 重建播放列表后要跳到的目标下标。重建期间 loadlist 会先自动载入列表第一项，
    /// playlist-pos 会经过中间位置 —— 设了这个就只认目标下标，中间的忽略
    pending_jump: Option<usize>,
}

/// 播放列表里的一集（m3u 顺序即此顺序）。音乐条目复用同一结构：
/// episode_id 存 track_id，season/episode/watched 等视频字段音乐时保持默认
#[derive(Clone)]
struct PlaylistEntry {
    episode_id: String,
    local_path: String,
    /// "家庭男人 · S01E02 第二集"，既给播放列表菜单显示，也给播放浮条
    label: String,
    /// 以下几项只给 queue.json 边车用 —— 播放列表抽屉靠它们画集号、已看勾、进度条。
    /// m3u 的 EXTINF 只带得动一个标题字符串，装不下这些
    season_number: i32,
    episode_number: i32,
    /// 单集标题（不含剧名/季集前缀）
    title: String,
    watched: bool,
    /// 续播位置（毫秒），语义同 episodes.watched_ms
    watched_ms: i64,
    runtime_minutes: i32,
}

pub type MpvHandle = Arc<Mutex<Option<Session>>>;

#[derive(Clone, Serialize)]
struct ProgressPayload {
    episode_id: String,
    /// "家庭男人 · S01E02 第二集"，给前端的播放浮条直接用，省一次回查
    label: String,
    position_ms: i64,
    duration_ms: i64,
}

// ─────────────────────────────────────────────
// mpv 可执行文件与配置
// ─────────────────────────────────────────────

/// 找 mpv.exe。三个候选按可靠性排序 —— `tauri build --no-bundle`（start.bat 走的就是
/// 这条）不会把 resources 复制到 exe 旁边，所以必须有开发树兜底
fn resolve_mpv(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(p) = app
        .path()
        .resolve("resources/mpv/mpv.exe", tauri::path::BaseDirectory::Resource)
    {
        if p.exists() {
            return Some(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("resources").join("mpv").join("mpv.exe");
            if p.exists() {
                return Some(p);
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("mpv")
        .join("mpv.exe");
    dev.exists().then_some(dev)
}

/// 找播放器皮肤资源目录（scripts/、fonts/、script-opts/ 三个子目录同构镜像）。
/// 和 resolve_mpv 同一套查找顺序：Resource 基目录 → exe 旁 → 开发树兜底。
/// 皮肤用的是 ModernZ（一体式单栏控制条 + 中文界面），脚本随 ZEX 锁版本
fn resolve_skin(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(p) = app
        .path()
        .resolve("resources/skin", tauri::path::BaseDirectory::Resource)
    {
        if p.exists() {
            return Some(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("resources").join("skin");
            if p.exists() {
                return Some(p);
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("skin");
    dev.exists().then_some(dev)
}

/// 递归复制目录。单个文件失败只跳过不中断 —— 皮肤这种可选资产不值得整体回滚
fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let path = entry.path();
        let target = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir(&path, &target)?;
        } else if ty.is_file() {
            let _ = std::fs::copy(&path, &target);
        }
    }
    Ok(())
}

/// 序列化 mpv 配置目录的写入（首次皮肤安装 / 配置补齐），防止预热线程与
/// 播放线程并发抢删文件
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

/// ZEX 专用的 mpv 配置目录。**不碰用户自己的 mpv 配置** —— 用 --config-dir 隔离，
/// 否则改了 HDR 设置会污染他们平时用的 mpv
fn ensure_config_dir(app: &AppHandle, data_dir: &PathBuf) -> PathBuf {
    // 首次运行时预热线程与播放线程可能并发进来，皮肤安装（remove_dir_all + copy）
    // 不串行会互相删文件 —— 整函数加锁串行化
    let _guard = CONFIG_LOCK.lock();
    let dir = data_dir.join("mpv");
    let _ = std::fs::create_dir_all(&dir);

    // ── 播放器皮肤（ModernZ 一体式控制栏）──
    // mpv 会从 <config>/fonts 自动注册字体、<config>/scripts 自动加载脚本，
    // 所以把随包资源复制进配置目录即可生效。用版本标记文件判断要不要重灌：
    // 脚本随 ZEX 锁版本，升级时整包覆盖；复制失败只影响皮肤，自带 OSC 兜底
    const SKIN_VERSION: &str = "modernz 2026-08-09 v59"; // v59: 抽屉开着时回读边车（已看勾实时刷新）
    let marker = dir.join(".skin-version");
    let need_install = std::fs::read_to_string(&marker).ok().as_deref() != Some(SKIN_VERSION);
    if need_install {
        if let Some(skin) = resolve_skin(app) {
            // 皮肤目录整包镜像。先清掉旧的脚本/字体/配置再复制：防止升级残留的
            // 旧脚本（比如上一版皮肤 uosc）和 ModernZ 同时接管 UI
            let _ = std::fs::remove_dir_all(&dir.join("scripts"));
            let _ = std::fs::remove_dir_all(&dir.join("fonts"));
            let _ = std::fs::remove_dir_all(&dir.join("script-opts"));
            let _ = copy_dir(&skin.join("scripts"), &dir.join("scripts"));
            let _ = copy_dir(&skin.join("fonts"), &dir.join("fonts"));
            let _ = copy_dir(&skin.join("script-opts"), &dir.join("script-opts"));
            let _ = std::fs::write(&marker, SKIN_VERSION);
        }
    }

    // ── input.conf：单击视频暂停/继续（双击全屏保持 mpv 默认），Esc 关闭播放器 ──
    // 缺失或空文件都补写；用户自己填过内容就尊重
    // Esc=quit 与 ModernZ 皮肤不冲突：播放列表抽屉开着时皮肤用 forced section 劫持 Esc
    // （先关抽屉），关抽屉后按键归还，Esc 才会落到这里关闭播放器
    const ESC_BIND: &str = "# Esc = 关闭播放器（等效在播放器窗口点叉）；播放列表抽屉开着时 Esc 先关抽屉\nESC quit\n";
    const TAB_BIND: &str = "# Tab = 打开/关闭统计信息（皮肤里的统计按钮已去掉）\nTab script-binding stats/display-stats-toggle\n";
    const F_KEY_BIND: &str = "# mpv 默认 f 键切换全屏，ZEX 固定全屏播放，禁用\nf ignore\n";
    // Xbox 手柄（--input-gamepad=yes 启用）：主机风格映射。GAMEPAD_ACTION_* = A/B/X/Y
    //（DOWN=A, RIGHT=B, LEFT=X, UP=Y，XInput 方向命名）。未用的键显式 ignore，
    // 避免 mpv 内置默认手柄绑定抢键。mpv 手柄键是纯数字量，扳机/摇杆只能当按钮
    const GAMEPAD_BIND: &str = "\
         # Xbox 手柄：A=暂停/继续，B=退出播放器，Y=切全屏，X=播放列表抽屉，LB/RB=音量±，LT/RT=未绑定，\n\
         # ←/→=快退/快进5秒（短按单次，长按连续），↑/↓=上一集/下一集，BACK=进度提示，START=静音。\n\
         # 绑定归入 {gamepad} 输入节：音乐播放时 ZEX 发 disable-section 屏蔽手柄，影视播放 enable-section 恢复\n\
         GAMEPAD_ACTION_DOWN {gamepad} cycle pause\n\
         GAMEPAD_ACTION_RIGHT {gamepad} quit\n\
         GAMEPAD_ACTION_UP {gamepad} cycle fullscreen\n\
         GAMEPAD_ACTION_LEFT {gamepad} script-binding modernz/playlist-drawer-toggle\n\
         GAMEPAD_LEFT_SHOULDER {gamepad} no-osd add volume -5\n\
         GAMEPAD_RIGHT_SHOULDER {gamepad} no-osd add volume 5\n\
         GAMEPAD_LEFT_TRIGGER {gamepad} ignore\n\
         GAMEPAD_RIGHT_TRIGGER {gamepad} ignore\n\
         GAMEPAD_DPAD_LEFT {gamepad} no-osd seek -5\n\
         GAMEPAD_DPAD_RIGHT {gamepad} no-osd seek 5\n\
         GAMEPAD_DPAD_UP {gamepad} playlist-prev\n\
         GAMEPAD_DPAD_DOWN {gamepad} playlist-next\n\
         GAMEPAD_BACK {gamepad} show-progress\n\
         GAMEPAD_START {gamepad} cycle mute\n\
         GAMEPAD_MENU {gamepad} ignore\n";
    let input_conf = dir.join("input.conf");
    let existing = std::fs::read_to_string(&input_conf).ok();
    let is_empty = existing.as_deref().map(|s| s.trim().is_empty()).unwrap_or(false);
    if !input_conf.exists() || is_empty {
        let mut fresh = "# ZEX 绑定的输入（独立于你自己的 mpv 配置，可以随意改）\n\
             # 单击视频 = 暂停/继续，双击 = 暂停（mpv 默认）\n\
             MBTN_LEFT cycle pause\n\
             # 右键不吃默认的暂停（mpv 内置 MBTN_RIGHT cycle pause 太容易误触）\n\
             MBTN_RIGHT ignore\n\
             # 滚轮 = 调音量（no-osd 不弹中央音量条，左上角由 volume_osd.lua 提示）\n\
             WHEEL_UP no-osd add volume 5\n\
             WHEEL_DOWN no-osd add volume -5\n\
             # Esc = 关闭播放器（等效在播放器窗口点叉）；播放列表抽屉开着时 Esc 先关抽屉\n\
             ESC quit\n\
             # Tab = 打开/关闭统计信息（皮肤里的统计按钮已去掉）\n\
             Tab script-binding stats/display-stats-toggle\n\
             # mpv 默认 f 键切换全屏，ZEX 固定全屏播放，禁用\n\
             f ignore\n"
            .to_string();
        fresh.push_str(GAMEPAD_BIND);
        let _ = std::fs::write(&input_conf, fresh);
    } else if let Some(text) = existing {
        // 老版本 ZEX 写的 input.conf 缺 Esc / Tab / f ignore / 手柄绑定：认准 ZEX 标记行才补，用户自写的文件不碰
        // GAMEPAD 段升级判定：任一旧版绑定特征（D-pad 换集/带 !、X=show-playlist、LT/RT=seek）→ 替换整段
        let stale_gampad = |t: &str| {
            // 缺 {gamepad} 输入节 = 旧版绑定（音乐播放无法屏蔽手柄），一律更新为新格式
            !t.contains("{gamepad}")
                || t.contains("GAMEPAD_DPAD_LEFT playlist-prev")
                || t.contains("GAMEPAD_DPAD_LEFT !no-osd seek")
                || t.contains("GAMEPAD_ACTION_LEFT show-playlist")
                || t.contains("GAMEPAD_ACTION_LEFT select/select-playlist")
                || t.contains("GAMEPAD_LEFT_TRIGGER no-osd seek")
        };
        if text.contains("# ZEX 绑定的输入")
            && (!text.contains("ESC quit")
                || !text.contains("script-binding stats/display-stats-toggle")
                || !text.contains("f ignore")
                || !text.contains("GAMEPAD_ACTION_DOWN")
                || stale_gampad(&text))
        {
            let mut out = text;
            // GAMEPAD 键位更新：旧绑定整体替换为新方案，
            // 从注释头到 GAMEPAD_MENU 行替换，保留段后用户追加的内容
            if stale_gampad(&out) {
                if let (Some(start), Some(end)) =
                    (out.find("# Xbox 手柄："), out.find("GAMEPAD_MENU ignore"))
                {
                    let end = end + "GAMEPAD_MENU ignore".len();
                    out.replace_range(start..end, GAMEPAD_BIND.trim_end_matches('\n'));
                }
            }
            if !out.contains("ESC quit") {
                out.push_str("\n");
                out.push_str(ESC_BIND);
            }
            if !out.contains("script-binding stats/display-stats-toggle") {
                out.push_str("\n");
                out.push_str(TAB_BIND);
            }
            if !out.contains("f ignore") {
                out.push_str("\n");
                out.push_str(F_KEY_BIND);
            }
            if !out.contains("GAMEPAD_ACTION_DOWN") {
                out.push_str("\n");
                out.push_str(GAMEPAD_BIND);
            }
            let _ = std::fs::write(&input_conf, &out);
        }
    }

    // ── mpv.conf：首次写入；已存在则只补齐需要的行，不覆盖用户的其它修改 ──
    let conf = dir.join("mpv.conf");
    if !conf.exists() {
        let _ = std::fs::write(
            &conf,
            // gpu-next 是 DV Profile 5/8 与 HDR 直通的前提，libplacebo 负责 tone mapping。
            // [hdr] 段用 profile-cond 只在 HDR 片源上生效，SDR 片源完全不受影响。
            // 注意：不要在这里写 osc=no —— ModernZ 皮肤加载时会自己关掉内置 OSC；
            // 万一皮肤加载失败，内置 OSC 还能兜底保证有控制条
            r#"# ZEX 托管的 mpv 配置（独立于你自己的 mpv 配置，可以随意改）
vo=gpu-next
gpu-api=d3d11
# auto 而非 auto-copy：-copy 会把解码好的画面从显存回读到内存、再上传回显存，
# 4K HDR 下这趟来回开销明显。gpu-next + d3d11 支持零拷贝的 d3d11va，auto 直接选它；
# 个别驱动上硬解失败时 mpv 会自己回落软解，不会播不了
hwdec=auto
target-colorspace-hint=yes
# OSD 菜单（播放列表/音轨选择、ModernZ 控制条动画）流畅渲染：
# 默认 video-sync=audio 让画面和 OSD 都跟着视频帧率走，24fps 片源下菜单只有
# 24fps 会卡。display-resample 按显示器刷新率渲染，菜单丝滑，视频观感不变
video-sync=display-resample

sub-auto=fuzzy
slang=chi,zh,chs,sc,zho,eng
alang=jpn,chi,eng

# 播完停在最后一帧等 ZEX 发下一集，别自己退出
keep-open=yes
idle=yes
# 进度由 ZEX 记账，别让 mpv 再存一份对不上的
save-position-on-quit=no
# ModernZ 皮肤要求：别让 watch-later 恢复字幕位置/OSD 边距，和皮肤抬字幕冲突
watch-later-options-remove=sub-pos
watch-later-options-remove=osd-margin-y
# 用随包的中文 select.lua（菜单提示本地化），关掉 mpv 内置的英文版
load-select=no
# 音量上限 100%（mpv 默认 130，滚轮/音量条都不会超过最大）
volume-max=100

[hdr]
profile-cond=get("video-params/max-luma", 0) > 203
profile-restore=copy
target-trc=pq
target-peak=auto
"#,
        );
    } else if let Ok(mut text) = std::fs::read_to_string(&conf) {
        // 追加会落在 [hdr] profile 之后被算进该 profile（只在 HDR 生效），
        // 所以必须插到 [hdr] 之前；没有 [hdr] 才追加到末尾
        let mut changed = false;
        let hdr_pos = text.find("[hdr]");
        if !text.contains("watch-later-options-remove=sub-pos") {
            let block =
                "\n# ModernZ 皮肤要求：别让 watch-later 恢复字幕位置/OSD 边距\nwatch-later-options-remove=sub-pos\nwatch-later-options-remove=osd-margin-y\n";
            match hdr_pos {
                Some(i) => text.insert_str(i, block),
                None => text.push_str(block),
            }
            changed = true;
        }
        if !text.contains("load-select=no") {
            let block = "\n# 用随包的中文 select.lua（菜单提示本地化），关掉 mpv 内置的英文版\nload-select=no\n";
            match hdr_pos {
                Some(i) => text.insert_str(i, block),
                None => text.push_str(block),
            }
            changed = true;
        }
        if !text.contains("video-sync=display-resample") {
            let block =
                "\n# OSD 菜单流畅渲染：按显示器刷新率渲染（默认跟视频帧率走会卡）\nvideo-sync=display-resample\n";
            match hdr_pos {
                Some(i) => text.insert_str(i, block),
                None => text.push_str(block),
            }
            changed = true;
        }
        if !text.contains("volume-max=") {
            let block = "\n# 音量上限 100%（mpv 默认 130）\nvolume-max=100\n";
            match hdr_pos {
                Some(i) => text.insert_str(i, block),
                None => text.push_str(block),
            }
            changed = true;
        }
        // ZEX 旧版本补写的置顶配置已无意义（ZEX 固定全屏播放，全屏窗口天然最前），
        // 从 ZEX 托管的 conf 里移除；用户自己写的 ontop= 行不碰
        let ontop_block = "\n# 播放器窗口默认置顶（皮肤置顶按钮已去掉）\nontop=yes\n";
        if text.contains(ontop_block) {
            text = text.replace(ontop_block, "");
            changed = true;
        }
        // 旧版写的 hwdec=auto-copy 迁移到 auto（去掉显存→内存→显存的回读，见首次写入处注释）。
        // 只认整行，避免命中用户写在别处的同名子串；lines() 会吃掉行尾换行，末尾补回
        if text.contains("hwdec=auto-copy") {
            let trailing = text.ends_with('\n');
            text = text
                .lines()
                .map(|l| if l.trim() == "hwdec=auto-copy" { "hwdec=auto" } else { l })
                .collect::<Vec<_>>()
                .join("\n");
            if trailing {
                text.push('\n');
            }
            changed = true;
        }
        if changed {
            let _ = std::fs::write(&conf, text);
        }
    }
    dir
}

fn setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?", [key], |r| {
        r.get::<_, String>(0)
    })
    .optional()
    .ok()
    .flatten()
    .filter(|v| !v.trim().is_empty())
}

// ─────────────────────────────────────────────
// IPC 原语
// ─────────────────────────────────────────────

fn send(writer: &mut File, cmd: Value) -> std::io::Result<()> {
    let mut line = serde_json::to_string(&json!({ "command": cmd })).unwrap_or_default();
    line.push('\n');
    // 不能 flush：Rust File::flush 在 Windows 命名管道上映射为 FlushFileBuffers，会阻塞
    // 等待对端把缓冲内数据全部读走 —— reader 的 BufReader 暂停读取（mpv 无新事件输出）
    // 或事件积压时，flush 永不返回，而 send 在 mpv 会话锁内调用 → 锁不释放 →
    // 前端 await musicControl 永久挂起 = "点暂停即冻死整个界面" 的根因。
    // write_all 已把以 \n 结尾的整行直送管道字节流（File 无用户态缓冲），mpv 按 \n 立即解析
    writer.write_all(line.as_bytes())
}

/// 给当前会话发一条命令：每次打开一条全新 IPC 连接发送后立即关闭。
///
/// ⚠️ 为什么不能像旧实现那样复用会话共享的 writer 连接（s.writer，与 reader 同一条连接）：
/// mpv 暂停后，其 IPC 连接线程会停在「往 mpv→ZEX 方向写事件」上、不再读新命令，
/// 这时往那条连接写 `set_property pause false` 会无限阻塞（实测 35s+ 不返回）。
/// 旧实现又是在 mpv 锁内写（`guard` 活到函数末尾）→ 锁被永久占用 → reader 处理事件
/// 拿不到锁、不排空管道 → mpv 更读不到命令 → 死锁成环 = "点暂停后整个界面冻住 /
/// 再点播放无响应"。
///
/// 修法：命令一律走全新连接 —— 新连接 mpv 端是新线程、管道缓冲区空，write 必然立即
/// 返回；只在取 pipe 名时短暂持锁，绝不在锁内写管道。property-change 事件按 observe
/// 广播回 reader 那条连接（observe 是 reader 连接发的），与命令来自哪条连接无关。
pub(crate) fn send_to_session(handle: &MpvHandle, cmd: Value) -> bool {
    log::debug!("[diag-stream] send_to_session 进入 {:?}", cmd);
    let pipe = {
        let guard = handle.lock();
        guard.as_ref().map(|s| s.pipe.clone())
    };
    let Some(pipe) = pipe else { return false };
    let mut file = match connect_pipe_fast(&pipe) {
        Some(f) => f,
        None => {
            log::warn!("send_to_session 连接失败：mpv 未运行或管道已消失（pipe={}）", pipe);
            return false;
        }
    };
    let ok = send(&mut file, cmd).is_ok();
    log::debug!("[diag-stream] 写管道后 ok={}", ok);
    // file 在此 drop → 连接关闭，mpv 端对应线程读到 EOF 自行收尾
    ok
}

/// 命令用的连接：会话已在运行、管道已存在 → 立即连上；mpv 已死/管道消失 →
/// 40ms 内放弃，不拖 3 秒轮询（connect_pipe）卡住前端按钮。
///
/// ⚠️ 为什么必须重试，不能像早先那样只试一次：
/// Windows 命名管道服务端同一时刻只挂一个「待接受」实例，客户端一连上，服务端线程
/// 才去创建下一个实例给后面的人用 —— 这中间有个亚毫秒空窗，此时 CreateFile 返回
/// ERROR_PIPE_BUSY。send_to_session 每条命令都新开连接，切歌时连发 5 条
/// （disable-section / vid / volume / playlist-pos / pause）必然有命令撞进空窗。
/// 实测日志：270 条命令丢 26 条，**被丢的 100% 是距上一条 <5ms 的连发命令**；
/// 丢掉 playlist-pos 时 mpv 根本没切歌，而前端已把 nowPlaying 换成新曲 →
/// music-progress 带的旧 track_id 被 updateMusicProgress 的 id 校验挡掉 →
/// 进度条永久停在 0（= "多切几首歌有概率进度条卡死"）。
/// 20×2ms：空窗是亚毫秒级的，一两次重试就过去；40ms 上限不会把等待带进会话锁。
fn connect_pipe_fast(pipe: &str) -> Option<File> {
    try_connect_pipe(pipe, 20, Duration::from_millis(2))
}

/// mpv 冷启动到创建命名管道有几百毫秒延迟，一次性 open 必然失败 —— 必须轮询等待，
/// 否则首次播放的整段进度都记不上。3s 上限：热启动连接 <100ms，超过即放弃
fn connect_pipe(pipe: &str) -> Option<File> {
    try_connect_pipe(pipe, 30, Duration::from_millis(100))
}

// ─────────────────────────────────────────────
// 空闲预热实例（WarmSlot 状态机）
// ─────────────────────────────────────────────

/// 空闲预热 mpv 的管道名持久文件：跨进程崩溃重启时靠它回收孤儿实例
fn warm_pipe_file(data_dir: &PathBuf) -> PathBuf {
    data_dir.join("mpv-warm.pipe")
}

/// 轮询等待命名管道可用（attempts × interval = 总超时）
fn try_connect_pipe(pipe: &str, attempts: u32, interval: Duration) -> Option<File> {
    for _ in 0..attempts {
        if let Ok(f) = OpenOptions::new().read(true).write(true).open(pipe) {
            return Some(f);
        }
        std::thread::sleep(interval);
    }
    None
}

/// 预热探测：轮询等 IPC 就绪。刚 spawn 的 mpv 要几百 ms 才建管道 —— "还没起来"会
/// 等到起来，"真死了"才超时判定重拉。期间检查 shutdown，应用退出时提前返回，
/// 避免 Exit 被最长 3s 的探测卡住
fn probe_warm_pipe(pipe: &str, shutdown: &AtomicBool) -> Option<File> {
    for _ in 0..10 { // 10×100ms = 1s：预热 mpv 建管道通常 <1s，超时即判失败并收尾
        if shutdown.load(Ordering::Relaxed) {
            return None;
        }
        if let Ok(f) = OpenOptions::new().read(true).write(true).open(pipe) {
            return Some(f);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    None
}

/// 快速存活探测（锁内短等待）：Idle 实例此前已确认建过管道，这里只确认还活着。
/// 短超时避免把秒级等待带进锁里（点播放的 acquire 会被锁阻塞）
fn quick_probe(pipe: &str, shutdown: &AtomicBool) -> bool {
    for _ in 0..2 {
        if shutdown.load(Ordering::Relaxed) {
            return false;
        }
        if OpenOptions::new().read(true).write(true).open(pipe).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

/// 拉一个空闲 mpv（不弹窗、不占任务栏）。配置/皮肤在启动时加载完毕，
/// 点播放时只需 loadlist，免去进程 + 库 + 皮肤脚本的冷启动等待
fn spawn_warm_mpv(app: &AppHandle, data_dir: &PathBuf) -> Option<String> {
    let mpv_exe = resolve_mpv(app)?;
    let config_dir = ensure_config_dir(app, data_dir);
    let (hwdec, hdr, slang, alang) = {
        let state = app.state::<AppState>();
        let conn = state.db.lock();
        (
            setting(&conn, "mpv_hwdec"),
            setting(&conn, "mpv_hdr"),
            setting(&conn, "mpv_slang"),
            setting(&conn, "mpv_alang"),
        )
    };
    // 唯一管道名：与任何会话/旧实例都不冲突
    let pipe = format!(r"\\.\pipe\zex-mpv-warm-{}", Uuid::new_v4().simple());
    let mut cmd = std::process::Command::new(&mpv_exe);
    cmd.arg("--idle=yes") // 空闲等命令，无文件时不建窗
        .arg("--ontop=yes") // 预热实例是后台常驻进程，窗口懒建时不一定天然最前 → 强制置顶盖住 ZEX
        .arg("--input-gamepad=yes") // SDL 手柄输入；音乐播放由 ZEX 用 disable-section 屏蔽 gamepad 输入节
        .arg(format!("--input-ipc-server={}", pipe))
        .arg(format!("--config-dir={}", config_dir.display()))
        .arg("--title=${media-title}")
        .arg("--load-select=no")
        // 根因：mpv 检测到 stdin 是终端(TTY)就认为有交互式用户，idle 时会建窗显示
        // 空闲界面（ModernZ 的"拖文件播放"）。start.bat 用 start 命令给 zex 分配了
        // 控制台，默认 spawn 会把 TTY stdin 一路继承给预热 mpv → 启动后桌面弹空播放器。
        // 显式置 null 让 mpv 永远拿不到 TTY（无论 ZEX 以何种方式启动），从源头不建窗；
        // 播放时 loadfile 有视频仍会自动建窗，热启动不受影响
        .stdin(std::process::Stdio::null());
    if hwdec.as_deref() == Some("no") {
        cmd.arg("--hwdec=no");
    }
    if hdr.as_deref() == Some("0") {
        cmd.arg("--target-colorspace-hint=no");
    }
    if let Some(s) = slang {
        cmd.arg(format!("--slang={}", s));
    }
    if let Some(a) = alang {
        cmd.arg(format!("--alang={}", a));
    }
    if let Some(dir) = mpv_exe.parent() {
        cmd.current_dir(dir);
    }
    if cmd.spawn().is_err() {
        return None;
    }
    let _ = std::fs::write(warm_pipe_file(data_dir), &pipe);
    Some(pipe)
}

// 锁外 spawn 慢路径的串行锁：保证任何时刻最多拉一个实例（ensure 补拉与 acquire 并发
// 也不会双拉）。把 spawn 移出 WarmState 锁是关键 —— 拉起 mpv 是秒级操作，绝不能
// 放在互斥锁里阻塞点播放
static WARM_SPAWN_LOCK: Mutex<()> = Mutex::new(());

/// 给预热实例发 quit（probe 超时收尾 / 优雅关闭）。实例刚拉起来可能还没建好管道，
/// 连不上就交给 kill_warm_processes 强杀兜底
fn quit_pipe(pipe: &str) {
    if let Some(mut f) = try_connect_pipe(pipe, 3, Duration::from_millis(100)) {
        let _ = send(&mut f, json!(["quit"]));
    }
}

/// 强杀命令行含 zex-mpv-warm（预热管道）的 mpv 进程。
/// pipe_hint 只匹配指定管道（probe 超时收尾）；None = 杀全部预热（退出清理）。
/// 播放会话的管道是 zex-mpv-（不含 warm），绝不会被误杀
fn kill_warm_processes(pipe_hint: Option<&str>) -> usize {
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let mut killed = 0;
    for (_, process) in sys.processes() {
        let is_mpv = process.name().to_string_lossy().to_ascii_lowercase() == "mpv.exe";
        let cmd = process.cmd();
        if !is_mpv || !cmd.iter().any(|c| c.to_string_lossy().contains("zex-mpv-warm")) {
            continue;
        }
        if let Some(hint) = pipe_hint {
            if !cmd.iter().any(|c| c.to_string_lossy().contains(hint)) {
                continue;
            }
        }
        if process.kill() {
            killed += 1;
        }
    }
    killed
}

/// 强杀命令行含 zex-mpv（随包播放器管道名）的 mpv 进程 —— 托盘「退出」的兜底，
/// 覆盖活跃播放会话 / 空闲预热 / 崩溃孤儿。注意与 kill_warm_processes 的区别：
/// 那个只杀 warm 预热（不碰正在播放的会话），这里是真正的全面销毁
pub(crate) fn kill_all_zex_mpv() -> usize {
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let mut killed = 0;
    for (_, process) in sys.processes() {
        let is_mpv = process.name().to_string_lossy().to_ascii_lowercase() == "mpv.exe";
        let cmd = process.cmd();
        if !is_mpv || !cmd.iter().any(|c| c.to_string_lossy().contains("zex-mpv")) {
            continue;
        }
        if process.kill() {
            killed += 1;
        }
    }
    killed
}

/// 统计命令行含 zex-mpv 的 mpv 进程数（退出时判断是否都退干净了）
fn mpv_zex_processes() -> usize {
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    sys.processes()
        .values()
        .filter(|p| {
            p.name().to_string_lossy().to_ascii_lowercase() == "mpv.exe"
                && p.cmd().iter().any(|c| c.to_string_lossy().contains("zex-mpv"))
        })
        .count()
}

/// 空闲预热实例状态机。状态判断/回写在锁内完成（快速），拉起进程在锁外（慢操作）
/// 由 WARM_SPAWN_LOCK 串行化，任何时刻最多拉一个空闲实例
pub struct WarmSlot {
    state: Mutex<WarmState>,
    shutdown: AtomicBool,
}

enum WarmState {
    /// 没有空闲实例
    Empty,
    /// 有一个空闲 mpv（管道名）。**约定：只有完全空闲的实例才处于 Idle**
    Idle(String),
    /// 已被点播放领走 → 是活跃会话，归 state.mpv 管
    Consumed,
}

impl WarmSlot {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(WarmState::Empty),
            shutdown: AtomicBool::new(false),
        }
    }

    pub fn shutdown(&self) -> bool {
        self.shutdown.load(Ordering::Relaxed)
    }

    pub fn set_shutdown(&self) {
        self.shutdown.store(true, Ordering::Relaxed);
    }

    /// 确保有一个空闲预热实例就绪（启动线程 & 播放器退出后补拉）。
    /// 保持 Idle 不消费 —— 点播放时由 acquire 领走。
    /// 锁只做快速判断与状态回写；拉进程在锁外（WARM_SPAWN_LOCK 串行），
    /// 退出补拉不再阻塞并发的 acquire（点播放）
    pub fn ensure(&self, app: &AppHandle, data_dir: &PathBuf) -> Option<String> {
        // 快速路径：已有 Idle 且存活 → 直接用（短探测，不把秒级等待带进锁里）
        {
            let mut state = self.state.lock();
            if let WarmState::Idle(pipe) = &*state {
                if quick_probe(pipe, &self.shutdown) {
                    return Some(pipe.clone());
                }
                *state = WarmState::Empty;
            }
            if self.shutdown() {
                return None;
            }
        }
        // 慢路径：锁外串行拉实例。等 spawn 锁期间别人可能已拉好，重新检查再拉
        let _guard = WARM_SPAWN_LOCK.lock();
        {
            let mut state = self.state.lock();
            if let WarmState::Idle(pipe) = &*state {
                if quick_probe(pipe, &self.shutdown) {
                    return Some(pipe.clone());
                }
                *state = WarmState::Empty;
            }
            if self.shutdown() {
                return None;
            }
        }
        let pipe = spawn_warm_mpv(app, data_dir)?;
        if probe_warm_pipe(&pipe, &self.shutdown).is_none() {
            // 拉起的实例迟迟没就绪：杀掉不留孤儿 + 状态复位，让下次可重拉
            quit_pipe(&pipe);
            *self.state.lock() = WarmState::Empty;
            return None;
        }
        *self.state.lock() = WarmState::Idle(pipe.clone());
        Some(pipe)
    }

    /// 点播放领取空闲实例（转 Consumed）。拿不到（mpv 缺失 / 预热失败 / 已被占用）
    /// 返回 None，调用方落冷启动。
    pub fn acquire(&self, app: &AppHandle, data_dir: &PathBuf) -> Option<String> {
        // 快速路径：已有 Idle 且存活 → 领取（短探测，锁内毫秒级）
        {
            let mut state = self.state.lock();
            match &*state {
                WarmState::Idle(pipe) => {
                    if quick_probe(pipe, &self.shutdown) {
                        let p = pipe.clone();
                        *state = WarmState::Consumed;
                        return Some(p);
                    }
                    *state = WarmState::Empty;
                }
                // Consumed：活跃会话存在，正常流程被 running 分支拦下，这里仅防御
                WarmState::Consumed => return None,
                WarmState::Empty => {}
            }
            if self.shutdown() {
                return None;
            }
        }
        // 慢路径：锁外串行拉实例。等别人补拉完成（此刻已是 Idle）或自己拉一个再领取
        let _guard = WARM_SPAWN_LOCK.lock();
        {
            let mut state = self.state.lock();
            match &*state {
                WarmState::Idle(pipe) => {
                    if quick_probe(pipe, &self.shutdown) {
                        let p = pipe.clone();
                        *state = WarmState::Consumed;
                        return Some(p);
                    }
                    *state = WarmState::Empty;
                }
                WarmState::Consumed => return None,
                WarmState::Empty => {}
            }
            if self.shutdown() {
                return None;
            }
        }
        let pipe = spawn_warm_mpv(app, data_dir)?;
        if probe_warm_pipe(&pipe, &self.shutdown).is_none() {
            quit_pipe(&pipe);
            *self.state.lock() = WarmState::Empty;
            return None;
        }
        *self.state.lock() = WarmState::Consumed;
        Some(pipe)
    }

    /// 领取后连接失败等异常：把 Consumed 复位为 Empty，允许下次重新拉起
    pub fn reset(&self) {
        *self.state.lock() = WarmState::Empty;
    }

    /// 恢复预加载能力：清除 shutdown 标志（隐藏库恢复显示后调用）
    pub fn resume(&self) {
        self.shutdown.store(false, Ordering::Relaxed);
    }

    /// 停用预加载：置 shutdown 标志（后续 ensure/acquire 都拒绝）+ 杀空闲实例。
    /// 只杀 WarmState::Idle 的空闲预热；活跃播放会话（哪怕复用了 warm 进程、命令行
    /// 仍带 zex-mpv-warm）绝不动 —— 隐藏库只是藏入口，不应打断正在播的音乐/影视
    pub fn deactivate(&self) {
        self.shutdown.store(true, Ordering::Relaxed);
        // 锁内只取管道名 + 置位；quit_pipe 要等对方连上（最坏 300ms），
        // 放在锁里会让并发的 acquire（点播放）干等
        let pipe = {
            let mut state = self.state.lock();
            let pipe = match &*state {
                WarmState::Idle(p) => Some(p.clone()),
                _ => None,
            };
            *state = WarmState::Empty;
            pipe
        };
        if let Some(pipe) = pipe {
            quit_pipe(&pipe);
        }
    }

    /// ZEX 退出：收掉所有空闲预热实例（含孤儿）。活跃播放会话（命令行不含 warm）
    /// 不动 —— 保持现有"关 ZEX 后播放器继续"的行为
    pub fn quit_idle(&self) {
        // 同 deactivate：管道名取出来再放锁，等待不占锁
        let pipe = {
            let mut state = self.state.lock();
            let pipe = match &*state {
                WarmState::Idle(p) => Some(p.clone()),
                _ => None,
            };
            *state = WarmState::Empty;
            pipe
        };
        if let Some(pipe) = pipe {
            quit_pipe(&pipe);
        }
        // 兜底：枚举强杀所有 warm 预热进程 —— 覆盖 probe 超时遗留的孤儿、状态已置
        // Empty 但进程还活着的实例（只靠 Idle 状态收不干净，这就是用户看到的残留）
        kill_warm_processes(None);
    }
}

/// 启动时清理上一轮遗留的所有随包 mpv 进程（会话 + 预热）—— 全新 ZEX 进程的
/// 会话状态必然是空的，任何还挂着的 zex-mpv 都是孤儿：
///   - 预热实例：上一轮 graceful 退出 / 崩溃后残留
///   - 播放中的会话：ZEX 被强杀（start.bat 的 taskkill）时 mpv 无人管理继续在播，
///     用户"以为停了、其实在放"，新 ZEX 点播放又拉新 mpv → 双 mpv 控制错位
/// （这是"无法控制播放"的根因之一：播放条控的是新 mpv，耳朵听到的是孤儿 mpv）
/// 用户自己的 mpv（命令行不含 zex-mpv）绝不受影响
pub fn kill_stale_session_mpv() {
    let killed = kill_all_zex_mpv();
    if killed > 0 {
        log::info!("ZEX 启动清理：强杀 {} 个遗留 mpv（上一轮强杀/崩溃的孤儿）", killed);
    }
}

/// 启动时回收上一轮崩溃遗留的空闲 mpv 孤儿。**只杀空闲的**（idle-active=true）：
/// 崩溃时正在播放的实例绝不动 —— 用户可能还在看，应让它自然结束
///（注：此函数已被 kill_stale_session_mpv 取代 —— 全新 ZEX 进程的会话必然是空的，
///  任何 zex-mpv 都是孤儿，保留活跃会话反而造成双 mpv 控制错位）

// ─────────────────────────────────────────────
// 数据库读写
// ─────────────────────────────────────────────

struct EpisodeRow {
    id: String,
    series_id: String,
    local_path: String,
    watched_ms: i64,
    runtime_minutes: i32,
    season_number: i32,
    episode_number: i32,
    title: String,
    series_title: String,
    watched: bool,
}

fn load_episode(conn: &Connection, episode_id: &str) -> AppResult<EpisodeRow> {
    conn.query_row(
        "SELECT e.id, e.series_id, e.local_path, e.watched_ms, e.runtime_minutes,
                s.season_number, e.episode_number, e.title, sr.title, e.watched
         FROM episodes e
         JOIN seasons s ON s.id = e.season_id
         JOIN series sr ON sr.id = e.series_id
         WHERE e.id = ?1",
        [episode_id],
        |r| {
            Ok(EpisodeRow {
                id: r.get(0)?,
                series_id: r.get(1)?,
                local_path: r.get(2)?,
                watched_ms: r.get(3)?,
                runtime_minutes: r.get(4)?,
                season_number: r.get(5)?,
                episode_number: r.get(6)?,
                title: r.get(7)?,
                series_title: r.get(8)?,
                watched: r.get::<_, i32>(9)? != 0,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::Custom("找不到该集".into()))
}

/// 整部剧的所有本地剧集，按 (季号, 集号) 排序 —— 组成播放列表的主体，
/// 让播放器的列表菜单有内容、prev/next 能切集。没本地文件的集进不了列表
fn load_series_episodes(conn: &Connection, series_id: &str) -> Vec<EpisodeRow> {
    let mut stmt = match conn.prepare(
        "SELECT e.id, e.series_id, e.local_path, e.watched_ms, e.runtime_minutes,
                s.season_number, e.episode_number, e.title, sr.title, e.watched
         FROM episodes e
         JOIN seasons s ON s.id = e.season_id
         JOIN series sr ON sr.id = e.series_id
         WHERE e.series_id = ?1 AND e.local_path <> ''
         ORDER BY s.season_number, e.episode_number",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = match stmt.query_map(params![series_id], |r| {
        Ok(EpisodeRow {
            id: r.get(0)?,
            series_id: r.get(1)?,
            local_path: r.get(2)?,
            watched_ms: r.get(3)?,
            runtime_minutes: r.get(4)?,
            season_number: r.get(5)?,
            episode_number: r.get(6)?,
            title: r.get(7)?,
            series_title: r.get(8)?,
            watched: r.get::<_, i32>(9)? != 0,
        })
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    rows.filter_map(|r| r.ok()).collect()
}

/// 把整季剧集写成 m3u 播放列表（EXTINF 带中文剧集标题，列表菜单里显示中文）。
/// 路径统一正斜杠，Windows 上 mpv 也认
fn write_playlist_m3u(data_dir: &PathBuf, entries: &[PlaylistEntry]) -> PathBuf {
    let path = data_dir.join("mpv").join("queue.m3u");
    let mut content = String::from("#EXTM3U\n");
    for e in entries {
        content.push_str(&format!(
            "#EXTINF:0,{}\n{}\n",
            e.label,
            e.local_path.replace('\\', "/")
        ));
    }
    let _ = std::fs::write(&path, content);
    path
}

/// 播放列表边车：把 m3u 装不下的字段写成 JSON 给播放器的抽屉用。
/// **数组下标必须和 m3u 行序严格一致** —— Lua 侧直接拿 playlist 下标索引，
/// count 供它做一致性校验（对不上就退回纯标题模式）。
/// 与 write_playlist_m3u 成对调用，任何重写 m3u 的地方都要跟着重写这里
fn write_playlist_meta(data_dir: &PathBuf, entries: &[PlaylistEntry]) {
    let items: Vec<Value> = entries
        .iter()
        .map(|e| {
            json!({
                "s": e.season_number,
                "e": e.episode_number,
                "t": e.title,
                "w": e.watched,
                "ms": e.watched_ms,
                "rt": e.runtime_minutes,
            })
        })
        .collect();
    let doc = json!({ "count": items.len(), "items": items });
    let path = data_dir.join("mpv").join("queue.json");
    if let Ok(text) = serde_json::to_string(&doc) {
        let _ = std::fs::write(&path, text);
    }
}

/// 整季本地剧集 → 播放列表项（带中文标签；续播位置切集时现算，保证是最新的 watched_ms）
fn build_playlist(conn: &Connection, series_id: &str) -> Vec<PlaylistEntry> {
    load_series_episodes(conn, series_id)
        .into_iter()
        .map(|r| {
            let label = label_of(&r);
            PlaylistEntry {
                episode_id: r.id,
                local_path: r.local_path,
                label,
                season_number: r.season_number,
                episode_number: r.episode_number,
                title: r.title,
                watched: r.watched,
                watched_ms: r.watched_ms,
                runtime_minutes: r.runtime_minutes,
            }
        })
        .collect()
}

/// 重写某部剧的边车 JSON。标记已看/换集之后调用 —— 抽屉里的勾和进度条
/// 才跟得上。m3u 内容不受影响（曲目集合没变），所以只重写 JSON。
///
/// 整季重建：只在集合本身可能变了的场景用（整季批量标记、集列表变动）。
/// 单集状态变化走 refresh_playlist_meta_entry —— 全量重建要重查整季 + 重算所有标签，
/// 433 集的剧每次换集都跑两次
pub fn refresh_playlist_meta(db: &Arc<Mutex<Connection>>, data_dir: &PathBuf, series_id: &str) {
    let entries = {
        let conn = db.lock();
        build_playlist(&conn, series_id)
    };
    write_playlist_meta(data_dir, &entries);
}

/// 单集增量更新：只把某一集的 watched / watched_ms 同步进内存播放列表，再重写边车。
///
/// 内存里的 Session.playlist 与 queue.json 的行序严格一致（见 write_playlist_meta），
/// 所以状态变化不必回库重建整季 —— 就地改那一项即可。改不到（不是当前播放的剧、
/// 或播放器没开）返回 false，调用方按需回退整季重建
fn refresh_playlist_meta_entry(
    handle: &MpvHandle,
    data_dir: &PathBuf,
    episode_id: &str,
    watched: Option<bool>,
    watched_ms: Option<i64>,
) -> bool {
    let entries = {
        let mut guard = handle.lock();
        let Some(s) = guard.as_mut() else { return false };
        let Some(item) = s.playlist.iter_mut().find(|e| e.episode_id == episode_id) else {
            return false;
        };
        if let Some(w) = watched {
            item.watched = w;
        }
        if let Some(ms) = watched_ms {
            item.watched_ms = ms;
        }
        s.playlist.clone()
    };
    write_playlist_meta(data_dir, &entries);
    true
}

/// 手动标记已看/未看后的边车同步入口（lib.rs 的 mark_episode_watched 等调用）。
/// 播放器开着时，抽屉里的勾要跟着变 —— 只有标记的是当前播放列表里的剧才重写边车。
/// 找不到该集（不是当前播放的剧，或播放器没开）时什么都不做
pub fn refresh_playlist_meta_for_episode(
    data_dir: &PathBuf,
    mpv: &MpvHandle,
    episode_id: &str,
    watched: bool,
) {
    // 与 lib.rs 的 UPDATE 同步：标记已看/未看都把续播点清 0
    refresh_playlist_meta_entry(mpv, data_dir, episode_id, Some(watched), Some(0));
}

// 会话表已移除（统计只保留时长与次数，不记录时间维度）。
// 这两个函数保留是为了不动事件循环里的调用链：开始播放时仍生成一个 id 作为
// 本次播放的标识（flush 用它判断是否同一次播放），但不再落库
fn open_session(_conn: &Connection, _ep: &EpisodeRow) -> String {
    Uuid::new_v4().to_string()
}

fn close_session(_conn: &Connection, _session_id: &str) {}

// ── 音乐：次数记在 tracks.play_count 上（原先靠数 music_sessions 行数）──

fn open_music_session(conn: &Connection, track_id: &str) -> String {
    // 开始播放即计一次。与游戏 play_count 的语义一致（启动即 +1，不管播多久）
    let _ = conn.execute(
        "UPDATE tracks SET play_count = play_count + 1 WHERE id = ?1",
        [track_id],
    );
    Uuid::new_v4().to_string()
}

fn close_music_session(_conn: &Connection, _session_id: &str) {}

// ─────────────────────────────────────────────
// 事件循环
// ─────────────────────────────────────────────

/// 一次播放的记账状态。watched 秒数是增量写的 —— mpv 被强杀时时长已经落库，
/// 不依赖退出时的结算
struct Tally {
    position: f64,
    duration: f64,
    accumulated: f64,
    written: f64,
    last_tick: Option<Instant>,
    last_flush: Instant,
}

impl Tally {
    fn new() -> Self {
        Self {
            position: 0.0,
            duration: 0.0,
            accumulated: 0.0,
            written: 0.0,
            last_tick: None,
            last_flush: Instant::now(),
        }
    }

    fn reset_for_new_file(&mut self) {
        self.position = 0.0;
        self.duration = 0.0;
        self.last_tick = None;
    }
}

/// 播放浮条上显示的一行文字（也是 m3u EXTINF 标题 → 播放列表菜单 / 全屏顶部栏）
fn label_of(ep: &EpisodeRow) -> String {
    format!(
        "{} S{:02}E{:02} {}",
        ep.series_title, ep.season_number, ep.episode_number, ep.title
    )
}

fn flush(
    db: &Arc<Mutex<Connection>>,
    app: &AppHandle,
    episode_id: &str,
    label: &str,
    series_id: &str,
    _session_id: &str,
    t: &mut Tally,
) {
    let delta = t.accumulated - t.written;
    let conn = db.lock();
    let _ = conn.execute(
        "UPDATE episodes SET watched_ms = ?1, last_watched_at = datetime('now') WHERE id = ?2",
        params![(t.position * 1000.0) as i64, episode_id],
    );
    if delta >= 1.0 {
        let _ = conn.execute(
            "UPDATE series SET total_seconds = total_seconds + ?1 WHERE id = ?2",
            params![delta as i64, series_id],
        );
        t.written += (delta as i64) as f64;
    }
    drop(conn);

    let _ = app.emit(
        "watch-progress",
        ProgressPayload {
            episode_id: episode_id.to_string(),
            label: label.to_string(),
            position_ms: (t.position * 1000.0) as i64,
            duration_ms: (t.duration * 1000.0) as i64,
        },
    );
    t.last_flush = Instant::now();
}

/// 换集：离开当前集前结算+关会话，然后为新集开会话，并登记续播位置。
/// 唯一调用点是 playlist-pos 变化 —— 播放器 prev/next、自动连播、ZEX 中途点别的集
/// 都会先让 mpv 的 playlist-pos 动起来，这里统一轮换，避免各路径写错会话
fn rotate_to(
    db: &Arc<Mutex<Connection>>,
    app: &AppHandle,
    handle: &MpvHandle,
    episode_id: &mut String,
    label: &mut String,
    series_id: &mut String,
    session_id: &mut String,
    t: &mut Tally,
    pos: usize,
) {
    // last_tick 为空说明还没真正开始播（首个文件），position 还是 0，
    // 这时候 flush 会把续播点清成 0
    if t.last_tick.is_some() {
        flush(db, app, episode_id, label, series_id, session_id, t);
    }
    let target_id = {
        let guard = handle.lock();
        guard
            .as_ref()
            .and_then(|s| s.playlist.get(pos))
            .map(|e| e.episode_id.clone())
    };
    let Some(target_id) = target_id else { return };
    let rotated = {
        let conn = db.lock();
        load_episode(&conn, &target_id).ok().map(|ep| {
            close_session(&conn, session_id);
            (open_session(&conn, &ep), ep)
        })
    };
    let Some((new_session, ep)) = rotated else { return };
    let new_episode_id = ep.id.clone();
    let new_label = label_of(&ep);
    let new_series_id = ep.series_id.clone();
    *session_id = new_session.clone();
    *episode_id = new_episode_id.clone();
    *label = new_label.clone();
    *series_id = new_series_id.clone();
    t.accumulated = 0.0;
    t.written = 0.0;
    t.reset_for_new_file();
    let resume = resume_seconds(&ep);
    {
        let mut guard = handle.lock();
        if let Some(s) = guard.as_mut() {
            s.episode_id = new_episode_id;
            s.label = new_label;
            s.series_id = new_series_id;
            s.session_id = new_session;
            s.playlist_pos = pos;
            s.pending_seek = resume;
        }
    }
    let _ = app.emit("episode-changed", &*episode_id);
}

// ── 音乐记账与换曲（与影视版 flush/rotate_to 对位，走 tracks 的 total_seconds / play_count）──

#[derive(Clone, Serialize)]
struct MusicProgressPayload {
    track_id: String,
    position_ms: i64,
    duration_ms: i64,
    /// 真实播放状态（!pause）。mpv 的 pause 会被 seek/paused-for-cache 自动改变，
    /// 前端 playing 必须以这里为准
    playing: bool,
}

fn flush_music(
    db: &Arc<Mutex<Connection>>,
    track_id: &str,
    _session_id: &str,
    t: &mut Tally,
) {
    let delta = t.accumulated - t.written;
    let conn = db.lock();
    if delta >= 1.0 {
        let _ = conn.execute(
            "UPDATE tracks SET total_seconds = total_seconds + ?1 WHERE id = ?2",
            params![delta as i64, track_id],
        );
        t.written += (delta as i64) as f64;
    }
    drop(conn);
    t.last_flush = Instant::now();
}

/// 音乐换曲：关旧 music_session、开新、更新 Session 字段，emit music-track-changed。
/// 音乐无续播位置，pending_seek 恒为 None
fn rotate_music_to(
    db: &Arc<Mutex<Connection>>,
    app: &AppHandle,
    handle: &MpvHandle,
    track_id: &mut String,
    label: &mut String,
    session_id: &mut String,
    t: &mut Tally,
    pos: usize,
) {
    if t.last_tick.is_some() {
        flush_music(db, track_id, session_id, t);
    }
    let target = {
        let guard = handle.lock();
        guard
            .as_ref()
            .and_then(|s| s.playlist.get(pos))
            .map(|e| (e.episode_id.clone(), e.label.clone()))
    };
    let Some((new_id, new_label)) = target else { return };
    let new_session = {
        let conn = db.lock();
        close_music_session(&conn, session_id);
        open_music_session(&conn, &new_id)
    };
    *track_id = new_id.clone();
    *label = new_label.clone();
    *session_id = new_session.clone();
    t.accumulated = 0.0;
    t.written = 0.0;
    t.reset_for_new_file();
    {
        let mut guard = handle.lock();
        if let Some(s) = guard.as_mut() {
            s.episode_id = new_id.clone();
            s.label = new_label;
            s.session_id = new_session;
            s.playlist_pos = pos;
            s.pending_seek = None;
        }
    }
    // 换曲瞬间快照复位：进度 0、播放中（加载完成后 reader 的 time-pos 立即刷新真值）
    update_music_snapshot(new_id.clone(), 0, true);
    let _ = app.emit("music-track-changed", &new_id);
}

fn spawn_reader(
    app: AppHandle,
    handle: MpvHandle,
    db: Arc<Mutex<Connection>>,
    warm: Arc<WarmSlot>,
    pipe: String,
    data_dir: PathBuf,
    pre_reader: Option<File>,
) {
    std::thread::spawn(move || {
        // 预热路径：调用方已连好管道并写入 writer，直接复用；冷启动：自己轮询连接
        let Some(file) = pre_reader.or_else(|| connect_pipe(&pipe)) else {
            log::warn!("mpv IPC 管道连接超时: {}", pipe);
            return;
        };
        log::debug!("[diag] reader 启动，已拿到管道 file pipe={}", pipe);
        {
            let mut guard = handle.lock();
            match guard.as_mut() {
                Some(s) if s.pipe == pipe => {
                    if s.writer.is_none() {
                        let Ok(w) = file.try_clone() else { return };
                        s.writer = Some(w);
                    }
                }
                _ => return, // 已经是另一个会话了，这个线程作废
            }
        }
        log::debug!("[diag] reader 会话匹配，开始发 observe + 进循环 pipe={}", pipe);

        // 输入节按会话模式激活（mpv 的 {gamepad} 节默认禁用，不 enable 则手柄
        // 按键事件到达但报 No key binding found）：影视 → enable 手柄绑定；
        // 音乐 → disable 屏蔽（音乐播放时手柄交给 mpv 内建也不该动播放列表）。
        // 统一在这里兜底，覆盖冷启动影视路径 —— 热启动 1799 / 音乐 2169 等处的
        // 显式 enable/disable 保持不动（重复设置无害）
        //
        // ⚠️ 死锁警告：不能写成 `if let Some(mode) = handle.lock().as_ref().map(|s| s.mode) { send_to_session(&handle, ...) }`
        // —— `handle.lock()` 的 guard 作为 if let 临时值会一直活到整个 if body 结束才释放，
        // 而块内 send_to_session 内部又 `handle.lock()` 同一把 parking_lot Mutex（不可重入）→
        // 永久死锁。必须先把 mode 取出来、释放锁，再去调 send_to_session
        let mode = handle.lock().as_ref().map(|s| s.mode);
        if let Some(mode) = mode {
            let cmd = if mode == SessionMode::Video { "enable-section" } else { "disable-section" };
            let _ = send_to_session(&handle, json!([cmd, "gamepad"]));
        }

        // 关键架构：observe_property 命令必须通过 reader 这条 IPC 连接发出。
        // mpv 的 Windows 命名管道 IPC 是 per-connection 会话 —— 客户端发命令、mpv 把对应的
        // property-change 事件推回同一条连接。如果用 session 的 writer 连接发 observe，事件
        // 会被推到 writer 那条，而 reader（在另一条连接上 BufReader 读）永远读不到 → 进度卡 0。
        // 所以这里必须用 reader 自己持有的 file 句柄裸 send observe（不经 send_to_session，
        // 否则会用 session writer 那条独立连接）。
        let mut reader_writer = match file.try_clone() {
            Ok(w) => w,
            Err(_) => return,
        };
        log::debug!("[diag] reader 用自己连接发 observe");
        // time-pos 在播放时约每秒推一次，暂停时不推 —— 这正好是我们记账要的节奏。
        // playlist-pos 变化 = 换集，是会话轮换的唯一同步点。
        // vo-configured = 视频输出已配置（窗口已创建显示）：mpv-ready 就绪信号的来源。
        // 不能用 duration 当信号 —— 文件元数据解析远早于窗口创建，会先藏 ZEX、窗口还没出 → 闪桌面
        for (id, prop) in [
            (1, "time-pos"),
            (2, "duration"),
            (3, "playlist-pos"),
            (4, "vo-configured"),
            // 播放器窗口句柄（win32 VO 返回 HWND）：loadfile 建窗时推送，用来把键盘焦点交给 mpv
            (5, "window-id"),
            // 暂停/播放状态：mpv 的 pause 会被 seek/paused-for-cache 自动改变，
            // 音乐模式的 music-progress 要带真实 playing，前端据此纠正按钮状态
            (6, "pause"),
        ] {
            let _ = send(&mut reader_writer, json!(["observe_property", id, prop]));
        }
        drop(reader_writer);

        let (mut episode_id, mut label, mut series_id, mut session_id) = {
            let guard = handle.lock();
            match guard.as_ref() {
                Some(s) => (
                    s.episode_id.clone(),
                    s.label.clone(),
                    s.series_id.clone(),
                    s.session_id.clone(),
                ),
                None => return,
            }
        };
        // 会话模式从 Session 实时读：影视 ↔ 音乐切换复用同一进程与 reader，
        // mode 开捕捉一次会拿到旧值，导致后续记账走错表
        let mode = || {
            handle
                .lock()
                .as_ref()
                .map(|s| s.mode)
                .unwrap_or(SessionMode::Video)
        };

        let mut t = Tally::new();
        let reader = BufReader::new(file);
        log::debug!("[diag] reader 已建 BufReader，进入读循环");
        // mpv 收到 quit 后先发 end-file reason=quit（窗口还没销毁、进程还没退），
        // 这时就把 ZEX 唤回、与 mpv 拆除并行，消灭退出瞬间的桌面空窗。
        // 记录已提前唤回，EOF 收尾时不再重复发 mpv-closed
        let mut quit_notified = false;
        // mpv 首次把视频输出配置好（vo-configured）＝窗口已创建并全屏显示。
        // 通知前端此刻再收 ZEX —— 与播放器启动并行，点播放进全屏不再闪桌面
        let mut startup_ready_emitted = false;
        // 键盘焦点是否已交给 mpv（window-id 首次 >0 时给一次）。mpv 是 ZEX 的
        // 子进程，自己抢焦点会被 Windows 拦下，得由前台进程（ZEX）代抢。
        // mpv_hwnd 缓存窗口句柄，供 vo-configured 兜底再抢一次
        let mut mpv_focus_given = false;
        let mut mpv_hwnd: i64 = 0;
        // 最近一次观察到的 pause 状态（初始订阅会推当前值，这里兜底默认 false）
        let mut paused = false;
        let mut first_line_seen = false;
        let mut time_pos_logged = false;
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if !first_line_seen {
                first_line_seen = true;
                log::debug!("[diag] reader 读到首行：{}", &line[..line.len().min(160)]);
            }
            let Ok(v): Result<Value, _> = serde_json::from_str(&line) else {
                continue;
            };

            match v.get("event").and_then(Value::as_str) {
                Some("property-change") => {
                    let name = v.get("name").and_then(Value::as_str).unwrap_or("");
                    // vo-configured 等布尔属性在 JSON IPC 里是 true/false 而不是数字，
                    // as_f64 会拿不到 → 布尔兼容解析：true→1.0，false→0.0
                    let data = v.get("data").and_then(|d| match d {
                        Value::Number(n) => n.as_f64(),
                        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
                        _ => None,
                    });
                    match (name, data) {
                        ("time-pos", Some(pos)) => {
                            if !time_pos_logged {
                                time_pos_logged = true;
                                log::debug!("[diag] reader 首次收到 time-pos={}", pos);
                            }
                            t.position = pos;
                            let now = Instant::now();
                            if let Some(prev) = t.last_tick {
                                let dt = now.duration_since(prev).as_secs_f64();
                                if dt < TICK_GAP_MAX {
                                    t.accumulated += dt;
                                }
                            }
                            t.last_tick = Some(now);
                            // 音乐模式：每秒推一次进度给播放条（进度显示不受 5 秒落库节奏拖累）。
                            // 落库仍走下方 flush_music（每 5 秒），两件事互不阻塞
                            if mode() == SessionMode::Music {
                                // seek 期间丢弃「seek 前的旧位置滞留事件」：mpv#15253 指出
                                // set_property time-pos 后，管道里可能还排着 seek 前发出的旧
                                // time-pos，seek 后才送达。不丢的话前端会弹回原位置再跳目标。
                                // pos 落到 ≥ 目标即视为 seek 完成；3 秒内一直没到位则超时兜底
                                let stale = {
                                    let mut guard = handle.lock();
                                    let (is_stale, clear) = match guard.as_mut().and_then(|s| s.seek) {
                                        Some((target, deadline)) => {
                                            if pos + 0.2 < target {
                                                // 旧值滞留；超时则不再丢，强制到位兜底
                                                (Instant::now() < deadline, Instant::now() >= deadline)
                                            } else {
                                                // 已到目标：seek 完成，恢复正常推送
                                                (false, true)
                                            }
                                        }
                                        None => (false, false),
                                    };
                                    if clear {
                                        if let Some(s) = guard.as_mut() {
                                            s.seek = None;
                                        }
                                    }
                                    is_stale
                                };
                                if !stale {
                                    update_music_snapshot(
                                        episode_id.clone(),
                                        (pos * 1000.0) as i64,
                                        !paused,
                                    );
                                    let _ = app.emit(
                                        "music-progress",
                                        MusicProgressPayload {
                                            track_id: episode_id.clone(),
                                            position_ms: (pos * 1000.0) as i64,
                                            duration_ms: (t.duration * 1000.0) as i64,
                                            playing: !paused,
                                        },
                                    );
                                }
                            }
                            if now.duration_since(t.last_flush) >= FLUSH_INTERVAL {
                                if mode() == SessionMode::Music {
                                    flush_music(&db, &episode_id, &session_id, &mut t);
                                } else {
                                    flush(&db, &app, &episode_id, &label, &series_id, &session_id, &mut t);
                                }
                            }
                        }
                        ("duration", Some(d)) if d > 0.0 => {
                            t.duration = d;
                            // 续播兜底：reader 可能错过首个 file-loaded（连接太晚）。
                            // observe 订阅会立即推送当前 duration（没加载就等加载后变化），
                            // 所以这里必然触发，把还没应用的续播位置补上。
                            // 旋转切集时 rotate_to 会设新的 pending_seek，同样在此落位。
                            // 和 file-loaded 分支是竞争关系，谁先 take 谁生效，位置一致
                            let seek = {
                                let mut guard = handle.lock();
                                guard.as_mut().and_then(|s| s.pending_seek.take())
                            };
                            if let Some(pos) = seek {
                                send_to_session(
                                    &handle,
                                    json!(["set_property", "time-pos", pos]),
                                );
                            }
                            // 影视：拿真实时长补上 runtime_minutes（音乐曲目的 duration_seconds 已入库）
                            if mode() == SessionMode::Video {
                                let conn = db.lock();
                                let _ = conn.execute(
                                    "UPDATE episodes SET runtime_minutes = ?1
                                     WHERE id = ?2 AND runtime_minutes = 0",
                                    params![(d / 60.0).round() as i64, episode_id],
                                );
                            }
                        }
                        // 换集同步点：播放器 prev/next、自动连播、ZEX 中途切集都会让
                        // mpv 的 playlist-pos 变。初始订阅会推一次当前值，和会话一致就跳过。
                        // -1 表示列表被替换/还没有当前项（转成 usize 会变 0），必须忽略。
                        // pending_jump 置位时只认目标下标，跳过重建期间的中间位置
                        ("playlist-pos", Some(raw)) if raw >= 0.0 => {
                            let pos = raw as usize;
                            let need_rotate = {
                                let mut guard = handle.lock();
                                match guard.as_mut() {
                                    Some(s) if s.pending_jump.is_some() => {
                                        if s.pending_jump == Some(pos) {
                                            s.pending_jump = None;
                                            pos < s.playlist.len()
                                        } else {
                                            false
                                        }
                                    }
                                    Some(s) => s.playlist_pos != pos && pos < s.playlist.len(),
                                    None => false,
                                }
                            };
                            if need_rotate {
                                if mode() == SessionMode::Music {
                                    rotate_music_to(
                                        &db, &app, &handle,
                                        &mut episode_id, &mut label, &mut session_id,
                                        &mut t, pos,
                                    );
                                } else {
                                    // rotate_to 会把 episode_id 改成新集，离开的那一集
                                    // 要在轮换前记下来
                                    let left_id = episode_id.clone();
                                    let left_ms = (t.position * 1000.0) as i64;
                                    rotate_to(
                                        &db, &app, &handle,
                                        &mut episode_id, &mut label, &mut series_id, &mut session_id,
                                        &mut t, pos,
                                    );
                                    // 离开的那一集刚 flush 过续播位置 —— 同步进边车，
                                    // 抽屉里的进度条才是最新的。只有这一项变了，不必重建整季
                                    refresh_playlist_meta_entry(
                                        &handle, &data_dir, &left_id, None, Some(left_ms),
                                    );
                                }
                            }
                        }
                        ("playlist-pos", Some(_)) => {} // -1：忽略
                        // 播放器窗口已创建（句柄 >0）：ZEX 还是前台进程，此刻把键盘焦点
                        // 交给 mpv —— 子进程自己 SetForegroundWindow 会被 Windows 拦下，
                        // 否则用户按 Esc/空格等键落在桌面或 ZEX 上（点一下播放器才恢复）
                        ("window-id", Some(h)) if h > 0.0 => {
                            mpv_hwnd = h as i64;
                            if !mpv_focus_given {
                                mpv_focus_given = true;
                                focus_mpv_window(mpv_hwnd);
                            }
                        }
                        // mpv 视频输出已配置 = 窗口已创建显示（首次播放早于任何渲染帧，
                        // 用 duration 当信号会先藏 ZEX、窗口还没起 → 闪桌面）。此刻才收 ZEX
                        ("vo-configured", Some(v)) if v > 0.0 => {
                            if !startup_ready_emitted {
                                startup_ready_emitted = true;
                                // 兜底：window-id 推送若晚于这里（极端时序），此刻 ZEX 还
                                // 在前台，用缓存的句柄再抢一次焦点
                                if !mpv_focus_given && mpv_hwnd > 0 {
                                    mpv_focus_given = true;
                                    focus_mpv_window(mpv_hwnd);
                                }
                                let _ = app.emit("mpv-ready", ());
                            }
                        }
                        // 暂停/恢复：立即把真实 playing 同步给音乐播放条（不等下个秒 tick）。
                        // mpv 的 pause 会被 seek / paused-for-cache 自动改，前端必须以此为准。
                        // seek 期间 t.position 可能仍是旧值（time-pos 旧事件正被丢弃），
                        // 此时只同步 playing，位置推目标值保持前端稳定，避免弹回原位置
                        ("pause", Some(v)) => {
                            paused = v > 0.0;
                            if mode() == SessionMode::Music {
                                let pos_for_emit = {
                                    let guard = handle.lock();
                                    match guard.as_ref().and_then(|s| s.seek) {
                                        Some((target, deadline)) if t.position + 0.2 < target && Instant::now() < deadline => target,
                                        _ => t.position,
                                    }
                                };
                                update_music_snapshot(
                                    episode_id.clone(),
                                    (pos_for_emit * 1000.0) as i64,
                                    !paused,
                                );
                                let _ = app.emit(
                                    "music-progress",
                                    MusicProgressPayload {
                                        track_id: episode_id.clone(),
                                        position_ms: (pos_for_emit * 1000.0) as i64,
                                        duration_ms: (t.duration * 1000.0) as i64,
                                        playing: !paused,
                                    },
                                );
                            }
                        }
                        _ => {}
                    }
                }

                // 新文件加载完成。会话轮换已由 playlist-pos 分支提前做掉，
                // 这里只负责把续播位置 apply 上去
                Some("file-loaded") => {
                    let seek = {
                        let mut guard = handle.lock();
                        guard.as_mut().and_then(|s| s.pending_seek.take())
                    };
                    if let Some(pos) = seek {
                        send_to_session(&handle, json!(["set_property", "time-pos", pos]));
                    }
                }

                Some("end-file") => {
                    let reason = v.get("reason").and_then(Value::as_str).unwrap_or("");
                    flush(&db, &app, &episode_id, &label, &series_id, &session_id, &mut t);
                    // mpv 正在退出（点叉 / Esc / ZEX 调 quit）：立刻把 ZEX 唤回。
                    // 此刻窗口还在、进程还没退，唤回与拆除并行 → 不再闪桌面。
                    // 最终结算（收尾 flush / 关会话）仍交给 EOF 分支做
                    if reason == "quit" {
                        if !quit_notified {
                            quit_notified = true;
                            // mpv 正在退出：窗口还在（--ontop 置顶全屏），此刻把 ZEX 显示
                            // 出来会被 mpv 盖住、用户无感，但窗口可见后 WebView2 就开始
                            // 合成恢复后的界面；等 mpv 销毁（几十 ms）ZEX 无缝接上 ——
                            // 桌面和任务栏全程被盖，不再闪现。set_focus 刻意留到 EOF
                            // （mpv 还在前台抢不过，抢反而会闪任务栏图标）
                            restore_main_window(&app);
                            let _ = app.emit("mpv-closed", ());
                            // 提前补拉：mpv 还在退出的同时拉起新预热，比等 EOF 提前几百
                            // ms 到 1-2s，避开"退出后马上再点"撞上补拉窗口。EOF 分支仍会
                            // ensure 兜底（幂等 + WARM_SPAWN_LOCK 串行，不会双拉）
                            if !warm.shutdown() {
                                let warm = warm.clone();
                                let app = app.clone();
                                let data_dir = data_dir.clone();
                                std::thread::spawn(move || {
                                    let _ = warm.ensure(&app, &data_dir);
                                });
                            }
                        }
                        continue;
                    }
                    if reason != "eof" {
                        continue; // stop = 播放器自己切集；quit = 用户退出，走 EOF 收尾
                    }

                    // 看完了：标记已看并把续播点归零，免得下次点开又从片尾开始。
                    // 列表里还有项目时 mpv 会自动接下一集（keep-open 只拦最后一部），
                    // 会话轮换交给 playlist-pos 分支；这里只判断整季是否播完。
                    // 音乐模式无「已看」概念，跳过
                    if mode() == SessionMode::Video {
                        let conn = db.lock();
                        let _ = conn.execute(
                            "UPDATE episodes SET watched = 1, watched_ms = 0,
                             last_watched_at = datetime('now') WHERE id = ?1",
                            [&episode_id],
                        );
                        drop(conn);
                        // 抽屉里这一集的勾要立刻跟上（下次打开抽屉时读到的就是新的）。
                        // 与上面的 UPDATE 同步：watched=1、续播点归零
                        refresh_playlist_meta_entry(
                            &handle, &data_dir, &episode_id, Some(true), Some(0),
                        );
                    }

                    let has_next = {
                        let guard = handle.lock();
                        guard
                            .as_ref()
                            .and_then(|s| s.playlist.get(s.playlist_pos + 1))
                            .is_some()
                    };
                    if !has_next {
                        // 整季看完了 —— keep-open 停在最后一帧，主动退出
                        send_to_session(&handle, json!(["quit"]));
                        break;
                    }
                }

                _ => {}
            }
        }

        // 管道读到 EOF = mpv 进程没了。做最后一次结算并把 ZEX 窗口唤回来
        if mode() == SessionMode::Music {
            flush_music(&db, &episode_id, &session_id, &mut t);
        } else {
            flush(&db, &app, &episode_id, &label, &series_id, &session_id, &mut t);
        }
        if mode() == SessionMode::Video && t.duration > 0.0 && t.position / t.duration >= WATCHED_THRESHOLD {
            let conn = db.lock();
            let _ = conn.execute(
                "UPDATE episodes SET watched = 1, watched_ms = 0 WHERE id = ?1",
                [&episode_id],
            );
        }
        {
            // mode() 内部要拿 mpv 锁，必须在 db.lock() **之前**求值 —— 否则本线程
            // 持 db 等 mpv，而 play_episode/play_music 正持 mpv 等 db（mpv.rs:1849、
            // 2219），parking_lot 无超时无 panic，整个应用永久冻死。
            // 全局加锁顺序：先 mpv 再 db，任何时候都不要反过来
            let is_music = mode() == SessionMode::Music;
            let conn = db.lock();
            if is_music {
                close_music_session(&conn, &session_id);
            } else {
                close_session(&conn, &session_id);
            }
        }
        {
            let mut guard = handle.lock();
            if guard.as_ref().map(|s| s.pipe == pipe).unwrap_or(false) {
                *guard = None;
            }
        }
        // mpv 已真正退出（EOF）。提前路径已把窗口 show 出来（被置顶 mpv 盖着），
        // 此刻补抢焦点 —— 之前 show 时 mpv 还在前台抢不过；强杀/崩溃没走到提前
        // 路径的，这里兜底把窗口唤回来
        restore_main_window(&app);
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
        }
        // 正常退出路径已在 end-file reason=quit 时提前唤回过窗口；
        // 强杀 / 崩溃等没走到那步的，在这里兜底再唤一次
        if !quit_notified {
            let _ = app.emit("mpv-closed", ());
        }
        // 播放器已退出：后台补拉一个空闲预热实例，下一次播放仍是热启动。
        // 应用正在退出（shutdown 置位）时不补拉
        if !warm.shutdown() {
            let warm = warm.clone();
            let app = app.clone();
            let data_dir = data_dir.clone();
            std::thread::spawn(move || {
                let _ = warm.ensure(&app, &data_dir);
            });
        }
    });
}

/// mpv 退出后把 ZEX 主窗口恢复到前台（不抢焦点）。
/// 提前路径（end-file quit）调它：mpv 窗口还在销毁中（--ontop 置顶全屏），此刻
/// show 出来的 ZEX 被 mpv 盖住、用户无感，但窗口可见后 WebView2 开始合成恢复后的
/// 界面；等 mpv 销毁（几十 ms）ZEX 无缝接上 —— 桌面和任务栏全程被盖，不再闪现。
/// set_focus 刻意不在这里：mpv 还在前台时抢不过，抢反而会让 Windows 闪烁任务栏图标。
fn restore_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
    }
    // 窗口已显示 → 托盘图标让位（图标只在窗口隐藏时亮出）
    crate::set_tray_visible(app, false);
}

/// 把键盘焦点交给 mpv 窗口。mpv 是 ZEX 的子进程，Windows 限制后台进程抢焦点，
/// 所以由前台进程（ZEX）主动 SetForegroundWindow —— 否则播放器打开时没有键盘焦点，
/// 按 Esc/空格等键会被桌面或 ZEX 吃掉，点一下播放器窗口才恢复
#[cfg(windows)]
fn focus_mpv_window(hwnd: i64) {
    use windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
    unsafe {
        SetForegroundWindow(hwnd as isize as *mut std::ffi::c_void);
    }
}

#[cfg(not(windows))]
fn focus_mpv_window(_hwnd: i64) {}

/// 上次看到哪：太靠前（片头）或太靠后（片尾）都不值得续播
fn resume_seconds(ep: &EpisodeRow) -> Option<f64> {
    let secs = ep.watched_ms as f64 / 1000.0;
    if secs < 10.0 {
        return None;
    }
    let total = ep.runtime_minutes as f64 * 60.0;
    if total > 0.0 && secs > total - 30.0 {
        return None;
    }
    Some(secs)
}

// ─────────────────────────────────────────────
// Tauri Commands
// ─────────────────────────────────────────────

/// 播放入口：按设置分派到内置 mpv 或外部播放器。前端只认这一个命令。
/// mpv 没拉取到时静默回退外部播放器，不至于点了没反应
#[tauri::command(async)]
pub fn play_episode(
    app: AppHandle,
    state: State<'_, AppState>,
    episode_id: String,
) -> AppResult<()> {
    let (engine, path) = {
        let conn = state.db.lock();
        let engine = setting(&conn, "player_engine").unwrap_or_else(|| "mpv".into());
        (engine, load_episode(&conn, &episode_id)?.local_path)
    };
    if engine == "external" || resolve_mpv(&app).is_none() {
        return crate::play_video_impl(state, path);
    }
    play_episode_mpv(app, state, episode_id)
}

/// 后台补拉一个空闲预热实例：播放用掉预加载（acquire）后立即补拉、冷启动后也补拉，
/// 音乐/影视播放中始终保有一个空闲预加载 —— 切换目标类型时能热启动。
/// （当前方案：单进程音乐/影视通用，video=yes 上下文恒定，靠文件有无视频流自动建/关窗口）
pub(crate) fn ensure_warm_bg(app: AppHandle, warm: Arc<WarmSlot>, data_dir: PathBuf) {
    std::thread::spawn(move || {
        let _ = warm.ensure(&app, &data_dir);
    });
}

/// 判定 mpv 是否在运行：按会话存在性（而非 writer 就绪）。
/// 冷启动窗口（进程已拉、reader 还没连上管道）内 writer 是 None，
/// 用 `writer.is_some()` 判断会把正在启动的实例当成不在运行 →
/// 第二次点播会再拉一个进程（双 mpv）。会话只要存在就该复用，哪怕管道未就绪
fn session_active(state: &State<'_, AppState>) -> bool {
    state.mpv.lock().as_ref().is_some()
}

/// 冷启动段入口守卫：已有会话（正在启动）时拒绝再拉进程，
/// 返回错误让前端收掉「假成功」状态，绝不 spawn 第二个 mpv
fn ensure_no_session(state: &State<'_, AppState>) -> AppResult<()> {
    if session_active(state) {
        return Err(AppError::Custom("播放器正在启动，请稍候再试".into()));
    }
    Ok(())
}

pub fn play_episode_mpv(
    app: AppHandle,
    state: State<'_, AppState>,
    episode_id: String,
) -> AppResult<()> {
    let ep = {
        let conn = state.db.lock();
        load_episode(&conn, &episode_id)?
    };
    if ep.local_path.is_empty() {
        return Err(AppError::Custom("该集还没有关联本地视频文件".into()));
    }
    if !std::path::Path::new(&ep.local_path).exists() {
        return Err(AppError::Custom(format!("视频文件不存在: {}", ep.local_path)));
    }

    let resume = resume_seconds(&ep);

    // mpv 已经开着 → 复用实例换片，别再弹第二个窗口。
    // 会话轮换由 reader 的 playlist-pos 分支统一处理
    // 按「会话是否存在」判定（不是 writer 就绪）：冷启动窗口内进程已拉、管道未连，
    // writer 还是 None —— 若按 writer 判，第二次点播会走冷启动再拉一个 mpv（双进程）
    let running = session_active(&state);
    if running {
        // 复用现有进程（音乐/影视通用，video=yes 上下文保持不变）：若上一会话是音乐，先结算其 music_session
        {
            let mut guard = state.mpv.lock();
            if let Some(s) = guard.as_mut() {
                if s.mode == SessionMode::Music {
                    let conn = state.db.lock();
                    close_music_session(&conn, &s.session_id);
                    drop(conn);
                }
                s.mode = SessionMode::Video;
            }
        }
        // 全屏 + 恢复手柄控制 mpv（音乐播放时 {gamepad} 输入节被 disable）。
        // vid=auto 放到 loadlist 之后：换文件前恢复视频轨会把当前音乐封面包短暂渲染出来
        send_to_session(&state.mpv, json!(["set_property", "fullscreen", "yes"]));
        send_to_session(&state.mpv, json!(["enable-section", "gamepad"]));
        // 目标集已在本季列表里 → 直接 set playlist-pos 跳过去，无闪屏也不重建
        let in_playlist = {
            let guard = state.mpv.lock();
            guard
                .as_ref()
                .and_then(|s| s.playlist.iter().position(|e| e.episode_id == ep.id))
        };
        if let Some(idx) = in_playlist {
            {
                let mut guard = state.mpv.lock();
                if let Some(s) = guard.as_mut() {
                    s.pending_seek = resume;
                }
            }
            // 关键命令必须真实送达：mpv 刚死但管道残留时 send 可能假成功，
            // 只有 playlist-pos（真正切集）与 pause 都确认写入才允许让前端收托盘
            let ok = send_to_session(&state.mpv, json!(["set_property", "playlist-pos", idx]))
                && send_to_session(&state.mpv, json!(["set_property", "pause", false]));
            if !ok {
                log::warn!("切剧失败：播放器管道已失效，清除失效会话");
                state.mpv.lock().take();
                return Err(AppError::Custom("播放器没有在运行，请重新播放".into()));
            }
            // mpv 窗口已在全屏，ZEX 可以直接让出（前端收到后收进托盘）
            let _ = app.emit("mpv-ready", ());
            return Ok(());
        }

        // 不在当前列表（换了别的剧/列表过期）→ 重建整季列表。
        // loadlist 会先自动载入列表第一项，playlist-pos 经过中间位置；
        // 设 pending_jump 让 reader 只认目标下标，中间的忽略
        let entries = {
            let conn = state.db.lock();
            build_playlist(&conn, &ep.series_id)
        };
        let idx = entries
            .iter()
            .position(|e| e.episode_id == ep.id)
            .unwrap_or(0);
        let m3u = write_playlist_m3u(&state.data_dir, &entries);
        write_playlist_meta(&state.data_dir, &entries);
        {
            let mut guard = state.mpv.lock();
            if let Some(s) = guard.as_mut() {
                s.playlist = entries;
                s.pending_seek = resume;
                s.pending_jump = Some(idx);
            }
        }
        // loadlist 是重建列表的关键命令：失败说明播放器管道已失效（mpv 被强杀/崩溃），
        // 后续 vid/playlist-pos/pause 也发不出去 —— 立即清掉失效会话并报错，
        // 绝不能假装成功让前端收进托盘
        if !send_to_session(&state.mpv, json!(["loadlist", m3u, "replace"])) {
            log::warn!("切剧失败：loadlist 发送失败，播放器管道已失效，清除失效会话");
            state.mpv.lock().take();
            return Err(AppError::Custom("播放器没有在运行，请重新播放".into()));
        }
        // 换完文件再恢复视频轨渲染（避免换文件前 vid=auto 把当前音乐封面包短暂显示出来）
        send_to_session(&state.mpv, json!(["set_property", "vid", "auto"]));
        send_to_session(&state.mpv, json!(["set_property", "playlist-pos", idx]));
        send_to_session(&state.mpv, json!(["set_property", "pause", false]));
        // mpv 窗口已在全屏，ZEX 可以直接让出
        let _ = app.emit("mpv-ready", ());
        return Ok(());
    }
    // 跨类型（音乐→影视）也复用现有进程：加载视频（video=yes 上下文恒定，窗口自动建/全屏），
    // 不再销毁重建 —— 单进程通用，根治黑屏且切换快

    // 播放列表与设置对预热/冷启动是共用的，先算好
    let config_dir = ensure_config_dir(&app, &state.data_dir);
    let (hwdec, hdr, slang, alang) = {
        let conn = state.db.lock();
        (
            setting(&conn, "mpv_hwdec"),
            setting(&conn, "mpv_hdr"),
            setting(&conn, "mpv_slang"),
            setting(&conn, "mpv_alang"),
        )
    };

    // 整季本地剧集组成 m3u 播放列表，列表菜单有内容、能前后切集、标题是中文。
    // 从当前集所在下标开始播
    let entries = {
        let conn = state.db.lock();
        build_playlist(&conn, &ep.series_id)
    };
    let start_idx = entries
        .iter()
        .position(|e| e.episode_id == ep.id)
        .unwrap_or(0);
    let m3u = write_playlist_m3u(&state.data_dir, &entries);
    write_playlist_meta(&state.data_dir, &entries);

    // ── 预热路径：复用常驻空闲 mpv，免去进程/库/皮肤脚本冷启动 ──
    // 拿到实例就 loadlist，窗口在文件加载时直接以全屏创建。连接失败（实例刚被
    // 抢占/消失）则复位预热槽位、落冷启动，行为与旧版一致
    if let Some(warm_pipe) = state.warm.acquire(&app, &state.data_dir) {
        // 用掉预热实例后不再补拉：会话结束时 reader 的 end-file/EOF 分支会补一个，
        // 避免「活跃播放 + 空闲预热」并存两个 mpv。音乐↔影视切换走 running 分支复用同一进程
        let mut started = false;
        if let Some(file) = connect_pipe(&warm_pipe) {
            if let Ok(mut writer) = file.try_clone() {
                // 设置项以属性方式覆盖：预热实例启动时的默认值可能已过期
                if hwdec.as_deref() == Some("no") {
                    let _ = send(&mut writer, json!(["set_property", "hwdec", "no"]));
                }
                if hdr.as_deref() == Some("0") {
                    let _ = send(&mut writer, json!(["set_property", "target-colorspace-hint", "no"]));
                }
                if let Some(s) = slang.as_deref() {
                    let _ = send(&mut writer, json!(["set_property", "slang", s]));
                }
                if let Some(a) = alang.as_deref() {
                    let _ = send(&mut writer, json!(["set_property", "alang", a]));
                }
                // 全屏 + 恢复视频轨渲染 + 整季列表 + 跳到目标集 + 开始播放（通用 warm 无 --fullscreen，这里补全屏）
                let _ = send(&mut writer, json!(["set_property", "fullscreen", "yes"]));
                let _ = send(&mut writer, json!(["set_property", "vid", "auto"]));
                // 激活 {gamepad} 输入节：预热实例的该节默认禁用（mpv 设计如此），
                // 不 enable 则手柄按键事件到达但找不到绑定（No key binding found）
                let _ = send(&mut writer, json!(["enable-section", "gamepad"]));
                let _ = send(&mut writer, json!(["loadlist", m3u, "replace"]));
                let _ = send(&mut writer, json!(["set_property", "playlist-pos", start_idx]));
                let _ = send(&mut writer, json!(["set_property", "pause", false]));

                let session_id = {
                    let conn = state.db.lock();
                    open_session(&conn, &ep)
                };
                *state.mpv.lock() = Some(Session {
                    pipe: warm_pipe.clone(),
                    writer: Some(writer),
                    episode_id: ep.id.clone(),
                    label: label_of(&ep),
                    series_id: ep.series_id.clone(),
                    session_id,
                    mode: SessionMode::Video,
                    // clone：万一下面连接失败落冷启动，entries 还能复用
                    playlist: entries.clone(),
                    playlist_pos: start_idx,
                    // 续播统一走 pending_seek；pending_jump 防 loadlist 中间态误切集
                    pending_seek: resume,
                    seek: None,
                    pending_jump: Some(start_idx),
                });
                spawn_reader(
                    app.clone(),
                    state.mpv.clone(),
                    state.db.clone(),
                    state.warm.clone(),
                    warm_pipe,
                    state.data_dir.clone(),
                    Some(file),
                );
                started = true;
            }
        }
        if !started {
            state.warm.reset();
        } else {
            return Ok(());
        }
    }

    // ── 冷启动（旧路径）：mpv 缺失 / 预热失败时兜底 ──
    // 双保险：预热路径走完（未领到实例）到这里时，若期间已有会话建立
    // （并发点播），绝不再拉第二个进程
    ensure_no_session(&state)?;
    let Some(mpv_exe) = resolve_mpv(&app) else {
        return Err(AppError::Custom(
            "找不到内置播放器 mpv。请运行 scripts/fetch-mpv.sh 拉取，或在设置里改用外部播放器".into(),
        ));
    };

    // 每次启动用唯一管道名：上一轮崩溃残留的 mpv 还占着旧管道时，
    // 固定名会让我们连到那个僵尸实例上
    let pipe = format!(r"\\.\pipe\zex-mpv-{}", Uuid::new_v4().simple());

    let mut cmd = std::process::Command::new(&mpv_exe);
    cmd.arg(format!("--playlist={}", m3u.display()))
        .arg(format!("--playlist-start={}", start_idx))
        .arg("--fullscreen") // 影视冷启动直接全屏（通用进程仅此路径带，运行态切换由 set fullscreen 处理）
        .arg("--input-gamepad=yes") // 通用进程（音乐/影视共用，video=yes 上下文）；音乐由 disable-section 屏蔽手柄
        .arg(format!("--input-ipc-server={}", pipe))
        .arg(format!("--config-dir={}", config_dir.display()))
        .arg("--title=${media-title}");
        // mpv 默认窗口标题模板是「${media-title} - mpv」，会多个 " - mpv" 后缀；
        // 显式传 ${media-title} 去掉它。mpv 换集时会重新展开该属性，
        // 顶部栏自动跟随当前集，显示「剧名 S01E01 单集名称」
        // （media-title 来自 m3u EXTINF 的中文剧集标题）
    // 注意：不要用 --start 续播 —— mpv 会把 --start 重复应用到播放列表的每个项，
    // 导致切换剧集时新文件也跳到同一个位置。统一由 reader 的 pending_seek 负责
    // （duration 事件兜底，见 spawn_reader），设置项以命令行形式覆盖 mpv.conf
    // load-select=no 必须走命令行：mpv 会把 [hdr] profile 之后的所有行都算进该
    // profile，配置里写在 [hdr] 后面的话只在 HDR 片源生效，SDR 下中文菜单就丢了
    cmd.arg("--load-select=no"); // 用随包的中文 select.lua，关掉内置英文版
    // 与预热同源的根因修复：stdin 是 TTY 时 mpv 会抢占终端输入甚至干扰。
    // 冷启动本就 force-window 建窗，这里置 null 是为了杜绝 mpv 读控制台按键
    cmd.stdin(std::process::Stdio::null());
    if hwdec.as_deref() == Some("no") {
        cmd.arg("--hwdec=no");
    }
    if hdr.as_deref() == Some("0") {
        cmd.arg("--target-colorspace-hint=no");
    }
    if let Some(s) = slang {
        cmd.arg(format!("--slang={}", s));
    }
    if let Some(a) = alang {
        cmd.arg(format!("--alang={}", a));
    }
    if let Some(dir) = mpv_exe.parent() {
        cmd.current_dir(dir);
    }
    cmd.spawn()
        .map_err(|e| AppError::Custom(format!("无法启动 mpv: {}", e)))?;

    // 不在此处补拉预热：会话结束时 reader 的 end-file/EOF 分支统一补拉，
    // 保持任意时刻至多一个 mpv（活跃会话或空闲预热），冷启动会话结束后同样有热启动可用

    let session_id = {
        let conn = state.db.lock();
        open_session(&conn, &ep)
    };
    *state.mpv.lock() = Some(Session {
        pipe: pipe.clone(),
        writer: None,
        episode_id: ep.id.clone(),
        label: label_of(&ep),
        series_id: ep.series_id.clone(),
        session_id,
        mode: SessionMode::Video,
        playlist: entries,
        playlist_pos: start_idx,
        // 续播统一走 pending_seek：reader 的 duration 事件兜底，保证首个文件也会应用
        pending_seek: resume,
        seek: None,
        pending_jump: None,
    });

    spawn_reader(
        app,
        state.mpv.clone(),
        state.db.clone(),
        state.warm.clone(),
        pipe,
        state.data_dir.clone(),
        None,
    );
    Ok(())
}

#[tauri::command(async)]
pub fn mpv_load_subtitle(state: State<'_, AppState>, path: String) -> AppResult<()> {
    if !std::path::Path::new(&path).exists() {
        return Err(AppError::Custom(format!("字幕文件不存在: {}", path)));
    }
    if !send_to_session(&state.mpv, json!(["sub-add", path, "select"])) {
        return Err(AppError::Custom("播放器没在运行".into()));
    }
    Ok(())
}

#[tauri::command(async)]
pub fn mpv_quit(state: State<'_, AppState>) -> AppResult<()> {
    send_to_session(&state.mpv, json!(["quit"]));
    Ok(())
}

/// 内置播放器是否可用（设置页据此提示需不需要先拉取 mpv）
#[tauri::command(async)]
pub fn mpv_available(app: AppHandle) -> bool {
    resolve_mpv(&app).is_some()
}

/// 托盘「退出」前的彻底清理：销毁所有随包 mpv（活跃播放会话 + 空闲预热）。
/// 与「收进托盘」不同——那是窗口隐藏、进程存活、播放器继续；这里是真正退出，
/// 必须把播放器一并收掉，否则用户退出 ZEX 后 mpv 还在后台播
pub fn shutdown_all(state: &AppState) {
    // 1) 活跃会话发 quit（优雅结算：reader 的 end-file 分支会 flush 进度/会话）。
    //    走 send_to_session（全新连接、不持 mpv 锁）—— 旧实现持锁直接写 s.writer，
    //    播放器暂停时那条连接写会无限阻塞，把退出流程卡死
    let _ = send_to_session(&state.mpv, json!(["quit"]));
    // 2) 冷启动中的会话（writer=None，reader 还在 connect 管道）：尝试补发 quit
    let cold_pipe = {
        let guard = state.mpv.lock();
        guard
            .as_ref()
            .filter(|s| s.writer.is_none())
            .map(|s| s.pipe.clone())
    };
    if let Some(pipe) = cold_pipe {
        if let Some(mut f) = try_connect_pipe(&pipe, 10, Duration::from_millis(50)) {
            let _ = send(&mut f, json!(["quit"]));
        }
    }
    // 3) 防 reader 在 quit 后补拉新预热实例
    state.warm.set_shutdown();
    // 4) 轮询等 mpv 进程消失（上限 1.5s）：期间 reader 完成 quit 结算。
    //    注意 quit 的结算发生在 mpv 进程退出前（end-file reason=quit 已 flush），
    //    所以等 mpv 消失后进度/会话已经落库
    let start = Instant::now();
    loop {
        if mpv_zex_processes() == 0 {
            break;
        }
        if start.elapsed() > Duration::from_millis(1500) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    // 5) 残留强杀兜底（1.5s 内没退的卡死实例 / 孤儿），再等 reader 收尾
    let killed = kill_all_zex_mpv();
    if killed > 0 {
        log::info!("ZEX 退出清理：强杀 {} 个 mpv 进程", killed);
        std::thread::sleep(Duration::from_millis(150));
    }
}

// ─────────────────────────────────────────────
// 音乐播放（复用同一 mpv 进程，video=no 不建窗）
// ─────────────────────────────────────────────

/// 前端传入的音乐队列条目（当前排序/筛选后的曲目列表）
#[derive(Deserialize, Clone)]
pub struct MusicQueueInput {
    pub track_id: String,
    pub local_path: String,
    pub title: String,
}

/// 播放入口：队列 = 前端传来的当前曲目列表，从 target 那首开始播。
/// mpv 以 video=no 运行（纯音频不建窗），ZEX 窗口保持前台。与影视互斥，
/// 切换时复用同一进程：影视模式恢复 video=yes，音乐模式置 video=no
#[tauri::command(async)]
pub fn play_music(
    app: AppHandle,
    state: State<'_, AppState>,
    track_id: String,
    queue: Vec<MusicQueueInput>,
) -> AppResult<()> {
    let entries: Vec<PlaylistEntry> = queue
        .iter()
        .map(|q| PlaylistEntry {
            episode_id: q.track_id.clone(),
            local_path: q.local_path.clone(),
            label: q.title.clone(),
            season_number: 0,
            episode_number: 0,
            title: q.title.clone(),
            watched: false,
            watched_ms: 0,
            runtime_minutes: 0,
        })
        .collect();
    let Some(start_idx) = entries.iter().position(|e| e.episode_id == track_id) else {
        return Err(AppError::Custom("目标曲目不在队列中".into()));
    };
    let m3u = write_playlist_m3u(&state.data_dir, &entries);

    // 音量：读持久化的 music_volume（前端音量条同源），播放时应用到 mpv —— 否则复用
    // 同一进程时 mpv 音量可能是影视残留或默认 100，与音量条显示脱节
    let music_vol = {
        let conn = state.db.lock();
        setting(&conn, "music_volume")
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(70)
    };

    let running = session_active(&state);
    if running {
        // 复用现有进程（音乐/影视通用，video=yes 上下文保持不变）：若上一会话是影视，先结算其 series_session
        {
            let mut guard = state.mpv.lock();
            if let Some(s) = guard.as_mut() {
                if s.mode == SessionMode::Video {
                    let conn = state.db.lock();
                    close_session(&conn, &s.session_id);
                    drop(conn);
                }
                s.mode = SessionMode::Music;
            }
        }
        // 音乐模式：屏蔽 mpv 手柄输入节（保留 --input-gamepad，影视播放要恢复）
        send_to_session(&state.mpv, json!(["disable-section", "gamepad"]));
        // 音乐不渲染视频轨（内嵌封面会被 mpv 当视频建窗）→ vid=no；切影视时 play_episode 再 vid=auto
        send_to_session(&state.mpv, json!(["set_property", "vid", "no"]));
        // 同步音量：复用进程的 mpv 音量可能是影视残留，覆盖为持久化的音乐音量
        send_to_session(&state.mpv, json!(["set_property", "volume", music_vol]));
        let in_playlist = {
            let guard = state.mpv.lock();
            guard
                .as_ref()
                .and_then(|s| s.playlist.iter().position(|e| e.episode_id == track_id))
        };
        if let Some(idx) = in_playlist {
            // playlist-pos 是「切到哪首」的唯一载体，发失败就等于没切歌：mpv 还在放旧曲，
            // 而前端 playTrack 一旦拿到 Ok 就会把 nowPlaying 换成新曲 → 之后 mpv 推来的
            // music-progress 带的是旧 track_id，被 updateMusicProgress 的 id 校验挡掉 →
            // 进度条停在 0 再不动。所以这里必须把失败如实返回，让前端保持旧曲状态
            if !send_to_session(&state.mpv, json!(["set_property", "playlist-pos", idx])) {
                return Err(AppError::Custom("切换曲目失败：播放器没有响应".into()));
            }
            send_to_session(&state.mpv, json!(["set_property", "pause", false]));
            return Ok(());
        }
        // 不在当前列表 → 重建音乐队列
        let idx = start_idx;
        {
            let mut guard = state.mpv.lock();
            if let Some(s) = guard.as_mut() {
                s.playlist = entries;
                s.pending_jump = Some(idx);
                s.pending_seek = None;
            }
        }
        // loadlist / playlist-pos 任一发失败都要把 pending_jump 撤掉再返回错误。
        // 留着它会把会话彻底焊死：reader 的 playlist-pos 分支在 pending_jump 置位时
        // 只认目标下标，对不上就 return 且**不清除**（见 1598 行附近）—— 于是往后每次
        // 换曲事件都被这个永远等不到的 pending_jump 挡掉，会话不再轮换、
        // music-track-changed 不再发，进度条永久停在 0，点多少次都救不回来，只能重启
        let rollback_jump = |state: &State<'_, AppState>| {
            let mut guard = state.mpv.lock();
            if let Some(s) = guard.as_mut() {
                s.pending_jump = None;
            }
        };
        if !send_to_session(&state.mpv, json!(["loadlist", m3u, "replace"])) {
            rollback_jump(&state);
            return Err(AppError::Custom("加载播放队列失败：播放器没有响应".into()));
        }
        if !send_to_session(&state.mpv, json!(["set_property", "playlist-pos", idx])) {
            rollback_jump(&state);
            return Err(AppError::Custom("切换曲目失败：播放器没有响应".into()));
        }
        send_to_session(&state.mpv, json!(["set_property", "pause", false]));
        return Ok(());
    }

    // ── 预热路径：复用常驻空闲 mpv ──
    if let Some(warm_pipe) = state.warm.acquire(&app, &state.data_dir) {
        // 用掉预热实例后不再补拉：会话结束时 reader 的 end-file/EOF 分支会补一个，
        // 避免「活跃播放 + 空闲预热」并存两个 mpv。音乐↔影视切换走 running 分支复用同一进程
        let mut started = false;
        if let Some(file) = connect_pipe(&warm_pipe) {
            if let Ok(mut writer) = file.try_clone() {
                // 音乐模式：屏蔽 mpv 手柄输入节（保留 --input-gamepad，影视播放要恢复）
                let _ = send(&mut writer, json!(["disable-section", "gamepad"]));
                // 音乐不渲染视频轨（内嵌封面会被 mpv 当视频建窗）→ vid=no
                let _ = send(&mut writer, json!(["set_property", "vid", "no"]));
                // 同步音量到持久化值（新进程默认 100，会盖过音量条显示）
                let _ = send(&mut writer, json!(["set_property", "volume", music_vol]));
                let _ = send(&mut writer, json!(["loadlist", m3u, "replace"]));
                let _ = send(&mut writer, json!(["set_property", "playlist-pos", start_idx]));
                let _ = send(&mut writer, json!(["set_property", "pause", false]));

                let session_id = {
                    let conn = state.db.lock();
                    open_music_session(&conn, &track_id)
                };
                *state.mpv.lock() = Some(Session {
                    pipe: warm_pipe.clone(),
                    writer: Some(writer),
                    episode_id: track_id.clone(),
                    label: queue.get(start_idx).map(|q| q.title.clone()).unwrap_or_default(),
                    series_id: String::new(),
                    session_id,
                    mode: SessionMode::Music,
                    playlist: entries.clone(),
                    playlist_pos: start_idx,
                    pending_seek: None,
                    seek: None,
                    pending_jump: Some(start_idx),
                });
                spawn_reader(
                    app.clone(),
                    state.mpv.clone(),
                    state.db.clone(),
                    state.warm.clone(),
                    warm_pipe,
                    state.data_dir.clone(),
                    Some(file),
                );
                started = true;
            }
        }
        if !started {
            state.warm.reset();
        } else {
            return Ok(());
        }
    }

    // ── 冷启动兜底（mpv 缺失/预热失败）：无窗口音频 ──
    // 双保险：预热路径走完未领到实例、但期间已有会话建立（并发点播）时，
    // 绝不再拉第二个进程
    ensure_no_session(&state)?;
    let Some(mpv_exe) = resolve_mpv(&app) else {
        return Err(AppError::Custom(
            "找不到内置播放器 mpv。请运行 scripts/fetch-mpv.sh 拉取".into(),
        ));
    };
    let config_dir = ensure_config_dir(&app, &state.data_dir);
    let pipe = format!(r"\\.\pipe\zex-mpv-{}", Uuid::new_v4().simple());
    let mut cmd = std::process::Command::new(&mpv_exe);
    cmd.arg(format!("--playlist={}", m3u.display()))
        .arg(format!("--playlist-start={}", start_idx))
        .arg("--idle=yes")
        .arg("--vid=no") // 音乐冷启动禁用视频轨（内嵌封面不建窗）；切影视时 play_episode 设 vid=auto
        .arg(format!("--volume={}", music_vol)) // 同步持久化音乐音量（新进程默认 100）
        .arg("--input-gamepad=yes") // 通用进程（音乐/影视共用，video=yes 上下文）；音乐由 disable-section 屏蔽手柄
        .arg(format!("--input-ipc-server={}", pipe))
        .arg(format!("--config-dir={}", config_dir.display()))
        .stdin(std::process::Stdio::null());
    if let Some(dir) = mpv_exe.parent() {
        cmd.current_dir(dir);
    }
    cmd.spawn()
        .map_err(|e| AppError::Custom(format!("无法启动 mpv: {}", e)))?;

    // 不在此处补拉预热：会话结束时 reader 的 end-file/EOF 分支统一补拉，
    // 保持任意时刻至多一个 mpv（活跃会话或空闲预热），冷启动会话结束后同样有热启动可用

    // 音乐冷启动：mpv 带 --input-gamepad 拉起（后续切影视要手柄），先等管道就绪
    // 屏蔽 gamepad 输入节，否则刚起那会儿手柄会控制音乐播放
    if let Some(mut file) = connect_pipe(&pipe) {
        let _ = send(&mut file, json!(["disable-section", "gamepad"]));
    }

    let session_id = {
        let conn = state.db.lock();
        open_music_session(&conn, &track_id)
    };
    *state.mpv.lock() = Some(Session {
        pipe: pipe.clone(),
        writer: None,
        episode_id: track_id.clone(),
        label: queue.get(start_idx).map(|q| q.title.clone()).unwrap_or_default(),
        series_id: String::new(),
        session_id,
        mode: SessionMode::Music,
        playlist: entries,
        playlist_pos: start_idx,
        pending_seek: None,
        seek: None,
        pending_jump: None,
    });
    spawn_reader(
        app,
        state.mpv.clone(),
        state.db.clone(),
        state.warm.clone(),
        pipe,
        state.data_dir.clone(),
        None,
    );
    Ok(())
}

/// 播放条控制：暂停/seek/音量/上下首/随机/循环。白名单 op，值语义随 op 而定。
/// send 失败（mpv 未就绪/已退出）返回错误，前端据此回滚本地状态
#[tauri::command(async)]
pub fn music_control(state: State<'_, AppState>, op: String, value: f64) -> AppResult<()> {
    log::debug!("[diag] music_control 进入 op={} value={}", op, value);
    // send 失败说明 mpv 进程没了但 Session 残留（reader 未能清理）：清掉残留会话返回错误，
    // 前端 musicTogglePause catch 据此收掉悬空播放条。
    // 注意：绝不在 mpv 锁里做 send_probe（往管道写探测命令）—— 写命名管道 + flush 是
    // 同步阻塞操作，放进会话锁会与 reader 的 time-pos 持锁路径互锁，表现为"点暂停即卡死"。
    // 靠 send 本身的失败结果（写已关闭管道立即 Err）判断会话死活
    let dead = || {
        *state.mpv.lock() = None;
        Err(AppError::Custom("播放器没在运行".into()))
    };
    match op.as_str() {
        "toggle_pause" => {
            // 用显式 set_property pause=true/false 取代 cycle pause：cycle 在暂停态触发 mpv
            // 内部"toggle"栈可能短暂阻塞 IPC 读入（实测暂停后再点播放，cycle pause 的 write_all
            // 卡 6 秒才返回）。set_property 是直设属性值、不触发 toggle 路径，mpv 立刻处理。
            // value=1 暂停 / 0 继续：前端乐观翻转后直接传目标值，比后端从快照反推可靠
            let want_pause = value > 0.0;
            let ok = send_to_session(&state.mpv, json!(["set_property", "pause", want_pause]));
            log::debug!("[diag] toggle_pause want_pause={}->ok={}", want_pause, ok);
            if !ok {
                return dead();
            }
        }
        "seek" => {
            // 先记下 seek 目标 + 3s 截止：reader 的 time-pos 分支据此丢弃「seek 前滞留
            // 在管道里、seek 后才送达」的旧位置推送（mpv#15253），前端就不会弹回原位置
            {
                let mut guard = state.mpv.lock();
                if let Some(s) = guard.as_mut() {
                    s.seek = Some((value, Instant::now() + Duration::from_secs(3)));
                }
            }
            if !send_to_session(&state.mpv, json!(["set_property", "time-pos", value])) {
                return dead();
            }
        }
        "volume" => {
            if !send_to_session(&state.mpv, json!(["set_property", "volume", value])) {
                return dead();
            }
        }
        "next" => {
            if !send_to_session(&state.mpv, json!(["playlist-next"])) {
                return dead();
            }
        }
        "prev" => {
            if !send_to_session(&state.mpv, json!(["playlist-prev"])) {
                return dead();
            }
        }
        "shuffle" => {
            if !send_to_session(&state.mpv, json!(["set_property", "shuffle", value > 0.0])) {
                return dead();
            }
        }
        // 循环：0=关，1=列表循环，2=单曲循环
        "loop" => {
            let (lp, lf): (&str, &str) = if value == 2.0 {
                ("no", "inf")
            } else if value == 1.0 {
                ("inf", "no")
            } else {
                ("no", "no")
            };
            if !send_to_session(&state.mpv, json!(["set_property", "loop-playlist", lp])) {
                return dead();
            }
            if !send_to_session(&state.mpv, json!(["set_property", "loop-file", lf])) {
                return dead();
            }
        }
        _ => return Err(AppError::Custom(format!("未知控制: {}", op))),
    }
    Ok(())
}

#[derive(Serialize)]
pub struct MusicNowPlaying {
    pub track_id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub cover_path: String,
    pub position_ms: i64,
    pub duration_ms: i64,
    pub playing: bool,
}

/// 音乐播放最新进度快照：reader 线程每次 emit music-progress 前刷新。
/// get_music_now_playing 读它拿真实 position/playing —— 托盘菜单顶部、ZEX 刷新后
/// 恢复播放条都靠它（否则 position 恒 0、playing 只能假定 true，暂停状态会闪一下）
struct MusicSnapshot {
    track_id: String,
    position_ms: i64,
    playing: bool,
}

static MUSIC_SNAPSHOT: RwLock<Option<MusicSnapshot>> = RwLock::new(None);

fn update_music_snapshot(track_id: String, position_ms: i64, playing: bool) {
    *MUSIC_SNAPSHOT.write() = Some(MusicSnapshot {
        track_id,
        position_ms,
        playing,
    });
}

/// 当前音乐播放状态（ZEX 重启/刷新后前端据此恢复播放条）。仅音乐模式返回 Some
#[tauri::command(async)]
pub fn get_music_now_playing(state: State<'_, AppState>) -> AppResult<Option<MusicNowPlaying>> {
    let (track_id, title) = {
        let guard = state.mpv.lock();
        match guard.as_ref() {
            Some(s) if s.mode == SessionMode::Music => (s.episode_id.clone(), s.label.clone()),
            _ => return Ok(None),
        }
    };
    // 进度快照来自 reader 线程。track 刚切换、快照还没来得及跟进时，兜底成「从头、播放中」
    let snap = MUSIC_SNAPSHOT.read();
    let (position_ms, playing) = match snap.as_ref() {
        Some(s) if s.track_id == track_id => (s.position_ms, s.playing),
        _ => (0, true),
    };
    drop(snap);
    let conn = state.db.lock();
    let row = conn
        .query_row(
            "SELECT artist, album, cover_path, duration_seconds FROM tracks WHERE id = ?1",
            [&track_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((artist, album, cover_path, duration_seconds)) = row else {
        return Ok(None);
    };
    Ok(Some(MusicNowPlaying {
        track_id,
        title,
        artist,
        album,
        cover_path,
        position_ms,
        duration_ms: duration_seconds * 1000,
        playing,
    }))
}
