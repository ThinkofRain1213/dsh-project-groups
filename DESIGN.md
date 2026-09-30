# DSH 项目分组插件 — 架构设计

> 状态：设计定案（已转向 **fork 官方组件** 路线）
> 版本：v2.1 · 2026-09-30
> 适用 DSH：0.2.0-rc.2（壳）· vendor 源 **0.2.0-rc.2**（同步流程见 §5 的 **L4.5**）
> 定位：可发布的社区插件（`dsh-project-groups`）
> 交付方式：基础功能分 6 层（L0–L4.5），额外功能见 §24

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
- vendor 内容（L0 交付时）：22 个文件，**与上游逐字节一致**（哈希比对已验证）
- 维护方式：DSH 升级时重新复制，见 `src/vendored/README.md`

> **⚠️ 现状修正（2026-09-30）**：上面第 2、3 条描述的是 **L0 交付时**的状态，**已不再成立**。
> 项目分组需要分组缝，因此 `src/vendored/` 现有 **41 条登记 patch，涉及 10 个文件**，
> **不再逐字节一致**。实际标准见 §2 第 7 条：**允许结构性、可选的改动，且每一处都必须
> 登记进 `src/vendored/README.md` 的 patch 表**（那是重同步时的唯一清单）。
> 这份 README 同时记录了"哪些偏离是有意的行为改变"，与结构性缝分开列。

---

## 1. 一句话定义

**在完全权限工作流下，用项目做轻量的会话归属。**

DSH 官方的工作区是**目录所有权**记录：一个会话属于某工作区，是因为它的 `cwd` 等于该工作区
的 `path`。这套模型要求你**事先手动指定目录**，而本插件的用法是**完全权限、不按目录划分工作**——
目录那套在这里是多余的负担。

所以插件把"分组"从**目录**上摘下来，变成一个**纯粹的前端归属**：项目**没有目录**，
只是给会话贴的一个标签，用来把不同项目的会话分开管理。

```
官方（经 vendor，由本插件持有）：会话的 cwd、归档、删除、沙箱根、日志目录、完整界面
插件新增：项目分组、项目归属表
```

**基础功能 = 完全不动官方 + 只做项目分组。** 除此之外的一切（工作文档等）
都是**额外功能**，默认不做，见 §24。

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
| **vendor 可加缝、必登记** | `src/vendored/` 允许**结构性、可选**的改动（不传即等官方行为），每一处都登记进 `src/vendored/README.md` 的 patch 表，供重同步时逐条重打 |

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
│  ③ 底层工作区守护                                                  │
│     检测（按 path）→ 缺失则 mkdir + workspaceRegistry.create 重建   │
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

## 5. 分层实现（基础功能 L0–L4.5）

### 5.0 分层总览

每层都是一个**可独立发布、可独立回退**的完整插件版本。低层是高层的严格子集——后一层只在前一层之上增加能力，不改写前一层的行为。

基础功能到此为止：**完全不动官方，只按项目分组适配完全权限工作流。**
下表之后的一切都是**额外功能**，默认不做（见 §24）。

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
L4  底层工作区与新会话     新会话要有地方可落
     ├─ 底层工作区探测 / 选择 / 路由（①②③a③b 已完成）
     └─ 项目内/未分组下"新会话" → 落点
                │
L4.5 上游同步流程         让 vendor 能跟着 DSH 升级走
     ├─ 同步要做什么、按什么顺序做
     ├─ 41 条登记 patch 的逐条重打清单
     └─ 差距量化与验证手段
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

### L4 — 底层工作区与新会话

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

### 5.x 层间依赖与风险

| 层 | 依赖 | 主要风险 | 缓解 |
|---|---|---|---|
| L0 | 无 | 官方升级改私有契约（vendor 漂移） | vendor 逐字节留存 + `compare-bundle.mjs` 断言 external 一致；升级时重新同步 |
| L0 | 无 | 禁用官方行失败（id 变更） | `verify-patch.mjs` 断言无 patch 被跳过；id 变更时同步更新 |
| L1 | L0 | 领域 schema 变更 | 用 `version` + `compatibleVersions` |
| L2 | L1 | 拖拽交互复杂度 | 先做"菜单里选择项目"的后备路径 |
| L3 | L0 | 官方 RPC 行为差异 | 全部走官方，不自己实现归档语义 |
| L4 | L1 | 默认工作区被删/改名 | 按 path 探测 + 用到才补建 |
| X-2 | L1、L4 | 注入与官方预算冲突 | 独立消息 + 大小上限（额外功能，见 §24） |

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

## 8. 工作文档规范（额外功能 X-2 的规格）

> **⚠️ 本节描述的是额外功能，默认不做。** 见 §24 的 **X-2**。
> 基础功能里 `docPath` 字段存在但恒为空串、不消费；这里定义的是**若实施**时的规范。

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

> **编号说明**：§9 不存在（历史上被并入 §8.3）。编号保持现状以免打乱全文交叉引用。

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
| `ctx.on('agent/pre-step')` (host) | 文档注入 | X-2（额外功能，见 §24） |

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
| 7 | 交付方式 | **基础功能分 6 层（L0–L4.5）**，额外功能单独列出 | 每层可独立交付、可回退；先验证"替换官方行"能干净启动 |
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

### 新会话落点（三步走）— 第一步 ✅ 已完成（2026-09-27）

**背景**：用户报"未分组 ＋ 失效"。实测复现出完整链条，也牵出了设计层的选择。

#### 根因

`WorkspaceBrowser.tsx` 的 `onCreate` 只给**项目行**传 `beforeOpen`：

```tsx
const filedUnder = group.kind === 'project' ? group.key : undefined
startSession(group.workspaceId, filedUnder === undefined ? undefined : ...)
```

**未分组行**（`kind !== 'project'`）→ `beforeOpen` 为 `undefined` → **与顶部"新会话"按钮
完全同一条路径**：

1. 未分组没有 workspaceId → `startSession(undefined, undefined)`
2. → 解析默认工作区
3. → `reuseOrCreateBlank` **复用该工作区的空白会话**（`navigation.ts:184`）
4. → 那个会话**带着旧项目的 `assignments` 条目**
5. → **没有任何一层清除它** → 新会话出现在旧项目下

**关键**：`beforeOpen` 是**唯一**能表达"归档意图"的机制（`navigation.ts:422` 在会话存在后、
成为主视图前调用）。未分组行不用它，就被当成了"无意图"。

**更准确的表述**：这是**我们自己的架构缺口**，不是官方 bug。官方没有"归属"这一层，
所以官方那个按工作区复用的逻辑无害；在我们的模型里它变成"归属被继承"。

#### 第一步的修法

让未分组行**也表态**——传 `beforeOpen` 去 `unassign`，从"无作用域"变成"显式意图"。

**三分支**（对应三种行）：

| 分支 | 行 | 动作 |
|---|---|---|
| `isProject` | 项目行 | `assign(sessionId, group.key)` |
| `isUngrouped` | 未分组行 | `unassign(sessionId)` |
| 否则 | 真实工作区行 | **不归档** |

**为什么第三分支要显式写出**：它在本组合下**不可达**（`clientGrouping` 恒为数组 →
`deriveGroups` 必走 `groupBySource`），但若将来**不带 override 复用这个组件**，
真实工作区行会落进"否则"——**若被 unassign，会静默解除一个真实工作区会话的归属**。
显式写出比依赖外部前提安全，且重读补丁的人立刻看懂。

**用 `key === UNGROUPED_KEY` 判别**，与同文件 `canReceiveDrag`（`:445`）**同一套判法**，
避免两套并存。

- [x] `WorkspaceBrowser.tsx`：`onCreate` 的归档分派（**唯一改动点**）
- [x] 动词缺失时 `file` 为 `undefined` → 不传 `beforeOpen` → **退回改动前行为**（对通用组合安全）
- [x] `console.warn` 文案统一为 `'file session rejected:'`
- [x] `pnpm check` **262 项全绿**

#### 验证（含反向对照）

`probe-ungrouped-plus.mjs` 走用户报的路径（建项目 → 点项目＋ → 点未分组＋），
读 Host 落盘的 `assignments` 表断言**归属**：

| | 旧 bundle | 新 bundle |
|---|---|---|
| 未分组＋ 后会话在哪 | **甲** ❌ | **未分组** ✅ |
| `assignments` | 归甲 ❌ | **空** ✅ |

**我修掉的探针缺陷**：最初断言"未分组＋ 会**新增**一个会话"（`filter !before.includes`），
但实际是**复用同一个空白会话**（`reuseOrCreateBlank` 的预期行为）——
所以断言恒失败，而**产品是对的**。改为**追踪那个会话的归属**。

#### 这一步是"半修"

**顶部"新会话"按钮仍被劫持**——它走 `navigation.ts`，不经过 `WorkspaceBrowser`。
**第二步修它。**

#### 后续两步（已冻结设计）

- **第二步**：设置存储 + `startSession` 按设置分派（覆盖顶部按钮、快捷键、
  `ui-agent-preset`、`ui-schedule`）。选项：1 未分组 / 2 当前会话所在项目 /
  3 最后活跃的会话所在项目 / 4 指定项目（留后）。**选项2 无当前会话时落未分组**
  （依据：官方归档后**不猜、让用户选**；我们的"未分组"就是那个合法默认）。
- **第三步**：设置卡片 UI，落在**插件自有页面**（`plugins.bundle.config` 槽位）。
  这里原本写的是 `settings.plugin.item`——**那个槽位在当前版本不存在**，
  见下方第三步一节的更正。

#### 第二步 ✅ 已完成（2026-09-27）

**设置**：`spec.ts` 的 `global` 加 `newSessionTarget`
（`z.enum(['ungrouped','current','recent']).default('ungrouped')`）。
**单例，不建表**；`version` 保持 1。

**向后兼容（实测，非推理）**：`storage-domain/src/index.ts:151` 在打开时用
`globalSpec.schema.parse(snapshot.global)` 解析，而 zod 的 `.default()` **在
parse 时生效** → 旧存档（缺字段）读出 `'ungrouped'`。用 node 直接验证过 zod 4.6.5，
并有 host 单测固定。

**⚠️ 类型检查抓到的一个真 bug**：`Domain.global.set` 是**整体替换**而非合并
（`domain.ts:194`），而 `create` / `remove` / `reorder` **三处**都写
`{ projectIds }` —— 加上新字段后，**每一次都会抹掉用户的设置**。
修法是加一个私有 `setGlobal(domain, patch)` 展开当前值，**四处统一走它**。
这是"加字段"暴露出的既有隐患，不是新引入的。

**解析策略**（`src/client/target.ts`，纯函数，可单测）：

```
ungrouped → undefined
current   → ownerOf(currentSessionId) ?? undefined    ← 无当前会话落未分组
recent    → recentProject()
```

**`recentProject` 照搬官方 `recentWorkspace`**（`ui-workspace/navigation.ts:428`）：

- 取项目内成员会话 `updatedAt` 最大值
- **空项目回退 `project.createdAt`**（否则刚建的空项目永远选不中）
- **严格 `>`** → 平局保留先出现的（项目显示顺序）

**接缝**：`UiWorkspaceService` 构造时接一个可选 `placeUnscoped(sessionId, currentSessionId)`，
`startSession` 里 `beforeOpen ?? placeUnscoped`：

- **`beforeOpen` 优先** —— 项目行和未分组行的 ＋ 各自声明落点，**永不受设置影响**
- 只有**没有 `beforeOpen`** 的入口（外壳新建按钮、快捷键、`ui-agent-preset`、
  `ui-schedule`）才走设置

**为什么接缝必须在服务里**：`ui-agent-preset` 和 `ui-schedule` 都声明
`inject: ['uiWorkspace']`，而官方那份被我们 disabled → 它们拿到的**必然**是我们的
实例 → **一处接缝全覆盖**。在 `WorkspaceBrowser` 打补丁覆盖不到它们。

**职责划分**：`vendored` 只提供它独有的数据（会话 `updatedAt`，因为只有它有
`sessions`），`src/client/` 做全部决策（只有它知道"项目"）。

**校验**：`pnpm check` **298 项全绿**（host 71 + client 81）。

**反向对照**：旧 bundle 上 **5 项失败**（含"设置被忽略、恒落未分组"）。

**我修掉的探针缺陷**（两轮，都是"探针错、产品对"）：

1. **改文件 + reload 不生效**：Host 把解析后的 global **缓存在内存**
   （`domain.ts:188`），domain 打开后只改内存 → 文件改动对运行中的进程不可见。
   改为**走真实 RPC**（`POST /api/projectGroups/setNewSessionTarget`，即第三步卡片要用的端点）。
2. **计数式断言**：空白会话是**复用/迁移**的，不累积，所以 `length === 2` 恒不成立。
   改为**追踪那个会话的身份与归属**（与第一步探针同型的错误）。
3. **`current` 与 `recent` 在多数场景下答案相同** → 那两条断言在旧 bundle 上也 PASS。
   补了一个**能分开两者**的场景（新建一个更晚的空项目：`recent` 选它，`current` 仍选原项目），
   旧 bundle 上该判别项失败。

#### 第三步 ✅ 已完成（2026-09-28）

**设置卡片 UI**，落在**插件自有页面**上。

**槽位：`plugins.bundle.config`**（`ui-plugin-manager/src/client/slot-contract.ts:89`）

```ts
/** A bundle's own configuration, keyed by the bundle's package name and
 *  rendered on the bundle's page between its description and its rows. */
'plugins.bundle.config': { kind: 'keyed'; scope: 'root'; owner: PluginConfigViewProps }
```

