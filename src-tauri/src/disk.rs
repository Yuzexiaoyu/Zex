// 磁盘管理：卷枚举（本地 + SMB 网络盘）、文件夹体积、跨盘移动游戏/影视（带进度与取消），
// 移动后静默重启 Steam 使其重新识别。Steam 路径探测走 crate::steam；归档守卫 crate::archive。
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use sysinfo::System;
use tauri::{Emitter, State};
use crate::{archive, steam};
use crate::{AppError, AppResult, AppState};

#[derive(Debug, Serialize, Clone)]
pub struct DiskVolume {
    pub drive: String,        // 盘符 "C:"
    pub mount_point: String,  // "C:\\"
    pub file_system: String,  // "NTFS"
    pub label: String,        // 卷标（系统分区常为空）；网络盘为共享名（无卷标时退回 UNC）
    pub total: u64,
    pub used: u64,
    pub available: u64,
    pub removable: bool,
    pub remote: bool,         // 网络映射盘（SMB 等映射了盘符的远程共享）
    pub unc: String,          // 远程映射盘的 UNC 根（\\server\share）；本地盘为空
}

// 枚举网络映射盘（SMB/NFS 共享映射的盘符，GetDriveTypeW == DRIVE_REMOTE）。
// sysinfo 的 Disks 在 Windows 只收 DRIVE_FIXED / DRIVE_REMOVABLE，网络盘被它直接
// 跳过（sysinfo/src/windows/disk.rs），磁盘管理要展示 SMB 盘只能在这里单独补
fn network_volumes() -> Vec<DiskVolume> {
    use windows_sys::Win32::Foundation::WIN32_ERROR;
    use windows_sys::Win32::NetworkManagement::WNet::WNetGetConnectionW;
    use windows_sys::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDriveStringsW, GetVolumeInformationW,
    };
    use windows_sys::Win32::System::WindowsProgramming::DRIVE_REMOTE;

    // NUL 分隔的盘符根路径列表："C:\\\0D:\\\0…\0\0"
    let buf = unsafe {
        let len = GetLogicalDriveStringsW(0, std::ptr::null_mut());
        if len == 0 {
            return vec![];
        }
        let mut buf = vec![0u16; len as usize];
        if GetLogicalDriveStringsW(len, buf.as_mut_ptr()) == 0 {
            return vec![];
        }
        buf
    };

    let mut out = Vec::new();
    for root in buf.split(|&c| c == 0) {
        if root.is_empty() {
            continue;
        }
        let root_ptr = root.as_ptr();
        unsafe {
            if GetDriveTypeW(root_ptr) != DRIVE_REMOTE {
                continue;
            }
            // 断开的映射盘查不到容量，列出来没有意义，跳过
            let mut total = 0u64;
            let mut avail = 0u64;
            let ok = GetDiskFreeSpaceExW(
                root_ptr,
                std::ptr::null_mut(),
                &mut total,
                &mut avail,
            );
            if ok == 0 || total == 0 {
                continue;
            }

            let mount_point = String::from_utf16_lossy(root);
            let drive = mount_point
                .chars()
                .find(|c| c.is_ascii_alphabetic())
                .map(|c| format!("{}:", c.to_ascii_uppercase()))
                .unwrap_or_else(|| mount_point.trim_end_matches('\\').to_string());

            // 卷标：SMB 映射盘的卷标就是共享名（映射 \\NAS\Media 时 Explorer 也显示 Media），
            // 直接当展示名；个别共享不上报卷标时才退回 UNC 路径，保证至少有个可辨识的名字
            let mut label_buf = [0u16; 256];
            let mut fs_buf = [0u16; 32];
            let _ = GetVolumeInformationW(
                root_ptr,
                label_buf.as_mut_ptr(),
                label_buf.len() as u32,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                fs_buf.as_mut_ptr(),
                fs_buf.len() as u32,
            );
            let vol_label = wide_to_string(&label_buf);
            let file_system = wide_to_string(&fs_buf);

            let unc = {
                let drive_wide: Vec<u16> = drive.encode_utf16().chain(std::iter::once(0)).collect();
                let mut unc_buf = vec![0u16; 1024];
                let mut unc_len = unc_buf.len() as u32;
                let rc: WIN32_ERROR = WNetGetConnectionW(drive_wide.as_ptr(), unc_buf.as_mut_ptr(), &mut unc_len);
                // 成功时 WNetGetConnectionW 不回写长度，缓冲区尾部仍是 NUL，按首个 NUL 截断。
                if rc == 0 { wide_to_string(&unc_buf) } else { String::new() }
            };

            out.push(DiskVolume {
                drive,
                mount_point,
                file_system,
                label: if vol_label.is_empty() { unc.clone() } else { vol_label },
                total,
                used: total.saturating_sub(avail),
                available: avail,
                removable: false,
                remote: true,
                unc,
            });
        }
    }
    out
}

// UTF-16 缓冲区 → 截到首个 NUL 的 String
fn wide_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

// 列出所有本地磁盘卷：容量 / 已用 / 可用 / 文件系统 / 是否可移动。
// 用于磁盘管理弹窗的卷卡片（容量条 + 游戏归属）。
// 注意：sysinfo 在 Windows 上 name() 返回的是卷标（GetVolumeInformationW 的 lpVolumeNameBuffer），
// 盘符在 mount_point() 里（"D:\"）——盘符必须从挂载点提取，不能拿 name() 当盘符
#[tauri::command(async)]
pub fn get_disk_volumes() -> AppResult<Vec<DiskVolume>> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let mut out: Vec<DiskVolume> = disks
        .iter()
        // 跳过总容量为 0 的卷（光驱无盘等没有意义的挂载点）
        .filter(|d| d.total_space() > 0)
        .map(|d| {
            let mount_point = d.mount_point().to_string_lossy().to_string();
            // 盘符：挂载点 "D:\" → "D:"；挂载到文件夹的卷用完整路径标识（不带尾斜杠）
            let drive = mount_point
                .chars()
                .find(|c| c.is_ascii_alphabetic())
                .map(|c| format!("{}:", c.to_ascii_uppercase()))
                .unwrap_or_else(|| mount_point.trim_end_matches('\\').to_string());
            // 卷标：sysinfo 的 name()；与盘符一致（个别情况）或为空 → 当作无卷标
            let raw_label = d.name().to_string_lossy().to_string();
            let label = if raw_label.is_empty() || raw_label.eq_ignore_ascii_case(&drive) {
                String::new()
            } else {
                raw_label
            };
            DiskVolume {
                drive,
                mount_point,
                file_system: d.file_system().to_string_lossy().to_string(),
                label,
                total: d.total_space(),
                used: d.total_space().saturating_sub(d.available_space()),
                available: d.available_space(),
                removable: d.is_removable(),
                remote: false,
                unc: String::new(),
            }
        })
        .collect();
    // SMB 等网络映射盘 sysinfo 不收，单独枚举补进来（盘符与本地盘无重叠，随大流排序/去重）
    out.extend(network_volumes());
    out.sort_by_key(|v| v.drive.clone());
    // 同一物理卷挂到多个路径会重复列出，按盘符去重（保留第一个）
    out.dedup_by(|a, b| a.drive == b.drive);
    Ok(out)
}

// 递归计算目录占用字节数（跳过无法读取的项）；文件直接返回自身大小。
// spawn_blocking 后台执行，避免大目录递归阻塞其他命令
/// 统计目录大小（跳过符号链接，与复制范围一致），返回 (总字节, 符号链接数)。
/// symlink_count 供移动前检测：源目录含 junction/软链时拒绝移动（复制会跳过它们，
/// 但校验不计数 → 校验"通过" → 删源 → 链接指向的数据永久丢失）
fn compute_folder_size(path: PathBuf) -> (u64, usize) {
    if !path.exists() {
        return (0, 0);
    }
    if path.is_file() {
        return (path.metadata().map(|m| m.len()).unwrap_or(0), 0);
    }
    let mut total = 0u64;
    let mut symlinks = 0usize;
    let mut stack = vec![path];
    let mut visited = std::collections::HashSet::new();
    while let Some(dir) = stack.pop() {
        if !visited.insert(dir.clone()) {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            // symlink_metadata + 跳过符号链接：与 copy_dir_with_progress 的复制范围一致。
            // 旧版用 entry.metadata()（跟随 junction），会把链接指向的外部目录计入大小，
            // 空间校验分母虚增（可能误报空间不足）
            let Ok(meta) = fs::symlink_metadata(&entry.path()) else { continue };
            if meta.file_type().is_symlink() {
                symlinks += 1;
                continue;
            }
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total = total.saturating_add(meta.len());
            }
        }
    }
    (total, symlinks)
}

#[tauri::command]
pub async fn get_folder_size(path: String) -> AppResult<u64> {
    tauri::async_runtime::spawn_blocking(move || compute_folder_size(PathBuf::from(&path)).0)
        .await
        .map_err(|e| AppError::Custom(format!("计算目录大小失败: {}", e)))
}

// ─────────────────────────────────────────────
// Tauri Commands - Apply Disk Moves
// ─────────────────────────────────────────────

