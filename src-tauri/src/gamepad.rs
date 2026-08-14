// ─────────────────────────────────────────────
// 手柄输入（gilrs XInput + hidapi DualSense 双通道）
// ─────────────────────────────────────────────
// 浏览器 Gamepad API 在 WebView 窗口隐藏（收托盘/播放）后按键数据会冻结，
// 无法用前端解决。这里在后端常驻线程轮询手柄，把按键映射为导航动作
// emit 给前端 —— 后端线程不受窗口隐藏影响，播放中/退出后照常工作。
//
// 两条输入通道，收敛到同一套 "gamepad-event" 字符串，前端零感知：
//   XInput（gilrs）     —— Xbox 系手柄，最可靠
//   DualSense（hidapi） —— PS5 手柄（含 Edge），XInput 不认，直读 USB 有线报文
// 各自独立线程 + 共享 PadCounts 汇报连接数（gamepad-status payload = {xbox, ps}）。
//
// 分工：ZEX 前台（nav_enabled=true）→ 事件驱动前端焦点导航；
//       播放中（nav_enabled=false，ZEX 收托盘）→ 不推导航事件，
//       mpv 内建 --input-gamepad 接管播放中的手柄控制，两端不冲突。
//
// 事件（前端 listen "gamepad-event"，payload 是 &str）：
//   "dir:up"/"dir:down"/"dir:left"/"dir:right"  方向按下（前端做长按连发）
//   "dir-clear"                                  方向全部释放（停连发）
//   "confirm" (A/✕) / "back" (B/○) / "alt" (X/□)
//   "bumper:left"/"bumper:right"                 LB/RB 或 L1/R1 肩键（前端切库）
// logo 键（Xbox 西瓜键 / PS 键）不 emit 事件，直接回调 lib.rs 的唤起判定
//   （各自独立开关 + 影视播放让位 + 前台可见性检查），与导航事件通道分离。
// 连接状态（前端 listen "gamepad-status"，payload 是 { xbox, ps } 各品牌已连接数）：

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use gilrs::{Axis, Button, Event, EventType, Gilrs};
use hidapi::{HidApi, HidDevice, HidError};
use tauri::{AppHandle, Emitter};

const AXIS_DEADZONE: f32 = 0.5;   // 左摇杆视为按下的阈值（导航用，避免误触）
/// 右摇杆 Y 轴滚动：进入死区 0.05（轻推即滚）；激活后退出死区放宽到 0.03
/// （滞回，幅度在 0.03~0.05 间抖动不反复启停）。幅度 0..1 线性映射、0.02 量化节流
const RSTICK_DEADZONE: f32 = 0.05;
const RSTICK_DEAD_OUT: f32 = 0.03;
const RSTICK_QUANT: f32 = 0.02;
const POLL_MS: u64 = 8;            // 非阻塞轮询间隔（约 125Hz）
// 西瓜键单独一个常量：它只判「按下→唤起窗口」，不参与摇杆导航，不需要 8ms 的
// 响应精度。暂与 POLL_MS 同值（本次只改「关闭时不轮询」），要降频改这里即可
const GUIDE_POLL_MS: u64 = 8;

/// 当前任一方向（D-pad + 左摇杆合并）是否按住
#[derive(Default)]
struct DirState {
    up: bool,
    down: bool,
    left: bool,
    right: bool,
    /// 最近一次发送的右摇杆幅度（-1..1，正=下；量化节流用）
    rstick_s: f32,
}

impl DirState {
    fn any(&self) -> bool {
        self.up || self.down || self.left || self.right
    }
}

fn emit_dir(app: &AppHandle, name: &str) {
    let _ = app.emit("gamepad-event", name);
}

