# ZEX 桌面歌词设计(第一版)

> 目标:**MVP = 音乐播放时显示桌面悬浮歌词窗口**。歌词只取**音乐文件内嵌歌词**(FLAC `LYRICS` / MP3 ID3v2 `USLT` 等,lofty `ItemKey::Lyrics`),不带时间轴的纯文本歌词丢弃。开/关按钮放在底部音乐播放条。不做在线歌词、不做逐字 KTV。

## 1. 结论先行:已实测验证的技术路线

| 问题 | 结论 | 依据 |
|---|---|---|
| 纯音频播放时能否拿到「当前歌词行」 | ✅ mpv `--vid=no` 加载 lrc 后,`sub-text` 属性精确返回当前行(seek 后立即对齐) | 本机实测(随包 mpv + 用户 flac 库) |
| 关闭字幕显示是否影响读取 | ✅ `sub-visibility=no` 不影响 `sub-text` 属性 | 本机实测 |
| 内嵌歌词怎么读 | lofty 0.24 `tag.get_string(ItemKey::Lyrics)` 统一覆盖 FLAC/MP3/MP4 等 | 项目已用 lofty 解析元数据(parse_audio_tags) |
| 时间轴谁管 | **mpv 管**:lrc 加载为字幕轨,行变化经 IPC 推送,seek/换曲/暂停天然对齐 | — |

**因此后端不需要自写 lrc 解析器**:把内嵌歌词文本写成本地 `.lrc` 文件喂给 mpv,读 `sub-text` 即可,时间轴交给 mpv 这个已经被时间考验的解析器。

## 2. 架构总览

```
[mpv] --sub-add data/mpv/lyrics/<track_id>.lrc
   │  observe_property sub-text(行变化推送)
   ▼
[reader 线程] ──emit──> [lyrics-line {track_id, line}]  (仅音乐模式)
   │
   │  播放/换曲时 attach_embedded_lyrics():提取→写 lrc→sub-add
   ▼
[歌词窗口 label=lyrics,index.html?view=lyrics]
   ├─ 透明无边框置顶穿透(focusable:false 不抢焦点)
   ├─ 默认锁定(点击穿透);设置页「调整歌词位置」→ 解锁可拖 → 完成恢复
   └─ 位置记忆(localStorage,与主窗口同 origin 共享)
```

### 2.1 关键设计:时间轴 = mpv 字幕轨

- 播放队列构建时**不**批量提取歌词(避免播放前卡 IO);按需懒加载:
  - **冷启动/预热路径**:reader 线程开头(observe 之后)给当前曲目 attach 一次
  - **换曲**:`rotate_music_to`(playlist-pos 轮换,唯一换曲同步点)内 attach 新曲
  - **热启动 running 分支**无需显式 attach:playlist-pos 变化会走 rotate → attach
- attach 动作:`extract_embedded_lyrics(local_path)` → 写 `data/mpv/lyrics/<track_id>.lrc` → `sub-add <file> select`(select = 替换选中轨;旧轨残留但不选中、不渲染、sub-text 不读,会话结束进程销毁,无害)
- 无内嵌歌词/无时间轴:直接 return,sub-text 推空行 → 前端显示「暂无歌词」

### 2.2 reader 线程改动(mpv.rs)

1. observe 列表追加 `(7, "sub-text")`
2. property-change 分支:sub-text 是**字符串**,现分支只解析 Number/Bool → 在现有 match 前单独拦 `name == "sub-text"`,取 `data` 字符串,`mode() == Music` 时 `app.emit("lyrics-line", {track_id, line})`
3. 新增 `attach_embedded_lyrics(handle, data_dir, track_id, local_path)`:**锁外调用**(文件 IO + IPC;rotate_music_to 里先锁内取 `local_path`,释放后再 attach,遵守项目「先 mpv 再 db、锁外不做 IO」纪律)

### 2.3 歌词窗口(后端创建,参照 tray-menu 惯例)

```rust
// lib.rs,与托盘窗口同区
const LYRICS_WINDOW_LABEL: &str = "lyrics";

#[tauri::command] fn open_lyrics_window(app, x: Option<f64>, y: Option<f64>)
  // 已存在 → show;否则 WebviewWindowBuilder::new(app, "lyrics",
  //   WebviewUrl::App("index.html?view=lyrics".into()))
  //   .inner_size(680, 200).decorations(false).transparent(true)
  //   .always_on_top(true).skip_taskbar(true).resizable(false)
  //   .focused(false).visible(false)  → build 后 set_position(x,y) + show
#[tauri::command] fn close_lyrics_window(app)  // 存在则 close,幂等
```

窗口参数对齐 tray-menu 先例(`focused(false)` 已有,再加 `focusable` 不可靠时以 `focused(false)` 为准;穿透由前端 `setIgnoreCursorEvents(true)` 负责)。

### 2.4 前端

