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

### L1b — 新建会话落点 ✅ 已完成（2026-09-26）

**目标**：所有"新建会话"入口落到默认工作区；未分组/自有分组的 ＋ 可用。

**背景**：上游把 ＋ 渲染出来但处理器被 `if (group.workspaceId !== undefined)` 挡住，
未分组下点击无效。上游仓库**关闭了 Issues**（`has_issues: false`），且 master 最新代码
仍是如此——同一组件对菜单/hover卡/拖拽都做了条件处理，唯独此处漏了，判定为**遗漏**
而非设计（详见 `src/vendored/README.md` 的"刻意的行为偏离"）。

- [x] `navigation.ts`：无目标 `startSession()` 改为解析**默认工作区**
      （`initializeDefault`——注册表记有默认时是**纯读**）
- [x] `navigation.ts`：无默认工作区时**静默不做**（选项 B：不猜、不清空选择）
- [x] `rows/WorkspaceBrowser.tsx`：`onCreate` 去掉 guard，恒展开 + 透传
- [x] `scripts/lib/ts-loader.mjs`：Node 无法 strip `navigation.ts` 的构造器参数属性，
      故测试用 TS 转译加载；顺带 stub 掉仅由 shell 提供的 `dsh-client-store`
- [x] 校验：`verify-new-session.mjs`（12 项，驱动真实 `UiWorkspaceService`）
- [x] **实测**：`pnpm check` 共 **65 项断言全绿**；隔离实例启动干净，
      产物含新方法、官方行 0 加载

**三处入口改动后的行为**

| 入口 | 插件层 | 底层调用 |
|---|---|---|
| 顶部"新会话" / Ctrl+N / schedule / preset | 不 assign | `initializeDefault()` → `create({ workspaceId })` |
| 未分组 ＋ | 不 assign（= 未分组） | 同上 |
| 项目 ＋（L1 接缝） | `assign(sessionId, projectId)` | 同上 |

**已知待办（L2）**：`reuseOrCreateBlank` 会复用同一工作区里已有的空白会话，
所以"未分组 ＋"后紧接着"项目 ＋"会拿到同一个空白会话。发过消息即固化；
L2 定策略（倾向"最后点的赢"）。

### L1-1 — 新建项目（界面）✅ 已完成（2026-09-26）

**目标**：把"添加工作区"换成"新建项目"，并让项目行拥有完整的行能力
（重命名 / 删除 / 拖拽排序），全部接插件自己的模型。

**背景**：上游的"添加工作区"强制走目录选择器（`workspace/create({path})`），
那正是"必须绑文件夹"的根源。项目不绑目录，所以这个按钮要换成纯标题输入。

- [x] `src/client/projects.ts`：`ProjectModel`（增删改查 + 排序 + 可订阅 observable）
- [x] `tree.ts`：`GroupSource.kind` + `GroupNode.kind`，`groupBySource` 透传
- [x] `contract/slots.ts`：注入面加 `createProject` / `renameProject` / `deleteProject` / `reorderProject`
- [x] `WorkspaceBrowser.tsx`：顶部 ＋ 换"新建项目"对话框；重命名/删除对话框与**组拖拽**
      改为按 `RowRequest.kind` 分派（项目行与工作区行共用一套 UI，动作不同）
- [x] `Rows.tsx`：菜单删除文案与 aria 按 `kind` 切换（"删除项目"）
- [x] `locales.ts`：中英项目文案
- [x] 校验：`verify-projects.mjs`（31 项，真实 `ProjectModel` + 真实 `deriveGroups`）
- [x] **实测**：`pnpm check` 共 **94 项断言全绿**；隔离实例启动干净，
      产物含 `createProject`/`ProjectModel`/`kind: "project"`

**为什么只有两种行**：插件启用时官方 `ui-workspace` 行已被 patch 禁用，
分组又完全由 `groupingOverride` 接管，所以侧栏只有**项目行**和**未分组桶**
——不存在"真实工作区行"，也就不需要第三种行类型。

