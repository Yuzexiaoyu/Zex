//! RTSS 帧数 OSD 驱动：驱动随包分发的便携 RTSS（src-tauri/rtss/）为游戏显示帧数。
//!
//! ## 为什么是文件 profile 而不是逐个 SetProfileProperty
//! RTSS 的 profile 是文件（Profiles/<exe>.cfg），[OSD] 段就是 OSD 全部设置。
//! 直接写文件 + LoadProfile() 让 RTSS 重载 + UpdateProfiles() 应用，比逐个
//! SetProfileProperty 简单可靠，且备份/还原（文件复制）天然成立。
//!
//! ## 运行模式（2026-08-19 全链路实测，见 src-tauri/rtss/VERSION）
//! - 便携：任意目录直接跑 RTSS.exe，注册表零写入，配置落 <exe 同级>/Profiles/
//! - 共享内存 RTSSSharedMemoryV2（不带 Global\ 前缀）探测"RTSS 在跑"
//! - RTSS 自提权/受保护：ZEX 只启动与复用，绝不杀；单实例=新实例退出
//! - 托盘图标：RTSS 启动后外部 Shell_NotifyIconW(NIM_DELETE) 删除
//!   （hWnd=uID=RivaTunerStatisticsServer 窗口句柄，cbSize=488 —— 反汇编
//!   0x4135cc 确认 hWnd/uID 同值；删后 RTSS 不重建、共享内存不受影响）

use std::ffi::c_char;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::ptr;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, BOOL, TRUE, FALSE};
use windows_sys::Win32::System::Memory::{OpenFileMappingW, FILE_MAP_READ};
use windows_sys::Win32::UI::Shell::{NOTIFYICONDATAW, NIM_DELETE, Shell_NotifyIconW};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextW, GetWindowThreadProcessId,
};

use crate::{AppError, AppResult, AppState};

// RTSS 共享内存段名（不带 Global\ 前缀 —— 带前缀非提权打开会 err=2，实测）
const SHARED_MEM_NAME: &str = "RTSSSharedMemoryV2";
// RTSS 托盘回调窗口标题（EnumWindows 按标题找；Afx:00400000:20:... 类名随版本变，标题稳）
const TRAY_WND_TITLE: &str = "RivaTunerStatisticsServer";
// RTSS 创建托盘图标时的 NOTIFYICONDATA 版本（反汇编 0x4135f5: cbSize=0x1e8）
const NID_CBSIZE: u32 = 0x1E8;
// 等待 RTSS 共享内存就绪的超时（RTSS 自提权重启一次，5 秒足够）
const READY_TIMEOUT: Duration = Duration::from_secs(5);

// ─────────────────────────────────────────────
// 状态模型
// ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct RtssStatus {
    /// 随包 RTSS 是否就位（rtss/RTSS.exe 存在）
    pub installed: bool,
    /// RTSS 是否在跑（共享内存探测，进程名/PID 都不可靠：RTSS 自提权重启、隐藏 PEB 路径）
    pub running: bool,
    /// rtss 目录绝对路径（未安装时为 None）
    pub path: Option<String>,
}

/// OSD 配置（设置页全局默认 + 游戏右键开关共用同一形状；graph_max 单位 ms）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OsdConfig {
    pub enabled: bool,
    /// 1..4 四角（RTSS PositionX/PositionY 的 1-4 枚举）
    pub position: i32,
    /// 1..8 缩放（ZoomRatio）
    pub zoom: i32,
    /// 0xRRGGBB 文本色（BaseColor 的 0x00RRGGBB 值）
    pub color: String,
    /// frametime 曲线开关（EnableFrametimeHistory）
    pub graph_enabled: bool,
    /// 曲线纵轴上限 ms（FrametimeHistoryMax，仅 graph_enabled 时有效）
    pub graph_max: i32,
}

impl Default for OsdConfig {
    fn default() -> Self {
        // 与 RTSS 官方默认一致（交接单第五节键表）
        Self {
            enabled: false,
            position: 1,
            zoom: 2,
            color: "00FF8000".to_string(),
            graph_enabled: false,
            graph_max: 50,
        }
    }
}

