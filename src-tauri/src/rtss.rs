//! RTSS 帧数 OSD 驱动：驱动随包分发的便携 RTSS（src-tauri/rtss/）为游戏显示帧数。
//!
//! ## 为什么是文件 profile 而不是逐个 SetProfileProperty
//! RTSS 的 profile 是文件（Profiles/<exe>.cfg），[OSD] 段就是 OSD 全部设置。
//! 直接写文件 + LoadProfile() 让 RTSS 重载 + UpdateProfiles() 应用，比逐个
//! SetProfileProperty 简单可靠，且备份/还原（文件复制）天然成立。
//!
//! ## 运行模式（2026-08-19 全链路实测，见 src-tauri/rtss/VERSION）
//! - 便携：任意目录直接跑 RTSS.exe，配置落 <exe 同级>/Profiles/。但 RTSS.exe 的
//!   清单是 requireAdministrator —— CreateProcessW（Command::spawn）启动必然
//!   报 os error 740，只能走 ShellExecuteExW + runas；RTSS 自己还会写
//!   HKLM\SOFTWARE\WOW6432Node\Unwinder\RTSS（InstallDir，Loader 靠它找 hook dll）
//! - 共享内存 RTSSSharedMemoryV2（不带 Global\ 前缀）探测"RTSS 在跑"
//! - RTSS 提权运行（Medium IL 的 taskkill 一律 Access denied），但 ZEX 退出时仍能
//!   销毁自己起的那个：见 RTSS_PROCESS。复用别人的 RTSS 时不碰。单实例=新实例退出
//! - 注入交给 RTSS 内置的新进程钩子（2026-08-20 实测 OSD 正常显示）。别再想着自己调
//!   RTSSHooksLoader64.exe —— 它的清单同样是 requireAdministrator，Command::spawn
//!   一样报 740；它还继承 RTSS 的高完整性，只能靠提权 taskkill 收（见 kill_hooks_loader）
//! - 托盘图标：RTSS 启动后外部 Shell_NotifyIconW(NIM_DELETE) 删除
//!   （hWnd=uID=RivaTunerStatisticsServer 窗口句柄，cbSize=488 —— 反汇编
//!   0x4135cc 确认 hWnd/uID 同值；删后 RTSS 不重建、共享内存不受影响）
//! - 弹窗治理（2026-09-20）：游戏进程必须创建在 RTSS 之后，注入才走新进程
//!   钩子路径；后到的 RTSS 只能对已在跑的进程补注入，d3d8 已加载挂不上 →
//!   弹 "…components cannot be hooked…" 模态框（框挂在 RTSS UI 线程上，
//!   还会卡住托盘图标创建，弹框和托盘删不掉两个症状同源）。两手：launch_game
//!   的同步门（ensure_osd_ready 等 RTSS 就绪才放行游戏进程）+ 启动后收尾
//!   线程关掉残余警告框（兜预热/手动启动 RTSS 时外面已开着游戏的场景）

use std::ffi::c_char;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, BOOL, TRUE, FALSE};
use windows_sys::Win32::Globalization::{WideCharToMultiByte, CP_ACP};
use windows_sys::Win32::System::Memory::{
    OpenFileMappingW, MapViewOfFile, UnmapViewOfFile, FILE_MAP_READ, FILE_MAP_WRITE,
};
use windows_sys::Win32::System::Threading::{TerminateProcess, WaitForSingleObject};
use windows_sys::Win32::UI::Shell::{
    NOTIFYICONDATAW, NIM_DELETE, Shell_NotifyIconW, ShellExecuteExW, SHELLEXECUTEINFOW,
    SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowTextW, GetWindowThreadProcessId, PostMessageW,
    SW_HIDE, SW_SHOWMINNOACTIVE, WM_CLOSE,
};

use crate::{AppError, AppResult, AppState};

// RTSS 共享内存段名（不带 Global\ 前缀 —— 带前缀非提权打开会 err=2，实测）
const SHARED_MEM_NAME: &str = "RTSSSharedMemoryV2";
// RTSS 托盘回调窗口标题（EnumWindows 按标题找；Afx:00400000:20:... 类名随版本变，标题稳）
const TRAY_WND_TITLE: &str = "RivaTunerStatisticsServer";
// RTSS 创建托盘图标时的 NOTIFYICONDATA 版本（反汇编 0x4135f5: cbSize=0x1e8）
const NID_CBSIZE: u32 = 0x1E8;
// 预热/设置页路径等 RTSS 共享内存就绪的超时（都在后台跑，宽一点无妨）
const READY_TIMEOUT: Duration = Duration::from_secs(5);
// launch_game 同步门的上限（2026-09-20 用户定的 2 秒快速超时）：常态下预热
// 已把 RTSS 拉起，门只零等待地过一下；只在预热没赶上/失败时兜底。等不到就
// 放行游戏 —— 那一次没 OSD，RTSS 后到补注入弹的警告框由收尾线程关掉
const GATE_TIMEOUT: Duration = Duration::from_secs(2);
// 启动后收尾（关警告框 + 删托盘图标）的轮询窗口
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(8);
// RTSS 警告框的窗口类：标准对话框类。主窗口/托盘回调窗口的类是 Afx:00400000:…
// （MFC，随版本变），按类名就能把对话框和它们分开，不会误关
const DIALOG_CLASS: &str = "#32770";
// 见过警告框后再静默多久才算收尾完成 —— RTSS 对多个已在跑的 3D 程序挨个弹，
// 关掉一个可能还跟着下一个
const DIALOG_QUIET: Duration = Duration::from_secs(1);

/// ZEX 自己拉起的那个 RTSS 的进程句柄（0 = 不是我们起的，或已销毁）。
///
/// 存句柄而不是 PID 是关键：这个句柄由 UAC 的 AppInfo 服务替我们创建再复制过来，
/// 自带全权限，而句柄权限只在打开时检查一次 —— 所以 Medium IL 的 ZEX 拿它直接
/// TerminateProcess 就能杀掉提权的 RTSS，不需要二次弹 UAC（对照：taskkill /F 走
/// OpenProcess，Medium→High 一律 Access denied，实测）。
///
/// 复用别人已经在跑的 RTSS（比如 MSI Afterburner 自带那份）时这里保持 0，
/// ZEX 退出就不去碰它 —— 和 mpv 一样，只销毁自己起的。
static RTSS_PROCESS: AtomicUsize = AtomicUsize::new(0);

/// RTSS 是否已做过「启动后收尾」（删托盘图标 + 关警告框）。收尾只在 RTSS
/// 从未跑→跑的边沿做：图标删过之后窗口还在，NIM_DELETE 只返回 FALSE，和
/// 失败没法区分，每次 ensure 都重跑等于白轮询一个超时。RTSS 不在跑时复位
/// （新进程会重建图标）
static RTSS_CLEANED: AtomicBool = AtomicBool::new(false);

/// 只护「spawn RTSS 一下」这个动作：预热线程和 launch_game 的同步门可能同时
/// 发现 RTSS 没在跑，各自 spawn 会白弹一次 UAC（第二个实例自退，框却弹两次）
static RTSS_START_LOCK: Mutex<()> = Mutex::new(());

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

/// 一份 RTSS profile 的可配置项。全局 profile 和单游戏 profile 共用同一形状 ——
/// 「单独设置」就是把全局整份复制出来独立编辑（见 ProfileTarget）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProfileConfig {
    // ── 帧数显示（[OSD]）
    pub enabled: bool,
    /// 1..4 四角：1 左上 2 右上 3 左下 4 右下（写盘时由 position_coords 换算成坐标）
    pub position: i32,
    /// 1..8 缩放（ZoomRatio）
    pub zoom: i32,
    /// 0xRRGGBB 文本色（BaseColor 的 0x00RRGGBB 值）
    pub color: String,
    /// 底板浓度 0=关 1=淡 2=浓（EnableFill + FillColor 高位）
    pub fill: i32,
    /// OSD 重绘间隔 ms（RefreshPeriod；模板 RefreshPeriodMin=10 是 RTSS 自己的下限）。
    /// 同时会写进 [Statistics] FramerateAveragingInterval，见 statistics_values
    pub refresh_period: i32,
    /// 帧数精度：true=整数，false=0.1 帧（IntegerFramerate）
    pub integer_framerate: bool,
    /// 坐标空间 0=渲染视口 1=整个画面（CoordinateSpace）。有些游戏一帧里切多个视口
    /// （官方点名 StarCraft II），OSD 原点会跟着最后一个视口跑偏，改 1 可以修正
    pub coordinate_space: i32,
    /// frametime 曲线开关（EnableFrametimeHistory）
    pub graph_enabled: bool,
    /// 曲线纵轴上限 ms（FrametimeHistoryMax，仅 graph_enabled 时有效）
    pub graph_max: i32,
    /// 曲线宽度，单位字宽（写盘时取负 —— RTSS 负值 = 按字符格算，随 ZoomRatio 缩放；
    /// 正值才是绝对像素。模板默认 -32 太宽，占掉大半屏）
    pub graph_width: i32,
    /// 曲线样式 0=折线 1=柱状（FrametimeHistoryStyle）
    pub graph_style: i32,

    // ── 锁帧（[Framerate]）
    /// 限帧开关（[Framerate] Limit，0=不限帧）
    pub framerate_enabled: bool,
    /// 限帧值 1-1000（仅 framerate_enabled 时生效）
    pub framerate_limit: i32,
    /// 限帧模式 0=异步 1=前沿同步 2=后沿同步 3=NVIDIA Reflex（SyncLimiter）
    pub framerate_mode: i32,
    /// 等待方式 true=省电（可等定时器）false=精准（忙等）。官方 ENABLE_PASSIVE_WAITING：
    /// 忙等的帧调度精度"无可匹敌"，代价只是多耗点电
    pub passive_wait: bool,
    /// 注入 Reflex 延迟标记（ReflexSetLatencyMarker）。默认注入，少数游戏不兼容 ——
    /// RTSS 自带的 CS2.exe.cfg / Overwatch.exe.cfg 模板都把它关了
    pub reflex_marker: bool,
    /// Reflex 睡眠注入点 0=自动 1=呈现前（帧时间更稳）2=呈现后（延迟更低）。
    /// 仅 framerate_mode=3 有意义（ReflexSleep）
    pub reflex_sleep: i32,

    // ── 兼容性（[Hooking]）
    /// 应用检测级别 0=无 1=低 2=中 3=高。RTSS **没有**单独的 INI 键，是三个
    /// [Hooking] 键的组合，见 hooking_values（2026-08-20 用官方导出的
    /// SetProfileProperty("AppDetectionLevel", 0..3) 逐档落盘实测得出）
    pub detection_level: i32,
    /// 兼容修改版 D3D 运行库（EnableDynamicOffsetDetection）。官方明确写了
    /// "不建议全局开启，可能导致部分程序起不来"，所以这项按游戏配才有意义
    pub dynamic_offset: bool,
    /// 改用 Microsoft Detours 挂钩（UseDetours）。和别的 overlay / 录制软件打架时用
    pub use_detours: bool,
    /// 注入延迟 ms（InjectionDelay）。用来绕开 Steam Overlay 的 OSD 独占检查，
    /// 0 = 关掉延迟注入
    pub injection_delay: i32,
}

