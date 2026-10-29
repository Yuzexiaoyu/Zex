// 桌面歌词窗口：无边框透明置顶横条，预建常驻、显隐/锁定切换；
// 锁定 = 鼠标穿透，仅解锁钮热区放行（后端悬停轮询实现）
use parking_lot::Mutex;
use rusqlite::Connection;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
use crate::AppState;

const LYRICS_LABEL: &str = "desktop-lyrics";
const LYRICS_WIDTH: f64 = 880.0;
const LYRICS_HEIGHT: f64 = 132.0;

// 桌面歌词：无边框透明置顶横条，与托盘菜单一样启动时预建常驻、显隐切换。
// focusable(false)：焦点永不落它身上（游戏时不抢输入焦点）；鼠标事件照常可达，
// 悬停工具栏、拖拽区域都能用。锁定时再叠 set_ignore_cursor_events 变纯展示
pub(crate) fn build_desktop_lyrics_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    tauri::WebviewWindowBuilder::new(
        app,
        LYRICS_LABEL,
        tauri::WebviewUrl::App("index.html?view=desktop-lyrics".into()),
    )
    .title("ZEX 桌面歌词")
    .inner_size(LYRICS_WIDTH, LYRICS_HEIGHT)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .visible(false)
    .focused(false)
    .focusable(false)
    .build()
}

fn lyrics_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
}

// 锁定态内存镜像（权威值在 settings.lyrics_locked）：悬停轮询线程据此判断退出
static LYRICS_LOCKED: AtomicBool = AtomicBool::new(false);
// 悬停轮询线程防重入守卫
static LYRICS_HOVER_POLLING: AtomicBool = AtomicBool::new(false);
// 解锁钮热区（物理屏幕坐标 x,y,w,h），前端量好按钮位置上报。
// 锁定后穿透只放行这一小块：光标进热区才临时关穿透（按钮吃住点击），其余区域永远穿透
static LYRICS_UNLOCK_HOTSPOT: Mutex<Option<(i32, i32, i32, i32)>> = Mutex::new(None);

// 前端上报解锁钮热区（锁定态下轮询线程的放行区域）
#[tauri::command]
pub fn set_lyrics_unlock_hotspot(x: i32, y: i32, w: i32, h: i32) {
    *LYRICS_UNLOCK_HOTSPOT.lock() = Some((x, y, w, h));
}

// 应用锁定态 + 广播（歌词窗据此切换工具栏/解锁钮渲染）。
// 锁定时顺带起轮询：穿透态下 webview 收不到任何鼠标事件，「只有解锁钮可点」
// 只能由后端盯光标位置实现；解锁时清热区
fn lyrics_set_lock_state(app: &tauri::AppHandle, locked: bool) {
    LYRICS_LOCKED.store(locked, Ordering::SeqCst);
    if !locked {
        *LYRICS_UNLOCK_HOTSPOT.lock() = None;
    }
    if let Some(w) = app.get_webview_window(LYRICS_LABEL) {
        let _ = w.set_ignore_cursor_events(locked);
    }
    let _ = app.emit("lyrics-lock-changed", locked);
    if locked {
        lyrics_start_hover_poll(app);
    }
}

// 锁定悬停轮询：两个独立信号——「显示」光标进整个窗口就浮出解锁钮（前端靠它
// 才知道该显示，穿透态 webview 收不到鼠标事件）；「放行」只放行解锁钮热区
// （点击只有按钮能吃住，其余区域保持穿透到后面窗口，锁定防误触语义不变）。
// 热区未上报时退回整窗兜底（保证一定有解锁入口）。解锁后线程退出。
// 窗口操作一律 run_on_main_thread 回主线程
fn lyrics_start_hover_poll(app: &tauri::AppHandle) {
    if LYRICS_HOVER_POLLING.swap(true, Ordering::SeqCst) {
        return; // 已有线程在跑
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut revealed = false; // 放行态：光标在解锁钮热区 → 临时关穿透
        let mut shown = false; // 显示态：光标在窗口内 → 前端浮出解锁钮
        loop {
            std::thread::sleep(std::time::Duration::from_millis(120));
            if !LYRICS_LOCKED.load(Ordering::SeqCst) {
                break; // 已解锁
            }
            let Some(w) = app.get_webview_window(LYRICS_LABEL) else { break };
            if !w.is_visible().unwrap_or(false) {
                continue; // 隐藏时不盯（带锁关窗再开仍锁定，线程不退）
            }
            let mut pt = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
            unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut pt) };
            // 显示信号：光标在整个歌词窗内 → 前端浮出解锁钮
            let in_window = match (w.outer_position(), w.outer_size()) {
                (Ok(p), Ok(s)) => {
                    pt.x >= p.x
                        && pt.x < p.x + s.width as i32
                        && pt.y >= p.y
                        && pt.y < p.y + s.height as i32
                }
                _ => false,
            };
            if in_window != shown {
                shown = in_window;
                let _ = app.emit("lyrics-unlock-hover", in_window);
            }
            // 放行信号：只放行解锁钮热区（热区还没上报时整窗兜底，避免没有解锁入口）
            let hotspot = *LYRICS_UNLOCK_HOTSPOT.lock();
            let inside = match hotspot {
                Some((hx, hy, hw, hh)) => {
                    pt.x >= hx && pt.x < hx + hw && pt.y >= hy && pt.y < hy + hh
                }
                None => in_window,
            };
            if inside != revealed {
                revealed = inside;
                let passthrough = !inside; // 进热区 → 关穿透（按钮可点）；离开 → 恢复
                let w2 = w.clone();
                let _ = app.run_on_main_thread(move || {
                    let _ = w2.set_ignore_cursor_events(passthrough);
                });
            }
        }
        LYRICS_HOVER_POLLING.store(false, Ordering::SeqCst);
    });
}

