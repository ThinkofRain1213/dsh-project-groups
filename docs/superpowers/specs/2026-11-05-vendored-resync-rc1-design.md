# vendored 树重同步至 DSH 0.2.2-rc.1

> 状态：待审
> 日期：2026-11-05
> 适用：`src/vendored/`、`package.json`、`cordis.patch.yml`、`scripts/`
> 基线：`dsh-v0.2.1-rc.3`（当前 vendored 版本）→ `dsh-v0.2.2-rc.1`（目标）

## 1. 意图

上游 `dsh-v0.2.2-rc.1` 已经发布，且用户的运行时**已实际升级**到该版本
（从 `app.asar` 内嵌 `package.json` 读到 `@deepseek-ai/dsh-desktop-runtime@0.2.2-rc.1`，
`cordis 4.1.0`）。本插件的 vendored 树仍停留在 `0.2.1-rc.3`，需要重同步。

**这次不是常规跟版**。上游对 `packages/client/ui-workspace` 做了结构性重写：

| 改动 | 性质 |
|---|---|
| Session 行菜单：Slot (`sidebar.workspaces.session.menu.item`) → `ctx.contextMenus` 结构化贡献 | 架构替换 |
| `AnimatedRows` 下沉到 `ui-primitives`，包内副本删除 | 代码搬家 |
| 对话框外提为 `WorkspaceDialogs.tsx`；注入面新增 `openWorkspaceMenu` / `settleWorkspaceAction` / `openSessionMenu` | 结构重排 |
| 新增 `path-suffix.ts` / `SessionMenu.tsx` / `context-menus.tsx` | 新增文件 |
| `locales.ts` 从 2 种语言扩到 8 种 | 体量增长 |

`rc.3 → rc.1` 该包合计 **+1689 / −813**（`src/` 范围 23 文件）。

## 2. 硬约束（用户定，不可让步）

> **不改动本项目功能能力，不导致插件有任何功能无法加载 / 缺失。**

**红线的范围已确认：「今天能跑的一切都不许退化」，README 的七项只是最低集。**

七项最低集（README「它做什么」）：

1. 项目分组（项目行 + 「未分组」桶）
2. 拖拽归类（项目之间 / 拖回未分组）
3. 项目增删改排（新建 / 重命名 / 删除 / 拖拽排序、标题唯一）
4. 新会话落点（项目行 ＋ / 未分组 ＋ / 顶栏按钮）
5. 搜索结果归属（显示所属**项目**）
6. 关联链接（只作标记，不拦截）
7. 注入预览（设置页显示真实注入内容）

**此外必须一并保住的行为**（今天有独立校验，不在七项字面内）：

- 底层工作区缺失对话框 + 重建流程（`BaseWorkspaceMissing.tsx`、`probe:base-workspace-*`）
- 默认工作区接管（`probe:default-workspace-takeover`）
- 设置页两个注入开关（`verify:project-injection`）
- 文档规范协商（`verify:doc-spec`）
- 目录 / 链接编辑（`verify:project-directories`）
- fork 继承项目（`verify:fork-inheritance`）

## 3. 方案（已与用户确认选 B）

### 备选与取舍

| 方案 | 做法 | 取舍 |
|---|---|---|
| A 最小兼容 | 只补契约缺口，菜单等继续 vendored 私有实现 | 工作量小，但每次上游动菜单都要重合并；与「1:1、可重复重同步」目标冲突 |
| **B 彻底跟随**（采纳） | 菜单层完全跟随上游 `ctx.contextMenus`；`ForkSession.tsx` / `SessionId.tsx` 随上游删除，功能并入结构化注册 | 改动面更大、验证成本更高；但**功能不变**，且未来上游动菜单时零合并成本 |
| C 重构去 vendoring | 试图不再 vendoring | **不可行**：`single slot already has a registration` 硬校验仍在，项目分组必须改写 browser |

用户明确选择 **B**：这次重同步不仅要跟平，还要把可剥离的维护成本永久降下来。

### B 的可行性依据（已核实）

1. **菜单剥离安全**：本插件对 `sidebar.workspaces.session.menu.item` 的全部引用都是
   **官方原装实现的透传**（pin / rename / fork / archive / session-id），
   七项自有能力**没有一项**挂在 Session 行菜单上。
2. **上游提供了稳定接缝**：`ui-context-menu/src/client/types.ts` 明示
   `External plugins extend this map with their own target families`，
   `MenuContribution` 提供 `id` / `target` / `order` / `observe` / `resolve` 完整契约。
3. **vendoring 仍是唯一路径**：`ui-slots` 的
   `single slot "..." already has a registration`、`slot "..." is already declared`
   等硬校验在 rc.1 **依然存在**；`ui-workspace` 仍然由 `apply` 亲自
   `new UiWorkspaceService(...)` 并 `ctx.slots.provideRoot(...)`。