**渲染点**（`PluginManagerPage.tsx:575`）：**描述 → `[data-plugin-config]` → 「包含的组件」**，
即"侧栏 → 插件 → dsh-project-groups"那一页。

**`key` 必须是我们的 bundle 名 `dsh-project-groups`**，因为：

1. 页面按 `entryKey = pkg.name` 分派这个 keyed 槽位；
2. **`configured` 就是从这个槽位的 key 投影出来的**
   （`config-ledger.ts:51` `keysOf('plugins.bundle.config')` → `:66` `bundles`）——
   **key 不匹配则整段不渲染，且无任何报错**。所以探针必须真的驱动页面，
   不能只断言"注册成功"。

**先例**：官方 `client-ui-voice-input` 的 `mount.ts:45` 用同一槽位 + 同一写法
（`key: <自身 bundle 名>`、`locale`、`inject: () => actions`、type-only 导入
`@deepseek-ai/dsh-client-ui-plugin-manager/client`）。**我们的写法与它同构。**

**⚠️ 一次被推翻的调研结论（记下来，避免重犯）**

我先后给出过三个**错误**方案：

| 说法 | 实际 |
|---|---|
| 注册 `settings.plugin.item`（照 `平滑光标`） | 该槽位在 **0.1.7-rc.2 里 0 次出现**（app.asar 实测），纯空转 |
| 注册 `settings.plugins.tab` | 槽位对，但是**"设置→插件"标签页**，不是插件自有页面 |
| 用 `PreferenceRow` 下拉行 | 它服务于 `settings.general.item`，**不是**我们的槽位 |

**根因**：一直在"读源码猜"，**没有先找同槽位的完整先例**。
**方法教训**：先定位"谁用了同一个槽位"，再照抄；猜测式的子品牌/组件复用一律不算依据。

**控件：`Menu` 下拉，不用原生 `<select>`**

官方语音输入的 `识别服务`/`识别语言` 是**原生 `<select>`**，
而它的弹出层**由操作系统绘制、CSS 管不到** → **深色主题下弹白底**（用户截图实测）。
`VoiceInput.module.css:29` 只给了闭合态样式，官方全仓 `color-scheme` 仅 1 处（Excel 预览写死 `light`）。

**`Menu`**（`@deepseek-ai/dsh-client-ui-primitives`，在 `PLATFORM_MODULES` 内、外部化零体积）
自带主题浮层、勾选态、键盘导航。**行布局**照 `PermissionRow`，**CSS 逐字复制**
（client bundle 纯度门禁禁止跨插件值导入——官方自己也复制）。

**主题实测**（探针 `page.emulateMedia` 双色断言）：

| 主题 | 弹出层填充 |
|---|---|
| light | `rgba(248,249,250,0.58)` |
| dark | `rgba(67,69,74,0.45)` |

**跟随主题**，白底问题不复现。

**注册**

```ts
ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
  name: 'plugins.bundle.config',
  key: 'dsh-project-groups',
  locale: SETTINGS_NS,
  inject: () => ({ hooks: { target: clientNewSessionTarget }, setTarget }),
}, ProjectGroupsCard))
```

**`form` 不用**：`PluginConfigViewProps.form` 是宿主配置表单；
我们的设置在自有领域，走自己的 RPC——**语音输入同样无视它**。

**新的可观察量 `clientNewSessionTarget`**（`grouping.ts`）：独立席位，
含早期订阅者队列（与 `clientExpansions`/`clientOrders` 同型），
模型未就绪时快照读 `'ungrouped'`（与 `EMPTY_STATE` 一致）。
**不交给 vendored**：侧栏渲染分组，无需知道落点。

**校验**

- `pnpm check` **302 项全绿**（原 298；新增 4 项：席位早期订阅默认值 / 唤醒 / 读回 / 跟随后续变更）
- `probe-settings-card.mjs` **13 项全过**
- **反向对照**：旧 bundle 上 `[data-plugin-config]` **sections: 0**，3 项失败、其余优雅跳过
- 回归三件套全过（跨组拖拽 / 未分组＋ / 插件开关）
- 构建纯度：`ui-plugin-manager` 在 `lib/client.js` **0 次**（type-only 导入无运行时代码）

**一个环境陷阱**：`probe-plugin-toggle.mjs` 需要预建 `official` profile
（`--profile official --from-default-profile web`）。隔离 `DSH_HOME` 下缺它会
"official exited early with 1"——**是探针环境缺口，不是产品回归**。

#### 修复 ✅ `recent` 永远选不中未分组（2026-09-28，用户实测报告）

**症状**：未分组里明明有最后活跃的会话，新建会话却落到某个项目（`abc`）。

**根因（两处，缺一不可）**

1. **未分组从不参与候选**。`target.ts` 的循环写的是 `for (const project of projects)`，
   只遍历项目 ⇒ `recent` **永远返回某个项目**，无法返回未分组。
   最后活跃的会话在未分组时，代码退而挑"项目里最新的"。
   （官方 `recentWorkspace` 没有"未分组"这种桶，所以照搬不完整——我们的模型里
   未分组是**合法落点**。）

2. **⚠️ 自引用陷阱（朴素修复会被它毁掉）**。
   `reuseOrCreateBlank`（`navigation.ts:189`）**复用**工作区里那个空白会话，
   实测点击前后是**同一个 id** ⇒ **它本就在列表里**。
   而 `updatedAt` 传的是整张 `byId` 表（`vendored/client/index.ts:207`）
   ⇒ **正在被安置的会话自己就在时间表里**，带着**它自己创建时间**，
   并且**带着上一次的归属**。

   **后果**：若只把未分组加为候选，那个空白会话会被算作未分组的成员，
   以"刚刚创建"的时间**必然获胜** ⇒ `recent` 退化成"永远未分组"。
   同时它也让上次落到的那个项目**白拿一个今天的时间戳**——
   **它就是靠自己的创建时间，决定了自己的下一个落点**（自我实现的预言）。

   **排查依据**：`SessionSummary.updatedAt` 的类型文档写的是 *"durable message
   time"*（由**用户消息**推进），RPC 实测空白会话在点击前后 `updatedAt` 不变
   ⇒ **是创建时间，不是活动**。

**修复（两处）**

1. **源头剔除空白**（`vendored/client/index.ts`）：组装活动表时跳过 `summary.blank`。
   - 空白会话**就是"没有活动"的定义**；一个停在项目里的旧空白同样不该算证据
     ⇒ **按 `blank` 标志剔除，不按 id**
   - 放这里而非 `src/client/`：**只有 vendored 半能看到 `blank`**（它持有会话列表）
   - 不需额外"排除正在安置的那个"参数：`reuseOrCreateBlank` **两条路径都要求 blank**
     ⇒ 它必然已被剔除

2. **未分组成为候选**（`target.ts`，函数改名 `recentProject` → **`recentDestination`**，
   因为它不再只返回项目）：
   - 未分组**放最后比较**，配合严格的 `>` ⇒ **未分组不靠平局赢项目**
     （沿用官方"稳定按显示顺序"的精神，不引入新偏好）
   - 未分组**无 `createdAt` 回退**：它不是实体、没有创建时间；没有散落活动就**不该被选中**
   - 返回 `undefined` 即未分组，与 `resolveTarget` 既有语义一致，**无需改签名**

**校验**

- `pnpm check` **306 项全绿**（原 302；新增 4 项：未分组胜出 / 项目仍胜 / 未分组无活动不能赢 / 平局归项目）
- `probe-recent-blank.mjs` **判别性场景**：两个空项目，`甲.createdAt=2019` 且**停着一个空白会话**
  （其时间是"刚刚"），`乙.createdAt=2021`；改文件后**必须重启**（Host 内存缓存）
  - 修复前：**甲**（空白会话靠自己的创建时间胜出）—— **实测确认**
  - 修复后：**乙**（空白被剔除，按 `createdAt` 比较）—— **实测确认**
- 回归四件套全过（新会话落点 / 设置卡片 / 未分组＋ / 跨组拖拽）

**我修掉的探针缺陷**（第 N 次"探针错、产品对"）：

1. `domain()` 返回的是 `{unit, global, tables}`，而 `blankOwner` 在**顶层**解构
   `assignments`/`projects` ⇒ 永远读到空 ⇒ 报告"无归属"，**而产品是对的**。
   诊断输出里能直接看到 assignment 已写入。**改为一律走 `.tables`**。
2. 断言"等出现归属"不够：种子阶段之后空白**已属于甲**，第一次读会拿到旧值
   ⇒ 误测了种子。改为**等归属发生变化**（`ownerAfter`）。

#### 仍未做

- **选项4（指定项目）**：需要项目选择器 + "所选项目被删除"的策略。枚举后加，向后兼容。
- **问题4**：项目行不显示会话数（`GroupNode.sessionCount` 已存在，呈现方式待定）。
- **已归档会话是否参与"最近活跃"**：官方 `recentWorkspace` 不剔除，我们目前也不剔除。
  若"最近活跃"停在已归档会话上，`recent` 会跟过去——**未决**。

---

#### 修复 ✅ 新建会话"先落旧项目再滑过去"（2026-09-28，用户实测报告）

**用户报告**（原话）：点标题行 ＋ 后新会话绑定到某项目 → 选中该项目的已有会话（新会话收起、
不渲染）→ 再点**该项目**的 ＋ 是**淡入**（与官方一致），但点**别的项目**的 ＋，新会话会
**从原项目出现然后平滑移动到后一个项目里**。

**逐帧 + `Element.prototype.animate` 实测复现**（`probe-new-session-motion.mjs`）：

```
同一项目 ＋   帧: (absent) → A        动画: opacity→opacity 100ms          ✅ 淡入
不同项目 ＋   帧: (absent) → A → B    动画: opacity 100ms + transform 200ms ❌ 先落 A 再滑到 B
```

**根因**：`reuseOrCreateBlank` 复用的空白会话**仍带着上一次的 assignment**。而
`assign`/`unassign` 的第一句就是 `await this.remote`，**不做乐观更新** ⇒

| 帧 | assignments | 渲染位置 |
|---|---|---|
| 第 1 帧 | `session → A`（复用带的旧归属） | A |
| 第 2 帧 | RPC 落地 → follow 帧 → `session → B` | B |

`AnimatedRows` 按"该 key 上一帧在不在"分流：新 key → `{opacity:0}→{opacity:1}` 淡入；
已知 key 换位置 → `translate(dx,dy)` 平移。⇒ 第 2 帧位置变了，**平移**。

**官方为何没这问题**：官方**没有"归属"这一层**——工作区是**会话创建参数**，不是后续写入的
映射，所以**从来没有"归属未定"的中间态**（只有一帧）。加上 `sessionVisible`
（`tree.ts:299`）规定空白会话**只在它是当前选中时可见**，它只有一个家，不会被搬动。
**官方的"淡入"不是刻意做的动画，是"位置从未变过"的自然结果**（走 `AnimatedRows` 的
`continue` 分支，零动画）。

**修法**：`assign`/`unassign` 改为**乐观写入**（写本地 → 通知 → 再调 Host）。
`navigation.ts:434` 的 `beforeOpen?.(...)` 是**同步调用**且**先于** `selection.set`，
所以状态更新只要在第一个 `await` 之前，React **首次渲染时归属已经是 B** ⇒ 直接出现在 B。

**四个关键点**（每一条都对应一种"静默失效"）：

1. **必须清 `derived`**（`applyAssignments`）。三个既有乐观 setter 都不清，因为它们改的字段
   **不参与分组派生**；而 `groupingSnapshot()` 正是**从这个 map 派生**且按引用缓存
   （`this.derived ??=`）。**不清则分组快照不更新 → 行根本不动 → 修复完全无效，且无任何报错。**
   这是本次最容易踩的坑。
2. **同值 early return**。保住"同一项目 ＋ → 淡入"：无状态变更 → 无通知 → 仍是新 key。
3. **`delete` 而非赋 `undefined`**。`sameAssignments` 与 `groupingSnapshot` 都走
   `Object.keys`，留一个值为 `undefined` 的键会让"未分组"被算成有归属。
4. **`pendingPlacements` 叠加未回声的写入**。会话创建本身也会广播一次 baseline，它可能
   **晚于**我们的乐观写入到达并把它冲掉 ⇒ 又变回两帧。**同类 bug，不是理论风险**。
   回声（Host 每次提交都推 baseline ⇒ 值相等）即清除，**自终止，无需定时器**。

**两处按会话粒度的收紧**（与初版方案不同）：

- **回滚按会话**，不用整表快照。写入单位是**一个会话**；整表回滚会抹掉在途期间**另一个会话**的
  合法变更。（`setOrders` 的整表回滚是对的——它的写入单位**就是**整张表。）
- **守卫用自增令牌而非值**。同一会话可依次写 B→A→B，值的相等无法区分世代，
  旧写入的失败会误删新写入的条目。

**已知限制（记录在代码注释里）**：Host 接受但**从不回声**的写入会把该会话的归属**本地钉住**。
前提是"归属只经本类写入 + 单客户端"；**若将来多端写入，正解是给 baseline 加代际号，
而不是加超时**。

**顺带修好**：`commitCrossGroupDrag`（`WorkspaceBrowser.tsx:596-598`）走的就是这两个方法
⇒ **跨组拖拽不再"弹回再归位"**。

