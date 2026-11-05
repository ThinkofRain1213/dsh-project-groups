# vendored 树重同步至 DSH 0.2.2-rc.1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `src/vendored/` 从 DSH `0.2.1-rc.3` 同步到 `0.2.2-rc.1`，同时保持本插件今天所有可用功能不退化。

**Architecture:** 以 `dsh-v0.2.1-rc.3` 为 base、本插件树为 ours、`dsh-v0.2.2-rc.1` 为 theirs 做逐文件三方合并；随后把 Session 行菜单从私有 Slot 实现改为跟随上游的 `ctx.contextMenus` 结构化贡献，并为项目行新增独立的 `target: 'project'` 菜单目标家族。

**Tech Stack:** TypeScript / React 18 / Cordis 4.1.0 / tsdown / pnpm 11 / Playwright（真机探针）

**Spec:** `docs/superpowers/specs/2026-11-05-vendored-resync-rc1-design.md`

## Global Constraints

- `engines.dsh` 最终值：`>=0.2.2-rc.1 <0.2.3`
- `peerDependencies['@deepseek-ai/cordis']` 最终值：`^4.1.0`
- `peerDependencies['@deepseek-ai/dsh-storage']` / `dsh-storage-domain` / `dsh-typert-protocol` 最终值：`>=0.2.2-rc.1 <0.2.3`
- `zod` 必须精确 `4.4.3`（无 caret）
- 所有 `devDependencies` 的 `@deepseek-ai/dsh-*` 跟随到 `0.2.2-rc.1`
- 版本号 `0.3.4` → `0.4.0`
- **红线：不得导致任何今天可用的功能无法加载或缺失**
- 项目 `directories` 数据形状保持 `z.array(z.string()).default([])`，**不得**引入 primary/secondary 标记

## Review Focus

- **零目录项目**：项目行菜单点开时，「在文件夹显示」必须不渲染（或禁用），且菜单仍能正常打开、重命名与删除可用。
- **多目录项目**：项目行菜单的「在文件夹显示」必须展开出与 `directories` 等长的子项，顺序与存储顺序一致。
- **`startSession` 第二参数误还原为纯 `beforeOpen`**：上游 `ui-agent-preset` / `ui-entry-customization` 会静默抛错（会话已创建、错误后抛）。必须由 `verify:new-session` 的断言 12/13 钉住。
- **`ProjectRowItem` 命名冲突**：上游该名指 Workspace 行，本插件用作项目行；合并后若混淆，项目行会渲染出 Workspace 行的行为（或在无 `workspaceId` 时不渲染菜单）。
- **非中英文 locale 的项目文案**：`ja/es/fr/de/ru/pt` 下项目相关键回退英文，不得渲染为空白或 `undefined`。

---

## 文件结构

### 新建

| 文件 | 职责 |
|---|---|
| `src/vendored/client/session-actions/context-menus.tsx` | Session 行菜单的结构化注册（跟随上游） |
| `src/client/project-menu.ts` | 项目行菜单的 `target: 'project'` 注册与 `ContextMenuTargetMap` 扩展 |
| `src/client/locales-project.ts` | 40 个项目自有 locale 键（与 vendored `locales.ts` 分离） |
| `scripts/verify-project-menu.mjs` | 项目行菜单的零目录/单目录/多目录三态校验 |

### 修改

| 文件 | 改动 |
|---|---|
| `package.json` | engines / peers / devDeps / version |
| `pnpm-workspace.yaml` | release-age 豁免清单重建 |
| `src/vendored/client/locales.ts` | 与上游逐字节 1:1，移除 40 个自有键 |
| `src/vendored/client/session-actions/{Pin,Rename,Archive}Session.tsx` | 移除 MenuItem 部分，保留 RowButton 与对话框 |
| `src/vendored/client/rows/Rows.tsx` | 合并上游 + 项目行菜单改走 `contextMenus` |
| `src/vendored/client/rows/WorkspaceBrowser.tsx` | 合并上游 60 处接缝 + 项目行菜单目标 |
| `src/vendored/client/index.ts` | 移除 5 条 menu.item 注册，改 `contextMenus` |
| `src/client/index.ts` | 接入 project menu 注册与 locale 拆分 |