/// ZEX 的出厂默认配置 —— 取自 2026-08-20 用户敲定的那份 Profiles/Global，
/// 不是 RTSS 模板的默认值。唯一的例外是 enabled：默认不开 OSD，由用户主动打开。
/// 面板上的「恢复默认」写的就是这一套；同时也是 osd_from_maps 读盘时缺键的回落值
impl Default for ProfileConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            position: 1,
            zoom: 3,
            color: "00FF8000".to_string(),
            fill: 0,
            refresh_period: 200,
            integer_framerate: true,
            coordinate_space: 0,
            graph_enabled: true,
            graph_max: 80,
            graph_width: 16,
            graph_style: 0,
            framerate_enabled: false,
            framerate_limit: 144,
            framerate_mode: 0,
            passive_wait: false,
            reflex_marker: true,
            reflex_sleep: 0,
            // 跟 RTSS 自己的实际行为对齐而不是跟出厂模板：模板 Global 是 1/0/0（低），
            // 但 RTSS 首次初始化写出来的 Profiles/Global 是 1/1/1（高）。降到低会漏掉
            // 动态加载 D3D 的游戏，宁可跟随 RTSS 的实际默认
            detection_level: 3,
            dynamic_offset: false,
            use_detours: false,
            injection_delay: 0,
        }
    }
}

/// 配置对象：全局 profile，或某个游戏自己的 profile。
///
/// RTSS 的模型是「没有 <exe>.cfg 的应用自动吃 Global」（官方 Help/PLACEHOLDER_APP_WND），
/// 所以「跟随全局」在盘上就等于该 cfg 不存在 —— ZEX 不需要自己实现继承
#[derive(Debug, Clone)]
pub enum ProfileTarget {
    Global,
    /// profile 名 = exe 文件名（含 .exe）
    Game(String),
}

impl ProfileTarget {
    fn path(&self, rtss_dir: &Path) -> PathBuf {
        match self {
            // Global 没有 .cfg 后缀
            ProfileTarget::Global => profiles_dir(rtss_dir).join("Global"),
            ProfileTarget::Game(name) => profiles_dir(rtss_dir).join(format!("{name}.cfg")),
        }
    }

    /// LoadProfile / SaveProfile 的参数：全局传空串（2026-08-20 实测）
    fn api_name(&self) -> &str {
        match self {
            ProfileTarget::Global => "",
            ProfileTarget::Game(name) => name,
        }
    }
}

// ─────────────────────────────────────────────
// 路径解析（与 mpv.rs 的 resolve_mpv 同构两级）
// ─────────────────────────────────────────────

/// 只认两处：Tauri Resource 基目录、ZEX.exe 同级的 rtss\。
/// 没有「开发树兜底」—— 原先的第三级是编译期写死的 CARGO_MANIFEST_DIR 绝对路径，
/// 发布版会靠它偷偷跨盘调用源码树里的 RTSS：包里漏带组件在开发机上永远不显形，
/// 换台电脑直接瘸，而且 RTSS 的 Profiles 全写回了版本库目录。
/// debug 构建没有资源复制（tauri build --no-bundle），由 build.bat 在 target\debug
/// 旁建 mpv / rtss / skin 目录联接补齐 —— 开发与发布于是走同一条解析路径。
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
    None
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

// ── 让 RTSS 对【正在运行】的真身进程立刻重读 profile ──
// RTSS 在进程创建那一刻就把 profile 焊到进程上。启动器型游戏的真身是启动几秒后
// 才被我们认出来、才写出 <真身>.cfg 的，这时 RTSS 早按「没有专属 profile → 吃
// Global(OSD 关)」注入好了；单靠 LoadProfile+UpdateProfiles 不会把一个已在跑的
// 进程从 Global 改绑到新冒出来的专属 profile（实测：SB 第一把不显示，得重开或预先
// 手填监听进程）。这里直接给它那条共享内存 app 记录置上官方的「请重读 profile」
// 请求位 APPFLAG_PROFILE_UPDATE_REQUESTED，RTSS 下一帧就重读 → 吃到刚写好的
// OSD 配置、当场亮。RTSS 没把真身 hook 进去时(GTA 增强版被反篡改挡住)共享内存里
// 没有这条记录 → 找不到、什么都不做，本就无 OSD 可亮。
//
// 只读 header 自描述的 APP 数组布局(dwAppEntrySize@8 / dwAppArrOffset@12 /
// dwAppArrSize@16) + 条目最前的稳定三字段(dwProcessID@0 / szName[260]@4 /
// dwFlags@264，自 v1.3 起不变)，按进程名文件名部分大小写不敏感命中后只对那一条
// dwFlags OR 一个位，绝不触碰其它字段。见官方 RTSSSharedMemory.h。
const RTSS_SIGNATURE: u32 = 0x5353_5452; // 'RTSS'（小端）
const APP_OFF_NAME: usize = 4;
const APP_OFF_FLAGS: usize = 264;
const APPFLAG_PROFILE_UPDATE_REQUESTED: u32 = 0x1000_0000;

fn nudge_rtss_profile_reload(real_name: &str) -> bool {
    let target = real_name.to_ascii_lowercase();
    let wide: Vec<u16> = SHARED_MEM_NAME.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let handle = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE, FALSE, wide.as_ptr());
        if handle.is_null() {
            return false; // RTSS 没在跑
        }
        let view = MapViewOfFile(handle, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, 0);
        if view.Value.is_null() {
            CloseHandle(handle);
            return false;
        }
        let base = view.Value as *mut u8;
        let rd = |off: usize| -> u32 { (base.add(off) as *const u32).read_unaligned() };
        let mut hit = false;
        // 校验确是 RTSS v2 共享内存再动手，签名/版本不对一律放弃
        if rd(0) == RTSS_SIGNATURE && (rd(4) >> 16) == 2 {
            let entry_size = rd(8) as usize;
            let arr_off = rd(12) as usize;
            let arr_size = rd(16) as usize;
            // entry_size 必须大到放得下 dwFlags，arr_size 给个上限防脏数据跑飞
            if entry_size >= APP_OFF_FLAGS + 4 && arr_off > 0 && arr_size <= 4096 {
                for i in 0..arr_size {
                    let entry = arr_off + i * entry_size;
                    if rd(entry) == 0 {
                        continue; // dwProcessID==0 → 空槽
                    }
                    let mut buf = [0u8; 260];
                    std::ptr::copy_nonoverlapping(base.add(entry + APP_OFF_NAME), buf.as_mut_ptr(), 260);
                    let end = buf.iter().position(|&b| b == 0).unwrap_or(260);
                    let full = String::from_utf8_lossy(&buf[..end]).to_string();
                    let fname = full
                        .rsplit(|c: char| c == '\\' || c == '/')
                        .next()
                        .unwrap_or(full.as_str())
                        .to_ascii_lowercase();
                    if fname == target {
                        let fp = base.add(entry + APP_OFF_FLAGS) as *mut u32;
                        fp.write_unaligned(fp.read_unaligned() | APPFLAG_PROFILE_UPDATE_REQUESTED);
                        hit = true;
                        break;
                    }
                }
            }
        }
        UnmapViewOfFile(view);
        CloseHandle(handle);
        hit
    }
}

// ─────────────────────────────────────────────
// 托盘图标删除（外部 NIM_DELETE）
// ─────────────────────────────────────────────

struct EnumCtx {
    target_pid: u32,
    tray_wnd: HWND,
    dialogs: Vec<HWND>,
}

unsafe extern "system" fn enum_wnd_proc(h: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam as *mut EnumCtx);
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(h, &mut pid);
    if pid != ctx.target_pid {
        return TRUE;
    }
    let mut class = [0u16; 32];
    let n = GetClassNameW(h, class.as_mut_ptr(), class.len() as i32);
    if n > 0 && class[..n as usize] == *DIALOG_CLASS.encode_utf16().collect::<Vec<u16>>().as_slice() {
        ctx.dialogs.push(h);
        return TRUE;
    }
    let mut buf = [0u16; 64];
    let n = GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32);
    if n > 0 && buf[..n as usize] == *TRAY_WND_TITLE.encode_utf16().collect::<Vec<u16>>().as_slice() {
        ctx.tray_wnd = h;
    }
    TRUE
}

