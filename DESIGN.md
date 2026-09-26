# DSH 项目分组插件 — 架构设计

> 状态：设计定案（已转向 **fork 官方组件** 路线）
> 版本：v2.0 · 2026-09-26
> 适用 DSH：0.1.7-rc.2（运行时实测版本）
> 定位：可发布的社区插件（`dsh-project-groups`）
> 交付方式：分 6 层（L0–L5），每层独立可交付、可回退（见 §5）

---

## 0. 重要变更：路线改为 fork 官方组件

**v1.1 曾主张"只换数据源、官方界面 1:1 保留"（B 方案）。该主张已被证伪。**

用发行版真实的 `SlotCore` 与 `cordis` 跑了探针，B 的三条实现路径全部被显式不变式封死
（复现脚本：`scripts/probe-approach-b.mjs`、`probe-slots.mjs`、`probe-service.mjs`）：

| 路径 | 结果 |
|---|---|
| 替换 root hook `useWorkspaces` | ❌ `provideRoot` 用 `copyUnique` 拒绝重复的 root standard 属性名（`useWorkspaces`） |
| 替换 `workspaces` 服务 | ❌ `provide "has been registered at <official>"`；`set "cannot set property in multiple fibers"` |
| 遮蔽主槽位后再声明官方子槽位 | ❌ `slot "…session.menu.item" is already declared`；且 `renderSlot` 逐 entry 授权，替代者也无权渲染 |

**因此 v2.0 改为：把官方 client 源码整个 vendor 进来，禁用官方插件行，自己持有这份界面。**
这样官方 UI 真正 1:1，且后续改动落在我们自己的代码里。

- vendor 来源：`dsh-v0.1.7-rc.2`（`477b4f420`），`packages/client/ui-workspace/src/`
- vendor 内容：22 个文件，**与上游逐字节一致**（哈希比对已验证）
- 适配全部在 vendor 之外（`src/client/index.ts` 再导出、`tsdown.config.ts` 打包规则、`cordis.patch.yml` 禁用官方行）
- 维护方式：DSH 升级时重新复制，见 `src/vendored/README.md`

---

## 1. 一句话定义

**界面所有权 + 项目分组叠加。** 插件持有官方侧栏工作区浏览器（vendor），
在它之上叠加"项目分组"能力；关闭插件即还原官方（官方行重新启用）。

底层数据一律走官方；插件只额外维护一份"会话 → 项目"归属表和一份工作文档。

```
官方（经 vendor，由本插件持有）：会话的 cwd、归档、删除、沙箱根、日志目录、完整界面
插件新增：项目分组、项目归属表、工作文档绑定与注入
```

---

## 2. 设计原则

| 原则 | 含义 |
|---|---|
| **不碰底层** | 不改任何会话的 `cwd`，不碰官方归档集合，不移动日志文件 |
| **界面 1:1** | 官方 UI 原样保留（vendor），不重写、不近似 |
| **可逆** | `cordis.patch.yml` 只做 disable + insert；撤销即回到原版 DSH |
| **归档归官方** | 归档 / 取消归档 / 删除一律调官方 RPC，插件不存状态 |
| **单一落脚点** | 插件内新建的会话全部落在官方**默认工作区** |
| **双账分离** | 官方账（cwd 归属）只读；插件账（项目归属）独占 |
| **vendor 不提改动** | `src/vendored/` 永不编辑，所有改动放在 `src/client/` |

---

## 3. 已核实的事实基础

以下结论全部来自对安装版 **0.1.7-rc.2** 的 `app.asar` 解包验证（源码 checkout 停留在 0.1.5-rc.2，不可作为运行时依据）。

### 3.1 会话归属是派生的，不是存储的

```js
// packages/workspace/workspace/src/entity.ts
get sessionIds() {
  return this.record.sessionIds.filter(id => this.host.sessionPath(id) === this.record.path)
}
```

`sessionPath(id)` 来自会话 header 的 `cwd`。**成员关系每次读取时现算。**

### 3.2 `cwd` 不可变，且无任何写入路径

- 类型层：`SessionHeader` 所有字段 `readonly`
- 运行时：`validateSessionHeader` 末尾 `deepFreeze`
- 持久化：header 行只在物化时写一次，无 append 路径
- **全仓库无任何生产代码写 `header.cwd`**；无 `setCwd` / `relocate` / `moveSession` RPC

爆炸半径（若强行改）：日志路径绑定失效 → `corrupt session log` 永久不可读 · 工作区归属丢失 · 投影缓存失效 · SQLite 索引冲突 · 跨会话可见性重划分 · 沙箱根移动 · `{{cwd}}` 提示词变化 · 子代理继承割裂。

→ **结论：任何"移动会话"的方案都必须是另加一层映射，绝不能改归属。**

### 3.3 删除工作区后归属账永久丢失（用户实测确认）

```js
// deleteKnown: 记录整个删除，含 sessionIds
this.entities.delete(id);
await this.requireTable().delete(id);
// 且显式写入 initialized: true
```

`bootstrap()`（唯一会按 `cwd` 重建归属的逻辑）**只在 `initialized === false` 时执行**。删除时标记为 `true`，所以：

> **删除工作区 = 永久解除那批会话的归属记账。重新导入同一目录只得到空工作区，旧会话回不去。**

用户真实数据佐证：`D:\下载\重要` 目录有 6 个会话，`workspace.json` 里只有 1 个在账上，另 5 个是未分组。

