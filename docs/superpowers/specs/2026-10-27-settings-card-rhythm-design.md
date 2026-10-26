# 设置页间距对齐通用 UI 规范

> 状态：待审
> 日期：2026-10-27
> 适用：`src/client/settings-card.tsx` / `injection-panel.tsx` / `settings-card.module.css`
> 依据：`C:\Users\Think\Desktop\项目\DSH-插件设置页UI规范.md`（下称《规范》）

## 1. 意图

设置页当前的纵向节奏是**两套数并排**：散行之间 32px、组内 40px、组边界 40px，跨线 32px。同一张卡里出现 32 / 40 两种间距，肉眼能看出「组内的行比散行松」。

目标：**全卡只有一种节奏**——相邻块 24px、跨线 32px、卡片顶/底 16px，且由《规范》§2.3 的 `.section` + 负边距机制产生。

## 2. 目标模型（已与用户逐段确认）

下面是目标模型的**完整结构剖面**，照《规范》附录 A 的画法，一个元素不漏。

```
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
│  div.stack   padding 0 · gap 0 · 包装层不吃空间                     │
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  ┆ div.section ▸ padding-top ·································· 16px
  ┆ div.section ▸ :first-child ▸ margin-top ··················· −12px
  ┆ div.row ▸ padding-top ······································· 12px
│ ① div.row    新会话落点                              [ selector ]    │
│     div.rowText   gap 6 · padding-right 48                           │
│       div.title   13/500/19.5 · label-primary                        │
│       div.desc    12/400/18   · label-tertiary                       │
  ┆ div.row ▸ padding-bottom ··································· 12px
  ┆ div.row ▸ padding-top ······································· 12px
│ ② div.row    创建项目时开会话                           [ Switch ]    │
│     div.rowText ▸ gap 6 → title 13/500 + desc 12/400                 │
  ┆ div.row ▸ padding-bottom ··································· 12px
  ┆ div.row ▸ padding-top ······································· 12px
│ ③ div.row    链接校验                                   [ Switch ]    │
  ┆ div.row ▸ padding-bottom ··································· 12px
  ┆ div.row ▸ padding-top ······································· 12px
│ ④ div.row    注入项目上下文（主开关）                   [ Switch ]    │
  ┆ div.row ▸ padding-bottom ··································· 12px
  ┆ div.row ▸ padding-top ······································· 12px
│ ⑤ div.row    注入项目文档（受 ④ 门控）          [ Switch ·disabled ] │
  ┆ div.row ▸ padding-bottom ··································· 12px
  ┆ div.group ▸ padding-top ····································· 12px
│ ⑥ div.group ▸ 文档规范                                              │
│     div.groupTitle   13/600/19.5  （门控时 + .gated）                │
  ┆ div.group ▸ gap ················································ 6px
│     div.cubeRow   gap 8 · flex-wrap                                  │
│       [ cube 无 ]  ┆8px┆  [ cube 默认 ]  ┆8px┆  [ cube 自定义 ]      │
│         cube ▸ padding 20/32 · gap 4                                 │
│           span.cubeName  13/500                                      │
│           span.cubePath  12/400 · label-tertiary · 或 +.cubeNotice   │
│           span.cubeAction  「更换…」                                  │
  ┆ div.group ▸ padding-bottom ································· 12px
  ┆ div.row ▸ padding-top ······································· 12px
│ ⑦ div.row    每项目独立规范（受门控）           [ Switch ·disabled ] │
  ┆ div.row ▸ padding-bottom ··································· 12px   ← :last-child
  ┆ div.section ▸ :last-child ▸ margin-bottom ················· −12px
  ┆ div.section ▸ padding-bottom ······························· 16px
  ┆ div.rule ▸ margin ·············································─ 0px
════════════════════════════════════════════════════  border-top 0.5px · border-l2
  ┆ div.rule ▸ margin ·············································─ 0px
  ┆ div.section ▸ padding-top ·································· 16px
  ┆ div.section ▸ :first-child ▸ margin-top ··················· −12px
  ┆ div.group ▸ padding-top ····································· 12px
│ ⑧ div.group ▸ 注入内容     ← InjectionPanel 的第一个孩子            │
│     div.groupTitle   13/600/19.5                                     │
  ┆ div.group ▸ gap ················································ 6px
│     div.injectionText   ▸ padding 12px                               │
│       font-mono 12/18 · pre-wrap · radius-lg · 0.5px solid border-l2 │
│       或 div.injectionOff  0.5px dashed · label-tertiary             │
  ┆ div.group ▸ gap ················································ 6px
│     div.desc  12/400/18  （仅 injectionText 存在时）                  │
  ┆ div.group ▸ padding-bottom ································· 12px   ← :last-child
  ┆ div.section ▸ :last-child ▸ margin-bottom ················· −12px
  ┆ div.section ▸ padding-bottom ······························· 16px
  ┆ div.rule ▸ margin ·············································─ 0px
════════════════════════════════════════════════════  border-top 0.5px · border-l2
  ┆ div.rule ▸ margin ·············································─ 0px
  ┆ div.section ▸ padding-top ·································· 16px
  ┆ div.section ▸ :first-child ▸ margin-top ··················· −12px
  ┆ div.group ▸ padding-top ····································· 12px
│ ⑨ div.group ▸ 状态差异  （仅 groups.length > 0 时渲染）              │
│     div.groupTitle   13/600/19.5                                     │
  ┆ div.group ▸ gap ················································ 6px
│     div.injectionDiffRow × N   flex column · gap 8                   │
│       button.injectionDiffToggle   padding 0 · 13/19.5                │
│       ┆ gap 8                                                         │
│       div.injectionDiffBody  （展开时）                               │
  ┆ div.group ▸ gap ················································ 6px
│     （下一个 injectionDiffRow）                                       │
  ┆ div.group ▸ padding-bottom ································· 12px   ← :last-child
  ┆ div.section ▸ :last-child ▸ margin-bottom ················· −12px
  ┆ div.section ▸ padding-bottom ······························· 16px
  ┆ div.rule ▸ margin ·············································─ 0px
════════════════════════════════════════════════════  border-top 0.5px · border-l2
  ┆ div.rule ▸ margin ·············································─ 0px
  ┆ div.section ▸ padding-top ·································· 16px
  ┆ div.section ▸ :first-child ▸ margin-top ··················· −12px
  ┆ div.group ▸ padding-top ····································· 12px
│ ⑩ div.group ▸ 底层工作区     ← groupHeading 已删，与 ⑧ 同构          │
│     div.groupTitle   13/600/19.5 ·「底层工作区」                      │
  ┆ div.group ▸ gap ················································ 6px
│     div.desc   12/400/18 · label-tertiary                            │
  ┆ div.group ▸ gap ················································ 6px
│     div.cubeRow   gap 8                                              │
│       [ cube 默认 ]  ┆8px┆  [ cube 指定 ]                             │
│         cube ▸ padding 20/32 · gap 4                                 │
│         span.cubePath ＋ .cubeWarn（缺失时）＋ cubeAction「重建」      │
│         span.cubeAction「更换…」                                     │
  ┆ div.group ▸ padding-bottom ································· 12px   ← :last-child
  ┆ div.section ▸ :last-child ▸ margin-bottom ················· −12px
  ┆ div.section ▸ padding-bottom ······························· 16px
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
│  卡片底                                                             │
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
```

