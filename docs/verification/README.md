# 验证材料

原始诊断 JSON、截图 PNG、`*-baseline-source/` 冻结源码保留在本机，由根目录 `.gitignore` 排除新增文件；已纳入 Git 的历史文件继续受版本管理。Markdown 摘要、主审查报告和 `scripts/` 验证脚本仍可提交。

持久测试输入放在 `scripts/fixtures/`。`stats-library-shape.json` 仅保留统计列表规模（游戏 112、影视 6、音乐 132），不含数据库路径、媒体文件名或逐帧采样；两个统计浏览器脚本直接读取它，无需本机原始数据库审计 JSON。

在仓库根目录安装项目依赖并提供 Playwright、Chrome 后，可执行 `node scripts/stats-image-regression.mjs`、`node scripts/music-first-cover.test.mjs`、`node scripts/music-prerender.test.mjs` 或 `node scripts/library-entry-benchmark.mjs` 重跑当前源码验证。若 Playwright 安装在项目外，设置 `PLAYWRIGHT_MODULE` 为其 `index.mjs` 的文件 URL。具体模式和输出前缀见对应脚本顶部环境变量及主报告。

使用新的输出前缀保存重跑结果，避免覆盖原始诊断。历史对照模式依赖本机保留的冻结源码或显式传入的基线文件；新检出仓库可直接验证当前源码，历史对照需先准备对应基线。