/// 右摇杆幅度 → 事件串：死区外线性映射 0..1（正=下）、0.02 量化、滞回防抖。
/// 方向/量化变化才 emit：幅度直传，前端做速度曲线 + 指数平滑（无阶跃启停）
fn rstick_event(app: &AppHandle, last_s: &mut f32, v: f32) {
    let mag = v.abs();
    // 滞回：已激活时退出阈值放宽到 0.03 —— 幅度在 0.03~0.05 间抖动不会反复启停
    let active = *last_s != 0.0;
    let threshold = if active { RSTICK_DEAD_OUT } else { RSTICK_DEADZONE };
    if mag <= threshold {
        if active {
            *last_s = 0.0;
            let _ = app.emit("gamepad-event", "rscroll:0");
        }
        return;
    }
    if mag <= RSTICK_DEADZONE {
        return; // 滞回区：保持上次幅度不重算（避免符号翻转/归零抖动）
    }
    // 死区外：线性映射 0..1（保持符号，正=下）
    let s = v.signum() * (mag - RSTICK_DEADZONE) / (1.0 - RSTICK_DEADZONE);
    if (*last_s - s).abs() >= RSTICK_QUANT {
        *last_s = s;
        let _ = app.emit("gamepad-event", &format!("rscroll:{}", s));
    }
}

fn emit_clear_if_idle(app: &AppHandle, state: &DirState) {
    if !state.any() {
        let _ = app.emit("gamepad-event", "dir-clear");
    }
}

/// 双通道共享的连接计数：xbox/ps 各自线程更新自己字段，任一变化时 emit 完整快照
#[derive(Default)]
pub struct PadCounts {
    pub xbox: usize,
    pub ps: usize,
}

fn emit_pad_status(app: &AppHandle, counts: &Mutex<PadCounts>) {
    let c = counts.lock().unwrap();
    let _ = app.emit("gamepad-status", serde_json::json!({ "xbox": c.xbox, "ps": c.ps }));
}