// 单个游戏的迁移方案（前端按 Steam / 普通游戏规则算好目标完整路径）。
// camelCase：Tauri 顶层参数名自动转，但嵌套结构体需显式声明才能接受 gameId/targetPath
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameMovePlan {
    pub game_id: String,
    pub target_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameMoveResult {
    pub game_id: String,
    pub name: String,
    pub ok: bool,
    pub error: Option<String>,
    // Steam 游戏清单 appmanifest_*.acf 已随文件夹搬到目标库：
    // 前端据此提示「重启 Steam 客户端后即可识别」（Steam 运行时不会实时扫描库）
    pub steam_manifest_moved: bool,
    // 移动已成功（数据完整落在目标）但有需注意的事项：源目录被占用未能删除，残留需手动清理。
    // 有值时前端以警告色展示，区别于纯成功；ok 仍为 true（数据没丢，只是源没删干净）。
    pub warning: Option<String>,
}

// 复制进度事件载荷（每复制完一个文件 emit 一次）
#[derive(Clone, Serialize)]
struct DiskMoveProgress {
    game_id: String,
    name: String,
    done: u64,
    total: u64,
}

// 取消磁盘移动：置位 move_cancel，复制循环在下一个文件检查点中止并走失败清理
//（删除目标残留副本，源目录/文件原样保留）。前端「取消移动」按钮调用；
// apply_game_moves / apply_series_moves 开始时自动复位
#[tauri::command]
pub fn cancel_disk_move(state: State<'_, AppState>) {
    state.move_cancel.store(true, Ordering::Relaxed);
}

/// Steam 库所在盘符（steam 根 + libraryfolders.vdf 注册的库路径的盘符）：
/// 磁盘管理移动 Steam 游戏前，前端用它判断目标盘是否在 Steam 库中 ——
/// 不在则移动后 Steam 客户端不识别该游戏，提前警告用户（M7）
#[tauri::command]
pub fn steam_library_drives() -> Vec<String> {
    let Ok(steam_root) = steam::detect_steam_path() else { return Vec::new() };
    let root_path = PathBuf::from(steam_root);
    let mut drives = std::collections::BTreeSet::new();
    if let Some(d) = drive_of_path_str(&root_path.to_string_lossy()) {
        drives.insert(d);
    }
    for lib in steam::steam_library_dirs(&root_path) {
        if let Some(d) = drive_of_path_str(&lib.to_string_lossy()) {
            drives.insert(d);
        }
    }
    drives.into_iter().collect()
}

/// Steam 库根路径列表（steam 根 + libraryfolders.vdf 注册的库，仅保留仍存在的目录）：
/// 磁盘管理移动 Steam 游戏时，目标盘已有 Steam 库则优先移动到其 steamapps\common 下
///（而不是新建一个 SteamLibrary 目录 —— 后者 Steam 客户端不识别）
#[tauri::command]
pub fn steam_library_paths() -> Vec<String> {
    let Ok(steam_root) = steam::detect_steam_path() else { return Vec::new() };
    let root_path = PathBuf::from(steam_root);
    let mut paths = Vec::new();
    if root_path.is_dir() {
        paths.push(root_path.to_string_lossy().to_string());
    }
    for lib in steam::steam_library_dirs(&root_path) {
        if lib.is_dir() {
            paths.push(lib.to_string_lossy().to_string());
        }
    }
    paths
}

// ─────────────────────────────────────────────
// 重启 Steam 使移动生效（静默 + 影响最小化）
// ─────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartSteamResult {
    pub ok: bool,
    pub error: Option<String>,
}

/// 移动 Steam 游戏后强制重启 Steam 客户端，让新位置被识别。
/// 流程：官方 -shutdown 优雅退出（给 5s）→ 未退出则强杀 steam.exe + steamwebhelper.exe
/// （游戏/下载状态不拦，用户主动要求强制）→ -silent 托盘启动，不弹主窗口。
/// 参数失效兜底：流程每步都以客观事实（进程是否存在）判定，-shutdown 无效时进程不退 → 强杀兜底
#[tauri::command]
pub fn restart_steam_for_recognition() -> AppResult<RestartSteamResult> {
    // 1. 定位 steam.exe（注册表 SteamPath 优先，Program Files 兜底）
    let steam_root = match steam::detect_steam_path() {
        Ok(p) => PathBuf::from(p),
        Err(e) => return Ok(RestartSteamResult { ok: false, error: Some(format!("找不到 Steam 客户端：{}", e)) }),
    };
    let steam_exe = steam_root.join("steam.exe");

    // 2. 优雅退出：-shutdown（官方参数：Steam 保存状态后自退；已在运行的实例接收参数并退出）。
    //    给 5s —— 正常退出 1-2s 内完成；正在下载/云同步/有游戏在跑时 Steam 可能弹确认框或拒绝，
    //    超时即强制终止（见 3），不让流程卡住
    if std::process::Command::new(&steam_exe).arg("-shutdown").spawn().is_err() {
        return Ok(RestartSteamResult { ok: false, error: Some("无法启动 steam.exe，请手动重启 Steam".into()) });
    }
    if !wait_steam_exit(std::time::Duration::from_secs(5)) {
        // 3. 强制终止：主进程 + UI 渲染进程一起清（webhelper 残留会占端口干扰重启后的实例）。
        //    游戏进程是独立进程不受影响；Steam 断开后反作弊类游戏可能自行退出，属预期
        log::warn!("Steam 未在限时内退出，强制终止");
        let _ = std::process::Command::new("taskkill").args(["/IM", "steam.exe", "/F"]).status();
        let _ = std::process::Command::new("taskkill").args(["/IM", "steamwebhelper.exe", "/F"]).status();
        if !wait_steam_exit(std::time::Duration::from_secs(3)) {
            return Ok(RestartSteamResult {
                ok: false,
                error: Some("Steam 强制退出失败，请手动关闭 Steam 后重试".into()),
            });
        }
    }

    // 4. 静默启动：-silent（Steam 启动到系统托盘，不弹主窗口）
    if std::process::Command::new(&steam_exe).arg("-silent").spawn().is_err() {
        return Ok(RestartSteamResult { ok: false, error: Some("Steam 启动失败，请手动打开 Steam".into()) });
    }
    log::info!("Steam 已重启（使移动生效）");

    Ok(RestartSteamResult { ok: true, error: None })
}