// ─────────────────────────────────────────────
// 路径解析（与 mpv.rs 的 resolve_mpv 同构三级兜底）
// ─────────────────────────────────────────────

fn resolve_rtss(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(p) = app
        .path()
        .resolve("rtss/RTSS.exe", tauri::path::BaseDirectory::Resource)
    {
        if p.exists() {
            return Some(p.parent()?.to_path_buf());
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("rtss").join("RTSS.exe");
            if p.exists() {
                return Some(p.parent()?.to_path_buf());
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("rtss").join("RTSS.exe");
    dev.exists()
        .then(|| dev.parent().map(|p| p.to_path_buf()))
        .flatten()
}

// ─────────────────────────────────────────────
// 共享内存探测（RTSS 在跑？）
// ─────────────────────────────────────────────

/// RTSSSharedMemoryV2 可打开 = RTSS 在跑。RTSS 整个生命周期都在（进程保护
/// 下共享内存一直有效），比进程名匹配可靠得多
fn rtss_running() -> bool {
    let wide: Vec<u16> = SHARED_MEM_NAME.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let handle = OpenFileMappingW(FILE_MAP_READ, FALSE, wide.as_ptr());
        if handle.is_null() {
            return false;
        }
        CloseHandle(handle);
        true
    }
}

// ─────────────────────────────────────────────
// 托盘图标删除（外部 NIM_DELETE）
// ─────────────────────────────────────────────

struct EnumCtx {
    target_pid: u32,
    found: HWND,
}

unsafe extern "system" fn enum_wnd_proc(h: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam as *mut EnumCtx);
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(h, &mut pid);
    if pid != ctx.target_pid {
        return TRUE;
    }
    let mut buf = [0u16; 64];
    let n = GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32);
    if n > 0 && buf[..n as usize] == *TRAY_WND_TITLE.encode_utf16().collect::<Vec<u16>>().as_slice() {
        ctx.found = h;
        return FALSE; // 找到即停
    }
    TRUE
}

/// 找 RTSS 进程的托盘回调窗口（title=RivaTunerStatisticsServer）。
/// RTSS 隐藏 PEB 路径（sysinfo 读不到 exe 路径），按进程名 + 窗口标题定位
fn find_rtss_tray_window(pid: u32) -> Option<HWND> {
    let mut ctx = EnumCtx { target_pid: pid, found: ptr::null_mut() };
    unsafe {
        EnumWindows(Some(enum_wnd_proc), &mut ctx as *mut EnumCtx as LPARAM);
    }
    (!ctx.found.is_null()).then_some(ctx.found)
}

/// 删除 RTSS 托盘图标。hWnd 与 uID 都是窗口句柄本身（RTSS 0x4135cc 用同一值
/// 初始化两个字段），cbSize=488（V2 结构）。删除后 RTSS 不重建图标（创建逻辑
/// 只在启动/EXPLORER 重启时触发），重复删除返回 FALSE（幂等无害）
fn delete_rtss_tray_icon(hwnd: HWND) -> bool {
    let mut nid: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
    nid.cbSize = NID_CBSIZE;
    nid.hWnd = hwnd;
    nid.uID = hwnd as u32;
    unsafe { Shell_NotifyIconW(NIM_DELETE, &mut nid) != FALSE }
}

