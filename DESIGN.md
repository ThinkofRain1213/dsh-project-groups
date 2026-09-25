# DSH 项目分组插件 — 架构设计

> 状态：设计定案（分层实现）
> 版本：v1.1 · 2026-09-26
> 适用 DSH：0.1.7-rc.2（运行时实测版本）
> 定位：可发布的社区插件（`dsh-project-groups`）
> 交付方式：分 6 层（L0–L5），每层独立可交付、可回退（见 §5）

---

## 1. 一句话定义

**显示层插件。** 启用时用"项目分组"视图替换官方工作区视图，并接管"新建"入口；关闭时一切还原官方逻辑。

底层数据一律走官方；插件只额外维护一份"会话 → 项目"归属表和一份工作文档。

```
官方负责：会话的 cwd、归档、删除、沙箱根、日志目录
插件负责：前端分组显示、工作文档绑定与注入
```

---

## 2. 设计原则

| 原则 | 含义 |
|---|---|
| **不碰底层** | 不改任何会话的 `cwd`，不碰官方归档集合，不移动日志文件 |
| **显示可逆** | 所有效果通过 slot 注册达成，注销即还原官方逻辑 |
| **归档归官方** | 归档 / 取消归档 / 删除一律调官方 RPC，插件不存状态 |
| **单一落脚点** | 插件内新建的会话全部落在官方**默认工作区** |
| **双账分离** | 官方账（cwd 归属）只读；插件账（项目归属）独占 |
| **标准合规** | 数据用 `ctx.storageDomain`，配置用 schemastery，遵循 DSH 插件规范 |

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

### 3.6 `sidebar.workspaces` 是 single 槽位，但有 priority shadowing

```js
// ui-slots: 同 priority 抛错；不同 priority 则最低者渲染
if (occupant) throw new Error(`single slot "${options.name}" already has a registration ... 
  — register at a different priority to shadow it (lowest renders)`)
```

官方注册时**未指定 priority**（默认 0）。输的 entry 留在 ledger 上，注销自己的注册后官方**自动恢复**。

→ **这是"可逆显示接管"的实现基础。**

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

### 3.10 shadow 会连带屏蔽官方的子槽位渲染（关键约束）

`entriesOfSlot` 只跳过 **abdicated** 的 entry；shadow 只是"排序后不被选中"：

```js
for (const entry of rec.entries) {
  if (this.abdicated.has(entry)) continue;   // shadow 不走这里
  // 仅按 priority 取第一个作为 winner
}
```

而 `releaseEntry`（唯一调用 `releaseChildren` 的地方）**只在注册被 dispose 时触发**。

shadow 之后的状态：

| 项 | 状态 |
|---|---|
| 官方 entry 本身 | ✅ 仍在 ledger |
| 它声明的 children spec | ✅ 保留（`session.menu.item` / `session.row.action` / `directoryFlow` …） |
| 官方组件的渲染 | ❌ 不再渲染 |
| 那些子槽位上的注册 | ⚠️ 仍注册，但**没有渲染点** → 动作从界面消失 |

**两个必须接受的后果：**

1. **我们的注册不能声明同名子槽位** —— `register` 会检查：
   ```js
   if (childRec?.spec) throw new Error(`slot "${childKey}" is already declared (by ${childRec.declaredBy})`)
   ```
   所以不能声明 `sidebar.workspaces.directoryFlow` 等已被官方占用为 children 的键。

2. **官方会话级操作在接管层会一起消失** —— 归档 / 置顶 / 重命名 / 分叉 都渲染在官方组件内部（`renderSlot('sidebar.workspaces.session.menu.item', …)`）。接管后这些动作没有渲染点，**必须在自己的会话行上重新实现**（直接调官方 RPC：`archiveSession` / `pinSession` / `renameSession` / `forkSession`）。

→ 这正是**分层实现**的核心理由：先落地接管机制，再逐层补齐被屏蔽的官方能力。

### 3.11 `sidebar.workspaces` 的 owner 契约较宽