// 等 steam.exe 进程消失：先给 -shutdown 一点反应时间（参数转发/保存状态），
// 超过 timeout 仍未退出返回 false（调用方决定是否强杀）。
// Steam 未运行时 -shutdown 会短暂拉起一个 steam.exe 处理参数后退出，同样等待即可
fn wait_steam_exit(timeout: std::time::Duration) -> bool {
    let mut sys = System::new();
    let start = std::time::Instant::now();
    std::thread::sleep(std::time::Duration::from_millis(800));
    loop {
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let alive = sys.processes().values().any(|p| {
            p.exe()
                .and_then(|e| e.file_name())
                .map(|f| f.eq_ignore_ascii_case("steam.exe"))
                .unwrap_or(false)
        });
        if !alive {
            return true;
        }
        if start.elapsed() > timeout {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

// ─────────────────────────────────────────────
// 路径词法清理（盘符 / UNC / verbatim）
// ─────────────────────────────────────────────

/// 去掉 Windows verbatim 前缀（canonicalize 的产物）：
/// `\\?\UNC\NAS\share\x` → `\\NAS\share\x`，`\\?\Y:\x` → `Y:\x`。
/// 只剥 `\\?\` 而不认 `UNC\`，网络路径就会剩成 "UNC\NAS\share\x" —— 既不是盘符也不是
/// UNC 的相对路径，落库后启动/移动/归档全部失效（SMB 映射盘添加游戏写坏 install_dir 的根因）
fn unverbatim(raw: &str) -> String {
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        raw.to_owned()
    }
}

/// 拆出路径的「根」：盘符盘 `Y:` 或 UNC 根 `\\server\share`，返回 (根, 其余部分)。
/// 相对路径 / 残缺 UNC 返回 None
fn split_root(text: &str) -> Option<(String, &str)> {
    if let Some(body) = text.strip_prefix(r"\\") {
        let mut it = body.splitn(3, '\\');
        let server = it.next().unwrap_or("");
        let share = it.next().unwrap_or("");
        if server.is_empty() || share.is_empty() {
            return None;
        }
        return Some((format!(r"\\{server}\{share}"), it.next().unwrap_or("")));
    }
    let bytes = text.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return Some((text[..2].to_ascii_uppercase(), text[2..].trim_start_matches('\\')));
    }
    None
}

/// 词法规范化一条**绝对**路径：剥 verbatim 前缀、统一分隔符、折叠 `.` / `..`。
/// 刻意不用 fs::canonicalize —— Windows 上它会把映射盘（SMB 挂载的 Y:\…）解析成
/// \\?\UNC\server\share\…：用户明明选的是盘符，落库却成了 UNC；再叠加上面只剥 \\?\
/// 的老逻辑，就剩下 "UNC\192.168.5.151…" 这种谁也认不出的坏路径。
/// 词法清理不改变用户选择的路径形式（盘符还是盘符、UNC 还是 UNC），且不触网、不跟符号链接。
fn tidy_path(raw: &str) -> Option<PathBuf> {
    let text = unverbatim(raw.trim()).replace('/', r"\");
    let (root, rest) = split_root(&text)?;
    let mut segs: Vec<&str> = Vec::new();
    for seg in rest.split('\\') {
        match seg {
            "" | "." => {}
            ".." => {
                segs.pop();
            }
            _ => segs.push(seg),
        }
    }
    let mut out = root;
    let mut depth = 0usize;
    for seg in segs {
        out.push('\\');
        out.push_str(seg);
        depth += 1;
    }
    // 只有根本身（如 exe 直接选在盘根）：补尾部分隔符，避免 "Y:" 这种盘符相对路径
    if depth == 0 {
        out.push('\\');
    }
    Some(PathBuf::from(out))
}

/// 反查映射盘：UNC 根（`\\server\share`）→ 盘符（`Y:`）。未映射返回 None。
/// 用来把历史遗留 / 归档恢复出来的 UNC 路径改回用户熟悉的盘符形式
pub fn mapped_drive_for_unc(unc_root: &str) -> Option<String> {
    use windows_sys::Win32::NetworkManagement::WNet::WNetGetConnectionW;
    let want = unc_root.trim_end_matches('\\').to_lowercase();
    if want.is_empty() {
        return None;
    }
    for letter in b'A'..=b'Z' {
        let drive = format!("{}:", letter as char);
        let wide: Vec<u16> = drive.encode_utf16().chain(std::iter::once(0)).collect();
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        // 未映射的盘符返回 ERROR_NOT_CONNECTED，正好用来筛出仍在的 SMB 映射
        if unsafe { WNetGetConnectionW(wide.as_ptr(), buf.as_mut_ptr(), &mut len) } != 0 {
            continue;
        }
        if wide_to_string(&buf).trim_end_matches('\\').eq_ignore_ascii_case(&want) {
            return Some(drive);
        }
    }
    None
}

/// 修复被 canonicalize 写坏的路径：`UNC\192.168.5.151\share\Game`（剥掉 \\?\ 的残骸）
/// → `\\192.168.5.151\share\Game`，该共享当前有映射盘时进一步还原成 `Y:\Game`。
/// 无需修复（不是这种形态）或无法识别时返回 None
pub fn repair_unc_path(raw: &str) -> Option<String> {
    let text = raw.trim();
    if !text.get(..4)?.eq_ignore_ascii_case(r"UNC\") {
        return None;
    }
    let repaired = format!(r"\\{}", &text[4..]);
    let (root, rest) = split_root(&repaired)?;
    let rest = rest.trim_start_matches('\\');
    Some(match mapped_drive_for_unc(&root) {
        Some(drive) if rest.is_empty() => format!("{drive}\\"),
        Some(drive) => format!("{drive}\\{rest}"),
        None if rest.is_empty() => format!("{root}\\"),
        None => format!("{root}\\{rest}"),
    })
}

// 是否是 canonicalize 留下的 "UNC\…" 残骸
fn is_broken_path(p: &str) -> bool {
    p.trim().get(..4).map(|h| h.eq_ignore_ascii_case(r"UNC\")).unwrap_or(false)
}

/// 存量路径修复（幂等，启动时体检一遍）：把 "UNC\…" 残骸还原成可用路径，返回修复条数。
/// install_dir 的残骸常常连共享名都丢了（只剩 "UNC\192.168.5.151"，向上探测时逐层截断），
/// 字符串层面无从还原；但 exe_path 是文件对话框原样给的、没经过 canonicalize —— 直接拿它
/// 重推一次游戏根即可（与添加游戏时同一套启发式），得到的就是用户当初想要的 Y:\游戏目录
pub fn repair_broken_paths(conn: &rusqlite::Connection) -> usize {
    let rows: Vec<(String, String, String, String)> = {
        let Ok(mut stmt) = conn.prepare(
            "SELECT id, install_dir, exe_path, work_dir FROM games
             WHERE upper(substr(install_dir, 1, 4)) = 'UNC\\'
                OR upper(substr(exe_path, 1, 4)) = 'UNC\\'
                OR upper(substr(work_dir, 1, 4)) = 'UNC\\'",
        ) else {
            return 0;
        };
        let Ok(it) = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))
        }) else {
            return 0;
        };
        it.filter_map(Result::ok).collect()
    };
    let mut fixed = 0usize;
    for (id, install_dir, exe_path, work_dir) in rows {
        // exe_path 一般没坏；真坏了先按字符串修（有共享名就能修回来）
        let exe = if is_broken_path(&exe_path) {
            repair_unc_path(&exe_path).unwrap_or_else(|| exe_path.clone())
        } else {
            exe_path.clone()
        };
        let new_install = if is_broken_path(&install_dir) {
            if tidy_path(&exe).is_some() {
                Some(find_game_root(exe.clone()))
            } else {
                Some(repair_unc_path(&install_dir).unwrap_or_default())
            }
        } else {
            None
        };
        let new_work = if is_broken_path(&work_dir) {
            // 工作目录还原不了就清空（空 = 跟随安装目录），留着坏值只会让启动失败
            Some(repair_unc_path(&work_dir).unwrap_or_default())
        } else {
            None
        };
        if new_install.is_none() && new_work.is_none() && exe == exe_path {
            continue;
        }
        let ok = conn.execute(
            "UPDATE games SET install_dir = ?1, exe_path = ?2, work_dir = ?3,
             updated_at = datetime('now') WHERE id = ?4",
            params![
                new_install.as_deref().unwrap_or(&install_dir),
                exe,
                new_work.as_deref().unwrap_or(&work_dir),
                id
            ],
        );
        if ok.is_ok() {
            fixed += 1;
        }
    }
    fixed
}

/// 从 exe 路径向上探测「游戏安装根目录」（手动添加游戏时自动填 install_dir）。
/// 商业游戏 exe 常在 bin\x64、win64、boot 等子目录，exe 的直接父目录不是游戏根；
/// install_dir 若只到子目录，磁盘管理移动会漏掉上级数据文件（校验"通过"后删源即损坏）。
/// 启发式：从 exe 父目录向上逐层检查（最多 4 层），某层满足「游戏根特征」即停：
/// - 该层直接子目录中「特征目录」（data/assets/content/bin/engine/r6 等）≥ 2 个
/// - 该层含 ≥2 个 exe（多启动器/主程序+子进程，大概率是根）
/// 到盘根仍未命中则返回 exe 的直接父目录（兜底，用户可在弹窗里手动改）
#[tauri::command]
pub fn find_game_root(exe_path: String) -> String {
    const FEATURE_DIRS: [&str; 14] = [
        "data", "assets", "content", "bin", "engine", "r6", "redist",
        "sound", "music", "common", "game", "levels", "config", "saves",
    ];
    // 词法清理而不是 canonicalize：映射盘必须原样留成 Y:\…，
    // 一旦被解析成 \\?\UNC\… 再剥前缀，install_dir 就落成 "UNC\192.168.5.151…" 的坏路径
    let mut dir = match tidy_path(&exe_path) {
        Some(d) => match d.parent() {
            Some(p) => p.to_path_buf(),
            None => return exe_path, // 盘根无父目录，原样返回
        },
        None => return exe_path, // 路径无效，原样返回（前端填 exe 父目录兜底）
    };
    let mut best = dir.clone();
    // 最多向上 3 层（bin\x64 → bin → 游戏根的典型结构）。
    // 盘根绝不检查也绝不返回：盘根下的特征目录名一抓一大把（data/bin/assets…），
    // 命中就会把整个盘当"游戏根"赋给游戏
    for _ in 0..3 {
        match dir.parent() {
            Some(p) if p != dir => {} // 正常层
            _ => break,               // 已到盘根：不检查不更新，返回 best
        }
        let mut features = 0usize;
        let mut exe_count = 0usize;
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    let name = p
                        .file_name()
                        .map(|n| n.to_string_lossy().to_lowercase())
                        .unwrap_or_default();
                    if FEATURE_DIRS.contains(&name.as_str()) {
                        features += 1;
                    }
                } else if p
                    .extension()
                    .map(|e| e.eq_ignore_ascii_case("exe"))
                    .unwrap_or(false)
                {
                    exe_count += 1;
                }
            }
        }
        if features >= 2 || exe_count >= 2 {
            return dir.to_string_lossy().to_string();
        }
        best = dir.clone();
        dir = dir.parent().unwrap().to_path_buf();
    }
    best.to_string_lossy().to_string()
}

/// 在文件夹内递归查找主可执行文件（复用 Steam 导入的打分启发式，限深 5 层）：
/// 手动添加游戏时选「安装目录」后自动定位启动程序
#[tauri::command]
pub fn find_main_exe(dir: String, game_name: String) -> String {
    steam::find_steam_exe(&PathBuf::from(&dir), &game_name)
}

// 应用磁盘移动：把一批游戏目录搬到目标路径（前端算好目标路径），逐个执行。
// 同盘 rename（瞬时）；跨盘复制整个目录 + 进度 + 删源。
// 单游戏失败只记入结果，不影响其它游戏
#[tauri::command]
pub async fn apply_game_moves(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    moves: Vec<GameMovePlan>,
) -> AppResult<Vec<GameMoveResult>> {
    let _operation = archive::OperationGuard::acquire(&state.archive_gate)?;
    // 新一轮移动开始：复位取消标志（上次取消/完成后的残留状态）
    state.move_cancel.store(false, Ordering::Relaxed);
    let mut results = Vec::with_capacity(moves.len());
    let mut cancelled = false;
    for plan in moves {
        // 逐游戏之间也检查取消：已置位则不再启动后续游戏，
        // 剩余游戏以「已取消，未移动」结果返回 —— 用户能看到哪些没动，不会静默消失
        if state.move_cancel.load(Ordering::Relaxed) {
            cancelled = true;
        }
        if cancelled {
            let name: String = state
                .db
                .lock()
                .query_row(
                    "SELECT name FROM games WHERE id = ?1",
                    params![plan.game_id],
                    |r| r.get(0),
                )
                .unwrap_or_default();
            results.push(GameMoveResult {
                game_id: plan.game_id.clone(),
                name,
                ok: false,
                error: Some("已取消，未移动".to_string()),
                steam_manifest_moved: false,
                warning: None,
            });
            continue;
        }
        let game_id = plan.game_id.clone();
        // 游戏名（成功/失败都要展示给前端）
        let name: String = state
            .db
            .lock()
            .query_row(
                "SELECT name FROM games WHERE id = ?1",
                params![game_id],
                |r| r.get(0),
            )
            .unwrap_or_default();
        // 已归档的游戏按「整个压缩包」移动，未归档的按安装目录移动。
        let archived = state
            .db
            .lock()
            .query_row(
                "SELECT archive_status FROM games WHERE id = ?1",
                params![game_id],
                |r| r.get::<_, String>(0),
            )
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        let moved = if archived {
            move_one_archive(&app, &state, &plan).await
        } else {
            move_one_game(&app, &state, &plan).await
        };
        let result = match moved {
            Ok((manifest_moved, warning)) => GameMoveResult {
                game_id,
                name,
                ok: true,
                error: None,
                steam_manifest_moved: manifest_moved,
                warning,
            },
            Err(e) => GameMoveResult {
                game_id,
                name,
                ok: false,
                error: Some(e.to_string()),
                steam_manifest_moved: false,
                warning: None,
            },
        };
        results.push(result);
    }
    Ok(results)
}