/// 扫一遍 RTSS 进程的顶层窗口：托盘回调窗口（title=RivaTunerStatisticsServer，
/// 类名随版本变所以按标题）+ 它弹的警告框（类 #32770）。RTSS 隐藏 PEB 路径
/// （sysinfo 读不到 exe 路径），只能按进程名 + 窗口特征定位
fn scan_rtss_windows(pid: u32) -> (Option<HWND>, Vec<HWND>) {
    let mut ctx = EnumCtx { target_pid: pid, tray_wnd: ptr::null_mut(), dialogs: Vec::new() };
    unsafe {
        EnumWindows(Some(enum_wnd_proc), &mut ctx as *mut EnumCtx as LPARAM);
    }
    ((!ctx.tray_wnd.is_null()).then_some(ctx.tray_wnd), ctx.dialogs)
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

/// RTSS 启动后的收尾：关警告框 + 删托盘图标（一个轮询循环，共用进程表扫描）。
///
/// 警告框（"Direct3D8 components cannot be hooked right now…"）出现在 RTSS 对
/// 【已在运行】的 3D 程序补注入、运行库已加载挂不上钩时 —— 模态框挂在 RTSS 的
/// UI 线程上，还会卡住后面托盘图标的创建，所以「弹框」和「托盘删不掉」两个
/// 症状同源。ZEX 自己启动的游戏已由 ensure_osd_ready 的同步门挡住（RTSS 必先
/// 于游戏进程）；这里兜的是门拦不住的残余场景：预热/设置页启动 RTSS 时，
/// 用户在外面已经开着游戏。对话框按类 #32770 + 归属 RTSS 进程识别，
/// PostMessage WM_CLOSE 关闭 —— 就算关错，后果也只是 RTSS 重弹一次
fn post_start_cleanup() -> bool {
    let deadline = Instant::now() + CLEANUP_TIMEOUT;
    let mut sys = sysinfo::System::new();
    let mut next_scan = Instant::now();
    let mut pid = None;
    let mut icon_deleted = false;
    let mut last_dialog: Option<Instant> = None;
    loop {
        // 进程表 500ms 重扫一次（全量 refresh 很贵，不能跟着 50ms 轮询走）；
        // 重扫也是为了跟上 RTSS 自提权重启换的新 PID
        if Instant::now() >= next_scan {
            // System::new() 是空表，必须 refresh 才有进程（漏掉就是永远找不到）
            sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
            pid = sys
                .processes()
                .values()
                .find(|p| p.name().to_string_lossy().eq_ignore_ascii_case("rtss.exe"))
                .map(|p| p.pid().as_u32());
            next_scan = Instant::now() + Duration::from_millis(500);
        }
        if let Some(pid) = pid {
            let (tray, dialogs) = scan_rtss_windows(pid);
            if !dialogs.is_empty() {
                last_dialog = Some(Instant::now());
                for d in dialogs {
                    unsafe { PostMessageW(d, WM_CLOSE, 0, 0) };
                }
            }
            if !icon_deleted {
                if let Some(tray) = tray {
                    icon_deleted = delete_rtss_tray_icon(tray);
                }
            }
            // 图标删掉 + 警告框静默一阵才算完。没见过框的常态路径删完即走
            // （几十毫秒）；见过框的多等 DIALOG_QUIET —— RTSS 对多个已在跑的
            // 3D 程序挨个弹，关掉一个可能还跟着下一个
            let quiet = last_dialog.map_or(true, |t| t.elapsed() >= DIALOG_QUIET);
            if icon_deleted && quiet {
                return true;
            }
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

// ─────────────────────────────────────────────
// RTSSHooks64.dll 动态加载（libloading）+ profile API
// ─────────────────────────────────────────────

type LoadProfileFn = unsafe extern "C" fn(*const c_char) -> i32;
type DeleteProfileFn = unsafe extern "C" fn(*const c_char) -> i32;
type UpdateProfilesFn = unsafe extern "C" fn() -> i32;

struct RtssApi {
    load_profile: LoadProfileFn,
    delete_profile: DeleteProfileFn,
    update_profiles: UpdateProfilesFn,
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
            delete_profile: *lib.get(b"DeleteProfile").map_err(|e| AppError::Custom(format!("DeleteProfile 导出缺失: {e}")))?,
            update_profiles: *lib.get(b"UpdateProfiles").map_err(|e| AppError::Custom(format!("UpdateProfiles 导出缺失: {e}")))?,
            _lib: lib,
        })
    }
}

fn cstr(s: &str) -> Vec<c_char> {
    // RTSS API 收的是 ANSI（ACP）字符串，中文系统上是 GBK 而非 UTF-8。
    // 以前 s.bytes() 直塞 UTF-8，ASCII exe 名碰巧没事，中文名（太吾绘卷.exe
    // 这类）到 LoadProfile 手里就是乱码：profile 匹配不上，热重载/删除静默
    // 失效（文件本身写对了，要等游戏重启才生效）。RTSS 内部拿 exe 名也是
    // ANSI 缓冲区，按 CP_ACP 转过去正好对齐
    if s.is_ascii() {
        return s.bytes().map(|b| b as c_char).chain(std::iter::once(0)).collect();
    }
    let wide: Vec<u16> = s.encode_utf16().chain(std::iter::once(0)).collect();
    // 先探转完要多少字节（cchWideChar=-1 时返回值含结尾 NUL）
    let need = unsafe {
        WideCharToMultiByte(CP_ACP, 0, wide.as_ptr(), -1, ptr::null_mut(), 0, ptr::null(), ptr::null_mut())
    };
    if need <= 0 {
        log::warn!("profile 名 {s:?} 转不了 ANSI，回退 UTF-8 字节（热重载可能匹配不上）");
        return s.bytes().map(|b| b as c_char).chain(std::iter::once(0)).collect();
    }
    let mut buf = vec![0u8; need as usize];
    let mut defaulted = FALSE;
    let written = unsafe {
        WideCharToMultiByte(CP_ACP, 0, wide.as_ptr(), -1, buf.as_mut_ptr(), need, ptr::null(), &mut defaulted)
    };
    if written <= 0 {
        log::warn!("profile 名 {s:?} 转 ANSI 失败，回退 UTF-8 字节");
        return s.bytes().map(|b| b as c_char).chain(std::iter::once(0)).collect();
    }
    if defaulted != FALSE {
        // 有字符被换成 ?：与 RTSS 内部名多半对不上，这次热重载大概率无效，日志留痕
        log::warn!("profile 名 {s:?} 含 ANSI 表示不了的字符，转换有损");
    }
    // 输出自带结尾 NUL（探测时按 -1 算的），正好是调用方要的 C 字符串
    buf.into_iter().map(|b| b as c_char).collect()
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

/// 该游戏 RTSS profile 绑定的进程 exe 名：rtss_profile_name（真身，检测线程回填）
/// 优先，否则启动 exe 的文件名。
///
/// RTSS 按【真实渲染进程】的 exe 名匹配 profile，而 exe_path 常是启动器
/// （SB.exe → SB-Win64-Shipping.exe 这类），绑在启动器名上的 cfg 真身永远
/// 吃不到 —— 真身名由 bind_profile_to_real_process 首次启动后回填
fn profile_name_for_game(exe_path: &str, rtss_profile_name: &str) -> String {
    if !rtss_profile_name.is_empty() {
        return rtss_profile_name.to_string();
    }
    profile_name_for_exe(exe_path)
}

/// 用户手动指定的监听进程（monitor_process）优先作为 RTSS profile 的绑定名 —— 它同时是
/// 计时与限帧/OSD 的目标进程；未指定时退回 rtss_profile_name（真身检测回填）。monitor
/// 可为完整路径或纯进程名，统一取文件名。把结果当作 profile_name_for_game 的第二参传入即可，
/// RTSS 全链路（面板/同步门/预热）无需各自感知 monitor_process
fn effective_bound(monitor_process: &str, rtss_profile_name: &str) -> String {
    if !monitor_process.trim().is_empty() {
        return profile_name_for_exe(monitor_process);
    }
    rtss_profile_name.to_string()
}

/// 只查 profile 解析需要的两列（get_game 是命令函数不能 pub 跨模块调）
fn game_profile_columns(
    conn: &rusqlite::Connection,
    game_id: &str,
) -> AppResult<(String, String)> {
    conn.query_row(
        "SELECT exe_path, rtss_profile_name, monitor_process FROM games WHERE id = ?",
        [game_id],
        |r| {
            let exe: String = r.get(0)?;
            let bound: String = r.get(1)?;
            let monitor: String = r.get(2)?;
            // monitor_process 优先：用户指定的监听进程即 RTSS profile 目标名
            Ok((exe, effective_bound(&monitor, &bound)))
        },
    )
    .map_err(AppError::from)
}

fn profiles_dir(rtss_dir: &Path) -> PathBuf {
    rtss_dir.join("Profiles")
}

/// 读某游戏 cfg 的指定段为 key=value map（文件不存在返回空 map —— 即默认配置）
fn read_section(path: &Path, section: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let Ok(content) = std::fs::read_to_string(path) else {
        return map;
    };
    let mut in_target = false;
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_target = line.eq_ignore_ascii_case(&format!("[{section}]"));
            continue;
        }
        if in_target {
            if let Some((k, v)) = line.split_once('=') {
                map.insert(k.trim().to_string(), v.trim().to_string());
            }
        }
    }
    map
}