### 3.4 只有 `workspaceId` 建会话才挂账

```js
const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd   // defaultCwd = process.cwd()
```

给 `cwd` 不给 `workspaceId` → **不进账**，永远显示为未分组。
→ **插件新建会话必须传 `workspaceId`。**

### 3.5 官方 `initializeDefault` 不可用

前置条件是**完全空状态**：注册表空 + 归档集空 + 无活动会话 + 无历史会话。已有 20+ 会话时永远返回 `undefined`。

且 `defaultWorkspaceId` 一旦删除即**永久禁用**自动创建。

→ **补建默认工作区必须用普通 `workspace/create`。**

### 3.6 `sidebar.workspaces` 是 single 槽位（双占用是硬错误）

```js
// ui-slots: 同一 priority 已有人占用 → 直接抛错
if (occupant) throw new Error(`single slot "${options.name}" already has a registration ... 
  — register at a different priority to shadow it (lowest renders)`)
```

同 priority 双注册**抛错**；不同 priority 则最低者渲染（shadowing）。

→ **v2.0 的取舍**：既然 shadow 会连带屏蔽官方动作（§3.10），就不走 shadow，
而是**禁用官方行**让本插件成为唯一占用者。这样不必依赖 priority 语义，
也不会出现"两个 entry 抢一个槽位"的隐性耦合。

### 3.7 客户端可调用的 workspace RPC 全集（7 个）

| 路由 | 用途 |
|---|---|
| `workspace/create` | 建工作区（**请求体只有 `{ path }`**） |
| `workspace/rename` | 改标题 |
| `workspace/delete` | 删除注册 |
| `workspace/insertBefore` | 工作区排序 |
| `workspace/insertSessionBefore` | 会话排序（**仅同工作区内**） |
| `workspace/archiveSession` | 归档 |
| `workspace/follow` | 流式投影（列表唯一来源） |

0.1.7 另新增：`unarchiveSession` · `pinSession` · `unpinSession` · `initializeDefault`。

**不存在**：跨工作区移动会话 · `detachSession`（host-only）· 带自定义标题的 create · 独立 `workspace/list`。

### 3.8 默认工作区路径推导是确定的

```js
// default-directory.js
return paths.join(directory, 'deepseek-harness', DEFAULT_WORKSPACE_DIRECTORY)
// DEFAULT_WORKSPACE_DIRECTORY = 'default-workspace'
```

Windows 上 `directory` = `[Environment]::GetFolderPath(MyDocuments)`。

用户环境：`C:\Users\Think\Documents\deepseek-harness\default-workspace`

**注意**：渲染时 `workspaceDisplayTitle` 会把存储标题恰好等于 `default-workspace` 的显示为本地化的"默认工作区"。→ **查找必须按 path，不能按 title**（用户改名不影响）。

### 3.9 官方原生 AGENTS.md 注入机制

`dsh-agent-instructions` 在 `agent/pre-step` 时，从会话 `cwd` **向上找 `.git` 定位项目根**，再从项目根到 cwd 逐层加载 `AGENTS.md` / `CLAUDE.md`（预算 64 KB，用户全局 `~/.dsh/AGENTS.md` 优先）。

→ 所有会话落在默认工作区时，`default-workspace\AGENTS.md` 会被自动注入。**零代码。**

### 3.10 shadow 会连带屏蔽官方的子槽位渲染（→ 故改用 fork）

**这是 v1.1 让位给 v2.0 的关键事实。**

`entriesOfSlot` 只跳过 **abdicated** 的 entry；shadow 只是"排序后不被选中"。
而 `releaseEntry`（唯一调用 `releaseChildren` 的地方）**只在注册被 dispose 时触发**。

shadow 之后的状态：

| 项 | 状态 |
|---|---|
| 官方 entry 本身 | ✅ 仍在 ledger |
| 它声明的 children spec | ✅ 保留（`session.menu.item` / `session.row.action` / `directoryFlow` …） |
| 官方组件的渲染 | ❌ 不再渲染 |
| 那些子槽位上的注册 | ⚠️ 仍注册，但**没有渲染点** → 动作从界面消失 |

实测还发现**第二条更硬的约束**（`scripts/probe-slots.mjs` 复现）：

```
register 声明已被占用的子槽位
  → slot "sidebar.workspaces.session.menu.item" is already declared
```

且 `renderSlot` 是**逐 entry 授权**的（发行版 renderer：`const declared = entry.children?.[key]`），
我们的 entry 不拥有那些 child，调用即抛 `SlotOwnershipError`。

**结论：shadow 路线既不能保留官方动作，也无法自行接管那些子槽位。**
这就是 v2.0 改为 **vendor 官方组件 + 禁用官方行**的原因——这样官方 entry 由我们持有，
子槽位由我们声明，一切照常。

### 3.11 我们持有的那份 UI，其 owner 契约由官方原文定义

vendor 进来的 `contract/slots.ts` 完整保留了官方注入面
（`startSession` / `open` / `searchSessions` / `renameSession` / `forkSession` /
`renameWorkspace` / `deleteWorkspace` / `insertWorkspaceBefore` / `archiveSession` /
`insertSessionBefore` / `createWorkspace` + `hooks`）。

→ **不要删减**。项目分组逻辑是**叠加**在它之上的，不是替换；
删掉任何一项都会让界面上某个已有功能静默失效。

---

## 4. 架构分层