### B 的三条工作线

**B-1 跟随上游（三方合并，功能不变）**

以 `dsh-v0.2.1-rc.3` 为 base、本插件树为 ours、`dsh-v0.2.2-rc.1` 为 theirs 做
`git merge-file`。差异现状（行级，对 rc.1 上游）：

| 文件 | 差异行 | 备注 |
|---|---:|---|
| `rows/WorkspaceBrowser.tsx` | 2394 | 60 处分组接缝，最大风险面 |
| `locales.ts` | 857 | 本插件新增的 project / baseMissing / link / directory 键须保留 |
| `index.ts` | 515 | 含菜单注册块（B-2 要改的部分） |
| `rows/WorkspaceBrowser.module.css` | 483 | `.groupDropTarget` / `.directory*` / `.link*` / `.baseMissing*` |
| `rows/Rows.tsx` | 421 | `sessionRowKey` / `groupDrop` / `kid` 分派 |
| `contract/slots.ts` | 391 | 本插件的 hooks 与 verbs |
| `navigation.ts` | 324 | `StartSessionSecondParameter` 联合类型必须保留 |
| `tree.ts` | 249 | `GroupSource` / `groupBySource` / `owningSourceKey` |
| `rows/Rows.module.css` | 144 | |
| `WorkspacePicker.tsx` | 30 | |
| `shortcuts.ts` | 18 | `projectModel` 第五参数 |
| `stores.ts` / `pin-order.ts` / `contract/toast.ts` | 0 | 无冲突，直接跟随 |

**B-2 剥离（本次的结构性改良）**

- 删除 vendored 的 `session-actions/ForkSession.tsx`、`session-actions/SessionId.tsx`
- 新增 `session-actions/context-menus.tsx`，照上游 `registerSessionMenus` 形态注册
- `index.ts` 移除对 `sidebar.workspaces.session.menu.item` 的 5 条注册，
  改为 `ctx.contextMenus.register(...)`
- `PinSession` / `RenameSession` / `ArchiveSession` 只保留 `...RowButton` 与对话框部分
- `contract/slots.ts` 的 `menuOpenStateFactory` 与 `SessionMenuItemProps`
  按上游保留（上游仍保留 legacy Slot 给外部 React 条目）

### B-2b locale 策略（已确认）

上游 rc.1 是 **8 种语言 × 119 键**，且类型约束写死：

```ts
en satisfies Record<WorkspaceKey, string>              // WorkspaceKey = keyof typeof zh
ja/es/fr/de/ru/pt satisfies Record<keyof typeof en, string>
```

本插件有 **40 个自有键**（`project.*` / `field.directories` / `link.*` /
`baseMissing.*` / `directory.*` 等）。若这 40 键进入 `zh`，6 种新语言各自都必须
补齐，凭空多出 240 条翻译。

**采纳方案 (b)：`locales.ts` 与上游 1:1（8 语言 × 119 键，逐字节对齐）；
40 个自有键放到本插件自己的模块，用 `ctx.locale.register('workspace', ...)`
的单语言无类型重载并入同一命名空间；ja/es/fr/de/ru/pt 按 fallback 链回退英文。**

理由：这是 B 方案「未来零合并成本」对 `locales.ts`（第二大冲突面，857 行差异）
真正兑现的唯一方式。

**已知代价（用户已接受）**：非中英文用户看到的项目文案会回退为英文。
这是**用户可见的退化**，须在 CHANGELOG 中明确登记。

**B-3 移植（必须做，否则动画失真）**

`AnimatedRows` 已移入 `ui-primitives`。本插件给它加的
`enteringKeys` / `onEnteringKeysDrawn` 两个 prop（用于「复用空白会话的新会话
也要淡入」）需要生效。**这是功能项**：丢失它会导致新会话入场动画缺失，
属于「功能缺失」，触碰第 2 节红线。

**已核实的约束**：`ui-primitives` 在 `tsdown.config.ts` 的 `PLATFORM_MODULES`
里，是 **external、由 shell 运行时提供**，本插件无法修改；上游
`AnimatedRows` 的内部成员（`armed` / `list` / `overlay` / `movements` /
`exits` / `readPositions` / `move`）全部是 `private`，子类化不可行。

**采纳方案 (a)：在 `src/vendored/` 保留一份本地 `AnimatedRows.tsx` + 其
`.module.css`。** 理由：`src/vendored/README.md` 已有「上游没有的文件」先例
（`BaseWorkspaceMissing.tsx`）；(b) 技术上不可行；(c) 改动面会扩散到第三处结构性
文件；(d) 等于放弃功能、违反红线。