/// 启动 gilrs 事件线程（Xbox）。nav_enabled 由 lib.rs 控制：收托盘 = false（不推导航），
/// 窗口唤回 = true。播放中（收托盘）mpv 内建 --input-gamepad 接管播放中的手柄，
/// 这里只在前台推导航事件。线程随进程退出终止。
pub fn spawn(app: AppHandle, nav_enabled: Arc<AtomicBool>, counts: Arc<Mutex<PadCounts>>) {
    std::thread::spawn(move || {
        let mut gilrs = match Gilrs::new() {
            Ok(g) => g,
            Err(e) => {
                log::warn!("手柄初始化失败（无手柄或缺少驱动）: {}", e);
                return;
            }
        };
        {
            let mut c = counts.lock().unwrap();
            c.xbox = gilrs.gamepads().count();
        }
        emit_pad_status(&app, &counts);
        let mut dir = DirState::default();

        loop {
            while let Some(Event { event, .. }) = gilrs.next_event() {
                match event {
                    EventType::Connected => {
                        log::info!("手柄已连接，当前 {}", gilrs.gamepads().count());
                        let mut c = counts.lock().unwrap();
                        c.xbox = gilrs.gamepads().count();
                        drop(c);
                        emit_pad_status(&app, &counts);
                    }
                    EventType::Disconnected => {
                        log::info!("手柄已断开，当前 {}", gilrs.gamepads().count());
                        dir = DirState::default();
                        // 收口持续动作：D-pad 连发要 dir-clear、右摇杆幅度要 rscroll:0，
                        // 否则断开后接收端拿不到任何事件会一直滚
                        if nav_enabled.load(Ordering::Relaxed) {
                            let _ = app.emit("gamepad-event", "dir-clear");
                            let _ = app.emit("gamepad-event", "rscroll:0");
                        }
                        let mut c = counts.lock().unwrap();
                        c.xbox = gilrs.gamepads().count();
                        drop(c);
                        emit_pad_status(&app, &counts);
                    }
                    EventType::ButtonPressed(button, _) => {
                        if !nav_enabled.load(Ordering::Relaxed) {
                            continue; // 播放中/收托盘：mpv 内建手柄接管，不推导航
                        }
                        match button {
                            Button::South => { let _ = app.emit("gamepad-event", "confirm"); }
                            Button::East => { let _ = app.emit("gamepad-event", "back"); }
                            Button::West => { let _ = app.emit("gamepad-event", "alt"); }
                            // 肩键（XInput LB/RB，gilrs 命名里是 Trigger）：切库
                            Button::LeftTrigger => { let _ = app.emit("gamepad-event", "bumper:left"); }
                            Button::RightTrigger => { let _ = app.emit("gamepad-event", "bumper:right"); }
                            Button::DPadUp => { dir.up = true; emit_dir(&app, "dir:up"); }
                            Button::DPadDown => { dir.down = true; emit_dir(&app, "dir:down"); }
                            Button::DPadLeft => { dir.left = true; emit_dir(&app, "dir:left"); }
                            Button::DPadRight => { dir.right = true; emit_dir(&app, "dir:right"); }
                            _ => {}
                        }
                    }
                    EventType::ButtonReleased(button, _) => {
                        if !nav_enabled.load(Ordering::Relaxed) {
                            continue;
                        }
                        match button {
                            Button::DPadUp => { dir.up = false; emit_clear_if_idle(&app, &dir); }
                            Button::DPadDown => { dir.down = false; emit_clear_if_idle(&app, &dir); }
                            Button::DPadLeft => { dir.left = false; emit_clear_if_idle(&app, &dir); }
                            Button::DPadRight => { dir.right = false; emit_clear_if_idle(&app, &dir); }
                            _ => {}
                        }
                    }
                    EventType::AxisChanged(axis, value, _) => {
                        // 播放中（ZEX 收托盘）：mpv 内建 --input-gamepad 接管播放中的手柄，
                        // 这里不推任何导航事件
                        if !nav_enabled.load(Ordering::Relaxed) {
                            continue;
                        }
                        // 左摇杆：X 轴=左/右，Y 轴=上/下；状态翻转时才 emit
                        let mut changed = false;
                        match axis {
                            Axis::LeftStickX => {
                                let l = value < -AXIS_DEADZONE;
                                let r = value > AXIS_DEADZONE;
                                if l && !dir.left { dir.left = true; emit_dir(&app, "dir:left"); changed = true; }
                                else if !l && dir.left { dir.left = false; changed = true; }
                                if r && !dir.right { dir.right = true; emit_dir(&app, "dir:right"); changed = true; }
                                else if !r && dir.right { dir.right = false; changed = true; }
                            }
                            Axis::LeftStickY => {
                                // 实测 XInput 上推摇杆 value 为正 → 判定为「上」，与 D-pad 方向一致
                                let u = value > AXIS_DEADZONE;
                                let d = value < -AXIS_DEADZONE;
                                if u && !dir.up { dir.up = true; emit_dir(&app, "dir:up"); changed = true; }
                                else if !u && dir.up { dir.up = false; changed = true; }
                                if d && !dir.down { dir.down = true; emit_dir(&app, "dir:down"); changed = true; }
                                else if !d && dir.down { dir.down = false; changed = true; }
                            }
                            Axis::RightStickY => {
                                // 右摇杆上下滚动（详情页/音乐库列表）：幅度直传（rscroll:<s>，
                                // 正=下，0=回中），前端做速度映射曲线 + 指数平滑 → 轻推慢滚、
                                // 推满快滚、起停无阶跃。量化变化才 emit（节流）
                                // XInput 上推 value 为正 → 取反成「正=下」（与 PS 分支同约定）
                                rstick_event(&app, &mut dir.rstick_s, -value);
                            }
                            _ => {}
                        }
                        if changed {
                            emit_clear_if_idle(&app, &dir);
                        }
                    }
                    _ => {}
                }
            }
            gilrs.inc(); // 推进 gilrs 内部状态
            std::thread::sleep(Duration::from_millis(POLL_MS));
        }
    });
}