// 单个游戏移动。失败返回 Err（原因展示给用户，不影响其它游戏）。
// 成功返回 true = Steam 清单已随文件夹搬到目标库（前端提示重启 Steam 识别）
// 返回 (Steam 清单是否已随文件夹搬迁, 源残留警告)。源残留 = 数据已完整移动到目标，
// 但源目录/文件被占用未能删除，需用户手动清理（移动本身仍算成功）。
async fn move_one_game(
    app: &tauri::AppHandle,
    state: &AppState,
    plan: &GameMovePlan,
) -> AppResult<(bool, Option<String>)> {
    archive::require_unarchived(state, &plan.game_id)?;
    let (name, install_dir, exe_path, work_dir, steam_appid): (String, String, String, String, u64) = {
        let conn = state.db.lock();
        conn.query_row(
            "SELECT name, install_dir, exe_path, work_dir, steam_appid FROM games WHERE id = ?1",
            params![plan.game_id],
            |r| Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, u64>(4)?,
            )),
        )?
    };

    // ── 数据安全防线一：install_dir 为空的手动添加游戏拒绝移动 ──
    // 源只能取到 exe 的父目录（商业游戏常是 bin\x64 等子目录），游戏主体（上级数据文件）
    // 不在复制范围；复制+校验对"复制范围内"两边一致 → 校验"通过" → 删源 → 游戏彻底损坏
    if install_dir.is_empty() {
        return Err(AppError::Custom(
            "该游戏未设置安装目录（手动添加的游戏只记录了启动路径），无法安全移动。请先在详情中设置「安装目录」为游戏整个文件夹，再重试移动".to_string(),
        ));
    }

    // 源目录：优先 install_dir（Steam 游戏带完整目录），否则 exe_path 所在目录
    let src = if !install_dir.is_empty() && Path::new(&install_dir).is_dir() {
        PathBuf::from(&install_dir)
    } else if !exe_path.is_empty() {
        Path::new(&exe_path)
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| AppError::Custom("无法确定游戏源目录".to_string()))?
    } else {
        return Err(AppError::Custom("游戏没有安装目录或启动路径，无法移动".to_string()));
    };

    // ── 数据安全防线二：游戏正在运行则拒绝移动 ──
    // 运行中跨盘复制会因文件锁报错、同盘 rename 失败；主动拦截比事后报错体验更好
    //（running_games 是 parking_lot 锁，read() 直接返回 guard）
    if state.running_games.read().contains_key(&plan.game_id) {
        return Err(AppError::Custom(
            "该游戏正在运行，请先退出游戏再移动（移动需要复制/重命名整个目录）".to_string(),
        ));
    }

    // ── 数据安全防线三：源目录合法性 ──
    // 移动 = 复制整个源目录 + 删源。若源是盘根（"D:\"）会把整个盘复制过去再删掉，
    // 灾难级误删 —— 只允许有明确目录名的源
    if src.components().count() <= 2 {
        return Err(AppError::Custom(format!(
            "源目录 {} 是盘根目录，拒绝移动（防止误删整个磁盘）",
            src.display()
        )));
    }
    // 系统关键目录：精确拒绝目录本身 + 前缀拒绝 windows/users 子树（System32、用户配置等
    // 都在其下）。Program Files 不前缀拒绝 —— 合法游戏也装那里，只挡目录本身
    let src_norm = norm_path(&src);
    let sys_exact = ["c:/windows", "c:/windows.old", "c:/program files", "c:/program files (x86)", "c:/users", "c:/programdata"];
    let sys_prefix = ["c:/windows/", "c:/users/"];
    if sys_exact.contains(&src_norm.as_str())
        || sys_prefix.iter().any(|p| src_norm.starts_with(p))
    {
        return Err(AppError::Custom(format!(
            "源目录 {} 是系统关键目录，拒绝移动",
            src.display()
        )));
    }

    // ── 数据安全防线四：启动程序必须在安装目录内 ──
    // 安装目录被填成别的游戏的目录时，移动会把无关目录复制+删除（如把 D:\Epic 赋给 DSX
    // 会搬走 Epic 的整个目录）。exe 不在 src 内 = 安装目录与启动程序无关 → 拒绝。
    // （极少数"独立启动器"场景可先在详情里把安装目录修正为包含 exe 的目录）
    if !exe_path.is_empty() {
        let exe_norm = norm_path(Path::new(&exe_path));
        let exe_inside = exe_norm.len() > src_norm.len()
            && exe_norm.starts_with(&src_norm)
            && exe_norm.as_bytes()[src_norm.len()] == b'/';
        if !exe_inside {
            return Err(AppError::Custom(format!(
                "启动程序 {} 不在安装目录 {} 内，拒绝移动（安装目录可能是别的游戏的目录）。请先在详情中修正「安装目录」为包含该启动程序的整个游戏文件夹",
                exe_path,
                src.display()
            )));
        }
    }

    let target = PathBuf::from(&plan.target_path);
    let tgt_norm = norm_path(&target);
    if tgt_norm == src_norm {
        return Ok((false, None)); // 目标即当前目录，无需移动
    }
    // 目标与源互相包含（同盘极端情况）：目标在源内部会复制到自己里面、源在目标内部
    // 会随复制被一起删掉 —— 规范化后判重叠（带目录边界）
    if norm_paths_overlap(&tgt_norm, &src_norm) {
        return Err(AppError::Custom(format!(
            "目标路径 {} 与源目录 {} 重叠，拒绝移动",
            plan.target_path,
            src.display()
        )));
    }
    if target.exists() {
        return Err(AppError::Custom(format!(
            "目标目录已存在：{}",
            plan.target_path
        )));
    }

    // 先算源目录总大小（blocking 后台），用于空间校验 + 复制进度分母；
    // 顺带统计符号链接数（S3 防线）
    let (total_size, symlink_count) = {
        let src2 = src.clone();
        tauri::async_runtime::spawn_blocking(move || compute_folder_size(src2))
            .await
            .map_err(|e| AppError::Custom(format!("计算目录大小失败: {}", e)))?
    };
    if symlink_count > 0 {
        return Err(AppError::Custom(format!(
            "源目录包含 {} 个符号链接/junction（如 DLC 或数据目录的链接）。移动不会复制链接指向的内容，\
             删源后这些数据会丢失，已拒绝移动。请先移除源目录中的符号链接，或手动复制这些内容后再移动",
            symlink_count
        )));
    }

    // 创建目标父目录（SteamLibrary\steamapps\common 等）
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }

    let same_drive = src
        .to_string_lossy()
        .chars()
        .next()
        .map(|c| {
            target
                .to_string_lossy()
                .chars()
                .next()
                .map(|t| c.eq_ignore_ascii_case(&t))
                .unwrap_or(false)
        })
        .unwrap_or(false);

    // 源残留警告：跨盘删源被占用时，数据已完整落在目标，但源目录没删干净，需用户手动清理。
    let mut src_leftover: Option<String> = None;
    if same_drive {
        // 同盘：rename 瞬时完成（同一文件系统内是改目录项，不拷贝数据）
        fs::rename(&src, &target)?;
    } else {
        // 跨盘：后台复制整目录（逐文件 emit 进度）。
        // 安全原则：只有「复制完整校验通过」后才允许删源；任何失败路径都保证源目录原样保留
        // 空间校验只在跨盘分支做：同盘 rename 不消耗空间，查空间会误拒
        if let Some(free) = drive_free_space(&target) {
            if total_size > free {
                return Err(AppError::Custom(format!(
                    "目标盘可用空间不足（需要 {}，可用 {}）",
                    fmt_size(total_size),
                    fmt_size(free)
                )));
            }
        }
        let app2 = app.clone();
        let game_id = plan.game_id.clone();
        let name2 = name.clone();
        let src2 = src.clone();
        let target2 = target.clone();
        let cancel = state.move_cancel.clone();
        let copy_result: Result<(), String> = tauri::async_runtime::spawn_blocking(move || {
            copy_dir_with_progress(&src2, &target2, &app2, &game_id, &name2, total_size, &cancel)
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| AppError::Custom(format!("复制任务失败: {}", e)))?;
        if let Err(e) = copy_result {
            // 复制中途失败/取消：清理目标残留副本，源目录未动，可重试。
            // 取消是用户主动中止，文案与真实失败区分开
            let _ = fs::remove_dir_all(&target);
            if e.contains("移动已取消") {
                return Err(AppError::Custom(
                    "移动已取消，已清理目标残留副本，游戏留在原目录".to_string(),
                ));
            }
            return Err(AppError::Custom(format!(
                "复制失败，已清理目标残留副本（源目录未动，可重试）：{}",
                e
            )));
        }
        // 完整性校验：文件数 + 总字节一致（跳过符号链接，与复制范围一致）才允许删源
        let (src_files, src_bytes) = count_files(&src);
        let (dst_files, dst_bytes) = count_files(&target);
        if src_files != dst_files || src_bytes != dst_bytes {
            let _ = fs::remove_dir_all(&target);
            return Err(AppError::Custom(format!(
                "复制完整性校验未通过（源 {} 个文件/{}，目标 {} 个文件/{}），已清理目标副本，源目录未动",
                src_files,
                fmt_size(src_bytes),
                dst_files,
                fmt_size(dst_bytes)
            )));
        }
        // 校验通过，此时才删源。删源前最后检查一次取消：
        // 用户取消 = 清理目标残留、源原样保留，移动视为未发生（不允许"复制完了但被取消"走删源）
        if state.move_cancel.load(Ordering::Relaxed) {
            let _ = fs::remove_dir_all(&target);
            return Err(AppError::Custom(
                "移动已取消，已清理目标残留副本，游戏留在原目录".to_string(),
            ));
        }
        // 删源失败（文件被占用）：此时目标是「已通过完整性校验」的完整副本 —— 移动其实已成功。
        // 绝不能删目标：remove_dir_all 是逐文件递归删，遇到被占用文件报错时，源往往已被删掉一部分，
        // 若再删目标 = 源残缺 + 目标全无 = 真正的数据丢失（旧代码「回滚删目标」正是这个隐患，
        // 且谎称「源目录未动」）。正确做法：保留完整的目标，把移动视为成功，继续更新数据库指向新位置，
        // 只把源残留记为警告让用户手动清理。
        if let Err(e) = fs::remove_dir_all(&src) {
            src_leftover = Some(format!(
                "文件已完整移动到新位置，但源目录 {} 被占用未能删除（{}）。数据没有丢失，请退出占用该目录内文件的程序后手动删除源目录",
                src.display(),
                e
            ));
        }
    }

    // ── Steam 识别：把 appmanifest 清单一起搬（源库 → 目标库） ──
    // Steam 靠 steamapps\appmanifest_<appid>.acf 识别已安装游戏：清单在源库、文件夹没了 →
    // 源库显示未安装；目标库有文件夹没清单 → Steam 根本不认识（"移动后不识别"的根因）。
    // 文件夹 + 清单一起搬才完整；目标库已有同名清单（重复安装）则覆盖
    let mut manifest_moved = false;
    if let Some(src_root) = steam_library_root_of(&src) {
        if let Some(dst_root) = steam_library_root_of(&target) {
            manifest_moved = relocate_steam_manifest(steam_appid, &src_root, &dst_root);
        }
    }

    // 更新数据库路径（cover/banner/bg 存 data_dir，不动）。
    // rebase 基准用实际移动的 src 而非 install_dir：手动添加的游戏 install_dir 常为空
    //（源取自 exe_path 父目录），用空串作基准会让 rebase 保持旧路径 → 移动后游戏打不开
    let new_install = target.to_string_lossy().to_string();
    let src_str = src.to_string_lossy().to_string();
    let new_exe = rebase_path(&exe_path, &src_str, &new_install);
    let new_work = if work_dir.is_empty() {
        String::new()
    } else {
        rebase_path(&work_dir, &src_str, &new_install)
    };
    {
        let conn = state.db.lock();
        if let Err(e) = conn.execute(
            "UPDATE games SET install_dir = ?1, exe_path = ?2, work_dir = ?3, updated_at = datetime('now') WHERE id = ?4",
            params![new_install, new_exe, new_work, plan.game_id],
        ) {
            // M4 防线：文件已移动、源已删，此时必须明确告诉用户文件在哪里，
            // 不能只报"更新失败"让用户以为移动没发生（重试也无源可移）
            return Err(AppError::Custom(format!(
                "游戏文件已移动到 {}，但数据库更新失败（{}）。游戏文件在新位置完好，请手动编辑该游戏的「安装目录」和「启动路径」指向新位置",
                new_install, e
            )));
        }
    }
    Ok((manifest_moved, src_leftover))
}