官方 `WorkspaceBrowserProps` 需要一整套注入面（`startSession` / `open` / `searchSessions` / `renameSession` / `forkSession` / `renameWorkspace` / `deleteWorkspace` / `insertWorkspaceBefore` / `archiveSession` / `insertSessionBefore` / `createWorkspace` + `hooks`）。

→ 我们的组件**不必实现全部**——只实现自己用到的；但凡是界面上暴露给用户的操作，都必须有真实实现，否则点了没反应。

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
│  ⑤ 主视图                                                         │
│     注册 sidebar.workspaces @ priority < 0（shadow 官方）          │
│     渲染项目分组 + "未分组"桶                                      │
│                                                                 │
│  ⑥ 新建入口                                                       │
│     "新建工作区"按钮 → 替换为"新建项目"（填标题，不选目录）          │
│     项目内/未分组下"新会话" → workspaceId = 默认工作区              │
│                                                                 │
│  ⑦ 拖拽                                                           │
│     会话从"未分组"拖进项目 → projectGroups/assign                 │
│     · 完全不碰官方 cwd / attachSession                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. 分层实现（L0–L5）

### 5.0 分层总览

每层都是一个**可独立发布、可独立回退**的完整插件版本。低层是高层的严格子集——后一层只在前一层之上增加能力，不改写前一层的行为。