// ─────────────────────────────────────────────
// PS 手柄（DualSense / DualSense Edge）输入 —— hidapi 补充通道
// ─────────────────────────────────────────────
// gilrs 的 xinput 后端不认 PS 手柄（DualSense 走 HID 协议），这里用 hidapi 在
// 独立线程枚举 Sony DualSense 并解析 USB 有线报文，emit 与 XInput 分支完全相同
// 的事件串，前端零感知。只做 USB 有线：蓝牙协议字节布局不同且需 0x31 解锁，明确不做。

const SONY_VID: u16 = 0x054C;
// DualSense 家族 USB PID：Edge 0x0DF2 / 标准 0x0CE6
const DUAL_SENSE_PIDS: &[u16] = &[0x0DF2, 0x0CE6];
// 无手柄时枚举间隔（hidapi 需要 refresh_devices 才能看到新插设备，慢扫省开销）
const SCAN_INTERVAL: Duration = Duration::from_millis(500);

/// DualSense 左摇杆（0x00–0xFF，中心 0x80）；Y 轴上推=小值，与 XInput 相反
const PS_AXIS_DEADZONE: f32 = 0.5;

/// PS 通道当前方向（D-pad hat + 左摇杆合并）
#[derive(Default)]
struct PsDir {
    up: bool,
    down: bool,
    left: bool,
    right: bool,
    /// 最近一次发送的右摇杆幅度（-1..1，正=下；量化节流用，同 XInput）
    rstick_s: f32,
}

impl PsDir {
    fn any(&self) -> bool {
        self.up || self.down || self.left || self.right
    }
}

/// 一把已连接的 DualSense 的解析状态
struct PsPad {
    dev: HidDevice,
    /// 上一帧按钮字节（report byte8/9），边沿检测用
    prev_btns: [u8; 2],
    dir: PsDir,
    /// 上一帧 PS logo 键状态（byte10 bit0），边沿检测用
    prev_ps: bool,
}

/// 枚举 Sony DualSense USB 手柄并打开主控制器接口。
/// DS5 有多个 HID collection（音频/触摸板等），主输入报告 usage_page=0x01 usage=0x05。
fn open_ps_pad(api: &HidApi) -> Result<Option<HidDevice>, HidError> {
    for info in api.device_list() {
        if info.vendor_id() != SONY_VID {
            continue;
        }
        if !DUAL_SENSE_PIDS.contains(&info.product_id()) {
            continue;
        }
        if info.usage_page() != 0x01 || info.usage() != 0x05 {
            continue;
        }
        let name = info.product_string().map(|s| format!(" ({s})")).unwrap_or_default();
        log::info!("发现 DualSense（PID 0x{:04X}）{}", info.product_id(), name);
        if let Ok(dev) = info.open_device(api) {
            return Ok(Some(dev));
        }
        log::warn!("DualSense 打开失败（可能被其它程序独占，稍后重试）");
    }
    Ok(None)
}

/// 更新单个方向位：变化时 emit；全部释放时补 dir-clear（停前端连发）
fn ps_set_dir(app: &AppHandle, dir: &mut PsDir, event: &str, want: bool) {
    let slot = match event {
        "dir:up" => &mut dir.up,
        "dir:down" => &mut dir.down,
        "dir:left" => &mut dir.left,
        _ => &mut dir.right,
    };
    if *slot == want {
        return;
    }
    *slot = want;
    if want {
        let _ = app.emit("gamepad-event", event);
    } else if !dir.any() {
        let _ = app.emit("gamepad-event", "dir-clear");
    }
}