**改写的模块注释**：`projects.ts:9` 原写 *"nothing is applied optimistically"*，
但**从第二步起就已有三个乐观 setter**（`setExpanded`/`setOrders`/`setNewSessionTarget`，
各自在方法上写着 "Optimistic"）。规范与实现分叉时后来者会照错的规范做——**这正是我上一步
踩过的坑**。现改为列出五处 + 给出判据：**"用户正在看着自己动作的后果时就乐观"**。

**验证**：
- `verify-projects.mjs` 新增第 25 节 **8 条**断言（乐观落地 / **派生分组同步** / 空通知 /
  按会话回滚 / 在途 baseline 不覆盖 / 回声后叠加退役 / unassign 删键）。
  为此给 `fakeRemote` 加了 `holdAssign`（可挂起指定会话的写入）与 `deliver`（投递任意
  ——含**过期**——的 baseline）。
- `probe-new-session-motion.mjs`（新增，7 条）**判别项是跨项目那两条**。
- **反向对照**：同一探针跑 pre-fix bundle ⇒ **恰好那 2 条失败、其余 5 条通过**
  （`(absent) → A → B` + `transform`）。修复后 7 条全过。

**探针自身踩过的坑**（记录以免重犯）：

1. **必须真实点击**。`AnimatedRows` 只在 `onPointerDownCapture` 之后才动；
   `dispatchEvent('click')` **不触发**它 ⇒ 无动画 ⇒ **所有结果都"看起来正确"**。
   探针用合成的 `pointerdown` 只做"解锁"（真实点击行会改变当前会话，从而影响空白行是否渲染）。
2. **会话 id 要整取**。id 本身就是 `session-<uuid>`，按固定宽度切片会切到**字面前缀**
   `session-`，**所有 id 看着一样**。
3. **分组标识用 row key，不用可见标题**。渲染器**截断标题**，同前缀的两个项目会相等，
   而针对截断文本写的断言**永远不会匹配**（曾因此让一条负控"假通过"）。
4. **非空白会话行不能用 `.first()`**。空白会话被归类后就渲染在**它上面**，`.first()`
   点到的是空白自己 ⇒ 场景准备失败。
5. **每个探针要独立 `DSH_HOME`**。四个探针共用一个 home 会让项目累积，
   而其中三个断言的是**精确项目数**（1 或 2）⇒ **假失败**（我犯过）。

## 新会话的行身份带上项目（2026-09-28）

### 问题

点项目 A 的 ＋，再点项目 B 的 ＋，**同一个空白会话从 A 的组平移到 B 的组**——
横跨整个侧栏滑过去。官方从不这样。

### 根因（逐帧实测）

`AnimatedRows` 判断"淡入还是平移"**只看 key 在上一帧是否存在**
（`AnimatedRows.tsx:92-105`）：

```ts
const previousRow = snapshot.positions.get(key)
if (previousRow === undefined) { fade(); continue }   // key 新 → 淡入
if (dx === 0 && dy === 0) continue                     // 没动 → 什么都不做
glide()                                                // 同 key 换位置 → 平移
```

官方跨工作区时，A、B 各持**不同**的会话 ⇒ 不同 key ⇒ `opacity→opacity` 淡入。
我们 A、B 是**同一个**会话（所有项目共用默认工作区）⇒ 同一 key 换了位置 ⇒ 平移。

**实测**（项目行 ＋，逐帧密集采样）：

| 场景 | 关键指标 |
|---|---|
| A＋（首次） | y 有 12 个中间位置，`transform+opacity→transform+opacity` |
| A＋（再来） | 无动画 |
| **B＋** | **y 有 12 个中间位置，`transform+opacity→transform+opacity`** ← bug |
| 跨组拖拽 | 74 采样点只有 2 个 y 值 ⇒ 瞬移（与 key 无关，拖拽期间 `ready=false` 关了动画） |

**官方 blank→real 实测**（官方 profile 发首条消息）：同一 id、同一分组、
**DOM 节点同一对象**、0 位移 0 淡入 —— 即**原地 patch，连淡入都没有**。
原因：行 key 恒为 `session:<id>`，`blank` 只改标题与尾部单元（`Rows.tsx:49,720,734`）。

### 修法

**只改行的"动画身份"，让它带上所属项目；后端与数据面一行不动。**

```ts
export function sessionRowKey(id, groupKey) {
  return groupKey === undefined ? `session:${id}` : `session:${id}@${groupKey}`
}
```

| 场景 | key | 结果 | 对照官方 |
|---|---|---|---|
| A＋ 首次 | 新 | 淡入 | ✅ |
| A＋ 再来 | 不变 | 无行为 | ✅ |
| **B＋** | `…@A` → `…@B` | **淡出 + 淡入** | ✅ 跨工作区同构 |
| **空白→真会话** | **不变**（同组） | **零动画原地 patch** | ✅ 与官方逐项一致 |
| 跨组拖拽 | 拖拽期间动画被关 | 瞬移 | ✅ 不变 |

**关键不变式**：`blank` **不进** key。进了就会让每次首次发消息变成交叉淡入，
直接违背上面那条官方实测。

改动 4 处：`Rows.tsx`（helper + 可选 `rowKey` prop + `data-row-key`）、
`WorkspaceBrowser.tsx`（`rowKeys` 与行 prop 两处，**必须同源同序**，因为
`AnimatedRows` 按位置配对）。`navigation.ts` / `tree.ts` / `stores.ts` /
`src/index.ts` / `spec.ts` **均未改动**。

### 验证

- `scripts/probe-row-key-motion.mjs`（新增，**16 项断言**）：四种转换 + 拖拽回归。
  反向对照（改前）**恰好失败 4 条**跨项目断言。
- `scripts/lib/row-key.mjs`（新增）：`@` 之后 id 的解析**只有这一处实现**，
  避免各探针各写一份而静默比错。
- 数据面复核：`@` **不落盘**（localStorage 无 `@`、无 `session:`）；
  关插件后官方侧栏恢复且**会话一条不丢**（`消失的会话: []`）。
- `pnpm check`：**13 suites / 321 断言全绿**（数量与改前一致，未新增/删除断言）。

### 边界

- **不碰后端复用**："草稿变成真会话后才新建下一个"是官方 `reuseOrCreateBlank`
  的现成行为（只在 `summary.blank` 为真时复用）。
- **顶栏新会话按钮无需改码**：其落点在 `beforeOpen` 里**同步**完成，
  渲染时 key 已算对（`probe-new-session-target.mjs` / `probe-settings-card.mjs` 覆盖）。
- **flat 单列表模式保持官方 key 逐字节不变**（无组可换）。
- 约 10 个既有探针改为经 `scripts/lib/row-key.mjs` 取 id；其中
  `probe-project-reorder.mjs` 的解析在 **Node 侧**，用 `sessionIdOf` 而非
  `window.__sessionIdOf`（后者只在页面内存在）。

### L3 — 行内动作适配  ✅ 已完成
- [x] 项目自身的重命名 / 删除 / 排序（新对象）—— 已实现（`WorkspaceBrowser.tsx` 的
  `kind: 'project'` 分派 + 对话框标题，以及 `reorderProject` 拖拽）；**重命名与新建均查重**，
  标题唯一（对齐官方工作区的 `renameDuplicate` 规则，见 §13 第 12 条）
- [x] 归档 / 取消归档在项目分组下的回落行为 —— 已实现：归档行**留在原项目**下灰显、
  不可打开；`groupBySource` 对每个会话走官方 `sessionVisible`
  （`archivedFilter` 三态 default/show/only）；插件**不写**官方归档集合
- [x] 搜索结果的归属跟着项目走 —— 已实现：`deriveSearchResults` 加可选第 9 参 `sources`，
  与 `deriveGroups` 同一套注入约定；分组时**只认项目、不回退工作区**（见 §13 第 13 条）

**移入额外功能**：*会话 hover 卡显示所属项目* —— 官方 `SessionHoverContent` 本来就没有这个概念，
加了属于超出官方，见 §24 的 **X-1**。

### 已知未适配（用户 2026-09-28 提出，记录在案）

**1. 搜索结果仍按"工作区"分组，未适配项目。** ✅ **已修复（2026-09-30）**

用户截图：搜索 "你" 时，结果行下面显示的是 **"默认工作区" / "重要"**，而不是所属**项目**。

原因（已核到代码）：搜索走的是**另一条与 `groupBySource` 无关**的派生路径
`deriveSearchResults`（`tree.ts:553`），它的实参是**官方 `workspaces`**：

```
WorkspaceBrowser.tsx:1159  deriveSearchResults(list, workspaces, query, ...)
                                                        ^^^^^^^^^^ 官方工作区列表
tree.ts   workspaceBySession ← 由 workspaces[].sessionIds 建表
tree.ts   labelOf(summary) = workspaceBySession.get(id) ?? workspaceLabel(summary.cwd)
```

所以它认的是**官方 cwd 归属**（默认工作区），与插件的 `assignments` 表毫无关系。
截图里的"重要"**已核实是一个真实工作区**，不是项目名：桌面 profile 的
`workspace.json` 里 `a77ef37c-…` 的 `title` 就是 `重要`、`path` 是 `D:\下载\重要`。
即 `labelOf` 的第二来源 `workspaceLabel(summary.cwd)` 命中了一个非默认工作区。

**修法方向**（未实施）：让 `SearchResults` 也接受 `groupingOverride`，`labelOf`
优先查"会话 → 项目"的归属表，查不到再回落官方的 `workspaceBySession` / `cwd`。
需要动 `deriveSearchResults` 的签名与调用点各一处。

### 上游版本

**2. 已升级到 `0.2.0-rc.1`；插件在该版本下实测正常。**（2026-09-28）

| 项 | 值 |
|---|---|
| 本机安装的 DSH | **0.2.0-rc.1**（实测 `app.asar` 内 `dsh-desktop` 与 `dsh-desktop-runtime`） |
| 本机安装的官方 `ui-workspace` | **0.2.0-rc.1** |
| 本插件 vendor 自 | **0.1.7-rc.2** ⇒ **尚未同步** |
| 插件在 0.2.0 下是否可用 | **✅ 挂载正常、pageerror 0、console error 0**（`scripts/probe-upstream-upgrade.mjs`） |

**重要**：所以"已升级 DSH"与"已同步 vendor"是两件事。当前状态是
**跑在 0.2.0 的壳上、用 0.1.7 的 vendored 源码**，实测可用——
因为 vendored bundle 只经 shell 的模块表解析同名 externals、按 id 禁用官方行、
占用同一个 slot，这三条在 0.2.0 都没变。

**待办：完整同步 vendor**（走 `src/vendored/README.md` 的 "Keeping it in sync"）：
fetch `0.2.0-rc.1` tag → 重拷 `packages/client/ui-workspace/src/client/` →
**逐条重打 6 条 patch** → 重跑 `compare-bundle.mjs` 与全部探针。

**升级时最易被冲掉的 patch**（按风险排序）：
1. `sessionRowKey`（patch 6）依赖 `AnimatedRows` 的 `previousRow === undefined` 判据
   与 `Rows.tsx` 的 `data-row-key`——上游若动这两处，那条不变式要重新确认
2. `placeUnscoped` / `beforeOpen`（patch 4、5）改的是 `startSession` 的签名与 `navigation.ts`
3. `contract/slots.ts` 的子槽位声明（`sidebar.session.row.leading` / `.hover`）——
   0.2.0 的 `ui-schedule` 依赖它们，见下

### 0.2.0 新增：自动化任务（定时任务）— 待适配

0.2.0 引入调度能力，三个包：`dsh-schedule`（host 半）、`dsh-client-ui-schedule`（界面）、
`dsh-experimental-schedule-bundle`（用 patch 把前两者插进默认 composition）。
桌面 profile 已启用 `schedule` + `ui-schedule` 两行。

**实测（`scripts/probe-schedule-integration.mjs`，隔离 profile 同时挂本插件 + 调度）**：

```
插件侧栏已挂载: true      ← 本插件仍是侧栏所有者
启动级错误    : pageerror 0 / console error 0
调度 UI 是否在同一侧栏: ✅ 是（"自动化任务" 入口可见）
```

**已经天然兼容的部分**（无需改码）：

| 接缝 | 实测 |
|---|---|
| 调度界面调用 `ctx.uiWorkspace.startSession()` | **`uiWorkspace` 正是本插件提供的服务**（官方行被 disable）⇒ 该调用**已经**走本插件的默认工作区解析与 `placeUnscoped` 落点策略 |
| 调度声明的子槽位 `sidebar.session.row.leading` / `sidebar.session.row.hover` | **本插件的 vendored entry 已声明这两个 child**（`contract/slots.ts:130,135`）⇒ 行内标记能渲染 |
| 调度 host 半自己建会话吗 | **不建**。只监听 `session/created` 与 `agent/created`，每次到期**在原会话里追加**（bundle 注释："delivers each due occurrence as a follow-up in its original Session"）⇒ **不产生新会话，不涉及"单一落脚点"** |

**仍需适配的（待办）**：

- [ ] **端到端验证**：真的建一个定时任务并等它触发，确认 (a) 任务行内标记出现在**项目分组**的行上，
      (b) 触发时是**原会话追加**而非新建，(c) 不破坏行 key 的跨组淡入
- [ ] **任务面板与项目分组的关系**：调度面板在 `sidebar.panellist`，是独立 tab；需确认
      "按会话"的任务目录在项目分组下语义正确
- [ ] **`probe-upstream-upgrade.mjs` / `probe-schedule-integration.mjs` 纳入常规回归**
- [ ] 若上游把调度改成"新建会话执行任务"，则需接入 `placeUnscoped` 策略（现在不需要）

### L4 — 底层工作区与新会话  ✅ 已完成