**代价（须记录）**：本地副本与上游副本会长期并存，验收标准 3 的「补丁基线数字
应下降」会因此出现一个反向项；该文件需在 vendored README 中登记为
「长久保留的本地副本 + 漂移风险」。

### B-4 项目行菜单（新增，本次最大的接缝）

**问题**：上游 rc.1 的事件行拆成 `UngroupedProjectRow` / `WorkspaceProjectRow`，
菜单触发条件是

```ts
const workspaceMenuTarget = row.workspaceId !== undefined && row.cwd !== undefined
  ? { workspaceId: row.workspaceId, path: row.cwd } : undefined
```

而本插件的**项目行既没有 `workspaceId`，也没有 `cwd`**（项目是标签，不是目录）。
一次「干净的」三方合并会让项目行的整块菜单（重命名 / 删除 / 在文件夹显示）
**直接消失**，这触碰红线第 3 项。

**采纳方案 P1b：为本插件新增 `target: 'project'` 目标家族。**

依据：上游 `ui-context-menu/src/client/types.ts` 明示

```ts
/** External plugins extend this map with their own target families. */
export interface ContextMenuTargetMap { ... }
```

并在 `MenuAction` 上提供 `children?: readonly MenuAction[]`（已核实存在），
因此多目录可以展开为子菜单。

项目菜单形态：`重命名 / 在文件夹显示 ▸ (目录 A | 目录 B | ...) / 删除项目`。
0 个目录时不渲染「在文件夹显示」；1 个目录时直接可用；N 个目录时展开子菜单。
**不改动 `directories: z.array(z.string())` 的数据形状**——`src/spec.ts` 明确
否决过 primary/secondary 标记，不得为此留位。

**为什么不用官方 `target: 'workspace'`**：它的 `resolve` 从 `target.value.path`
取**唯一一个**目录。项目可以有 0 或 N 个目录，复用会导致多目录只显示第一个，
与项目模型冲突。

### B-5 新能力接收（rc.1 新增，随 B-2 自动获得）

用户在实机截图确认了 rc.1 新增的两个菜单项：

| 菜单项 | 注册方 | 目标 |
|---|---|---|
| 在文件夹显示（工作区菜单） | `ui-open-in-app` | `target: 'workspace'`，order 200 |
| 在文件夹显示（会话菜单） | `ui-open-in-app` → `session-reveal.tsx` | `target: 'session'`，order 500 |

**二者均不由 `ui-workspace` 提供**，而是独立插件经 `ctx.contextMenus.register`
注册。因此只要 B-2 把菜单接回 `contextMenus`，这两项会**自动出现**，本插件无需
为其写任何代码——这也反过来证明 B 方案正确：走 A（保留旧 Slot 私有实现）会
**永久丢失**这两个新版能力。

## 4. 已知风险与陷阱

1. **`ProjectRowItem` 命名冲突**。上游这个名字指 **Workspace 行**
   （拆为 `UngroupedProjectRow` / `WorkspaceProjectRow`），本插件用作**项目行**。
   三方合并会静默混淆，必须人工切分并加注释。

2. **`startSession` 第二参数是联合类型**。本插件把它做成
   `beforeOpen | StartSessionOptions`。rc.1 上游签名仍是 `startSession(workspaceId?, options?)`。
   若重同步时误还原为纯 `beforeOpen`，上游两个调用方（`ui-agent-preset`、
   `ui-entry-customization`）会**静默抛错**——会话先创建、错误后抛。

3. **`engines.dsh` 不会拦下 rc.1**。现有范围 `>=0.2.1-rc.2 <0.2.2`，
   而 `0.2.2-rc.1 < 0.2.2`（预发布低于正式段），实测 `satisfies(...) === true`。
   也就是说：**契约不匹配时插件会照常加载，然后静默失效**。
   不能依赖兼容性检查兜底，必须靠 `pnpm check` 主动验证。

4. **`node_modules` 必须重装**。历史记录：留着旧 `node_modules` 直接 `pnpm install`
   会让两版包同时解析，导致 `tsc` 报 `RemoteFailure` / `$ZodCheck` 类型不匹配。
   本次依赖跨 `0.2.1-rc.3 → 0.2.2-rc.1`，同样必须删除后重装。

5. **`zod` 必须精确 `4.4.3`**（不加 caret）。DSH 自家包对 zod 是精确钉死，
   带 caret 会解析出第二份副本。

6. **`cordis` 跨次版本线**：`4.0.5 → 4.1.0`。已核实本插件只用公开的
   `ctx.effect` / `ctx.inject` / `ctx.get`，不碰内部 API（`.store` 的 6 处命中
   均为 React store，`epoch` 3 处均为时间戳）。但 `4.1.0` 有条行为变更：
   **失败的 fiber 需显式 `update()` 才能恢复**，影响开发期热重载体验。

