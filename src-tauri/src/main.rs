// Prevents console window on Windows in ALL builds (not just release).
// Debug 构建也要无窗：自启用 debug 二进制测试时同样不弹 cmd（登录自启无父终端，
// 控制台子系统会被 Windows 单独开一个窗口）。日志走 data/zex-debug.log，
// 控制台本来只留给 panic/eprintln，去除无实际损失
#![windows_subsystem = "windows"]

fn main() {
    zex_lib::run()
}