/// 写 profile：**按 key 合并**，不是整段替换。
///
/// 段内我们负责的键就地改写，其余键原样留着；文件里没有的段整段补在末尾；
/// 没点名的段完全不动。
///
/// 必须按 key 合并而不是整段替换：Profiles/Global 的 [Framerate] 有 14 个键
/// （SyncScanline0 / ReflexSleep / PassiveWait …）而 framerate_values 只产出其中几个，
/// [Hooking] 更是有 ~50 个键 —— 整段替换会把 RTSS 自己持久化的配置抹掉
fn merge_sections(path: &Path, sections: &[(&str, &std::collections::HashMap<String, String>)]) -> AppResult<()> {
    // 段落收尾：把该段里文件中没出现过的托管键补在段尾
    fn flush(out: &mut String, pending: &mut Option<std::collections::HashMap<String, String>>) {
        if let Some(remaining) = pending.take() {
            for (k, v) in remaining.iter() {
                out.push_str(&format!("{k}={v}\n"));
            }
        }
    }

    let existing = std::fs::read_to_string(path).unwrap_or_default();
    let mut out = String::new();
    let mut seen = std::collections::HashSet::new();
    // 当前所在段还没写掉的托管键（None = 当前段不归我们管）
    let mut pending: Option<std::collections::HashMap<String, String>> = None;

    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            flush(&mut out, &mut pending);
            let name = trimmed.trim_start_matches('[').trim_end_matches(']').trim();
            out.push_str(&format!("[{name}]\n"));
            if let Some((_, values)) = sections.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)) {
                seen.insert(name.to_lowercase());
                pending = Some((*values).clone());
            }
            continue;
        }
        if let Some(remaining) = pending.as_mut() {
            if let Some((k, _)) = trimmed.split_once('=') {
                if let Some(v) = remaining.remove(k.trim()) {
                    out.push_str(&format!("{}={}\n", k.trim(), v));
                    continue;
                }
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    flush(&mut out, &mut pending);

    for (name, values) in sections {
        if !seen.contains(&name.to_lowercase()) {
            out.push_str(&format!("[{name}]\n"));
            for (k, v) in values.iter() {
                out.push_str(&format!("{k}={v}\n"));
            }
        }
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, out)?;
    Ok(())
}

/// [OSD] 段里 ZEX 负责的键
fn osd_values(cfg: &ProfileConfig) -> std::collections::HashMap<String, String> {
    let mut m = std::collections::HashMap::new();
    m.insert("EnableOSD".into(), if cfg.enabled { "1" } else { "0" }.into());
    // EnableBgnd 是【阴影】不是背景（Help/BUTTON_ENABLE_BGND），一直开着让文字
    // 在浅色画面上也读得清；EnableFill 才是文字底下那层色板
    m.insert("EnableBgnd".into(), "1".into());
    m.insert("EnableFill".into(), if cfg.fill > 0 { "1" } else { "0" }.into());
    // "Show own statistics"：RTSS 自己往 OSD 里填帧数。默认 0 是因为官方假定
    // MSI Afterburner 供数（Afterburner 才是内容源，RTSS 只负责渲染）。ZEX 单独
    // 分发 RTSS，没有 Afterburner，不开这个 OSD 就是一片空白
    m.insert("EnableStat".into(), "1".into());
    m.insert("BaseColor".into(), cfg.color.clone());
    m.insert("BgndColor".into(), "00000000".into());
    // 颜色高位是【透明度】不是不透明度：模板 BaseColor=00FF8000 高位 00 却渲染成
    // 实心橙，说明 00=不透明、FF=全透（Help/BUTTON_COLOR 只说这一位"可调透明度"，
    // 没说方向）。所以 淡 要比 浓 的值大，写反了看着就是「底板没变化」
    m.insert("FillColor".into(), if cfg.fill >= 2 { "60000000" } else { "C0000000" }.into());
    // 色板四周留白，贴着字读起来太挤（模板默认 2）
    m.insert("FillMargin".into(), "4".into());
    let (px, py) = position_coords(cfg.position);
    m.insert("PositionX".into(), px.to_string());
    m.insert("PositionY".into(), py.to_string());
    m.insert("ZoomRatio".into(), cfg.zoom.clamp(1, 8).to_string());
    m.insert("CoordinateSpace".into(), cfg.coordinate_space.clamp(0, 1).to_string());
    m.insert("EnableFrameColorBar".into(), "0".into());
    m.insert("FrameColorBarMode".into(), "0".into());
    m.insert("RefreshPeriod".into(), cfg.refresh_period.clamp(50, 2000).to_string());
    m.insert("IntegerFramerate".into(), if cfg.integer_framerate { "1" } else { "0" }.into());
    m.insert("MaximumFrametime".into(), "0".into());
    m.insert("EnableFrametimeHistory".into(), if cfg.graph_enabled { "1" } else { "0" }.into());
    // 曲线纵轴上限。以前漏了这一句，于是 graph_max 怎么调都不落盘，读回来还会
    // 被 MaximumFrametime=0 顶掉 —— UI 上表现为这一档永远显示 0
    m.insert("FrametimeHistoryMax".into(), cfg.graph_max.clamp(10, 200).to_string());
    m.insert("FrametimeHistoryWidth".into(), (-cfg.graph_width.clamp(8, 48)).to_string());
    m.insert("FrametimeHistoryHeight".into(), "-4".into());
    m.insert("FrametimeHistoryStyle".into(), cfg.graph_style.clamp(0, 1).to_string());
    m.insert("ScaleToFit".into(), "0".into());
    m
}

/// 四角 → RTSS PositionX/PositionY。RTSS 里这两个是【相对原点的坐标】而不是
/// 四角枚举（Help/TEXT_OSD_X: "in reference to the origin"），原点靠哪条边由
/// 坐标正负号决定：负 X = 贴右边，负 Y = 贴下边。之前直接写 1/2/3/4，四个值
/// 全落在左上角差 3 像素，看着就是「位置调不动」
fn position_coords(position: i32) -> (i32, i32) {
    const M: i32 = 8; // 离屏幕边缘留的空隙
    match position {
        2 => (-M, M),  // 右上
        3 => (M, -M),  // 左下
        4 => (-M, -M), // 右下
        _ => (M, M),   // 左上
    }
}

/// [Framerate] 段里 ZEX 负责的键（Limit=0 表示不限；SyncLimiter 0=异步
/// 1=前沿同步 2=后沿同步 3=NVIDIA Reflex，顺序由 RTSS.exe 的下拉标签串表确认）
fn framerate_values(cfg: &ProfileConfig) -> std::collections::HashMap<String, String> {
    let mut m = std::collections::HashMap::new();
    m.insert(
        "Limit".into(),
        if cfg.framerate_enabled { cfg.framerate_limit.clamp(1, 1000).to_string() } else { "0".into() },
    );
    m.insert("LimitDenominator".into(), "1".into());
    m.insert("SyncLimiter".into(), cfg.framerate_mode.clamp(0, 3).to_string());
    m.insert("PassiveWait".into(), if cfg.passive_wait { "1" } else { "0" }.into());
    m.insert("ReflexSetLatencyMarker".into(), if cfg.reflex_marker { "1" } else { "0" }.into());
    m.insert("ReflexSleep".into(), cfg.reflex_sleep.clamp(0, 2).to_string());
    m
}

/// [Hooking] 段里 ZEX 负责的键。
///
/// 「应用检测级别」在 RTSS 里没有对应的 INI 键 —— 官方 Help（BUTTON_NONE/LOW/
/// MEDIUM/HIGH）只描述行为、从不写键名。下面这张表是 2026-08-20 用官方导出的
/// SetProfileProperty("AppDetectionLevel", 0..3) 逐档 SaveProfile 落盘、diff
/// Profiles/Global 实测出来的：
///   0 无 = 0/0/0   1 低 = 1/0/0   2 中 = 1/1/0   3 高 = 1/1/1
/// 顺序也对得上官方描述：低=拦 D3D/OpenGL，中=多拦 DirectDraw，高=再多拦 LoadLibrary
fn hooking_values(cfg: &ProfileConfig) -> std::collections::HashMap<String, String> {
    let lvl = cfg.detection_level.clamp(0, 3);
    let mut m = std::collections::HashMap::new();
    m.insert("EnableHooking".into(), if lvl >= 1 { "1" } else { "0" }.into());
    m.insert("HookDirectDraw".into(), if lvl >= 2 { "1" } else { "0" }.into());
    m.insert("HookLoadLibrary".into(), if lvl >= 3 { "1" } else { "0" }.into());
    m.insert("EnableDynamicOffsetDetection".into(), if cfg.dynamic_offset { "1" } else { "0" }.into());
    m.insert("UseDetours".into(), if cfg.use_detours { "1" } else { "0" }.into());
    m.insert("InjectionDelay".into(), cfg.injection_delay.clamp(0, 60000).to_string());
    m
}

/// OSD 渲染器段（[Renderer*] Implementation=2）。RTSS 内置默认 Implementation=0
/// （禁用）—— 不加这段 OSD 只统计帧数不渲染（2026-08-19 饥荒/鸡马实测踩坑，
/// 反汇编 0x41f0de/0x41f142 确认 D3D8/D3D9 默认 0；2 是 RTSS UI 写入的推荐值）
fn renderer_sections() -> Vec<(String, std::collections::HashMap<String, String>)> {
    let mut m = std::collections::HashMap::new();
    m.insert("Implementation".to_string(), "2".to_string());
    ["RendererDirectDraw", "RendererDirect3D8", "RendererDirect3D9",
     "RendererDirect3D10", "RendererDirect3D11", "RendererDirect3D12",
     "RendererOpenGL", "RendererVulkan"]
        .iter()
        .map(|name| (name.to_string(), m.clone()))
        .collect()
}

/// [Statistics] 段里 ZEX 负责的键
fn statistics_values(cfg: &ProfileConfig) -> std::collections::HashMap<String, String> {
    let mut m = std::collections::HashMap::new();
    // 帧数取平均的窗口，跟重绘间隔绑一起：只改 RefreshPeriod 的话，1000ms 的平均
    // 窗口会把数字压得几乎不动，看着就是「刷新率这一档没用」
    m.insert("FramerateAveragingInterval".into(), cfg.refresh_period.clamp(50, 2000).to_string());
    m
}

/// ZEX 负责写的全部段。没列进来的段 merge_sections 一律不动
fn managed_sections(cfg: &ProfileConfig) -> Vec<(String, std::collections::HashMap<String, String>)> {
    let mut v = vec![
        ("OSD".to_string(), osd_values(cfg)),
        ("Framerate".to_string(), framerate_values(cfg)),
        ("Statistics".to_string(), statistics_values(cfg)),
        ("Hooking".to_string(), hooking_values(cfg)),
    ];
    v.extend(renderer_sections());
    v
}

/// 落盘一份 profile：按 key 合并写入（只覆盖 ZEX 负责的键，其余原样保留）
fn write_profile(rtss_dir: &Path, target: &ProfileTarget, cfg: &ProfileConfig) -> AppResult<()> {
    let owned = managed_sections(cfg);
    let refs: Vec<(&str, &std::collections::HashMap<String, String>)> =
        owned.iter().map(|(name, map)| (name.as_str(), map)).collect();
    merge_sections(&target.path(rtss_dir), &refs)
}

/// 读一份 profile。文件不存在 → 返回默认值（调用方自己决定这算不算「跟随全局」）
fn read_profile(rtss_dir: &Path, target: &ProfileTarget) -> ProfileConfig {
    let path = target.path(rtss_dir);
    config_from_maps(
        &read_section(&path, "OSD"),
        &read_section(&path, "Framerate"),
        &read_section(&path, "Hooking"),
    )
}

/// profile 文件 → ProfileConfig（缺键用默认值）
fn config_from_maps(
    osd: &std::collections::HashMap<String, String>,
    fps: &std::collections::HashMap<String, String>,
    hooking: &std::collections::HashMap<String, String>,
) -> ProfileConfig {
    let mut cfg = ProfileConfig::default();
    let flag = |m: &std::collections::HashMap<String, String>, k: &str, dflt: bool| {
        m.get(k).map(|v| v == "1").unwrap_or(dflt)
    };
    let num = |m: &std::collections::HashMap<String, String>, k: &str, dflt: i32| {
        m.get(k).and_then(|v| v.parse().ok()).unwrap_or(dflt)
    };

    cfg.enabled = flag(osd, "EnableOSD", false);
    // 反解四角：只看正负号（正 = 左/上，负 = 右/下），见 position_coords
    let px = num(osd, "PositionX", 1);
    let py = num(osd, "PositionY", 1);
    cfg.position = match (px < 0, py < 0) {
        (false, false) => 1,
        (true, false) => 2,
        (false, true) => 3,
        (true, true) => 4,
    };
    cfg.zoom = num(osd, "ZoomRatio", 2);
    cfg.color = osd.get("BaseColor").cloned().unwrap_or_else(|| "00FF8000".to_string());
    // 反解浓度：高位越小越不透明（见 osd_values 里的 FillColor），取中点 0x90 分档
    let fill_transparency = osd
        .get("FillColor")
        .and_then(|c| u8::from_str_radix(c.get(..2)?, 16).ok())
        .unwrap_or(0xC0);
    cfg.fill = match osd.get("EnableFill").map(|v| v == "1") {
        Some(true) if fill_transparency < 0x90 => 2,
        Some(true) => 1,
        _ => 0,
    };
    cfg.refresh_period = num(osd, "RefreshPeriod", 500);
    cfg.integer_framerate = flag(osd, "IntegerFramerate", true);
    cfg.coordinate_space = num(osd, "CoordinateSpace", 0);
    cfg.graph_enabled = flag(osd, "EnableFrametimeHistory", false);
    cfg.graph_max = num(osd, "FrametimeHistoryMax", 50);
    cfg.graph_width = num(osd, "FrametimeHistoryWidth", -20).abs();
    cfg.graph_style = num(osd, "FrametimeHistoryStyle", 0);

    let limit = num(fps, "Limit", 0);
    cfg.framerate_enabled = limit > 0;
    cfg.framerate_limit = if limit > 0 { limit } else { 144 };
    cfg.framerate_mode = num(fps, "SyncLimiter", 0);
    cfg.passive_wait = flag(fps, "PassiveWait", true);
    cfg.reflex_marker = flag(fps, "ReflexSetLatencyMarker", true);
    cfg.reflex_sleep = num(fps, "ReflexSleep", 0);

    // 三个键反解回四档，见 hooking_values
    cfg.detection_level = match (
        flag(hooking, "EnableHooking", true),
        flag(hooking, "HookDirectDraw", true),
        flag(hooking, "HookLoadLibrary", true),
    ) {
        (false, _, _) => 0,
        (true, false, _) => 1,
        (true, true, false) => 2,
        (true, true, true) => 3,
    };
    cfg.dynamic_offset = flag(hooking, "EnableDynamicOffsetDetection", false);
    cfg.use_detours = flag(hooking, "UseDetours", false);
    cfg.injection_delay = num(hooking, "InjectionDelay", 15000);
    cfg
}

// ─────────────────────────────────────────────
/// 启动 RTSS.exe。必须走 ShellExecuteEx —— RTSS.exe 的清单是
/// requireAdministrator，CreateProcessW（Rust 的 Command::spawn）不会提权，
/// 一律返回 os error 740 ERROR_ELEVATION_REQUIRED。只有 shell 这条路能触发提权
fn shell_execute_rtss(exe: &Path) -> bool {
    let wide = |s: &std::ffi::OsStr| -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    };
    let file = wide(exe.as_os_str());
    let dir = exe.parent().map(|p| wide(p.as_os_str()));
    let verb: Vec<u16> = "runas".encode_utf16().chain(std::iter::once(0)).collect();

    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    // NOASYNC：本函数在后台线程里跑，不保证有消息泵，同步执行才可靠
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpDirectory = dir.as_ref().map_or(ptr::null(), |d| d.as_ptr());
    info.nShow = SW_SHOWMINNOACTIVE;

    let ok = unsafe { ShellExecuteExW(&mut info) != 0 };
    if !ok {
        log::warn!("RTSS 启动失败（{}）：{}", exe.display(), std::io::Error::last_os_error());
    } else if !info.hProcess.is_null() {
        // 留住句柄给退出时销毁用（见 RTSS_PROCESS）。用 runas 起的 RTSS 已经是提权
        // 状态，不会再自提权重启换 PID，所以这个句柄指向的就是最终那个进程（实测）
        let prev = RTSS_PROCESS.swap(info.hProcess as usize, Ordering::SeqCst);
        if prev != 0 {
            unsafe { CloseHandle(prev as _) };
        }
    }
    ok
}