/// 解析一帧 DualSense USB 报文并 emit 边沿事件。nav=false（收托盘/播放中）不推导航，
/// 播放中的手柄交给 mpv 内建 --input-gamepad。
/// 布局（nondebug/dualsense 权威，USB 有线 0x01 报告，与实测 dump 完全吻合）：
///   byte1-4  左/右摇杆（中心 0x80，Y 上推=0x00）
///   byte5/6  L2/R2 扳机模拟值（本轮不加功能，忽略）
///   byte7    帧计数
///   byte8    bit0-3=D-pad hat（neutral=8, N=0, E=2, S=4, W=6）· bit4=□ bit5=✕ bit6=○ bit7=△
///   byte9    bit0=L1 bit1=R1 bit2=L2 bit3=R2 bit4=Create bit5=Options bit6=L3 bit7=R3
///   byte10   bit0=PS（logo 键，唤起主窗口）bit1=触摸板 bit2=静音（本轮不映射）
fn handle_ps_report(app: &AppHandle, pad: &mut PsPad, nav: bool, buf: &[u8], on_guide: &GuideCallback) {
    let b8 = buf.get(8).copied().unwrap_or(0);
    let b9 = buf.get(9).copied().unwrap_or(0);
    let b10 = buf.get(10).copied().unwrap_or(0);
    let prev = pad.prev_btns;
    pad.prev_btns = [b8, b9];

    // PS logo 键（byte10 bit0）→ 唤起主窗口，语义同 Xbox 西瓜键。
    // 放在 nav 判断之前：播放中/收托盘（nav=false）也必须能唤起；
    // on_guide 回调内部已有影视播放让位 mpv、前台可见性等判定
    let ps = b10 & 0x01 != 0;
    if ps && !pad.prev_ps {
        (on_guide)(app);
    }
    pad.prev_ps = ps;

    if !nav {
        return; // 播放中：mpv 接管，不推导航事件
    }

    // 动作键（byte8 bit4-7 = □✕○△，边沿触发）
    let square = b8 & 0x10 != 0;
    let cross = b8 & 0x20 != 0;
    let circle = b8 & 0x40 != 0;
    if cross && !(prev[0] & 0x20 != 0) {
        let _ = app.emit("gamepad-event", "confirm");
    }
    if circle && !(prev[0] & 0x40 != 0) {
        let _ = app.emit("gamepad-event", "back");
    }
    if square && !(prev[0] & 0x10 != 0) {
        let _ = app.emit("gamepad-event", "alt");
    }

    // 肩键（byte9 bit0=L1 bit1=R1）→ 切库
    let l1 = b9 & 0x01 != 0;
    let r1 = b9 & 0x02 != 0;
    if l1 && !(prev[1] & 0x01 != 0) {
        let _ = app.emit("gamepad-event", "bumper:left");
    }
    if r1 && !(prev[1] & 0x02 != 0) {
        let _ = app.emit("gamepad-event", "bumper:right");
    }

    // 方向：D-pad hat（byte8 bit0-3，neutral=8）+ 左摇杆（byte1/2）合并
    let hat = b8 & 0x0F;
    let lx = buf.get(1).copied().unwrap_or(0x80) as f32;
    let ly = buf.get(2).copied().unwrap_or(0x80) as f32;
    // 摇杆归一化：中心 0x80；Y 上推=0x00（与 XInput 相反）→ ny 正 = 上
    let nx = (lx - 128.0) / 128.0;
    let ny = (128.0 - ly) / 128.0;

    let want_up = (hat == 0 || hat == 1 || hat == 7) || ny > PS_AXIS_DEADZONE;
    let want_down = (hat == 4 || hat == 3 || hat == 5) || ny < -PS_AXIS_DEADZONE;
    let want_left = (hat == 6 || hat == 7 || hat == 5) || nx < -PS_AXIS_DEADZONE;
    let want_right = (hat == 2 || hat == 1 || hat == 3) || nx > PS_AXIS_DEADZONE;
    ps_set_dir(app, &mut pad.dir, "dir:up", want_up);
    ps_set_dir(app, &mut pad.dir, "dir:down", want_down);
    ps_set_dir(app, &mut pad.dir, "dir:left", want_left);
    ps_set_dir(app, &mut pad.dir, "dir:right", want_right);

    // 右摇杆（byte3=X / byte4=Y，Y 上推=0x00）→ 上下滚动，幅度直传同 XInput
    // （nry 符号约定与 XInput 相反：PS 上推=正，这里取反为 正=下）
    let ry = buf.get(4).copied().unwrap_or(0x80) as f32;
    let nry = (128.0 - ry) / 128.0;
    rstick_event(app, &mut pad.dir.rstick_s, -nry);
}