### 删除

| 文件 | 理由 |
|---|---|
| `src/vendored/client/session-actions/ForkSession.tsx` | 上游已删，功能并入 `context-menus.tsx` |
| `src/vendored/client/session-actions/SessionId.tsx` | 同上 |

### 保留（上游已删，本插件保留）

| 文件 | 理由 |
|---|---|
| `src/vendored/client/rows/AnimatedRows.tsx` + `.module.css` | `ui-primitives` 为 external 且内部成员 private，无法修改也无法子类化 |
| `src/vendored/client/session-actions/BaseWorkspaceMissing.tsx` | 本插件独有功能 |

---

## Task 1: 依赖与锁文件重建

**Files:**
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`
- Rebuild: `pnpm-lock.yaml`（删除后重生成）

**Interfaces:**
- Consumes: 无
- Produces: 可执行的 `pnpm typecheck` / `pnpm build` 工具链

- [ ] **Step 1: 删除 node_modules 与锁文件**

```bash
cd "C:/Users/Think/Desktop/项目/dsh-project-groups"
rm -rf node_modules pnpm-lock.yaml
```

理由：历史记录表明留着旧 `node_modules` 直接 `pnpm install` 会让两版包同时解析，
导致 `tsc` 报 `RemoteFailure` / `$ZodCheck` 类型不匹配。

- [ ] **Step 2: 更新 `package.json` 的版本与依赖**

按下表替换（`zod` 保持精确 `4.4.3`，不加 caret）：

```jsonc
"version": "0.4.0",
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.1.0",
  "@deepseek-ai/dsh-storage": ">=0.2.2-rc.1 <0.2.3",
  "@deepseek-ai/dsh-storage-domain": ">=0.2.2-rc.1 <0.2.3",
  "@deepseek-ai/dsh-typert-protocol": ">=0.2.2-rc.1 <0.2.3",
  "zod": "4.4.3"
},
"engines": { "node": "^22.19.0 || >=24.0.0", "dsh": ">=0.2.2-rc.1 <0.2.3" }
```

`devDependencies` 中全部 `@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis` 改为
`0.2.2-rc.1` / `4.1.0`。新增
`"@deepseek-ai/dsh-client-ui-context-menu": "0.2.2-rc.1"`。

`dsh.client.inject` 数组追加 `"@deepseek-ai/dsh-client-ui-context-menu"`。

- [ ] **Step 3: 重建 `pnpm-workspace.yaml` 的豁免清单**

`minimumReleaseAgeExclude` 必须覆盖 `pnpm install` 会解析的**每一个**
`@deepseek-ai/dsh-*` 包，且版本号与新的 lockfile 一致。运行 install 后，
按 pnpm 的 release-age 报错逐个补齐，再排序使其稳定。

- [ ] **Step 4: 安装并验证工具链可执行**

```bash
pnpm install
pnpm typecheck
```

Expected: install 成功；typecheck 能执行（此时允许因源码未合并而报错，
但**不允许**出现 `$ZodCheck` / `RemoteFailure` 这类"两份包"症状）。

- [ ] **Step 5: 提交**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "chore(deps): 跟进 DSH 0.2.2-rc.1，重建锁文件与 release-age 豁免"
```

---

## Task 2: 三方合并 vendored 树

**Files:**
- Modify: `src/vendored/client/tree.ts`
- Modify: `src/vendored/client/locales.ts`
- Modify: `src/vendored/client/shortcuts.ts`
- Modify: `src/vendored/client/navigation.ts`
- Modify: `src/vendored/client/contract/slots.ts`
- Modify: `src/vendored/client/index.ts`
- Modify: `src/vendored/client/rows/Rows.tsx`
- Modify: `src/vendored/client/rows/WorkspaceBrowser.tsx`
- Modify: `src/vendored/client/rows/{Rows,WorkspaceBrowser}.module.css`
- Modify: `src/vendored/client/WorkspacePicker.tsx`
- Create: `src/vendored/client/path-suffix.ts`
- Create: `src/vendored/client/rows/WorkspaceDialogs.tsx`
- Create: `src/vendored/client/session-actions/{SessionMenu.tsx,context-menus.tsx}`