/// 收掉 RTSS 留下的 RTSSHooksLoader64.exe。
///
/// 这个进程是 RTSS 自己拉起来的 64 位注入宿主，继承了 RTSS 的高完整性级别 ——
/// 和 RTSS 本体不同，ZEX 手里没有它的句柄，Medium IL 的 OpenProcess 一律
/// Access denied（实测），所以只能借一次提权 taskkill。硬杀 RTSS 之后它不会
/// 自己退出（实测父进程没了还常驻），不收就是每次 RTSS 启动残留一个闲置进程。
///
/// 代价：默认 UAC 的机器上退出时会多弹一次同意框（本机 ConsentPromptBehaviorAdmin=0
/// 静默）。这是唯一能跨完整性级别杀它的办法，Job Object 那条路试过 ——
/// AssignProcessToJobObject 对提权进程失败，整棵树收不掉
fn kill_hooks_loader() {
    let file: Vec<u16> = "taskkill.exe".encode_utf16().chain(std::iter::once(0)).collect();
    let params: Vec<u16> = "/F /IM RTSSHooksLoader64.exe"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let verb: Vec<u16> = "runas".encode_utf16().chain(std::iter::once(0)).collect();

    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = params.as_ptr();
    info.nShow = SW_HIDE;

    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        log::warn!("清理 RTSSHooksLoader64 失败：{}", std::io::Error::last_os_error());
        return;
    }
    if !info.hProcess.is_null() {
        // 等 taskkill 跑完再放行（提权进程由 AppInfo 服务创建，不是 ZEX 的子进程，
        // 不等也能活到最后；等一下只是让"退出即干净"可预期）。3 秒够了，
        // 卡在 UAC 同意框上也不至于把退出流程拖住
        unsafe {
            WaitForSingleObject(info.hProcess, 3000);
            CloseHandle(info.hProcess);
        }
    }
}

/// 销毁 ZEX 自己拉起的 RTSS（托盘「退出」时调用，语义同 mpv::shutdown_all）。
/// 没有句柄 = RTSS 是别人起的、我们只是复用，直接放过（连它的 loader 一起不碰）
pub fn shutdown_rtss() {
    let handle = RTSS_PROCESS.swap(0, Ordering::SeqCst);
    if handle == 0 {
        return;
    }
    // 下次再起是全新进程，托盘图标会重建，收尾标志复位
    RTSS_CLEANED.store(false, Ordering::SeqCst);
    unsafe {
        TerminateProcess(handle as _, 0);
        CloseHandle(handle as _);
    }
    kill_hooks_loader();
}

// 确保就绪（launch_game 挂钩 + 设置页共用）
// ─────────────────────────────────────────────

/// 确保 RTSS 在跑（共享内存就绪）+ 排一次后台收尾。预热/设置页路径用
/// READY_TIMEOUT；launch_game 的同步门走 ensure_rtss_running_with(GATE_TIMEOUT)
pub fn ensure_rtss_running(app: &AppHandle) -> AppResult<RtssStatus> {
    ensure_rtss_running_with(app, READY_TIMEOUT)
}

fn ensure_rtss_running_with(app: &AppHandle, timeout: Duration) -> AppResult<RtssStatus> {
    let Some(rtss_dir) = resolve_rtss(app) else {
        return Ok(RtssStatus { installed: false, running: false, path: None });
    };
    // 锁只护 spawn 一瞬（见 RTSS_START_LOCK）。拿不到锁 = 预热/另一条门正在
    // 拉起（runas 的 UAC 同意框会把 spawn 卡到用户点完为止），跳过 spawn 直接连
    // 着等共享内存就行 —— 门有 2 秒上限，不能被别人的锁内等待拖住
    if let Ok(_guard) = RTSS_START_LOCK.try_lock() {
        if !rtss_running() {
            // 新进程会重建托盘图标，收尾标志复位
            RTSS_CLEANED.store(false, Ordering::Relaxed);
            // 启动失败不算致命（可能恰好正在提权重启），统一走共享内存轮询
            shell_execute_rtss(&rtss_dir.join("RTSS.exe"));
        }
    }
    let deadline = Instant::now() + timeout;
    while !rtss_running() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    let running = rtss_running();
    if running {
        schedule_cleanup_once();
    }
    Ok(RtssStatus {
        installed: true,
        running,
        path: Some(rtss_dir.to_string_lossy().to_string()),
    })
}

/// 排一次后台收尾（关警告框 + 删托盘图标），收尾不占调用方时间。swap 抢占
/// 保证并发 ensure 只有一个真正去跑；没收干净把标志放回去，下次 ensure 重试
fn schedule_cleanup_once() {
    if RTSS_CLEANED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        if !post_start_cleanup() {
            RTSS_CLEANED.store(false, Ordering::SeqCst);
            log::warn!("RTSS 收尾未完成：警告框反复弹或托盘图标超时没删掉");
        }
    });
}

/// 这个游戏实际生效的配置对象：有自己的 cfg 就是它，没有就跟随全局。
/// 这条规则是 RTSS 自己的（Help/PLACEHOLDER_APP_WND），ZEX 只是照着判断
fn effective_target(rtss_dir: &Path, profile: &str) -> ProfileTarget {
    let game = ProfileTarget::Game(profile.to_string());
    if game.path(rtss_dir).exists() {
        game
    } else {
        ProfileTarget::Global
    }
}

/// 这个游戏会不会用到 RTSS（OSD 或限帧任一开着）—— 同步门与真身检测线程共用的判断
fn profile_wants(rtss_dir: &Path, exe_path: &str, rtss_profile_name: &str) -> bool {
    let profile = profile_name_for_game(exe_path, rtss_profile_name);
    let cfg = read_profile(rtss_dir, &effective_target(rtss_dir, &profile));
    cfg.enabled || cfg.framerate_enabled
}

/// launch_game 挂钩：这个游戏会用到 OSD 或限帧时，过一道**同步门**再放行。
///
/// 游戏进程必须创建在 RTSS 之后，注入才走 RTSS 内置的新进程钩子；后到的
/// RTSS 只能对已在跑的进程补注入，d3d8 等运行库已加载挂不上，就会弹
/// "Direct3D8 components cannot be hooked right now"（2026-09-20 用户报告，
/// 那之前这里是后台拉起、游戏先跑）。常态下预热已把 RTSS 拉起（见
/// preheat_wants_rtss，单游戏 profile 也算数），门零等待通过；只在预热没
/// 赶上/失败时兜底拉起，GATE_TIMEOUT（2 秒）等不到就放行 —— 那一次没
/// OSD，RTSS 后到弹的警告框由收尾线程关掉。
///
/// **不往 profile 里写任何东西。** 样式和限帧由配置对象决定 —— 游戏有自己的
/// cfg 就用它的，没有就自动吃 Global。以前这里每次启动都拿全局覆写游戏 profile，
/// 那正是「单游戏设置留不住」的根源
pub fn ensure_osd_ready(app: &AppHandle, exe_path: &str, rtss_profile_name: &str) {
    // RTSS 未安装 → 静默跳过（设置页置灰已提示，启动游戏不阻塞）
    let Some(rtss_dir) = resolve_rtss(app) else { return };
    if !profile_wants(&rtss_dir, exe_path, rtss_profile_name) {
        return;
    }
    let was_running = rtss_running();
    let _ = ensure_rtss_running_with(app, GATE_TIMEOUT);
    // 门自己拉起来的才给初始化余量：共享内存就绪 ≈ 核心已起，但新进程监视
    // 的布防时机没有文档可考，300ms 保险。RTSS 已在跑的常态路径零延迟
    if !was_running && rtss_running() {
        std::thread::sleep(Duration::from_millis(300));
    }
}