// 已归档游戏的移动：把整个压缩包搬到目标盘（单文件 copy + 校验大小 + 删源 + 更新 archive_path）。
// 与 move_one_game 同样的安全原则：跨盘先复制、校验通过才删源；任何失败都保留源压缩包、绝不覆盖目标。
async fn move_one_archive(
    app: &tauri::AppHandle,
    state: &AppState,
    plan: &GameMovePlan,
) -> AppResult<(bool, Option<String>)> {
    let (name, archive_status, archive_path): (String, String, String) = {
        let conn = state.db.lock();
        conn.query_row(
            "SELECT name, archive_status, archive_path FROM games WHERE id = ?1",
            params![plan.game_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?
    };
    if archive_status.is_empty() {
        return Err(AppError::Custom("该游戏未归档，不能按压缩包移动".to_string()));
    }
    if archive_path.trim().is_empty() {
        return Err(AppError::Custom("归档记录缺少压缩包路径，无法移动".to_string()));
    }
    let src = PathBuf::from(&archive_path);
    let meta = fs::symlink_metadata(&src)
        .map_err(|e| AppError::Custom(format!("找不到压缩包 {}（{}）", src.display(), e)))?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(AppError::Custom(format!("压缩包路径不是普通文件：{}", src.display())));
    }
    let total_size = meta.len();
    let target = PathBuf::from(&plan.target_path);
    if !target.is_absolute() {
        return Err(AppError::Custom("目标路径必须是绝对路径".to_string()));
    }
    if norm_path(&target) == norm_path(&src) {
        return Ok((false, None)); // 已在目标位置，无需移动
    }
    if target.exists() {
        return Err(AppError::Custom(format!("目标已存在，拒绝覆盖：{}", target.display())));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let same_drive = src
        .to_string_lossy()
        .chars()
        .next()
        .map(|c| {
            target
                .to_string_lossy()
                .chars()
                .next()
                .map(|t| c.eq_ignore_ascii_case(&t))
                .unwrap_or(false)
        })
        .unwrap_or(false);
    let mut src_leftover: Option<String> = None;
    if same_drive {
        fs::rename(&src, &target)?;
    } else {
        if let Some(free) = drive_free_space(&target) {
            if total_size > free {
                return Err(AppError::Custom(format!(
                    "目标盘可用空间不足（需要 {}，可用 {}）",
                    fmt_size(total_size),
                    fmt_size(free)
                )));
            }
        }
        let app2 = app.clone();
        let game_id = plan.game_id.clone();
        let name2 = name.clone();
        let src2 = src.clone();
        let target2 = target.clone();
        let cancel = state.move_cancel.clone();
        let copied: Result<u64, String> = tauri::async_runtime::spawn_blocking(move || {
            copy_file_with_progress(&src2, &target2, &app2, &game_id, &name2, total_size, &cancel)
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| AppError::Custom(format!("复制任务失败: {}", e)))?;
        let copied = match copied {
            Ok(n) => n,
            Err(e) => {
                let _ = fs::remove_file(&target);
                if e.contains("移动已取消") {
                    return Err(AppError::Custom(
                        "移动已取消，已清理目标残留副本，压缩包留在原位置".to_string(),
                    ));
                }
                return Err(AppError::Custom(format!(
                    "复制失败，已清理目标残留副本（源压缩包未动，可重试）：{}",
                    e
                )));
            }
        };
        let dst_size = fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
        if copied != total_size || dst_size != total_size {
            let _ = fs::remove_file(&target);
            return Err(AppError::Custom(format!(
                "复制完整性校验未通过（源 {}，目标 {}），已清理目标副本，源压缩包未动",
                fmt_size(total_size),
                fmt_size(dst_size)
            )));
        }
        if state.move_cancel.load(Ordering::Relaxed) {
            let _ = fs::remove_file(&target);
            return Err(AppError::Custom(
                "移动已取消，已清理目标残留副本，压缩包留在原位置".to_string(),
            ));
        }
        if let Err(e) = fs::remove_file(&src) {
            src_leftover = Some(format!(
                "压缩包已完整移动到新位置，但源文件 {} 被占用未能删除（{}）。数据没有丢失，请关闭占用它的程序后手动删除",
                src.display(),
                e
            ));
        }
    }
    let new_path = target.to_string_lossy().to_string();
    {
        let conn = state.db.lock();
        if let Err(e) = conn.execute(
            "UPDATE games SET archive_path = ?1, updated_at = datetime('now') WHERE id = ?2",
            params![new_path, plan.game_id],
        ) {
            return Err(AppError::Custom(format!(
                "压缩包已移动到 {}，但数据库更新失败（{}）。文件在新位置完好，请在该游戏详情里手动修正归档路径",
                new_path, e
            )));
        }
    }
    Ok((false, src_leftover))
}

// 单文件分块复制，边复制边 emit 进度（移动大压缩包时进度条可动）。返回已复制字节数。
fn copy_file_with_progress(
    src: &Path,
    dst: &Path,
    app: &tauri::AppHandle,
    game_id: &str,
    name: &str,
    total: u64,
    cancel: &std::sync::atomic::AtomicBool,
) -> AppResult<u64> {
    use std::io::{Read, Write};
    let mut reader = fs::File::open(src)
        .map_err(|e| AppError::Custom(format!("打开源文件失败 {}: {}", src.display(), e)))?;
    let mut writer = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dst)
        .map_err(|e| AppError::Custom(format!("创建目标文件失败 {}: {}", dst.display(), e)))?;
    let mut buf = vec![0u8; 1024 * 1024];
    let mut done = 0u64;
    let mut last_emit = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::Custom("移动已取消".to_string()));
        }
        let n = reader
            .read(&mut buf)
            .map_err(|e| AppError::Custom(format!("读取源文件失败: {}", e)))?;
        if n == 0 {
            break;
        }
        writer
            .write_all(&buf[..n])
            .map_err(|e| AppError::Custom(format!("写入目标文件失败: {}", e)))?;
        done = done.saturating_add(n as u64);
        if done - last_emit >= 8 * 1024 * 1024 || done == total {
            let _ = app.emit(
                "disk-move-progress",
                DiskMoveProgress {
                    game_id: game_id.to_string(),
                    name: name.to_string(),
                    done,
                    total,
                },
            );
            last_emit = done;
        }
    }
    writer
        .sync_all()
        .map_err(|e| AppError::Custom(format!("刷盘失败: {}", e)))?;
    Ok(done)
}

