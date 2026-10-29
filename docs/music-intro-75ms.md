# 音乐库入场：75ms

2026-10-29，Asia/Shanghai。

[已核实] 单项入场动画从 150ms 缩短为 75ms；单列逐项延迟 15→7.5ms，多列 6→3ms；首屏结束计时余量 210→105ms，整体再快一倍。E1：[MusicView 入场计时](../src/views/MusicView.tsx)，E2：[`.music-row-enter` 样式](../src/index.css)。

[已核实] 使用真实 MusicView、模拟曲目与 Tauri IPC，浏览器实测单列和多列均为 0.075s。单列前四项延迟 0/7.5/15/22.5ms，多列 0/3/6/9ms；页面脚本错误为 0。E3：[测量记录](verification/music-intro-75ms-measurement.json)。

覆盖：单列时长和延迟、多列时长和延迟、首屏结束计时。原生 WebView2 中的逐项视觉检查未执行。

[已核实] `npx tauri build --no-bundle` 成功，完整 ZIP 已生成并签名，状态 `Valid`。E4：[构建日志](verification/music-intro-75ms-build.txt)、[打包日志](verification/music-intro-75ms-package.txt)。

[已核实] 13:44 已替换 F 盘 EXE 并重启，旧版备份为 `F:\ZEX-0.1.0\ZEX.exe.bak-20261029-134454`。ZIP 内、构建目录、F 盘 EXE 哈希一致；替换前后、重启前的 1,940 个用户数据文件差异为 0。E5：[部署记录](verification/music-intro-75ms-deployment.json)。
