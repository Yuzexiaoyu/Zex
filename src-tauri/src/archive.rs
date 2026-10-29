//! Windows 单游戏归档，支持本地 NTFS 和具备所需文件操作能力的 SMB 共享。
//! 直接压缩源目录：建清单起对每个源条目持拒写只读句柄（不含 DELETE，故 7za 可直接读源），
//! 全程源不可被改写或删除；压缩后以 7za 整包测试 + 清单逐项比对校验，通过才重开 DELETE 句柄复核身份删源。
use crate::{AppError, AppResult, AppState, Game};
use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};

fn fail(s: impl Into<String>) -> AppError {
    AppError::Custom(s.into())
}
pub(crate) struct OperationGuard(Arc<AtomicBool>);
impl OperationGuard {
    pub(crate) fn acquire(gate: &Arc<AtomicBool>) -> AppResult<Self> {
        gate.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| fail("归档或磁盘/游戏修改任务正在进行，请稍后重试"))?;
        Ok(Self(gate.clone()))
    }
}
impl Drop for OperationGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

pub(crate) fn migrate(conn: &Connection) -> AppResult<()> {
    let names = conn
        .prepare("PRAGMA table_info(games)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    for (name, ty) in [
        ("archive_status", "TEXT NOT NULL DEFAULT ''"),
        ("archive_path", "TEXT NOT NULL DEFAULT ''"),
        ("archive_size", "INTEGER NOT NULL DEFAULT 0"),
        ("archive_original_size", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !names.contains(name) {
            conn.execute(&format!("ALTER TABLE games ADD COLUMN {name} {ty}"), [])?;
        }
    }
    Ok(()) // cleanup_pending 在重启时原样保留，绝不续删。
}
pub(crate) fn require_unarchived(state: &AppState, id: &str) -> AppResult<()> {
    let status: String =
        state
            .db
            .lock()
            .query_row("SELECT archive_status FROM games WHERE id=?", [id], |r| {
                r.get(0)
            })?;
    if !status.is_empty() {
        return Err(fail("该游戏已归档或有待清理残留，不能执行此操作"));
    }
    Ok(())
}
pub(crate) fn check_edit(state: &AppState, game: &Game) -> AppResult<()> {
    let (status, dir, exe): (String, String, String) = state.db.lock().query_row(
        "SELECT archive_status, install_dir, exe_path FROM games WHERE id=?",
        [&game.id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    if !status.is_empty() && (dir != game.install_dir || exe != game.exe_path) {
        return Err(fail("归档游戏不能修改原安装目录或启动路径"));
    }
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveResult {
    archive_path: String,
    archive_size: u64,
    original_size: u64,
    warning: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    game_id: &'a str,
    phase: &'a str,
    percent: f64,
}
fn emit(app: &AppHandle, id: &str, phase: &str, percent: f64) {
    let _ = app.emit(
        "game-archive-progress",
        Progress {
            game_id: id,
            phase,
            percent,
        },
    );
}
fn cancelled(cancel: &AtomicBool, exiting: &AtomicBool) -> AppResult<()> {
    if cancel.load(Ordering::Acquire) || exiting.load(Ordering::Acquire) {
        Err(fail("归档已取消，源文件未删除"))
    } else {
        Ok(())
    }
}
#[tauri::command]
pub fn cancel_game_archive(state: State<'_, AppState>) {
    state.archive_cancel.store(true, Ordering::Release);
}
#[tauri::command]
pub async fn compress_game(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    archive_path: String,
    level: i32,
) -> AppResult<ArchiveResult> {
    let guard = OperationGuard::acquire(&state.archive_gate)?;
    state.archive_cancel.store(false, Ordering::Release);
    // 使用 AppHandle 在阻塞线程内重新借 State；guard 覆盖完整任务而非仅命令入队。
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let state = app.state::<AppState>();
        run(&app, &state, &game_id, &archive_path, level)
    })
    .await
    .map_err(|e| fail(e.to_string()))?
}
fn resolve_7za(app: &AppHandle) -> AppResult<PathBuf> {
    const BINARY: &[u8] = include_bytes!("../7zip/7za.exe");
    let expected: [u8; 32] = Sha256::digest(BINARY).into();
    let dir = app.state::<AppState>().data_dir.join("tools").join("7zip");
    let path = dir.join("7za.exe");
    if let Ok(mut file) = File::open(&path) {
        if hash(&mut file)? == (expected, BINARY.len() as u64) {
            return Ok(path);
        }
    }

    fs::create_dir_all(&dir)?;
    let temporary = dir.join(format!("7za-{}.tmp", uuid::Uuid::new_v4()));
    let install = (|| -> AppResult<()> {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        file.write_all(BINARY)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, &path)?;
        Ok(())
    })();
    if let Err(error) = install {
        let _ = fs::remove_file(&temporary);
        return Err(fail(format!("释放内嵌 7-Zip 失败（{}）：{error}", path.display())));
    }
    Ok(path)
}
fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
    }
}
fn key(path: &Path) -> String {
    display_path(path).replace('/', "\\").to_lowercase()
}
fn within(a: &Path, b: &Path) -> bool {
    let (a, b) = (key(a), key(b));
    a == b || a.starts_with(&(b.trim_end_matches('\\').to_owned() + "\\"))
}
fn safe_name(s: &str) -> AppResult<()> {
    if s.is_empty()
        || s.contains(['\r', '\n', ':', '\\', '/'])
        || s.chars().any(char::is_control)
        || s.ends_with([' ', '.'])
        || s == "."
        || s == ".."
    {
        return Err(fail("不支持的文件名（控制字符、流或非规范路径）"));
    }
    Ok(())
}
fn entry_key(s: &str) -> AppResult<String> {
    let normalized = s.replace('\\', "/");
    for component in normalized.split('/') {
        safe_name(component)?;
    }
    Ok(normalized)
}
fn hash(file: &mut File) -> AppResult<([u8; 32], u64)> {
    file.seek(SeekFrom::Start(0))?;
    digest_reader(file)
}
fn digest_reader(mut reader: impl Read) -> AppResult<([u8; 32], u64)> {
    let mut sha = Sha256::new();
    let mut size = 0u64;
    let mut buf = [0u8; 128 * 1024];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        sha.update(&buf[..n]);
        size = size.checked_add(n as u64).ok_or_else(|| fail("文件过大"))?;
    }
    Ok((sha.finalize().into(), size))
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::os::windows::{
        ffi::OsStrExt,
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle},
    };
    use windows_sys::Win32::{Foundation::*, Storage::FileSystem::*};
    pub fn wide(p: &Path) -> Vec<u16> {
        p.as_os_str().encode_wide().chain(Some(0)).collect()
    }
    pub fn info(f: &File) -> AppResult<BY_HANDLE_FILE_INFORMATION> {
        let mut info = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(f.as_raw_handle() as _, &mut info) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(info)
    }
    pub fn same(a: &BY_HANDLE_FILE_INFORMATION, b: &BY_HANDLE_FILE_INFORMATION) -> bool {
        a.dwVolumeSerialNumber == b.dwVolumeSerialNumber
            && a.nFileIndexHigh == b.nFileIndexHigh
            && a.nFileIndexLow == b.nFileIndexLow
    }
    pub fn open(path: &Path, delete: bool, dir: bool) -> AppResult<File> {
        // OPEN_REPARSE_POINT 保证按名称打开的对象本身不是未经检查的链接目标。
        let f = OpenOptions::new()
            .access_mode(
                if dir {
                    FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY
                } else {
                    GENERIC_READ
                } | if delete { DELETE } else { 0 },
            )
            .share_mode(if dir && !delete {
                FILE_SHARE_READ | FILE_SHARE_WRITE
            } else {
                FILE_SHARE_READ
            })
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        let i = info(&f)?;
        if i.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_ENCRYPTED) != 0
            || (!dir && i.nNumberOfLinks != 1)
            || (i.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != dir
        {
            return Err(fail("拒绝链接、EFS、多硬链接或类型变化的源条目"));
        }
        streams(&f, path)?;
        Ok(f)
    }
    pub fn writable_archive(path: &Path) -> AppResult<File> {
        let f = OpenOptions::new()
            .access_mode(GENERIC_READ | GENERIC_WRITE | DELETE)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        let i = info(&f)?;
        if i.dwFileAttributes
            & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_ENCRYPTED | FILE_ATTRIBUTE_DIRECTORY)
            != 0
            || i.nNumberOfLinks != 1
        {
            return Err(fail("归档文件类型不安全"));
        }
        streams(&f, path)?;
        Ok(f)
    }
    /// 可以放行的流：默认数据流（空名 / ::$DATA），以及 Windows 的「下载标记」:Zone.Identifier。
    /// 后者由浏览器与解压器写在从网上下载的文件上（Mark of the Web），是系统元数据不是文件内容：
    /// 压缩包本来就不保留 NTFS 流（随附 7za 26.03 开 -sns 直接报「未实现」），为它拒绝整份源文件
    /// 毫无意义 —— 从网上下载的安装包/绿色版几乎每个文件都带这个流，放行才不会一压就中止。
    /// 其余命名流一律拒绝：流内容不随压缩包保留，删源就会静默丢数据。
    fn ignorable_stream(name: &str) -> bool {
        name.is_empty()
            || name.eq_ignore_ascii_case("::$DATA")
            || name.eq_ignore_ascii_case(":Zone.Identifier:$DATA")
            || name.eq_ignore_ascii_case(":Zone.Identifier")
    }
    // 错误信息必须带路径与流名：源里哪个文件带流，用户/日志一眼能看到（原来两条都看不出来）
    fn streams(f: &File, path: &Path) -> AppResult<()> {
        // FileStreamInfo 从同一个受保护的句柄枚举，不能对路径另开存在竞态的扫描。
        let mut buffer = vec![0u64; 8192];
        if unsafe {
            GetFileInformationByHandleEx(
                f.as_raw_handle() as _,
                FileStreamInfo,
                buffer.as_mut_ptr() as _,
                (buffer.len() * 8) as u32,
            )
        } == 0
        {
            let error = std::io::Error::last_os_error();
            // NTFS 无命名流的目录返回 ERROR_HANDLE_EOF；这是完整的空列表，不是跳过检查。
            if error.raw_os_error() == Some(38) {
                return Ok(());
            }
            return Err(fail(format!("无法完整检查 ADS：{error}")));
        }
        let bytes =
            unsafe { std::slice::from_raw_parts(buffer.as_ptr() as *const u8, buffer.len() * 8) };
        let mut offset = 0;
        loop {
            if offset + 24 > bytes.len() {
                return Err(fail("无效流信息"));
            }
            let next = u32::from_ne_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
            let n = u32::from_ne_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
            if n % 2 != 0 || offset + 24 + n > bytes.len() {
                return Err(fail("无效流信息"));
            }
            let name = String::from_utf16(
                &bytes[offset + 24..offset + 24 + n]
                    .chunks_exact(2)
                    .map(|c| u16::from_ne_bytes([c[0], c[1]]))
                    .collect::<Vec<_>>(),
            )
            .map_err(|_| fail("无效流名"))?;
            if !ignorable_stream(&name) {
                return Err(fail(format!(
                    "不支持 NTFS 替代数据流 {name}：{}",
                    path.display()
                )));
            }
            if next == 0 {
                break;
            }
            if next < 24 {
                return Err(fail("无效流偏移"));
            }
            offset += next;
        }
        Ok(())
    }
    pub fn storage_free_space(path: &Path) -> AppResult<u64> {
        let p = wide(path);
        let mut volume = vec![0u16; 32768];
        if unsafe { GetVolumePathNameW(p.as_ptr(), volume.as_mut_ptr(), volume.len() as u32) } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        let drive_type = unsafe { GetDriveTypeW(volume.as_ptr()) };
        let remote = drive_type == 4;
        if drive_type != 3 && !remote {
            return Err(fail("归档支持本地固定 NTFS 磁盘或已连接的 SMB 网络共享"));
        }
        let mut name = [0u16; 64];
        if !remote {
            if unsafe {
                GetVolumeInformationW(
                    volume.as_ptr(),
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    name.as_mut_ptr(),
                    64,
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            if String::from_utf16_lossy(&name[..name.iter().position(|c| *c == 0).unwrap_or(64)])
                != "NTFS"
            {
                return Err(fail("本地归档需要 NTFS；NAS 请通过 SMB 共享或映射盘访问"));
            }
        }
        let mut free = 0;
        if unsafe {
            GetDiskFreeSpaceExW(
                p.as_ptr(),
                &mut free,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(free)
    }
    // 仅取可用空间（不校验盘类型/文件系统）：解压恢复可落到任意可写盘，不强制 NTFS。
    pub fn free_space(path: &Path) -> AppResult<u64> {
        let p = wide(path);
        let mut free = 0u64;
        if unsafe {
            GetDiskFreeSpaceExW(p.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut())
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(free)
    }
    pub fn remove(f: &File) -> AppResult<()> {
        let data = FILE_DISPOSITION_INFO { DeleteFile: 1 };
        if unsafe {
            SetFileInformationByHandle(
                f.as_raw_handle() as _,
                FileDispositionInfo,
                &data as *const _ as _,
                std::mem::size_of_val(&data) as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
    pub fn rename(f: &File, to: &Path) -> AppResult<()> {
        let name = wide(to);
        let offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
        let size = offset + (name.len() - 1) * 2;
        let mut memory = vec![0u64; (size + 7) / 8];
        let p = memory.as_mut_ptr() as *mut FILE_RENAME_INFO;
        unsafe {
            (*p).Anonymous.ReplaceIfExists = 0;
            (*p).RootDirectory = std::ptr::null_mut();
            (*p).FileNameLength = ((name.len() - 1) * 2) as u32;
            std::ptr::copy_nonoverlapping(
                name.as_ptr(),
                (*p).FileName.as_mut_ptr(),
                name.len() - 1,
            );
        }
        if unsafe {
            SetFileInformationByHandle(f.as_raw_handle() as _, FileRenameInfo, p as _, size as u32)
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
    // 任务对象在进程异常退出时由内核关闭并终止子进程，禁止遗留后台 7za。
    pub struct Job(pub File);
    impl Job {
        pub fn new() -> AppResult<Self> {
            use windows_sys::Win32::System::JobObjects::*;
            let h = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if h.is_null() {
                return Err(std::io::Error::last_os_error().into());
            }
            let f = unsafe { File::from_raw_handle(h as _) };
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if unsafe {
                SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as _,
                    std::mem::size_of_val(&limits) as u32,
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(Self(f))
        }
        pub fn assign(&self, child: &std::process::Child) -> AppResult<()> {
            if unsafe {
                windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(
                    self.0.as_raw_handle() as _,
                    child.as_raw_handle() as _,
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(())
        }
    }
}

#[cfg(windows)]
struct Entry {
    relative: String,
    path: PathBuf,
    file: Option<File>,
    identity: windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION,
    directory: bool,
    size: u64,
}
#[cfg(windows)]
struct Manifest {
    entries: Vec<Entry>,
    total: u64,
    _ancestors: Vec<File>,
    report: Option<(AppHandle, String)>,
}
#[cfg(windows)]
fn anchors(path: &Path) -> AppResult<Vec<File>> {
    let mut paths = path.ancestors().map(Path::to_path_buf).collect::<Vec<_>>();
    paths.reverse();
    paths
        .into_iter()
        .filter(|p| p.parent().is_some())
        .map(|p| win::open(&p, false, true))
        .collect()
}
#[cfg(windows)]
impl Manifest {
    fn build(
        root: &Path,
        cancel: &AtomicBool,
        exiting: &AtomicBool,
        pinned: Option<File>,
    ) -> AppResult<Self> {
        let ancestors = anchors(root.parent().ok_or_else(|| fail("不能归档盘根"))?)?;
        let mut m = Self {
            entries: vec![],
            total: 0,
            _ancestors: ancestors,
            report: None,
        };
        let name = root
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| fail("目录名不是 Unicode"))?;
        m.walk(root, name.to_owned(), cancel, exiting, pinned)?;
        Ok(m)
    }
    fn walk(
        &mut self,
        path: &Path,
        relative: String,
        cancel: &AtomicBool,
        exiting: &AtomicBool,
        pinned: Option<File>,
    ) -> AppResult<()> {
        cancelled(cancel, exiting)?;
        entry_key(&relative)?;
        let dir = fs::symlink_metadata(path)?.is_dir();
        let file = match pinned {
            Some(f) => f,
            // 只读拒写句柄（不含 DELETE）：压缩期间源不可被改写/删除，同时允许 7za 直接读取源。
            None => win::open(path, false, dir)?,
        };
        let identity = win::info(&file)?;
        // 直接压源不再预读内容算 SHA256（避免把整个游戏多读一遍）；大小取自句柄信息，
        // 完整性由 7za 整包测试 + 清单逐项比对 + 全程拒写锁共同保证。
        let size = if dir {
            0
        } else {
            ((identity.nFileSizeHigh as u64) << 32) | identity.nFileSizeLow as u64
        };
        self.total = self
            .total
            .checked_add(size)
            .ok_or_else(|| fail("源目录过大"))?;
        self.entries.push(Entry {
            relative: relative.clone(),
            path: path.to_owned(),
            file: Some(file),
            identity,
            directory: dir,
            size,
        });
        if dir {
            for e in fs::read_dir(path)? {
                let e = e?;
                let name = e
                    .file_name()
                    .into_string()
                    .map_err(|_| fail("文件名不是 Unicode"))?;
                safe_name(&name)?;
                self.walk(
                    &e.path(),
                    format!("{relative}/{name}"),
                    cancel,
                    exiting,
                    None,
                )?;
            }
        }
        Ok(())
    }
    fn rescan(&self) -> AppResult<()> {
        // 只检查清单/身份，删除仍使用始终持有的句柄，绝不通过复扫名单递归删除。
        let expected = self
            .entries
            .iter()
            .map(|e| key(&e.path))
            .collect::<HashSet<_>>();
        for e in &self.entries {
            if !win::same(&e.identity, &win::info(e.file.as_ref().unwrap())?) {
                return Err(fail("源条目身份变化"));
            }
            if e.directory {
                for c in fs::read_dir(&e.path)? {
                    if !expected.contains(&key(&c?.path())) {
                        return Err(fail("源目录新增条目，保留源文件"));
                    }
                }
            }
        }
        Ok(())
    }
    fn clean(&mut self) -> AppResult<()> {
        self.rescan()?;
        let count = self.entries.len();
        for (index, e) in self.entries.iter_mut().rev().enumerate() {
            // 建清单时持的是只读句柄（无 DELETE，让 7za 能读源）。删除前先放掉只读锁，
            // 再以 DELETE 重开同一路径并复核身份（卷序列号 + 文件索引）确认仍是原对象；
            // 重开会重跑 reparse/ADS 检查，期间若被换成链接或其它文件则身份不符而中止。
            let expected = e.identity;
            e.file.take();
            let del = win::open(&e.path, true, e.directory)?;
            if !win::same(&expected, &win::info(&del)?) {
                return Err(fail("源条目身份变化，停止清理"));
            }
            win::remove(&del)?;
            // 关闭已 delete-pending 的句柄后才轮到父目录，非空目录内核拒绝删除。
            drop(del);
            if let Some((app, id)) = &self.report {
                emit(
                    app,
                    id,
                    "cleaning",
                    (index + 1) as f64 * 100.0 / count.max(1) as f64,
                );
            }
        }
        Ok(())
    }
}
// 只清理本任务创建过的精确路径；绝不用 remove_dir_all，外部新增文件使 rmdir 失败并保留。
struct Scratch {
    files: Vec<PathBuf>,
    dirs: Vec<PathBuf>,
}
impl Drop for Scratch {
    fn drop(&mut self) {
        for p in self.files.iter().rev() {
            let _ = fs::remove_file(p);
        }
        for p in self.dirs.iter().rev() {
            let _ = fs::remove_dir(p);
        }
    }
}

#[cfg(windows)]
fn command(
    tool: &Path,
    args: &[String],
    cwd: &Path,
    cancel: &AtomicBool,
    exiting: &AtomicBool,
    decode: bool,
) -> AppResult<(Vec<u8>, [u8; 32], u64)> {
    command_progress(tool, args, cwd, cancel, exiting, decode, None)
}
#[cfg(windows)]
fn command_progress(
    tool: &Path,
    args: &[String],
    cwd: &Path,
    cancel: &AtomicBool,
    exiting: &AtomicBool,
    decode: bool,
    report: Option<(AppHandle, String, &'static str)>,
) -> AppResult<(Vec<u8>, [u8; 32], u64)> {
    use std::os::windows::process::CommandExt;
    cancelled(cancel, exiting)?;
    let job = win::Job::new()?;
    let mut child = Command::new(tool)
        .args(args)
        .current_dir(cwd)
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Err(e) = job.assign(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let out = thread::spawn(move || -> AppResult<_> {
        if decode {
            let (sha, size) = digest_reader(stdout)?;
            return Ok((vec![], sha, size));
        }
        let mut reader = stdout;
        let mut data = vec![];
        let mut buf = [0u8; 4096];
        let mut carry = String::new();
        let mut overflow = false;
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            if data.len() + n <= 32 * 1024 * 1024 {
                data.extend_from_slice(&buf[..n]);
            } else {
                overflow = true;
            }
            if let Some((app, id, phase)) = &report {
                carry.push_str(&String::from_utf8_lossy(&buf[..n]));
                while let Some(pos) = carry.find('%') {
                    let digits = carry[..pos]
                        .chars()
                        .rev()
                        .take_while(char::is_ascii_digit)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect::<String>();
                    if let Ok(percent) = digits.parse::<u32>() {
                        if percent <= 100 {
                            emit(app, id, phase, percent as f64);
                        }
                    }
                    carry.drain(..=pos);
                }
                if carry.len() > 8192 {
                    carry.clear();
                }
            }
        }
        if overflow {
            return Err(fail("7za 清单输出超出安全上限"));
        }
        Ok((data, [0; 32], 0))
    });
    let err = thread::spawn(move || {
        let mut s = Vec::new();
        let mut reader = stderr;
        let mut b = [0u8; 4096];
        while let Ok(n) = reader.read(&mut b) {
            if n == 0 {
                break;
            }
            if s.len() < 65536 {
                s.extend_from_slice(&b[..n]);
            }
        }
        s
    });
    let status = loop {
        if let Err(e) = cancelled(cancel, exiting) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = out.join();
            let _ = err.join();
            return Err(e);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = out.join();
                let _ = err.join();
                return Err(e.into());
            }
        }
    };
    let output = out.join().map_err(|_| fail("7za 输出读取线程失败"))??;
    let error = err.join().map_err(|_| fail("7za 错误读取线程失败"))?;
    if !status.success() {
        return Err(fail(format!(
            "7za 退出码 {:?}，禁止删除源文件：{}",
            status.code(),
            String::from_utf8_lossy(&error)
        )));
    }
    Ok(output)
}
fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}
fn parse_listing(bytes: &[u8]) -> AppResult<BTreeMap<String, (bool, u64)>> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| fail("7za 清单不是 UTF-8"))?
        .replace("\r\n", "\n");
    let mut result = BTreeMap::new();
    for block in text.split("\n\n").filter(|s| !s.trim().is_empty()) {
        let mut fields = BTreeMap::new();
        for line in block.lines() {
            let (k, v) = line
                .split_once(" = ")
                .ok_or_else(|| fail("7za 清单格式异常"))?;
            if fields.insert(k, v).is_some() {
                return Err(fail("7za 清单重复字段"));
            }
        }
        let path = entry_key(fields.get("Path").ok_or_else(|| fail("清单缺少路径"))?)?;
        let attrs = fields
            .get("Attributes")
            .ok_or_else(|| fail("清单缺少属性"))?;
        // 7za 的属性串是字母拼接：R 只读 / H 隐藏 / S 系统 / D 目录 / A 归档 / I 不索引 ——
        // 目录不索引写作 "DI"、隐藏文件 "HA"、只读文件 "RA"，普通文件 "A"、普通目录 "D"。
        // 类型只看有没有 D：附加属性（隐藏/只读/不索引…）与归档保真度无关，不该因为它多带
        // 一个字母就让整包中止（游戏存档目录常带 NotContentIndexed）。
        // 类型或大小对不上时，后面的整表比对仍会拦下，不会因此误判为通过。
        let dir = attrs.contains('D');
        let size = fields
            .get("Size")
            .ok_or_else(|| fail("清单缺少大小"))?
            .parse::<u64>()
            .map_err(|_| fail("清单大小无效"))?;
        if fields.get("Encrypted") == Some(&"+")
            || fields.contains_key("Symbolic Link")
            || fields.contains_key("Hard Link")
        {
            return Err(fail("归档含有不支持的数据类型"));
        }
        if result.insert(path, (dir, size)).is_some() {
            return Err(fail("归档清单有重复条目"));
        }
    }
    Ok(result)
}
#[cfg(windows)]
fn verify(
    tool: &Path,
    archive: &Path,
    m: &Manifest,
    cancel: &AtomicBool,
    exiting: &AtomicBool,
) -> AppResult<(windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION, u64)> {
    // 在调用任何校验之前取得并一直保留禁止改写/替换的读锁。
    let lock = win::open(archive, false, false)?;
    let cwd = archive.parent().unwrap();
    let p = archive.to_str().ok_or_else(|| fail("目标不是 Unicode"))?;
    // 整包测试（解压校验 CRC）带进度输出，避免大包 / NAS 上长时间停在"正在校验 0%"。
    let verify_report = m
        .report
        .as_ref()
        .map(|(app, id)| (app.clone(), id.clone(), "verifying"));
    command_progress(
        tool,
        &strings(&["t", "-bb0", "-bsp1", "-y", "--", p]),
        cwd,
        cancel,
        exiting,
        false,
        verify_report,
    )?;
    let (listing, _, _) = command(
        tool,
        &strings(&["l", "-slt", "-ba", "-sccUTF-8", "--", p]),
        cwd,
        cancel,
        exiting,
        false,
    )?;
    let listing = parse_listing(&listing)?;
    let expected = m
        .entries
        .iter()
        .map(|e| (e.relative.clone(), (e.directory, e.size)))
        .collect::<BTreeMap<_, _>>();
    if listing != expected {
        return Err(fail("归档完整清单与锁定源不一致，禁止删除源文件"));
    }
    // 直接压源模式：7za `t` 已逐条解压测试（CRC32）确认归档可完整还原，清单又与锁定源逐项
    // （名称/类型/大小）一致；源自建清单起即被拒写锁锁死不可改，故归档忠实于将被删除的源。
    // 只做这一趟整包测试，不再额外整包 SHA256（避免把压缩包反复整读）。返回文件身份供改名前复核。
    let info = win::info(&lock)?;
    let size = ((info.nFileSizeHigh as u64) << 32) | info.nFileSizeLow as u64;
    Ok((info, size))
}

#[cfg(windows)]
fn validate_paths(
    state: &AppState,
    id: &str,
    source: &str,
    exe: &str,
    destination: &str,
) -> AppResult<(PathBuf, PathBuf, Vec<File>, File)> {
    if source.trim().is_empty() || exe.trim().is_empty() {
        return Err(fail(
            "必须先设置完整安装目录和启动程序，不会回退到 exe 父目录",
        ));
    }
    let raw = PathBuf::from(source);
    if !raw.is_absolute() {
        return Err(fail("安装目录必须为绝对路径"));
    }
    // 在 canonicalize 前锚定所有祖先并拒绝 reparse，不能通过联接绕过路径保护。
    let mut locks = anchors(raw.parent().ok_or_else(|| fail("不能归档盘根"))?)?;
    // 检查选中的根自身，canonicalize 之前拒绝 junction/symlink；持只读拒写锁（不含 DELETE，让 7za 可读）。
    let root_lock = win::open(&raw, false, true)?;
    let root = fs::canonicalize(&raw)?;
    win::storage_free_space(&root)?;
    if root.parent().is_none() || root.file_name().is_none() {
        return Err(fail("不能归档盘根"));
    }
    let exe = fs::canonicalize(exe)?;
    if !within(&exe, &root) || exe == root {
        return Err(fail("启动程序不属于安装目录"));
    }
    let mut protected = vec![
        state.data_dir.clone(),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")),
    ];
    if let Ok(p) = std::env::current_exe() {
        if let Some(p) = p.parent() {
            protected.push(p.to_owned());
        }
    }
    for env in [
        "WINDIR",
        "SystemRoot",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
        "USERPROFILE",
        "PUBLIC",
        "APPDATA",
        "LOCALAPPDATA",
    ] {
        if let Some(p) = std::env::var_os(env) {
            protected.push(PathBuf::from(p));
        }
    }
    for p in protected {
        if let Ok(p) = fs::canonicalize(p) {
            if within(&p, &root)
                || (std::env::var_os("WINDIR")
                    .map(|w| within(&root, &PathBuf::from(w)))
                    .unwrap_or(false))
            {
                return Err(fail("安装目录覆盖受保护的系统、用户或 ZEX 目录"));
            }
        }
    }
    let leaf = root.file_name().unwrap().to_string_lossy().to_lowercase();
    if [
        "games",
        "steam",
        "steamlibrary",
        "steamapps",
        "common",
        "gog games",
        "epic games",
        "xboxgames",
        "users",
        "windows",
        "program files",
        "program files (x86)",
    ]
    .contains(&leaf.as_str())
    {
        return Err(fail("不能归档游戏库公共根目录"));
    }
    let conn = state.db.lock();
    let mut q = conn.prepare("SELECT install_dir FROM games WHERE id<>? AND install_dir<>''")?;
    for p in q.query_map([id], |r| r.get::<_, String>(0))? {
        let p = PathBuf::from(p?);
        let p = fs::canonicalize(&p).unwrap_or(p);
        if within(&p, &root) || within(&root, &p) {
            return Err(fail("安装目录与其它游戏目录重叠"));
        }
    }
    drop(q);
    drop(conn);
    let dst = PathBuf::from(destination);
    if !dst.is_absolute() {
        return Err(fail("归档目标必须是绝对路径"));
    }
    safe_name(
        dst.file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| fail("目标文件名无效"))?,
    )?;
    if dst
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("7z"))
        != Some(true)
    {
        return Err(fail("目标必须使用 .7z 扩展名"));
    }
    let parent = dst.parent().ok_or_else(|| fail("目标父目录无效"))?;
    locks.extend(anchors(parent)?);
    let parent = fs::canonicalize(parent)?;
    win::storage_free_space(&parent)?;
    let dst = parent.join(dst.file_name().unwrap());
    if within(&dst, &root) || dst.exists() {
        return Err(fail("归档目标在源内或已存在，不会覆盖"));
    }
    Ok((root, dst, locks, root_lock))
}
#[cfg(windows)]
fn run(
    app: &AppHandle,
    state: &AppState,
    id: &str,
    destination: &str,
    level: i32,
) -> AppResult<ArchiveResult> {
    if ![1, 5, 9].contains(&level) {
        return Err(fail("压缩等级仅允许 1、5、9"));
    }
    require_unarchived(state, id)?;
    let (source, exe, monitor): (String, String, String) = state.db.lock().query_row(
        "SELECT install_dir,exe_path,monitor_process FROM games WHERE id=?",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    if state.running_games.read().contains_key(id) {
        return Err(fail("游戏正在运行，请先退出"));
    }
    let sys = sysinfo::System::new_all();
    if !crate::games::game_process_matches(&sys, &exe, &source, &monitor).is_empty() {
        return Err(fail("安装目录中的进程正在运行，请先退出"));
    }
    let tool = resolve_7za(app)?;
    let cancel = &state.archive_cancel;
    let exiting = &state.exiting;
    emit(app, id, "preparing", 0.0);
    let (root, dst, _locks, root_lock) = validate_paths(state, id, &source, &exe, destination)?;
    let mut manifest = Manifest::build(&root, cancel, exiting, Some(root_lock))?;
    manifest.report = Some((app.clone(), id.to_owned()));
    let parent = dst.parent().unwrap();
    // 直接压源不再暂存整份拷贝，只需容纳压缩包：按不可压缩最坏情况（原始大小 + 6.25% 膨胀）估算。
    let needed = manifest
        .total
        .checked_add(manifest.total / 16) // LZMA2 不可压缩数据膨胀余量 6.25%
        .and_then(|n| n.checked_add((manifest.entries.len() as u64).saturating_mul(4096)))
        .and_then(|n| n.checked_add(128 * 1024 * 1024))
        .ok_or_else(|| fail("压缩包空间估算溢出"))?;
    if win::storage_free_space(parent)? < needed {
        return Err(fail(format!(
            "压缩包需要至少 {} 字节可用空间（不假定压缩率）",
            needed
        )));
    }
    let temp = parent.join(format!(".zex-archive-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&temp)?;
    let mut scratch = Scratch {
        files: vec![],
        dirs: vec![temp.clone()],
    };
    // 直接压缩源目录：源条目全程被只读拒写句柄锁住（7za 可读、他人不可改删）。
    // 7za 工作目录设为源的父目录，按根文件夹名归档，产出条目路径与清单一致。
    let source_parent = root.parent().ok_or_else(|| fail("源父目录无效"))?;
    manifest.rescan()?;
    let output = temp.join("payload.7z");
    scratch.files.push(output.clone());
    emit(app, id, "compressing", 0.0);
    let args = vec![
        "a".into(),
        "-t7z".into(),
        format!("-mx={level}"),
        "-ms=on".into(), // 固实压缩：跨文件共享字典去重，包更小；本流程只整包校验/恢复，无单文件解压需求
        "-m0=lzma2".into(),
        "-bsp1".into(),
        "-bb0".into(),
        "-y".into(),
        "-spd".into(),
        "--".into(),
        output.to_string_lossy().into_owned(),
        manifest.entries[0].relative.clone(),
    ];
    command_progress(
        &tool,
        &args,
        source_parent,
        cancel,
        exiting,
        false,
        Some((app.clone(), id.to_owned(), "compressing")),
    )?;
    OpenOptions::new().write(true).open(&output)?.sync_all()?;
    emit(app, id, "verifying", 0.0);
    let verified = verify(&tool, &output, &manifest, cancel, exiting)?;
    // 7za 不共享 DELETE，故测试阶段只持读锁；此处切换为 DELETE 句柄前，用文件身份（卷序列号+文件索引）
    // 复核压缩包未被替换，确认是刚测试通过的那一个，再 rename-by-handle 落位。
    let archive_lock = win::writable_archive(&output)?;
    if !win::same(&verified.0, &win::info(&archive_lock)?) {
        return Err(fail("校验后的压缩包被替换，保留源文件"));
    }
    cancelled(cancel, exiting)?;
    manifest.rescan()?;
    win::rename(&archive_lock, &dst)?;
    archive_lock.sync_all()?;
    let archive_path = display_path(&dst);
    let mut result = ArchiveResult {
        archive_path: archive_path.clone(),
        archive_size: verified.1,
        original_size: manifest.total,
        warning: None,
    };
    // 发布后写库失败也绝不删源；最终文件保留供用户处理。
    if let Err(e) = mark_pending(
        &state.db.lock(),
        id,
        &archive_path,
        verified.1,
        manifest.total,
    ) {
        return Err(fail(format!(
            "压缩包已保存到 {archive_path}，但归档状态写入失败，源完整保留：{e}"
        )));
    }
    emit(app, id, "cleaning", 0.0);
    // 一旦进入 cleaning，不再响应取消，不续删重启遗留任务。
    match manifest.clean() {
        Ok(())=> {if let Err(e)=state.db.lock().execute("UPDATE games SET archive_status='archived' WHERE id=? AND archive_status='cleanup_pending'",[id]) {result.warning=Some(format!("源已清理，但状态更新失败：{e}"));}},
        Err(e)=>result.warning=Some(format!("压缩包已完整校验，源目录仍有残留；未自动继续删除：{e}")),
    }
    emit(app, id, "cleaning", 100.0);
    drop(archive_lock);
    Ok(result)
}
fn mark_pending(
    conn: &Connection,
    id: &str,
    path: &str,
    size: u64,
    original: u64,
) -> AppResult<()> {
    let n=conn.execute("UPDATE games SET archive_status='cleanup_pending',archive_path=?,archive_size=?,archive_original_size=? WHERE id=? AND archive_status=''",params![path,size,original,id])?;
    if n != 1 {
        return Err(fail("游戏归档状态已经变化"));
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    install_dir: String,
    archive_deleted: bool,
    warning: Option<String>,
}
#[tauri::command]
pub async fn decompress_game(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    target_dir: String,
    delete_archive: bool,
) -> AppResult<RestoreResult> {
    let guard = OperationGuard::acquire(&state.archive_gate)?;
    state.archive_cancel.store(false, Ordering::Release);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let state = app.state::<AppState>();
        restore(&app, &state, &game_id, &target_dir, delete_archive)
    })
    .await
    .map_err(|e| fail(e.to_string()))?
}
// 把以 old_base 为前缀的路径改挂到 new_base 下（大小写不敏感；非该前缀则原样返回）。
fn rebase(path: &str, old_base: &str, new_base: &str) -> String {
    let ob = old_base.trim_end_matches(['\\', '/']);
    if let Some(head) = path.get(..ob.len()) {
        if head.eq_ignore_ascii_case(ob) {
            let rest = &path[ob.len()..];
            if rest.is_empty() || rest.starts_with(['\\', '/']) {
                return format!("{}{}", new_base.trim_end_matches(['\\', '/']), rest);
            }
        }
    }
    path.to_owned()
}
// 解压临时目录看守：函数返回时（成功移走内容或中途失败）都整个清掉这个私有 staging。
struct RestoreStaging(PathBuf);
impl Drop for RestoreStaging {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[cfg(windows)]
fn restore(
    app: &AppHandle,
    state: &AppState,
    id: &str,
    target_dir: &str,
    delete_archive: bool,
) -> AppResult<RestoreResult> {
    let (status, archive_path, install_dir, exe_path, work_dir, original): (
        String,
        String,
        String,
        String,
        String,
        u64,
    ) = state.db.lock().query_row(
        "SELECT archive_status, archive_path, install_dir, exe_path, work_dir, archive_original_size FROM games WHERE id=?",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
    )?;
    if status.is_empty() {
        return Err(fail("该游戏未归档"));
    }
    if archive_path.trim().is_empty() || install_dir.trim().is_empty() {
        return Err(fail("归档记录不完整（缺少压缩包路径或原安装目录），无法解压"));
    }
    let archive = PathBuf::from(&archive_path);
    if !fs::symlink_metadata(&archive).map(|m| m.is_file()).unwrap_or(false) {
        return Err(fail(format!("找不到压缩包：{archive_path}")));
    }
    let folder = Path::new(&install_dir)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| fail("无法确定游戏文件夹名"))?
        .to_owned();
    safe_name(&folder)?;
    let target = fs::canonicalize(target_dir).map_err(|e| fail(format!("解压目录无效：{e}")))?;
    if !target.is_dir() {
        return Err(fail("解压目标不是有效目录"));
    }
    let dest = target.join(&folder);
    if dest.exists() {
        return Err(fail(format!(
            "目标盘已存在同名文件夹，拒绝覆盖：{}",
            display_path(&dest)
        )));
    }
    if win::free_space(&target)? < original.saturating_add(64 * 1024 * 1024) {
        return Err(fail(format!("解压目标盘可用空间不足（约需 {original} 字节）")));
    }
    let tool = resolve_7za(app)?;
    let cancel = &state.archive_cancel;
    let exiting = &state.exiting;
    let staging = target.join(format!(".zex-restore-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&staging)?;
    let _staging_guard = RestoreStaging(staging.clone());
    emit(app, id, "extracting", 0.0);
    let out = format!("-o{}", staging.to_string_lossy());
    let p = archive
        .to_str()
        .ok_or_else(|| fail("压缩包路径不是 Unicode"))?
        .to_owned();
    command_progress(
        &tool,
        &strings(&["x", &out, "-bsp1", "-bb0", "-y", "-spd", "--", &p]),
        &staging,
        cancel,
        exiting,
        false,
        Some((app.clone(), id.to_owned(), "extracting")),
    )?;
    let extracted = staging.join(&folder);
    if !extracted.is_dir() {
        return Err(fail("压缩包解压后未找到游戏文件夹"));
    }
    emit(app, id, "moving", 0.0);
    fs::rename(&extracted, &dest)?;
    let new_install = display_path(&dest);
    let new_exe = rebase(&exe_path, &install_dir, &new_install);
    let new_work = if work_dir.is_empty() {
        String::new()
    } else {
        rebase(&work_dir, &install_dir, &new_install)
    };
    {
        let conn = state.db.lock();
        // 保留压缩包时：原记录转为可玩副本（保留 id/时长/收藏/排序），再克隆出一条新的已归档记录
        // 代表仍在盘上的 .7z，这样「解压不删包」后游戏库同时显示两份（可玩的 + 归档的）。
        if !delete_archive {
            let clone_id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO games (id, name, install_dir, exe_path, launch_args, env_vars, work_dir,
                    cover_path, banner_path, bg_path, notes, tags, favorite, hidden,
                    total_seconds, play_count, created_at, updated_at, sort_order, steam_appid,
                    rtss_profile_name, monitor_process, archive_status, archive_path, archive_size, archive_original_size)
                 SELECT ?1, name, install_dir, exe_path, launch_args, env_vars, work_dir,
                    cover_path, banner_path, bg_path, notes, tags, favorite, hidden,
                    0, 0, datetime('now'), datetime('now'), 0, steam_appid,
                    rtss_profile_name, monitor_process, archive_status, archive_path, archive_size, archive_original_size
                 FROM games WHERE id = ?2",
                params![clone_id, id],
            )?;
        }
        conn.execute(
            "UPDATE games SET install_dir=?1, exe_path=?2, work_dir=?3, archive_status='', archive_path='', archive_size=0, archive_original_size=0, updated_at=datetime('now') WHERE id=?4",
            params![new_install, new_exe, new_work, id],
        )?;
    }
    let mut archive_deleted = false;
    let mut warning = None;
    if delete_archive {
        match fs::remove_file(&archive) {
            Ok(()) => archive_deleted = true,
            Err(e) => warning = Some(format!("游戏已解压恢复，但删除压缩包失败：{e}")),
        }
    }
    emit(app, id, "extracting", 100.0);
    Ok(RestoreResult {
        install_dir: new_install,
        archive_deleted,
        warning,
    })
}
#[cfg(not(windows))]
fn restore(_: &AppHandle, _: &AppState, _: &str, _: &str, _: bool) -> AppResult<RestoreResult> {
    Err(fail("解压恢复只支持 Windows"))
}
#[cfg(not(windows))]
fn run(_: &AppHandle, _: &AppState, _: &str, _: &str, _: i32) -> AppResult<ArchiveResult> {
    Err(fail("安全归档只支持 Windows 本地 NTFS"))
}

#[tauri::command]
pub async fn import_archive(
    app: AppHandle,
    state: State<'_, AppState>,
    archive_path: String,
) -> AppResult<String> {
    let guard = OperationGuard::acquire(&state.archive_gate)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let state = app.state::<AppState>();
        import(&app, &state, &archive_path)
    })
    .await
    .map_err(|e| fail(e.to_string()))?
}
// 导入已有的游戏压缩包为「已归档」游戏：读清单取唯一顶层文件夹名作为 install_dir（供日后解压定位），
// 累加未压缩总大小，并挑一个最浅的 .exe 猜作启动程序（解压后按 install_dir→新目录 rebase 命中）。
#[cfg(windows)]
fn import(app: &AppHandle, state: &AppState, archive_path: &str) -> AppResult<String> {
    let path = PathBuf::from(archive_path);
    let meta = fs::symlink_metadata(&path).map_err(|e| fail(format!("找不到压缩包：{e}")))?;
    if !meta.is_file() {
        return Err(fail("请选择一个压缩包文件"));
    }
    let archive_size = meta.len();
    let p = path.to_str().ok_or_else(|| fail("压缩包路径不是 Unicode"))?.to_owned();
    let cwd = path.parent().ok_or_else(|| fail("压缩包路径无效"))?;
    let tool = resolve_7za(app)?;
    let cancel = AtomicBool::new(false);
    let exiting = AtomicBool::new(false);
    let (listing, _, _) = command(
        &tool,
        &strings(&["l", "-slt", "-ba", "-sccUTF-8", "--", &p]),
        cwd,
        &cancel,
        &exiting,
        false,
    )?;
    let listing = parse_listing(&listing)?;
    if listing.is_empty() {
        return Err(fail("压缩包是空的"));
    }
    let mut top: Option<String> = None;
    let mut original: u64 = 0;
    let mut exe: Option<String> = None;
    let depth = |s: &str| s.bytes().filter(|b| *b == b'/').count();
    for (key, (is_dir, size)) in listing.iter() {
        let comp = key.split('/').next().unwrap_or("");
        match &top {
            None => top = Some(comp.to_owned()),
            Some(t) if t == comp => {}
            Some(_) => return Err(fail("压缩包不是单个游戏文件夹，无法作为游戏导入")),
        }
        if *is_dir {
            continue;
        }
        original = original.saturating_add(*size);
        if key.to_ascii_lowercase().ends_with(".exe") {
            let better = match &exe {
                None => true,
                Some(cur) => (depth(key), key.as_str()) < (depth(cur), cur.as_str()),
            };
            if better {
                exe = Some(key.clone());
            }
        }
    }
    let folder = top.ok_or_else(|| fail("压缩包结构异常"))?;
    safe_name(&folder)?;
    let exe_path = exe.map(|k| k.replace('/', "\\")).unwrap_or_default();
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("导入的游戏")
        .to_owned();
    let id = uuid::Uuid::new_v4().to_string();
    let display = display_path(&path);
    {
        let conn = state.db.lock();
        conn.execute(
            "INSERT INTO games (id, name, install_dir, exe_path, archive_status, archive_path, archive_size, archive_original_size)
             VALUES (?1, ?2, ?3, ?4, 'archived', ?5, ?6, ?7)",
            params![id, name, folder, exe_path, display, archive_size, original],
        )?;
        // 名称若对上已删除游戏留下的历史统计，并入本游戏（之后解压恢复可继续累计）
        crate::games::absorb_orphan_stats(&conn, &id, &name);
    }
    Ok(id)
}
#[cfg(not(windows))]
fn import(_: &AppHandle, _: &AppState, _: &str) -> AppResult<String> {
    Err(fail("导入压缩包只支持 Windows"))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    fn temp() -> PathBuf {
        let p = std::env::temp_dir().join(format!("zex-archive-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&p).unwrap();
        p
    }
    #[test]
    fn listing_rejects_duplicates_and_unsafe_paths() {
        assert!(parse_listing(b"Path = ../x\nFolder = -\nSize = 0\n").is_err());
        assert!(parse_listing(
            b"Path = x\nFolder = -\nSize = 0\n\nPath = x\nFolder = -\nSize = 0\n"
        )
        .is_err());
        assert!(safe_name("x\nPath = y").is_err());
        assert!(entry_key("game/a[1].exe").is_ok());
    }
    #[test]
    fn listing_reads_compound_attributes() {
        // 附加属性（不索引/隐藏/只读）不能影响 目录/文件 判定
        let listing = b"Path = g\nAttributes = DI\nSize = 0\n\nPath = g/a\nAttributes = AI\nSize = 7\n\nPath = g/c\nAttributes = RAI\nSize = 5\n";
        let l = parse_listing(listing).unwrap();
        assert_eq!(l.get("g"), Some(&(true, 0)));
        assert_eq!(l.get("g/a"), Some(&(false, 7)));
        assert_eq!(l.get("g/c"), Some(&(false, 5)));
    }
    #[test]
    fn migration_and_pending_preserve_stats() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE games(id TEXT PRIMARY KEY, total_seconds INTEGER, play_count INTEGER, install_dir TEXT); INSERT INTO games VALUES('g',12345,9,'original'); CREATE TABLE sessions(game_id TEXT,seconds INTEGER); INSERT INTO sessions VALUES('g',12345);").unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        mark_pending(&conn, "g", "a.7z", 10, 100).unwrap();
        let row: (i64, i64, String, String) = conn
            .query_row(
                "SELECT total_seconds,play_count,install_dir,archive_status FROM games",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(row, (12345, 9, "original".into(), "cleanup_pending".into()));
        assert_eq!(
            conn.query_row("SELECT seconds FROM sessions", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            12345
        );
        migrate(&conn).unwrap();
        assert_eq!(
            conn.query_row("SELECT archive_status FROM games", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "cleanup_pending"
        );
    }
    #[test]
    fn source_locks_and_safe_cleanup() {
        let p = temp();
        let root = p.join("game");
        fs::create_dir(&root).unwrap();
        let f = root.join("a");
        fs::write(&f, b"unchanged").unwrap();
        let c = AtomicBool::new(false);
        let mut m = Manifest::build(&root, &c, &c, None).unwrap();
        assert!(fs::write(&f, b"changed").is_err());
        assert!(fs::remove_file(&f).is_err());
        assert!(fs::rename(&root, p.join("other")).is_err());
        fs::write(root.join("new"), b"new").unwrap();
        assert!(m.clean().is_err());
        assert!(f.exists());
        fs::remove_file(root.join("new")).unwrap();
        m.clean().unwrap();
        assert!(!root.exists());
        drop(m);
        fs::remove_dir(p).unwrap();
    }
    #[test]
    fn refuses_ads_and_hardlinks() {
        let p = temp();
        let f = p.join("a");
        fs::write(&f, b"a").unwrap();
        fs::write(format!("{}:secret", f.display()), b"hidden").unwrap();
        assert!(win::open(&f, true, false).is_err());
        fs::remove_file(&f).unwrap();
        fs::write(&f, b"a").unwrap();
        let link = p.join("b");
        fs::hard_link(&f, &link).unwrap();
        assert!(win::open(&f, true, false).is_err());
        fs::remove_file(link).unwrap();
        fs::remove_file(f).unwrap();
        fs::remove_dir(p).unwrap();
    }
    #[test]
    fn allows_zone_marker_but_not_other_streams() {
        let p = temp();
        let f = p.join("a");
        fs::write(&f, b"a").unwrap();
        // Windows 下载标记（浏览器/解压器写）：放行，压缩包不保留该流
        fs::write(format!("{}:Zone.Identifier", f.display()), b"[ZoneTransfer]").unwrap();
        assert!(win::open(&f, true, false).is_ok());
        // 其它命名流仍拒绝（隐藏数据不随压缩包保留，删源即丢）
        fs::write(format!("{}:secret", f.display()), b"hidden").unwrap();
        assert!(win::open(&f, true, false).is_err());
        fs::remove_file(&f).unwrap();
        fs::remove_dir(p).unwrap();
    }
    #[test]
    fn real_7za_roundtrip_locked_source() {
        let tool = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("7zip/7za.exe");
        assert!(tool.exists(), "需要随附7za真实测试");
        let p = temp();
        let root = p.join("中文 game");
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("empty")).unwrap();
        fs::write(root.join("a[1].exe"), b"test bytes\0\xff").unwrap();
        fs::write(root.join("zero"), b"").unwrap();
        let c = AtomicBool::new(false);
        let mut m = Manifest::build(&root, &c, &c, None).unwrap();
        // 直接压缩被只读句柄锁住的源目录（验证 7za 能读 ZEX 持锁的源，无需暂存拷贝）。
        let output = p.join("a.7z");
        command(
            &tool,
            &strings(&[
                "a",
                "-t7z",
                "-ms=off",
                "-bd",
                "--",
                output.to_str().unwrap(),
                &m.entries[0].relative,
            ]),
            &p,
            &c,
            &c,
            false,
        )
        .unwrap();
        let verified = verify(&tool, &output, &m, &c, &c).unwrap();
        let locked = win::writable_archive(&output).unwrap();
        assert!(win::same(&verified.0, &win::info(&locked).unwrap()));
        let final_path = p.join("final.7z");
        win::rename(&locked, &final_path).unwrap();
        locked.sync_all().unwrap();
        assert!(fs::write(&final_path, b"bad").is_err());
        m.clean().unwrap();
        assert!(!root.exists());
        drop(locked);
        drop(m);
        fs::remove_file(final_path).unwrap();
        fs::remove_dir(p).unwrap();
    }
}