```
L0  接管 + 收拢          纯前端，无数据、无 host
     ├─ shadow 官方 sidebar.workspaces
     └─ 全部会话收进一个"未分组"列表
                │
L1  新建项目              引入 host + 领域数据
     ├─ 领域表 projects
     ├─ Remote: create / rename / delete / follow
     └─ "新建项目"入口（替换官方按钮）
                │
L2  拖拽归类              引入归属映射
     ├─ 领域表 assignments
     ├─ Remote: assign / unassign
     └─ 会话从"未分组"拖进项目
                │
L3  会话操作补齐          补回被 shadow 屏蔽的官方能力
     ├─ 归档 / 取消归档（调官方 RPC）
     ├─ 重命名 / 分叉 / 置顶
     └─ 会话行 hover 动作 + 菜单
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

**为什么是这个顺序**

| 顺序 | 理由 |
|---|---|
| 接管在最前 | 它是全部功能的前提；且能立刻暴露"哪些官方能力会消失"（§3.10） |
| 项目早于归类 | 没有项目就无处可拖 |
| 归类早于会话操作 | 归类是插件独有价值；会话操作只是补回官方已有能力（可后补） |
| 新会话晚于归类 | 需要先有项目和归属表，才有"在项目里建会话"的语义 |
| 文档最后 | 依赖项目表（docPath）与归属表（找到会话属主）；且是唯一的 host 注入逻辑 |

---

### L0 — 接管 + 收拢

**目标**：验证 shadow 机制可用，并把"全部会话收进未分组"这一最基础形态跑通。

**交付物**

| 项 | 内容 |
|---|---|
| 插件形态 | **纯 client 插件**（无 host half） |
| slot 注册 | `sidebar.workspaces` @ priority `-100` |
| 渲染 | 一个平铺列表：**全部会话**（不含归档） |
| 数据来源 | `useSessions` 全局 hook（官方 ui-workspace 已在 root 提供） |
| 交互 | 点击打开会话；"新会话"按钮透传官方 `startSession()` |

**技术要点**

- 组件 props 的 `inject` 面**只实现用到的**：`startSession` / `open` / `hooks`
- **不能声明** `sidebar.workspaces.directoryFlow` 等子槽位（已被官方声明，重复声明抛错，§3.10）
- 归档过滤：L0 默认**不显示归档会话**（与官方"隐藏归档"默认一致），用 `workspaces.archivedSessionIds` 判断
- 会话列表直接用 `list.ids` / `list.byId`，无需任何插件自有数据

**已知收缩（L0 明确不提供）**

- ❌ 官方工作区分组（这是接管的目的）
- ❌ 归档 / 置顶 / 重命名 / 分叉 的行内动作（被 shadow 屏蔽，L3 补回）
- ❌ 搜索、目录选择、工作区树

**验收标准**

1. 启用插件 → 侧栏显示全部会话的平铺列表，官方工作区分组消失
2. 关闭插件 → 官方工作区分组完整恢复（含用户改过的名字）
3. 点击会话能正常打开
4. "新会话"能正常创建并打开
5. 归档会话不出现

**回退**：卸载插件即完全还原，无残留数据。

---

### L1 — 新建项目

**目标**：引入 host 侧与领域数据，支持创建项目（只有标题，不选目录）。

**新增交付物**

| 项 | 内容 |
|---|---|
| 插件形态 | 升级为 **host + client 双面** |
| 领域声明 | `defineDomain({ name: 'projectGroups', version: 1, tables: { projects } })` |
| 领域记录 | `projects`: `{ title, docPath, createdAt, updatedAt }` |
| Remote | `projectGroups/create` · `rename` · `delete` · `follow`(stream) |
| Client 渲染 | 项目列表置于"未分组"桶**之上** |
| 入口 | "新建项目"按钮（替换官方"新建工作区"）→ 弹标题输入框 |

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

### L3 — 会话操作补齐

**目标**：补回被 shadow 屏蔽的官方会话级能力（§3.10）。

**新增交付物**

| 操作 | 实现方式 |
|---|---|
| 归档 / 取消归档 | 调官方 `workspace/archiveSession` / `unarchiveSession` |
| 重命名 | `session/rename` |
| 分叉 | 官方 `forkSession` |
| 置顶 / 取消置顶 | `workspace/pinSession` / `unpinSession` |
| 打开 / 复制标题 | 官方对应能力 |

**技术要点**

- **一律调官方 RPC，插件不存状态**——这是"不乱"的前提（§2）
- 归档后从列表消失；取消归档后回到原分组位置（归属表未动）
- 会话行 hover 动作 + `...` 菜单，对齐官方交互
- 置顶排序：可复用官方 `pinnedSessionIds`，或先用插件内部顺序

**验收标准**

1. 归档一个会话 → 从列表消失；在官方视图（关插件后）也是已归档
2. 取消归档 → 回到原项目下
3. 重命名生效且官方视图同步
4. 分叉能创建子会话
5. 插件与官方对"归档"的认知**永远一致**（同一份数据）

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
| L0 | 无 | shadow 机制失效（官方改契约） | 降级到 `sidebar.panellist` 并列入口 |
| L1 | L0 | 领域 schema 变更 | 用 `version` + `compatibleVersions` |
| L2 | L1 | 拖拽交互复杂度 | 先做"菜单里选择项目"的后备路径 |
| L3 | L0 | 官方 RPC 行为差异 | 全部走官方，不自己实现归档语义 |
| L4 | L1 | 默认工作区被删/改名 | 按 path 探测 + 用到才补建 |
| L5 | L1、L4 | 注入与官方预算冲突 | 独立消息 + 大小上限 |

**每层都必须满足**：关闭插件后官方视图与数据完全不受影响。

---

## 6. 关键流程

### 6.1 插件启用（视图接管）

```
1. client half 加载
   → ctx.slots.inject('sidebar.workspaces', () =>
       ctx.slots.register({ name: 'sidebar.workspaces', priority: -100, ... }))
   → 官方 WorkspaceBrowser 被 shadow（entry 仍在 ledger，子槽位声明保留）

2. 读官方 workspace/follow 流（baseline + 增量）
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

### 6.4 关闭插件（还原）

```
client half 卸载 → 我们的 sidebar.workspaces 注册 dispose
  → shadow 消失 → 官方 WorkspaceBrowser 自动恢复
  → 用户在默认工作区改的名字照常显示（官方数据）
  → 其他自建工作区的会话照常显示
  → 插件期间建的会话都在默认工作区里（因为用了 workspaceId）
```