- [x] 底层工作区探测（按 path）—— 已实现（`initializeDefault`，纯读）
- [x] **重建（建目录 + 注册工作区）—— 已实现**（`@Remote('rebuildBaseWorkspace')`：
  `mkdir -p` → `workspaceRegistry.create`；`'default'` 模式下采纳为 `'specified'`，
  原因见下节"官方硬约束"）
- [x] 新会话（带 workspaceId）+ 自动归类 —— 已实现（`navigation.ts` 的 `placeUnscoped`）

#### 底层工作区设计（2026-09-29 定稿，分三步实现）

**术语**（用户指定）：叫「**底层工作区**」，不叫"默认工作区"——
因为缺失的可能是默认工作区，也可能是用户指定的工作区。

**它是什么**：本插件**所有新会话的落脚点**（§2「单一落脚点」）。
项目行 ＋ / 未分组 ＋ / 顶栏按钮，最终都落在它里面。

**为什么由插件管**：项目没有目录（项目 ≠ 工作区），所以需要一个真实目录承接会话。
官方默认工作区就是那个目录；用户也可以指定别的工作区。

##### 三步走

**顺序（2026-09-29 用户确认调整）**：先弹窗骨架 → 再设置卡片 → 最后新建能力。
理由：弹窗的两个动作分别依赖后两步，先做骨架能把"静默无反应"立刻变成"明确告知"，
且每步可独立交付、独立验证。

| 步 | 内容 | 状态 |
|---|---|---|
| **1** | **弹窗骨架**：缺失才弹；三个按钮 + **取消可用**，另两个 **disabled** | ✅ **已完成（2026-09-29）** |
| **2** | **设置卡片**：选默认 / 指定工作区（二选一卡片 + 卡片内「更换…」） | ✅ **已完成（2026-09-29）** |
| **2.5** | **路由**：把底层工作区接到新会话上，替掉"只走官方默认" | ✅ **已完成（2026-09-29）** |
| **3a** | **重新指定**：跳设置卡片 + 自动打开选择弹窗 | ✅ **已完成（2026-09-29）** |
| **3b** | **重建该工作区**：host 建目录 + 注册工作区 | ✅ **已完成（2026-09-29）** |

##### 第 3b 步的补充：二级确认（3b-2，2026-09-29）

**触发**：用户反馈"你不是说设计了二次警告弹窗吗，我实测没看到"。

**核实结果：我没做弹窗，做的是正文一行小字。** 我在设计时说的是
**"建目录前要不要二次确认 —— 我建议要（弹窗里加一句'将在 X 创建目录'）"**，
**"二次确认"和"加一句"混在同一句里**，用户按前者理解。**表述歧义是我的责任。**

**更实质的问题**：那行提示的样式是 **`--dsw-alias-label-tertiary`（第三级最淡）+ 12px**，
**比路径那行还弱**。针对"即将写磁盘"的提示，视觉层级**明显不当**。

**用户定：加二级弹窗**（理由：*"毕竟是写操作，还会动官方目录"*）——
**这个理由比我的强**：`default` 模式下重建的路径就是 **官方默认工作区的真实目录**。

**⚠️ 探查发现：不能用"第二个 Modal"**

**`RiskConfirmation` 本身就是 Modal**：
```js
function RiskConfirmation({...}) { return jsxs(Modal, { open, onClose: onCancel, ... }) }
```

**官方三个使用者全部是"从设置行/菜单打开"**（`permission-presets` ×2 用 `PermissionRow`；
`commands` 用 `PopupSelectView`），**没有一个是"从另一个 Modal 里打开"**。

**⇒ 官方没有"弹窗里再开弹窗"的先例。** 而实测风险是真实的：

```css
.root { z-index: 1000; }   /* 两个 Modal 同值 */
```
```js
document.addEventListener("keydown", keydown)   // 每个 Modal 各装一个
```

| 风险 | 后果 |
|---|---|
| 两个 document Escape 监听 | **一次 Esc 关掉两个** |
| 两个焦点陷阱 | 焦点可能逃到外层 |
| 同 z-index 靠 DOM 顺序 | 可工作但**脆弱** |

**⇒ 用户采纳方案 A：同一个 `Modal` 切两屏**（一个 DOM，零嵌套风险）。

**改动 5 个文件**：

| 文件 | 改动 |
|---|---|
| `BaseWorkspaceMissing.tsx` | `stage: 'report' \| 'confirm'`；两套 footer/正文；`onClose` 分阶段 |
| `locales.ts` | 5 个 `baseMissing.confirm*` 键（删掉 `rebuildHint`）|
| `WorkspaceBrowser.module.css` | `.baseMissingConfirm` + 图标（删掉 `.baseMissingHint`）|
| `scripts/...rebuild.mjs` | 适配两阶段（见下）|
| `scripts/...confirm.mjs` | **新增**：确认阶段的验收探针 |

**关键设计**：

1. **`stage` 用命名联合而非 boolean** —— 三个阶段（"重建失败重试"）可预期，
   而 `isConfirming` 会演化成一对能互相矛盾的标志位。
2. **`onClose` 分阶段**：确认阶段 Escape/点遮罩 ⇒ **返回报告阶段**，不是关闭。
   理由：用户拒绝的是"确认"，不是整个尝试；直接关掉会让他再点一次 ＋ 才能回来。
3. **`busy` 时 `onClose` 直接 return** —— 请求已发出，**关掉弹窗不会撤销它**，
   假装能取消是不诚实的。
4. **确认阶段再显示一次路径** —— 确认的**核心就是"确认哪个目录"**。
5. **文案含"若该目录已存在，其内容不会被修改"** —— 这是**必要的**：
   `mkdir` 幂等、**不删除任何东西**（3b 实测第 4 条）。说清"不会破坏"消除最大顾虑。

**⚠️ 我的注释写错了，实测纠正**

我在焦点 effect 上方写：
> *"Without this the focus would sit on the button that just unmounted"*

**反向对照（去掉 effect）⇒ 探针仍全绿**，说明**这个判断是错的**。继续探查得到真因：

```
报告阶段第一个按钮: "重建该工作区"  ← 打标记 + 聚焦
确认阶段第一个按钮: "确认重建"     ← hasMark: true, isFocused: true
```

**⇒ React 按位置复用了同一个 DOM 元素**（两阶段都是 `div > Button, Button`，索引 0 对齐），
**焦点"没丢"是因为元素没被替换，不是因为我移动了焦点。**

**处理**：**保留 effect 作保险**（重排 footer 就会失去复用），但**注释改成实测结论**，
并明说"去掉它当前不会让探针失败"。**不把通过了但没在测的东西当成证明。**

**验收（`probe-base-workspace-confirm.mjs`，15 条断言全绿）**：

```
1) 进入确认阶段（标题变「确认重建」）+ 含警告文案
2) 确认阶段显示目标路径
3) 焦点在「确认重建」按钮上
4) 点「返回」⇒ 回到报告阶段，弹窗不关
5) 确认阶段 Escape ⇒ 返回（不关闭）
6) 报告阶段 Escape ⇒ 关闭（无回归）
7) 走完确认 ⇒ 目录创建 + 注册成功 + 弹窗关闭
8) 全程 dialog 数量恒为 1（证明没有嵌套 Modal）
```

**反向对照（把确认阶段的 `onClose` 改成 `settle`）⇒ 第 5 条失败。**
（第 4 条**正确地仍通过**：「返回」是按钮直接 `setStage`，不走 `onClose`——
**这说明探针确实在区分两条路径**。）

**⚠️ 3b 探针需要适配（不是回归）**：它的 `missingDialog` 用
`filter({ hasText: '底层工作区缺失' })` 定位，而**确认阶段标题是「确认重建」** ⇒
那个 filter 不再匹配 ⇒ **超时**。**已改为不按标题过滤**，并在 `pressRebuild` 里补一次「确认重建」点击。
**这类"按阶段标题定位"的脆弱性值得记下。**

##### 第 3b 步实现（2026-09-29）

**⚠️ 探查中发现一个会让 3b 一半失效的官方硬约束**：

```js
// dsh-workspace/lib/index.js
initializeDefault(resolveDirectory) {
  const state = this.requireState();
  if (state.defaultWorkspaceId !== void 0) return this.entities.get(state.defaultWorkspaceId);
  //                                                        ↑ 已删记录 ⇒ undefined
  // …创建路径【永远不会到达】
}
```

**官方文档注释逐字**：
> *"Repeated requests reuse its durable identity; **deleting that registration permanently
> disables automatic creation**."*

**schema 注释**：
> *"First-use Workspace identity, **retained after its registration is deleted**."*

**⇒ 这是官方**有意设计**：`defaultWorkspaceId` 一旦写入就永久保留，删除注册后
`initializeDefault` 永远返回 `undefined`，且**没有** `setDefault` / `adoptDefault` 可修。**

**实测**（`probe-rebuild-default-mode.mjs`）：
```
1) 默认工作区 id=fc9eed09…
2) 删除注册 ⇒ initializeDefault → null
3) mkdir + 同路径重新注册 ⇒ 成功，但拿到【新 id】040e2b30…（defaultWorkspaceId 仍指 fc9eed09…）
4) 重建后 initializeDefault → null   ❌ 仍然解析不到
```

**⇒ mkdir + create 对 `specified` 是完整修复，对 `default` 是无效修复。**

**用户的场景正是 `specified`**（`{mode:'specified', path:'D:\下载\apk'}`）⇒ 3b 解决实际问题。

**`default` 模式的处理（用户确认采纳方案 A）**：把它**采纳为 `specified`**。

```ts
const mode = stored.mode
if (mode === 'default') {
  await this.setGlobal(domain, {
    baseWorkspace: { mode: 'specified', path: entity.path ?? path, name: entity.title },
  })
}
```

理由：**只动插件自己的域**，且**结果诚实**（那个工作区现在确实是插件在管的一个路径）。
**代价**：卡片会从「默认工作区」变成「指定工作区」——所以 `mode` 放进返回值，
让调用方**看得见**这件事，而不是到卡片上才发现。

**改动 7 个文件**：

| 文件 | 改动 |
|---|---|
| `src/protocol.ts` | 加 `ProjectRebuildBaseWorkspaceValue`（含 `mode`）|
| `src/index.ts` | `@Remote('rebuildBaseWorkspace')`：`mkdir` → `registry.create` →（default 时）采纳 |
| `src/client/remote.ts` | 注册 descriptor（零参数）|
| `src/client/projects.ts` | `ProjectRemote` + `ProjectModel.rebuildBaseWorkspace`（**不乐观写入**）|
| `src/client/index.ts` | 实现 `rebuildBaseWorkspace`（用 `requireModel`，让失败浮出）|
| `vendored/.../BaseWorkspaceMissing.tsx` | 加"将创建目录"提示 |
| `vendored/client/locales.ts` + `WorkspaceBrowser.module.css` | 提示文案 + 样式 |

**关键设计**：

1. **Host 自己读设置，不接受调用方传路径** —— 单一真源，弹窗显示的与实际重建的**不可能不一致**。
2. **`registry.create` 而非 `workspace/create` Remote** —— 后者**只转发 path**，
   标题会被 `defaultWorkspaceTitle` 从 basename 推导；直调能**保留用户选的名字**。
   实测：`title: '我给它起的名字'` 存活。
3. **`entity.path` 回写设置**，而非请求的 path —— registry 返回**规范化后**的路径
   （`realpathNormalize`），符号链接/大小写差异才不会让设置与注册表对不上。
4. **`mkdir -p`（`recursive: true`）** —— 已存在时幂等；父目录也没了时是唯一能成的写法。
5. **`ctx.get` 调用时读**（与 ②.5/③a 一致）—— 实测该服务**1000ms 才出现**
   （0/250ms 采样 `present: false`）；写进 `inject` 会把整个插件拖到那时才激活。
   而属性读 `ctx.workspaceRegistry` **始终抛错**（`without inject`），三次采样一致。
6. **这是本插件唯一不做乐观写入的动词** —— 其余动词改的是"用户正看着的状态"，
   这一个是**真实磁盘副作用**，失败必须浮到弹窗（所以用 `requireModel`，不是守卫式读取）。

**⚠️ 实现时自己发现并修掉的一个 bug**（探针输出里看出来的）：

```
重建后设置: {"mode":"specified","path":"…default-workspace","name":"deep"}   ← ❌
```

`default` 模式下 `stored.name` 属于**另一个路径**（记忆会跨模式保留），
我最初直接把它传给了 `create` ⇒ **用无关的名字给默认工作区命名**。

**修正**：只有 `specified` 模式才传 stored name（那个名字是**为该路径**捕获的）；
`default` 模式不传，让 registry 从目录推导。实测变为 `name: 'default-workspace'`。

**验收（`probe-base-workspace-rebuild.mjs`，全绿）**：

```
1) 目录已创建 + 已注册为工作区 + 弹窗关闭
2) 重建后 ＋ 落在重建的工作区（不再弹窗）
3) 标题是用户起的名字，不是 basename
4) 目录已存在时重建幂等（该路径仍只有一条）
5) 父目录也不存在 ⇒ mkdir -p 一路建上去
6) default 模式被采纳为 specified + ＋ 落点正常 + 未沿用旧名字
7) 弹窗提示将创建目录
```

**反向对照**（把 `mkdir` 移到 `create` 之后）：**7 条失败**，正是依赖正确顺序的那些。