```
┌─ Host 侧 ──────────────────────────────────────────────────────┐
│                                                                 │
│  ① 领域数据（ctx.storageDomain，标准做法）                        │
│     defineDomain({ name: 'projectGroups', version: 1,            │
│                    tables: { projects, assignments } })          │
│     · 落在 $DSH_HOME/storages/projectGroups.json（json 后端）     │
│     · schema 校验、原子写、domain/changed 事件                    │
│     · 与官方 workspace 领域平行，互不干扰                          │
│                                                                 │
│  ② Remote 命名空间（自有 RPC）                                    │
│     namespace: 'projectGroups'                                   │
│     create · rename · delete · assign · unassign · reorder        │
│     follow (stream)                                              │
│                                                                 │
│  ③ agent/pre-step 文档注入                                        │
│     sessionId → assignment → project → 读 docPath → 注入          │
│     · 与官方 dsh-agent-instructions 并存（两条独立消息）           │
│                                                                 │
│  ④ 默认工作区守护                                                  │
│     检测（按 path）→ 缺失则 mkdir + workspace/create 补建           │
└─────────────────────────────────────────────────────────────────┘
                              ↕ Remote
┌─ Client 侧 ────────────────────────────────────────────────────┐
│                                                                 │
│  ⑤ 界面主体（vendor 自官方，由本插件持有）                          │
│     src/vendored/ = 官方 client 源码原样副本                       │
│     官方 ui-workspace 行由 cordis.patch.yml 禁用                   │
│     → 分组树 / 搜索 / 视图选项 / 行内动作 / 对话框 全部原样          │
│                                                                 │
│  ⑥ 项目分组叠加（在 vendor 之上）                                  │
│     项目行与"未分组"桶：由 assignments 表重新派生分组              │
│     新建项目入口：替换/隐藏"添加工作区"                            │
│                                                                 │
│  ⑦ 拖拽                                                           │
│     会话从"未分组"拖进项目 → projectGroups/assign                 │
│     · 完全不碰官方 cwd / attachSession                            │
└─────────────────────────────────────────────────────────────────┘
```

**分层要点**：⑤ 是**基线**（本版本已交付，行为与官方完全一致），
⑥⑦ 是**叠加**——只改分组派生与入口，不动 vendor 内部。

---

## 5. 分层实现（L0–L5）

### 5.0 分层总览

每层都是一个**可独立发布、可独立回退**的完整插件版本。低层是高层的严格子集——后一层只在前一层之上增加能力，不改写前一层的行为。

```
L0  vendor 官方界面        本版本已交付 · 行为与官方完全一致
     ├─ 复制官方 client 源码到 src/vendored/（逐字节一致）
     ├─ cordis.patch.yml 禁用官方 ui-workspace 行 + 挂载本插件
     └─ 同一套 slot / 服务 / root hook，只是 bundle id 换成我们的
                │
L1  新建项目              引入 host + 领域数据
     ├─ 领域表 projects
     ├─ Remote: create / rename / delete / follow
     └─ "新建项目"入口（替换官方"添加工作区"）
                │
L2  拖拽归类              引入归属映射
     ├─ 领域表 assignments
     ├─ Remote: assign / unassign
     └─ 分组派生改为：项目 + "未分组"桶
                │
L3  行内动作适配          vendor 动作接到我们的分组上（无需重写）
     ├─ 归档 / 取消归档（沿用官方实现）
     ├─ 重命名 / 分叉 / 置顶（沿用）
     └─ 仅处理"项目"这一新对象自身的重命名/删除
                │
L4  默认工作区与新会话     引入官方 workspace 交互
     ├─ 默认工作区守护（探测 + 补建）
     └─ 项目内/未分组下"新会话" → workspaceId
                │
L5  工作文档              引入文档绑定与注入
     ├─ 项目 docPath 绑定
     ├─ host 侧 agent/pre-step 注入
     └─ 文档模板与读写
```

**与 v1.1 的关键差别**：L3 从"重写被屏蔽的官方能力"变成"把 vendor 的动作接到新分组上"——
动作代码已经在我们手里，不需要重写。

**为什么是这个顺序**

| 顺序 | 理由 |
|---|---|
| vendor 在最前 | 它是全部功能的前提；且必须先确认"替换官方行"能干净启动，再叠加任何逻辑 |
| 项目早于归类 | 没有项目就无处可拖 |
| 归类早于动作适配 | 先有分组派生，动作才知道自己挂在哪个分组下 |
| 新会话晚于归类 | 需要先有项目和归属表，才有"在项目里建会话"的语义 |
| 文档最后 | 依赖项目表（docPath）与归属表（找到会话属主）；且是唯一的 host 注入逻辑 |

---

### L0 — vendor 官方界面（已完成）

**目标**：把官方侧栏工作区浏览器变成"我们的"，行为与官方**完全一致**，作为后续叠加的基线。

**交付物**

| 项 | 内容 |
|---|---|
| vendor 源码 | `src/vendored/client/`（22 文件）+ `css-modules.d.ts`，与上游 `dsh-v0.1.7-rc.2` **逐字节一致** |
| 插件入口 | `src/client/index.ts` 仅 `export { apply, inject } from '../vendored/client/index.ts'` |
| 打包 | `tsdown.config.ts`：平台模块保持 external，接线/纯折叠层内联，跨插件值导入报错 |
| 配置 | `cordis.patch.yml`：`disabled: true` 官方行 + insert 本插件行 |
| 校验 | `scripts/compare-bundle.mjs` + `scripts/verify-patch.mjs` |