| 行 | 标题 | 菜单 | 拖拽 | ＋ |
|---|---|---|---|---|
| 项目行 | `projects.title` | 重命名 / 删除**项目** | 项目间排序 | 建会话（落默认工作区） |
| 未分组桶 | 固定"未分组" | ❌ | ❌（L2 作放置目标） | 建会话（不归类） |

**L1-1 的临时状态**（已被 L1-2 取代）：项目数据曾在前端内存，刷新即丢。

### L1-2 — 项目持久化 ✅ 已完成（2026-09-26）

**目标**：项目落到 `$DSH_HOME/storages/`，重启不丢；前端改为读 host 状态。

- [x] `src/spec.ts`：`defineDomain({ name: 'project_groups', version: 1 })`
      —— `projects` + `assignments` 两表 + `global.projectIds` 顺序
- [x] `src/protocol.ts`：两半共享的线协议（7 个方法 + follow 帧）
- [x] `src/index.ts`：`ProjectController extends TypertRemoteService`
      （`@Remote` × 7，含 `follow` 流），domain 挂 `ctx.effect` 生命周期
- [x] `src/client/remote.ts`：**手写** contribution（~60 行 descriptor）
- [x] `src/client/projects.ts`：`ProjectModel` 改为 host 投影的镜像（含 `follow`）
- [x] `src/client/index.ts`：`ctx.remote.$mount(...)` + 启动模型
- [x] `tsdown.config.ts`：host half 加**装饰器降级插件**（关键修复，见下）
- [x] 校验：`verify-project-host.mjs`（31 项，真实 controller + 真实 domain 设施）、
      `verify-projects.mjs`（31 项，真实 model + 真实 deriveGroups）
- [x] **实测**：`pnpm check` 全绿；隔离实例启动干净；**7 个动词经 `/api` 全部打通**；
      数据落 `storages/project_groups.json`；**重启后仍在**

**本轮查清并推翻的两个前置判断**

| 我先前说 | 实际 |
|---|---|
| 「代码生成器 npm 上只有 `0.0.1-rc.1`」 | ❌ 错。`0.1.7-rc.2` **存在**（`0.0.1-rc.1` 是 npm 的 `latest` 标签） |
| 「必须用代码生成器 / 或手写 24.9 KB 产物」 | ❌ 都不必。手写 descriptor **约 60 行**就够 |

**为什么手写 descriptor 够**（`verify` 已覆盖）

1. client 只校验参数 codec 的 `mode === 'strict'`，**不检查 `create()` 返回什么**
   （`gateway/src/client/index.ts` 的 `requireStrictCodec`）
2. `TypertSchema` 是结构类型 `{ parse(value) }`，**不要求 zod**
3. 本插件载荷全是扁平 JSON，直通 codec 即语义正确
4. **host 侧根本不需要生成物**：Gateway 有 SRC 回退
   （`resolveSrcDescriptor`），运行时从 `typertRemote` binding + `@Remote` 标记推导 descriptor

**生成器仍不适用于独立仓库**（故未采用）：它只扫 `<root>/packages` 或 `vendor`，
并要求根目录有 `tsconfig.host.json`。

**关键修复：装饰器必须降级**

首次启动报 `project-groups (dsh-project-groups): failed to import`。
根因不是模块解析，而是 **`@Remote` 被原样输出到 `.js`**（TS 语法，Node 无法解析）。
官方同样遇到并以 `typert-generator` 的 tsdown `transform` 钩子解决；
我们加了一个只做这件事的最小插件（`DECORATOR_SYNTAX` + `ts.transpileModule`）。

**第二个真实错误**：领域名 `projectGroups` 违反 `UNIT_NAME_RE`（`/^[a-z][a-z0-9_]*$/`）
——它同时是后端 unit 名与文件名片段，故改为 snake_case 的 `project_groups`。

**依赖解析**：host half 的 harness 包全部保持 external；DSH 的 profile 用
`nodeLinker: hoisted`（`profile.ts` 明确注释）让树外插件共享安装实例的 cordis/zod，
所以不需要把它们打进产物。