/// 真身 profile 的检测窗口：SB.exe → SB-Win64-Shipping.exe 这类「启动器拉起真身」
/// 的链路里，真身进程正常都在启动后几十秒内出现；冷盘首窗可能分钟级，进程本身
/// 不会。等不到基本就是非启动器型，静默放弃（下次启动再试）
const REAL_PROCESS_WATCH: Duration = Duration::from_secs(120);

/// 真身识别（检测线程与写入路径共用）：在 game_process_matches 的命中进程里，
/// 找 exe 名 ≠ 启动器名的进程 —— 带可见窗口的优先（启动器 SB.exe 无窗口、真身有），
/// 无窗口的兜底（真身创建早期窗口未就绪的瞬间也认得上）。比较用小写，返回的
/// 名字保留进程报告的原始大小写（对齐 RTSS 自己生成 profile 时的命名，避免它
/// 按大小写匹配不上）
fn scan_real_process_name(
    sys: &sysinfo::System,
    exe_path: &str,
    dir_key: &str,
    launcher_lower: &str,
) -> Option<String> {
    let mut real: Option<String> = None;
    // 自动检测路径（仅在用户未指定监听进程时才走到这里），monitor 传空
    for pid in crate::games::game_process_matches(sys, exe_path, dir_key, "") {
        let Some(p) = sys.process(sysinfo::Pid::from_u32(pid)) else { continue };
        // 真身名优先取 exe 路径的文件名（保留原始大小写）；受保护 / 提权进程读不到
        // 路径（p.exe()=None）时回退进程名 —— p.name() 来自系统快照、对所有进程可得，
        // 同样是「xxx.exe」形。否则父链刚把这种真身捞进 game_process_matches，这里又
        // 因读不到路径把它漏掉（GTA5_Enhanced.exe 正是这种：子进程、路径常读不到）
        let display = p
            .exe()
            .and_then(|pe| pe.file_name())
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_else(|| p.name().to_string_lossy().to_string());
        let name = display.to_lowercase();
        if name.is_empty() || name == launcher_lower {
            continue;
        }
        if crate::games::process_has_visible_window(pid) {
            return Some(display);
        }
        real.get_or_insert(display);
    }
    real
}