**Interfaces:**
- Consumes: Task 1 的工具链
- Produces: 与 rc.1 对齐的 vendored 树，保留全部本插件接缝；
  `locales.ts` 仅含上游 8 语言 × 119 键（本插件自有键移出，见 Task 3）

- [ ] **Step 1: 准备三方合并基线**

```bash
cd "C:/Users/Think/Desktop/项目/deepseek-harness"
git archive dsh-v0.2.1-rc.3 packages/client/ui-workspace/src | tar -x -C /tmp/base-rc3
git archive dsh-v0.2.2-rc.1 packages/client/ui-workspace/src | tar -x -C /tmp/theirs-rc1
```

- [ ] **Step 2: 逐文件三方合并（除 locales.ts）**

对下列 11 个文件执行 `git merge-file`，base 用 rc.3、theirs 用 rc.1：

```
tree.ts  shortcuts.ts  navigation.ts  contract/slots.ts  index.ts
rows/Rows.tsx  rows/WorkspaceBrowser.tsx
rows/Rows.module.css  rows/WorkspaceBrowser.module.css
WorkspacePicker.tsx  WorkspacePicker.module.css
```

`stores.ts` / `pin-order.ts` / `contract/toast.ts` 三方一致，直接覆盖为上游版本。

- [ ] **Step 3: 吸收 4 个上游新文件**

`path-suffix.ts`、`rows/WorkspaceDialogs.tsx`、`session-actions/SessionMenu.tsx`、
`session-actions/context-menus.tsx` 按上游原样收入。

- [ ] **Step 4: 人工切开 `ProjectRowItem` 命名冲突**

上游 `Rows.tsx` 的 `ProjectRowItem` 指 **Workspace 行**（拆为
`UngroupedProjectRow` / `WorkspaceProjectRow`）；本插件的 `ProjectRowItem`
指 **项目行**。合并后必须：

- 保留上游的 `ProjectRowItem` / `UngroupedProjectRow` / `WorkspaceProjectRow`
  三件套，语义为 Workspace 行
- 本插件的项目行渲染函数改名为 `ProjectGroupRowItem`，并在文件头注释写明
  与上游同名函数的区别

- [ ] **Step 5: 验证联合类型与接缝仍在**

```bash
grep -n "StartSessionSecondParameter" src/vendored/client/navigation.ts
grep -c "groupingOverride\|orderedProjects\|isCallerOwned\|overGroupKey" src/vendored/client/rows/WorkspaceBrowser.tsx
```

Expected: 前者命中联合类型定义与其 dispatch；后者计数 > 0（60 处接缝仍在）。

- [ ] **Step 6: 提交**

```bash
git add src/vendored/
git commit -m "refactor(vendored): 三方合并至 DSH 0.2.2-rc.1"
```

---

## Task 3: 剥离 Session 行菜单到 contextMenus

**Files:**
- Delete: `src/vendored/client/session-actions/ForkSession.tsx`
- Delete: `src/vendored/client/session-actions/SessionId.tsx`
- Modify: `src/vendored/client/session-actions/PinSession.tsx`
- Modify: `src/vendored/client/session-actions/RenameSession.tsx`
- Modify: `src/vendored/client/session-actions/ArchiveSession.tsx`
- Modify: `src/vendored/client/index.ts`

**Interfaces:**
- Consumes: Task 2 的 `context-menus.tsx`
- Produces: `registerSessionMenus(ctx, actions)` 已接入；`index.ts` 不再注册
  `sidebar.workspaces.session.menu.item`

- [ ] **Step 1: 删除两个已被上游并入 contextMenus 的文件**

```bash
git rm src/vendored/client/session-actions/ForkSession.tsx
git rm src/vendored/client/session-actions/SessionId.tsx
```

- [ ] **Step 2: 三个 Session 文件只保留 RowButton 与对话框**

`PinSession.tsx` / `RenameSession.tsx` / `ArchiveSession.tsx` 移除各自的
`...MenuItem` 导出（pin / rename / archive 的菜单行），保留：

- `PinSessionRowButton`
- `SessionRenameDialog`
- `ArchiveSessionRowButton` / `SessionArchiveConfirmDialog`

- [ ] **Step 3: `index.ts` 改为结构化注册**