### L2a — 项目行 ＋ 归类 ✅ 已完成（2026-09-26）

**目标**：点项目行的 ＋，新会话归到该项目；点未分组的 ＋，不归类。

**做法**：`startSession` 加**可选** `beforeOpen` 回调，透传进 `openWorkspace`
（那里本来就收 `sessionId`），项目行的 `onCreate` 用它调 `assignSession`。

**为什么是回调而不是改返回值**：`startSession` 是 fire-and-forget（`void`），
改成返回 Promise 会波及 5 个现有调用点（sidebar 壳 / Ctrl+N / schedule / preset），
而 `openWorkspace` 已有 `beforeOpen` 接缝；可选参数不传时行为完全不变。

**"最后点的赢"是 `put` 覆盖写的自然结果**，无需额外代码：

```
未分组 ＋ → 建空白 A（未 assign）
项目 abc ＋ → 复用 A → assign(A, abc)    ← A 归 abc
项目 xyz ＋ → 复用 A → assign(A, xyz)    ← A 移给 xyz
```

- [x] `navigation.ts`：`startSession(workspaceId?, beforeOpen?)` + 透传
- [x] `contract/slots.ts`：注入面加 `assignSession?`
- [x] `index.ts`：`ProjectActions.assignSession` + 透传
- [x] `WorkspaceBrowser.tsx`：`onCreate` 按 `kind === 'project'` 分派
- [x] `src/client/index.ts`：接到 `ProjectModel.assign()`
- [x] 校验：`verify-new-session.mjs` 补 4 项（回调收到正确 id、显式目标、省略时不变、无默认不回调）
- [x] **实测**：`pnpm check` 共 **186 项断言全绿**；
      浏览器实测：`未分组 ＋` 后项目仍为 0；`项目 ＋` 后会话入项目且未分组消失；刷新后仍在

**已知行为**：`reuseOrCreateBlank` 会复用同工作区的空白会话（发消息即固化）。
所以"未分组 ＋"不会让未分组计数 +1——它复用了那个空白会话。
探针已按此语义断言，并注明原因。

**一项探针缺陷（已修）**：我最初把"会话不在未分组"写成
`(section?.sessionCount ?? 0) === 0`，而**会话全归类后未分组组根本不渲染**，
于是这个断言恒真——是假阳性。现在未分组的**存在性**与**计数**分开断言，
且反向测试（未分组 ＋ 不归类）**先跑**，因为那是唯一能证伪"无条件 assign"的用例。

### L2c — 展开状态记忆（方案错误，已回滚）❌

> **这一节保留作为失败记录。** 它修的是**另一个**问题，且方案本身引入了
> 不该有的耦合。真正的修复是 L2d。

**当时观察到的现象**：项目展开状态**刷新即丢**。

**先回答"官方默认展开还是折叠"**（查上游源码 + 上游测试，非推断）：

上游 `WorkspaceBrowser.tsx:331-335`：

```tsx
.filter(key => groupExpansion[key] ?? ancestorKeys.has(key))
```

- 默认值 = `ancestorKeys.has(key)`
- `nestWorkspaces: false`（默认）→ `parents` 空 Map → `ancestorKeys` 空
  → **所有组默认折叠**
- 上游测试**每个**断言展开的用例都必须显式 `setGroupExpanded(key, true)`
  （:175, :210, :248, :340…），**没有一处**假设默认展开

所以**官方 = 折叠默认 + 记忆 + 一次性自动展开**。那条"自动展开"在
`:356-359`：

```tsx
if (current === undefined || currentGroup === undefined
    || Object.hasOwn(groupExpansion, currentGroup)) return
setGroupExpanded(currentGroup, true)     // 无记录时展开一次
```

`Object.hasOwn` 是"只自动展开一次，之后完全听用户的"。