/// 轮询删除 RTSS 托盘图标：窗口一出现立即 NIM_DELETE，图标存在时间 = 轮询间隔
/// （50ms，肉眼不可见）。RTSS 自提权重启（新进程新窗口），每次 ensure 就绪后调用；
/// 删除成功或超时后返回（超时下次 launch 再补，RTSS 不重建图标，漏删也无副作用）
fn hide_rtss_tray() {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        // 进程名匹配（RTSS 进程名稳定，路径被隐藏读不到）。sysinfo 只采集进程表，
        // RTSS 的 PEB 命令行被屏蔽但进程名正常（mpv.rs 同款经验）
        let sys = sysinfo::System::new();
        let target = sys
            .processes()
            .values()
            .find(|p| {
                p.name()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .eq_ignore_ascii_case("rtss.exe")
            })
            .map(|p| p.pid().as_u32());
        if let Some(pid) = target {
            if let Some(hwnd) = find_rtss_tray_window(pid) {
                if delete_rtss_tray_icon(hwnd) {
                    return; // 删除成功
                }
            }
        }
        if Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

// ─────────────────────────────────────────────
// RTSSHooks64.dll 动态加载（libloading）+ profile API
// ─────────────────────────────────────────────

type LoadProfileFn = unsafe extern "C" fn(*const c_char) -> i32;
type SaveProfileFn = unsafe extern "C" fn(*const c_char) -> i32;
type UpdateProfilesFn = unsafe extern "C" fn() -> i32;
type SetProfilePropertyFn = unsafe extern "C" fn(*const c_char, *const c_char, u32) -> i32;
type GetProfilePropertyFn = unsafe extern "C" fn(*const c_char, *const c_char) -> u32;

struct RtssApi {
    load_profile: LoadProfileFn,
    // 阶段一用文件 profile，Save/Get/Set 留待阶段二（限帧）用
    #[allow(dead_code)]
    save_profile: SaveProfileFn,
    update_profiles: UpdateProfilesFn,
    #[allow(dead_code)]
    set_profile_property: SetProfilePropertyFn,
    #[allow(dead_code)]
    get_profile_property: GetProfilePropertyFn,
    #[allow(dead_code)]
    _lib: libloading::Library, // 保持库句柄存活（drop 会卸载）
}

/// 加载 RTSSHooks64.dll 并取导出。RTSS 官方 API 是 ANSI 字符串（cdecl，
/// 通过共享内存与 RTSS 通信，非提权可用 —— 交接单实测验证）
fn load_rtss_api(rtss_dir: &Path) -> AppResult<RtssApi> {
    let lib_path = rtss_dir.join("RTSSHooks64.dll");
    let lib = unsafe { libloading::Library::new(&lib_path) }
        .map_err(|e| AppError::Custom(format!("加载 RTSSHooks64.dll 失败: {e}")))?;
    unsafe {
        Ok(RtssApi {
            load_profile: *lib.get(b"LoadProfile").map_err(|e| AppError::Custom(format!("LoadProfile 导出缺失: {e}")))?,
            save_profile: *lib.get(b"SaveProfile").map_err(|e| AppError::Custom(format!("SaveProfile 导出缺失: {e}")))?,
            update_profiles: *lib.get(b"UpdateProfiles").map_err(|e| AppError::Custom(format!("UpdateProfiles 导出缺失: {e}")))?,
            set_profile_property: *lib.get(b"SetProfileProperty").map_err(|e| AppError::Custom(format!("SetProfileProperty 导出缺失: {e}")))?,
            get_profile_property: *lib.get(b"GetProfileProperty").map_err(|e| AppError::Custom(format!("GetProfileProperty 导出缺失: {e}")))?,
            _lib: lib,
        })
    }
}

fn cstr(s: &str) -> Vec<c_char> {
    // ANSI 字符串：exe 名/键名都是 ASCII，直接转 c_char（Windows 上 c_char = i8）
    s.bytes().map(|b| b as c_char).chain(std::iter::once(0)).collect()
}

// ─────────────────────────────────────────────
// profile 文件读写（Profiles/<exe>.cfg 的 [OSD] 段）
// ─────────────────────────────────────────────

/// 游戏 exe 名（不含路径）→ profile 名（RTSS 按 exe 名匹配，与启动方式无关：
/// Steam 走 steam://rungameid 同样适用）
fn profile_name_for_exe(exe: &str) -> String {
    Path::new(exe)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// 只查 exe_path 一列（profile 匹配只需要它；get_game 是命令函数不能 pub 跨模块调）
fn game_exe_path(conn: &rusqlite::Connection, game_id: &str) -> AppResult<String> {
    conn.query_row("SELECT exe_path FROM games WHERE id = ?", [game_id], |r| r.get(0))
        .map_err(AppError::from)
}

fn profiles_dir(rtss_dir: &Path) -> PathBuf {
    rtss_dir.join("Profiles")
}

/// 读某游戏 cfg 的 [OSD] 段为 key=value map（文件不存在返回空 map —— 即默认配置）
fn read_osd_section(path: &Path) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let Ok(content) = std::fs::read_to_string(path) else {
        return map;
    };
    let mut in_osd = false;
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_osd = line.eq_ignore_ascii_case("[OSD]");
            continue;
        }
        if in_osd {
            if let Some((k, v)) = line.split_once('=') {
                map.insert(k.trim().to_string(), v.trim().to_string());
            }
        }
    }
    map
}