移除 `ctx.slots.inject('sidebar.workspaces.session.menu.item', ...)` 整个块
（现有 5 条 `ctx.slots.register`，id 为 `pin` / `rename` / `fork` / `archive` /
`session-id`），改为在 `apply` 内调用：

```ts
registerSessionMenus(ctx, {
  pinSession, unpinSession, forkSession, archiveSession, unarchiveSession,
  requestSessionRename, copySessionId,
})
```

传入的六个 action 取自 `index.ts` 中已有的同名实现。

- [ ] **Step 4: 运行校验**

```bash
pnpm typecheck && pnpm verify:client-seats
```

Expected: PASS。`sidebar.workspaces.session.menu.item` 的注册数应为 0。

- [ ] **Step 5: 提交**

```bash
git add -A src/vendored/client/session-actions src/vendored/client/index.ts
git commit -m "refactor(vendored): Session 行菜单改为 ctx.contextMenus 结构化注册"
```

---

## Task 4: 拆分项目自有 locale 键

**Files:**
- Create: `src/client/locales-project.ts`
- Modify: `src/vendored/client/locales.ts`
- Modify: `src/client/index.ts`
- Modify: `scripts/verify-locales.mjs`

**Interfaces:**
- Consumes: Task 2 的 `locales.ts`
- Produces: `PROJECT_LOCALE_ZH` / `PROJECT_LOCALE_EN`（`Record<string, string>`）；
  运行时以单语言重载并入 `workspace` 命名空间

- [ ] **Step 1: 让 `locales.ts` 与上游逐字节一致**

```bash
diff <(git -C "C:/Users/Think/Desktop/项目/deepseek-harness" show dsh-v0.2.2-rc.1:packages/client/ui-workspace/src/client/locales.ts) src/vendored/client/locales.ts
```

Expected: 无输出（逐字节一致）。40 个自有键必须已移到 Task 4 的新文件。

- [ ] **Step 2: 新建 `src/client/locales-project.ts`**

导出两个常量，键为原先从 `locales.ts` 移出的 40 个键
（`project.*` / `field.directories` / `field.links` / `link.*` /
`baseMissing.*` / `directory.*` / `create` / `save` / `edit.project*` 等）：

```ts
export const PROJECT_LOCALE_ZH: Readonly<Record<string, string>> = { /* 40 键 */ }
export const PROJECT_LOCALE_EN: Readonly<Record<string, string>> = { /* 40 键 */ }
```

- [ ] **Step 3: 在 `src/client/index.ts` 注册并入命名空间**

在现有 `ctx.locale.register(SETTINGS_NS, ...)` 附近，追加：

```ts
ctx.effect(() => ctx.locale.register(NS, 'zh', PROJECT_LOCALE_ZH), 'project-groups: project copy zh')
ctx.effect(() => ctx.locale.register(NS, 'en', PROJECT_LOCALE_EN), 'project-groups: project copy en')
```

其中 `NS` 为 `'workspace'`（与 vendored 树同一命名空间）。使用**单语言重载**
而非整表注册，以免触发 `Record<keyof typeof en, string>` 的全量类型约束。

- [ ] **Step 4: 扩展 `verify-locales.mjs` 覆盖拆分后的两个来源**

该校验当前从 `src/` 递归读源并比对语言间键的 parity。新文件引入后需让
parity 检查同时覆盖 `locales-project.ts`，且**允许** `PROJECT_LOCALE_*`
只存在 zh/en 两语（6 语言回退英文是已接受的决策）。

具体改动：在收集"语言 → 键集合"时把 `locales-project.ts` 的 zh/en 并入
对应集合；对 `ja/es/fr/de/ru/pt` 的 parity 检查排除项目自有键。

- [ ] **Step 5: 运行校验**

```bash
pnpm verify:locales
```

Expected: PASS，且报告不再把 40 个项目键判为 `zh` 独有。

- [ ] **Step 6: 提交**

```bash
git add src/client/locales-project.ts src/client/index.ts src/vendored/client/locales.ts scripts/verify-locales.mjs
git commit -m "refactor(locale): 项目自有文案与官方字典分离，6 语言回退英文"
```

---

