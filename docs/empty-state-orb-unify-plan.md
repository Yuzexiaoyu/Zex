# 计划书：库空状态图标统一为统计页 orb 风格

- 日期：2026-08-23
- 状态：待实施
- 需求：以统计页空状态（圆形 orb + 线性图标 + 青色径向光晕）为基准，重设计游戏库、影视库、音乐库三个库的空状态图标

## 一、现状：四处空状态，三种风格

| 位置 | 容器 | 图标 | 配色 | 光晕 |
|---|---|---|---|---|
| 统计页 `StatsView.tsx:202` | **圆形 orb** 86×86（`.stats-empty-orb`） | BarChart3 size=38 | 青色（--color-accent） | 内部径向渐变 |
| 游戏库 `GameGrid.tsx:294` | 圆角方块 32×32 | 🎮 emoji（6xl, 40% 透明） | 青蓝渐变 | 外部 blur 光晕 |
| 影视库 `SeriesView.tsx:475` | 圆角方块 32×32 | Tv size=52 | 紫渐变（#7c3aed） | 外部 blur 光晕 |
| 音乐库 `MusicView.tsx:557` | 圆角方块 32×32 | Music size=52 | 紫渐变（#7c3aed） | 外部 blur 光晕 |

四处动画均为同一 `float`（3s 来回、4px，`src/index.css:224`）。

**关键事实**：`#7c3aed` 紫色全库仅出现在音乐/影视库空状态图标（各 2 次：渐变 + 边框），并非页面主题色——三个库页面的主题色与统计页一致，都是全局 `--color-accent: #00d4ff`（`src/index.css:12`，各库按钮、选中态、高亮全走它）。紫色是空状态专属点缀，移除不破坏任何页面主题。

## 二、统计页 orb 的设计语言（作为基准）

```css
/* src/index.css:2276 */
.stats-empty-orb {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 86px; height: 86px;
  border-radius: 50%;
  color: var(--color-accent);
  background: radial-gradient(circle, rgba(0, 212, 255, 0.16) 0%, transparent 70%);
  border: 1px solid rgba(0, 212, 255, 0.25);
  animation: float 3s ease-in-out infinite;
}
```

- 圆形 + 细边框 + 内部径向渐变光晕（无外圈 blur）
- 图标为 lucide 线性图标，继承青色，size=38
- `float` 动画与其余四处相同 → 动效无需改

## 三、方案

### 1. 类泛化：`.stats-empty-orb` → `.empty-orb`

`src/index.css:2276` 原地改名 + 注释改为「四库共用的空状态 orb」，样式不动。`StatsView.tsx:202` 同步换类名。统计页外观零变化。

### 2. 三库空状态替换（每个库一处 JSX）

统一结构（父容器已是 `flex flex-col items-center justify-center gap-*`，flex 居中，无需 `mx-auto`/`mb-6`——统计页需要它们是因为它的父容器是 `text-center` 块级）：

```tsx
<div className="empty-orb"><Xxx size={38} /></div>
```

| 位置 | 删除 | 替换为 |
|---|---|---|
| `GameGrid.tsx:293-298` | `relative` 包裹 + 32×32 渐变方块 + emoji + 外圈 blur 光晕 | `<div className="empty-orb"><Gamepad2 size={38} /></div>` |
| `SeriesView.tsx:474-479` | 同上（Tv size=52） | `<div className="empty-orb"><Tv size={38} /></div>` |
| `MusicView.tsx:556-561` | 同上（Music size=52） | `<div className="empty-orb"><Music size={38} /></div>` |

- `Gamepad2` 已在 `GameGrid.tsx:9` 导入，无需新增 import；Tv/Music 沿用现有导入
- 图标从 52/6xl emoji 缩到 38，与统计页一致；颜色从 `text-text-tertiary`/40% 透明改为继承 orb 的 `--color-accent`
- 紫色渐变、外圈 blur 光晕、`animate-float` 类随方块一起删除

### 3. 布局间距微调

- 统计页 orb 与标题间距 `mb-6` = 24px；音乐/影视库父 `gap-6` = 24px，天然一致
- 游戏库父 `gap-5` = 20px，略紧 → 顺手改 `gap-6`（`GameGrid.tsx:290`），四页空状态垂直节奏一致

### 4. 清理（可选但建议）

- `.animate-float` 类（`src/index.css:240`）改完后无引用 → 删除类定义（`@keyframes float` 保留，`empty-orb` 仍用）
- `.stats-empty-orb` 名称全库无残留（grep 验证）

## 四、实施步骤

1. `src/index.css`：`.stats-empty-orb` 改名 `.empty-orb`，注释说明四库共用；删 `.animate-float` 类
2. `StatsView.tsx:202`：类名换成 `.empty-orb`
3. `GameGrid.tsx:287-302`：替换空状态图标块，父容器 `gap-5` → `gap-6`
4. `SeriesView.tsx:472-488`：替换空状态图标块
5. `MusicView.tsx:554-570`：替换空状态图标块
6. grep 验证：`stats-empty-orb`、`animate-float` 零残留；`#7c3aed` 零残留

## 五、验证清单

- [ ] 四个页面分别清空库（或临时改空态判定），确认均为青色圆形 orb + 线性图标 + float 动画
- [ ] 游戏库显示 Gamepad2、影视库 Tv、音乐库 Music、统计页 BarChart3
- [ ] 深色/浅色主题下 orb 均清晰（径向渐变透明度无叠加异常）
- [ ] 动画节奏与之前一致（同一 float 关键帧，无感知差异）
- [ ] 空状态文字与按钮间距不因替换变化（gap 对齐）

## 六、风险与回归面

- 改动面：4 个文件（CSS 1 处、TSX 4 处），全部局限在空状态渲染分支
- `empty-orb` 无其他使用者，改名无全局影响；`.animate-float` 删除前 grep 确认无遗漏引用
- 空状态仅在库为空时渲染，日常路径（有内容时）完全不触碰这些行
