# 计划书：设置页切走后选项标签残留

- 日期：2026-08-21
- 状态：待实施
- 复现：设置页 → 点击顶部导航切到其他库（游戏/影视/音乐/统计），设置页的「开/关」「隐藏/显示」等选项标签悬在新视图背景上约 0.2s 后消失

## 一、症状

从设置页切换到其他库的瞬间，设置页内容大部分立即消失，但带标签样式的控件（chip：开/关、隐藏/显示；btn：导出/导入/清除/保存/浏览；主题与语言按钮）残留约 0.15~0.2 秒，期间悬浮在其他库的内容之上，然后才消失。

## 二、根因

机制链条（全部为 CSS 标准行为，四环缺一不可）：

1. **设置页是唯一用 `visibility` 隐藏的视图**。`src/App.tsx:404-409`：设置页始终挂载，用 `style={{ visibility: activeView === 'settings' ? undefined : 'hidden' }}` 控制显隐（刻意不用 `display: none`，保证隐藏期间保持几何尺寸，供留空测量）。其余视图（GameView/SeriesView 等）是卸载式切换（`{activeView === 'games' && <GameView />}`），DOM 直接移除，不存在此问题。

2. **`visibility` 是继承属性**。容器变 `hidden` 时，设置页所有子元素的 computed visibility 跟随变为 `hidden`。

3. **子元素的 `transition: all` 包含 `visibility`**。
   - `.chip`（`src/index.css:746`）：`transition: all 0.2s cubic-bezier(0.22, 1, 0.36, 1)`
   - `.btn`（`src/index.css:267`）：`transition: all 0.2s ...`
   - Tailwind `transition-all`（设置页主题/语言按钮，`SettingsView.tsx:708/729`）：150ms
   - 子元素 computed value 变化（哪怕来自继承）即触发其过渡。

4. **visibility 向 hidden 过渡时，整个过渡期间保持可见**。CSS Transitions 规范对离散属性 visibility 的语义：向 `hidden` 过渡 → 过渡期间 used value 恒为 `visible`，过渡**结束**才切到 `hidden`。因此带 `transition: all` 的元素延迟 0.2s 才隐藏。

**为什么只残留标签、不残留整页**：`visibility` 的渲染判定是逐元素生效（hidden 祖先不阻止显式/过渡期 visible 的后代绘制）。`.glass-card` 的过渡是显式列表 `box-shadow, transform, background`（`index.css:101`），**不含 visibility** → 卡片立即隐藏；`.set-row`、文本等无 transition → 立即隐藏。只有 `transition: all` 的标签类元素进入过渡期，保持可见 0.15~0.2s。与症状精确吻合。

**为什么反向（切回设置页）无此问题**：向 `visible` 过渡时 visibility 立即翻转，无残留。

## 三、修复方案

### 方案一（推荐）：隐藏态禁用子树过渡

在设置页容器上打标记，隐藏期间子树全部 `transition: none`，visibility 变化立即生效。

`src/App.tsx:404-409` 容器加 data 属性：

```tsx
<div
  className="absolute inset-0"
  data-settings-hidden={activeView === 'settings' ? undefined : ''}
  style={{ visibility: activeView === 'settings' ? undefined : 'hidden' }}
>
```

`src/index.css`（设置页区块附近）加规则：

```css
/* 切走设置页时立即隐藏子树：visibility 是继承属性，子元素 .chip/.btn 的
   transition: all 会把 visibility 纳入过渡 —— 向 hidden 过渡期间保持可见、
   过渡结束（0.2s）才隐藏，卡片已消失只剩标签残留。隐藏态禁掉子树全部
   过渡，visibility 立即生效（切回时属性移除，过渡照常） */
[data-settings-hidden] *,
[data-settings-hidden] { transition: none !important; }
```

改动 2 处、共约 10 行，零回归风险。

**副作用分析**：
- 隐藏期间子树不可见、不交互，禁用过渡无任何感知；
- 切回设置页瞬间属性移除、过渡恢复；visibility 向 visible 本就立即翻转，无影响；
- `visibility: hidden` 的布局保留不变，留空测量（`useSettingsRhythm` 的 ResizeObserver）不受影响；
- `!important` 仅作用于隐藏态，不影响任何常驻样式。

### 方案二（备选加固，非必须）：显式 transition-property 列表

把 `.chip` / `.btn`（以及设置页内 Tailwind `transition-all` 处）的 `transition: all` 改为显式属性列表（`color/background/border-color/box-shadow/transform`，不含 visibility），从根上消除。改动面大（需逐个排查 `transition-all` 用法），且有全局回归风险（这些类被顶部导航等多处复用）。适合作为后续顺手加固，不解决眼前问题的主要方案。

### 方案对比

| | 方案一 | 方案二 |
|---|---|---|
| 改动面 | 2 处 | 多处（含 Tailwind 类排查） |
| 风险 | 低 | 中 |
| 是否根治 | 是（设置页场景） | 是（全局） |
| 覆盖范围 | 设置页 | 全部 visibility 使用场景（含托盘隐藏） |

## 四、实施步骤

1. `src/App.tsx`：设置页容器加 `data-settings-hidden`（如上）。
2. `src/index.css`：加 `[data-settings-hidden]` 规则（如上）。
3. 编译运行（按既有工作流：Claude 编译，start.bat 运行）。

## 五、验证清单

1. 设置页 → 切游戏库/影视库/音乐库/统计：标签残留消失，切换立即干净。
2. 切回设置页：正常显示，主题/语言按钮、chips 动画、hover 过渡照常。
3. 设置页内各项交互（开关即时保存、手柄聚焦、输入框、弹窗）不受影响。
4. 窗口缩放/播放条出现时留空测量正常（`--sr-py` 节奏与铺底不变）。
5. 托盘隐藏/唤回流程无回归（`html.app-blank` 链路未改动，抽查一次即可）。

## 六、影响面

- 仅设置页隐藏路径；改动为隐藏态新增 CSS 规则 + 一个 data 属性，常驻渲染零变化。