| 文件 | 改动 |
|---|---|
| `src/main.tsx` | 加 `view=lyrics` 分支(仿 tray-menu):渲染 `<LyricsWindow/>` |
| `src/components/LyricsWindow.tsx`(新) | 监听 `lyrics-line`(当前行)、`music-progress`(playing 灰化)、`music-track-changed`/`mpv-closed`/`mpv-ready`(清行);挂载时 `setIgnoreCursorEvents(true)`;`onMoved` 存位置到 localStorage;调整模式:显示边框 + 完成按钮,期间不穿透可拖动(`data-tauri-drag-region`) |
| `src/components/MusicPlaybackBar.tsx` | 控制区加「歌词」按钮(`Captions` 图标,开=高亮 `#00d4ff`),toggle → `api.openLyricsWindow(x,y)` / `api.closeLyricsWindow()`,位置从 localStorage 读 |
| `src/store/index.ts` | `lyricsOpen: boolean` + `setLyricsOpen`(不持久化,会话级) |
| `src/views/SettingsView.tsx` | 「播放」section 加一行「调整歌词位置」(仅 lyricsOpen 时渲染):emit `lyrics-adjust-mode` 事件。**注意:新增行后 data-settings-row 编号顺延,库行 14+i → 15+i** |
| `src/api/index.ts` | `openLyricsWindow(x?, y?)` / `closeLyricsWindow()` |
| `src-tauri/capabilities/lyrics.json`(新) | windows: ["lyrics"],permissions: core:default + `core:window:allow-set-ignore-cursor-events` |

歌词窗口默认位置:首次无记忆 → 创建后由窗口 `center`;拖动后位置写入 localStorage(`zex-lyrics-pos`),下次打开恢复。

## 3. 交互设计

- **锁定态(默认)**:点击穿透、不抢焦点、置顶显示,不挡任何鼠标操作;暂停时歌词灰化
- **调整态**:设置页「调整歌词位置」→ 主窗口 emit `lyrics-adjust-mode` → 歌词窗口解除穿透、显示 1px 边框和「✓ 完成」按钮,整窗可拖;点完成 → 保存位置 + 恢复穿透
- 歌词窗口无关闭按钮(用户无法误关);开/关只由播放条按钮控制,状态不漂移
- 无歌词:显示「♪ 暂无歌词」;换曲瞬间短暂显示同文案,可接受

## 4. 数据流时序

- **冷启动播放**:play_music(spawn+loadlist) → reader 连管道 observe(含 sub-text) → reader 开头 attach 首曲 lrc → mpv 推 sub-text 行 → emit → 歌词窗口显示
- **换曲**:mpv playlist-pos 变化 → reader rotate_music_to(锁内取新曲路径)→ 锁外 attach 新曲 → mpv 推空行 + 新行 → 窗口刷新
- **seek/暂停**:mpv 内部处理,sub-text 自动跟随/保持,前端零逻辑
- **停止**:mpv-closed → 窗口清空
- **音乐→影视**:mpv-ready → 窗口清空(影视模式 reader 不 emit lyrics-line)
- **ZEX 重启后 mpv 续播**:歌词窗口不自动恢复(会话级开关),打开即显示当前行(sub-text 初始订阅推当前值)

## 5. 已知限制(本版接受)

1. 无 KTV 逐字效果(mpv `sub-text` 只给整行文本,`sub-text-all` 上游已拒收)
2. 纯文本歌词(无 `[mm:ss]` 时间轴)丢弃
3. Enhanced LRC 逐字标签 mpv 兼容性未测(本机库无此类文件)
4. 旧歌词轨在 mpv 会话内累积(不选中、无渲染开销,进程结束清理)
5. 同目录 `.lrc` 文件:mpv `sub-auto=fuzzy` 默认会顺带加载(免费获得),但不在本版管理范围

## 6. 验收清单

| # | 项 | 验证 |
|---|---|---|
| 1 | 编译 | `npx tauri build --debug --no-bundle` 通过 |
| 2 | 窗口创建 | 播放条点歌词按钮 → 弹出透明置顶窗口,任务栏无图标,不抢焦点 |
| 3 | 歌词显示 | 有内嵌歌词的曲目播放时逐行跟随,无内嵌歌词显示「暂无歌词」 |
| 4 | 换曲 | 上一首/下一首/自动连播 → 歌词跟随新曲 |
| 5 | seek | 拖动进度条/快进 → 歌词立即跳到对应行 |
| 6 | 暂停 | 歌词保留当前行且灰化;恢复播放变亮 |
| 7 | 停止 | 歌词清空;窗口不自动关 |
| 8 | 穿透 | 锁定态鼠标点击穿透到下层窗口 |
| 9 | 调整位置 | 设置页进入调整态可拖,完成恢复穿透;位置记忆,重开后同位置 |
| 10 | 切影视 | 音乐→影视,歌词清空;影视→音乐恢复 |
| 11 | 重启 | ZEX 重启后 mpv 续播,打开歌词窗口即显示当前行 |

## 7. 后续可扩展(不在本版)

- 在线歌词源:LRCLIB(免 key、按歌手+歌名+时长匹配,API 已实测可用)中文歌覆盖一般;网易云 API 覆盖好但有封禁风险
- 同目录 `.lrc` 文件纳入管理(扫描登记、换曲切换)
- 歌词字号/颜色/对齐设置
- KTV 逐字:需自己解析 Enhanced LRC + 以 time-pos 驱动(前端二分),放弃 mpv sub-text
