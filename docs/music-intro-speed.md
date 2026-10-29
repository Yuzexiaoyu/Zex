# 音乐库入场速度翻倍

2026-10-29，Asia/Shanghai。

[已核实] 单行动画 300→150ms；逐项延迟单列 30→15ms、多列 12→6ms；首屏入场结束计时中的余量 420→210ms，整体时间按原来的一半运行。E1：[MusicView 入场计时](../src/views/MusicView.tsx)，E2：[`.music-row-enter` 样式](../src/index.css)。

[已核实] 浏览器使用真实 MusicView、模拟曲目及 Tauri IPC，实测两种布局的动画均为 0.15s；单列前四项延迟 0/15/30/45ms，多列为 0/6/12/18ms，页面脚本错误为 0。E3：[测量记录](verification/music-intro-measurement.json)。

覆盖：单列时长和延迟、多列时长和延迟、首屏结束计时。原生 WebView2 中的逐项视觉检查未执行。

[已核实] `npx tauri build --no-bundle` 成功，新 ZIP 已生成，签名为 `Valid`。E4：[构建日志](verification/music-intro-build.txt)、[打包日志](verification/music-intro-package.txt)。

[已核实] 13:41 已替换 F 盘 EXE 并重启；旧版备份为 `F:\ZEX-0.1.0\ZEX.exe.bak-20261029-134114`。ZIP 内、构建目录、F 盘 EXE 哈希一致；替换前后、重启前的 1,940 个用户数据文件差异为 0。E5：[部署记录](verification/music-intro-deployment.json)。