**技术要点**

- bundle id 换成 `dsh-project-groups`，但 **slot、服务、root hook 全部沿用官方**
  （`sidebar.workspaces` / `uiWorkspace` / `workspaces`），所以侧栏壳与目录选择器无需改动
- `sidebar.workspaces` 是 `single` 槽位，**双占用是硬错误** → 必须禁用官方行，不能共存
- `uiWorkspace` 服务被 `ui-sidebar` 与两个目录选择器 `inject`，
  所以 vendor 必须连 `navigation.ts`（服务实现）一起持有，否则整个侧栏起不来
- 编译期规则：只有 5 个 external，与官方 bundle **完全一致**（`compare-bundle.mjs` 断言）

**验收标准**

1. 启用插件 → 侧栏与**原版 DSH 无法区分**（同样的分组、动作、对话框）
2. `dsh --dump-config` 显示官方行 `disabled: true`、本插件行已挂载
3. 关闭/卸载插件 → 官方行恢复，一切回到原版

**回退**：删除本插件即还原；官方行一直保留在配置里，只是被 disable。

---

### L1 — 新建项目

**目标**：引入 host 侧与领域数据，支持创建项目（只有标题，不选目录）。

**新增交付物**

| 项 | 内容 |
|---|---|
| 插件形态 | 升级为 **host + client 双面** |
| 领域声明 | `defineDomain({ name: 'projectGroups', version: 1, tables: { projects, assignments } })` |
| 领域记录 | `projects`: `{ title, docPath, createdAt, updatedAt }` |
| Remote | `projectGroups/create` · `rename` · `delete` · `follow`(stream) |
| Client 渲染 | 项目列表置于"未分组"桶**之上** |
| 入口 | "新建项目"按钮（替换官方"添加工作区"）→ 弹标题输入框 |

**技术要点**

- 领域句柄生命周期：`ctx.effect(() => () => domain.close(), 'projectGroups.domainClose')`
- `follow` 流照抄官方 workspace feed 模式：先发 baseline，再发 upsert/remove 增量
- **新建项目不创建任何工作区**——它纯粹是插件侧的一条记录
- 项目顺序：可先按 `createdAt`，L2 再加拖拽排序

**验收标准**

1. 点"新建项目"→ 填标题 → 项目出现在列表顶部
2. 重启 DSH 后项目仍在（领域已持久化）
3. 重命名 / 删除项目生效
4. 删除项目**不影响任何会话**
5. 关闭插件 → 官方视图恢复；项目数据留在 `$DSH_HOME/storages`（重开插件即回来）

---

### L2 — 拖拽归类

**目标**：把会话从"未分组"拖进项目。

**新增交付物**

| 项 | 内容 |
|---|---|
| 领域表 | `assignments`: `{ projectId }`，key = sessionId |
| Remote | `projectGroups/assign` · `unassign` |
| 交互 | 会话行可拖拽；项目行/未分组桶为放置目标 |
| 渲染 | 项目下显示其会话；未分组 = 全部会话 − 已归类 |

**技术要点**

- **一个会话只属一个项目**（用户已决定）→ `assignments` 以 sessionId 为 key，天然保证唯一
- 移动 = 覆盖写一次；移出 = delete 一条
- `follow` 流需同时携带 projects 与 assignments 两个表的增量
- **完全不碰官方 `cwd` / `attachSession`**——只改插件自己的表（这是"可逆"的根本）
- 会话在项目中仍显示真实标题与时间，仅分组位置变化

**验收标准**

1. 拖会话进项目 → 立即生效、刷新后仍生效
2. 从项目拖回未分组 → 归属被清除
3. 一个会话不会同时出现在两个项目
4. 项目删除后，其下会话自动回到未分组（不丢会话）
5. 关闭插件 → 官方视图里会话归属完全不变（因为官方账没被动过）

---

### L3 — 行内动作适配

**目标**：把 vendor 自带的官方行内动作接到我们的分组模型上。

**与 v1.1 的关键差别**：这里**不需要重写任何官方动作**。动作代码随 vendor 一起在我们手里
（`src/vendored/client/session-actions/`），它们已经调用官方 RPC 并渲染进官方声明的子槽位。
本层的工作只是让它们在新分组下正常工作。

**新增交付物**

| 项 | 内容 |
|---|---|
| 分组上下文 | 会话行知道自己属于哪个"项目"（供 hover 卡、菜单使用） |
| 项目自身操作 | 项目行的重命名 / 删除 / 排序（新对象，需新实现） |
| 动作回落 | 归档 / 取消归档后，从项目下消失并回到"未分组"或原项目 |

**沿用官方实现、无需改写的**

| 操作 | 位置 |
|---|---|
| 归档 / 取消归档 / 停止并归档 | `session-actions/ArchiveSession.tsx` |
| 重命名 + 对话框 | `session-actions/RenameSession.tsx` |
| 分叉 | `session-actions/ForkSession.tsx` |
| 置顶 / 取消置顶 | `session-actions/PinSession.tsx` |

**技术要点**

- **动作一律调官方 RPC，插件不存状态**——这是"不乱"的前提（§2）
- 归档后从列表消失；取消归档后回到原分组位置（归属表未动）
- 项目是插件新对象，其"重命名/删除"走我们自己的 Remote，**不复用官方 workspace RPC**

**验收标准**

