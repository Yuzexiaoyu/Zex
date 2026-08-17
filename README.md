# ZEX

本地游戏库 · 影视库 · 音乐库一站式管理工具（Windows 桌面应用）

## 功能

### 🎮 游戏库
- Steam 库扫描批量导入（自动获取封面与游玩时长）
- 手动添加游戏：启动程序、安装目录、启动参数
- 封面自动获取：Steam CDN 竖版封面，缺失时从 SteamGridDB 兜底
- 游玩时长自动追踪，统计页可手动修正
- 磁盘管理：跨盘移动游戏目录（自动识别目标盘 Steam 库）

### 🎬 影视库
- 文件夹扫描自动识别季 / 集结构，电影 / 剧集两种模式
- TMDB 元数据：海报、简介、评分、剧照
- 剧集连播、观看进度记录、「继续观看」
- 磁盘管理：跨盘移动影视

### 🎵 音乐库
- 文件夹 / 文件导入，标签自动解析
- 内置 mpv 播放引擎（MKV / HEVC / AV1 / DTS / TrueHD 全支持）
- 桌面歌词：LRC 同步滚动，可锁定点击穿透
- 歌单、收藏、拖拽排序

### 📊 统计
- 游戏 / 影视 / 音乐三类时长统计与排行
- 游戏时长右键手动调整

### 🎮 手柄与托盘
- Xbox / PS5 DualSense 手柄全程导航（西瓜键 / PS 键可配置为唤回）
- 最小化到系统托盘后台记录，右键托盘切换库 / 退出
- 开机自启选项

### 🌐 界面语言
- 中文 / English，设置 → 外观 → 语言 随时切换，立即生效

## 🔑 可选 API Key（免费）

部分功能依赖第三方数据源，需免费申请 API Key，在 **设置 → 封面** 中配置。未配置不影响基本使用。

| Key | 用途 | 获取方式 |
|---|---|---|
| **SteamGridDB** | 游戏竖版封面兜底：Steam CDN 没有竖版封面（如新上架游戏）时，导入自动获取 600×900 封面 | steamgriddb.com 登录 → Preferences → API → Generate API Key |
| **TMDB** | 影视库自动封面（海报、季封面、集剧照）与元数据（简介、评分、上映日期） | themoviedb.org 注册登录 → Settings → API → Create，取 v3 API Key（读访问令牌不需要） |

> API Key 仅存储在本机数据库中，只用于向对应接口发起请求，不会上传到任何其他服务。

## 🚀 构建与运行

依赖：Node.js、Rust 工具链、随包 mpv（拉取见 `scripts/fetch-mpv.sh`）

```bash
# 编译（前端 + Rust 后端，debug 产物）
build.bat          # 或 npx tauri build --debug --no-bundle

# 直接运行已编译产物（不重新编译）
start.bat

# 生产构建（产物: src-tauri\target\release\zex.exe）
npm run tauri build
```

构建 / 运行详细说明见 `START_SCRIPTS_README.md`。

## 🔒 隐私

所有数据（游戏 / 影视 / 音乐信息、观看记录、API Key 配置）仅存储在本机 `data/` 目录，不向任何服务上传。

## 系统要求

Windows 10 / 11
