# ZEX 英文语言支持（i18n）— 状态文档

> 任务：给软件加英文语言支持；设置页加「语言」选项（中文 / English），切换立即生效并持久化。
> ✅ 已完成全部条目，本文件归档保留（含过程中踩过的坑，供后续扩展语言时参考）。

## 一、方案

- **范围**：前端所有用户可见文案（React 视图/组件/托盘菜单/桌面歌词小窗）。Rust 后端无用户文案（全是注释），不动。
- **机制**：自建轻量 i18n，不引第三方库。
  - `src/i18n/index.ts` — `t(key, vars)` 取词（en → zh 兜底 → key 本身）、`useT()`（组件内用，订阅语言变化）、`useLang()`、`setLang(l)`（立即生效 + 落库 + 写 localStorage 镜像）、`initLang()`（启动时按数据库纠偏）。
  - `src/i18n/dict.ts` — 词典合并入口，摊平 `locales/` 下各模块文件。
  - `src/i18n/locales/common.ts` — 跨模块通用词条（取消/保存/错误/开关/导航名/时长格式化/浏览/取消全选/完成等，前缀 `common.`、`nav.`、`app.`）。
  - 各模块词条在 `locales/<area>.ts`（`settings.` / `games.` / `series.` / `music.` / `stats.` / `misc.` / `disk.` 等），zh 原文 + en 译文。
- **持久化**：settings 表 `language` 键（`'zh'` / `'en'`），localStorage 镜像 `zex-lang` 供首帧同步读取（避免闪语言）。
- **多窗口**：托盘菜单 / 桌面歌词与主窗共用 index.html 入口，各自在挂载函数里 `initLang()`。

## 二、使用约定（改代码时遵守）

- 组件内：`const t = useT();` 然后 `t('area.key')`；动态值用占位符 `t('key', { n })`，词条写 `'共 {n} 个'`。
- 模块级常量里的中文 label → 存 key，渲染时 `t(item.label)`。
- 非渲染上下文（事件监听等）直接 `import { t }` 调用（永远读当前语言）。
- 中文代码注释**不翻译**；文件路径/CSS/标识符/品牌名 ZEX 不动。
- 通用词条优先复用：`common.cancel/confirm/delete/remove/close/save/saving/error/warning/success/tip/yes/no/loading/retry/on/off/search/all/none/saveFailed/browse/deselectAll/done`、`nav.games/series/music/stats/settings`、`common.episodeN`、`common.duration.*`。

## 三、进度

- [x] i18n 基础设施（index.ts / dict.ts / locales/common.ts）
- [x] `utils/media.ts` 时长与集数格式化走词条（formatHoursMinutes / formatRuntime / cleanEpisodeTitle）
- [x] `App.tsx`：导航标签、窗口按钮 title、启动 `initLang()`
- [x] `tray-menu.tsx` / `desktop-lyrics.tsx`：挂载时 `initLang()`
- [x] `SettingsView.tsx`：外观区新增「语言 / Language」行（row 1，主题之后），中文 / English 两个 chip，鼠标点击 + 手柄左右切换；后续所有行编号已 +1（rowOffset 机制不变）
- [x] `SettingsView.tsx` 全部文案抽取 → `locales/settings.ts`（约 120 词条；fetchResult 失败判断改为 `fetchFailed` 状态，不再用中文前缀 startsWith）
- [x] Music 模块 → `locales/music.ts`：MusicView / MusicContextMenu / MusicPlaybackBar / AddMusicModal / CreatePlaylistModal / AddToPlaylistFlyout
  - 修复遗留 bug：MusicView 行右键 `setMenu({ trk, ... })` → `{ t: trk, ... }`（类型错误，上轮改名漏改）
  - `music.selectFiles` 复用于模式按钮与选择按钮两处同文位置
  - `music.parsePrefix/Mid/New` 三段式词条保住 `共解析 <b>n</b> 首，其中 <b>m</b> 首新曲` 的加粗结构
- [x] Games 模块 → `locales/games.ts`：GameView / GameDetail / GameCard / GameGrid / GameContextMenu / AddGameModal / SteamScanModal / LibraryContextMenu / SortMenu
  - common.ts 新增 `common.browse` / `common.deselectAll`（游戏库与音乐库共用）
  - GameDetail 日期格式化跟随语言：`toLocaleDateString` 按 lang 传 zh-CN / en-US
  - SteamScanModal 的 formatPlaytime 移入组件闭包（模块级函数无法取词）
- [x] Series 模块 → `locales/series.ts`：SeriesView / SeriesDetail / SeriesContextMenu / AddSeriesModal / SeriesDiskManagerModal / DiskManagerModal
  - 磁盘管理两弹窗（游戏/影视）共用 `disk.*` 词条
  - AddSeriesModal 的 `连载中`/`正片`/`第 N 季` 是写入数据库的数据值，不翻译
  - `(r.error ?? '').includes('移动已取消')` 是后端中文错误匹配，保留
  - DiskManagerModal `driveOf` 返回 null 表示未知盘符（渲染处译「未知」），替代中文字符串
- [x] Stats+杂项 → `locales/stats.ts` + `locales/misc.ts`：StatsView / StatsAdjustModal / StatsCovers / CoverPickerModal / TmdbPickerModal / tray-menu / desktop-lyrics
  - StatsCovers 的 longDur 改用 `common.duration.*` 词条（模块级 import t）
  - `gamepad/service.ts` 手柄名 `Xbox 手柄 ×1` → `Xbox ×1`（设置页「已连接」直接显示，改中英通用紧凑格式）
- [x] dict.ts 合并全部 locale 文件
- [x] 全量 `tsc --noEmit` + `vite build` 验证
- [x] 残留中文扫描（仅注释应残留）
- [x] 提交

## 四、注意事项

- SettingsView 手柄导航行编号脆弱：`data-settings-row` / `focusedRow === N (+ rowOffset)` 已含语言行，抽取文案时**绝不能**动编号逻辑。
- `replaceAll` 不可用（tsc target 低于 ES2021），插值用 `split().join()`。
- 语言行文案本身（「语言 / Language」标题、说明）也要进 settings 词条。
- 后续加语言：新建 `locales/<lang>.ts` 对（或按模块），dict.ts 摊平；language 行 chip 在 SettingsView 的 `LANGUAGES`（i18n/index.ts）里加。