## Task 5: 项目行菜单（target: 'project'）

**Files:**
- Create: `src/client/project-menu.ts`
- Modify: `src/vendored/client/rows/Rows.tsx`
- Modify: `src/vendored/client/contract/slots.ts`
- Modify: `src/client/index.ts`
- Create: `scripts/verify-project-menu.mjs`

**Interfaces:**
- Consumes: Task 4 的 locale 键；Task 2 的 `GroupNode` / `GroupSource`
- Produces:
  - `declare module '@deepseek-ai/dsh-client-ui-context-menu/client'` 扩展：
    `project: { readonly projectId: string; readonly title: string; readonly directories: readonly string[] }`
  - `registerProjectMenu(ctx, actions: ProjectMenuActions): void`
  - `ProjectMenuActions` = `{ rename(id: string): void; remove(id: string): void; reveal(path: string): Promise<void> }`
  - `src/vendored` 侧新增注入面 `openProjectMenu`

- [ ] **Step 1: 写失败测试**

新建 `scripts/verify-project-menu.mjs`，断言三个状态的菜单项：

```js
// 零目录：不应产出 reveal 动作
assert.equal(actionsFor({ directories: [] }).some(a => a.id === 'reveal'), false)
// 单目录：reveal 直接可用，且不可有 children
const one = actionsFor({ directories: ['C:/a'] }).find(a => a.id === 'reveal')
assert.equal(one.children, undefined)
// 多目录：children 长度与 directories 一致且顺序相同
const many = actionsFor({ directories: ['C:/a', 'C:/b', 'C:/c'] }).find(a => a.id === 'reveal')
assert.deepEqual(many.children.map(c => c.label), ['C:/a', 'C:/b', 'C:/c'])
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node scripts/verify-project-menu.mjs
```

Expected: FAIL（`project-menu.ts` 尚不存在）。

- [ ] **Step 3: 实现 `src/client/project-menu.ts`**

按 Interfaces 的签名实现。`resolve` 的顺序固定为
`rename(100) / reveal(200) / remove(300)`，其中 `remove` 设 `danger: true`
与 `separatorBefore: true`。`reveal` 的动作构造：

- `directories.length === 0` → 不产出该动作
- `directories.length === 1` → 单个 action，`run: () => actions.reveal(d[0])`
- `directories.length > 1` → 一个 action，`children` 为每个目录一项，
  `id: 'reveal:' + index`，`label` 为目录原文

- [ ] **Step 4: 扩展 `ContextMenuTargetMap` 并在 `Rows.tsx` 触发**

在 `project-menu.ts` 顶部加：

```ts
declare module '@deepseek-ai/dsh-client-ui-context-menu/client' {
  interface ContextMenuTargetMap {
    project: { readonly projectId: string; readonly title: string; readonly directories: readonly string[] }
  }
}
```

在项目行渲染处（Task 2 Step 4 改名后的 `ProjectGroupRowItem`）绑定触发器：

```ts
const trigger = getTriggerProps({ kind: 'project', value: {
  projectId: group.key, title: group.label, directories: group.directories ?? [],
} })
```

并把项目行菜单按钮的 `onClick` 从旧的 `setMenuOpen` 改为
`openProjectMenu(...)`（经 `inject` 面注入，形态参照上游
`openWorkspaceMenu`）。

- [ ] **Step 5: 运行测试确认通过**

```bash
node scripts/verify-project-menu.mjs
```

Expected: PASS（三态全部通过）。

- [ ] **Step 6: 提交**

```bash
git add src/client/project-menu.ts scripts/verify-project-menu.mjs src/vendored/client/rows/Rows.tsx src/vendored/client/contract/slots.ts src/client/index.ts
git commit -m "feat(menu): 项目行新增 target: project 菜单，支持零/单/多目录"
```

---

## Task 6: AnimatedRows 本地副本

**Files:**
- Keep: `src/vendored/client/rows/AnimatedRows.tsx`
- Keep: `src/vendored/client/rows/AnimatedRows.module.css`
- Modify: `src/vendored/client/rows/WorkspaceBrowser.tsx`

**Interfaces:**
- Consumes: Task 2 合并后的 `WorkspaceBrowser.tsx`
- Produces: 新会话入场淡入恢复；`AnimatedRows` 从 vendored 本地导入而非
  `ui-primitives`