**当时找到的根因（真实，但不是用户遇到的那个）**：`retainAccountKeys`
把不在名单里的 key **全部删除**，而它在本浏览器就绪时（~250ms）就跑，
远程 baseline 要到 ~12s —— 空数组无法区分"没有项目"与"模型未应答"，
于是把活项目的 key 当过期键删了。**这是竞态**，同一产物有时保住有时丢。

- [x] `retainAccountKeys` 传入 override 自己的 key
- [x] 空 override 时跳过清理
- [x] 实测：`probe-prune-race.mjs` 连刷 3 次，修复前 0/3、修复后 3/3

**为什么仍然回滚**：用户报的是**开关插件**丢状态，不是刷新丢。真正的根因是
**官方挂载会清掉共享 store 里的非工作区 key**（见 L2d）。L2c 把项目状态
**继续留在官方插件的 key 空间里**，只是教会了官方清理逻辑认识它——这正是
"官方就官方，我们就我们"要消除的耦合。方案 A 从根上分开，L2c 因此多余。

**代价（当时实测）**：项目数为 0 时，最后被删项目的 key 会残留到下次建项目
才清理（最多 1 个，自愈）。

**行为结论仍然成立且已并入 L2d**：官方 = 折叠默认 + 记忆 + 当前会话所在组
自动展开一次。

### L2d — 展开状态存进我们自己的领域 ✅ 已完成（2026-09-26）

**用户现象**（原话）："开启/关闭插件，插件侧无法记忆（开启则加载插件页面这里
无记忆，关闭回到官方界面是正常记忆展开收起状态的）。"

**根因（实测证明）**：

官方和我们的 vendored 副本**共用同一个 localStorage key**：

```
官方 ui-workspace : persist: 'dsh.workspace.view.v5'
我们 vendored     : persist: 'dsh.workspace.view.v5'   ← 同一个
```

官方挂载时跑 `retainAccountKeys([未分组, flat, ...工作区id])`，**删除名单外
所有 key**。项目 id 不在名单 → **每次官方挂载都被删**。

用**只装官方**的实例验证：

```
塞入:   {"<工作区id>":true, "project-seeded-by-probe":true}
刷新后: {"<工作区id>":true}
→ project-shaped key: PRUNED by the official mount
→ real Workspace key: kept (expected)
```

**这解释了"关闭回官方则正常"**：官方自己的 key 在名单里，所以正常记忆；
我们的被删。

**方案 A**：展开状态是我们的数据，存到**我们的**领域（`project_groups`）。

- [x] `spec.ts`：加 `expansions` 表，**version 保持 1**
      （`single` 布局版本不符直接 `version-mismatch` 且无迁移，加表读为空即可）
- [x] `protocol.ts`：`setExpanded` + `baseline.expansions`
      （**缺席 ≠ false**，前者才允许"自动展开一次"）
- [x] host：`@Remote('setExpanded')` + baseline + 删项目时级联清理
- [x] client `remote.ts`：加 1 个 descriptor
- [x] client `projects.ts`：`expansions` 可观察量 + **乐观更新**（失败回滚）
- [x] `grouping.ts`：`clientExpansions`（**独立席位**，有自己的早期订阅者集合）
- [x] vendored：按 **key 归属**分派读写；`expansions` 是**必需 hook + 默认值**
      （renderer 按 observable 身份绑定 hook，可选会退化成 `never`）
- [x] 回滚 L2c 的两处改动
- [x] 校验：`pnpm check` **218 项全绿**；新增 host 11 项 + client 13 项

**决定性验证（含反向对照）**

`probe-plugin-toggle.mjs` —— **自己启动服务器**，同一端口、顺序启动
（plugin on → official → plugin on）：

| | 旧 bundle (L2c) | 新 bundle (L2d) |
|---|---|---|
| 项目 key 在共享 store | `["", "<项目id>"]` ← **在里面** | `[""]` ← **不在** |
| 关插件再开后 | **`aria-expanded=false`** ← 用户报的现象 | `aria-expanded=true` ✅ |