**⚠️ 一处探针盲点，已如实记录在探针里**：
第 6 条**对顺序不敏感**——`default-workspace` 目录**本来就存在**（用户桌面上的真实目录），
所以顺序反了 `create` 仍成功。**要把这个前提做实就得删掉那个真实目录**——
而它由 OS Documents 派生，**不属于 `DSH_HOME`**，是**用户真实数据**。
**⇒ 不为一条已被 1/2/5 覆盖的断言冒这个风险。**


##### 第 3 步拆分（2026-09-29 用户决定）

用户提出把 ③ 拆成 **3a 跳转+弹窗** 与 **3b 重建路径**。理由与 ②/②.5 分离相同：
两个按钮依赖完全不同 ——

| | 3a「重新指定底层工作区」 | 3b「重建该工作区」 |
|---|---|---|
| 性质 | 纯前端导航 + 复用已有弹窗 | **真实磁盘写入 + 注册表写入** |
| host 改动 | **不需要** | 需要（`fs.mkdir` + `registry.create`）|
| 风险 | 零（不动数据） | 会**真的建目录** |

##### 第 3a 步实现（2026-09-29）

**目标**：点缺失弹窗的「重新指定底层工作区」⇒ 跳到插件设置卡片 + **自动打开选择弹窗**。

**改动 4 个文件**（**零 host 改动**）：

| 文件 | 改动 |
|---|---|
| `vendored/client/session-actions/BaseWorkspaceMissing.tsx` | 按钮先 `settle()` 再调 `chooseBaseWorkspace` |
| `vendored/client/contract/slots.ts` | `chooseBaseWorkspace` 文档改为"已接上（3a）" |
| `client/index.ts` | **实现** `chooseBaseWorkspace` + `chooserRequest` store + 注入 |
| `client/settings-card.tsx` | 消费请求 ⇒ 自动 `setPicking(true)` |

**关键设计（三处实测结论）**：

**① 导航用 `pluginNavigation.openBundle`（官方服务）**

```js
// 插件管理器自己发布
ctx.reflect.provide("pluginNavigation", {
  openBundle: (name) => { ctx.layout.selectPanel("plugins"); instance.actions.setView({kind:'package', name}) }
})
```

**实测**：从**真实第三方 cordis fiber** 一次调用即**跳到插件页 + 挂载我们的卡片**；
换成别的 bundle 名我们的卡片消失（参数生效）。
**⇒ 一次调用完成两件事，是官方正路（列表行的 `onOpen` 驱动的同一个 view machine），不是后门点击。**

**② `ctx.get` 而非 `inject`（我上轮判断错了，此处纠正）**

实测作用域：provide 点距离 **`slots.register` 仅 952 字符**，且后面**紧跟 `yield` 释放**：

```js
const disposeNavigation = ctx.reflect.provide("pluginNavigation", {...});
yield () => { disposeNavigation(); };      // ← 与 slot 生命周期绑定
```

**⇒ 该服务只在插件页 slot 挂载期间存在。** 若写进 `inject`：
cordis 的 `inject` 是**门** ⇒ 服务不在时**整个插件不激活**
⇒ **关了插件页，项目/分组/持久化全会死**。

**⇒ 必须 `ctx.get`，在点击时读。**

**我上轮说"inject 合法且安全"是错的** —— 我看到"我们已 inject plugin-manager"就下了结论，
**但那注入的是包（静态），而这是那个包在 slot 里发布的服务（动态）**。两者不同。

**③ 官方先例不能直接抄**

`dsh-experimental-client-ui-voice-input` 确实写 `inject: ["pluginNavigation"]`，但它：
```js
const ui = ctx.inject(["remote.speech", "slots", "locale", "pluginNavigation"], registerUi);
```
**⇒ 那是嵌套 `ctx.inject` 子 fiber**，作用域恰好覆盖插件页。**顶层 inject 是另一回事。**

**⇒ 先例只证明"可以调"，不证明"该写进顶层 inject"。**

**④ 弹窗交接：store 而非 prop**

卡片在**请求发出后才挂载**（`openBundle` 触发导航 ⇒ 那次渲染创建卡片）。用 store：
**快照读取返回当前值** ⇒ 晚挂载的卡片首次渲染就能看到请求。

**消费（置回 `null`）防止的是另一种缺陷**：请求留着的状态下卡片**重新挂载**
⇒ `useEffect` 因挂载执行 ⇒ **弹窗自己冒出来**（用户没要求）。

**验收（`probe-base-workspace-respecify.mjs`，全绿）**：

```
1) 缺失弹窗先出现（前提）
2) 缺失弹窗已关闭（不跟到另一页面）
3) 卡片已挂载（跳转成功）
4) 选择弹窗自动打开 + 列出了工作区
5) 卡片确实卸载了（离开插件页）⇒ 重挂载后弹窗【没有】自己弹出（消费生效）
6) 重新挂载后再次「重新指定」⇒ 仍能打开
```

**⚠️ 探针设计上我犯的两个错，都已修正（值得记录）**：

**错误 1：第 5 条最初写成 `second.appeared === false || chooserSecond === 1`**
—— 当 `appeared === true` 时**条件恒真** ⇒ **这条断言根本没在测消费**。
**反向对照（去掉消费）照样全绿**，暴露了它。**已重写为"重挂载后弹窗不得自己弹出"。**

**错误 2：卸载前提不成立**
- 先点"已在当前的面板行"⇒ **无任何变化**，卡片不卸载
- 再改成"打开会话"，但默认工作区已被删 ⇒ 点 ＋ 只弹缺失弹窗，
  **取消 = 什么都没发生** ⇒ 卡片仍不卸载
- **修正**：先把设置指向一个**存在**的工作区，让 ＋ 真正导航；
  并**断言卸载确实发生**（`0` 个卡片）才算前提成立

**修正后反向对照（去掉消费）：2 条失败** ——
`弹窗没有自己重新弹出 → 1 个`、`第二次仍能打开选择弹窗 → 0 个`，
**精确复现消费所要防止的缺陷**。

**一处诚实说明**：`createSnapshotStore.set(x)` 当值已是 `x` 时是否通知，
**我未能直接实测**（`zustand` 不在安装里，由客户端 bundle 图解析；
`__ModuleLoader__` 只有 `load`，没有取回已加载模块的接口）。
我一度写了个"测契约"的探针，**但它只验证了我自己重写的 store** ⇒ **证据不成立，已删除**。
**不过这不影响方案**：本项目每次 `set` 都传**新对象**，且**消费对两种语义都正确**
（不通知时消费是**必需**；通知时消费是**卫生**）。


##### 第 2.5 步实现（2026-09-29）

**为什么必须插这一步**：做完 ② 后用户报「点 ＋ 还是正常出现新会话页面，弹窗不弹」。
探查确认根因是——**`baseWorkspace` 只写不读**：

```
全部引用里，唯一的消费者是设置卡片（src/client/index.ts:188）
没有任何"新建会话"路径引用它
```

**实测**（设置成"指定一个不存在的工作区"后点 ＋）：
```
调用的端点: workspace/initializeDefault, session/create
缺失弹窗出现: 0 个   创建了会话: 1 次
```

⇒ 三步走的划分里 **"让新建会话真的用这个设置"没有任何一步认领**。
③ 讲的是"创建目录"，与"使用设置"是两件事。**这是方案划分的缺口，不是 bug。**

**⚠️ 探查中还推翻了一个我自己的错误结论**：
我先前说"项目行/未分组的 ＋ 已带明确的 `workspaceId`"。**实测是错的**——
点项目行 ⊕ 会触发 `workspace/initializeDefault`，说明它**也走 unscoped 分支**。
代码印证：`tree.ts:473-475` 用 `buildGroup(source.key, undefined, …)` 建组，
注释明写 *"`workspaceId` stays undefined"*。

**⇒ 实际受影响的入口（5 个）**：侧栏按钮、快捷键、`ui-schedule.onNewTask`、
`ui-agent-preset`、**项目行 ＋**、**未分组 ＋**。

**改动 6 个文件**：

| 文件 | 改动 |
|---|---|
| `contract/slots.ts` | 加 `BaseWorkspaceRoute` 三成员判别联合 |
| `navigation.ts` | 加可选构造参数 `resolveBaseWorkspace`（第 9 位）；`startSession` 加两个分支 |
| `vendored/index.ts` | `ProjectActions` 加 `resolveBaseWorkspace`；作为构造最后一位传入 |
| `client/index.ts` | 实现 `resolveBaseWorkspace`（path → workspaceId 解析）|
| `client/projects.ts` | **修掉 ② 留下的错误注释**（描述了不存在的 "resolver"）|
| `vendored/README.md` | patch 清单 + 新增第 8 节 |

**关键设计**：

1. **三成员判别联合，而不是 `workspaceId \| undefined`**
   —— 因为"设置说用官方"和"设置指向的工作区没了"**都不打开具体工作区**，
   但**只有后者该报**。用可选 id 表达不出这个区别。`'official'` 是显式成员，
   使"回调缺席（未装配）"与"设置是默认"**可区分**（否则探针分不清"没接上"和"接上了"）。

2. **`'missing'` 时创建 nothing + 弹窗，绝不静默回退**
   —— 静默回退到官方默认**与"设置被忽略"无法区分**，**那正是本功能要消除的缺陷**。
   弹窗类型 ① 当初就留好了 `mode: 'specified'`，**这一步才第一次真正用上它**。

3. **`'workspace'` 分支 `beforeOpen` 照传**（核心）
   —— 两个入口的 `beforeOpen` 是**不同东西**：侧栏 ＋/schedule 是 **placement 回调**
   （"新会话落点"），项目 ＋ 是**归档回调**。照传才能"落在指定工作区 **+** 按入口归档"。
   **提前 return 会创建会话但丢掉归档** ⇒ 项目 ＋ 会归到空。

4. **回调缺席 ⇒ 与今天逐字节相同**
   —— 这是"插件关了就恢复官方逻辑、互不影响"的落点。
   `startSessionInDefaultWorkspace` **一个字不改**，所以 `defaultWorkspaceFailed`
   toast 与 `verify-new-session.mjs:216` 的断言**不受影响**（实测 329 断言全绿）。

5. **三个 `model === undefined` / `path === ''` ⇒ `'official'`**
   —— `mountProjects` 是 `void` 异步的，**冷启动点 ＋ 误弹窗**是真实风险，必须显式排除。
   `path === ''` 是 Host 会拒绝的非法态（手改介质可能有），**没有可报告的对象**。

6. **按 path 解析，绝不按 id**
   —— 实测重注册同目录会换新 id；存 id 必过期。**附带好处**：删掉再加回同路径自动重新认上。

**验收（`scripts/probe-base-workspace-routing.mjs`，6 场景全绿）**：

| 场景 | 结果 |
|---|---|
| `specified(A)` ⇒ 点 ＋ | 落在 **A**，未走官方解析 |
| `specified(已删的工作区)` ⇒ 点 ＋ | **弹窗出现**（含那个路径）+ **0 个会话** |
| `default` ⇒ 点 ＋ | `initializeDefault` 被调 + 落在官方默认 |
| **项目行 ＋** | 落在 **A** + **归到该项目**（两条都断言）|
| 快捷键 `Ctrl+Alt+N` | 落在 **A** |
| 往返（A → default → A） | 仍落在 **A** |

**探针的关键设计**：**从 `session/create` 的请求体里读 `workspaceId`**。
只看"调用了哪个端点"**分不出落在哪个工作区**——**这正是 ② 漏掉的那一层**。

**反向对照**（`applyVendored` 时不传 `resolveBaseWorkspace`，即未装配）：
**8 条断言失败**，所有会话落在官方默认（`21778aa5…`）、**弹窗 0 个**
—— **精确复现用户报告的现象**。


##### 第 2 步实现（2026-09-29）

**形态（用户定稿）**：设置卡片里加一行「底层工作区」，是**两张外观卡片二选一**
（照抄官方外观行），第二张卡片里放「更换…」，点开是**弹窗**列出所有工作区。
弹窗**先选中、确认才写盘**，底部是左右对称的 取消 / 确认。

**为什么是弹窗不是下拉框**（用户判断，实测支持）：

| | 下拉框 | **弹窗** |
|---|---|---|
| 区分**同名**工作区 | ⚠️ 只能显示标题，做不到 | ✅ 每行显示**路径**副标题 |
| 定位依赖 | 依赖锚点，滚动列里须 `portal` | 无依赖（`Modal` 自 portal） |

官方自己也把工作区列表放 `Menu` 里（`WorkspacePicker.tsx:112-118`），但那是侧栏
"在哪新建会话"的**即时动作**，一行标题够用；设置页是**配置**，需要看清选哪一个。

**数据模型**（`src/spec.ts`）：

```ts
baseWorkspaceSetting = z.object({
  mode: z.enum(['default', 'specified']),
  path: z.string().optional(),
  name: z.string().optional(),
}).default({ mode: 'default' })   // 带默认 ⇒ 旧记录自动兼容
```

**只存 `path` 不存 `workspaceId`**——实测重注册同一目录会**换新 id**，存 id 必过期。
附带好处：删掉再加回同路径，插件**自动重新认上**。

**改动 11 个文件**：