/// 写某游戏 cfg：保留原文件其他段，整体替换 [OSD] 段（新文件只写 [OSD]）。
/// RTSS 加载 cfg 时缺失段用内置默认，无需写全
fn write_osd_section(path: &Path, values: &std::collections::HashMap<String, String>) -> AppResult<()> {
    let existing = if path.exists() {
        std::fs::read_to_string(path).unwrap_or_default()
    } else {
        String::new()
    };
    let mut out = String::new();
    let mut replaced_osd = false;
    if !existing.is_empty() {
        let mut in_osd = false;
        for line in existing.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('[') {
                if in_osd {
                    // [OSD] 段内容已跳过，段结束
                    in_osd = false;
                }
                if trimmed.eq_ignore_ascii_case("[OSD]") {
                    in_osd = true;
                    replaced_osd = true;
                    out.push_str("[OSD]\n");
                    for (k, v) in values {
                        out.push_str(&format!("{k}={v}\n"));
                    }
                    continue;
                }
            }
            if !in_osd {
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    if !replaced_osd {
        out.push_str("[OSD]\n");
        for (k, v) in values {
            out.push_str(&format!("{k}={v}\n"));
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, out)?;
    Ok(())
}

/// 默认 OSD 键值（完整 [OSD] 段，RTSS 官方默认 + 前端可配项）
fn osd_values(cfg: &OsdConfig) -> std::collections::HashMap<String, String> {
    let mut m = std::collections::HashMap::new();
    m.insert("EnableOSD".into(), if cfg.enabled { "1" } else { "0" }.into());
    m.insert("EnableBgnd".into(), "1".into());
    m.insert("EnableFill".into(), "0".into());
    m.insert("EnableStat".into(), "0".into());
    m.insert("BaseColor".into(), cfg.color.clone());
    m.insert("BgndColor".into(), "00000000".into());
    m.insert("FillColor".into(), "80000000".into());
    m.insert("PositionX".into(), cfg.position.to_string());
    m.insert("PositionY".into(), cfg.position.to_string());
    m.insert("ZoomRatio".into(), cfg.zoom.to_string());
    m.insert("CoordinateSpace".into(), "0".into());
    m.insert("EnableFrameColorBar".into(), "0".into());
    m.insert("FrameColorBarMode".into(), "0".into());
    m.insert("RefreshPeriod".into(), "500".into());
    m.insert("IntegerFramerate".into(), "1".into());
    m.insert("MaximumFrametime".into(), "0".into());
    m.insert("EnableFrametimeHistory".into(), if cfg.graph_enabled { "1" } else { "0" }.into());
    m.insert("FrametimeHistoryWidth".into(), "-32".into());
    m.insert("FrametimeHistoryHeight".into(), "-4".into());
    m.insert("FrametimeHistoryStyle".into(), "0".into());
    m.insert("ScaleToFit".into(), "0".into());
    m
}

/// cfg 文件 → OsdConfig（缺键用默认值）
fn osd_from_map(map: &std::collections::HashMap<String, String>) -> OsdConfig {
    let mut cfg = OsdConfig::default();
    cfg.enabled = map.get("EnableOSD").map(|v| v == "1").unwrap_or(false);
    cfg.position = map.get("PositionX").and_then(|v| v.parse().ok()).unwrap_or(1);
    cfg.zoom = map.get("ZoomRatio").and_then(|v| v.parse().ok()).unwrap_or(2);
    cfg.color = map.get("BaseColor").cloned().unwrap_or_else(|| "00FF8000".to_string());
    cfg.graph_enabled = map.get("EnableFrametimeHistory").map(|v| v == "1").unwrap_or(false);
    cfg.graph_max = map
        .get("FrametimeHistoryMax")
        .and_then(|v| v.parse().ok())
        .or_else(|| map.get("MaximumFrametime").and_then(|v| v.parse().ok()))
        .unwrap_or(50);
    cfg
}

// ─────────────────────────────────────────────
// 备份 / 还原
// ─────────────────────────────────────────────

fn backup_dir() -> PathBuf {
    crate::get_data_dir().join("rtss-backup")
}

/// 首次修改某游戏 profile 前整份备份（文件级，覆盖 [OSD] 之外的段也能还原）
fn backup_profile(rtss_dir: &Path, profile: &str) {
    let src = profiles_dir(rtss_dir).join(format!("{profile}.cfg"));
    if !src.exists() {
        return;
    }
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let dst = backup_dir().join(format!("{profile}.cfg.{stamp}.bak"));
    if let Some(parent) = dst.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::copy(&src, &dst);
}

// ─────────────────────────────────────────────
// 确保就绪（launch_game 挂钩 + 设置页共用）
// ─────────────────────────────────────────────

/// 确保 RTSS 在跑（共享内存就绪）+ 清理托盘图标。
/// RTSS 已在跑 → 只补一次托盘清理（可能上次没清到）；没在跑 → 启动并等待。
/// RTSS 自提权重启（PID 会变），spawn 返回值不可靠，一律以共享内存为准
pub fn ensure_rtss_running(app: &AppHandle) -> AppResult<RtssStatus> {
    let Some(rtss_dir) = resolve_rtss(app) else {
        return Ok(RtssStatus { installed: false, running: false, path: None });
    };

    if !rtss_running() {
        let exe = rtss_dir.join("RTSS.exe");
        let mut cmd = Command::new(&exe);
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        // spawn 失败不算致命（可能恰好正在提权重启），统一走共享内存轮询
        let _ = cmd.spawn();

        let deadline = Instant::now() + READY_TIMEOUT;
        while Instant::now() < deadline {
            if rtss_running() {
                break;
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    }

    let running = rtss_running();
    if running {
        hide_rtss_tray();
    }
    Ok(RtssStatus {
        installed: true,
        running,
        path: Some(rtss_dir.to_string_lossy().to_string()),
    })
}

/// launch_game 挂钩：该游戏启用 OSD 时确保 RTSS 就绪 + 写入 profile。
/// 游戏级开关优先：cfg 的 EnableOSD=1 即启用（右键开关）；cfg 不存在或
/// 未启用时按设置页全局默认决定
pub fn ensure_osd_ready(app: &AppHandle, state: &AppState, exe_path: &str) {
    // RTSS 未安装 → 静默跳过（设置页置灰已提示，启动游戏不阻塞）
    let Some(rtss_dir) = resolve_rtss(app) else { return };
    let profile = profile_name_for_exe(exe_path);
    let cfg_path = profiles_dir(&rtss_dir).join(format!("{profile}.cfg"));

    // 读取该游戏当前状态；文件不存在 = 从未设置 → 按全局默认
    let map = read_osd_section(&cfg_path);
    let game_enabled = map.get("EnableOSD").map(|v| v == "1");
    let global_enabled = {
        let conn = state.db.lock();
        conn.query_row(
            "SELECT value FROM settings WHERE key = 'rtss_osd_enabled'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .map(|v| v == "1")
        .unwrap_or(false)
    };
    let enabled = game_enabled.or(Some(global_enabled)).unwrap_or(false);
    if !enabled {
        return;
    }

    // 写 profile（只写一次：文件已存在且 EnableOSD=1 说明配置就绪，跳过
    // 避免覆盖用户手动调整的其他 OSD 项；不存在时按全局默认建）
    if !cfg_path.exists() {
        let global_cfg = global_osd_config(state);
        let values = osd_values(&global_cfg);
        let _ = write_osd_section(&cfg_path, &values);
    }

    // RTSS 就绪 + 通知加载新 profile
    if let Ok(status) = ensure_rtss_running(app) {
        if status.running {
            let _ = reload_profile(&rtss_dir, &profile);
        }
    }
}

fn global_osd_config(state: &AppState) -> OsdConfig {
    let mut cfg = OsdConfig::default();
    let conn = state.db.lock();
    let get = |key: &str| -> Option<String> {
        conn.query_row("SELECT value FROM settings WHERE key = ?", [key], |r| r.get(0)).ok()
    };
    cfg.enabled = get("rtss_osd_enabled").map(|v| v == "1").unwrap_or(false);
    cfg.position = get("rtss_osd_position").and_then(|v| v.parse().ok()).unwrap_or(1);
    cfg.zoom = get("rtss_osd_zoom").and_then(|v| v.parse().ok()).unwrap_or(2);
    cfg.color = get("rtss_osd_color").unwrap_or_else(|| "00FF8000".to_string());
    cfg.graph_enabled = get("rtss_osd_graph").map(|v| v == "1").unwrap_or(false);
    cfg.graph_max = get("rtss_osd_graph_max").and_then(|v| v.parse().ok()).unwrap_or(50);
    cfg
}

/// LoadProfile + UpdateProfiles：让 RTSS 从文件重载并应用该游戏 profile
fn reload_profile(rtss_dir: &Path, profile: &str) -> AppResult<()> {
    let api = load_rtss_api(rtss_dir)?;
    let name = cstr(profile);
    unsafe {
        (api.load_profile)(name.as_ptr());
        (api.update_profiles)();
    }
    Ok(())
}

// ─────────────────────────────────────────────
// Tauri Commands
// ─────────────────────────────────────────────

#[tauri::command(async)]
pub fn rtss_status(app: AppHandle) -> AppResult<RtssStatus> {
    let installed = resolve_rtss(&app).is_some();
    Ok(RtssStatus {
        installed,
        running: rtss_running(),
        path: resolve_rtss(&app).map(|p| p.to_string_lossy().to_string()),
    })
}

#[tauri::command(async)]
pub fn rtss_launch(app: AppHandle) -> AppResult<RtssStatus> {
    ensure_rtss_running(&app)
}

#[tauri::command(async)]
pub fn rtss_open_download_page() -> AppResult<()> {
    // 官方发布页（guru3d 的 RTSS 专区；opener 走用户默认浏览器，可过 Cloudflare）
    let url = "https://www.guru3d.com/download/rivatuner-statistics-server-download/";
    tauri_plugin_opener::open_url(url, None::<String>)
        .map_err(|e| AppError::Custom(format!("打开下载页失败: {e}")))
}

#[tauri::command(async)]
pub fn rtss_get_osd(app: AppHandle, state: State<'_, AppState>, game_id: String) -> AppResult<OsdConfig> {
    let Some(rtss_dir) = resolve_rtss(&app) else {
        return Err(AppError::Custom("RTSS 未安装".to_string()));
    };
    // 由 game_id 查 exe 名（profile 按 exe 名匹配）
    let exe = {
        let conn = state.db.lock();
        game_exe_path(&conn, &game_id)?
    };
    let profile = profile_name_for_exe(&exe);
    let cfg_path = profiles_dir(&rtss_dir).join(format!("{profile}.cfg"));
    Ok(osd_from_map(&read_osd_section(&cfg_path)))
}

#[tauri::command(async)]
pub fn rtss_set_osd(app: AppHandle, state: State<'_, AppState>, game_id: String, config: OsdConfig) -> AppResult<()> {
    let Some(rtss_dir) = resolve_rtss(&app) else {
        return Err(AppError::Custom("RTSS 未安装".to_string()));
    };
    let exe = {
        let conn = state.db.lock();
        game_exe_path(&conn, &game_id)?
    };
    let profile = profile_name_for_exe(&exe);
    let cfg_path = profiles_dir(&rtss_dir).join(format!("{profile}.cfg"));

    // 首次修改前备份
    backup_profile(&rtss_dir, &profile);

    let values = osd_values(&config);
    write_osd_section(&cfg_path, &values)?;
    reload_profile(&rtss_dir, &profile)?;
    Ok(())
}

#[tauri::command(async)]
pub fn rtss_restore_backup(app: AppHandle, state: State<'_, AppState>, game_id: String) -> AppResult<()> {
    let Some(rtss_dir) = resolve_rtss(&app) else {
        return Err(AppError::Custom("RTSS 未安装".to_string()));
    };
    let exe = {
        let conn = state.db.lock();
        game_exe_path(&conn, &game_id)?
    };
    let profile = profile_name_for_exe(&exe);
    let cfg_path = profiles_dir(&rtss_dir).join(format!("{profile}.cfg"));

    // 找最新备份
    let dir = backup_dir();
    let newest = std::fs::read_dir(&dir)
        .ok()
        .and_then(|entries| {
            let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with(&format!("{profile}.cfg.")) && name.ends_with(".bak") {
                    if let Ok(meta) = e.metadata() {
                        let t = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                        if best.as_ref().map(|(bt, _)| t > *bt).unwrap_or(true) {
                            best = Some((t, e.path()));
                        }
                    }
                }
            }
            best.map(|(_, p)| p)
        });
    let Some(src) = newest else {
        return Err(AppError::Custom("没有可还原的备份".to_string()));
    };
    std::fs::copy(&src, &cfg_path)?;
    reload_profile(&rtss_dir, &profile)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_cfg(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("zex-rtss-test");
        let _ = std::fs::create_dir_all(&dir);
        dir.join(name)
    }

    #[test]
    fn write_osd_creates_full_section() {
        let p = tmp_cfg("new.cfg");
        let _ = std::fs::remove_file(&p);
        let mut cfg = OsdConfig::default();
        cfg.enabled = true;
        cfg.position = 3;
        cfg.zoom = 4;
        cfg.color = "00FFFF00".into();
        cfg.graph_enabled = true;
        write_osd_section(&p, &osd_values(&cfg)).unwrap();
        let content = std::fs::read_to_string(&p).unwrap();
        assert!(content.contains("[OSD]\n"));
        assert!(content.contains("EnableOSD=1\n"));
        assert!(content.contains("PositionX=3\n"));
        assert!(content.contains("ZoomRatio=4\n"));
        assert!(content.contains("BaseColor=00FFFF00\n"));
        assert!(content.contains("EnableFrametimeHistory=1\n"));
    }

    #[test]
    fn write_osd_keeps_other_sections() {
        let p = tmp_cfg("keep.cfg");
        std::fs::write(
            &p,
            "[OSD]\nEnableOSD=0\nPositionX=1\n\n[Framerate]\nLimit=200\nSyncLimiter=0\n\n[Info]\nTimestamp=test\n",
        )
        .unwrap();
        let mut cfg = OsdConfig::default();
        cfg.enabled = true;
        cfg.position = 2;
        write_osd_section(&p, &osd_values(&cfg)).unwrap();
        let content = std::fs::read_to_string(&p).unwrap();
        // [OSD] 段被整体替换，其他段原样保留
        assert!(content.contains("EnableOSD=1\n"));
        assert!(content.contains("PositionX=2\n"));
        assert!(!content.contains("PositionX=1\n"));
        assert!(content.contains("[Framerate]\nLimit=200\nSyncLimiter=0"));
        assert!(content.contains("[Info]\nTimestamp=test"));
    }

    #[test]
    fn osd_roundtrip() {
        let p = tmp_cfg("roundtrip.cfg");
        let _ = std::fs::remove_file(&p);
        let mut cfg = OsdConfig::default();
        cfg.enabled = true;
        cfg.position = 4;
        cfg.zoom = 6;
        cfg.color = "00FF0000".into();
        cfg.graph_enabled = true;
        cfg.graph_max = 100;
        write_osd_section(&p, &osd_values(&cfg)).unwrap();
        let back = osd_from_map(&read_osd_section(&p));
        assert_eq!(back.enabled, true);
        assert_eq!(back.position, 4);
        assert_eq!(back.zoom, 6);
        assert_eq!(back.color, "00FF0000");
        assert_eq!(back.graph_enabled, true);
    }

    #[test]
    fn profile_name_from_exe_path() {
        assert_eq!(profile_name_for_exe("D:\\games\\Cyberpunk2077\\REDprelauncher.exe"), "REDprelauncher.exe");
        assert_eq!(profile_name_for_exe("game.exe"), "game.exe");
        assert_eq!(profile_name_for_exe(""), "");
    }
}