// 从游戏目录向上找名为 steamapps 的父目录 → 其父即 Steam 库根（D:\Steam、D:\SteamLibrary…）
pub(crate) fn steam_library_root_of(dir: &Path) -> Option<PathBuf> {
    let mut cur = dir;
    loop {
        if let Some(name) = cur.file_name() {
            if name.eq_ignore_ascii_case("steamapps") {
                return cur.parent().map(|p| p.to_path_buf());
            }
        }
        cur = cur.parent()?;
    }
}

// 把 Steam 清单 appmanifest_<appid>.acf 从源库搬到目标库（复制+删源）。
// 移动游戏文件夹后清单不搬 Steam 就不识别；目标库已有同名清单则覆盖（Steam 启动时以磁盘现状为准）。
// 失败不阻断移动主流程（游戏文件与数据库已就绪），仅记日志 —— 用户重启 Steam 后可手动补救。
// 返回 true = 清单已搬迁（前端提示「重启 Steam 客户端后即可识别」）
fn relocate_steam_manifest(steam_appid: u64, src_root: &Path, dst_root: &Path) -> bool {
    if steam_appid == 0 {
        return false; // 非 Steam 游戏无需清单
    }
    if norm_path(src_root) == norm_path(dst_root) {
        return false; // 同一库内移动，清单原位不动
    }
    let src_manifest = src_root
        .join("steamapps")
        .join(format!("appmanifest_{}.acf", steam_appid));
    if !src_manifest.exists() {
        return false; // 源库无清单（非常规 Steam 安装），无需处理
    }
    let dst_manifest = dst_root
        .join("steamapps")
        .join(format!("appmanifest_{}.acf", steam_appid));
    if let Some(parent) = dst_manifest.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(e) = fs::copy(&src_manifest, &dst_manifest) {
        eprintln!(
            "[move] 复制 Steam 清单失败 {} → {}: {}",
            src_manifest.display(),
            dst_manifest.display(),
            e
        );
        return false;
    }
    if let Err(e) = fs::remove_file(&src_manifest) {
        eprintln!("[move] 删除源 Steam 清单失败 {}: {}", src_manifest.display(), e);
    }
    true
}

// 目标盘可用空间：找挂载点能匹配目标路径前缀的卷（sysinfo，跨平台）
fn drive_free_space(path: &Path) -> Option<u64> {
    let target = path.to_string_lossy().to_uppercase();
    let disks = sysinfo::Disks::new_with_refreshed_list();
    for d in &disks {
        let mp = d.mount_point().to_string_lossy().to_uppercase();
        if !mp.is_empty() && target.starts_with(&mp) {
            return Some(d.available_space());
        }
    }
    None
}

// 把 old 相对 old_root 的路径拼到 new_root；old 不以 old_root 开头（exe 在独立位置）则保持原值
fn rebase_path(old: &str, old_root: &str, new_root: &str) -> String {
    if old.is_empty() {
        return String::new();
    }
    let root = old_root.trim_end_matches(['\\', '/']);
    if !root.is_empty() && old.to_lowercase().starts_with(&root.to_lowercase()) {
        let rel = old[root.len()..].trim_start_matches(['\\', '/']);
        Path::new(new_root).join(rel).to_string_lossy().to_string()
    } else {
        old.to_string()
    }
}

// 路径规范化：统一反斜杠为斜杠、去尾部斜杠、转小写。
// Windows 路径比较必须用它：裸 == / starts_with 会把 "D:\Game" vs "d:\game"、
// "D:\Game\" vs "D:\Game" 当不同路径（数据安全相关判断一律走这里）
fn norm_path(p: &Path) -> String {
    p.to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

// 两个规范化路径是否「重叠」：相等，或一个是另一个的目录前缀（带边界 ——
// "d:/a" 与 "d:/ab" 不是重叠，"d:/a" 与 "d:/a/b" 才是）
fn norm_paths_overlap(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let is_dir_prefix = |x: &str, y: &str| {
        x.len() > y.len()
            && x.starts_with(y)
            && x.as_bytes()[y.len()] == b'/'
    };
    is_dir_prefix(a, b) || is_dir_prefix(b, a)
}

// 递归复制目录（跳过符号链接，避免 junction 死循环或复制到外部）。每复制一个文件累计已复制字节并 emit 进度。
// 在 spawn_blocking 线程执行；app 为 AppHandle（Send），emit 可跨线程。
// cancel 为取消标志：每复制完一个文件检查，置位即中止（调用方走失败清理，源目录原样保留）
fn copy_dir_with_progress(
    src: &Path,
    dst: &Path,
    app: &tauri::AppHandle,
    game_id: &str,
    name: &str,
    total: u64,
    cancel: &std::sync::atomic::AtomicBool,
) -> AppResult<()> {
    fs::create_dir_all(dst)?;
    let mut done = 0u64;
    let mut stack = vec![(src.to_path_buf(), dst.to_path_buf())];
    let mut visited = std::collections::HashSet::new();
    while let Some((from, to)) = stack.pop() {
        if !visited.insert(from.clone()) {
            continue;
        }
        // symlink_metadata 才能识别符号链接；junction/软链在此应已被移动前检测拦截
        //（见 move_one_game 的 symlink 防线），这里仍防御性跳过
        let meta = fs::symlink_metadata(&from)
            .map_err(|e| AppError::Custom(format!("读取目录信息失败 {}: {}", from.display(), e)))?;
        if meta.file_type().is_symlink() {
            continue;
        }
        // 不可读目录必须报错而非跳过（S2 防线）：静默跳过会让「复制+校验」两边一致
        // → 校验通过 → 删源 → 该子目录数据永久丢失。读失败立即中止，源原样保留
        let entries = fs::read_dir(&from)
            .map_err(|e| AppError::Custom(format!("读取目录失败 {}: {}", from.display(), e)))?;
        for entry in entries.flatten() {
            // 取消检查点：每文件一次（大目录单层几千文件时取消也能快速响应，
            // 不能只在每目录检查——那会让取消等完整个目录的所有文件）
            if cancel.load(Ordering::Relaxed) {
                return Err(AppError::Custom("移动已取消".to_string()));
            }
            let f = entry.path();
            let t = to.join(entry.file_name());
            let m = entry.metadata()
                .map_err(|e| AppError::Custom(format!("读取文件信息失败 {}: {}", f.display(), e)))?;
            if m.is_dir() {
                let _ = fs::create_dir_all(&t);
                stack.push((f, t));
            } else if m.is_file() {
                fs::copy(&f, &t)
                    .map_err(|e| AppError::Custom(format!("复制失败 {}: {}", f.display(), e)))?;
                done = done.saturating_add(m.len());
                let _ = app.emit(
                    "disk-move-progress",
                    DiskMoveProgress {
                        game_id: game_id.to_string(),
                        name: name.to_string(),
                        done,
                        total,
                    },
                );
            }
        }
    }
    Ok(())
}

fn fmt_size(n: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;
    if n >= GB {
        format!("{:.1} GB", n as f64 / GB as f64)
    } else if n >= MB {
        format!("{:.1} MB", n as f64 / MB as f64)
    } else if n >= KB {
        format!("{:.1} KB", n as f64 / KB as f64)
    } else {
        format!("{} B", n)
    }
}

// 统计目录内文件数与总字节（跳过符号链接，与 copy_dir_with_progress 的复制范围一致），
// 用于跨盘复制后的完整性比对：两边文件数、字节数一致才允许删源
fn count_files(path: &Path) -> (u64, u64) {
    let mut files = 0u64;
    let mut bytes = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let p = entry.path();
            let Ok(meta) = fs::symlink_metadata(&p) else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(p);
            } else if meta.is_file() {
                files += 1;
                bytes += meta.len();
            }
        }
    }
    (files, bytes)
}

// ─────────────────────────────────────────────
// Tauri Commands - Series Disk Layout（影视磁盘管理）
// ─────────────────────────────────────────────

// 单个本地视频文件：完整路径 + 相对剧根的路径 + 大小
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesDiskFile {
    pub local_path: String,
    pub rel: String, // 相对剧根目录的路径（移动后保持这个结构）
    pub size: u64,
}

// 一部剧在磁盘上的布局：剧根目录 + 归属盘 + 本地文件列表 + 总大小
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesDiskEntry {
    pub series_id: String,
    pub title: String,
    pub poster_path: String,
    pub media_type: String, // tv / movie
    pub root: String,       // 剧根目录（所有本地文件的公共父目录）；无文件或跨盘 = 空
    pub drive: String,      // 归属盘 "D:"；无法确定 = "未知"
    pub total_size: u64,
    pub files: Vec<SeriesDiskFile>,
}