| 文件 | 改动 |
|---|---|
| `src/spec.ts` | `baseWorkspaceMode` / `baseWorkspaceSetting`；`globalRecord` 加字段；`initialGlobal` 同步 |
| `src/protocol.ts` | `ProjectSetBaseWorkspaceRequest` / `ProjectBaseWorkspaceValue`；`ProjectBaseline` 加字段 |
| `src/index.ts` | `@Remote('setBaseWorkspace')`；`baseline()` 带出新字段 |
| `src/client/remote.ts` | 注册 descriptor |
| `src/client/projects.ts` | `ProjectState`+`EMPTY_STATE`+`baseWorkspace$`+getter+**乐观写入** |
| `src/client/grouping.ts` | `clientBaseWorkspace` observable（含早期订阅者唤醒） |
| `src/client/index.ts` | 注入面加 `baseWorkspace` / `workspaces` / `setBaseWorkspace` |
| `src/client/settings-card.tsx` | 新增「底层工作区」行 |
| `src/client/base-workspace-picker.tsx` | **新增**：选择弹窗 |
| `src/client/settings-locales.ts` | 17 个新键（zh + en 同键集） |
| `src/client/settings-card.module.css` | 抄官方外观行 6 条 + 弹窗列表 |

**关键设计**：

1. **`setGlobal` 而非整体写**：`setGlobal` 会 spread 已有 global，整体写会**丢掉
   `projectIds`**，所有项目从侧栏消失（`setNewSessionTarget` 注释已记同一坑）。
2. **`'default'` 剥掉 path/name**：否则残留旧路径会让后续判断读错。
3. **拒绝无 path 的 `'specified'` 写**：存了也解析不出来，正是本功能要消除的故障。
4. **`sameBaseWorkspace` 按值比较**（含 `name`）：`follow` 每帧新对象，不比字段会重复写盘；
   只比 mode+path 则"同名不同路径"切换会被误判为无变化。
5. **卡片是 `<button>`，「更换…」是 `span[role=button]`**：`button > button` 会让
   React 每次挂载打 `validateDOMNesting` error，而探针断言 console error 为 0。
   `span` 需自己处理 Enter/Space（原生 button 有内建激活）。
6. **`WorkspaceSource` 直接当 `HostObservable` 注入**：实测 `{ getSnapshot, subscribe }` 同形，
   零包装；`ctx.get('workspaces')` 合法（插件 client inject 表含 `dsh-api-workspace-controller`）。
7. **`Modal` 内联渲染，不注册 slot**：`Modal` 自己 portal 到 body，卡片里直接用本地 state 管开关。

**⚠️ 探针发现并修掉的真实缺陷**：最初「指定工作区」卡片点击直接
`setBaseWorkspace({ mode: 'specified' })`，而**未选过时没有 path** ⇒ 被 host 守卫
**拒绝**。改为：**没存 path 就打开选择弹窗**（"选指定"本身就是"选一个"）。
这是探针第 3 条抓到的，不是我推理出来的。

**验收（`scripts/probe-base-workspace-card.mjs`，全绿）**：

```
3) 未选过时点「指定工作区」⇒ 打开弹窗而不是写盘   PASS
3) 未写盘（没有存出无法解析的设置）               PASS
3) 确认后 mode 变为 specified                    PASS
4) 弹窗列出多个工作区，每行含路径                 PASS
5) 点行不写盘（staged）                          PASS
6) 取消不写盘                                    PASS
7) 确认才写盘，且存 specified + path             PASS
8) 点「更换…」只打开弹窗，不改设置                 PASS
9) 工作区删除后标注「已不存在」，设置未被自动清空    PASS
9) 弹窗不含已删除的那个                           PASS
9) 没有嵌套 button 的 React 报错                  PASS
```

**⚠️ 一处诚实说明**：第 8 条是**守卫，不是判别器**。实测把 `stopPropagation`
**去掉后该条仍通过**——因为冒泡在本设计下是良性的：`mode:'default'` 时 host 已剥掉
path，卡片 handler 走"无 path 就开弹窗"分支；有 path 时
`sameBaseWorkspace` 提前返回。`stopPropagation` 保留作纵深防御，但**探针不能证明它必需**，
探针注释里已写明，不再宣称"反向对照会失败"。

**`pnpm check`**：**329 断言**（325 + 新 Remote 的 4 条），13 suites 全绿。既有的
`probe-settings-card`（含"项目顺序未被写坏"）**仍全绿**。

##### 第 2 步的两个缺陷修复（2026-09-29，用户实测报回）

**缺陷一：指定工作区"不能持久化"——切回默认为再切回来又要重选**

**根因是我的错误设计**：第 2 步里我让 Host 在 `'default'` 写入时
**剥掉 `path`/`name`**，理由是"残留路径会让后续判断读错"。
后果：切回默认就**抹掉了用户的选择记忆**，切回指定没有东西可恢复 ⇒ 必须重选。

**修正**：`path`/`name` 是**记忆**，不是 mode 的附属字段 —— `'default'` 写入
**保留**它们。

```ts
const stored = domain.global.get().baseWorkspace
const next = request.mode === 'default'
  ? { mode: 'default', path: stored?.path, name: stored?.name }   // 保留记忆
  : { mode: 'specified', path: request.path, name: request.name ?? '' }
```

**为什么安全**：所有读者都**先看 `mode`** 再看 `path`。卡片里 `gone`
原本写成 `mode === 'specified' && …`，现在改成**只看 path 是否存在**：
记忆过期时，无论当前是哪个 mode 都该给出"已不存在"的提示。

**连带修正**：切到「指定工作区」时，若记忆的工作区**已不存在**，不能直接写入那个
死路径，而是**打开选择弹窗**。判据改成 `chosen === null`（TypeScript 才能正确收窄）。

**缺陷二：「更换…」按钮和卡片糊在一起（选中卡片上看不出按钮）**

**根因**：`.cubeAction` 的底色用了 `--dsw-alias-bg-module-platform` ——
**正是选中卡片的填充色**。于是指定卡片被选中时，按钮背景与卡片背景**完全相同**
（实测两者都是 `rgb(245,246,247)`）。

**修正**：改成**描边型**（透明底 + `--dsw-alias-border-l3` 边框 + `--dsw-radius-sm`），
与官方 `Button` 的 `outline` variant 一致（官方给设置页链接用的就是这个中性描边）。
另加 `:focus-visible` 描边，因为它是 `span` 不是原生 button。

实测：`border=1px rgba(0,0,0,0.12)`、`button=rgba(0,0,0,0)` vs `cube=rgb(245,246,247)`。

**反向对照（两处都做，均如期失败）**：

| 还原的缺陷 | 失败的断言 |
|---|---|
| host 重新剥离 path | `11) path/name 作为记忆被保留` — 实际 `path=undefined` |
| | `11) 切回指定恢复了原选择` |
| | `11) 卡片直接显示那个工作区名` — 显示「未选择」 |
| 按钮改回 module-platform 填充 | `10) 有可见边框` — `border=0px` |
| | `10) 底色与卡片底色不同` — `button=rgb(245,246,247) cube=rgb(245,246,247)` |

**5 条断言失败**，且**逐条复现用户描述的原话**（"糊在一起"、"回来又要重新选"）。

**探针**：`probe-base-workspace-card.mjs` 新增第 10、11 节；
`probe-base-workspace-write-rejected.mjs` 记录"写入被拒时静默回滚"这一独立缺陷
（见下）。

##### 第 2 步的第三个缺陷：切换时「指定」卡的副标题闪一帧「未选择」（2026-09-29 修复）

**现象**（用户报）：持久化已正常，但**切回指定的时候，指定这里还是会闪烁一下**。

**逐帧测量**（`probe-base-workspace-toggle-flash.mjs`，`requestAnimationFrame` 采样）：

```
点「默认工作区」：
  +0.0ms   pressed=false/true  副标题="scripts"
  +16.2ms  pressed=true/false  副标题="未选择"    ← ❌ 闪帧
  +33.0ms  pressed=true/false  副标题="scripts"
```

**`pressed` 全程正确**（默认一直选中），**闪的只是副标题文字**。

**根因：同一条规则写在两处，而且只有一处写了。**

```ts
// Host（index.ts）—— 写了：保留记忆
? { mode: 'default', path: stored?.path, name: stored?.name }
// 客户端乐观写入（projects.ts）—— 没写：原样采用调用方对象
this.state = { ...this.state, baseWorkspace: { ...setting } }
//                                               ↑ setting = { mode: 'default' }，无 path
```

于是：**乐观写入那帧 `path` 是 `undefined`** ⇒ 卡片走 `path === undefined` 分支
⇒ 显示「未选择」⇒ 下一帧 Host 的 `follow` 帧把 path 带回来 ⇒ 变回 `scripts`。

**为什么只有 default 方向闪**：点「指定」传的是
`{mode:'specified', path: chosen.path, name: chosen.title}`，**信息完整**；
点「默认」传的是光秃秃的 `{mode:'default'}`。**不对称正是证据。**

**修法：把这条规则抽成两半共用的纯函数**（方案 A，放 `protocol.ts`）：

```ts
export function withDefaultMode(stored: BaseWorkspaceSetting | undefined): BaseWorkspaceSetting {
  return { mode: 'default', path: stored?.path, name: stored?.name }
}
```

| 文件 | 改动 |
|---|---|
| `src/protocol.ts` | **加** `withDefaultMode`；文件头文档同步改准 |
| `src/index.ts` | Host 的 default 分支改调它（删掉手写副本）|
| `src/client/projects.ts` | 乐观写入**先归一化再比较**；回滚比对改用 `next` |
| `src/client/settings-card.tsx` | `neverChosen` / `gone` 拆开 |

**为什么选 A 而不新建文件**：这条规则**只有 4 行**，且 `protocol.ts` **已经**装着
两个"两半必须一致的运行时约定"（`PROJECT_NAMESPACE` 等），**同类**。
为一个函数新建模块，仪式感大于规则本身。
**提升触发条件**：这类规则攒到**第二条**时，一起挪到 `src/base-workspace.ts`。

**为什么必须共用而不是"两处各写对"**：规则写在两处就**必然靠人同步**，
**这次闪帧正是没同步的结果**。共用后"一边有、一边没有"**结构上不可能**。

**`spec.ts` 不能放**（硬约束，实测）：`spec.ts:44` **value-import zod**，
客户端 value-import 它会把 zod 拉进浏览器 bundle。

**顺带修掉一个未报的缺陷**：**已经是「默认」时再点「默认」会发一次冗余写请求**。
原因：`sameBaseWorkspace` 拿入参 `{mode:'default'}` 与已存 `{mode:'default',path,name}` 比，
**永不相等** ⇒ 去重失效。归一化后 `next` 等于 `previous`，**自动修好**。

**改动 4 的必要性**：`neverChosen` 与 `gone` 原本耦合在
`base.path === undefined || base.path === ''` 上，把"当前没在用它"和"从未选过"混同。
拆开后「未选择」**只**表示从未选过——**改动 3 保证了这点**（乐观写入不再丢 path），
**两个改动有依赖顺序**。

**反向对照**（还原 `const next = setting` 那行）：

```
切到默认: 3 个状态变化，含 1 个中间态：副标题="未选择"
重复点击产生的请求: 1
FAIL  切到默认：副标题不出现「未选择」中间态 — ["scripts","未选择","scripts"]
FAIL  重复点已选中的卡片不产生写请求 — 1 次
```

**精确复现原始症状**。

**验收**：新探针 9 条断言全绿——三次切换**都无中间态**、副标题**从不出现「未选择」**、
重复点击 **0 个请求**、整轮结束记忆仍在。

**探针教训（重要）**：`probe-base-workspace-card.mjs` 第 11 节**隔 1800ms 才采样**，
**跨过了那一帧**，所以上一轮验收漏掉了这个 bug。**必须用 `requestAnimationFrame` 逐帧采样。**

**一处诚实说明**：`lib/client.js` 里出现字符串 `zod` —— 那是**我自己写的注释**被原样
打进 bundle（"spec.ts 不能放"那段理由），**不是依赖**。实测
`require("zod")` / `from "zod"` 全为 `False`，**外部 require 集合零新增**，体积 +1.7 KB。

##### ⚠️ 一个**已确认但未修**的独立缺陷

**写入被拒绝时用户看不到任何解释**——只有 `console.warn`，界面上什么都不显示。
用户看到的是卡片"自己跳回去了"。

实测（`probe-base-workspace-write-rejected.mjs`，6 条断言全绿）：把
`setBaseWorkspace` 桩成失败后，50ms 密集采样得到

```
t=0.00s  默认=false 指定=true   ← 乐观写入先paint（闪）
t=0.55s  默认=true  指定=false  ← 回滚（跳回）
```

而页面上 `alert/note` 为空，只有一条 console warn。

**这个缺陷与老 host 无关**，任何写入失败都会这样。**留待用户决定是否修**
（范围在 ② 之外，不擅自改）。

##### 附：第 2 步首次实测"闪回默认"的真身（非代码缺陷）

用户重启前报告的"选完立刻跳回默认"，根因是**host 进程陈旧**：
运行中的 host 启动于 **08:08:17**，而步骤①(11:03)、②(11:50) 的 host 代码
是之后才写入磁盘的。client bundle 每次刷新都从磁盘重读 ⇒ 卡片是新的；
host bundle 只在进程启动时载入一次 ⇒ 跑的是**没有 `setBaseWorkspace` 的旧 host**。
于是乐观写入先paint（闪），RPC 失败后回滚（跳回），回滚清掉 path 后
再点就走"无 path 开弹窗"分支 ⇒ 用户看到的"循环"。

**旁证**：当时用户的 `storages\project_groups.json` 里 `global` 只有
`projectIds, newSessionTarget`，**从来没有 `baseWorkspace`**。
重启后该字段出现，写入即成功。

**教训**：`pnpm build` 之后**必须重启 DSH** 才能让 host 侧改动生效；
此前的验收探针都在**新起的隔离进程**里跑，所以碰不到这个错配。

##### 第 1 步实现（2026-09-29）