**第一版探针是假阳性，被反向对照抓住**：我最初用两个不同端口的实例，
但 **localStorage 按 origin 隔离，origin 含端口** → 官方实例根本看不到项目
key → 探针恒过。用**旧 bundle** 跑也"通过"，才暴露这一点。改成同端口顺序启动
后，旧 bundle 如期失败、新 bundle 通过。

**落盘位置**（实测）：`$DSH_HOME/storages/project_groups.json`

```json
"expansions": { "<项目id>": { "expanded": true } }
```

**行为与官方一致**：折叠默认、记忆、当前会话所在组自动展开一次；
新建项目默认折叠。

### L2b-1 — 项目成员排序（时间 / 手动）✅ 已完成（2026-09-26）

**用户确认的现象**：项目内拖动排序**完全不工作**。

**根因（读代码 + 反向对照实测）**：`commitSessionDrag` 里

```ts
const accountSessionIds = activeDrag.accountKey === UNGROUPED_KEY
  ? ungroupedSessionIds
  : workspaces.find(w => w.workspaceId === activeDrag.accountKey)?.sessionIds
if (accountSessionIds === undefined) return      // ← 项目 key 在这里 return
```

且项目**完全不在排序管线里**（`orderedWorkspaces` 只遍历真实工作区，
`groupBySource` 直接拿 `source.sessionIds`，不调用任何排序函数）。
所以项目顺序原本 = `assignments` 的写入顺序，**既不按时间也不按手动**。

**方案：给项目一条平行的排序管线**，只**调用**官方三个纯函数，不改它们：

```tsx
const orderedProjects = groupingOverride?.map((source) => {
  const baseOrder = orderBy === 'updated'
    ? orderByRecency(memberIds, list.byId)
    : reconcileManualOrder(memberIds, projectOrders[source.key], list.byId, orderState)
  return { ...source, sessionIds: pinCurrentBlank(baseOrder, ...) }
})
```

然后 `groupingOverride={orderedProjects}` —— **一处改动**，因为 `SessionTree`
内部其它 `groupingOverride` 用法都不关心顺序（逐个查过）。

- [x] `spec.ts`：加 `orders` 表，**version 保持 1**
- [x] `protocol.ts`：`setOrders`（**整表替换**）+ `baseline.orders`
- [x] host：`@Remote('setOrders')`，**做 diff**（未变不写）+ 删项目级联
- [x] client：`orders` 可观察量 + **乐观更新**
- [x] `commitSessionDrag` 加一行 `?? groupingOverride?.find(...)`
- [x] `saveSessionOrder` / 菜单切换按 **key 归属**分派
- [x] 校验：`pnpm check` **252 项全绿**（host 57 + client 60）
- [x] **实测**：项目内拖动落位 + 自动切手动 + 刷新存活；
      菜单切手动冻结、切时间丢弃（读 Host 落盘文件确认）

**"冻结"是什么**（用户问过）：官方 `setOrderBy` 在时间→手动时把**当前渲染顺序**
抄进 `sessionOrderByAccount`。因为 `reconcileManualOrder` 对**没有保存顺序**的成员
用 `orderByRecency` 兜底 → **"手动模式 + 无保存顺序" ≡ 时间模式**。不冻结的话，
菜单显示"手动"而项目仍按时间重排。切回时间则**丢弃**（官方破坏性语义，照做）。

**项目顺序为什么必须存我们自己的领域**：`retainAccountKeys` **不只剪
`groupExpansion`**：

```ts
d.groupExpansion = ...filter(retained)
d.sessionOrderByAccount = ...filter(retained)   // ← 这个也剪
```

项目 key 不在官方名单 → 存共享 store 会被官方挂载剪掉（L2d 同款坑）。
**未分组继续用共享 store**（`UNGROUPED_KEY` 在名单里），行为一字不改。

**反向对照（探针有效性证明）**：`probe-project-reorder.mjs` 在**旧 bundle** 上
3 项全失败（顺序不变、模式仍 `updated`）——**复现了用户报的现象**；
新 bundle 全通过。

**我修掉的两个探针自身缺陷**（都是假信号）：