## 5. 验收标准

1. **`pnpm check` 全绿**。实测该链条为 **16 个 `verify:*` + 8 个探针**
   （`typecheck` → `build` → 16 个 verify → `verify:host-import` → `pnpm probe`
   的 7 个脚本）。仓库共定义 17 个 `verify:*`，其中 `verify:bundles` 不在
   `check` 链内，需单独跑。

2. **红线逐条实测**（见第 2 节）：七项最低集 + 六项附加行为，在 rc.1 上全部可用。

3. **真机探针针对性抽查**。仓库共 62 个 `probe-*.mjs`，其中约 52 个需要真机
   DSH + Electron + playwright，不在 `pnpm check` 内。按七项能力各自的代表性
   探针抽查，不要求全部跑通。**理由**：红线要求的是「功能不缺失」，
   而非「旧 DOM 结构不变」；UI 重写后旧探针断言的实现细节本就应当变化。

4. **补丁基线重新测量并写回 `src/vendored/README.md`**。当前基线：
   10 文件 / 108 编辑 / 200 hunk / +4011 −192。

   **实测结果与最初的预期相反，须如实记录**：rc.1 基线为
   **11 文件 / 200 hunk / +4538 −198**，`Added` 反而上升。
   原因是上游对 `ui-workspace` 做了结构性重写（`index.ts` 从 17 → 29 hunk，
   菜单注册整块搬进 `contextMenus`），补丁要在新结构上重新落位；这不是
   B-2 剥离失效，而是重写型同步的固有结果。

   因此本条的验收判据改为：**数字必须可复现**（`git diff --no-index --numstat`
   逐文件可重算，实现与复核两方独立算出同一个 `4538 / 198`），
   **而不是必须下降**。`Edits` 列已删除——该口径无任何机械阈值可复现
   已发布的 10 个数字（最好只对 6/10），发布不可验证的数字比删掉更糟；
   `Hunks / Added / Removed` 成为唯一计数口径。

   `AnimatedRows` 本地副本在表中单独标注（它已不属于 `ui-workspace`，
   对 rc.1 无 patch 可言）——见 B-3。

5. **`engines.dsh` 收紧为 `>=0.2.2-rc.1 <0.2.3`**（见第 4 节风险 3）。

## 5b. 版本与兼容策略（已确认）

一份 vendored 树**不可能同时匹配两条线**：rc.1 形状的树会调用
`ctx.contextMenus`，而该服务在 0.2.1 线根本不存在（`ui-context-menu` 是 0.2.2
新增包）。因此「覆盖」只能是**替换**为 `>=0.2.2-rc.1 <0.2.3`。

**这意味着 0.2.1-rc.x 上的用户会被直接拒绝加载。** 这是预期的破坏性变更：

- 版本号 **0.3.4 → 0.4.0**（次版本跃迁，反映破坏性变更）
- CHANGELOG 必须写明迁移说明与最低 DSH 版本
- 收紧 `engines.dsh` 是**唯一**能让 0.2.1 用户不落入「装了、加载了、静默失效」
  的手段——因为现有的 `>=0.2.1-rc.2 <0.2.2` 范围对 `0.2.2-rc.1` 实测
  `satisfies() === true`，兼容性检查根本拦不住（见风险 3）

## 6. 留给执行者的部分

- 三方合并的具体冲突解法（逐文件判断，文档给出判据但不预写结论）
- `pnpm-workspace.yaml` 的 release-age 豁免清单更新
- `vite`/`tsdown` 侧若有 specifier 分类需同步的，按实际报错调整
- 每个 probe 脚本与新 UI 的适配改法

## 7. 分阶段建议

| 阶段 | 内容 | 产出 |
|---|---|---|
| 1 | 依赖与锁文件重建（先行，先让工具链能跑） | `pnpm install` 通过、`typecheck` 可执行 |
| 2 | B-1 三方合并（12 个文件） | 代码跟到 rc.1，接缝重新落位 |
| 3 | B-2 菜单剥离 + B-2b locale 拆分 | 菜单改走 `contextMenus`，两文件删除，40 键独立注入 |
| 4 | **B-4 项目行菜单（`target: 'project'`）** | 项目行的重命名 / 删除 / 多目录 reveal 恢复 |
| 5 | B-3 `AnimatedRows` 本地副本 | 新会话入场动画恢复 |
| 6 | 校验与基线更新 | `pnpm check` 全绿、红线实测、README 基线 |

阶段 1 先行的理由：工具链不通时，后续任何验证都无法执行，合并质量无从判断。

**阶段 4 必须在阶段 5 之前**：项目行菜单是红线第 3 项的直接载体，
是本轮最大的功能风险点，应当在动画这类次要项之前先落地并验证。