- [ ] **Step 1: 确认两个文件仍在且被本地导入**

```bash
ls src/vendored/client/rows/AnimatedRows.tsx src/vendored/client/rows/AnimatedRows.module.css
grep -n "from './AnimatedRows.tsx'" src/vendored/client/rows/WorkspaceBrowser.tsx
```

Expected: 两个文件存在；`WorkspaceBrowser.tsx` 从本地路径导入，**不是**
从 `@deepseek-ai/dsh-client-ui-primitives`。

若合并后导入已变成 `ui-primitives`，改回本地导入。

- [ ] **Step 2: 保留两个本插件专属 prop**

`AnimatedRows` 的 `enteringKeys` / `onEnteringKeysDrawn` 必须仍在本地副本中，
且 `WorkspaceBrowser` 仍传入它们。

```bash
grep -n "enteringKeys\|onEnteringKeysDrawn" src/vendored/client/rows/AnimatedRows.tsx src/vendored/client/rows/WorkspaceBrowser.tsx
```

Expected: 两个文件都有命中。

- [ ] **Step 3: 提交**

```bash
git add src/vendored/client/rows/
git commit -m "chore(vendored): 保留 AnimatedRows 本地副本以维持新会话入场动画"
```

---

## Task 7: 全量校验与基线更新

**Files:**
- Modify: `scripts/verify-release.mjs`
- Modify: `src/vendored/README.md`
- Modify: `CHANGELOG.md`
- Modify: `README.md`（若安装说明涉及版本）
- Rebuild: `lib/`（`pnpm build` 产物）

**Interfaces:**
- Consumes: Task 1–6 的全部产出
- Produces: 可发布的 0.4.0

- [ ] **Step 0: 修正 `scripts/verify-release.mjs` 第 8 节的过时断言**

该脚本第 8 节硬编码了 rc.3 时期的前提，与新 `engines.dsh` 范围直接冲突：

```js
// 现状（过时）
expectCompat('区间下限覆盖 DSH 0.2.1-rc.2（当前唯一验证过的运行时）', '0.2.1-rc.2', true)
expectCompat('拒绝 0.2.1-rc.1（未验证的旧版本）', '0.2.1-rc.1', false)
expectCompat('拒绝 0.2.2（未验证的新版本，re-sync 前不该放行）', '0.2.2', false)
expectCompat('拒绝 0.3.0（下一个次版本）', '0.3.0', false)
```

改为针对新范围 `>=0.2.2-rc.1 <0.2.3`：

```js
expectCompat('区间下限覆盖 DSH 0.2.2-rc.1（当前唯一验证过的运行时）', '0.2.2-rc.1', true)
expectCompat('拒绝 0.2.1-rc.3（旧版本，本轮已放弃支持）', '0.2.1-rc.3', false)
expectCompat('拒绝 0.2.2（未验证的正式版，rc 线不自动放行）', '0.2.2', false)
expectCompat('拒绝 0.3.0（下一个次版本）', '0.3.0', false)
```

**注意**：`0.2.2` 必须仍然拒绝——`>=0.2.2-rc.1 <0.2.3` 在语义化版本下**不含** `0.2.2`（预发布段与会话），此断言验证的正是这一点。

验证：`pnpm verify:release` 全绿（CHANGELOG 段落此时可能仍红，见 Step 4）。

- [ ] **Step 1: 跑通 `pnpm check`**

```bash
pnpm check
```

Expected: 全部 PASS。该链条为 `typecheck` → `build` → **16 个 `verify:*`** →
`verify:host-import` → `pnpm probe`（7 个脚本）。
（仓库共定义 17 个 `verify:*`，其中 `verify:bundles` 不在 `check` 链内，见 Step 2。）

- [ ] **Step 2: 跑 `verify:bundles`（不在 check 链内，但 CI 会跑）**

```bash
pnpm verify:bundles
```

Expected: PASS。**此步必须在 Step 3 重建 `lib/` 之后才能通过**——依赖升级改变了
`.pnpm` 虚拟目录哈希，已提交的 `lib/` 里内联着旧哈希路径串，`pnpm build` 会重写它们。