**触发点**：`startSessionInDefaultWorkspace` 原来在 `prepared === undefined` 时
**静默 return**——这就是"点 ＋ 没反应"的根因（`initializeDefault` 返回 `undefined`
而**不抛错**，所以连已有的 `defaultWorkspaceFailed` toast 都不触发）。

**改动 8 个文件**：

| 文件 | 改动 |
|---|---|
| `src/default-workspace.ts` | **新增**：host 侧推导默认工作区路径 |
| `src/protocol.ts` | 新增 `ProjectDefaultWorkspacePathValue` |
| `src/index.ts` | 新增 `@Remote('defaultWorkspacePath')`（纯读） |
| `src/client/remote.ts` | 注册该 descriptor |
| `src/client/projects.ts` | `ProjectRemote` + `ProjectModel.defaultWorkspacePath()` |
| `src/client/index.ts` | `projectActions.defaultWorkspacePath` 中继 |
| `contract/slots.ts` | `BaseWorkspaceMissingRequest` / `...DialogInjected` / `...Props` |
| `navigation.ts` | 可选 `onBaseWorkspaceMissing` 回调（省略即上游行为） |
| `session-actions/BaseWorkspaceMissing.tsx` | **新增**：弹窗 |
| `locales.ts` | 6 个 `baseMissing.*` 键（zh + en） |
| `WorkspaceBrowser.module.css` | `.baseMissingActions` 等 3 条 |

**关键设计**：

1. **不删已有的 `defaultWorkspaceFailed` toast**——它属于**抛错**路径，
   而 `verify-new-session.mjs:216` 正断言它。新弹窗属于**返回 `undefined`** 路径。
   两条并存，互不替代。
2. **路径异步补入**：报告同步发出（点 ＋ 立即响应），路径由 host 往返拿回后
   **再补写同一份报告**；窗口期显示"路径未知"，好过让 `powershell.exe` 拖住弹窗。
   补写前校验"屏幕上还是那份报告"（用对象身份比较），避免覆盖第二次点击。
3. **两个动作可选**（`rebuildBaseWorkspace` / `chooseBaseWorkspace`）⇒ 缺失时按钮
   **disabled**。这正是"①可独立交付"的落点。
4. **`@types/node` + 拆分 tsconfig**：host 半首次需要 Node 内置模块
   （`node:child_process` / `node:path`），但根 `tsconfig.json` 的 `"types": []`
   是**刻意**的（阻止 Node 全局流入浏览器 bundle）。
   ⇒ 新增 `tsconfig.host.json`（`types: ["node"]`），根配置 **exclude** 那两个 host 文件，
   `typecheck` 脚本跑**两个** config。**已验证 client bundle 不含任何 node 内置**。
5. **host 用官方 `execFile` 而非 `runNativeCommand`**：后者的类型面在
   `dsh-native-command` 的 `./types` 入口，且它要求 `window` 参数语义；直接照抄官方
   那三行命令更贴近上游实现（含 `DoNotVerify`，避免查询自身创建目录）。

**验收（14 项断言全绿，`scripts/probe-base-workspace-dialog.mjs`）**：

```
1) 正常路径下没有弹窗                                     PASS
2) 注册已删除                                             PASS
3) 弹窗出现（不再是静默无反应）                            PASS
3) 弹窗文案含"底层工作区缺失"                              PASS
3) 弹窗显示了 Host 推导的路径                              PASS
4) 三个按钮竖排（top 递增 369→413→457）                    PASS
4) 三个按钮等宽全宽 [332,332,332]                          PASS
4) 文案全部放得下（84/126/28 vs 可用 304）                 PASS
5) 「重建该工作区」disabled                                PASS
5) 「重新指定底层工作区」disabled                          PASS
5) 「取消」可用                                            PASS
4) 取消后弹窗关闭                                          PASS
4) 取消后插件状态未变                                      PASS
5) 再次点击仍然弹窗                                        PASS
```

**反向对照**：把 `navigation.ts` 恢复成静默 `return` 后重建，
**恰好失败"弹窗出现"一条**（`count=0`），其余通过；恢复后源码
SHA256 逐字节一致（`2F8B3CF0…`）。

**`pnpm check`**：**325 断言**（原 321 + 新 Remote 的 4 条 descriptor 断言），
13 suites 全绿。

##### 设置页的语义（2026-09-29 定稿）

**位置**：与「新会话落点」**同一张卡片、同一个页面**（插件 → dsh-project-groups → 详情页）。
现有 `ProjectGroupsCard` 注册在 `plugins.bundle.config`（`src/client/index.ts:163-181`），
**加一行即可**，不需要新注册。

**形态**：按用户的定稿——**照官方「外观」行的二选一卡片**，卡片内部额外放一个
"从已有工作区选择"的按钮。

```
底层工作区
┌────────────────────────┐  ┌────────────────────────┐
│        默认工作区        │  │       指定工作区         │
│  …\Documents\deepseek-  │  │   D:\我的项目            │
│  harness\default-workspace│  │   [ 更换… ]             │  ← 卡片内部
└────────────────────────┘  └────────────────────────┘
```

**「更换…」的行为**（用户定）：点击后**实时读 `workspaces.list` snapshot**，
列出**真实存在的工作区**供选。

- **可选范围 = 所有工作区，包含默认工作区本身**（用户明确）。
  这让"指定"成为一种**显式固定**：用户可以把当前那个默认工作区钉住，
  于是即使日后 registry 的默认变了，插件仍落在它上面。
- **一个工作区都没有时**：显示「**暂无工作区**」。
- **只读 snapshot，不逐个 `stat` 目录**：官方注册表就是权威（工作区账 = `sessionIds` 归属）；
  逐个 stat 会在网络盘/慢盘上卡住 UI。目录被删而注册仍在是另一个问题
  （那时 `connectWorkspace` 会失败，见下面的弹窗路径）。

**为什么卡片不选 `SegmentedControl`**：官方那个「外观」卡片**不是公共组件**——
它在 `dsh-client-ui-theme` 里是私有的 `<button>` + CSS Module，而该包**不在本插件
可导入白名单**（`tsdown.config.ts` 的 `PLATFORM_MODULES` / `INLINE_SAFE` / `TYPE_ONLY`），
作 value import 会**构建失败**。`ui-primitives` 里的 `SegmentedControl` 是公共组件，
但它是**标签式**的分段控件，**不是卡片外观**，与用户要的观感不符。

⇒ 照本项目一贯做法：**抄那 6 条 CSS**（共 850 字符，全用主题变量，深浅色自动跟随）。
实测取自 `dsh-client-ui-theme/lib/client.js`：

```css
.group  { border-bottom:.5px solid var(--dsw-alias-border-l2); flex-direction:column; gap:8px; padding:16px 0; display:flex }
.title  { color:var(--dsw-alias-label-primary); font-size:14px; font-weight:400; line-height:22px }
.row    { flex-wrap:wrap; align-items:stretch; gap:8px; display:flex }
.cube   { box-sizing:border-box; border:.5px solid var(--dsw-alias-border-l4);
          border-radius:var(--dsw-radius-xl); font:inherit; color:var(--dsw-alias-label-primary);
          cursor:pointer; background:0 0; flex-direction:column; flex:180px;
          justify-content:center; align-items:center; gap:4px; padding:20px 32px;
          font-size:14px; line-height:22px; display:flex }
.cube:hover:not(.selected) { background:var(--dsw-alias-interactive-bg-hover) }
.selected { background:var(--dsw-alias-bg-module-platform); border-color:var(--dsw-static-neutral-bluish-400) }
```

`flex: 180px` + `flex-wrap: wrap` ⇒ 宽度自适应，两张卡片各占一半。

##### 卡片内的按钮：容器选型（2026-09-29 定稿，实测）

用户问"能不能把按钮放卡片里面，点按钮不透到卡片"。
**能**——但**卡片本身是 `<button>`**，而 HTML 禁止 button 含交互后代，
且 **React 会为此告警**。四条路径实测（`scripts/probe-card-nesting-options.mjs`、
`scripts/probe-react-button-nesting.mjs`）：

| 结构 | `stopPropagation` 后点击 | React 18 开发版告警 | 卡片语义 |
|---|---|---|---|
| `button > button` | ✅ 只触发内部 | ❌ **`validateDOMNesting` error** | 原生 |
| `div[role=radio] > button` | ✅ 只触发内部 | ✅ 无 | 需自实现键盘/aria |
| `div > (button, button)` 兄弟 | —（不嵌套） | ✅ 无 | 卡片非控件 |
| **`button > span[role=button][tabindex=0]`** ← **选定** | ✅ 只触发内部 | ✅ **无** | **原生 button** |

**选最后一个**：卡片仍是真正的 `<button>`（与官方 `themeCube` 一致），
内部"更换…"用 `span[role=button][tabindex=0]`。
React 的校验**只认标签名、不认 ARIA role**，而 HTML 的"交互内容"是一个固定标签列表
（不含 `span`）⇒ 两者都满足。

**两条必须遵守的实现约束**：

1. **必须 `stopPropagation`**：实测不加则点击同时触发卡片（`["inner","card"]`），
   即"点选择顺手切换了模式"。
2. **`span[role=button]` 要自己处理 Enter / Space**：原生 button 自动支持，
   span 不会。加上 `tabindex=0` 才可聚焦（实测可聚焦）。

##### 为什么"不自动降级为未指定"（用户纠正）

```
底层工作区
  指定工作区   D:\我的项目          ← 保留用户的选择，不自动清空
                ⚠ 该工作区已不存在   ← 只标注事实，不改状态
```

理由（用户指出）：用户可能是**误删**了官方的工作区，插件不该替他做决定——
"如果他不想换呢？"

⇒ 官方的删除**不该单方面改插件的配置**。这正是"官方归官方、我们归我们、
互不影响"的直接推论。设置页只**呈现两个信号**（我的选择 / 它已失效），
由用户决定下一步。

**只从已有工作区里选**（用户指定），不调目录选择器——
既符合"指定 = 从现有的挑一个"，也**顺带绕开了桌面端不能建目录的能力限制**（见下表事实 2）。

**切换卡片立即写盘**（用户同意），与「新会话落点」一致，用乐观写入。

**"选了指定义没选工作区"**（用户同意）：写入模式、路径为空 ⇒ 卡片显示"未选择"，
点新建会话时**弹窗引导去选**。

##### 弹窗：**竖排三个全宽按钮**（2026-09-29 定稿）

```
底层工作区缺失
  当前：D:\我的项目（已不存在）
  它是本插件所有会话的落脚点，缺失时无法新建会话。

  [        重建该工作区        ]   ← variant="primary"（最主动，最上）
  [    重新指定底层工作区      ]   ← variant="outline"
  [            取消           ]   ← variant="ghost"（最弱，最下）
```

**顺序 = 上→下 由主动到被动**，三个按钮**等宽全宽**。

- **默认工作区**缺失时**用同一个弹窗**（`当前：…\default-workspace（已不存在）`）
  ⇒ 不需要"两种模式"，一套 UI 覆盖全部
- 「重建该工作区」→ 按原 path 建目录 + 注册
- 「重新指定底层工作区」→ 从已有工作区里选（设置页同一套规则）

**为什么竖排**（实测，`scripts/probe-modal-vertical-actions.mjs`）：

| 布局 | 380px 对话框下每按钮宽度 | 用户措辞「重新指定底层工作区」(需 126px) |
|---|---|---|
| 横排三等分 | 105px（可用 **77px**） | ❌ **溢出**，须把对话框加宽到 460px |
| **竖排全宽** | **332px（可用 304px）** | ✅ **绰绰有余** |

竖排实测：三个按钮 `top` 递增 `359 → 403 → 447`（确实竖排）；
对话框高 `206px → 294px`（撑高 88px，第三行未被裁）；
`footer` 原为 `display:flex; flex-direction:row; justify-content:flex-end`，
**换成 column 容器即可**，无需改动 `Modal` 组件。

**这正是官方自己的做法**：`dsh-client-ui-plugin-manager` 的「添加插件」弹窗就是

```css
.installFooter { flex-direction: column; gap: 20px; display: flex }
.installDialog { width: min(560px, 100%) }
```

⇒ 同一个 `Modal` 组件、`footer` 里放一个 column 容器、配全宽 `Button`。
**观感与官方 100% 一致，且不需要把对话框加宽。**

**按钮视觉权重**：竖排等宽时三者样式若相同则分不清主次，
故用官方 `Button` 的三种 variant（实测取值 `outline` / `primary` / `ghost`）分层。

##### 实测技术事实（决定实现形态）

| # | 事实 | 证据 |
|---|---|---|
| 1 | **注册工作区：客户端就能做** ✅ | `workspaces.create({ path })` 是公开 RPC，插件已接线（`src/client/index.ts:375,406`） |
| 2 | **建目录：客户端做不了，必须走 host 半** ❌ | 桌面 composition 是 `directory-picker-auto` → 解析为 **`native`**；`createDirectory` 被 `requireCapability("browse", ...)` 门控。**实测**：`directory-picker/unavailable — needs the browse capability; the composed picker serves "native"`。native 的 capability **只有 `pick`** |
| 3 | **host 半能建目录** ✅ | 插件 host 半是 Node 进程，可直接 `fs.mkdir`；官方生态 **51 个 host 半包**都直接用 `node:fs` |
| 4 | **路径推导拿不到官方的** ⚠️ | `defaultWorkspaceDirectory` 在 `lib/types/default-directory.js`，但**不在 `exports` 映射里**，且包**不发 `src/`**（实测 0 个文件）⇒ 只能拿到末段常量 `DEFAULT_WORKSPACE_DIRECTORY='default-workspace'`（来自 `./default-workspace`），**Documents 查询必须自己实现**。Windows 需用 `[Environment]::GetFolderPath(MyDocuments)`——**OneDrive 重定向时与 `homedir()\Documents` 不同** |
| 5 | **`session/create` 接受 `cwd`** | 契约文档写着 "Create or **adopt** a Session on the Host"，`create({ workspaceId?, cwd?, sessionId? })` |