1. 归档一个会话 → 从列表消失；`archiveSession` 后官方数据一致
2. 取消归档 → 回到原项目下
3. 重命名 / 分叉 / 置顶与官方行为一致
4. 项目重命名/删除只影响插件自己的表，不碰任何会话

---

### L4 — 默认工作区与新会话

**目标**：让插件内建的新会话落在官方默认工作区，并在缺失时补建。

**新增交付物**

| 项 | 内容 |
|---|---|
| 默认工作区守护 | 按 **path** 探测 → 缺失则 `mkdir` + `workspace/create` |
| 新会话 | `session/create { workspaceId: <默认工作区id> }` |
| 入口 | 项目行 / 未分组桶的"新会话" |
| 创建后 | 自动写入 `assignments`（若在项目下创建） |

**技术要点**

- **按 path 匹配，不按 title**：`<Documents>\deepseek-harness\default-workspace`
  （渲染层会把 title 恰好等于 `default-workspace` 的显示为"默认工作区"，用户改名后 title 会变，path 不会）
- **不能用官方 `initializeDefault`**（要求完全空状态，永远返回 `undefined`，§3.5）
- 补建顺序：`mkdir(recursive)` → `workspace/create { path }` → 取返回的 `workspaceId`
- 补建**不传 title** → 自动取目录名 → 界面显示"默认工作区"
- 必须传 `workspaceId`（不是 `cwd`），否则会话不进官方账，永远显示未分组（§3.4）
- 补建时机：**用到才补**（点"新会话"时），不在启动时侵入

**验收标准**

1. 项目内点"新会话" → 会话创建并出现在该项目下
2. 官方视图（关插件后）该会话在**默认工作区**下
3. 删掉默认工作区后点"新会话" → 自动补建，会话正常创建
4. 用户把默认工作区改名 → 插件仍能正确定位（按 path）
5. 补建不会重复创建（已有则复用）

---

### L5 — 工作文档

**目标**：项目绑定一份 md 工作文档，新会话自动注入。

**新增交付物**

| 项 | 内容 |
|---|---|
| 领域字段 | 使用 L1 已有的 `docPath`（本层启用其编辑与消费） |
| 文档位置 | 默认 `$DSH_HOME/projects/<projectId>.md` |
| 注入 | host 侧 `ctx.on('agent/pre-step', …)` |
| UI | 项目设置里绑定/解绑文档；可打开编辑 |
| 模板 | 新项目可选生成初始文档 |

**技术要点**

- `$DSH_HOME` 解析顺序（与官方 `resolveDshHome` 同序）：
  `profileContext.home` → `$DSH_HOME` → `~/.dsh`
- `docPath` 允许用户覆盖为任意路径（放进项目仓库跟 git 走）
- 注入内容包在 `<system-reminder>` 里，与官方 `dsh-agent-instructions` 的注入**并存不冲突**（两条独立消息）
- 注入前做大小上限，避免超长文档吃掉上下文
- **不解析文档内容**——只读原文注入（是否渲染结构化台账见 §7.2 决策）
- 注入仅对"已归类到某项目"的会话生效

**验收标准**

1. 给项目绑定文档 → 该项目下新会话首轮即能看到文档内容
2. 未绑定文档的项目 → 不注入任何额外内容
3. 官方 `default-workspace\AGENTS.md` 注入仍正常（两者共存）
4. 关闭插件 → 不再注入（仅剩官方 AGENTS.md）
5. 文档过大时被截断且有提示

---

### 5.x 层间依赖与风险

| 层 | 依赖 | 主要风险 | 缓解 |
|---|---|---|---|
| L0 | 无 | 官方升级改私有契约（vendor 漂移） | vendor 逐字节留存 + `compare-bundle.mjs` 断言 external 一致；升级时重新同步 |
| L0 | 无 | 禁用官方行失败（id 变更） | `verify-patch.mjs` 断言无 patch 被跳过；id 变更时同步更新 |
| L1 | L0 | 领域 schema 变更 | 用 `version` + `compatibleVersions` |
| L2 | L1 | 拖拽交互复杂度 | 先做"菜单里选择项目"的后备路径 |
| L3 | L0 | 官方 RPC 行为差异 | 全部走官方，不自己实现归档语义 |
| L4 | L1 | 默认工作区被删/改名 | 按 path 探测 + 用到才补建 |
| L5 | L1、L4 | 注入与官方预算冲突 | 独立消息 + 大小上限 |

**每层都必须满足**：停用插件后，官方行重新启用即回到原版 DSH。

---

## 6. 关键流程

### 6.1 插件启用（接管侧栏）

```
1. cordis.patch.yml 生效（在 web-app bundle 层之后）
   → ui-workspace 行 disabled: true
   → project-groups 行挂载

2. client bundle 加载，bundle id = dsh-project-groups
   → 注册 sidebar.workspaces（此时无竞争者）
   → 提供 uiWorkspace 服务（ui-sidebar / 目录选择器 inject 它）
   → 提供 workspaces root hook

3. 读官方 workspace/follow 流（baseline + 增量）
   → items（含 path/title/sessionIds）、archivedSessionIds

3. 读会话列表 → ids + summaries

4. 读插件领域
   → projects（表）+ assignments（表）

5. 渲染
   分组 = 项目列表（按创建顺序）
   每个项目下 = assignments 里指向它的 sessionId（join summaries）
   未分组桶 = 全部会话 − 已被 assignments 覆盖的
```

**"未分组"的定义**：**全部会话，减去已被项目认领的**。官方那些用户自建工作区的会话也落进这个桶。