/// 启动器型游戏的 profile 绑定修正（launch_game 后台线程调用，不阻塞启动）。
///
/// exe_path 可能是启动器（SB.exe），真身渲染进程是另一个名字
/// （SB-Win64-Shipping.exe，位于 install_dir 内）—— RTSS 按**真身的 exe 名**匹配
/// profile，绑在启动器名上的单游戏 cfg 真身永远吃不到（这正是 Stellar Blade 的
/// OSD/限帧不生效的根因，与计时当初漏掉真身同源）。复用计时的进程匹配规则
/// （game_process_matches：exe 全路径 / install_dir 内 / 进程名）盯进程表，
/// 发现真身名后：
/// 1. `Profiles/<启动器名>.cfg` 存在且真身名 cfg 不存在 → rename 过去保留用户
///    已有配置，LoadProfile + UpdateProfiles 热重载 —— 运行中的真身当场生效，
///    不用重启游戏
/// 2. 回填 games.rtss_profile_name —— 之后 RTSS 全链路（同步门/面板/预热）直接
///    用真身名，下次启动 RTSS 在真身创建瞬间就命中配置，零间隙
/// 3. 跟随全局的游戏（启动器名无 cfg）只回填不写文件，「跟随全局」语义不变
///
/// 不用 RTSS 的游戏（OSD/限帧全关）直接返回 —— 检测只为 profile 服务，别让
/// 普通游戏每次启动都白扫 2 分钟进程表
pub fn bind_profile_to_real_process(
    app: AppHandle,
    exe_path: String,
    install_dir: String,
    game_id: String,
) {
    std::thread::spawn(move || {
        let Some(rtss_dir) = resolve_rtss(&app) else { return };
        if !profile_wants(&rtss_dir, &exe_path, "") {
            return;
        }
        let launcher = profile_name_for_exe(&exe_path);
        if launcher.is_empty() {
            return;
        }
        let Some(dir_key) = effective_match_dir(&exe_path, &install_dir) else { return };

        let mut sys = sysinfo::System::new();
        let deadline = Instant::now() + REAL_PROCESS_WATCH;
        while Instant::now() < deadline {
            sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
            if let Some(real_name) =
                scan_real_process_name(&sys, &exe_path, &dir_key, &launcher.to_lowercase())
            {
                bind_profile_to_real(&app, &rtss_dir, &game_id, &launcher, &real_name);
                return;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

/// 写入路径的同步纠正：target 落在启动器 exe 名上（真身还没绑定）而游戏正在跑时，
/// 刚写入启动器名 cfg 的配置真身吃不到 —— 扫一次进程表，发现真身就把这份
/// rename 到真身名下并热重载，面板操作当场可见。游戏没跑则扫不到，等下次启动
/// 的 watch 线程归位。必须在 write_profile **之后**调用：rename 要带走刚写的
/// 新内容，顺序反了会把旧配置重定向过去、新配置留在启动器名下变孤儿
fn bind_unbound_game_profile(app: &AppHandle, state: &AppState, rtss_dir: &Path, game_id: &str) {
    let Ok((exe, install_dir, bound)) = target_game_row(state, game_id) else {
        return;
    };
    if !bound.is_empty() {
        return;
    }
    let launcher = profile_name_for_exe(&exe);
    if launcher.is_empty() {
        return;
    }
    let Some(dir_key) = effective_match_dir(&exe, &install_dir) else { return };
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    if let Some(real_name) = scan_real_process_name(&sys, &exe, &dir_key, &launcher.to_lowercase())
    {
        bind_profile_to_real(app, rtss_dir, game_id, &launcher, &real_name);
    }
}

// install_dir 是真身匹配的主力规则（exe 全路径匹配只认启动器自己）。空则用
// exe 所在目录兜底 —— 启动器与真身基本同目录，仍有发现能力
fn effective_match_dir(exe_path: &str, install_dir: &str) -> Option<String> {
    if !install_dir.is_empty() {
        return Some(install_dir.to_string());
    }
    Path::new(exe_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .filter(|d| !d.is_empty())
}

/// 发现真身后落盘：profile 文件重定向（启动器名 → 真身名）+ 热重载 + 回填真身名。
/// rename 与回填相互独立 —— 文件动不了（如被占用）也不影响回填，下次启动
/// ensure_osd_ready 用真身名解析，cfg 缺失就吃 Global，不比修复前差
fn bind_profile_to_real(
    app: &AppHandle,
    rtss_dir: &Path,
    game_id: &str,
    launcher: &str,
    real: &str,
) {
    let real_target = ProfileTarget::Game(real.to_string());
    let real_cfg = real_target.path(rtss_dir);
    if !real_cfg.exists() {
        let launcher_cfg = ProfileTarget::Game(launcher.to_string()).path(rtss_dir);
        if launcher_cfg.exists() {
            match std::fs::rename(&launcher_cfg, &real_cfg) {
                Ok(()) => {
                    // 把新 cfg 载入 RTSS 的 profile 集（文件→内存）。真正让「已在
                    // 跑的真身」当场换用这份 profile 的是下面的 nudge；单 reload 不会
                    // 把运行中进程从 Global 改绑过来。RTSS 没在跑时静默失败
                    let _ = reload_profile(rtss_dir, &real_target);
                }
                Err(e) => {
                    log::warn!(
                        "RTSS profile 重定向失败（{} → {}）：{}",
                        launcher_cfg.display(),
                        real_cfg.display(),
                        e
                    );
                }
            }
        }
    }
    // 让正在跑的真身当场重读 profile（给它那条共享内存记录置「请重读」请求位）——
    // 这才是「第一把就显示」的关键：上面的 reload 只把文件载进 RTSS，运行中的进程
    // 仍停在 Global。RTSS 没运行 / 没 hook 到真身时此调用无副作用（找不到记录）
    let _ = nudge_rtss_profile_reload(real);
    // 回填真身名。WHERE 空值守卫：连续两次 launch_game 会起两个检测线程，
    // 都到这里时先到的写入、后到的不再覆盖（防并发，正常路径只有一个线程）
    let state = app.state::<AppState>();
    let conn = state.db.lock();
    if let Err(e) = conn.execute(
        "UPDATE games SET rtss_profile_name = ? WHERE id = ? AND (rtss_profile_name = '' OR rtss_profile_name IS NULL)",
        rusqlite::params![real, game_id],
    ) {
        log::error!("回填 RTSS 真身 profile 名失败: {}", e);
    }
}

/// 开机预热判断用：全局**或任一游戏**的 profile 开了 OSD 或限帧。
/// 只看全局会漏掉「全局关、单游戏开」的库 —— 那种库点游戏时 RTSS 冷启动，
/// 游戏进程抢在前面，正是 2026-09-20 弹窗问题的入口之一
pub fn preheat_wants_rtss(app: &AppHandle, state: &AppState) -> bool {
    let Some(rtss_dir) = resolve_rtss(app) else { return false };
    let wants = |cfg: &ProfileConfig| cfg.enabled || cfg.framerate_enabled;
    if wants(&read_profile(&rtss_dir, &ProfileTarget::Global)) {
        return true;
    }
    let exes: Vec<(String, String, String)> = {
        let conn = state.db.lock();
        conn.prepare("SELECT exe_path, rtss_profile_name, monitor_process FROM games")
            .and_then(|mut s| {
                s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
                    .map(|rows| rows.flatten().collect())
            })
            .unwrap_or_default()
    };
    exes.iter()
        .map(|(exe, bound, monitor)| profile_name_for_game(exe, &effective_bound(monitor, bound)))
        .filter(|name| !name.is_empty())
        .any(|name| {
            let target = ProfileTarget::Game(name);
            // 没有 cfg = 跟随全局（全局是关的才走到这），不用读文件
            target.path(&rtss_dir).exists() && wants(&read_profile(&rtss_dir, &target))
        })
}

/// LoadProfile + UpdateProfiles：让 RTSS 从文件重载并应用该 profile
fn reload_profile(rtss_dir: &Path, target: &ProfileTarget) -> AppResult<()> {
    let api = load_rtss_api(rtss_dir)?;
    let name = cstr(target.api_name());
    unsafe {
        (api.load_profile)(name.as_ptr());
        (api.update_profiles)();
    }
    Ok(())
}

// ─────────────────────────────────────────────
// 旧模型迁移（一次性）
// ─────────────────────────────────────────────

/// 从「一份全局广播到所有 profile」迁到「Global + 单游戏 profile」。
///
/// 旧模型把 settings 表里的 12 个 rtss_* 键当唯一样式源，每次改动就整份 clone 到每个
/// 游戏 cfg —— 连 EnableOSD 一起。所以每个游戏 cfg 都只是全局的复制品，**唯一可能
/// 与全局不同的就是那个开关**（右键翻转过、之后没再动过面板）。迁移据此判断：
/// 开关与全局一致的直接删掉（删掉 = 跟随全局，内容等价，但从此改全局才真的能影响它），
/// 不一致的保留成「单独设置」—— 那正是当初右键的意图。
pub fn migrate_profile_model(app: &AppHandle, state: &AppState) {
    const FLAG: &str = "rtss_profile_model_v2";
    let Some(rtss_dir) = resolve_rtss(app) else { return };
    {
        let conn = state.db.lock();
        let done: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = ?", [FLAG], |r| r.get(0))
            .ok();
        if done.is_some() {
            return;
        }
    }

    let legacy = legacy_global_config(state);
    if let Err(e) = write_profile(&rtss_dir, &ProfileTarget::Global, &legacy) {
        log::warn!("迁移全局 profile 失败：{e}");
        return; // 不落标志位，下次启动重试
    }

    let games: Vec<String> = {
        let conn = state.db.lock();
        conn.prepare("SELECT exe_path FROM games")
            .and_then(|mut s| s.query_map([], |r| r.get::<_, String>(0)).map(|rows| rows.flatten().collect()))
            .unwrap_or_default()
    };
    for exe in games {
        let profile = profile_name_for_exe(&exe);
        if profile.is_empty() {
            continue;
        }
        let path = ProfileTarget::Game(profile).path(&rtss_dir);
        if !path.exists() {
            continue;
        }
        let game_enabled = read_section(&path, "OSD").get("EnableOSD").map(|v| v == "1").unwrap_or(false);
        if game_enabled == legacy.enabled {
            let _ = std::fs::remove_file(&path);
        }
    }

    let conn = state.db.lock();
    let _ = conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')", [FLAG]);
    // 旧的 12 个键从此没人读，留着只会让人以为还有第二份真相
    let _ = conn.execute("DELETE FROM settings WHERE key LIKE 'rtss_osd_%' OR key LIKE 'rtss_fps_%'", []);
}

/// 只给迁移用：读旧模型那 12 个 settings 键
fn legacy_global_config(state: &AppState) -> ProfileConfig {
    let mut cfg = ProfileConfig::default();
    let conn = state.db.lock();
    let get = |key: &str| -> Option<String> {
        conn.query_row("SELECT value FROM settings WHERE key = ?", [key], |r| r.get(0)).ok()
    };
    cfg.enabled = get("rtss_osd_enabled").map(|v| v == "1").unwrap_or(false);
    cfg.position = get("rtss_osd_position").and_then(|v| v.parse().ok()).unwrap_or(1);
    cfg.zoom = get("rtss_osd_zoom").and_then(|v| v.parse().ok()).unwrap_or(2);
    cfg.color = get("rtss_osd_color").unwrap_or_else(|| "00FF8000".to_string());
    cfg.fill = get("rtss_osd_fill").and_then(|v| v.parse().ok()).unwrap_or(1);
    cfg.graph_enabled = get("rtss_osd_graph").map(|v| v == "1").unwrap_or(false);
    cfg.graph_max = get("rtss_osd_graph_max").and_then(|v| v.parse().ok()).unwrap_or(50);
    cfg.graph_width = get("rtss_osd_graph_width").and_then(|v| v.parse().ok()).unwrap_or(20);
    cfg.refresh_period = get("rtss_osd_refresh").and_then(|v| v.parse().ok()).unwrap_or(500);
    cfg.framerate_enabled = get("rtss_fps_enabled").map(|v| v == "1").unwrap_or(false);
    cfg.framerate_limit = get("rtss_fps_limit").and_then(|v| v.parse().ok()).unwrap_or(144);
    cfg.framerate_mode = get("rtss_fps_mode").and_then(|v| v.parse().ok()).unwrap_or(0);
    cfg
}

// ─────────────────────────────────────────────
// Tauri Commands
// ─────────────────────────────────────────────

/// 前端用的「配置对象」id：全局固定是这个字符串，其余是 game_id
const GLOBAL_TARGET: &str = "global";

#[derive(Debug, Clone, Serialize)]
pub struct ProfileTargetInfo {
    /// "global" 或 game_id
    pub id: String,
    pub name: String,
    /// 有自己的 profile 文件 = 单独设置；false = 跟随全局。全局对象恒为 true
    pub has_own_profile: bool,
    /// 自己的 profile 内容与全局逐项相同 —— 此时「单独设置」/「恢复跟随全局」都没有实际
    /// 意义（删不删文件行为一样），前端据此隐藏这两个入口。全局对象恒为 false
    pub same_as_global: bool,
}

/// target（game_id）对应的 (exe_path, install_dir, rtss_profile_name)。
/// 写入路径判断「是否需要真身纠正」用
fn target_game_row(state: &AppState, target: &str) -> AppResult<(String, String, String)> {
    let conn = state.db.lock();
    conn.query_row(
        "SELECT exe_path, install_dir, rtss_profile_name, monitor_process FROM games WHERE id = ?",
        [target],
        |r| {
            let exe: String = r.get(0)?;
            let install: String = r.get(1)?;
            let bound: String = r.get(2)?;
            let monitor: String = r.get(3)?;
            // 第三元素折叠成「有效绑定名」：monitor_process 优先。bind_unbound_game_profile
            // 据此判断 —— 用户已指定监听进程时视为已绑定，跳过启动器→真身的自动纠正
            Ok((exe, install, effective_bound(&monitor, &bound)))
        },
    )
    .map_err(AppError::from)
}

fn resolve_target(state: &AppState, target: &str) -> AppResult<ProfileTarget> {
    if target == GLOBAL_TARGET {
        return Ok(ProfileTarget::Global);
    }
    let (exe, bound) = {
        let conn = state.db.lock();
        game_profile_columns(&conn, target)?
    };
    let profile = profile_name_for_game(&exe, &bound);
    if profile.is_empty() {
        return Err(AppError::Custom("这个游戏还没有设置启动程序，无法单独配置".to_string()));
    }
    Ok(ProfileTarget::Game(profile))
}

fn require_rtss(app: &AppHandle) -> AppResult<PathBuf> {
    resolve_rtss(app).ok_or_else(|| AppError::Custom("RTSS 未安装".to_string()))
}

#[tauri::command(async)]
pub fn rtss_status(app: AppHandle) -> AppResult<RtssStatus> {
    let dir = resolve_rtss(&app);
    Ok(RtssStatus {
        installed: dir.is_some(),
        running: rtss_running(),
        path: dir.map(|p| p.to_string_lossy().to_string()),
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

/// 面板顶部的「配置对象」列表：全局 + 库里每个游戏（顺序与游戏页一致）
#[tauri::command(async)]
pub fn rtss_list_targets(app: AppHandle, state: State<'_, AppState>) -> AppResult<Vec<ProfileTargetInfo>> {
    let rtss_dir = require_rtss(&app)?;
    // 全局只读一次，逐游戏比较「内容与全局是否相同」。N 个游戏各读一个 ~1KB 的
    // cfg 再比一次 PartialEq，毫秒级，面板打开一次足够
    let global_cfg = read_profile(&rtss_dir, &ProfileTarget::Global);
    let mut out = vec![ProfileTargetInfo {
        id: GLOBAL_TARGET.to_string(),
        name: "global".to_string(), // 前端自己按语言显示
        has_own_profile: true,
        same_as_global: false,
    }];
    let conn = state.db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, name, exe_path, rtss_profile_name, monitor_process FROM games WHERE hidden = 0
         ORDER BY CASE WHEN sort_order = 0 THEN 1 ELSE 0 END, sort_order, created_at, id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
        ))
    })?;
    for (id, name, exe, bound, monitor) in rows.flatten() {
        // monitor_process 优先作为 profile 绑定名（与计时同一进程）
        let profile = profile_name_for_game(&exe, &effective_bound(&monitor, &bound));
        if profile.is_empty() {
            continue; // 没有启动程序就没法按 exe 名匹配 profile
        }
        let target = ProfileTarget::Game(profile);
        let has_own = target.path(&rtss_dir).exists();
        out.push(ProfileTargetInfo {
            id,
            name,
            has_own_profile: has_own,
            same_as_global: has_own && read_profile(&rtss_dir, &target) == global_cfg,
        });
    }
    Ok(out)
}

/// 读一个配置对象。游戏若是「跟随全局」，返回的就是全局的值
/// （前端据 rtss_list_targets 的 has_own_profile 决定要不要标成继承来的）
#[tauri::command(async)]
pub fn rtss_read_profile(app: AppHandle, state: State<'_, AppState>, target: String) -> AppResult<ProfileConfig> {
    let rtss_dir = require_rtss(&app)?;
    let target = resolve_target(&state, &target)?;
    let effective = match &target {
        ProfileTarget::Game(profile) => effective_target(&rtss_dir, profile),
        ProfileTarget::Global => ProfileTarget::Global,
    };
    Ok(read_profile(&rtss_dir, &effective))
}

/// 写一个配置对象。对游戏来说，写入即意味着「单独设置」（文件被创建出来）
/// 按需同步 RTSS 进程：还有任何配置对象（全局或单游戏）开着 OSD/限帧就立刻
/// 拉起，全都关了就销毁自己拉起的那份。rtss_write_profile / rtss_clear_profile
/// 落盘后调用 —— 用户在面板上开关帧数显示，RTSS 的生死马上跟着走，不用等
/// 下次启动游戏或重启 ZEX
fn sync_rtss_to_demand(app: &AppHandle, state: &AppState) {
    if preheat_wants_rtss(app, state) {
        // 后台拉：落盘不等 RTSS 冷启动（UAC/初始化），面板状态行会自己刷上来
        let app = app.clone();
        std::thread::spawn(move || {
            let _ = ensure_rtss_running(&app);
        });
    } else {
        // 全关了。只杀自己拉的（RTSS_PROCESS == 0 时 shutdown 是空操作，复用
        // 别人的 RTSS 一律不碰）；正在跑的游戏里已注入的 OSD 不受影响，只是
        // 新进程不再注入
        shutdown_rtss();
    }
}

#[tauri::command(async)]
pub fn rtss_write_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    target: String,
    config: ProfileConfig,
) -> AppResult<()> {
    let rtss_dir = require_rtss(&app)?;
    let resolved = resolve_target(&state, &target)?;
    write_profile(&rtss_dir, &resolved, &config)?;
    // 先落盘、后纠偏：真身未绑定时把刚写的这份 rename 到真身名下（见
    // bind_unbound_game_profile 的顺序说明）
    if let ProfileTarget::Game(_) = &resolved {
        bind_unbound_game_profile(&app, &state, &rtss_dir, &target);
    }
    // 正在跑的游戏立刻跟着变（若上面已按真身名热重载，这次重复调用无害）
    let _ = reload_profile(&rtss_dir, &resolved);
    // 开了帧数/限帧 → RTSS 立刻在跑；全都关了 → 收掉自己拉的那份
    sync_rtss_to_demand(&app, &state);
    Ok(())
}

/// 出厂默认配置。前端「恢复默认」取这一份再原样写回去 —— 默认值只在 Rust 这边定义
#[tauri::command(async)]
pub fn rtss_default_profile() -> ProfileConfig {
    ProfileConfig::default()
}

/// 恢复跟随全局：删掉该游戏自己的 profile。
/// 先让 RTSS 自己 DeleteProfile（它持有这份 profile 的内存副本，直接删文件它不知道），
/// 再补一次文件删除兜底
#[tauri::command(async)]
pub fn rtss_clear_profile(app: AppHandle, state: State<'_, AppState>, game_id: String) -> AppResult<()> {
    let rtss_dir = require_rtss(&app)?;
    let target = resolve_target(&state, &game_id)?;
    let ProfileTarget::Game(_) = &target else {
        return Err(AppError::Custom("全局配置不能删除".to_string()));
    };
    if let Ok(api) = load_rtss_api(&rtss_dir) {
        let name = cstr(target.api_name());
        unsafe {
            (api.delete_profile)(name.as_ptr());
            (api.update_profiles)();
        }
    }
    let path = target.path(&rtss_dir);
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    // 删掉的可能是最后一个「想用 RTSS」的配置对象 —— 按需同步进程生死
    sync_rtss_to_demand(&app, &state);
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

    /// 把 managed_sections 写进任意路径（测试里不需要真的有 rtss 目录）
    fn write_managed(path: &Path, cfg: &ProfileConfig) {
        let owned = managed_sections(cfg);
        let refs: Vec<(&str, &std::collections::HashMap<String, String>)> =
            owned.iter().map(|(n, m)| (n.as_str(), m)).collect();
        merge_sections(path, &refs).unwrap();
    }

    fn read_back(path: &Path) -> ProfileConfig {
        config_from_maps(
            &read_section(path, "OSD"),
            &read_section(path, "Framerate"),
            &read_section(path, "Hooking"),
        )
    }

    #[test]
    fn write_creates_full_section() {
        let p = tmp_cfg("new.cfg");
        let _ = std::fs::remove_file(&p);
        let mut cfg = ProfileConfig::default();
        cfg.enabled = true;
        cfg.position = 3;
        cfg.zoom = 4;
        cfg.color = "00FFFF00".into();
        cfg.graph_enabled = true;
        write_managed(&p, &cfg);
        let content = std::fs::read_to_string(&p).unwrap();
        assert!(content.contains("[OSD]\n"));
        assert!(content.contains("EnableOSD=1\n"));
        assert!(content.contains("PositionX=8\n"));
        assert!(content.contains("PositionY=-8\n"));
        assert!(content.contains("ZoomRatio=4\n"));
        assert!(content.contains("BaseColor=00FFFF00\n"));
        assert!(content.contains("EnableFrametimeHistory=1\n"));
    }

    #[test]
    fn merge_keeps_unmanaged_keys_in_same_section() {
        // 本次最容易回归的点：以前是整段替换，会把 RTSS 自己持久化的
        // ReflexLowLatency / SyncScanline0 这类键连同整段一起抹掉
        let p = tmp_cfg("merge.cfg");
        std::fs::write(
            &p,
            "[OSD]\nEnableOSD=0\nPositionX=1\nPerformanceProfiler=1\n\
             \n[Framerate]\nLimit=200\nSyncScanline0=42\nReflexLowLatency=1\n\
             \n[Hooking]\nEnableHooking=1\nHookDXGI=1\nTrampolineType=2\n\
             \n[Info]\nTimestamp=test\n",
        )
        .unwrap();
        let mut cfg = ProfileConfig::default();
        cfg.enabled = true;
        cfg.position = 2;
        write_managed(&p, &cfg);
        let content = std::fs::read_to_string(&p).unwrap();

        // 托管键就地改写
        assert!(content.contains("EnableOSD=1\n"));
        assert!(content.contains("PositionX=-8\n"));
        assert!(content.contains("Limit=0\n"));
        assert!(!content.contains("PositionX=1\n"));
        // 同段里我们不管的键必须活着
        assert!(content.contains("PerformanceProfiler=1\n"));
        assert!(content.contains("SyncScanline0=42\n"));
        assert!(content.contains("ReflexLowLatency=1\n"));
        assert!(content.contains("HookDXGI=1\n"));
        assert!(content.contains("TrampolineType=2\n"));
        // 没点名的段原样保留
        assert!(content.contains("[Info]\nTimestamp=test"));
    }

    #[test]
    fn fill_light_is_more_transparent_than_heavy() {
        let mut cfg = ProfileConfig::default();
        cfg.fill = 1;
        let light = osd_values(&cfg)["FillColor"].clone();
        cfg.fill = 2;
        let heavy = osd_values(&cfg)["FillColor"].clone();
        let hi = |s: &str| u8::from_str_radix(&s[..2], 16).unwrap();
        // 高位是透明度：淡 = 更透明 = 更大的值。写反了 UI 上两档看着一样
        assert!(hi(&light) > hi(&heavy), "light={light} heavy={heavy}");
        cfg.fill = 0;
        assert_eq!(osd_values(&cfg)["EnableFill"], "0");
    }

    #[test]
    fn detection_level_roundtrip() {
        // 2026-08-20 实测的映射：0 无 = 0/0/0，1 低 = 1/0/0，2 中 = 1/1/0，3 高 = 1/1/1
        let expect = [("0", "0", "0"), ("1", "0", "0"), ("1", "1", "0"), ("1", "1", "1")];
        for (lvl, (hook, ddraw, loadlib)) in expect.iter().enumerate() {
            let mut cfg = ProfileConfig::default();
            cfg.detection_level = lvl as i32;
            let m = hooking_values(&cfg);
            assert_eq!(m["EnableHooking"], *hook, "level {lvl}");
            assert_eq!(m["HookDirectDraw"], *ddraw, "level {lvl}");
            assert_eq!(m["HookLoadLibrary"], *loadlib, "level {lvl}");

            let p = tmp_cfg(&format!("detect{lvl}.cfg"));
            let _ = std::fs::remove_file(&p);
            write_managed(&p, &cfg);
            assert_eq!(read_back(&p).detection_level, lvl as i32);
        }
    }

    #[test]
    fn profile_roundtrip() {
        let p = tmp_cfg("roundtrip.cfg");
        let _ = std::fs::remove_file(&p);
        let mut cfg = ProfileConfig::default();
        cfg.enabled = true;
        cfg.position = 4;
        cfg.zoom = 6;
        cfg.color = "00FF0000".into();
        cfg.fill = 2;
        cfg.refresh_period = 200;
        cfg.integer_framerate = false;
        cfg.coordinate_space = 1;
        cfg.graph_enabled = true;
        // graph_max 以前从来没被写进过文件（osd_values 漏了这一句），读回来永远是 0
        cfg.graph_max = 100;
        cfg.graph_width = 32;
        cfg.graph_style = 1;
        cfg.framerate_enabled = true;
        cfg.framerate_limit = 120;
        cfg.framerate_mode = 2;
        cfg.passive_wait = false;
        cfg.reflex_marker = false;
        cfg.reflex_sleep = 2;
        cfg.detection_level = 2;
        cfg.dynamic_offset = true;
        cfg.use_detours = true;
        cfg.injection_delay = 0;
        write_managed(&p, &cfg);
        assert_eq!(read_back(&p), cfg);
    }

    #[test]
    fn global_target_has_no_cfg_suffix() {
        let dir = Path::new("D:\\rtss");
        assert!(ProfileTarget::Global.path(dir).ends_with("Profiles\\Global"));
        assert!(ProfileTarget::Game("cs2.exe".into()).path(dir).ends_with("Profiles\\cs2.exe.cfg"));
        // LoadProfile/SaveProfile 的全局参数是空串（实测）
        assert_eq!(ProfileTarget::Global.api_name(), "");
    }

    #[test]
    fn profile_name_from_exe_path() {
        assert_eq!(profile_name_for_exe("D:\\games\\Cyberpunk2077\\REDprelauncher.exe"), "REDprelauncher.exe");
        assert_eq!(profile_name_for_exe("game.exe"), "game.exe");
        assert_eq!(profile_name_for_exe(""), "");
    }

    #[test]
    fn profile_name_prefers_bound_real_process() {
        // 真身名回填后优先生效：RTSS 按真身 exe 名匹配 profile，启动器名只是回填前的兜底
        assert_eq!(
            profile_name_for_game("D:\\Games\\Stellar Blade\\SB.exe", "SB-Win64-Shipping.exe"),
            "SB-Win64-Shipping.exe"
        );
        // 未回填（空）→ 回退启动 exe 文件名，与旧行为一致
        assert_eq!(profile_name_for_game("D:\\Games\\Stellar Blade\\SB.exe", ""), "SB.exe");
    }

    #[test]
    fn cstr_converts_cjk_names_to_ansi_not_utf8() {
        // 修复点：RTSS API 收 ANSI（ACP）字符串。旧实现 s.bytes() 直塞 UTF-8，
        // 中文 exe 名到 LoadProfile 手里必成乱码，热重载静默失效
        let bytes: Vec<u8> = cstr("太吾绘卷.exe").iter().map(|&b| b as u8).collect();
        assert_eq!(*bytes.last().unwrap(), 0, "NUL 结尾");
        // 非 ASCII 段必须真的被重编过（不再等于 UTF-8 原字节）
        assert_ne!(&bytes[..bytes.len() - 1], "太吾绘卷.exe".as_bytes());
        // ASCII 段原样保留
        assert_eq!(&bytes[bytes.len() - 5..bytes.len() - 1], b".exe");
        // 纯 ASCII（含 Global 的空串）走快路，语义与旧实现一致
        let ascii_bytes: Vec<u8> = cstr("cs2.exe").iter().map(|&b| b as u8).collect();
        assert_eq!(cstr("").as_slice(), [0]);
        assert_eq!(ascii_bytes, b"cs2.exe\0");
    }
}