/// 启动 DualSense 轮询线程。枚举 → 连接 → 8ms 读报文 → 统一 emit；
/// 断开自动收口方向并重扫。nav_enabled / counts 与 XInput 线程共享。
/// on_guide：PS logo 键唤起回调（lib.rs 注入判定逻辑，同西瓜键）
pub fn spawn_ps(app: AppHandle, nav_enabled: Arc<AtomicBool>, counts: Arc<Mutex<PadCounts>>, on_guide: GuideCallback) {
    std::thread::spawn(move || {
        let mut api = match HidApi::new() {
            Ok(a) => a,
            Err(e) => {
                log::warn!("PS 手柄通道初始化失败（无手柄或缺少驱动）: {}", e);
                return;
            }
        };
        let mut pad: Option<PsPad> = None;
        let mut last_scan = Instant::now();

        loop {
            if pad.is_none() {
                // 无手柄时慢扫（hidapi 枚举要 refresh 才看得到新设备），避免每 8ms 全量枚举
                if last_scan.elapsed() >= SCAN_INTERVAL {
                    last_scan = Instant::now();
                    let _ = api.refresh_devices();
                    match open_ps_pad(&api) {
                        Ok(Some(dev)) => {
                            pad = Some(PsPad { dev, prev_btns: [0; 2], dir: PsDir::default(), prev_ps: false });
                            counts.lock().unwrap().ps = 1;
                            emit_pad_status(&app, &counts);
                            log::info!("PS 手柄已连接");
                        }
                        Ok(None) => {}
                        Err(_) => {}
                    }
                }
                std::thread::sleep(Duration::from_millis(POLL_MS));
                continue;
            }

            let nav = nav_enabled.load(Ordering::Relaxed);
            let mut disconnected = false;
            if let Some(p) = pad.as_mut() {
                // buf 取 256：DualSense USB 报告 64 字节，Edge 可能更长，宁大勿溢
                let mut buf = [0u8; 256];
                match p.dev.read_timeout(&mut buf, POLL_MS as i32) {
                    Ok(0) => {} // 超时，无新数据
                    Ok(n) if n > 0 => {
                        handle_ps_report(&app, p, nav, &buf[..n], &on_guide);
                    }
                    Ok(_) => {}
                    Err(_) => {
                        // 断开：收口持续方向与右摇杆幅度（否则前端连发/滚动停不下来）+ 汇报
                        if nav && p.dir.any() {
                            let _ = app.emit("gamepad-event", "dir-clear");
                            let _ = app.emit("gamepad-event", "rscroll:0");
                        }
                        log::info!("PS 手柄已断开");
                        disconnected = true;
                    }
                }
            }
            if disconnected {
                pad = None;
                counts.lock().unwrap().ps = 0;
                emit_pad_status(&app, &counts);
            }
        }
    });
}

// ─────────────────────────────────────────────
// Xbox 西瓜键（Guide）—— RAW Input 广播通道
// ─────────────────────────────────────────────
// Xbox 西瓜键（Guide）—— XInput wButtons 位轮询
// ─────────────────────────────────────────────
// 结论（实测 Elite 2）：rawinput 报文里按钮区恒 0（Xbox Wireless 下按钮走 XInput），
// rawinput 读不到 Guide。SDL/mpv 能读到 GAMEPAD_MENU 是因为它们走 XInput：
// XInput 1.4 的 wButtons 含 Guide 位（0x0400，微软官方 XINPUT_GAMEPAD_GUIDE）。
// 这里直接轮询 XInputGetState 的 wButtons & 0x0400，只读不抢连接（与 gilrs 共享）。