**关键**：因为插件期间的会话**真的**建在默认工作区（不是虚拟归属），关闭后它们是官方数据里名正言顺的一部分，**不需要任何迁移**。

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
| 5 | shadow priority | **负数（-100）** | 与官方默认 0 拉开；最低者渲染 |
| 6 | 项目文档位置 | **`$DSH_HOME/projects/<id>.md`** | 标准位置；用户可覆盖 docPath |
| 7 | 交付方式 | **分 6 层（L0–L5）** | 每层可独立交付、可回退；先验证接管机制 |

---

## 12. 风险与对策

| 风险 | 对策 |
|---|---|
| 官方升级改 `sidebar.workspaces` 契约 | shadow 依赖公开文档化的 priority 行为。失败时降级到 `sidebar.panellist` 并列入口 |
| shadow 连带屏蔽官方会话动作 | L3 全部补回（调官方 RPC，不自己实现语义） |
| 用户手删领域数据 | 领域文件在 `$DSH_HOME/storages`，与官方 workspace 同级。可加备份导出 |
| 默认工作区被用户删除 | **下一个新会话时自动补建**（§6.3） |
| 用户重命名默认工作区 | 查 path 不查 title，不受影响；关闭插件后名字照常显示 |
| 注入与官方 AGENTS.md 预算冲突 | 官方 64 KB 预算独立计算；插件注入设大小上限 |
| 两套账不一致 | 属正常（各记各的）。"未分组"按"全部会话 − 已认领"算，天然自洽 |
| 多进程写领域 | 官方领域层文档明确"无跨进程写锁"；插件数据写入频率低，可接受 |

---

## 13. 与 0.1.5 旧设计的区别

| | 旧设计（2026-09-22 讨论） | 本设计 |
|---|---|---|
| 范围 | 会话管理 + 项目跟踪 + 知识图谱 | 仅显示层分组 + 工作文档 |
| 状态 | 五级状态机 + 四态台账 | **零状态**（全交官方） |
| 数据 | 想解析会话内容 / 自动分类 | **零解析**（只要会话 id） |
| 图谱 | 独立全屏面板 | 不做 |
| 改动面 | 深（碰归档、血缘、LLM） | 浅（一个 shadow 注册 + 一个领域） |

**核心简化：把"会话管理"整块让给官方，插件只做"给会话起中文项目名 + 绑定一份文档"。**

---

## 14. 待实现清单（按层）

### L0 — 接管 + 收拢
- [ ] client 插件骨架（`package.json` / `dsh.client.platform: web`）
- [ ] `sidebar.workspaces` shadow 注册（priority -100）
- [ ] 平铺会话列表组件（含归档过滤）
- [ ] 点击打开 / 新会话透传

### L1 — 新建项目
- [ ] host half 与领域声明 + `ctx.storageDomain` 打开
- [ ] Remote：`create` / `rename` / `delete` / `follow`
- [ ] 项目列表渲染 + "新建项目"输入框
- [ ] 项目重命名 / 删除

### L2 — 拖拽归类
- [ ] `assignments` 表启用
- [ ] Remote：`assign` / `unassign`
- [ ] 拖拽交互 + 放置目标
- [ ] 未分组桶计算（全部 − 已认领）

### L3 — 会话操作补齐
- [ ] 归档 / 取消归档（官方 RPC）
- [ ] 重命名 / 分叉 / 置顶
- [ ] 会话行 hover 动作 + `...` 菜单

### L4 — 默认工作区与新会话
- [ ] 默认工作区探测（按 path）
- [ ] 补建（mkdir + `workspace/create`）
- [ ] 新会话（带 workspaceId）+ 自动归类

### L5 — 工作文档
- [ ] `docPath` 编辑 UI
- [ ] `agent/pre-step` 注入
- [ ] 文档模板与大小上限

### 通用
- [ ] 构建配置（tsdown + `cordis.patch.yml`）
- [ ] 测试（domain / RPC / 注入 / 补建逻辑 / 开关还原）
- [ ] 每层的"关闭插件后官方视图无损"回归测试