### 2.1 结构

卡片根改为三段 `div.section`，用现有 `div.rule` 分隔：

```
div.stack                                 gap 0（包装层，不吃空间）
├── div.section                          ① ② ③ ④ ⑤ ⑥ ⑦
├── div.rule     ═══════════              margin 0
├── div.section                          ⑧ 注入内容
├── div.rule     ═══════════              margin 0   ← 仅在 ⑨ 存在时
├── div.section                          ⑨ 状态差异
├── div.rule     ═══════════              margin 0
└── div.section                          ⑩ 底层工作区
```

**段边界落在 `InjectionPanel` 内部**：它现在返回 Fragment（`injection-panel.tsx:122` 与 `:207`），线 B 由它自己渲染。要改成由面板输出 `<div className={css.section}>`，因此这不是纯 CSS 改动。

### 2.2 间距（唯一的三种来源）

| 来源 | 值 | 作用 |
|---|---|---|
| `.section` padding | `16px 0` | 段两端 |
| `.section > :first-child` margin-top | `−12px` | 吃掉首块的内部上 padding |
| `.section > :last-child` margin-bottom | `−12px` | 吃掉末块的内部下 padding |
| `.row` / `.group` padding | `12px 0` | 块自身上下 |
| `.group` gap | `6px` | 组内直接孩子之间 |
| `.rowText` gap | `6px` | 行标题 ↔ 说明 |