// 影视磁盘管理数据：一次返回全部有本地文件的剧（含剧根/归属盘/文件列表/大小）。
// 前端按 drive 分组显示，拖拽整部剧跨盘移动
#[tauri::command(async)]
pub fn get_series_disk_layout(state: State<'_, AppState>) -> AppResult<Vec<SeriesDiskEntry>> {
    // 先把库里要的东西一次取完就放锁：下面每个文件都要 metadata() 问一次磁盘，
    // 几百集就是几百次 IO，占着锁做会让同期的播放/扫描全排队
    let rows: Vec<(String, String, String, String, Vec<String>)> = {
        let conn = state.db.lock();
        let mut series_stmt = conn.prepare(
            "SELECT id, title, poster_path, media_type FROM series ORDER BY title",
        )?;
        let series_list: Vec<(String, String, String, String)> = series_stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<Result<_, _>>()?;

        let mut ep_stmt = conn.prepare(
            "SELECT e.local_path FROM episodes e JOIN seasons s ON s.id = e.season_id
             WHERE e.series_id = ?1 AND e.local_path <> ''",
        )?;

        let mut acc = Vec::with_capacity(series_list.len());
        for (sid, title, poster, media_type) in series_list {
            let mut paths: Vec<String> = ep_stmt
                .query_map(params![&sid], |r| r.get::<_, String>(0))?
                .collect::<Result<_, _>>()?;
            // 去重（同一文件可能被多集引用）
            paths.sort();
            paths.dedup();
            if paths.is_empty() {
                continue; // 没有本地文件的剧不参与磁盘管理
            }
            acc.push((sid, title, poster, media_type, paths));
        }
        acc
    };

    let mut out = Vec::with_capacity(rows.len());
    for (sid, title, poster, media_type, paths) in rows {

        // 剧根 = 所有 local_path 的公共父目录（用户添加影视时选的文件夹）
        let root = common_parent_of(&paths);
        let drive = root
            .as_ref()
            .and_then(|r| drive_of_path_str(&r.to_string_lossy()))
            .unwrap_or_else(|| "未知".to_string());

        let mut files = Vec::with_capacity(paths.len());
        let mut total = 0u64;
        for p in &paths {
            let pb = PathBuf::from(p);
            let size = pb.metadata().map(|m| m.len()).unwrap_or(0);
            let rel = root
                .as_ref()
                .and_then(|r| pb.strip_prefix(r).ok())
                .map(|r| r.to_string_lossy().to_string())
                .unwrap_or_else(|| p.clone());
            total = total.saturating_add(size);
            files.push(SeriesDiskFile {
                local_path: p.clone(),
                rel,
                size,
            });
        }

        out.push(SeriesDiskEntry {
            series_id: sid,
            title,
            poster_path: poster,
            media_type,
            root: root
                .map(|r| r.to_string_lossy().to_string())
                .unwrap_or_default(),
            drive,
            total_size: total,
            files,
        });
    }
    Ok(out)
}

// 一批文件路径的公共父目录（LCA）。路径跨盘（盘符前缀不同）或无公共前缀时返回 None
fn common_parent_of(paths: &[String]) -> Option<PathBuf> {
    if paths.is_empty() {
        return None;
    }
    let mut root: Option<PathBuf> = None;
    for p in paths {
        let parent = Path::new(p).parent()?;
        root = Some(match root {
            None => parent.to_path_buf(),
            Some(r) => common_dir_prefix(&r, parent),
        });
        // 公共前缀为空 → 没有共同目录（跨盘等），视为无剧根
        if root.as_ref().map(|r| r.as_os_str().is_empty()).unwrap_or(false) {
            return None;
        }
    }
    root
}

// 两个路径逐组件求公共前缀
fn common_dir_prefix(a: &Path, b: &Path) -> PathBuf {
    let ca: Vec<_> = a.components().collect();
    let cb: Vec<_> = b.components().collect();
    let mut out = PathBuf::new();
    for (x, y) in ca.iter().zip(cb.iter()) {
        if x == y {
            out.push(x.as_os_str());
        } else {
            break;
        }
    }
    out
}

// 从路径提取盘符 "D:"；非盘符路径（相对/UNC）返回 None
fn drive_of_path_str(p: &str) -> Option<String> {
    p.chars()
        .find(|c| c.is_ascii_alphabetic())
        .map(|c| format!("{}:", c.to_ascii_uppercase()))
}

// ─────────────────────────────────────────────
// Tauri Commands - Apply Series Moves（影视跨盘移动）
// ─────────────────────────────────────────────

// 一部剧的迁移方案（前端算好目标根目录：目标盘:\剧名）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesMovePlan {
    pub series_id: String,
    pub target_root: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesMoveResult {
    pub series_id: String,
    pub title: String,
    pub ok: bool,
    pub error: Option<String>,
    // 同 GameMoveResult.warning：移动已成功但源文件被占用未删净，残留需手动清理（ok 仍为 true）。
    pub warning: Option<String>,
}

// 复制进度事件载荷（每复制完一个文件 emit 一次）
#[derive(Clone, Serialize)]
struct SeriesMoveProgress {
    series_id: String,
    title: String,
    done: u64,
    total: u64,
}

// 应用影视磁盘移动：把一批剧的本地视频文件搬到目标根目录（目标盘:\剧名），
// 保持文件相对剧根的结构。逐文件复制 + 完整性校验 + 删源 + 更新 local_path。
// 单剧失败只记入结果，不影响其它剧
#[tauri::command]
pub async fn apply_series_moves(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    moves: Vec<SeriesMovePlan>,
) -> AppResult<Vec<SeriesMoveResult>> {
    let _operation = archive::OperationGuard::acquire(&state.archive_gate)?;
    // 新一轮移动开始：复位取消标志（与游戏移动共用，两个弹窗不可能同时开）。
    // 说明：与游戏侧一致，删源被占用时保留完整目标、移动视为成功、只带源残留警告，不删目标。
    state.move_cancel.store(false, Ordering::Relaxed);
    let mut results = Vec::with_capacity(moves.len());
    let mut cancelled = false;
    for plan in moves {
        // 逐剧之间也检查取消：已置位则不再启动后续影视，
        // 剩余影视以「已取消，未移动」结果返回
        if state.move_cancel.load(Ordering::Relaxed) {
            cancelled = true;
        }
        if cancelled {
            let title: String = state
                .db
                .lock()
                .query_row("SELECT title FROM series WHERE id = ?1", params![plan.series_id], |r| r.get(0))
                .unwrap_or_default();
            results.push(SeriesMoveResult {
                series_id: plan.series_id.clone(),
                title,
                ok: false,
                error: Some("已取消，未移动".to_string()),
                warning: None,
            });
            continue;
        }
        let series_id = plan.series_id.clone();
        let title: String = state
            .db
            .lock()
            .query_row("SELECT title FROM series WHERE id = ?1", params![series_id], |r| r.get(0))
            .unwrap_or_default();
        let result = match move_series_one(&app, &state, &plan, &title).await {
            Ok(warning) => SeriesMoveResult {
                series_id,
                title,
                ok: true,
                error: None,
                warning,
            },
            Err(e) => SeriesMoveResult {
                series_id,
                title,
                ok: false,
                error: Some(e.to_string()),
                warning: None,
            },
        };
        results.push(result);
    }
    Ok(results)
}

