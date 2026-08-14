# 🚀 ZEX 构建与启动

## 📁 脚本

- **`build.bat`** - 编译（前端 + Rust 后端 + 打包资源，debug 产物）
- **`start.bat`** - 直接运行已编译的 `zex.exe`，**不重新编译**（秒开）

## 🎯 工作流程

```
改完代码
    ↓
双击 build.bat    （或命令行: npx tauri build --debug --no-bundle）
    ↓
双击 start.bat     （直接启动）
    ↓
应用运行 🎉
```

### 什么时候需要重新编译

| 改动类型 | 需要 build.bat？ |
|---|---|
| Rust（`src-tauri/src`） | ✅ 需要 |
| 前端（`src/`） | ✅ 需要 |
| mpv 皮肤 Lua（`resources/skin`） | ❌ 不需要。同步到运行时目录 `src-tauri\target\debug\data\mpv\scripts\` 后重启 zex.exe 即可。若改了 `mpv.rs` 的 `SKIN_VERSION`，ZEX 启动时自动重灌皮肤 |

## 🚫 停止应用

关闭 ZEX 窗口即可。

## 📦 生产构建

```bash
npm run tauri build
# 产物: src-tauri\target\release\zex.exe
```

---

**创建时间：** 2026-07-30  
**版本：** v2.0（拆分构建/运行）  
**兼容性：** Windows 10/11