1. `[data-row-key^="session:"]` **匹配所有组的行** → 拖到了别的组的行
2. `dragTo` 默认落**行中心**，而 `rowHalf()` 判定中心以下为 `after`
   → 第 2 行拖到第 1 行中心 = "放在第 1 行之后" = **它本来就在的位置**，
   于是"什么也没发生"，看着像功能坏了。改成落**目标行顶边**。

### L2b-2 — 跨组归属（拖进 / 拖出 / 项目间互拖）✅ 已完成（2026-09-26）

**用户确认的现象**：会话**不能跨组拖动**。

**根因（读代码 + 反向对照实测）**：官方明确限制"会话拖拽不离开本组"：

```tsx
// :807  行只在同组时可接受
const sameGroupDrag = drag !== null && drag.accountKey === group.key
const compatibleTarget = sameGroupDrag && drag.pinned === node.pinned
// → false 时 Rows.tsx 的 onDragOver 直接 return（不 preventDefault = 不接受）

// :732  组容器只认"组拖拽"
onDragOver={workspaceDrag === null ? undefined : (e) => {...}}
// → 会话拖拽时组容器根本没有 onDragOver
```

**两条落点路径**（语义不同，反馈也不同）：

| 落点 | 语义 | 时间模式 | 手动模式 |
|---|---|---|---|
| **会话行** | "放在这里"（位置） | 落位 + **切手动** | 落位 |
| **组栏/组空白区** | "放进这个组"（归属） | **不写顺序**（recency 自然落位） | **插最前** |

**关键实现点**：

- `DragState.overGroupKey` 携带目标组；`over === null` 区分"落栏"和"落行"
  → 所以 `commitSessionDrag` 第二个参数改成可空
- `sessionDragOrder` **不能**复用：它从**目标组**的行里找被拖行，
  跨组时必然 `undefined`。新写 `insertIntoTargetOrder`（8 行），**不碰**原函数
- 归属走 `assignSession` / `unassignSession`；顺序走 L2b-1 的 key 归属分派
- `Rows.tsx` 的 `dragover`/`drop` 加 `stopPropagation`：让行优先于组容器，
  否则组容器会把位置指示线替换成组级目标
- `canReceiveDrag` 为 false 时（通用组合没有动词）跨组完全不激活，**行为退回官方**

**我发现的硬阻塞**：`groupBySource` 原本只在有游离会话时才渲染未分组桶。
所有会话都归类后，**未分组行消失 → 拖出项目无处可落**（进去就出不来）。
改为 **override 生效时始终渲染**；`groupByWorkspace` 保持原规则
（工作区分组下没有"自建组"可离开），`only`（只显示归档）仍隐藏空桶。

**校验**：`pnpm check` **257 项全绿**；`probe-cross-group.mjs` 覆盖
落行/落栏 × 时间/手动 × 拖出 × 项目间互拖 × 刷新存活。

**反向对照**：旧 bundle 上 **10 项失败**（含落栏路径）。

**我修掉的探针缺陷**（重要）：

1. 落栏路径的断言原来**只比数量**——"甲 2 个、乙 1 个"在拖动**失败**时
   前后完全一样，于是**空转通过**。改成断言**具体是哪个会话**移动了。
   旧 bundle 上这两条从 PASS 变成 FAIL，证明原断言是假信号。
2. `seedSession` 用 `fill` + 固定等待，**flaky**：Lexical 编辑器未就绪时
   消息没发出去，会话仍是空白，下一个 ＋ 会**复用它**，导致种子行数不足。
   改成 `type` + 轮询"消息是否成为行标题"。
3. `probe-order-mode.mjs` **需要空 `dshHome`**（它断言初始状态）。
   我在同一次运行里先后跑两个探针共用 home，它报了 2 个假失败。
   已在文件头写明。

### L2b-3 — 新项目置顶 ✅ 已完成（2026-09-26）

#### 问题3：新项目落最下面

**根因**：`create` 用 `[...this.order(), projectId]` 追加。

**官方行为**（查上游源码，非推断）：