// 显隐唯一入口：播放条「词」按钮、歌词窗自身 X、停止联动全走这里，状态广播给所有窗口。
// 刻意不加 (async)：窗口显隐在 Windows 上要求主线程执行（见 tray_menu_ready 注释）
#[tauri::command]
pub fn set_desktop_lyrics_visible(app: tauri::AppHandle, visible: bool) {
    let state = app.state::<AppState>();
    let Some(window) = app.get_webview_window(LYRICS_LABEL) else { return };
    if visible {
        // 位置：优先记忆值（物理坐标 "x,y"），否则主屏工作区底部居中、离底 56px
        let saved = {
            let conn = state.db.lock();
            lyrics_setting(&conn, "lyrics_pos")
        };
        let mut placed = false;
        if let Some(p) = saved {
            if let Some((xs, ys)) = p.split_once(',') {
                if let (Ok(x), Ok(y)) = (xs.trim().parse::<i32>(), ys.trim().parse::<i32>()) {
                    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
                    placed = true;
                }
            }
        }
        if !placed {
            if let Ok(Some(monitor)) = window.primary_monitor() {
                let area = monitor.work_area();
                let scale = monitor.scale_factor();
                let x = area.position.x as f64
                    + (area.size.width as f64 - LYRICS_WIDTH * scale) / 2.0;
                let y = area.position.y as f64 + area.size.height as f64
                    - LYRICS_HEIGHT * scale
                    - 56.0 * scale;
                let _ = window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
            }
        }
        // 重应用持久化的锁定态（重启/重开后穿透状态不丢），锁定则起悬停解锁轮询
        let locked = {
            let conn = state.db.lock();
            lyrics_setting(&conn, "lyrics_locked").as_deref() == Some("1")
        };
        lyrics_set_lock_state(&app, locked);
        let _ = window.show();
    } else {
        // 隐藏前记忆当前位置（物理坐标），下次原位打开。
        // 只在窗口确实可见时记：隐藏态的 outer_position 可能是 0,0 之类的无意义值，
        // 覆盖掉有效记忆（比如歌词窗挂载自检时对已隐藏的窗口再发一次 hide）
        if window.is_visible().unwrap_or(false) {
            if let Ok(pos) = window.outer_position() {
                let conn = state.db.lock();
                let _ = conn.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES ('lyrics_pos', ?1)",
                    [format!("{},{}", pos.x, pos.y)],
                );
            }
        }
        let _ = window.hide();
    }
    {
        // 可见性也持久化：托盘菜单据此决定要不要露出「锁定桌面歌词」项
        let conn = state.db.lock();
        let _ = conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('lyrics_visible', ?1)",
            [if visible { "1" } else { "0" }],
        );
    }
    let _ = app.emit("lyrics-visibility-changed", visible);
}

// 锁定 = 鼠标穿透（点不到歌词窗，直接落到后面的窗口，防游戏/工作误触）。
// 穿透后窗口自己收不到任何点击，解锁走托盘菜单；播放条「词」按钮随时能关窗兜底
#[tauri::command]
pub fn set_desktop_lyrics_locked(app: tauri::AppHandle, locked: bool) {
    let state = app.state::<AppState>();
    {
        let conn = state.db.lock();
        let _ = conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('lyrics_locked', ?1)",
            [if locked { "1" } else { "0" }],
        );
    }
    lyrics_set_lock_state(&app, locked);
}