CI（`.github/workflows/validate.yml:94`、`publish.yml:146`）会跑这条断言，
不通过则发布被拦。

- [ ] **Step 3: 重建 `lib/` 并提交**

```bash
pnpm build
git add lib/
git commit -m "chore(build): 依赖升级后重建 lib 产物"
```

**顺序要求**：必须在 Task 2–6 的全部源码改动完成后执行，否则会被后续源码改动再次弄脏。
`lib/` 是 git 追踪的构建产物，`verify:bundles` 断言它与其 source 同步。

- [ ] **Step 4: 红线逐条实测**

按 spec 第 2 节列出的七项最低集 + 六项附加行为，在运行中的 rc.1 上逐条验证。
对每一条记录：操作步骤、预期、实际。**任何一条不通过都不得发布。**

- [ ] **Step 5: 重新测量补丁基线**

```bash
# 对每个 patched 文件统计 edits / hunks / added / removed
diff -U0 /tmp/theirs-rc1/packages/client/ui-workspace/src/client/<file> \
     src/vendored/client/<file> | ...
```

把结果表写回 `src/vendored/README.md`，替换旧的
「10 文件 / 108 编辑 / 200 hunk / +4011 −192」。`AnimatedRows.*` 作为
「本地保留副本」单独成行并注明漂移风险。

- [ ] **Step 6: 更新 CHANGELOG**

新增 `## [0.4.0] — 2026-11-05` 段，必须包含：

- **破坏性**：最低 DSH 版本升至 `0.2.2-rc.1`，0.2.1-rc.x 将被拒绝加载
- **新增**：项目行菜单支持多目录「在文件夹显示」（子菜单）
- **新增**：随上游获得工作区与会话菜单的「在文件夹显示」
- **变更**：Session 行菜单改由 `ctx.contextMenus` 提供
- **已知退化**：`ja/es/fr/de/ru/pt` 下项目文案回退英文

- [ ] **Step 7: 提交**

```bash
git add src/vendored/README.md CHANGELOG.md README.md
git commit -m "docs: 记录 0.4.0 的破坏性变更、新能力与补丁基线"
```

---

## Self-Review

**Spec 覆盖检查**（对照 spec 各节）：

| Spec 节 | 对应 Task |
|---|---|
| 2 硬约束 / 红线 | Task 7 Step 2 逐条实测 |
| 3 B-1 三方合并 | Task 2 |
| 3 B-2 菜单剥离 | Task 3 |
| 3 B-2b locale 策略 | Task 4 |
| 3 B-4 项目行菜单 | Task 5 |
| 3 B-5 新能力接收 | Task 3（走 contextMenus 后自动获得）+ Task 7 Step 4 记录 |
| 3 B-3 AnimatedRows | Task 6 |
| 4 风险 1 ProjectRowItem 冲突 | Task 2 Step 4 |
| 4 风险 2 startSession 联合类型 | Task 2 Step 5 + Review Focus |
| 4 风险 3 engines.dsh 拦不住 | Task 1 Step 2 收紧范围 |
| 4 风险 4/5 node_modules + zod | Task 1 Step 1 / Step 2 |
| 4 风险 6 cordis 跨线 | Task 1 Step 2 |
| 5 验收 1 pnpm check | Task 7 Step 1 |
| 5 验收 2 红线实测 | Task 7 Step 2 |
| 5 验收 3 真机探针抽查 | Task 7 Step 2（随红线一起验） |
| 5 验收 4 基线更新 | Task 7 Step 3 |
| 5 验收 5 engines 收紧 | Task 1 Step 2 |
| 5b 版本 0.4.0 + CHANGELOG | Task 1 Step 2 / Task 7 Step 4 |

**Review Focus 的测试归属**：五个失败模式分别由 Task 5 Step 1（零/多目录）、
Task 2 Step 5（联合类型）、Task 2 Step 4（命名冲突）、Task 4 Step 5
（locale 回退）的断言覆盖。

**类型一致性**：`ProjectMenuActions` 的三个方法名在 Task 5 的 Interfaces 与
Step 3 的实现描述中一致；`openProjectMenu` 在 Interfaces 与 Step 4 中一致。