/// 西瓜键回调参数：唤起主窗口（lib.rs 注入判定逻辑）
pub type GuideCallback = Box<dyn Fn(&AppHandle) + Send + Sync>;

/// 开关门闩：功能关闭时让轮询线程真正阻塞，而不是空转。
///
/// 西瓜键默认是关的（guide_button_enabled 默认 false），而 XInput 轮询线程原先
/// 无论开关状态都以 125Hz 常驻空转 —— 每秒 500 次 XInputGetStateEx，采到的数据
/// 在 on_guide_pressed 开头就被开关判断丢弃。笔记本上纯属费电发热。
/// 现在关闭时线程 wait 在 Condvar 上，CPU 占用真正为零；set 打开时唤醒
pub struct EnableGate {
    on: Mutex<bool>,
    cv: Condvar,
}

impl EnableGate {
    pub fn new(on: bool) -> Self {
        Self { on: Mutex::new(on), cv: Condvar::new() }
    }

    /// 设置开关；由关变开时唤醒等待中的轮询线程
    pub fn set(&self, on: bool) {
        let mut guard = match self.on.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(), // 持锁线程 panic 过：这里只是个 bool，照常用
        };
        *guard = on;
        drop(guard);
        if on {
            self.cv.notify_all();
        }
    }

    /// 阻塞直到开关打开。已经是开的就立刻返回
    fn wait_until_on(&self) {
        let mut guard = match self.on.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        while !*guard {
            guard = match self.cv.wait(guard) {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
        }
    }

    fn is_on(&self) -> bool {
        match self.on.lock() {
            Ok(g) => *g,
            Err(p) => *p.into_inner(),
        }
    }
}

/// 启动西瓜键 XInput 轮询线程。常驻直到进程退出；按下边沿回调一次。
/// 只轮询 user0（前 4 个玩家槽位，同 gilrs）；不推事件给前端（Guide 不参与导航）
///
/// gate 关闭时线程阻塞在 Condvar 上（零 CPU），不再空转轮询
pub fn spawn_guide_watch(app: AppHandle, gate: Arc<EnableGate>, on_guide: GuideCallback) {
    std::thread::spawn(move || {
        let Ok(handle) = rusty_xinput::XInputHandle::load_default() else {
            log::warn!("西瓜键监听：XInput 加载失败");
            return;
        };
        log::info!("西瓜键监听已启动（XInput wButtons Guide 位）");
        let mut prev_guide = false; // 边沿检测：按住不重复触发
        loop {
            // 开关关闭 → 睡死在这里，直到设置里打开
            gate.wait_until_on();
            let mut guide_down = false;
            for slot in 0..4u32 {
                // XInputGetStateEx：未公开 API（SDL 同款），完整状态含 Guide 位
                // （XInputGetState 的公开 wButtons 不报 Guide，实测 Elite 2 恒 0）
                if let Ok(state) = handle.get_state_ex(slot) {
                    if state.raw.Gamepad.wButtons & rusty_xinput::XINPUT_GAMEPAD_GUIDE != 0 {
                        guide_down = true;
                        break;
                    }
                }
            }
            if guide_down && !prev_guide {
                log::debug!("西瓜键按下（XInput Guide 位）");
                on_guide(&app);
            }
            prev_guide = guide_down;
            // 关掉的瞬间别再睡满一轮，下一圈立刻进 wait
            if !gate.is_on() {
                prev_guide = false; // 重新打开时不把关闭前的按下状态当成新的边沿
                continue;
            }
            std::thread::sleep(Duration::from_millis(GUIDE_POLL_MS));
        }
    });
}