由此得出：

| 位置 | 构成 | 值 |
|---|---|---|
| 卡片顶 → 首块内容 | 16 − 12 + 12 | **16px** |
| 行 → 行 | 12 + 12 | 24px |
| 行 → 组 / 组 → 行 | 12 + 12 | 24px |
| 组标题 → 内容 | gap | 6px |
| 行标题 → 说明 | gap | 6px |
| 块 → 线 / 线 → 块 | 12 − 12 + 16 | 16px |
| **跨线内容 → 内容** | 16 + 16 | **32px** |
| 卡片底 | 16 − 12 + 12 | 16px |

**线两侧完全对称**，达成《规范》§2.1 的「组边界 32px」。

### 2.3 删除 `.groupHeading`

⑩ 现在用 `.groupHeading { gap: 4px }` 包住「标题 + 说明」，而 ⑧ 是让 `groupTitle` 与 `desc` 直接做 `.group` 的孩子、靠 6px gap 分开。

**删掉 `.groupHeading`**，⑩ 与 ⑧ 同构。改完后 `.groupHeading` 的 4px 消失，全卡不再存在 4px 的 title/desc 间距。

剩余的 `4px` 只有 `.cube` 内部（卡片 name → path → action），那是卡片内部排版，不是 title/desc 关系。

## 3. 非目标

- **不动字体、颜色、token。** 13/600、13/500、12/400 与三个 label token 全部保持。
- **不动横向间距**（`.row` gap 8、`.cubeRow` gap 8、`.rowText` padding-right 48）。
- **不动任何交互与门控逻辑。** 哪些控件受哪个开关控制完全不变。
- **不改 `.cube` / `.selector` / `.injectionText` 的尺寸与圆角。**

## 4. 已知取舍

**① 卡片顶从 28px 变 16px。** 加 `:first-child` 负边距之前，段 padding 16 会与首块的 12 叠加成 28。用户要求吸掉，因此加负边距。这与《规范》§2.3 只写 `:last-child` 不同——规范设想的首孩子是 `h3.heading`（margin 0），我们的首孩子永远带 padding，所以上下都要吸。**这是规范漏了、本设计补上的一条。**

**② 主开关关闭时是单段。** `groups.length === 0` 时面板只返回 ⑧、线 B 消失，串成「线 A → ⑧ → 线 C」。此时 ⑧ 同时吃 `:first-child` 与 `:last-child`，上下各吸 12，结构仍成立。

**③ 跨线间距从 32px 保持不变**（改动前也是 32），但**非跨线**从 32/40 统一到 24。

## 5. 验证

- `pnpm check` 全绿（现 890 条断言）。
- `probe-settings-card` / `probe-settings-injection-switches` 真机通过。
- **新增真机断言**：读取计算样式，断言 `.row` 的 `padding-top` 为 12px、`.group` 的 `gap` 为 6px、`.section` 的 `padding` 为 16px——否则这类纯视觉改动没有任何自动防线。
- 反向对照：把 `.group` gap 改回 8px，断言应当失败。

## 6. 留给实现者

- `.section` 的类名与放置（新类，还是复用某个现有类）。
- `injection-panel.tsx` 从 Fragment 改为 section 的具体写法（注意它内部还有 `<>{}</>` 条件分支）。
- 是否需要给 `:first-child` / `:last-child` 加 `> ` 直接子选择器（会同时命中嵌套结构，需实测确认没有意外命中）。