> 底层归属一个字节都没动；只是**显示层**不再按官方工作区分组。

### 6.2 新建项目

```
点"+" → 输入框（只要标题，不弹目录选择器）
  → projectGroups/create { title }
  → projects 表 put(id, { title, docPath: '', ... })
  → domain/changed → follow 流推送 → 视图刷新
```

**解决的原痛点**：不用选文件夹、标题自定义。

### 6.3 新建会话（关键路径）

```
1. 定位默认工作区（按 path 匹配，不按 title）
     path = <Documents>\deepseek-harness\default-workspace
     find in workspaceSnapshot.items

2. 不存在 → 补建
     mkdir(path, { recursive: true })
     workspace/create { path }
     → 注意：不能用官方 initializeDefault（要求空状态，永远返回 undefined）

3. session.create { workspaceId: <默认工作区id> }
     → cwd = 默认工作区 path → 官方账上"在默认工作区"

4.（可选）projectGroups/assign { sessionId, projectId }

5. 打开会话
```

**双账结果**：官方看到它在默认工作区，插件看到它在项目 X。互不冲突。

### 6.4 停用插件（还原）

```
停用/卸载插件 → 其 cordis.patch.yml 不再生效
  → ui-workspace 行恢复启用（官方行从未被删除，只是被 disable）
  → official bundle 重新注册 sidebar.workspaces / uiWorkspace / workspaces
  → 用户在默认工作区改的名字照常显示（官方数据）
  → 插件期间建的会话都在默认工作区里（因为用了 workspaceId）
```

**关键**：因为插件期间的会话**真的**建在默认工作区（不是虚拟归属），停用后它们是官方数据里名正言顺的一部分，**不需要任何迁移**。

**注意**：`disabled: true` 是"同一行的开关"，不是删除。因此还原是改一个布尔值，
官方行、官方 bundle、官方数据自始至终都在原处。

### 6.5 文档注入

```
agent/pre-step（host 侧）
  sessionId → assignments 表 → projectId → projects 表
    → docPath 非空 → 读文件 → 注入 <system-reminder>
    → 否则跳过
```

与官方 `dsh-agent-instructions` 独立：官方注入 `default-workspace\AGENTS.md`（若存在），插件注入项目文档。**两条消息、互不覆盖。**

---

## 7. 数据模型（标准 DSH 规范）

### 7.1 领域声明

```ts
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

const projectRecord = z.object({
  title: z.string().min(1),
  /** 工作文档路径；空串表示未绑定 */
  docPath: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const assignmentRecord = z.object({ projectId: z.string() })

const projectGroupsSpec = defineDomain({
  name: 'projectGroups',          // 必须匹配 /^[a-z][a-z0-9_]*$/
  version: 1,
  tables: {
    projects: domainTable(projectRecord),        // L1 引入
    assignments: domainTable(assignmentRecord),  // L2 引入
  },
})
```

> 领域名匹配 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`（`defineDomain` 在模块加载时校验，失败即抛）。
> 记录键是任意字符串，**绝不进入文件路径**。
> **分层注意**：`defineDomain` 的 `tables` 是声明式常量。L1 阶段可只声明 `projects`，L2 时把 `assignments` 加进来并升 `version`（或从一开始就声明两张表，L1 只使用其中一张——**推荐后者**，避免 L2 引入 schema 迁移）。

### 7.2 两张表

| 数据 | 表 | key | 引入层 | 说明 |
|---|---|---|---|---|
| **项目** | `projects` | projectId | L1 | `{ title, docPath, createdAt, updatedAt }` |
| **会话归属** | `assignments` | sessionId | L2 | `{ projectId }` |

**归属映射为什么用独立表**：

- **A. 存在项目记录里**（`projectRecord.sessionIds: string[]`）：一次读全，但移动会话要写两条项目记录
- **B. 独立映射表**（采用）：移动只需一次定点写；`sessionId` 作 key 天然保证"一个会话只属一个项目"

→ **采用 B**（用户已决定：一个会话只属于一个项目）。

**为什么不用裸 JSON 文件**：

| | 裸 JSON（`.agent/projects/x.json`） | `ctx.storageDomain` |
|---|---|---|
| 可移植性 | ❌ 依赖用户有 `.agent` | ✅ 自动落在 `$DSH_HOME/storages` |
| schema 校验 | 自己写 | ✅ 打开时逐条校验 |
| 原子写 | 自己写 | ✅ 后端保证 |
| 变更事件 | 自己写 | ✅ `domain/changed` |
| 版本迁移 | 自己写 | 内建 `version` / `compatibleVersions` |

→ 发布给别人的插件必须走标准数据层。

---

## 8. 工作文档规范

### 8.1 位置
**默认**：`$DSH_HOME/projects/<projectId>.md`

```
$DSH_HOME = $DSH_HOME 环境变量 → ~/.dsh
```

解析顺序（与官方 `resolveDshHome` 同序，参考 `dsh-codearts-auth` 的实现）：

```
profileContext.home  →  $DSH_HOME  →  ~/.dsh
```

**用户可改**：项目记录里的 `docPath` 允许指向任意路径（放进项目仓库、跟代码走 git 等）。

> 不默认写 `.agent`——那是本机私有资产，别人电脑上没有。

### 8.2 格式

沿用 0.1.5 那轮讨论收敛出的**平表**结构：

```markdown
# <项目名>
> 上游仓库：<url> ｜ 本地目录：<path> ｜ 更新：<date>