// 单部剧移动。安全原则：只有「复制完整校验通过」后才删源；任何失败路径都保证源文件原样保留。
// 返回源残留警告：数据已完整移动到目标，但源文件被占用未能删净，需用户手动清理（移动仍算成功）。
async fn move_series_one(
    app: &tauri::AppHandle,
    state: &AppState,
    plan: &SeriesMovePlan,
    title: &str,
) -> AppResult<Option<String>> {
    // 1. 该剧所有本地文件（去重）
    let paths: Vec<String> = {
        let conn = state.db.lock();
        let mut stmt = conn.prepare(
            "SELECT e.local_path FROM episodes e JOIN seasons s ON s.id = e.season_id
             WHERE e.series_id = ?1 AND e.local_path <> ''",
        )?;
        let mut p: Vec<String> = stmt
            .query_map(params![plan.series_id], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        p.sort();
        p.dedup();
        p
    };
    if paths.is_empty() {
        return Err(AppError::Custom("该影视没有本地文件".to_string()));
    }

    // 2. 剧根（公共父目录）；跨盘剧无公共根 → 拒绝
    let root = common_parent_of(&paths)
        .ok_or_else(|| AppError::Custom("该影视文件跨盘，无法整体移动".to_string()))?;
    let target_root = PathBuf::from(&plan.target_root);
    // 目标与剧根重叠（同盘极端情况）：规范化比较带目录边界
    let root_norm = norm_path(&root);
    let tgt_norm = norm_path(&target_root);
    if tgt_norm == root_norm {
        return Ok(None); // 目标即当前目录，无需移动
    }
    if norm_paths_overlap(&tgt_norm, &root_norm) {
        return Err(AppError::Custom(format!(
            "目标路径 {} 与剧根 {} 重叠，拒绝移动",
            plan.target_root,
            root.display()
        )));
    }
    if target_root.exists() {
        return Err(AppError::Custom(format!("目标目录已存在：{}", plan.target_root)));
    }

    // 3. 总大小（空间校验 + 进度分母）
    let total_size: u64 = paths
        .iter()
        .filter_map(|p| Path::new(p).metadata().ok().map(|m| m.len()))
        .sum();
    // 4. 目标盘可用空间校验
    if let Some(free) = drive_free_space(&target_root) {
        if total_size > free {
            return Err(AppError::Custom(format!(
                "目标盘可用空间不足（需要 {}，可用 {}）",
                fmt_size(total_size),
                fmt_size(free)
            )));
        }
    }

    // 5. 逐文件复制到 目标根目录\<相对剧根路径>，保持内部结构（spawn_blocking 后台）
    let app2 = app.clone();
    let series_id = plan.series_id.clone();
    let title2 = title.to_string();
    let root2 = root.clone();
    let target2 = target_root.clone();
    let paths2 = paths.clone();
    let cancel = state.move_cancel.clone();
    let copy_result: Result<(), String> = tauri::async_runtime::spawn_blocking(move || {
        copy_series_files_with_progress(
            &paths2,
            &root2,
            &target2,
            &app2,
            &series_id,
            &title2,
            total_size,
            &cancel,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| AppError::Custom(format!("复制任务失败: {}", e)))?;
    if let Err(e) = copy_result {
        // 复制中途失败/取消：清理目标残留，源未动，可重试。
        // 取消是用户主动中止，文案与真实失败区分开
        let _ = fs::remove_dir_all(&target_root);
        if e.contains("移动已取消") {
            return Err(AppError::Custom(
                "移动已取消，已清理目标残留副本，影视留在原目录".to_string(),
            ));
        }
        return Err(AppError::Custom(format!(
            "复制失败，已清理目标残留副本（源未动，可重试）：{}",
            e
        )));
    }

    // 6. 完整性校验：源文件快照 vs 目标目录（文件数 + 字节）
    let (src_files, src_bytes) = count_files_of(&paths);
    let (dst_files, dst_bytes) = count_files(&target_root);
    if src_files != dst_files || src_bytes != dst_bytes {
        let _ = fs::remove_dir_all(&target_root);
        return Err(AppError::Custom(format!(
            "复制完整性校验未通过（源 {} 文件/{}，目标 {} 文件/{}），已清理目标副本，源未动",
            src_files,
            fmt_size(src_bytes),
            dst_files,
            fmt_size(dst_bytes)
        )));
    }

    // 7. 删源文件（全部成功才继续），并清理空的父目录。
    // 删源前最后检查一次取消：用户取消 = 清理目标残留、源文件原样保留，移动视为未发生
    if state.move_cancel.load(Ordering::Relaxed) {
        let _ = fs::remove_dir_all(&target_root);
        return Err(AppError::Custom(
            "移动已取消，已清理目标残留副本，影视留在原目录".to_string(),
        ));
    }
    // 删源被占用时，target_root 已通过完整性校验 = 完整副本，移动其实已成功。
    // 绝不删目标：逐文件删源时若中途遇占用，源已删掉一部分，再删目标 = 源残缺 + 目标全无 = 数据丢失。
    // 保留完整目标、把移动视为成功、记源残留为警告让用户手动清理，并停止继续删源（避免删掉更多源文件）。
    let mut src_leftover: Option<String> = None;
    for p in &paths {
        match fs::remove_file(p) {
            Ok(()) => {}
            Err(_) if !Path::new(p).exists() => {} // 源文件本就不存在，视为已删
            Err(e) => {
                src_leftover = Some(format!(
                    "文件已完整移动到新位置，但源文件被占用未能删除（{}）。数据没有丢失，请退出占用程序后手动删除源目录残留",
                    e
                ));
                break;
            }
        }
    }
    // 有残留时含残留文件的目录非空，cleanup 不会误删；无残留时清掉搬空的父目录
    cleanup_empty_dirs(&root, &paths);

    // 8. 更新 episodes.local_path：相对剧根的路径拼到新根
    let new_root = target_root.to_string_lossy().to_string();
    let conn = state.db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, local_path FROM episodes WHERE series_id = ?1 AND local_path <> ''",
    )?;
    let rows: Vec<(String, String)> = stmt
        .query_map(params![plan.series_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for (ep_id, old_path) in rows {
        let rel = Path::new(&old_path)
            .strip_prefix(&root)
            .map(|r| r.to_string_lossy().to_string())
            .unwrap_or_else(|_| old_path.clone());
        let new_path = Path::new(&new_root).join(&rel).to_string_lossy().to_string();
        if let Err(e) = conn.execute(
            "UPDATE episodes SET local_path = ?1 WHERE id = ?2",
            params![new_path, ep_id],
        ) {
            // M4 防线：文件已移动、源已删，明确告诉用户文件在哪里，可手动修复
            return Err(AppError::Custom(format!(
                "影视文件已移动到 {}，但数据库更新失败（{}）。文件在新位置完好，请手动重新关联本地文件",
                new_root, e
            )));
        }
    }
    Ok(src_leftover)
}

// 逐文件复制：相对剧根的路径拼到目标根（保持内部结构），每复制完一个 emit 进度。
// spawn_blocking 线程执行；app 为 AppHandle（Send）。
// cancel 为取消标志：每复制完一个文件检查，置位即中止（调用方走失败清理，源文件原样保留）
fn copy_series_files_with_progress(
    paths: &[String],
    root: &Path,
    target_root: &Path,
    app: &tauri::AppHandle,
    series_id: &str,
    title: &str,
    total: u64,
    cancel: &std::sync::atomic::AtomicBool,
) -> AppResult<()> {
    fs::create_dir_all(target_root)?;
    let mut done = 0u64;
    for p in paths {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::Custom("移动已取消".to_string()));
        }
        let from = Path::new(p);
        let rel = from
            .strip_prefix(root)
            .map(|r| r.to_path_buf())
            .unwrap_or_else(|_| from.file_name().map(|f| PathBuf::from(f)).unwrap_or_default());
        let to = target_root.join(&rel);
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        let size = from.metadata().map(|m| m.len()).unwrap_or(0);
        fs::copy(from, &to)
            .map_err(|e| AppError::Custom(format!("复制失败 {}: {}", from.display(), e)))?;
        done = done.saturating_add(size);
        let _ = app.emit(
            "series-move-progress",
            SeriesMoveProgress {
                series_id: series_id.to_string(),
                title: title.to_string(),
                done,
                total,
            },
        );
    }
    Ok(())
}

// 统计一批指定文件的文件数与总字节（只算存在的文件）
fn count_files_of(paths: &[String]) -> (u64, u64) {
    let mut files = 0u64;
    let mut bytes = 0u64;
    for p in paths {
        if let Ok(meta) = Path::new(p).metadata() {
            if meta.is_file() {
                files += 1;
                bytes += meta.len();
            }
        }
    }
    (files, bytes)
}

// 删除剧根下的空目录（从深到浅；非空目录保留）。用于移动后清理源目录骨架
// 清理「paths 文件被删后留下的空父目录链」（最深 → 剧根边界，root 本身非空则保留）。
// 不做全盘扫描：影视文件的公共父目录可能是盘根（文件散落各处），
// 旧实现会遍历整个盘删掉所有空目录（误删其他应用的空目录 + 遍历几十分钟）
fn cleanup_empty_dirs(root: &Path, paths: &[String]) {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for p in paths {
        let mut cur = Path::new(p).parent().map(Path::to_path_buf);
        while let Some(d) = cur {
            if d == root || !dirs.contains(&d) {
                dirs.push(d.clone());
            }
            cur = d.parent().map(Path::to_path_buf);
        }
    }
    // 深度大的先删（先子后父），remove_dir 只在空目录时成功（非空自动跳过）
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for d in dirs {
        let _ = fs::remove_dir(&d);
    }
}

#[cfg(test)]
mod path_tests {
    use super::{repair_unc_path, tidy_path};

    // 映射盘必须原样留成盘符 —— SMB 盘添加游戏时 install_dir 写坏就是在这里出的问题
    #[test]
    fn tidy_keeps_mapped_drive() {
        assert_eq!(
            tidy_path(r"Y:/Atomic.Heart.v080326/AtomicHeart.exe")
                .unwrap()
                .to_string_lossy(),
            r"Y:/Atomic.Heart.v080326/AtomicHeart.exe"
        );
        // 小写盘符统一大写，正斜杠统一反斜杠，.. 折叠
        assert_eq!(
            tidy_path("y:/games/sub/../AtomicHeart.exe").unwrap().to_string_lossy(),
            r"Y:/games/AtomicHeart.exe"
        );
    }

    // canonicalize 的 verbatim 产物要还原：\\?\UNC\… 必须变回 \\server\share，不能剩 "UNC\…"
    #[test]
    fn tidy_unwraps_verbatim() {
        assert_eq!(
            tidy_path(r"\\?\UNC\10.99.99.99\share\Game\a.exe").unwrap().to_string_lossy(),
            r"\\10.99.99.99\share\Game\a.exe"
        );
        assert_eq!(
            tidy_path(r"\\?\D:/DSX/a.exe").unwrap().to_string_lossy(),
            r"D:/DSX/a.exe"
        );
    }

    // 存量坏值修复：只认 "UNC\…" 形态；该共享没有映射盘时退到 UNC 形式
    #[test]
    fn repair_broken_unc_prefix() {
        assert_eq!(
            repair_unc_path(r"UNC\10.99.99.99\share\Game"),
            Some(r"\\10.99.99.99\share\Game".to_string())
        );
        assert_eq!(repair_unc_path(r"Y:/Game"), None);
        assert_eq!(repair_unc_path(r"\\NAS\share\Game"), None);
        assert_eq!(repair_unc_path(""), None);
    }
}