```ts
// packages/workspace/workspace/src/index.ts:558  createCanonical()
workspaceIds: [id, ...state.workspaceIds],   // ← 置顶
```

全文件只有这一处插入 `workspaceIds`（搜过 `workspaceIds: [...`），
所以没有第二条追加路径。**用户诉求 = 官方行为**，我原来的实现是偏离。

- [x] `src/index.ts`：`[projectId, ...this.order()]`
- [x] host 测试更新 + 新增 2 组（置顶、置顶不破坏已重排顺序）
- [x] 反向对照：改回追加后新测试失败 5 项

#### 问题1：落点收窄 → ✅ **已完成（2026-09-27）**

**用户报的现象**：拖动时"不时闪过整项目高亮"——行间 2px 缝隙、行两侧留白
被当成落点。

**根因**：跨组落点挂在 `groupSection` 上，而**它比子元素高**——行与行之间的
`margin-top: 2px` 属于它。指针落在那 2px 里时，**在 section 内但不在任何行内**
→ section 的 `dragover` 触发 → 整组高亮。

**需求（用户澄清后的精确表述）**：**只收窄命中判定到标题行，高亮保持整组。**
这两件事回答不同问题——行是 handle（能落在哪），组是 destination（落下的含义）。

**最终实现**：

| | 位置 | 说明 |
|---|---|---|
| **命中判定** | **标题行**（`ProjectRowItem` 的 `groupDrop`） | 只有这里接受 drop；缝隙/侧面不接受 |
| **高亮** | **整组**（`groupSection` 的 `.groupDropTarget`） | 落下的含义是"进这个项目" |

`GroupDropProps` **不带 `active` 字段**——行只**报告**状态，region 自己算高亮
（`overGroupKey === group.key && over === null`）。这是"只收窄命中判定"在类型上的体现。

**踩坑（必须记住）**：`dragenter`/`dragleave` 在指针跨过**行的子元素**
（文件夹图标、箭头、标题）时**也会触发并冒泡** → 只在行内移动就会收到一个
`dragleave`，把指针从未离开的高亮清掉（第一版高亮**完全不出现**）。
所以 `dragover` 也要调 `enter`——它持续触发，让状态**自纠正**；
setter 必须**幂等**（同状态返回原引用），否则每个 dragover 都重渲染。

**探索过程中的弯路（记录以免重犯）**：

1. `eaa71f5`：命中判定**和高亮一起**缩到标题行 —— **理解偏了**，用户纠正。
2. 用户曾要求回滚（`e68996e`），理由是"不想改了又改更混乱"；
   明确需求后基于干净版本重做。

**校验**：`pnpm check` **262 项全绿**；`probe-drop-highlight.mjs` 全通过。

**反向对照（精确命中判别项）**：

| 检查 | 旧 bundle（命中在 section） | 新 bundle |
|---|---|---|
| 标题行上 → 整组高亮（挂 `groupSection`） | PASS（两版都亮整组） | PASS |
| 会话行上 → 不亮 | PASS | PASS |
| 从行返回标题行 → 高亮恢复 | PASS | PASS |
| **向 section 派发 `dragover` → 不接受** | **FAIL**（`defaultPrevented=true` 且高亮） | **PASS** |

**只有最后一项是判别项**——因为两版的高亮都在 section 上，
"高亮整组"本身不区分新旧；**区分新旧的是 section 是否接受 drop**。

**两个探针要点**：

- 2px 缝隙**无法用合成指针可靠命中**：section 只比子元素高 2px，下一行覆盖其中
  1px，**section-only 的像素只有 1 个**。必须**直接向 section 派发事件**。
- **派发检查必须放最后**：合成 `DragEvent` 会扰动 Chromium 的拖拽记账，
  下一次真实指针移动不再可靠触发 `dragover`，会把前面的断言变成"测 harness"。

**保存点**：`a013bc1`（改动前）、`e68996e`（回滚后重做的基线）、
tag `save/l2b3-highlight-whole-group` / 分支 `keep/l2b3-highlight-whole-group`（第一版实现）。

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