## 现状
<一句话：现在到哪了>

## 关联资产
- 上游：<repo / issue / PR>

## 台账
| 状态 | 日期 | 改动 | 会话 |
|------|------|------|------|
| 跟踪中 | 09-22 | <一句话> | @[标签](dsh-session:<base64>) |
| 已完成 | 09-18 | <一句话> | @[标签](dsh-session:<base64>) |
| 已挂起 | 09-18 | <一句话> | @[标签](dsh-session:<base64>) |
| 已放弃 | 09-15 | <一句话> | @[标签](dsh-session:<base64>) |
```

- **单位 = 问题/想法**（不是会话、不是文件改动）：一个 bug 跨多轮对话、多文件，台账里只占一行
- **四态**：`跟踪中 / 已完成 / 已挂起 / 已放弃`
- **会话列**：官方深链 `@[label](dsh-session:<base64>)`，可点击跳回
- **不设"项目自动分类"**——只有手动

### 8.3 谁写

| 角色 | 做什么 | 不做什么 |
|---|---|---|
| **AI** | 判定"这是个问题"，写状态/内容/引用 | 不管格式、排序、计数 |
| **程序** | 读文档、渲染、计数、深链可点 | **不生成内容、不跑 LLM、不解析会话** |
| **用户** | 改状态、拖拽分类 | 不用手写格式 |

切分依据：**谁需要理解，谁来做**。"修 bug 时又发现一个 bug 算一条还是两条"是主观判断，只有 AI 能做；数数、渲染不需要理解，程序做。

---

## 10. 扩展点规范

### 10.1 插件清单（标准 DSH 插件形态）

```json
// package.json
{
  "name": "dsh-project-groups",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.4",
    "@deepseek-ai/dsh-client-ui-slots": "*",
    "@deepseek-ai/dsh-storage-domain": "*"
  }
}
```

> 参考社区插件 `dsh-codearts-auth`（host + client 双面）与 `dsh-smooth-cursor-patched`（client 插件）。

### 10.2 用到的官方接缝

| 接缝 | 用途 | 引入层 |
|---|---|---|
| `ctx.slots` (client) | 注册 `sidebar.workspaces` | L0 |
| `ctx.storageDomain` | 领域数据持久化 | L1 |
| `ctx.remote.workspace` (client) | 调官方 create / follow / archive | L1 / L3 |
| `ctx.remote.session` (client) | 建会话（带 workspaceId） | L4 |
| `ctx.workspaceRegistry` (host) | 只读：查默认工作区 | L4 |
| `ctx.on('agent/pre-step')` (host) | 文档注入 | L5 |

### 10.3 我们不碰的

- ❌ 会话 `cwd` / header 任何字段
- ❌ 官方 `archivedSessionIds`（只调 archive/unarchive RPC）
- ❌ 会话日志文件与目录
- ❌ 官方 `workspace.json`（不直接写）

---

## 11. 决策记录

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| 1 | 补建时机 | **用到才补** | 少侵入；只有要点"新会话"时才需要 |
| 2 | 补建时传不传标题 | **不传** | 自动取目录名 → 界面显示"默认工作区" |
| 3 | 一个会话能否属多项目 | **否** | 语义清晰；用独立 assignments 表天然保证 |
| 4 | 数据存哪 | **`ctx.storageDomain`** | 标准规范；可移植；schema 校验 + 原子写 |
| 5 | 界面获取方式 | **vendor 官方源码**（v2.0 改） | 所有"只换数据源"的接缝都被不变式封死（§0、§3.10） |
| 6 | 项目文档位置 | **`$DSH_HOME/projects/<id>.md`** | 标准位置；用户可覆盖 docPath |
| 7 | 交付方式 | **分 6 层（L0–L5）** | 每层可独立交付、可回退；先验证"替换官方行"能干净启动 |
| 8 | 与官方如何共存 | **禁用官方行**（非共存） | `single` 槽位双占用、服务双提供都是硬错误 |

---

## 12. 风险与对策

| 风险 | 对策 |
|---|---|
| DSH 升级导致 vendor 漂移 | vendor 逐字节留存；升级时按 `src/vendored/README.md` 重新同步；`compare-bundle.mjs` 断言 external 一致 |
| 官方行 id 改名导致 disable 失效 | `verify-patch.mjs` 断言"无 patch 被跳过"；id 变更会立刻红灯 |
| 用户手删领域数据 | 领域文件在 `$DSH_HOME/storages`，与官方 workspace 同级。可加备份导出 |
| 默认工作区被用户删除 | **下一个新会话时自动补建**（§6.3） |
| 用户重命名默认工作区 | 查 path 不查 title，不受影响；停用插件后名字照常显示 |
| 注入与官方 AGENTS.md 预算冲突 | 官方 64 KB 预算独立计算；插件注入设大小上限 |
| 两套账不一致 | 属正常（各记各的）。"未分组"按"全部会话 − 已认领"算，天然自洽 |
| 多进程写领域 | 官方领域层文档明确"无跨进程写锁"；插件数据写入频率低，可接受 |

---

## 13. 与早期设计的区别

| | 0.1.5 讨论（2026-09-22） | v1.1（shadow） | 本设计（v2.0 fork） |
|---|---|---|---|
| 范围 | 会话管理 + 项目跟踪 + 知识图谱 | 显示层分组 + 工作文档 | 同左 |
| 界面 | 自建 | 自建（平铺列表） | **官方原文** |
| 状态 | 五级状态机 + 四态台账 | 零状态 | 零状态 |
| 数据 | 解析会话内容 / 自动分类 | 零解析 | 零解析 |
| 图谱 | 独立全屏面板 | 不做 | 不做 |
| 改动面 | 深（碰归档、血缘、LLM） | 浅（一个 shadow 注册） | 中（一份 vendor 副本 + 叠加逻辑） |

**核心：界面所有权归插件，能力归属仍归官方；插件只做"给会话起中文项目名 + 绑定一份文档"。**

---

## 14. 实现状态（按层）

### L0 — vendor 官方界面 ✅ 已完成（2026-09-26）

- [x] vendor 官方 client 源码 22 文件（与上游 `dsh-v0.1.7-rc.2` 逐字节一致）
- [x] 浏览器入口再导出（`src/client/index.ts`）
- [x] 打包规则：平台模块 external / 接线层内联 / 跨插件值导入报错
- [x] `cordis.patch.yml`：禁用官方 `ui-workspace` 行 + 挂载本插件
- [x] `dsh.client.inject` 与官方一致
- [x] 校验脚本：`compare-bundle.mjs`（8 项）、`verify-patch.mjs`（6 项）
- [x] **实测**：`dsh --profile <test> --dump-config` 显示
      官方行 `disabled: true`、插件行已挂载

### L1a — 全部收进未分组 ✅ 已完成（2026-09-26）

**目标**：验证"分组来源可注入"，并把所有会话收进未分组桶（官方底层不动）。

- [x] `tree.ts`：`GroupSource` 类型 + `owningSourceKey` + `groupBySource`
      （`groupByWorkspace` 的逐行对称版）
- [x] `tree.ts`：`deriveGroups` 加**可选**第 6 参数 `sources`
- [x] `contract/slots.ts`：注入面加 `grouping` hook
- [x] `rows/WorkspaceBrowser.tsx`：消费 `useGrouping`，贯穿到 `SessionTree`
- [x] `rows/Rows.tsx`：未分组桶改按"空 label"判别（不再看 `workspaceId`）
- [x] `index.ts`：`apply(ctx, groupingOverride?)` 可选参数
- [x] `src/client/grouping.ts`：本轮注入**空源**（`[]` = 活跃但不认领任何会话）
- [x] 校验：`verify-grouping.mjs`（19 项）、`probe-grouping-seam.mjs`（5 项）
- [x] **实测**：`pnpm check` 共 **55 项断言全绿**

**收口的关键结论**：注入必须走**参数**，不能走 `ctx.provide` 服务。
实测（`probe-service-timing.mjs`）显示同 fiber 内 `ctx.get` 在 apply 未退出前
读不到自己刚 provide 的值 → 会与 slot 声明顺序形成竞态。

### L1 — 新建项目
- [ ] host half 与领域声明 + `ctx.storageDomain` 打开
- [ ] Remote：`create` / `rename` / `delete` / `follow`
- [ ] 项目列表渲染（把 `EMPTY_GROUPING` 换成项目派生的 `GroupSource[]`）
- [ ] 项目重命名 / 删除

### L2 — 拖拽归类
- [ ] `assignments` 表启用
- [ ] Remote：`assign` / `unassign`
- [ ] 分组派生改为：项目 + "未分组"桶
- [ ] 拖拽交互 + 放置目标（复用 vendor 的拖拽基建或新增）

### L3 — 行内动作适配
- [ ] 会话行感知所属项目（hover 卡 / 菜单上下文）
- [ ] 项目自身的重命名 / 删除 / 排序（新对象）
- [ ] 归档 / 取消归档在项目分组下的回落行为

### L4 — 默认工作区与新会话
- [ ] 默认工作区探测（按 path）
- [ ] 补建（mkdir + `workspace/create`）
- [ ] 新会话（带 workspaceId）+ 自动归类

### L5 — 工作文档
- [ ] `docPath` 编辑 UI
- [ ] `agent/pre-step` 注入
- [ ] 文档模板与大小上限

### 通用
- [x] 构建配置（tsdown + `cordis.patch.yml`）
- [ ] 单元测试（domain / RPC / 注入 / 补建逻辑）
- [ ] 每层的"停用插件后回到原版 DSH"回归测试
- [ ] vendor 重新同步流程演练（升到下一个 DSH 版本时）

---

## 15. 本轮（L0）验证结果

| 验证项 | 手段 | 结果 |
|---|---|---|
| vendor 与上游一致 | 22 文件 SHA256 逐字节比对 | ✅ 0 差异 |
| 产物 external 与官方一致 | `compare-bundle.mjs` 读安装版 `app.asar` | ✅ 5 个完全相同 |
| bundle id / apply / inject | 同上 | ✅ |
| 无构建机路径泄漏 | 同上 | ✅ 0 处 |
| CSS 已内联 | 同上 | ✅ |
| 禁用 patch 生效 | `verify-patch.mjs` 跑真实 `applyEntryPatches` | ✅ 无 patch 被跳过 |
| 真实组装配置 | `dsh --profile pg-test --dump-config` | ✅ 官方行 disabled、插件行挂载 |
| 依赖自动入 roster | `dsh plugin --profile pg-test add` | ✅ 自动加入 bundles |
| 宿主启动（端到端） | 未做——避免与运行中的桌面实例争用 `$DSH_HOME` | ⏸ 待确认 |

**下一轮（用户确认后）**：按 L1 开始叠加项目分组逻辑。