##### 关键陷阱：`initializeDefault` 删注册后**永久失效**

```
1. 首次解析默认工作区        → ✅ 返回 workspace
2. workspace/delete 删注册   → ✅ deleted=true（目录保留）
3. 再调 initializeDefault    → ❌ 返回 null
4. 用公开 workspace/create 重注册同一 path → ✅ created=true，但【新 id】
5. 再调 initializeDefault    → ❌ 仍返回 null
```

原因（代码）：`defaultWorkspaceId` **只在 `createCanonical` 的 `firstUse` 分支写一次**、
**从不清除**；`initializeDefault` 开头就是

```js
if (state.defaultWorkspaceId !== void 0) return this.entities.get(state.defaultWorkspaceId)
```

删注册后该 id 悬空 ⇒ 立即返回 `undefined`，**在资格检查与目录解析之前**。
新注册拿到**新 id**，`defaultWorkspaceId` 指向旧 id ⇒ **永不匹配**。

⇒ **必须改为"按 path 解析"**（在 `workspaces.list` snapshot 里按 `path` 查），
这就是 §3.8「查找必须按 path，不能按 title」的加强版。

##### 「重建」的实际效果（实测，**不修复旧会话的归属**）

删注册后用同 path 重注册 ⇒ **新 id、`sessionIds = []`**；重启（重建 cwd 索引）后
**仍不认领**旧会话。该会话此后渲染在 `未分组` 下。

**但这不影响本插件**：我们的分组**不看工作区账**，只看 `assignments` 表 ⇒
工作区注册没了，会话的 `cwd` 与项目归属**都没变**，**照常显示在原项目下**。
"工作区账"只影响 ① 官方侧栏 ② 我们新会话的落脚点。

⇒ **「重建」的收益是"新会话重新有地方落"**，不是"找回旧会话的去向"。

##### 实现分工

| 步骤 | 位置 | 手段 |
|---|---|---|
| 检查底层工作区是否存在 | 客户端 | `workspaces.list` snapshot **按 path 查** |
| 建目录 | **host 半** | `fs.mkdir(path, { recursive: true })` |
| 注册工作区 | 客户端 | `workspace/create { path }`（`create` 要求目录已存在 ⇒ **顺序不能反**） |
| 记住用户的选择 | host 半（领域） | `projectGroups` 新增 `global.baseWorkspace: { mode, path?, name? }` |
| 弹窗 / 设置卡 UI | 客户端 | `Modal` + column footer；卡片抄官方外观 CSS |

**存储只存 `path`，不存 `workspaceId`**：实测重注册会拿**新 id**，存 id 必然过期；
`path` 稳定（§3.8 同结论）。

**设置卡需要新增的注入**（现有卡片只有 `target` / `setTarget` 两项）：

| 注入项 | 类型 | 用途 |
|---|---|---|
| `baseWorkspace` | hook（observable） | 读当前 `{ mode, path, name }` |
| `setBaseWorkspace` | setter | 切换卡片模式时写入 |
| `workspaces` | hook（observable） | 读 `workspaces.list` snapshot，供"更换…"列出现有工作区 |

前两项与现有两项同构；`workspaces` 正是 vendored 半已经 `provideRoot` 的那个
（`src/vendored/client/index.ts:229`），**不新增数据源**。

##### 一处既有探针会受影响（实现时必须处理）

`scripts/probe-settings-card.mjs:103` 用

```js
const pillar = () => card().locator('button[aria-haspopup="menu"]').first()
```

抓"卡片里第一个下拉框"。**加上第二行后，`.first()` 可能抓到新元素。**

处置：新的「更换…」按钮**不开 Menu**（它开的是选择列表/弹窗），因此**不加**
`aria-haspopup="menu"`；同时给探针换成更精确的定位（按所在行的标题找），
而不是靠"第一个"。

##### 弹窗组件选型（实测）

**排除 `RiskConfirmation`**：它的勾选框**是结构的一部分**，拆不掉——

```ts
interface RiskConfirmationProps { acknowledgeLabel; acknowledged; onAcknowledgedChange; ... }
// 主按钮 disabled: disabled || !acknowledged
```

**采用 `Modal` + 自定义 `footer`**：插件**已经在用**这个写法
（`WorkspacePicker.tsx:204-219` 的"取消 + 重试"两按钮），
观感与官方 100% 一致（同一个 `Modal` 组件）。

**按钮三等分的配方**（实测生效）：

```css
.footerAction { flex: 1 1 0; min-width: 0; }
```

- `flex-basis: 0` 是必须的：只写 `flex-grow: 1` 时基准是**内容宽度**，仍不等宽
- `min-width: 0` 让长文案可压缩而不撑破
- **实测**：380px 对话框三等分 ⇒ 各 105px（含 padding）；两等分 ⇒ 各 163/161px

#### 补建设计（2026-09-28 初版，已被上节取代）

**触发**：用户点"新建会话"（项目行 ＋ / 未分组 ＋ / 顶栏按钮）时**检查一次**。
缺失才弹窗，**不主动自愈**（避免"启动就悄悄建目录"违背用户意图）。

**弹窗**（用户提出）：

```
默认工作区缺失
  它是本插件所有会话的落脚点，缺失时无法新建会话。
  （当前路径：C:\Users\Think\Documents\deepseek-harness\default-workspace）
  [ 不，我想自己指定目录 ]  [ 确认，新建默认工作区目录 ]
```

"自己指定目录" → 复用官方目录选择流（`directoryFlow` 槽位已有）→ 注册为工作区并记为插件底座。

**为什么这不违反"不碰底层"**：建目录 + `workspace/create` **都是官方合规路径**
（`workspace/create` 本就是官方给的客户端 RPC）。
插件只是**替用户点了一下**，不改任何会话的 `cwd`、不碰归档集、不移动日志。

**三个已实测的技术事实**（决定实现形态）：

| # | 事实 | 证据 |
|---|---|---|
| 1 | **注册工作区：客户端就能做** ✅ | `workspaces.create({ path })` 已是公开 RPC，插件已接线（`src/client/index.ts:375,406`） |
| 2 | **建目录：客户端做不了，必须走 host 半** ❌ | 桌面 composition 是 `directory-picker-auto` → 解析为 **`native`** 后端；而 `createDirectory` 被 `requireCapability("browse", ...)` 门控。**实测**：`directory-picker/unavailable — needs the browse capability; the composed picker serves "native"`。native 的 capability **只有 `pick`**，没有建目录能力 |
| 3 | **host 半能建目录** ✅ | 插件 host 半是 Node 进程，可直接 `fs.mkdir`；官方生态 **51 个 host 半包**都直接用 `node:fs`，做法一致 |

**关键陷阱（实测，决定解析策略）**：

`initializeDefault` 一旦注册被删就**永久失效**：

```
1. 首次解析默认工作区        → ✅ 返回 workpace（path=…\default-workspace）
2. workspace/delete 删注册   → ✅ deleted=true（目录保留）
3. 再调 initializeDefault    → ❌ 返回 null（不补建）
4. 用公开 workspace/create 重新注册同一路径 → ✅ created=true，但【新 id】
5. 再调 initializeDefault    → ❌ 仍返回 null
```

原因（代码）：`defaultWorkspaceId` **只在 `createCanonical` 的 `firstUse` 分支写一次**，
**从不清除**；而 `initializeDefault` 开头就是

```js
if (state.defaultWorkspaceId !== void 0) return this.entities.get(state.defaultWorkspaceId)
```

删注册后该 id 悬空 ⇒ 立即返回 `undefined`，**在资格检查与目录解析之前**。
新注册拿到**新 id**，`defaultWorkspaceId` 指向旧 id ⇒ **永不匹配**。

⇒ **所以补建后不能依赖 `initializeDefault` 找底座，必须改为"按 path 解析"**：
在 `workspaces.list` 的 snapshot 里按 `path === <底座路径>` 查。
这也正是 §3.8 早就写下的结论（"查找必须按 path，不能按 title"）的加强版。

**底座路径的来源**：默认取官方推导路径（`defaultWorkspaceDirectory`：
`<Documents>\deepseek-harness\default-workspace`，§3.8）；用户若"自己指定目录"，
则该路径存进插件自己的领域（新增 `global.basePath`），此后按它解析。

**实现分工**：

| 步骤 | 位置 | 手段 |
|---|---|---|
| 检查底座是否存在 | 客户端 | `workspaces.list` snapshot 按 path 查 |
| 建目录 | **host 半** | `fs.mkdir(path, { recursive: true })` |
| 注册工作区 | 客户端或 host | `workspace/create { path }` |
| 记住用户指定的路径 | host 半（领域） | `projectGroups` 领域新增 `global.basePath` |
| 弹窗 UI | 客户端 | vendored 目录流 / 新对话框 |

**待确认**：`workspace/create` 客户端 `create({ path })` 要求目录已存在 ⇒
必须**先** host 建目录、**再** 客户端注册（顺序不能反）。

### L4.5 — 上游同步流程  ✅ 已完成（2026-09-30）
- [x] 同步步骤与顺序 —— 写进 `src/vendored/README.md` 的 "Keeping it in sync"（5 步，
      含"三方版本要取哪个 tag"、逐文件 `git merge-file`、双向验证、重装 node_modules 的告警）
- [x] 0.1.7-rc.2 → 0.2.0-rc.2 差距量化 —— **上游只改 145 行 / 19 文件**，其中 **7 个是我们 patch 过的**
- [x] 验证手段 —— **10 个 patch 文件全部零冲突三方合并**；双向 grep（上游 8 项改动 + 我们 17 处缝）；
      `pnpm check` 354 条；9 个浏览器探针各自独立 HOME
- [x] 回滚路径 —— `.agent\backups\...-pre-upstream-sync\vendored`（整棵树的快照）
- [x] **真的同步了一遍**：`src/vendored/` 现为 **0.2.0-rc.2 + 41 条登记 patch**，
      `devDependencies` 同步升级并新增 `product-analytics`（照官方：`ctx.get` + `import type {}`）

**同步中暴露的两件事**（已记入 `src/vendored/README.md`）：

1. **依赖残留**：`pnpm install` 覆盖旧 `node_modules` 会留下 0.1.7 的包 ⇒ `.pnpm` 里
   出现两份 `dsh-typert-protocol` ⇒ `tsc` 在**上游原文**上报 `RemoteFailure` 不匹配。
   **必须删掉 `node_modules` 重装**（lockfile 本身是干净的）。
2. **测试夹具过时**：0.2.0 的 `sessionTitle` 改读新字段 `title`（不再是 `displayTitle`）⇒
   3 个 verify 脚本的夹具要补 `title`。**上游自己也做了同样的夹具修改**（`tree.client.spec.ts`），
   这正是确认修法正确的依据。

### 额外功能  ⏸ 默认不做（见 §24）
- [ ] **X-1** 会话 hover 卡显示所属项目
- [ ] **X-2** 工作文档：`docPath` 编辑 UI / `agent/pre-step` 注入 / 模板与大小上限

### 通用
- [x] 构建配置（tsdown + `cordis.patch.yml`）
- [ ] 单元测试（domain / RPC / 注入 / 重建逻辑）
- [ ] 每层的"停用插件后回到原版 DSH"回归测试
- [ ] vendor 重新同步流程演练（并入 L4.5）

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

---

## 24. 额外功能（默认不做）

**基础功能 = 完全不动官方 + 只按项目分组。** 这里列的东西**超出**这个范围：
官方没有对应行为，做了就**削弱"插件关了就是官方原样"这个保证**。

**⇒ 默认不做。** 要做需要明确点头，且必须在本节登记，而不是混进待办清单。

| # | 功能 | 状态 | 为什么是额外功能 |
|---|---|---|---|
| **X-1** | **会话 hover 卡显示所属项目** | 未做 | 官方 `SessionHoverContent` 只有标题/时间/槽位/状态/归档。分组视图里项目标题就在行上方**肉眼可见** ⇒ 加了是冗余；只在扁平模式/搜索下有信息量 |
| **X-2** | **工作文档**（`docPath` 绑定 + `agent/pre-step` 注入 + 模板/大小上限） | 未做 | 官方没有这个概念。它引入 **host 侧注入逻辑**，是基础功能里唯一的"改会话内容"动作 |

### X-2 详细设计（保留原 L5 内容）

**目标**：项目绑定一份 md 工作文档，新会话自动注入。

| 项 | 内容 |
|---|---|
| 领域字段 | 使用已有的 `docPath`（当前为空串，启用其编辑与消费） |
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
- **不解析文档内容**——只读原文注入
- 注入仅对"已归类到某项目"的会话生效

**验收标准（若实施）**

1. 给项目绑定文档 → 该项目下新会话首轮即能看到文档内容
2. 未绑定文档的项目 → 不注入任何额外内容
3. 官方 `default-workspace\AGENTS.md` 注入仍正常（两者共存）
4. 关闭插件 → 不再注入（仅剩官方 AGENTS.md）
5. 文档过大时被截断且有提示

**⇒ 实施前必须确认**：这会往会话里注入内容，与"完全不动官方"的边界需要明确。


