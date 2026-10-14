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
| **投影纯派生** | `baseline()` 只按 `order()` 派生（同官方 `list()` 依 `workspaceIds`）：记录 id 未进顺序就不在投影里。**这是硬约束**——一旦列出顺序外的记录，创建就会出现"底部→顶部"的滑动（Z-1 的成因）。顺序外记录的不存在性由**恢复标记**保证，不由读取端兜底 |
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
  /** 关联目录，任意多个；顺序即展示顺序。基础阶段不区分主次（见 §25.5） */
  directories: z.array(z.string()).default([]),
  /** 工作文档路径；空串表示未绑定（额外功能，默认不消费，见 §25.4） */
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
**默认**：`$DSH_HOME/project-groups/<projectId>.md`（2026-10-04 修订；原 `$DSH_HOME/projects/`）

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
| 6 | 项目文档位置 | **`$DSH_HOME/project-groups/<projectId>.md`** | 2026-10-04 修订（原 `$DSH_HOME/projects/`）；用户可覆盖 docPath |
| 9 | 项目信息注入 | **`systemPrompt.context()`**（user 消息），见 §25 | section 会被 `complete: true` 的 preset 整个丢弃 |
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

> **后续增补（2026-10-01，Z-1/方案 D）**：`global` 新增 `pendingMutation`
> 恢复标记；`create`/`delete` 改为官方式的多笔写序并串行化
> （`operationTail` + `recoverPendingMutation`）；`baseline()` 改为纯派生。
> 详见 §14 的 Z-1 与 §2 的「投影纯派生」原则。

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
  **⇒ 已升格为待办 Z-7**（2026-10-07 用户提出），决策点见那里，此处不再重复。
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

> ⚠️ **本节记录的做法已于 2026-10-13 撤回**（见 Z-4）。
>
> **为什么撤回**：把组编进行键**不能区分**"新建"与"其他任何重新归档" ——
> 删除项目、点未分组的 ＋、拖拽，键的变化与"点另一项目的 ＋"逐字相同，
> 却应当滑动。所以它修好了本节这一个场景，同时**引入了**"删除项目时淡入"
> （Z-4，用户事后发现），而且**当时并未说明这个代价**。
>
> **现行做法**：行键回到 `session:<id>`（一切归属变化都滑动，与官方一致），
> **"新建"改由显式信号表达** —— `startSession` 是所有新建入口的汇聚点，
> 它公告 `onNewSession(sessionId)`，浏览器转成 `AnimatedRows` 的
> `enteringKeys`，该行淡入。详见 Z-4 与本文件"新建会话"一节。
>
> 下文保留原始记录，作为"为什么这个思路看起来成立却不成立"的证据。

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

> ⚠️ **本节记录的是当时（3b）的行为，后被 Z-5 推翻**：`default` 模式此后
> **不再被采纳为 `specified`**，而是写入插件自己的 `baseWorkspace.adoptedPath`
> 并**保留 `mode`**（卡片高亮不再移动）。见下方 Z-5。
> 下面清单里的第 6 条已按新语义改写（"重建后仍是 default 且记下了 adoptedPath"）。

**验收（`probe-base-workspace-rebuild.mjs`，全绿）**：

```
1) 目录已创建 + 已注册为工作区 + 弹窗关闭
2) 重建后 ＋ 落在重建的工作区（不再弹窗）
3) 标题是用户起的名字，不是 basename
4) 目录已存在时重建幂等（该路径仍只有一条）
5) 父目录也不存在 ⇒ mkdir -p 一路建上去
6) default 模式重建后仍是 default + 记下 adoptedPath + ＋ 落点正常 + 未沿用旧名字
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

### 零散待办（用户实测发现，2026-10-01）
- [x] **Z-1 新项目创建时从底部滑到顶部** ✅ **已修复并实测确认（2026-10-01）**
      现象（用户实测）：新建项目**从列表底部滑到顶部**；官方新建工作区是
      **直接出现在顶部**（只有极轻微的 100ms 淡入，无滑动）。
      **官方源码已核实**：`AnimatedRows.tsx` 与我们 vendored 的那份
      **SHA256 逐字节相同**，所以动画引擎就是官方的，问题不在引擎。
      官方 `workspace/src/index.ts:290` 的 `list()` **完全从 `workspaceIds`
      派生**：记录已写但未进 `workspaceIds` 的中间态**官方看不见**，
      因此官方只有一次可见转换（出现在顶部）⇒ 判定为"新行" ⇒ fade。
      **我们的机制**：`create` 是**两笔独立领域写入**（`index.ts:238-239`），
      每笔都触发 `domain/changed` ⇒ `follow` 重发完整 baseline（共两帧）：
      - **帧 1**（记录已写、order 未写）：`baseline()` 的**补漏逻辑**
        （`index.ts:194` `ordered.push(id)`）把新项目**追加到最末尾**
      - **帧 2**（order 已写）：新项目在**最前面**
      ⇒ `AnimatedRows` 看到同一行键从底部移到顶部 ⇒ 判定为**移动** ⇒
      执行 `translate` glide ⇒ **从下往上滑**。
      **根因 = `index.ts:192-194` 的补漏逻辑**（本意是防"记录落盘但无 order
      条目"被静默丢弃，属数据完整性保护），它顺带把两笔写入之间的
      中间态变成了一个可见帧。
      **注意**：官方也是"先写记录、后写顺序"（`createCanonical`
      `workspace/src/index.ts:508-559`，实为三笔：pending 标记 → 记录 → 顺序），
      **所以帧数相同**。差别**不在写入顺序，只在读取端**——官方 `list()`
      是纯派生，我们的 `baseline()` 多了补漏。先前"反转写入顺序"的说法
      不准确，已更正。
      **修法（已实施，2026-10-01）：贴合官方 = 让投影变成纯派生 + 采用官方的
      恢复标记。** 用户选定**方案 D**（最贴合官方，零残留）。
      `baseline()` 只按 `order()` 派生，与官方 `list()` 同构 ⇒ 中间态不可见
      ⇒ 只有一次可见转换 ⇒ 单次 fade。
      **实施内容**：
      - `src/spec.ts`：新增 `pendingMutation` 判别联合（照抄官方
        `workspace/src/spec.ts:40-43` 的形状）+ `globalRecord.pendingMutation`
        （`.optional()`，无需 bump version——同 `newSessionTarget` 的兼容机制）。
      - `src/index.ts`：新增 `operationTail` / `recoverPendingMutation` /
        `operate`，`ready()` 内启动即恢复。
      - `create` 改为**三笔写序：标记 → 记录 → 顺序（并清标记）**。
      - `remove` 改为**顺序写在首笔**（镜像 create）。
      - `baseline()` 删掉补漏，改纯派生。
      **写序的理由（关键且易写错）**：
      - **顺序必须最后写**（create）/ **最先写**（delete）⇒ 中断时 id 总是
        **不在** `projectIds` 里 ⇒ 残留**永远是记录集** ⇒ 恢复只需"删记录 +
        清标记"，无需猜测方向。
      - **标记必须是独立一笔**（虽然与顺序同属 global）⇒ 若合并，"顺序先于
        记录"会被发布 ⇒ 崩溃后顺序里留下悬空 id，而恢复删的是记录，**够不到它**。
      **关于残留**：正常路径零残留；写入失败由回滚兜底；进程被强杀由
      `recoverPendingMutation` 在下次启动清除。**三种情形都不留残余。**
      **既有测试 #9 是"假通过"（实施中发现）**：它用
      `unit.global = { projectIds: [] }` 修改后端 state 对象，但 facility 在
      `open()` 时**只读一次 `loadAll()`**，之后 live domain 持有自己的内存副本
      —— 那行赋值**从未影响到 `baseline()`**。所以它此前既没覆盖补漏逻辑，
      也没覆盖任何恢复路径。**已重写**为：通过后端注入崩溃后的持久化形态，
      再用**新 controller** 打开观察（这才是"重启后看到什么"）。新增 9b
      （正常路径零残留的正面断言）、9c（中断的 delete，含 assignment 清理）。
      **断言数 354 → 362**（#9 由 2 条变 4 条，新增 9b 3 条、9c 3 条）。
      实测 **362 PASS / 0 FAIL / 13 suites**。

      ### ✅ 实测复核：方案 D **修好了**动画（2026-10-01，逐帧实测 + 反向对照）
      **过程**（含一次误判的更正）：
      1. 用户重装（`link:` 指向本地仓库）后实测**仍然滑动**，据此一度记录为
         "方案 D 没有修好"，并写下了"推理有误"的结论。
      2. 随后做了**浏览器逐帧实测**（`scripts/probe-project-create-motion.mjs`），
         并用**反向对照**验证探针有效：
         | 构建 | 新建行的 y 序列 | 判定 |
         |---|---|---|
         | **Plan D 之前**（含补漏） | `654→594→537→…→211→206`（13 个位置） | **★ 从下往上滑** |
         | **Plan D**（HEAD） | `206`（恒定，两次独立运行一致） | **未滑动，单次淡入** |
         反向对照**复现了用户报告的现象** ⇒ 探针能抓到滑动，不是失灵。
         动画关键帧也吻合：新行是 `opacity→opacity` 100ms（淡入），
         其余行是 `transform+opacity→…` 200ms（平移让位）——**滑的是旧行在
         为新行腾位置，新行自己没有平移**。
      3. **用户重启 DSH 后确认：确实好了。**
      **⇒ 之前"没修好"的结论是错的，真正原因是 Host 端改动未生效。**
      **重要事实（记入文档，避免下次误判）**：
      **`link:` 安装下，改 `src/` 后必须 `pnpm build` 重建 `lib/`，
      并且必须重启 DSH 进程——Host 端 `lib/index.js` 不会热加载。**
      只重建不重启，看到的仍是旧 Host 行为；只重启不重建，同样不生效。
      （客户端 `lib/client.js` 可能热载，**Host 端不行**。）
      **`accept()` 守卫的比较列表里没有 `projectIds`** —— 这一点观察保留，
      它是真实的（`src/client/projects.ts:668-677` 只比 projects/assignments/
      expansions/orders/newSessionTarget/baseWorkspace），但**不再构成疑点**：
      实测表明帧被正确丢弃。
      **方案 D 的三项保证（投影纯派生 + 官方恢复标记 + 零残留）已由 362 条
      断言覆盖，动画则由此探针覆盖。**
- [ ] **Z-2 新会话入口仍用「工作区」措辞**（结论已修正，2026-10-01）
      首页新建会话的下拉（「默认工作区 / 添加工作区」）没有反映项目分组，
      左侧栏已按「项目」组织，此处仍说「工作区」。
      **应当改成「选择项目 / 新建项目」（用户判断，已确认正确）。**
      理由——不改才是冲突：
      - 下拉现在让用户挑**工作区（目录）**，而**底层工作区设置**
        （L4）也在决定"新会话去哪" ⇒ **两者争同一个决定**，职责重叠；
      - 下拉提供的是**侧栏根本不显示**的东西（侧栏按项目组织）⇒ 概念割裂；
      - 「添加工作区」（注册目录）在插件模型下**没有对应物**
        （项目没有目录），对应动作应是「新建项目」——而侧栏项目行的 `＋`
        已经是「新建项目」，**两处行为不一致**。
      改成「项目」后各归其位：
      - **底层工作区** = 会话落在哪个目录（项目无目录 ⇒ 同一目录 ⇒
        一次性技术配置，在设置卡里设）
      - **下拉** = 会话归到哪个项目（用户真正关心的归属）
      ⇒ 两者是不同层级的问题，不重叠。
- [x] **Z-3 新建项目不创建会话，官方会创建** ✅ **已实现（2026-10-01）**
      **官方链路已核实**：
      `WorkspacePicker.tsx:132-134` `createWorkspace({path}) → onPick(id)`
      ⇒ `WorkspaceBrowser.tsx:1316-1319` `onPick: { closeAddWorkspace();
      startSession(workspaceId) }` ⇒ `navigation.ts:223-241` `startSession`
      → `openWorkspace` → `connectWorkspace` ⇒ `navigation.ts:179-189`
      `reuseOrCreateBlank`：**没有可复用的空白会话就 `sessions.create`**。
      ⇒ **官方"添加工作区" = 建注册 + 立即开一个新会话。**
      **我们的链路**（`WorkspaceBrowser.tsx:1728-1739`）：`createProject({title})`
      **只写一条记录就结束**，不创建任何会话 ⇒ 与官方不一致。
      **用户意见：做成一个开关。** 设计张力需先定：
      官方那一步的实质是"在**新目录**里开一个会话"，而**项目没有目录**
      （所有项目共用同一个底层工作区）⇒ 对应行为应是
      "新建项目后在其中开一个空白会话"（语义说得通），
      但**开关的默认值、以及开关放在设置卡还是对话框**需要先定。
      （2026-10-01 完成，见下方"实施方案与实测"。）

      #### 实施方案与实测（2026-10-01 完成）

      **用户确认的设计**：开关进**插件自有设置页**，值进**插件自有领域**
      （随 profile 持久），默认**开**，行为**照抄项目行 `＋`**。

      **关键实现事实**：

      1. **Host 早就返回了 `projectId`** —— `protocol.ts` 的
         `ProjectValueResult { project: ProjectValue }` 一直带着它，是客户端
         `create` 声明成 `Promise<void>` 把它丢掉了。**零协议改动、零 Host 改动**。
      2. **行为 = `startSession(undefined, file)`** —— 项目没有 `workspaceId`
         （纯前端标签），带 `undefined` 调用走 `navigation.ts` 的"无目标"分支
         ⇒ 解析**底层工作区**，`beforeOpen` 归档到新项目。**与项目行 `＋`
         （`WorkspaceBrowser.tsx:887-896`）完全同一条路径**。
      3. **开关值必须经注入面 hook 进 vendored 树** —— 调用 `startSession` 的是
         `WorkspaceBrowser`，它读不到插件领域状态。新增 `createOpensSession` hook
         （第 4 个，与 `grouping`/`expansions`/`orders` 并列）。
      4. **`Switch` 组件**（`dsh-client-ui-primitives`）已在 `PLATFORM_MODULES` 里，
         **无需改构建配置**。

      **三个实施时踩到的坑（都已解决）**：

      - **`initialGlobal` 必须加新字段** —— 它被标注成 `GlobalRecord`，而
        `.default()` 使字段在输出类型里为**必需**；`tsc` 直接报错（好事）。
      - **`accept()` 的逐字段相等守卫必须加新字段** —— 漏了会导致"开关点了卡片
        不动"（守卫提前 return）。
      - **开关判断必须在 `setCreating(false)` 之后** —— 放前面会导致关掉开关时
        **对话框不关闭**。

      **实测（真实浏览器，两个开关位置）**：

      | 场景 | 结果 |
      |---|---|
      | 开关开（默认）：建项目 | ✅ 会话出现在**新项目下**（`rows=1`） |
      | 开关关：建项目 | ✅ **不创建任何会话**（会话总数 3 → 3） |
      | 页面错误 | ✅ 无 |

      探针 `probe-create-opens-session.mjs`（新）驱动真实 UI 验证以上三项。

      **空白会话"移动"是官方语义，不是缺陷**：
      `reuseOrCreateBlank`（`navigation.ts:208-218`）为**每个工作区保留一个**空白
      会话，而所有项目**共用同一个底层工作区** ⇒ 建第二个项目会把那个空白会话
      **挪过去**。实测确认（`probe-two-project-plus.mjs`）：点 A 的 `＋` 后会话
      归 A；点 B 的 `＋` 后**同一个会话 id** 移到 B，A 变空。官方对第二个
      **工作区**是同样行为（目录不同才不复用）——
      `probe-recent-blank.mjs` 早已记录这一性质。**故按官方语义接受**。
- [x] **Z-4 删除项目时会话淡入，官方是滑动** ✅ **已修复（2026-10-13）**（用户实测发现，2026-10-01）
      **现象**：官方删除工作区时，其会话会**滑动**到下方；我们的会话在下方
      **淡入**，失去了滑动。
      **根因（2026-10-13 订正）**：不是"取舍"，是 `7579f14`（2026-09-28）引入
      `sessionRowKey(id, groupKey)`（`session:<id>@<groupKey>`）的**副作用**。
      ⚠️ **本条原文两处都错，据此订正**：
      1. **场景不是"跨项目拖拽"**（用户 2026-10-13 指出："不是跨项目拖拽！
         那根本没有动画！"）。`7579f14` 的提交正文写的是**项目行的 ＋ 把
         新建的会话重新归档到另一个项目**。
      2. **它不是需要权衡的取舍** —— 当年实施时**没有检查反向路径**
         （删除项目），用户是事后才发现代价的。
      **为什么"行键含组"从根上不成立**：删除项目时其会话落入「未分组」⇒ 行键同样
      改变。而「在未分组点 ＋」**也**把会话送回未分组 ⇒ **两种情形的键变化逐字
      相同**，要求却相反（前者应滑动、后者应淡入）。⇒ **任何基于键的规则都无法
      区分它们**，问题必然复发（这正是用户给出的反例）。
      **正确修法（已实施）**：
      - **行键回到只含会话 id**（`sessionRowKey(id)` ⇒ `session:<id>`）⇒ 一切
        "归属变化"键都不变 ⇒ **默认滑动**（与官方一致）⇒ Z-4 自动消失；
      - **"新建"由显式信号表达**：`navigation.startSession` 是所有新建入口的
        汇聚点（顶部按钮、快捷键、项目行 ＋、未分组 ＋、新建项目、ui-schedule、
        ui-agent-preset）⇒ 它调用 `onNewSession(sessionId)`；浏览器把它转成
        `AnimatedRows` 的 `enteringKeys` ⇒ **该行淡入**。
      - 信号带 `seq`：新建通常**复用同一个空白会话**，两次点击公告同一个 id
        ⇒ 快照存储按值比较会认为"无变化" ⇒ `seq` 让第二次也算到达。
      - `probe-row-key-motion.mjs` 断言**反向并扩充**：第 5 节由"拖拽瞬移"改为
        **拖拽必须平移**（与第 3 节的淡入成对），21 PASS。
  - [x] **Z-5 默认工作区缺失：警告 + 重建（已实施，2026-10-07）**
        **背景（已核实，决定了文案怎么写）**：
        - `dsh-workspace` 的 `initializeDefault()`（asar 内 `lib/index.js:423-437`）只有三条分支：
          ① `defaultWorkspaceId` 已设 ⇒ **立即** `entities.get(id)` 返回（纯读）；
          ② 指针未设但注册表/归档集/会话历史非空 ⇒ `undefined`（纯读）；
          ③ **全空** ⇒ `mkdir` + 注册（**写**）。
        - 该字段**一经写入就不再清空**：`deleteKnown()`（同文件 `:703`）只从 `workspaceIds`
          过滤，**不动 `defaultWorkspaceId`**；而它**全仓库只有一处可写**
          —— `createCanonical` 的 `firstUse` 分支（`:684`），只有 `initializeDefault` 会传；
          公开 `create()` 不传（`:406-410`）。存储域又被 `reserved` 挡着不让第二个 opener 打开
          （`dsh-storage-domain/lib/index.js:356`）。
        - ⇒ **删掉默认工作区的注册后，官方那条路永久死掉，且没有任何公共 API 能改写它。**
          这正是"文案不能说会自动创建"的根据，也是本插件必须**自己另开一条道**的原因。

        #### 定案的模型：两条路径 + 单向切换

        ```
        mode === 'specified'  → 查 baseWorkspace.path（原有逻辑，未动）

        mode === 'default'
          ├ baseWorkspace.adoptedPath 未设 → 第1段：交给官方那条路
          │                                   官方有 → 用它新建；undefined → 弹窗
          └ baseWorkspace.adoptedPath 已设 → 第2段：查该 path
                                              命中 → 用它新建；未命中 → 弹窗
          重建（任一段）→ 写 adoptedPath、mode 不变 → 此后只走第2段，官方那条不再看
        ```

        **⇒ 「覆盖官方」发生在插件自己的字段里，不是去改官方闩锁**（上面已证改不了）。
        切换是**单向**的：翻过去就不回头。

        #### ① 存储：`baseWorkspace.adoptedPath`（`src/spec.ts`）
        新可选字段，与 `path` **分开**：`path` 是"上次**指定**选的记忆"（`mode === 'default'`
        时被刻意忽略，见 `spec.ts:199-204`），`adoptedPath` 是"默认工作区被接管后的位置"
        （`mode === 'specified'` 时被忽略）。一个字段载不了两者，否则
        默认 → 指定 → 默认 会丢掉用户的指定记忆 —— 那正是 `withDefaultMode` 存在的理由。
        **`.optional()`，不 bump version**（`single` 布局会因版本不符拒绝打开整份文件）。

        #### ② 判定"默认工作区不存在"：新增 Host Remote `officialDefaultWorkspace`
        客户端**看不到**闩锁、归档集、stored headers，所以**做不出正确的门控**；
        而直接调 `IWorkspaces.initializeDefault` 在第③支会**建目录**——
        渲染一个设置页不得写盘。
        ⇒ 判定放在 Host：**传一个"抛错的目录 resolver"**。它只会在第③支被调用，
        而第③支的调用点在 `mkdir` **之前**，于是任何分支都不可能产生写入。
        返回三态 `{ status: 'present' | 'missing' | 'unknown' }`；被自己的拒绝捕获时答
        `'unknown'`（"判不了"，不是"缺失"）。
        - 队列不受损：`enqueueOperation` 的尾部 `result.then(() => {}, () => {})` 吞掉本次拒绝
          （asar `:937-942`）。
        - 第②支答 `'missing'` 是诚实的：官方永不再建默认工作区，点新建会话**必然**弹窗，
          卡片告警与点击结果由此**结构性一致**。

        #### ③ 卡片（`settings-card.tsx` 的「默认工作区」卡片）
        - 缺失时第二行改文案 + **橙色警告**，复用 `${css.cubePath} ${css.cubeWarn}`
          （与「指定工作区已不存在」同款；`.cubeWarn` 与 `.cubeNotice` 颜色相同，
          见 `settings-card.module.css:237`/`:252`，此处按语义选 `.cubeWarn`）。
        - 文案：**「默认工作区缺失，新建会话时会弹窗确认是否重建」**
          —— 说"会弹窗"，不说"会自动创建"。
        - 同卡片上出现小按钮**「重建默认工作区」**：与「更换…」同款 `css.cubeAction`
          的 `role="button"` span（**不能是真 `<button>`**，嵌套会报 `validateDOMNesting`，
          多个探针把 console error 当失败；且**必须 `stopPropagation`**，
          否则同时触发模式切换），点击走**二次确认 `Modal`**（与弹窗内的同名动作共用
          同一个 `rebuildBaseWorkspace` Remote）。
        - 两段的判法不同、语义同一个：**第1段**读 Host 探测结果；
          **第2段**在注册表快照里按 `adoptedPath` 精确查表（同步，与指定卡片同款）。

        #### ④ 重建：保留 mode（`src/index.ts` 的 `rebuildBaseWorkspace`）
        - **删掉**原来把 `mode` 改写成 `'specified'` 的那段。**保留 `mode: 'default'`**，
          只写 `{ ...stored, mode: 'default', adoptedPath: entity.path }`。
        - ⇒ **卡片高亮不再移动**。用户点的是"重建默认工作区"，得到的就是这个，
          而不是被告知"你的设置被改成了指定工作区"——那就是这条待办的原始报告。
        - 重算路径的顺序：`specified` 用存的 path；`default` **先看 `adoptedPath`**
          （已接管时缺的就是它，重算官方位置会去修另一个目录、留原目录仍解析不到），
          未接管才走官方推导。
        - `withDefaultMode`（`protocol.ts`）与 `setBaseWorkspace` 的 `'specified'` 分支
          都必须**带上 `adoptedPath`**，否则一次模式切换就把接管丢掉（已由
          `verify-project-host.mjs` 的接管断言钉住）。

        #### ⑤ 新建会话弹窗的第三个选项：**已存在，不改**
        现有对话框的「重新指定底层工作区」（`baseMissing.respecify`）做的就是"直接选一个
        工作区"：关弹窗 → `pluginNavigation.openBundle` 跳到本插件详情页 →
        自动弹出 `BaseWorkspacePicker`。`probe-base-workspace-respecify.mjs`
        （**12 项断言**）钉住整条链。**⇒ 定案保留（即原 (c) 中的"保留跳页"）**：
        选择器服务挂在 Plugins 页的 slot 里（`src/client/index.ts:226-247`），
        同弹窗内直接列工作区需要另开实现路径，收益不抵复杂度。

        #### 验收
        - `scripts/probe-default-workspace-takeover.mjs`（新增，**27 条断言**）：
          起点无告警/无按钮 → 删注册 → 出橙警告 + 出按钮（文案含"弹窗"、不含"自动创建"）
          → 点重建只弹确认、**确认前不写盘** → 确认后写 `adoptedPath`、**`mode` 仍 `default`**、
          高亮仍在「默认工作区」→ 告警与按钮消失、＋ 落点正常且不再弹窗、页面零 console 错误。
        - `scripts/probe-official-default-probe.mjs`（新增，**18 条断言**）：
          证明探测**零副作用** —— 健康时答 `present`、删注册后答 `missing`，
          且两种情况下**注册表字节完全未变**、指针未被改写、**目录未被重新创建**；
          可重复，且探测的拒绝没有毒化注册表的重启队列。
        - `verify-project-host.mjs` 新增接管断言：`adoptedPath` 经 baseline 可见、
          穿过 默认 → 指定 → 默认 仍在、且不会被凭空捏造。
        - `probe-base-workspace-rebuild.mjs` 第 6 节语义反转：由"重建后被采纳为 specified"
          改为"重建后仍是 default 且记下了 adoptedPath"。
        - 已知局限：`adoptedPath` 只由重建写，**首次捕获**不需要单独动作；
          `officialDefaultWorkspace` 只服务卡片告警，弹窗仍由
          `navigation.ts:331-343` 的实时 `initializeDefault` 驱动（比探测更新）。


  - [x] **Z-6 新建/编辑项目支持关联链接（上游仓库）** ✅ **已实施并结案（2026-10-08 实施 / 2026-10-09 结案）**（2026-10-06 用户提出）
        **目标**：给项目登记**关联链接**，用于把项目联系到**上游仓库**（GitHub 等）。

        #### 一、数据（定案）
        - `projectRecord.links: z.array(z.string()).default([])`，**每条只存 URL**。
        - **不与 Z-8 合并形状**（用户 2026-10-08：Z-8 是「目录 + 链接」一起加 note，**先不做**）。
          将来 Z-8 落地时 `string[]` → `{ url, note }[]`，那是一次独立形状变更。
        - **两个硬约束（照 `directories`，不可省）**：
          - `.default([])` 是**兼容性刚需**（`src/spec.ts:58-72`）：域打开时逐条校验，
            缺字段会让**整个文件打不开、连累所有项目**。
          - **不能 bump version**（`single` 布局会因版本不符拒绝打开）。

        #### 二、校验开关（定案）
        - 详情页新增 **「开启http(s)://校验」**（en：`Validate http(s)://`），**默认开**。
        - 域里存一个布尔字段，带 `.default(true)` ⇒ 老数据读成"开"，**不 bump version**。
        - **关掉 = 整套消失**：转圈、绿勾、橙 ⓘ、标题行计数**全部没有**，填什么存什么。
          **关联链接本身仍然可用**（登记、编辑、注入都不依赖这个开关）。
        - **开启 = 标记，不拦截**：保存照常成功。这是关键取舍 ——
          否则一条早就存进去的旧值会**卡死整个对话框**（连改标题都提交不了）。
        - **校验规则：严格，不自动补全。** 必须以 `http://` 或 `https://` 开头。
          用户 2026-10-08 明确否掉了自动补全：实时校验 + 0.5s 防抖的组合下，
          "输入框里的字被无声改掉"比"多打几个字符"更糟。**输入框永不改用户打的字。**
          **判定是两步**：① 前缀必须是 `http://` / `https://`；② 其余部分必须能被
          `new URL()` 解析。
          **不额外要求 hostname 含点**（用户 2026-10-08 定案）：
          `https://a` 会通过，但**内网主机名**（`https://gitlab`、`https://nas`）
          是真实合法地址，为拦一个 `https://a` 而误伤它们不划算。
          这条校验的定位是"**形状像网址**"，不是"这个网站能用" ——
          我们**验证不了可达性，也不假装能**。
        - **两条纪律（2026-10-08 按探查修正）**：
          - **Host 零校验**。`create` / `update` **不判、不抛错、一律存下去** ——
            校验的产出是**客户端本地算出的标记**，不参与写入。
            （初版写的是"校验只在写入侧"，那是把它当成了拦截；探查后确认
            "标记而非拦截"就该让 Host 完全不参与，否则不合规的旧值会卡死保存。）
          - 校验规则**绝不进域 schema** —— 否则开关一关，已存的自由文本会让
            整个文件打不开（`directories` 的教训）。
          - 开关**只管 `links`**，不动 `directories`。

        #### 三、实时校验交互（定案）
        ```
        输入框内容变化
          ├ 有变化（正在输入）→ 转圈圈        ← 常驻，直到停手
          └ 停止变化 0.5s      → 校验
               ├ 通过 → 绿勾（仅聚焦时显示；失焦即消失）
               └ 不通过 → 橙 ⓘ（常驻，失焦也显示）
        ```
        - **转圈 / 绿勾 / 橙 ⓘ 三态共用「输入框内右侧」同一个位置。**
        - **空输入框** → 什么都不显示（没有内容就没有可校验的东西）。
        - **失焦后重新聚焦** → **重新校验一次**（转圈 → 出结果）。
          **用户 2026-10-08 定案**，推翻先前"用缓存、绿勾立刻出现"的设计。
          代价只是 0.5s 的圈，换来的是**代码里不需要任何依赖豁免**：
          "是否聚焦"可以正常进 `useEffect` 的依赖数组。
          （先前方案必须把 `focused` 排除在依赖外才能让勾立刻出现，那是本设计
          唯一的 React 反模式；此决定把它整个消掉。实现时
          **不保留值缓存,也不豁免依赖**。）
        - **标题行计数**：`N 条链接未通过校验`（en：`N links failed validation`），
          **橙色**，位置在「关联链接」标签右边同行，与行内校验**同一数据源、实时联动**。
          （用「条」不用「行」：链接的量词是条。）
          **（2026-10-08 用户定案）不要在设计阶段推演"会不会挤压 + 添加链接"** ——
          宽度、换行、对齐一律**实现后实测**，不臆造缺陷。
        - **关开关时，正在跑的 0.5s 一并取消。**
        - 行内 ⓘ 的 hover 说明：需以 `http://` 或 `https://` 开头。

        #### 四、可用的官方件（**均已从安装版 asar 核实存在**）
        | 需要的 | 用什么 |
        |---|---|
        | 绿勾 | `IconCheckOutlineRegular` |
        | 转圈圈 | **`StateDot state="ongoing"`** —— 官方现成的双圆环 SVG + CSS 旋转 |
        | 橙 ⓘ | `IconInfoOutlineRegular` |
        | 行容器 | 官方 `ModelRow` 先例：圆角卡片 + grid |
        | 输入框 | `Input`（`radius-md` / `height:32` / `bg-layer-1`） |
        | 图标按钮 | 官方 `iconButton`：28×28，`border:none; background:0 0`，hover 变底色 |

        **`StateDot` 还内含 `syncSpinner`**：把 CSS 动画的 `startTime` 钉到文档时间零点，
        让所有可见转圈**同相位**（各自挂载时刻不同会转得错位）。自己写会漏掉这个细节。

        #### 五、唯一要自己做的：输入框内右侧插槽
        官方 `Input` **只有左侧 `icon`**（源码：`function Input({ icon, className, ...rest })`），
        **没有 `suffix`**。
        ⇒ 自包一层：`position:relative` 容器 + 绝对定位的右侧图标 + `input` 加 `padding-right`。
        **不改官方 `Input`**（改了以后 vendor 重同步会冲突）。

        #### 六、官方 UI 先例：`ModelRow`（`dsh-client-ui-settings-models`）
        ```
        div.modelEntry                    ← 圆角卡片（border-l4 / radius-lg / padding 6px）
          └ div.modelRow                  ← grid，align-items:center，gap 6px
              ├ input.input               ← 输入框（radius-md / height 32）
              ├ button.iconButton         ← 28×28 裸图标按钮
              └ button.iconButtonDanger   ← IconTrashOutlineRegular size 14，hover 才变红
        ```
        **关键区别：`links` 不是照 `DirectoryRows` 做。**
        `directories` 靠**原生目录选择器**选路径 ⇒ 只读行 + 「添加文件夹」；
        链接是**手打**的，没有原生选择器 ⇒ **必须能内联编辑** ⇒ 照 `ModelRow`。
        多行列表的 `aria-label` **带序号**（官方写法 `` `${label} ${position}` ``）。

        #### 七、协议与 Remote（**已按探查修正**）
        ```
        ProjectCreateRequest.links?     创建时可带
        ProjectUpdateRequest.links      编辑时整份替换
        Remote setLinks                 ❌ 不加 —— 见九-B4 与 L 组
        ```
        **为什么最初写"照 setDirectories 做独立动词"是错的**：穷举后确认
        `setDirectories` **全仓库没有任何调用方**（`create` 直接带 `directories`、
        `update` 一次提交全部字段），它自己就是死动词。再加一个 `setLinks`
        只会多一份要维护的协议面、测试面与 Remote 描述符。
        将来若真出现"单独改链接"的界面，再补 —— 那是**加**，不改协议。

        #### 八、注入（渲染逻辑**零设计改动**，但测试要同步）
        **"零改动即可接通"说的是渲染路径**：§25.3.4 已把 `related links` 定为预留段，
        `src/injection.ts` 的 `declaredSegments` 留了注释锚点
        （`// related links belongs here once the project record carries it.`）。
        实现时打开那一行 `if`，声明段与段清单**自动通**。
        - 1 条：`Related link: {url}`
        - ≥2 条：`Related links:` + 逐项 `- {url}`

        ⚠️ **但"零改动"不等于不动任何东西**：`verify-project-injection.mjs`
        有**硬编码行数断言**（`6/6/6/8/5`）与**声明段精确文本断言**，
        加段后必红 —— 见九-K1/K2。**渲染代码不用改，测试必须同步。**

        #### 九、落点清单（**逐项核实，53 项**）

        来源：穷举 `directories` 的**全部 124 处引用**（12 个文件），逐类判定 `links`
        是否需要对应项。**不是"想到哪查到哪"** —— 三轮自由探查分别得到 18 / 33 / 53 项，
        每次都新增，说明只有穷举法才靠得住。

        **A 组 · 数据与协议（5 加 / 2 不加）**
        | # | 落点 | 判定 |
        |---|---|---|
        | A1 | `spec.ts:82` 后 `links: z.array(z.string()).default([])` | ✅ |
        | A2 | `protocol.ts:90` 后 `readonly links: readonly string[]`（**必填**） | ✅ |
        | A3 | `protocol.ts:228` 后 `readonly links?: readonly string[]` | ✅ |
        | A4 | `protocol.ts:257` 后 `readonly links: readonly string[]` | ✅ |
        | A5 | `ProjectSetDirectoriesRequest/Value` | ❌ **不加**（`setDirectories` 是死代码） |
        | A6 | `globalRecord` 加 `validateLinks: z.boolean().default(true)`，`initialGlobal` 同步 | ✅ |

        **B 组 · Host（3 加 / 3 不加）**
        | # | 落点 | 判定 |
        |---|---|---|
        | B1 | `index.ts:686` 后 `links: [...record.links]`（**复制，不可别名**） | ✅ |
        | B2 | `index.ts:1000` + `:1012` create 写入 | ✅ |
        | B3 | `index.ts:1072` update 写入（`next` 是展开式，**不写会保留旧值**） | ✅ |
        | B4 | `setLinks` Remote | ❌ **不加**（无调用方） |
        | B5/B6 | 协议类型导入 / `remote.ts` 描述符 | ❌ 不需要 |

        **C 组 · 客户端模型（7 加 / 2 不加）**
        | # | 落点 | 判定 |
        |---|---|---|
        | C1/C2 | `projects.ts:66/69` Remote 类型 | ✅ |
        | C4/C5 | `:540`/`:558` 调用 | ✅ |
        | C6 | `:1114` 后 `links: Object.freeze([...(project.links ?? [])])` | ✅ |
        | C7 | `:1213` 后 `groupingSnapshot` | ✅ |
        | C8 | `:1240` 后 `sameStringList(project.links ?? [], other.links ?? [])` | ✅ |
        | C3/C9 | `setDirectories` 相关 | ❌ 不加 |

        **D 组 · 漏斗类型（5 加）** —— **同名类型在两个文件里，都要改**
        `vendored/client/index.ts:155/163` 的 `ProjectActions`；
        `contract/slots.ts:325/336`；`client/index.ts:157-162` 转发。

        **E 组 · tree / 请求类型（5 加）**
        `tree.ts:129`（可选，同 `directories`）；
        `WorkspaceBrowser.tsx:275` `RowRequest`；
        `:1949` `RenameTarget.storedLinks`；
        **`:1160` 行菜单查表构造**；
        **`:2435` 播种 + `:2451`**。
        ⚠️ `RowRequest` 与 `RenameTarget` 是**两个不同类型**，都要加。

        **F 组 · UI state 与逻辑（8 加）**
        `:1962`/`:2055` state；`:1991` `renameLinksChanged`；
        **`:2004` 脏检查**；`:2018`/`:2101` 提交；`:2087` `openCreate` 重置；`:2451` 播种。
        ⚠️ 漏 `:2004` ⇒ **只改链接时保存按钮是灰的**（`docSpecChanged` 就是为同一原因加的）。

        **G 组 · UI 组件（3）**
        `LinkHeader` 照 `DirectoryHeader:354`；
        **`LinkRows` 不照 `DirectoryRows`**（链接可编辑，照官方 `ModelRow`）；
        两处插入 `:2608`（create）、`:2513`（edit）。

        **H 组 · 样式 / locale（3）**
        新增 link 类；**删除按钮复用已有 `.iconButton`**（`:17`，28×28）；
        `locales.ts:58/222` 加 `field.links` 与 `link.*`。

        **I 组 · 注入（3）**
        `injection.ts:277` 后渲染；`:306` 打开锚点；新增 `renderLinkLines`（照 `:348-351`）。
        `ProjectInjectionInput.project` 是 `ProjectRecord`（`:219`），`.default([])` 保证有值
        ⇒ **注入侧不需要 `?? []`**。

        **J 组 · 架构：开关怎么进 vendored 树（3）**
        **已核实完整转发链**（照 `DocSpecHooks` 的先例）：
        ```
        client/index.ts:348 applyVendored(..., { perProjectDocSpec, … })
          → vendored/client/index.ts:310 apply(..., docSpecHooks?: DocSpecHooks)
          → :421-439 docSpecHooks?.perProjectDocSpec ?? { 兜底 observable }
          → :594 塞进 WorkspaceBrowserInjected 的 hooks
          → WorkspaceBrowser.tsx:1560-1563 解构 usePerProjectDocSpec…
          → :1599-1612 useXxx(value => value)
        ```
        ⇒ 新增 `LinkHooks { readonly validateLinks: HostObservable<boolean> }`，
        `apply` 加**第 8 个参数**（现为 7 个）；`grouping.ts` 加 `clientValidateLinks` seat；
        卡片 inject face 加 `validateLinks` hook + `setValidateLinks`。

        **K 组 · 测试（8）**
        - **K1** `verify-project-injection.mjs:334-339` **硬编码行数 6/6/6/8/5** 必须改
        - **K2** `:161` 声明段精确文本要加 `` `related links` ``
        - **K3** `verify-doc-spec.mjs` **已查：无行数断言** ✅
        - **K4** `verify-locales.mjs` 自动（两侧都加键）
        - **K5** `verify-project-host.mjs` 加 `links` 往返
        - **K6** **6 处内联 `ProjectValue` 字面量**要补 `links: []`
          （`verify-project-injection.mjs:34`、`verify-doc-spec.mjs:187/255`、
          `verify-project-directories.mjs:90`、`verify-projects.mjs:116/862`）
        - **K7** `verify-projects.mjs:110/123` 的 **fake remote** 要加 `links`，否则静默不测
        - **K8** `verify-project-directories.mjs`（29 条）需**同构一套** links 断言

        **L 组 · 明确不做**：`setLinks` Remote、`remote.ts` 新描述符、
        `ProjectSetLinksRequest/Value`、域 version bump。

        #### 十、已裁定的两个问题
        - **`ProjectValue.links` 用「必填」**（`readonly links: readonly string[]`），
          与 `directories` 一致：`ProjectValue` 是 Host 产出，Host 必然带；
          老 Host 兼容由 `accept()` 的 `?? []` 兜。代价是 K6 的 6 处测试字面量补一次。
          **注意：这与"用户能不能不填"无关 —— 空数组 `[]` 一直是合法值，
          正如现在的「关联文件夹」可以一个都不加。**
        - **空行过滤**：空串/仅空白的条目**不进计数、不标 ⓘ**（与"空输入框什么都不显示"一致）；
          存储时**一并过滤掉**。

        #### 十一、设计层的验证结果（2026-10-08，四项）
        | # | 项 | 结果 |
        |---|---|---|
        | 1 | `protocol.ts` 加共享纯函数是否会破客户端 bundle 纯度 | ✅ **已验证**。临时加 `export function …` ⇒ `pnpm build` + **`pnpm verify:bundle` 全绿**，external 列表未变 |
        | 2 | `DocSpecHooks` 的兜底写法 | ✅ **已读全**（`vendored/client/index.ts:418-439`）。四者一个模式：`getSnapshot: () => 兜底值`、`subscribe: () => () => {}`。`validateLinks` 兜底取 `true` |
        | 3 | 官方是否已有"防抖 + 输入框 + 校验"先例 | ❌ **没有**。全量扫官方所有 `.js`（含 `dsh-web-frontend`），判据"防抖 + `<input>` + 校验语义"命中 2 个候选，细读 `setTimeout` 上下文后**全部无关** |
        | 4 | 计数放在标签右边会不会挤压 | ⏳ **不做纸面推演**（用户 2026-10-08 定案）—— **实现后实测** |

        **第 3 项的后果（重要）**：这套实时校验交互**没有任何官方先例可抄**，
        是 §0「界面与官方 1:1」的一处**有意偏离**，实现后必须登记进
        `src/vendored/README.md` 的 patch 表。

        **仍无法在纸面解决、只能实现后实测的两项**：
        - 输入框内右侧插槽在 **480px 对话框 + 官方 dialog CSS** 下是否排得下
          （`WorkspaceBrowser.module.css:616` 实测宽度 480px）
        **仍无法在纸面解决、只能实现后实测的一项**：
        - 输入框内右侧插槽在 **480px 对话框 + 官方 dialog CSS** 下是否排得下
          （`WorkspaceBrowser.module.css:616` 实测宽度 480px）

        已定（用户 2026-10-08）：**删除按钮用真 `<button>`** ——
        它在输入框**外**，不像设置卡里那种嵌套按钮必须用 `role="button"` span。

        **三项交互裁定（用户 2026-10-08）**：
        1. `isValidLink` **不要求 hostname 含点**（内网主机名合法）
        2. 失焦后重新聚焦 → **重新校验**（不缓存、不豁免 React 依赖）
        3. 删除按钮 → **真 `<button>`**

        **已知真空，用户已接受（2026-10-08）**：对话框关掉后，"这条不合规"就看不见了，
        只有下次打开编辑对话框才再看到 ⓘ。**不做额外提示**（不在项目行上加标记、不加别处提示）。
        理由：不合规只是"这条不像网址"，**不是错误状态** —— 数据照样存下、照样注入，
        下次编辑时标记自然回来。为一个非错误状态在侧栏常驻一个警告，代价大于收益。

        #### 实施记录（2026-10-08 完成）

        **落点：53 项 → 实际 55 项。** 实施前的最后一遍探查又发现**两处清单漏项**，
        都源自同一盲区：**清单是照 `directories` 推的，而 `directories` 没有开关**，
        所以"开关的协议面"整条链不在参照物里。

        | # | 漏项 | 漏了会怎样 |
        |---|---|---|
        | 1 | `setValidateLinks` Remote | 开关**没有写入动词**，卡片点了不生效 |
        | 2 | `baseline.validateLinks` | 客户端**永远读不到开关值**（baseline 是逐字段列的，不是整份透传） |

        **实测验证（全部通过）**：
        - `pnpm check` **706 PASS / 0 FAIL**（基线 667，净增 39）
        - 新增 `scripts/probe-project-links.mjs`（**26 条断言**，真实浏览器）：
          防抖三态、聚焦规则、失焦后 ⓘ 常驻 / 绿勾消失、标题行计数 1→2、
          **不合规照存**、重开读已存值、删行后 Host 收到短列表、关开关整套消失、零 console 错误
        - `verify-project-directories.mjs` 新增 12 条 links/开关断言（含"非 URL 原样存储"）
        - `verify-project-injection.mjs` 新增 links 段断言
        - `verify-locales.mjs`：设置卡 58/58、浏览器 151/151

        **⚠️ 探针抓到一个真实缺陷（已修）**：初版把 `focused` 放进 `useEffect` 依赖，
        于是**失焦也会重新校验** —— 失焦后那一行会显示 0.5s 转圈，
        **把规格要求"失焦仍常驻"的橙 ⓘ 顶掉了**。
        先前的设计推演（"`focused` 进依赖没有副作用"）是**错的**，只有真跑浏览器才暴露。
        修法：依赖改成**只在聚焦时自增的计数器**，聚焦状态由 hook 自己持有。

        **已登记**：`src/vendored/README.md` 的 patch 表新增 9 行，
        并在"刻意的行为偏离"里加第 **16** 条（实时校验无官方先例，
        是 §0「界面与官方 1:1」的一处有意偏离）。

        #### 实施后修复（2026-10-08，用户从截图发现）

        **现象**：「+ 添加链接」**只在出现计数时才在右端**；没有计数时贴在「关联链接」右边。

        **根因（我自己的 CSS 写错）**：`.linkHeader` 是 flex 但**漏了
        `justify-content: space-between`**，改用 `.linkInvalidCount` 的
        `margin-right: auto` 来把按钮顶到右端。
        ⇒ **按钮位置依赖于"计数存在"**：计数一消失，那个 `auto` 也没了，按钮塌回左边。

        **为什么与参照物不同**：`directoryHeader` 用 `justify-content: space-between`
        （**在容器上**做两端对齐），而它**只有两个子元素**，所以效果正好；
        `linkHeader` 有**三个**子元素，照抄 `space-between` 会让计数跑到中间。

        **修法（用户定案「乙」）**：内层加 `.linkHeading` 把「标签 + 计数」包成一组，
        外层容器做 `space-between`。⇒ 计数贴标签、按钮恒在右端，两个诉求同时满足。

        **🔴 测试盲区（已补）**：原有 26 条断言**没有一条测位置** ——
        计数文本在不在、标记对不对都测了，唯独没测"按钮在哪"，
        所以这个缺陷一路通过了探针。新增 3 条位置断言：
        - 无计数时按钮已在右端
        - 有计数时按钮位置**没变**（768 → 768）
        - 计数**紧贴标签**（不是被推到中间）

        **反向对照（证明断言有效）**：把 CSS 还原成旧写法后，那 3 条里
        **恰好 2 条失败**（`button.x=484`、`484 → 597.8`），其余 24 条全过 ——
        与用户截图的现象一致。

        #### 实施后修复 2（2026-10-08，用户报告"空链接"）

        **现象（用户原话）**："一个空链接无法保存，两个及以上空连接又可以保存了"，
        随后自己定性："**就是没有改导致的保存禁用，我原来就有一行空行了**"。

        **根因：设计里写了"存储时过滤空行"，实现只做了一半。**

        [本节第十节](#)原文是**两句话**：
        > 空串/仅空白的条目**不进计数、不标 ⓘ**；**存储时一并过滤掉**。

        前半句做了（`countInvalidLinks` 与 `useLinkCheck` 都跳过空值），
        **后半句完全没写** —— Host 的 `create` / `update` 原样收下 `[""]` 就存了。

        **因果链**：
        ```
        空行被存下（Host 无过滤）
          → 注入侧 renderLinkLines 不过滤 ⇒ 模型收到「Related links:」+ 空项目符号
          → 对话框播种把 [""] 读成一行空输入框
          → 用户不动它 ⇒ sameStringList 相等 ⇒ 判定"没改" ⇒ 保存禁用
        ```
        **⇒ "1 个不能存、2 个能存"不是矛盾，是同一 bug 的两个面**：
        两种操作其实**都算改了**（长度不同），差异来自更早一次操作留下的状态。

        **实际危害（有证据，不只是视觉）**：本会话此前的运行时上下文确实以
        `Related links:` + 两个空 `- ` 结尾 —— **模型收到了两个空的项目符号**。

        **修复（用户定案"保存时过滤 + 注入时过滤"两层，共四处）**：

        | # | 位置 | 改动 |
        |---|---|---|
        | 1 | `protocol.ts` | **新增共享纯函数 `nonBlankLinks`**（与 `isValidLink` 并列） |
        | 2 | `index.ts` `create` | `nonBlankLinks(request.links ?? [])` |
        | 3 | `index.ts` `update` | `nonBlankLinks(request.links)` |
        | 4 | `injection.ts` `renderLinkLines` **与 `declaredSegments`** | 各自调用同一函数 |

        **为什么第 4 处是两行而不是一行**：`declaredSegments` 若只看 `links.length`，
        全空列表会**公告 `related links` 段却不输出任何行** —— 违反"声明段与实际渲染段
        必须一致"这条有测试钉着的约束。两处**各自调用同一个纯函数**，天然一致；
        不做"传递过滤后的列表"是因为传参多一处可漏。

        **为什么共享而非各写**（用户选"乙"）：这条规则本已散在 **6 处**
        （对话框 2、Host 写入 2、注入 2）。**本次 bug 本身就是这种分散的产物**。
        `injection.ts → protocol.ts` 是纯函数 + type-only，**无循环、不破 bundle 纯度**
        （`protocol.ts` 只有 type 导入，已核实）。

        **边界（刻意的）**：
        - **只丢空值，不 trim 内容**：`"  https://x  "` 原样保留（与 `directories` 一致，
          也与"不做自动补全"同一条原则：不静默改写用户输入）。
        - **只丢空值，不按合规性过滤**：`"not a url"` 必须保留 —— 丢掉它就把"标记"
          变成了设计明确否决的"拦截"。

        **测试补充（本次盲区）**：原有 29 条链接断言**无一条喂空值**
        （计数与标记恰好也忽略空值，所以看起来测过了）。新增 12 条：
        - `verify-project-directories.mjs`：两条写入路径都丢空行、全空存成 `[]`、
          **非空不合规的必须保留**、空格内容不被 trim
        - `verify-project-injection.mjs`：全空**输出一句未设置**且**声明段公告**、
          混合只留真链接且**声明段公告**、带空格的原样保留
          （⚠️ 2026-10-13 更正：原写"全空不输出且声明段不公告"—— 那是当时的实现，
          按用户 2026-10-06 的定案应为三态对齐）
        - `probe-project-links.mjs` 第 7b 节：真实浏览器里"加空行 + 改标题 + 保存"，
          断言库里**不新增空链接**、重开后**无幽灵行**

        **反向对照（证明断言有效）**：撤掉 Host `update` 的过滤后重跑探针，
        **恰好 2 条失败**，且报错内容与用户描述逐一对应：
        ```
        FAIL  7b) 空行没有被存进去 — bad one|        ← 存成了 ["bad one",""]
        FAIL  7b) 重开后没有幽灵空行 — rows=2         ← 幽灵行回来了
        ```

        **验收**：`pnpm check` **718 PASS / 0 FAIL**（本次修复前 706，净增 12）。
        `probe-project-links.mjs` **33 条断言全绿**（原 29 + 位置 3 + 空行 1 + 幽灵行 1）。

        #### 实施后新增 3（2026-10-08，用户提出"空行提示"）

        **用户定案的形式**：**条件显示**（不是常驻）；**失焦时出现**；**弱化色**。

        **为什么不做常驻**：常驻讲的是"我们的数据处理方式"（"将会自动过滤空行"），
        而用户的心智是"这行空的到底算不算问题"。改成条件显示后，
        它从**信息**变成**安心** —— 只在真有空行时说"这行不用管"。
        文案也相应改成行为描述：`{n} 行为空，保存时忽略`。

        **为什么用失焦而不是"为空"作判据**：只按"为空"，提示会在按下「添加链接」的
        **那一瞬间**就出现 —— 用户还没来得及打字，读起来像对话框在抱怨他刚建的行。

        **🔴 由此暴露一个真实缺口（不只是探针写错）**：

        按"失焦"作判据，**前提是"新行会被聚焦"—— 而当时没有任何代码让它聚焦**。
        `onAdd` 只做 `setRenameLinks(list => [...list, ''])`。
        于是最常见的那条路径：

        ```
        点「添加链接」→ 新行出现，但焦点在按钮上
          → 输入框从未聚焦 → onBlur 永不触发 → onBlank 永不调用
          → 提示永不出现        ← 判据的前提不成立
        ```

        **修法**：点「添加链接」时自动聚焦新行（`LinkRow.contentRef` + `autoFocus` +
        父级用完即清的标记）。这既让判据成立，本身也是更好的交互 —— 点添加后直接就能打字。

        **一个实现细节**：`setRenameAutoFocus(renameLinks.length)` 必须写在
        `setRenameLinks` 的 updater **外面**。updater 必须是纯函数，StrictMode 会调用两次，
        在里面 set 另一个 state 是错误写法。

        **带副作用的清理点**（漏一处就是幽灵提示）：
        | 时机 | 处理 |
        |---|---|
        | 打字 `onEdit` | 从集合删掉该下标 |
        | 删行 `onRemove` | 集合**整体清空**（后面的下标全移位了） |
        | 打开对话框 | 集合与自动聚焦标记一起重置 |

        **实测（不做纸面推演）**：
        - **颜色确实不同**：琥珀 `rgb(245,158,11)` vs 空行提示 `rgb(225,229,238)`
        - **两个提示同时在场的头行不溢出**：`{"scroll":432,"client":432}`
          —— 此前我推演"三个小字可能挤"，**实测是满宽不溢出**（推演又错了一次）
        - 关掉「开启http(s)://校验」后**空行提示仍在**（它不依赖校验，已加断言）

        **验收**：`probe-project-links.mjs` **41 PASS / 0 FAIL**（33 → 41，新增 8 条）；
        `pnpm check` **718 PASS / 0 FAIL**。

        #### 实施后修复 3（2026-10-08，用户从截图发现"删一行空行后提示就不见了"）

        **现象**：截图里 5 行空行，**提示一行都没有**。用户原话：
        "只要删了一行空行就不显示提示了"。

        **根因：模型选错 —— 用"累加集合"，而不是"推导当前值"。**

        旧实现维护一个 `Set<number>`，行**失焦时把自己加进去**。删行时我写：

        ```
        setRenameBlanks(new Set())   // 当时的注释：
        // every later row's index moved, and
        // renumbering a set of positions buys nothing the next blur will not redo.
        ```

        **"下一次失焦会重新算出来"这句话是错的。**
        `onBlank` 只在**真实的失焦事件**里被调用；删行后焦点在删除按钮上，
        **没有任何新的 blur 事件发生**：

        ```
        删行 → 集合清空 → 剩余空行全部失去"已失焦"身份
             → 焦点在删除按钮，不产生新的 blur
             → 集合永远为空 → 提示永久消失
        ```

        **更深的问题：累加模型本身易腐。** 它必须在**三处**打补丁
        （打字时删下标、删行时清空、开框时重置）—— **补丁越多越说明模型选错了**。

        **修法（用户定案"改"）：不存集合，只存"当前聚焦的行下标"，计数推导。**

        ```tsx
        const [renameFocused, setRenameFocused] = useState<number | null>(null)

        function countBlankLinks(links, focused) {
          return links.filter((l, i) => l.trim() === '' && i !== focused).length
        }
        ```

        | | 集合模型（旧） | 单值模型（新） |
        |---|---|---|
        | 判据 | "失焦事件发生过" | "现在没聚焦" ← **与规则字面一致** |
        | 删行 | 要清空/平移 | **自动正确** |
        | 打字 | 要手动删下标 | **自动正确** |
        | 开框 | 要重置 | **自动正确** |
        | 状态漂移 | 会 | **不可能** |

        **三处补丁全部消失** —— 这正是模型选对的标志。改动**净减少代码**
        （`blankRowToggler` 整个删除）。

        **🔴 测试盲区（第四次同类）**：7c 测的是"加行 → 点标题 → 提示出现"，
        **没有一条测"删行之后"**。与我前三次的盲区完全同型：
        **只测了自己写的那条路径，没测状态会被打断的路径。**

        **新增 7d 节（5 条断言）**：三个空行→提示 3；删一行→**仍在且为 2**；
        再删→为 1；填上最后一个→消失。

        **反向对照（证明断言有效）**：注入一个"删行后清空且不自愈"的哨兵
        （等价于旧模型），**恰好 2 条失败**，报错与用户截图一致：
        ```
        FAIL  7d) 删掉一行后提示仍在，且为 2 — ...（提示整条不见了）
        FAIL  7d) 再删一行后提示为 1 — ...（提示整条不见了）
        ```

        **验收**：`probe-project-links.mjs` **46 PASS / 0 FAIL**（41 → 46）；
        `pnpm check` **718 PASS / 0 FAIL**。

        > **⚠️ 以下两条已被「实施后修复 4」推翻，保留作决策轨迹**：
        > - 「**失焦时出现**」的判据 → 改为**实时（只看空，与焦点无关）**；
        > - `countBlankLinks(links, focused)` 的 `focused` 入参 → **整条焦点上报链已删除**。
        > 代码与探针以「实施后修复 4」为准，本节文字仅记录当时的推理。

        #### 实施后修复 4（2026-10-08，用户报告"清空后行内 ⓘ 先消失、头行计数滞后"）

        **本段同时记录两次改动**，它们同源：两个消费者（行内标记 / 头行计数）
        对**同一次草稿变化**用了**不同的时间基准**，于是往两个方向各错了一次。

        **（一）空行提示改实时**（用户定案："不排除聚焦，只要是空就算，
        输入文字非空就不算"）

        原判据是「空 **且** 未聚焦」，为它建了一整套焦点上报链
        （`FocusedRow` 类型 + 两个 state + 两处重置 + 两处透传 + 两个事件绑定）。
        判据收窄成「空」之后，**整条链失去存在理由，全部删除** —— 改动净减少代码。

        ```tsx
        // 修复 3 的单值模型            →  本次
        function countBlankLinks(links, focused) {   →  function countBlankLinks(links: readonly string[]) {
          return links.filter((l, i) =>                return links.filter(link => link.trim() === '').length
            l.trim() === '' && i !== focused).length   }
        }
        ```

        **必须保留、不要连带删掉的两样**（它们管别的事）：
        - `useLinkCheck` 的 `onFocus` / `onBlur` —— 管"绿勾只在聚焦时显示"与"聚焦重跑校验"，
          有 3 条断言钉着；
        - 新行**自动聚焦**（`autoFocus` + `onAutoFocused`）—— 管"点添加后光标就在新行"，
          不再以提示为依据。

        **行为差异**：`点回该行提示消失` 这条断言**从此不再成立**（点回去它还是空的，
        提示应仍在），7c 已按新规则重写为 8 条。

        **（二）头行计数不再滞后**（用户报告的真问题）

        `useSettledInvalidCount` 原先对**任何**草稿变化都等 500ms。但行内**不是**：
        `useLinkCheck` 有一条**空值快速通道** —— `trimmed === ''` 直接 `idle`，因为没东西可校验。

        ```
        清空一行：
          行内   0ms  → idle             （空值快速通道）
          头行   500ms 才归零            （统一防抖）
        ```

        **⇒ 这是同一个缺口的两端**：上次修的是"头行**领先**"（0ms 出结论 vs 行内 500ms），
        本次是"头行**滞后**"。两次的根因都是"两边基准不同"。

        **修法**：等待的条件从"草稿变了"改成"**有行会转圈**"，即按行内自己的规则重建：

        ```tsx
        const restarted = !before.enabled                       // 开关刚打开：所有非空行都要重判
        const spins = restarted || links.some((link, at) =>
          link !== before.links[at] && link.trim() !== '')      // 改成非空 ⇒ 该行会转圈
        if (!spins) { setDisplay(countInvalidLinks(links, enabled)); return }   // 清空走这里，立即
        ```

        **按下标对齐**是刻意的：列表按 index 键控，删行会把后面每一行的值移到上一行，
        那些行**确实**会重判 —— 与真正存在的那些组件一致。

        **验证（不做纸面推演）**：

        | | |
        |---|---|
        | 修复后采样 | `[invalid/1, none/null, none/null, …]` —— 行内与头行**同一拍**归零 |
        | 反向对照 | 改回"一律等 500ms"后**恰好 2 条失败**，头行多持有 **7 拍（≈420ms）** |
        | `probe-project-links.mjs` | **61 PASS / 0 FAIL**（本轮新增 7e/7f；**注**：本节早前记的 41 / 46 与现今全量计数对不上，疑为当时只数了部分节，未能复原，以实测为准） |
        | `pnpm check` | **718 PASS / 0 FAIL / 退出码 0** |

        **反向对照的失败信息（与用户描述一致）**：
        ```
        FAIL  7f) 行内消失的那一拍，头行计数也同时为 null（不滞后） — {"mark":"none","count":"1 条链接未通过校验"}
        FAIL  7f) 之后头行不再单独持有计数 — ["1 条链接未通过校验" ×7, null ×7]
        ```

        **探针本身的一个坑（写的时候踩到）**：`fill('')` 之后**同一 tick** 采样会读到
        **提交前**的 DOM（输入框已空、旧标记仍在）。所以断言不能写成"每个采样都已消失"，
        那是把"读得太早"也算成缺陷。改为**配对断言**：**行内转 none 的那一拍，头行必须同时为 null**。
        采样窗口取 14 × 60ms ≈ 840ms，**刻意长于 500ms 防抖** —— 否则可能靠时序侥幸通过。

        **🔴 测试盲区（第五次同型）**：7e 测的是「非空 → 另一个非空」，
        **没有一条测「清空」**。而这个分支差别**静态就能看出来**（空值快速通道写在代码里）。
        与前四次盲区完全同型：**只测了自己写的那条路径。**

        **另发现（同型、方向相反，本次未处理）**：挂载时头行被 **seed 成当前草稿的值**，
        而行内要在 500ms 后才出结论 ⇒ 打开对话框的那一瞬间是**"头行领先"**方向的不同步。
        触发条件是"库里有不合规链接的对话框被打开"，**未修**，留作已知项。

        #### 实施后修复 5（2026-10-08，用户报告"非法→空时一行两段同时渲染一下"）

        **现象**（用户原话，并明确排除了折行："不是两行，是一行两段同时渲染一下"）：
        清空一行时，头行有**一帧**同时显示 `1 条链接未通过校验` 与 `1 行为空，保存时忽略`。

        **根因：两个提示的数据来源性质不同 —— 一个渲染期推导，一个来自 state。**

        ```tsx
        blankCount={countBlankLinks(renameLinks)}      // 渲染期推导 ⇒ 同一次渲染就变
        invalidCount={settledRenameInvalidCount}       // 来自 useState ⇒ effect 里 setState，
                                                       //   落后一轮渲染
        ```

        ```
        onChange → setRenameLinks([''])
          ├─ 渲染 N（上屏）：blankCount=1（立刻）   invalidCount=1（state，旧的）
          │                   ⇒ 一行两段同时渲染        ★ 用户看到的那一帧
          └─ effect：!spins → setDisplay(0)
               └─ 渲染 N+1：invalidCount=0
        ```

        **这是同一个根因的第三次表现**，三次都是「两个消费者不一致」：

        | 次序 | 症状 | 不一致之处 |
        |---|---|---|
        | 修复 4（一） | 计数**抢先**（0ms vs 行内 500ms） | 时间基准 |
        | 修复 4（二） | 计数**滞后**（500ms vs 行内 0ms） | 时间基准 |
        | **修复 5** | 两个提示**差一轮渲染** | **数据来源（推导 vs state）** |

        **实测**（一次性度量脚本，`MutationObserver` 亚帧 + `rAF` 逐帧分开采样；
        诊断结论已固化为 7g 的 3 条断言，脚本本身已删）：

        ```
        非法 → 空（单条）              非法 → 空（9 条）
           0  1 条未通过  —                0  9 条未通过  —
          17  1 条未通过  1 行为空         5  9 条未通过  1 行为空   ← 两段同场
          35  —           1 行为空        37  8 条未通过  1 行为空   ← 两段同场
        ⇒ 中间态上屏 1 帧                ⇒ 上屏 2 帧
        ```

        **折行假设已排除**：头行高度**恒 28**、`scroll === client`（432/432）、
        按钮 x 恒 768、列表顶不变 —— 与用户"不是两行"的判断一致。
        **`rAF` 与 `MutationObserver` 必须分开采样**：后者是微任务、早于绘制，
        "DOM 里存在过"不等于"用户看见过"。

        **范围收窄（顺带测出，重要）**：防抖落定那一瞬（行内 `invalid→valid`、头行 9→8）
        实测**同帧**（`行内转为最终态: 第 2 帧；头行计数变化: 第 2 帧`）⇒
        **定时器那条路已由修复 4 对齐，唯一没对齐的是"同步变化"这条**。

        **修法（用户定案"按根因"）**：

        1. **提取纯函数 `linksWillSpin(before, after, beforeEnabled, enabled)`** ——
           把 `useLinkCheck` 的"会不会转圈"规则写成一处，供渲染期与 effect **共用**。
           两者若不一致，就是屏幕上一帧错误的文字。
        2. **`useSettledInvalidCount` 的返回行改为 `spins ? display : countInvalidLinks(...)`** ——
           state 的唯一职责是"**等待期间保持旧值**"；不等待时它没有职责，
           就在渲染期直接推导，与 `blankCount` **同一拍**。

        **最关键的实现约束（最容易写错的一点）**：`concluded` ref **只在**「不转圈」
        与「定时器落定」两处写入，**绝不在进入等待时写**。
        否则等待期间一次无关渲染（hover、父组件更新）会让 `linksWillSpin` 把草稿与自己比较，
        得出"没有行在转圈"，头行就会在行内还在转圈时抢先报数 —— **把修复 4（一）的 bug 重新引入**。

        **为什么不做"排先后"（用户最初的方案）**：能消除重叠，但会换成一个**反向空档**
        （`[计数+空行] → [] → [空行]`，宽度先缩后扩 = 抖动）；且若实现成
        "`invalidCount > 0` 时不显示 `blankCount`"，会**破坏稳态并列** ——
        而"1 条不合规 + 1 条空行同场"是用户明确要的形态（7c 有断言、还测过不溢出）。

        **验证**：

        | | |
        |---|---|
        | 修复后（单条） | `两段同场 rAF 帧 0/3`，且**无过时并列** —— 计数与空行提示同一拍切换 |
        | 修复后（9 条） | 直接 `9 条未通过` → `8 条未通过 + 1 行为空`，一步到位 |
        | **反向对照**（返回行改回 `return display`） | **恰好 1 条失败**，报错即并列帧：`[{"inv":"1 条链接未通过校验","blk":"1 行为空，保存时忽略"}, …]` |
        | `probe-project-links.mjs` | **64 PASS / 0 FAIL**（7g 新增 3 条） |
        | `pnpm check` | **718 PASS / 0 FAIL / 退出码 0** |

        **新增 7g 节（3 条断言）**，断言用的是**单条不合规**场景 —— 它让判据干净：
        清空后**唯一正确**的终态就是"无计数 + 空行提示"，任何一帧两者并存都是缺陷，
        **不需要知道哪个数字是过时的**。

        **探针写法上的两个坑（都踩到并修了）**：
        - **不能用 `evaluate` 轮询**：坏帧只存在一次提交，往返之间会漏采 ——
          7g 改为**在页面内装 `requestAnimationFrame` 记录器**，与 7f 的轮询式采样不同。
        - **判据不能用"两段同场"**：稳态下两段本就该同场（1 条不合规 + 1 条空行），
          真正的瞬态特征是计数**过时**（说的还是变化之前那个数）。

        **🔴 测试盲区（第六次同型）**：7f 测的是"清空后**最终**是否归零"，
        **没有一条测"中间有没有并列帧"**。与前五次完全同型：
        测了自己写的那条路径（终态），没测**过程**。

        #### 设计变更 1：校验时间线统一（2026-10-08，用户多轮讨论后定案）

        **一句话**：**0.5s 防抖只属于「编辑」**；打开、新增、删除、聚焦一律立即，
        且行内与头行**同一拍**。

        **为什么不是又一处补丁**：修复 4（一）/4（二）/5 三次都栽在"**两个消费者**"上 ——
        计数领先、计数滞后、两个提示差一轮渲染。它们的共同前提是
        **行内与头行各有一条时间线、各有一个数据来源**。这次把前提去掉了。

        ##### 决策表（每条都注明出处）

        | # | 决策 | 出自 |
        |---|---|---|
        | 1 | 空/通过/不通过**共用一次** 0.5s 防抖 | 用户：「万一用户是连续输入呢」「这正是和有内容是修改一样的逻辑」 |
        | 2 | **聚焦不重复校验**（②） | 用户：「聚焦时不再次校验：已经校验好」 |
        | 3 | **打开时同步校验一次**，头行跟着等（③） | 用户：「打开时正常同步校验」 |
        | 4 | **新增不转圈**：出生即空不是判定 | 用户：「新增行默认就是空的…用户看再校验一次就会很怪」 |
        | 5 | **新增立即计入顶部**（撤销 latch） | 用户：「失焦才显示太麻烦了，还是实时显示吧」 |
        | 6 | 头行记忆与对话框**同生命周期** | 用户：「上面怎么复用旧信息了」＋ 采纳抽子组件 |
        | 7 | **绿勾行为不改**（仍仅聚焦时显示） | 用户：「算了，绿勾要不然不改，就②，③就够」 |

        ##### 模型

        ```
        唯一的时间机制：值被编辑后 0.5s 防抖
              │
              ├─ 行内：checking → 空 / 通过 / 不通过
              └─ 头行：等待期间显示**上一份落定快照**，
                       落定时与行内**同一拍**翻新

        不等待的场合：
          打开对话框 → 行内校验一次，头行**跟着等**（③）
          新增一行   → 行内不校验（出生即空），头行**立即**计入
          删除一行   → **立即**（用户明确意图）
          聚焦       → 不重新校验（②）；绿勾仍仅聚焦时显示
        ```

        ##### 两处结构性例外，以及它们的理由

        - **出生即空 vs 被编辑成空**：`''` 作为**默认值**没有可判的东西，所以新增行不转圈；
          `''` 作为**编辑结果**（用户删掉刚打的字）必须等 ——
          这正是"删空 → 再输"不闪烁的机制：计时器被下一次输入推翻，提示从未出现。
          实现是 `useLinkCheck` 里一个 per-row 的 `edited` ref，**从 change handler 置位**
          （不用 effect：StrictMode 双跑会误标新行）。
        - **新增/删除不等，编辑等**：`headerShouldWait` 里 `after.length !== before.length → false`。
          新增是"出生即空"，删除是用户明确意图，两者都不产生需要等待的检验。

        ##### 根因（用户报的"上面复用旧信息"）

        **头行的记忆活得比对话框长。**

        ```
        :2482  useSettledInvalidCount(...)   ← 对话框组件顶层：开关都在
        :3079  {renameTarget?.kind === 'project' && <linkBlock>}  ← 行只开着时挂载
        closeRename() { setRenameTarget(null) }                    ← 不重置 renameLinks
        ```

        | | 打开时 | 关闭时 |
        |---|---|---|
        | 行 | 全新挂载 → 转圈 | **卸载** |
        | 头行 hook | 沿用上次 `display`/`concluded` | **不卸载、不重置** |

        两个后果：
        - **重开同一项目**：`links` 值相同 ⇒ 判"没变" ⇒ 头行 t=0 出数，行才刚开始转圈；
        - **换一个项目**：等待期间 `held` 还是旧值 ⇒ **A 的数字画在 B 的界面上**。

        **修法：抽 `LinkBlock`**，让头行与行**同生同死**。依据是**从官方 asar 读出的原文**：

        ```js
        function Modal({ open, onClose, ... }) {
          const dialog = useRef(null);
          useModalLayer(dialog, open, onClose);
          if (!open) return null;          // ← 关闭即卸载子树
          return createPortal(...)
        }
        ```

        ⇒ 不需要任何"记得重置"。顺带删掉**五处手动重置**与**两个 `autoFocus` state**
        （它们存在的唯一理由就是"状态活得比对话框长"）。

        ##### 行为一览（改后）

        | 场景 | 行内 | 头行 |
        |---|---|---|
        | 打开对话框（有值） | 转圈 0.5s → 结论 | 同时等，之后一起出 |
        | 点「添加链接」 | **不转圈** | **立即**计入 |
        | 打字 | 转圈 0.5s → 结论 | 保持旧快照 → 同一拍翻新 |
        | 清空一行 | **转圈 0.5s** → 无标记 | 同上 |
        | 删空后 0.5s 内再输入 | 计时器被推翻 ⇒ **提示从未出现** | 同 |
        | 删除一行 | 后续行转圈（index 键控） | **立即** |
        | 聚焦 | **不重校验**；绿勾（仅聚焦显示）零延迟出现 | 不变 |

        ##### 验证

        | | |
        |---|---|
        | `probe-project-links.mjs` | **78 PASS / 0 FAIL**（64 → 78） |
        | `pnpm check` | **718 PASS / 0 FAIL / 退出码 0** |

        **7h 逐帧实录**（打开一个含不合规链接的对话框）：
        ```
        [{"mark":"none","count":null}, {"mark":"checking","count":null},
         {"mark":"invalid","count":"1 条链接未通过校验"}]
        ⇒ firstMarked=1 firstCount=2：**转圈在前，报数在后**，头行不领先
        ```

        **反向对照（三向，全部命中）**：

        | 哨兵 | 失败项 | 报错 |
        |---|---|---|
        | `headerShouldWait` 恒 true | 3 条 | `7d) 删除立即生效 — 仍显示 3 行为空` |
        | `headerShouldWait` 恒 false | 3 条 | `7e) 转圈期间头行不抢先报新数`（正是修复 4 的缺陷） |
        | hook 放回对话框顶层 | **1 条** | `7i) 打开全合法的项目时头行从不显示旧计数 — [{"count":"1 条链接未通过校验"}, …]` |

        第 3 向的帧数据就是你报的现象：
        ```
        打开 clean（全合法）期间:
          {"mark":"none",     "count":"1 条链接未通过校验"}   ← linked 的旧数画在 clean 上
          {"mark":"checking", "count":"1 条链接未通过校验"}   ← 行在转圈，头行还是旧数
          {"mark":"none",     "count":null}                  ← 落定后才对
        ```

        **🔴 探针取样错误（本轮我自己犯的，两次同型）**：
        `7h` 与 `7i` 初版都在 `openEditDialog` **返回之后**才装记录器，
        而该辅助函数内部有 `waitForTimeout(900)` —— 比 500ms 防抖长，
        于是**永远看不到要观察的那一瞬**。7i 初版因此**在缺陷存在时也通过**（77 PASS 假绿）。
        修法：新增 `openEditDialogRecorded`，**在点击菜单项之前**装 `requestAnimationFrame`
        记录器。**这与前六次盲区同型：测了自己写的那条路径，没测"记录器什么时候开始"。**
        另：反向对照 3 的第一版用**模块级缓存**模拟旧结构，**不忠实**（对照未失败）——
        必须用真实的"hook 挂在对话框顶层"才能复现，因为成因是"hook 活得比行久"。

        #### 设计变更 2：行身份用稳定 id（2026-10-08，用户报告"删除会导致其他行重新校验"）

        **现象**（用户原话）：「目前删除会导致其他全部/部分重新校验。目前我不确定所有触发条件。」

        ##### 根因：组件身份用「位置」，数据身份用「值」

        ```tsx
        // 行按**位置**键控 ⇒ 组件实例认的是"第几个"
        {links.map((url, index) => <LinkRow key={index} ... />)}

        // 校验按**值**触发 ⇒ 结论认的是"什么内容"
        }, [value, enabled])
        ```

        删除下标 `i` 时，后面的组件实例**位置没动、却被塞进了别人的值**：

        ```
        删除前 [A, B, C, D] → 删除 i=1 → [A, C, D]
          下标 1 的**同一个实例**（原持有 B 的 state）现在收到 C
            ⇒ value 变 ⇒ effect 重跑 ⇒ 转圈 0.5s
        ```

        ##### 两个后果，第二个才是真病

        **① 多余重校验**（实测九场景，**H2 值驱动**被证实）：

        | 场景 | 转圈行 | 说明 |
        |---|---|---|
        | 删下标 0（4 行） | `[0,1,2]` | 其余**全部** |
        | 删下标 1（4 行） | `[1,2]` | 其后各行 |
        | 删**末行** | `[]` | 无行受影响 |
        | **删下标 0（`same,same,tail`）** | **`[1]`** | **判定性证据** —— 上移那行值没变，未重校验 ⇒ 不是"删除就全刷" |
        | 删下标 0（三行全合法） | `[0,1]` | **全合法时也转圈** |
        | 只改标题 | `[]` | 不触发 |

        **② 🔴 结论错配**（真病）：

        ```
        场景 5：删下标 0（合法, 不合规 → 只留不合规）
          动作前: ["none","invalid"]
              0ms  ["none","invalid"]
             15ms  ["none"]        ← 上移那行显示 **none**（继承了"合法"的结论）
             32ms  ["checking"]
            515ms  ["invalid"]     ← 落定才对
        ```

        **⇒ 那 17ms 里屏幕上显示"合法"，而它的值是 `not a url`。**
        与「A 的计数画在 B 的对话框上」（设计变更 1 的跨项目泄漏）**是同一类错误**：
        **一个东西的结论画在另一个东西上**。四行全 `invalid` 时看不见，
        **只有相邻两行结论不同才暴露**。

        ##### 修法：给行一个与值、与位置都无关的 id

        ```tsx
        interface LinkRowDraft { readonly id: string; readonly url: string }
        {rows.map(row => <LinkRow key={row.id} ... />)}
        ```

        删除后，其余行的 **id 不变** ⇒ React 复用同一批实例（C 只是换了位置）
        ⇒ `value` 与 `state` 始终配对 ⇒ **零重校验、零错配**。

        **`key={url}` 已实测否决**（反向对照 2，**7 条失败**）：
        ```
        FAIL  2) 输入后立刻是转圈 — none        ← 打字即重挂载，state 归零
        FAIL  2) 停手后变成绿勾 — none
        FAIL  3) 聚焦时是绿勾 — none
        ```

        ##### id 只活在客户端草稿里

        `linkUrls(rows)` 是**唯一**丢弃 id 的地方，只在两处提交调用
        ⇒ **协议、Host、存储格式一行不改**（`links` 仍是 `string[]`）。

        **连带简化**：`autoFocusIndex` → `autoFocusId`，
        `onRemove(index)` → `onRemove(id)` —— 顺带消掉"删行后下标移位可能指错行"的隐患。

        ##### 修后实测

        | 场景 | 修复前 | 修复后 |
        |---|---|---|
        | 删首行 | `checking` × 3 行 | **零转圈** |
        | 删中间行 | `checking` × 2 行 | **零转圈** |
        | 删末行 | 零 | 零 |
        | **错配（场景 5）** | `["none"]` 持续 17ms | **从不出现**：`["none","invalid"] → ["invalid"]` |
        | 编辑一行 | 只该行 | 只该行（未修过头） |
        | 新增一行 | 不牵连 | 不牵连 |

        ##### 验证

        | | |
        |---|---|
        | `probe-project-links.mjs` | **86 PASS / 0 FAIL**（78 → 86，新增 7k–7n 共 8 条） |
        | `pnpm check` | **718 PASS / 0 FAIL / 退出码 0** |
        | 现有 78 条 | **全部继续通过**（探针按位置定位 DOM，与 id 无关） |

        **新增 7k–7n**：四种删除位置零转圈、**错配帧不出现**（`7l` 钉的就是真病）、
        编辑仍只重校验该行（防修过头）、新增不牵连。

        **反向对照（两向，全部命中）**：

        | 哨兵 | 失败项 | 关键报错 |
        |---|---|---|
        | `key` 改回 `index` | **4 条** | `7l` 抓到错配：`["none","invalid"] → ["none"] → ["checking"]` |
        | `key` 改成 `url` | **7 条** | `2) 输入后立刻是转圈 — none`（打字即重挂载） |

        **🔴 探针自身两个缺陷（本轮发现并修）**：
        - **`storedProjects()` 不返回 `projectId`** —— 它是表的**键**，不是记录的字段。
          探针里三处 `storedProjects().find(...).projectId` 因此**一直是 `undefined`**，
          对应的 `update` 被 Host 拒绝，**静默无效**。此前无害只是因为那三处要设的状态
          "恰好已经在位"。新增 `projectIdOf(title)` + `setStoredLinks(title, links)`
          （带 `ok` 断言），三处一并修正。
        - **7k 段污染了共享状态**：它把 `linked` 依次改成 4/3 行等，
          跑完没还原 ⇒ 下游 11 条失败。修法：段末 `setStoredLinks('linked', ['bad one'])`。

        #### 设计变更 3：三层模型 —— 事实即时 / 判定延迟 / 纠正自动（2026-10-09）

        **用户原话**：「非空和空立即吧，有内容才校验，删空马上变空，输入内容马上变成非空，
        然后转圈圈转完了在加到非法。」随后确认：「清空是一个很明确的动作：
        清空后未通过也马上消失。」

        ##### 业界先例（用户要求核实，确有）

        | 模式 | 出处 | 与本设计的关系 |
        |---|---|---|
        | **Reward Early, Punish Late** | Mihael Konjević，被 Smashing / UX Planet / a11y 指南反复引用 | 清空即时撤销 = reward early |
        | **Remove Error Messages as Soon as the Field Is Corrected** | Baymard「3 Critical Details」第 2 条（2024-01-09） | 本设计的核心诉求 |
        | **Avoid Premature Validation** | Baymard / NN/g | 出生即空不转圈早已符合 |
        | **Validate Empty Fields Only On Submit** | Smashing《A Complete Guide To Live Validation UX》第 3 节 | 空值不参与实时**判定** |
        | 实测用户原话 | Baymard | *"Why are you telling me my email address is wrong, I haven't had a chance to fill it all out yet!"* |

        Baymard 另有一条**实测结论**直接支持本设计：错误消息在用户**改好之后**仍留着，
        会让用户

        > **misinterpret their newly corrected, and now valid, input to still contain an error**

        ⇒ 这正是本文件此前反复修的「结论比它的值活得久」，而它是**实测出的用户误解**，
        不是审美偏好。

        ##### 根因：三层被压成一层

        改动前是**单层**：空、通过、不通过**共用一条 500ms 时间线**。

        ```tsx
        // 旧：三者共用一个时钟
        if (trimmed === '' && !edited.current) { setState('idle'); return }  // 唯一即时分支
        setState('checking')
        const timer = setTimeout(() => {
          setState(trimmed === '' ? 'idle' : (isValidLink(trimmed) ? 'valid' : 'invalid'))
        }, 500)
        ```

        **性质根本不同**：

        | | 空 / 非空 | 通过 / 不通过 |
        |---|---|---|
        | 需要计算？ | **否** | 是 |
        | 会算错？ | **不可能** | 可能（用户还在打字） |
        | 该等吗？ | **不该** | 该 |
        | 性质 | **事实** | **判定** |

        ⇒ **把事实塞进判定的时钟，就是这个文件历次缺陷的共同来源。**
        此前修的四条（计数抢先、计数滞后、差一轮渲染、删除错配）都是它在一个消费者上的表现。

        ##### 不变量：一个结论只对产生它的那个值有效

        这条不变量同时是**层 3 的全部实现** —— 值一变，结论**自动**失效，不需要写代码。

        ```tsx
        // 旧：只存标记 —— 换值后必然有一帧画着旧结论
        const [state, setState] = useState<LinkCheck>('idle')

        // 新：存「标记 + 它属于哪个值」，渲染期比对
        const [verdict, setVerdict] = useState<{ url: string; mark: LinkCheck } | null>(null)
        ```

        ```tsx
        const settled: LinkCheck = !enabled || isBlankLink(value)
          ? 'idle'                                     // 层 1：事实
          : verdict !== null && verdict.url === value
            ? verdict.mark                             // 层 2：已落定
            : 'checking'                               // 层 2：判定中（层 3 也走这里）
        ```

        ##### 头行：`useSettledLinks` → `useSettledUrls`，按 id 配对

        ```tsx
        // 旧：持整个上一份快照 + 一个决定"要不要等"的函数
        function useSettledLinks(links, enabled): readonly string[] | null
        function headerShouldWait(before, after, beforeEnabled, enabled): boolean

        // 新：只记「哪一行在哪个值上有了结论」，整体替换
        function useSettledUrls(rows, enabled): ReadonlyMap<string, string>
        ```

        **删除了整个 `headerShouldWait`** —— 它存在的理由是"要不要整表等待"，
        而新模型下**每一行各自与自己的值配对**，那个问题不存在了。

        **两个计数走两条不同规则**（这是分层最直接的体现）：

        ```tsx
        countBlankLinks(rows)                            // 事实层：吃 live，即时
        countInvalidLinks(rows, settled, enabled)        // 判定层：
          settled.get(row.id) === row.url                //   配对成立才计
          && !isBlankLink(row.url)
          && !isValidLink(row.url.trim())
        ```

        **⇒ 一条配对判据同时挡住三个历史缺陷**：

        | 缺陷 | 为什么挡住 |
        |---|---|
        | 计数**抢先** | 新值未被判定过 ⇒ 配对不成立 ⇒ 不计 |
        | 计数**滞后** | 清空 ⇒ 立即不成立 ⇒ **当拍出局** |
        | 两提示**差一轮渲染** | 两者都渲染期推导 ⇒ 天然同拍 |

        **`settled` 必须按 id 键** —— 按下标会在删除后读到别的行的结论，
        即设计变更 2 修掉的那个错配。**设计变更 2 是本变更的前提。**

        ##### 行为对照

        | 动作 | 改前 | 改后 | 业界 |
        |---|---|---|---|
        | 清空一行 | ⓘ 转圈 500ms → 无 | **当帧无标记** | reward early ✅ |
        | 清空（头行计数） | 500ms 后 −1 | **当帧 −1** | ✅ |
        | 清空（空行提示） | 500ms 后 +1 | **当帧 +1** | 空值不判定 ✅ |
        | 输入内容 | 转圈 | 转圈（不变） | punish late ✅ |
        | 输入（头行计数） | **保持旧数 500ms** | **当帧移出**，落定后按结论归位 | ✅ |
        | 新增行 | 不转圈、立即计入空行 | 同（不变） | ✅ |
        | 删除行 | 立即 | 同（不变） | ✅ |
        | 打开对话框 | 转圈 500ms | 同（不变） | blur/late ✅ |

        **反转的既往前决定**（必须记录，因为是用户当时的明确选择）：

        | 原决定 | 新模型 | 理由 |
        |---|---|---|
        | 「不更新，保持旧数字」（hold） | **整个删除** | 有配对后没有陈旧数字可保持；持有等于描述用户已替换掉的值 |
        | 空行提示随判定延迟 | **改回即时** | 空是事实；为"与判定同步"而延迟一个事实是本末倒置 |
        | 「空/通过/不通过共用一次 0.5s 防抖」（设计变更 1 决策 1） | **反转** | 三者性质不同，共用时钟是根因 |

        **保留不变**：决策 2（聚焦不重跑）、决策 3（打开时校验）、决策 4（新增不转圈）、
        决策 5（新增立即计入）、决策 6（`LinkBlock` 同生命周期）、决策 7（绿勾规则）、
        设计变更 2（稳定 id）。**唯一保留的偏离**：用固定 500ms 防抖而非业界标准的 blur
        —— 业界说 "late" 是下限不是上限，不违反，但不是标准做法。

        ##### 净简化

        | 删除 | 换成 |
        |---|---|
        | `headerShouldWait` 整个函数（14 行） | |
        | `useLinkCheck` 的 `edited` ref + `onEdit` 返回值 | |
        | `useSettledLinks` 的 `held` / `null` 三态 / 渲染期判据（~15 行） | `useSettledUrls`（~20 行） |
        | `LinkBlock` 的 `urls` memo | 两个渲染期派生 |
        | **合计：~40 行机制** | **~25 行** |

        **`isBlankLink` 提取到 `protocol.ts`** —— 让 `nonBlankLinks`（存储侧）、
        `countBlankLinks`（事实层）、`useLinkCheck`（行内）**共用同一个判据**，
        三者不可能对"空"给出不同答案。**判据唯一化后，`trim() === ''` 全仓库只剩一处。**

        ##### 🔴 实施中自己引入并修掉的回归

        **`enabled=false` 时永远转圈**：推导写成 `isBlankLink(value) ? 'idle' : ...`，
        开关关闭时 effect 把 `verdict` 清空，非空行于是落到 `'checking'` —— **永不落定的转圈**。
        旧代码在 effect 里 `setState('idle')` 覆盖了它，改成渲染期推导后这个覆盖消失了。
        **由既有断言 `8) 关掉后不出标记 — checking` 当场抓住。**
        修法：推导里也判 `!enabled`（注释写明不是冗余）。
        **这是"把状态改成推导"这一类改动的典型风险 —— 原先靠 effect 兜住的边界要重新显式表达。**

        ##### 验证

        | | |
        |---|---|
        | `probe-project-links.mjs` | **99 PASS / 0 FAIL**（86 → 99） |
        | `pnpm check` | **718 PASS / 0 FAIL / 退出码 0** |
        | 既有断言 | 5 条**按预期翻转**，其余全部继续通过 |

        **翻转的 5 条**（旧断言测的正是本次要改掉的行为）：

        | 旧断言 | 新断言 |
        |---|---|
        | `7c) 输入后 0.5s 内提示保持（不闪）` | 输入后空行提示**立即**消失 |
        | `7c) 清空后 0.5s 内提示不出现` | 清空后空行提示**立即**出现 |
        | `7c) 清空后行内在转圈` | 清空后行内**不**转圈 |
        | `7e) 转圈期间头行不抢先报新数`（期望保持 2） | 编辑中的行**立即移出**计数（2 → 1） |
        | `7f) 清空后行内在转圈（空是被编辑出来的，要判定）` | 清空后**不**转圈 |

        **新增 7o（13 条断言）** —— 钉住「同一帧」：

        逐帧记录器扩展为**每帧同时带两个提示**，于是"三个消费者同拍"变成可测而非推断
        （两次 `evaluate` 调用会跨过 commit，恰好掩盖要测的那种不一致）。

        ```
        清空逐帧:
          t:0    {"marks":["invalid","invalid"],"invalid":"2 条链接未通过校验","blank":null}
          t:933  {"marks":["none","invalid"],   "invalid":"1 条链接未通过校验","blank":"1 行为空，保存时忽略"}
        ```
        ⇒ **一帧之内**：行内标记消失 + 计数 2→1 + 空行提示出现，**且全程无一行转圈**。

        **反向对照（两向，全部命中）**：

        | 哨兵 | 失败项 | 关键报错 |
        |---|---|---|
        | 空值也走判定层（退回单层） | **6 条** | `7o) 清空全程没有任何一行转圈` — 逐帧显示 `t:921` 三消费者同拍后 **`t:938` 行内又变 checking**：单层模型下空值也要转圈 |
        | 去掉配对判据 | **2 条** | `7o) 输入当拍：该行移出计数` — `"2 条链接未通过校验"`（**正是"抢先"**） |

        **反向对照 2 的一个发现**：`7e` **没有**失败，因为它把行编辑成**合法**值 ——
        即使缺配对，用新值算也恰好得"合法"。而 `7o` 把行编辑成**不合规**值就暴露了
        （旧值不合规 + 新值也不合规 ⇒ 缺配对时会把新值算成不合规，抢先报数）。
        **两条互补，7o 是必需的。**

        #### 结案（2026-10-09，用户：「z6 就这样吧，暂时结案 z6」）

        **功能状态**：关联链接（登记 / 编辑 / 注入）已实施并全绿。

        | 验收 | 结果 |
        |---|---|
        | `pnpm check` | **718 PASS / 0 FAIL / 退出码 0** |
        | `probe-project-links.mjs` | **99 PASS / 0 FAIL** |
        | 数据形状 | `links: z.array(z.string()).default([])`，**每条只存 URL** |
        | 版本 | **未 bump**（`single` 布局的硬约束，已守住） |

        **本项目期间共修掉 10 个真缺陷**（全部有实测证据与反向对照）：
        计数抢先 · 计数滞后 · 两提示差一轮渲染 · 跨对话框泄漏 · 删除致他人重校验 ·
        删除结论错配（17ms）· 空值被并入判定时钟 · 提示随判定延迟 · 头行持陈旧数字 ·
        `enabled` 关闭时永不落定的转圈。

        **三次设计变更**（均记录在案）：
        1. **校验时间线统一**（2026-10-08）—— 后由设计变更 3 部分反转；
        2. **行身份用稳定 id**（2026-10-08）—— 治本 `key={index}` 与 `value` 的身份错配；
        3. **三层模型**（2026-10-09）—— 事实即时 / 判定延迟 / 纠正自动，**是设计变更 1 的反转与终点**。

        **暂时性说明**：本次结案为**功能结案**，不代表设计冻结。
        已知可继续打磨、但**用户明确不再追**的一点：判定层的触发用**固定 500ms 防抖**
        而非业界主流的 `onBlur` / `onTouched`。这不违反业界（Smashing 引用的原 Medium 文
        即建议"短暂无交互后"，且有来源主张过），但**不是主流库的默认**。
        我们与业界标准的**前提差异**是：标准模式假设"填完一行就走"（填表），
        而本功能是"盯着一个已存在的值改"（修列表），没有那个自然节点。
        ⇒ **保留现状**，理由已在偏离 #16 记录。

        #### 未决（无）
  - [ ] **Z-7 项目行显示会话数**（2026-10-07 用户提出）
        **要做的**：项目行上显示该项目的会话数。
        **已核实的前提**：
        - **数据已经算好了，渲染层零成本**：`GroupNode.sessionCount`
          （`src/vendored/client/tree.ts:170`）在 `:642` 由 `g.sessions.length` 赋值。
        - **渲染层目前完全没用它** —— 全仓库只有"定义"与"赋值"两处，
          **没有任何读取点**。
        - **官方也不显示**：上游 `packages/client/ui-workspace/src/client/tree.ts`
          同样只有 78（定义）与 459（赋值）两处，**渲染层从不引用**。
          ⇒ 这个字段是**官方预留但未使用**的，我们 vendored 时原样带了过来。
        **⇒ 因此这是"官方没有的行为"，需要权衡**：
        - 与 §0 的总原则**"界面与官方 1:1"** 有张力——行上多一个数字就是可见差异。
          参照 X-1（hover 卡显示项目）的判例：那条因"分组视图里已肉眼可见"
          被判为**未做**；会话数**不是**肉眼可见的，所以理由不同，可以单独判断。
        **要定的**：
        - **诚实性**：`sessionCount` 是 `g.sessions.length`，即**已加载的可见会话**。
          它是否等于用户理解的"这个项目的会话总数"？（已归档、未加载的算不算？）
          若不等，显示一个会让人误解的数字比不显示更糟。
        - **位置**：行标题右侧？与「未分组」桶一致？折叠时也显示吗？
        - **形态**：裸数字，还是 `(3)` / 徽标？零会话时显示 `0` 还是隐藏？
        - **未分组桶**是否同样显示。
        - 与 `containsCurrent`（当前会话所在组的染色）在视觉上会不会打架。
        **未动代码。**
  - [ ] **Z-8 相关目录 / 关联链接支持备注**（2026-10-07 用户提出）
        **与 Z-6 是同一批改动**：两者都是给项目的列表字段附加一个说明性字段，
        字段形状、兼容约束、实现路径完全同构。
        ⚠️ **措辞更正（2026-10-09，Z-6 结案时）**：本条原写「应**与 Z-6 一起定、一起做**」
        且「与 Z-6 **直接耦合，必须先理清**」——**该耦合已经解开**。
        Z-6 已按 `links: string[]`（每条**只存 URL**）**落定并结案**，
        所以不再是"要么连 Z-6 一起改形状、要么分两期"的两难，而是：
        **备注明确作为第二期**，`string[]` → `{ url, note }[]` 是一次**独立的形状变更**，
        由本条自行承担（用户 2026-10-08 亦已表态 Z-8「先不做」）。
        当前已知范围：
        - `directories` 每项加备注（`string[]` → `{ path, note }[]`）
        - `links` 每项加备注（`string[]` → `{ url, note }[]`）
        **目标**：给项目的「相关目录」和「关联链接」各加一条**备注 / 注释**。
        **Z-6 结案后本条要自己承担的部分**：
        - `directories` 现为 `string[]`，加备注后同样要变 `{ path, note }[]`，
          于是**同样触到两条硬约束**（同 Z-6）：`.default([])` 的兼容性刚需，
          以及 **`single` 布局不允许 bump version**。
        - `links` 的 `string[]` → `{ url, note }[]` 是**第二次**形状变更，
          与 Z-6 那次（`undefined` → `[]`）不同：这次是**已有数据换类型**，
          迁移必须让旧的裸字符串被读成 `{ url, note: '' }`，**且不能 bump version**
          ⇒ 需先验证 zod schema 能否靠 union/coerce 在**不删数据**的前提下做到。
        **要定的**：
        - 备注的编辑入口（对话框行内输入 / hover 卡 / 展开区）
        - 注入侧是否带上备注（带上则每个目录、每条链接各多一行，语域变化）
        - 是否必填、空备注显示与否
        - 与文档的关系：`PROJECT-SPEC.md` 已经在叙述层记这些信息，需说清分工
        - **迁移**：已存的 `string[]` 记录要能被读成 `{ …, note: '' }`，且
          `single` 布局不能 bump version ⇒ 只能靠 `.default([])` +
          union/coerce，需先验证 schema 能否在**不删数据**的前提下做到
        **未定，未动代码。**
  - [x] **Z-9 详情页展示"当前注入文案"** ✅ **已实施（2026-10-09）**（2026-10-07 用户提出）

        > ## ⚠️ 已暂时回滚（2026-10-12，用户要求「暂时拿掉」）
        >
        > **注入预览面板不在当前代码里。** 本节以下全部内容是**设计记录**，记录当时怎么设计、
        > 怎么验证、踩过哪些坑；它**描述的不是当前实现**。
        >
        > **本次回滚方式（方案二：只删预览，保留无关变更）**：
        >
        > | 处理 | 内容 |
        > |---|---|
        > | **删除** | `injection-panel.tsx` / `injection-preview.ts` 两个文件；`grouping.ts` 的 locale 座位（`installLocaleService` / `clientInjectionLocale`）；`index.ts` 的 5 处接线；`settings-locales.ts` 的 22 个文案键；`settings-card.module.css` 的面板样式段；探针的 `7)` / `7b)` 两组断言 |
        > | **保留** | **「开启http(s)://校验」开关移位** —— 它是 Z-9 期间**独立**的一个决定（不依赖预览），探针里留下 `6b)` 断言守着它 |
        > | **保留** | **本节的文档**（用户要求）、`Z-13`（项目嵌套待办，完全独立）、探针定位器的既有缺陷修复 |
        >
        > **逐文件核对**：`grouping.ts` / `index.ts` / `settings-locales.ts` / `settings-card.module.css`
        > 与本功能之前的基线（标签 **`pre-injection-preview`**）**逐字节一致**；
        > `settings-card.tsx` 相对该基线**只剩校验开关移位**这一处差异。
        >
        > **恢复方式**：`git checkout scheme-C -- <那些文件>` 可取回 C 形态，
        > 或 `git checkout pre-injection-preview -- src/` 取回无预览的基线。
        > 相关标签：`pre-injection-preview`（本节功能的起点）、`scheme-C` / `scheme-B`（试过的两种面板形态）、
        > `rhythm-fixed`（间距修复，随面板一起回滚）。
        >
        > **以下为设计记录，保留原文。**

        **目标**：在本插件的插件详情页（设置卡所在页）显示**模型实际会收到的注入文本**。

        #### 一、位置（两处定案）

        1. **校验开关移到「创建项目时开启会话」之后**（用户 2026-10-09 选 B）。
           理由：它是这张卡里**唯一不依赖任何别的设置**的项，却排在一条四行的依赖链
           （注入信息 → 文档 → 规范 → 每项目规范）之后，读起来像那条链的最后一环。
        2. **展示区在文档规范组下方**，独立成区。

        #### 二、展示区 = 主展示 + 分块差分

        | 部分 | 内容 | 折叠 |
        |---|---|---|
        | **主展示** | 按开关的**最大注入** | **常驻，不可折叠**（用户 2026-10-09：「主不能折叠，常驻」）|
        | **分块差分** | 按段分组的各形态 | **默认全部折叠** |

        #### 三、核心决策：由真实渲染器派生，不需要 Remote

        **全部文本来自 `renderProjectInjection()`**（`src/injection.ts`），即 Host 在请求时调用的
        **同一个纯函数**。手写一份 mock 就是第二个描述，会与第一个漂移 —— 而这个面板唯一要回答的
        问题正是"模型到底读到了什么"。

        **⇒ 因此不需要 Remote**：面板展示的是注入的**形状**，每个值都是占位符，
        不依赖任何项目、会话或 Host。纯函数在浏览器里直接可调。

        **已实测的三条前提**：
        - **客户端可以引入 `injection.ts`**：`tsdown.config.ts:152` 对**非** `@deepseek-ai/` 的
          导入返回 `null`（不受纯度门禁管辖）；且**已有先例**（`projects.ts:59` 值导入 `protocol.ts`）。
        - **zod 不会被拉进客户端 bundle**：`injection.ts`（`:48`）与 `protocol.ts`（`:15`）
          对 `spec.ts` 都是 **`import type`**，运行时擦除。**实测 `lib/client.js`**：
          `require` 列表里没有 zod / storage-domain，无 `ZodError` / `safeParse` 痕迹
          （文件里那处 `zod` 字样出现在一条**注释**中）。
        - **不需要哨兵替换层**：渲染器把值**原样**拼入
          （`Relevant directory: ${directories[0]}`、`project name "${project.title}"`），
          所以**直接把占位符当值传进去**即可。原方案里的"哨兵 → 渲染 → 替换"整层被删除。

        #### 四、占位符规则（用户两轮修正的产物）

        **只有「随项目/会话变化」的值才占位；写死在源码里的固定文本原样渲染。**

        | 占位 | 原样保留（常量） |
        |---|---|
        | `"[项目名称]"` | `"Ungrouped"` |
        | `[目录 N]` | `DIRECTORY_UNSET` 那句 |
        | `[链接 N]` | 规范为 none 的那句 |
        | `[文档路径]`（`documentPath()` 派生）| 重写流程路径（`REWRITE_FLOW_PATH` 包内常量）|
        | `[规范路径]` | |

        **符号用 `[]`**，且**只替换值本身，周围引号原样保留**：
        `project name "名称"` → `project name "[项目名称]"`。

        **🔴 两处我自己犯的错（都由用户指出）**：
        1. **丢了引号** —— 我写成 `project name [你设置的项目名]`，而真实是
           `project name "名称"`。引号是**语法的一部分**，标明"这里是一个整体值"。
           我在自己举的第一个例子上就改错了结构。
        2. **`"Ungrouped"` 被加了方括号** —— 用户问「未分组为什么要加方括号？」。
           它是 `injection.ts:276` **硬编码的常量**，不是用户数据；加括号等于宣称它会变。
           **这一问让我发现原表 11 项里有 4 项根本不是"值"**（`"Ungrouped"`、`DIRECTORY_UNSET`、
           规范 none 那句、重写流程路径），只有 **5 项**才是真正该占位的。

        **⇒ 判据由此确立：占位的依据是「会变」，不是「我编不出真值」。**
        我原来把"凡是我编不出真值的地方"都塞了占位符，那是错的。

        #### 五、分块差分：按段分组（用户定）

        | 组 | 形态 | 门控 |
        |---|---|---|
        | **owning project** | 有项目 / 未分组 | `注入项目信息` |
        | **relevant directories** | 0 条 / 1 条（单数）/ ≥2 条（复数）| + 有项目 |
        | **related links** | 0 条 / 1 条 / ≥2 条 | + 有项目 |
        | **work document** | 有规范 / 无规范 / **规范漂移** | + `注入项目文档` + 有项目 |

        **按段而非平铺**，因为块的构造就是一段一个函数，且读者是带着"我这条链接会怎样"来的。

        **两个列表段逐态对齐**（2026-10-13 修正）：目录与链接都是**空/一/多三态**，
        空态各自输出一句未设置（`DIRECTORY_UNSET` / `LINK_UNSET`），声明段都公告。
        这是用户 2026-10-06 的原始定案（「空或一个就单数，多个就复数」＋
        「不存在四段都为空……只是没有目录，没有链接没有文档」）。

        > ⚠️ **订正记录**：2026-10-08 的"空值过滤"修复中，我把「过滤空值」实现成了
        > **「过滤后为空 ⇒ 整段不渲染」**，并在代码注释里把随之而来的不对称论证成
        > **"刻意设计"**（"没有链接是项目的常态"）。该论证的前提是错的 ——
        > 目录与链接在「编辑项目」对话框里**是两个对等的字段**。本次按原始定案改回三态，
        > 并删除了那段错误注释。原"不对称是差分区存在的理由"一说随之作废。

        **漂移块归差分，不进主展示**（用户确认）：它由**运行时 SHA 比对**决定
        （`index.ts:765` → `documentInjection`），开关全开也**未必出现**，
        放进"最大注入"会让用户以为自己的设置会产生那一大段。

        #### 六、locale：唯一新增的基础设施

        漂移块的问题文案**按语言变化**，需知道当前 locale。实测 `ctx.locale` 已具备
        `HostObservable` 形状（`getSnapshot()` + `subscribe()`），但**它不在项目模型里**，
        所以不能走 `pendingSeat` —— 新增 `installLocaleService()` + `clientInjectionLocale`。

        **⚠️ 归一化规则与 Host 不同，这是刻意的**：Host 读的是**存储的 preference**（`'en'`），
        浏览器快照给的是**已解析的 BCP 47 id**（可能是 `'en-US'`），所以客户端用
        `active.startsWith('en')` 而 Host 用 `=== 'en'`。

        #### 七、验证

        | | |
        |---|---|
        | `pnpm check` | **718 PASS / 0 FAIL / 退出码 0** |
        | `probe-settings-card.mjs` | **31 PASS / 0 FAIL**（新增 section 7 共 15 条）|
        | `probe-settings-injection-switches.mjs` | **15 PASS / 0 FAIL**（顺序变化未影响它）|
        | `verify:locales` | 通过（新键 22 个，zh/en 双语平衡）|

        **反向对照（两向，全部命中）**：

        | 哨兵 | 失败项 | 关键报错 |
        |---|---|---|
        | 主展示改成可折叠 | **5 条** | `7) 主展示含项目名占位符` — detail 显示折叠后只剩标题 |
        | 常量 `"Ungrouped"` 加方括号 | **1 条** | `7) 未分组一项保留真实常量文本` |

        **🔴 我自己引入并修掉的两处缺陷**：
        1. **探针定位器失效（既有缺陷，非本次引入）**：`probe-settings-card.mjs` 用
           `text=dsh-project-groups` 找插件条目，而 Plugins 页**显示本地化名「项目分组」**
           ⇒ **每次运行都超时**。**已用 git stash 验证改动前同样失败**，
           确证与 Z-9 无关。修法：改用
           `[data-plugin-id]` 或本地化名（`.or()`）。
        2. **断言查了一个默认不可见的元素**：`7) 常量文本没有被加方括号` 查的是
           `"Ungrouped"`，而它**只存在于默认折叠的差分里** ⇒ **反向对照 2 未能命中**（31 PASS）。
           修法：**展开 owning 组后**再断言。**这与本项目历次盲区同型：测了自己写的那条路径，
           没测"要断言的东西此刻是否可见"。**

        #### 八、附：`verify:locales` 的键格式约束（探查所得）

        `settings-locales.ts` 的键正则是 `^\s{2}([A-Za-z][A-Za-z0-9_]*)\s*:`（`verify-locales.mjs:77`），
        **不认带点的键**。故方案原拟的模板键 `t('diff.owning.title')` 不可行 ——
        带点键会被**静默跳过**（既不报错也不计入），于是它们既躲过死键检查、也躲过键位平衡检查。
        **改用扁平 camelCase 键**（`diffOwningTitle` 等），静态可检且 `t()` 有类型。

        #### 九、面板的纵向间距规格（2026-10-09 补，**必须遵守**）

        > ✅ **已在基线上重新实施（2026-10-10）**。
        > 本节曾一度标为"已回滚"，因为 2026-10-10 的整体回滚把间距修复一起退掉了；
        > 随后按用户要求「下一步是单独的间隙修复」在原基线上**重新实施并实测通过**。
        > 现在是**当前代码的规格**，且已由 `probe-settings-card.mjs` 的 5 条几何断言守住。
        > （方案 B/C 仍是回滚状态：`scheme-B` / `scheme-C` 两个标签保留其形态。）

        **来源**：用户报「标题和上方主注入的内容挤到一起、可展开部分上下宽度不均」。
        实测（截图像素测量，折叠态）：分组行文字**上方 14px、下方 20px**；末行下方 **28px**。
        **根因**：`.injectionPanel` 的 `gap: 8px` 对**每个**子元素生效，而**分组行也是子元素**
        ⇒ 每行下方被多加一份 8px（行自身已有 `padding: 8px 0`）：
        `文字下方 = 8(padding) + 8(gap) = 16`，而 `文字上方 = 8`。末行无 gap，
        但面板 `padding-bottom: 16` 接上 ⇒ `8 + 16 = 24`，又与前两者都不同。

        **定案：面板不带 `gap`，节奏全部由显式 `margin` / `padding` 给出。**

        | 位置 | 规格 | 实现 |
        |---|---|---|
        | 面板上边 → 第一个标题 | **16px** | `.injectionPanel { padding: 16px 0 8px }` |
        | 标题 → 主展示块 | **8px** | `.injectionMain { margin-top: 8px }`（原靠 panel gap） |
        | 说明文字 → 「各状态下的分块差异」 | **16px** | `.injectionDiffTitle { margin-top: 16px }`（原 `margin-top:4px` + gap = **12px**，比上一节还小） |
        | 分组标题 → 第一条线 | **8px** | `.injectionDiffTitle + .injectionDiff { margin-top: 8px }` |
        | 线 → 行标签 / 行标签 → 下一条线 | **各 8px（必须相等）** | `.injectionDiffToggle { padding: 8px 0 }` —— **只有这一份** |
        | 末行标签 → 面板下边 | **16px** | 行自身 padding 8 + `.injectionPanel` 的 `padding-bottom: 8` |
        | 行间 | **0** | 面板**无** `gap` |

        **⚠️ 禁止**：给 `.injectionPanel` 恢复 `gap`（它落在行的**下方而不上方**，必然再次造成
        上下不等）；给分组行外加 `margin-top`（会与面板顶部留白重复计）。

        ##### 实施与实测（2026-10-10，在基线上重新实施）

        **改动面**：`src/client/settings-card.module.css` **一个文件、5 处**（`injectionPanel`
        去掉 `gap` 且 `padding: 16px 0 8px`；`injectionMain` 加 `margin-top: 8px`；
        `injectionDiffTitle` 的 `margin-top: 4px → 16px`；新增
        `.injectionDiffTitle + .injectionDiff { margin-top: 8px }`）。**TSX 与注入文本零改动。**

        **实测（真实 DSH，折叠态，`Range` 量文字墨迹）**：

        | 位置 | 修前 | **修后** |
        |---|---|---|
        | 线上 → 标签 | 10px | **10px** |
        | **标签 → 下一条线** | **18px** | **10px** ✅ 对称 |
        | 主展示 → 第二个标题 | 12px | **16px** ✅ |
        | **末行标签 → 面板下沿** | **27px** | **19px** ✅ |
        | 面板 `row-gap` | `8px` | **`normal`** ✅ |

        **⚠️ 只撤 `gap` 不够**：面板 `padding-bottom` 若保持 16px，末行仍是 **27px**
        （实测验证过 `16/16` 与 `16/8` 两种），因为 `gap` 消失后末行下方只剩它自己的 8px。
        **底部必须同时改成 8px**，末行才与行间一致。

        **护栏**：`probe-settings-card.mjs` 新增 **5 条几何断言**（`7b)` 一组）：

        | # | 断言 |
        |---|---|
        | 1 | 测量前所有分组已收起（否则量到的是展开体）|
        | 2 | 面板无 `gap`（`row-gap === 'normal'`）|
        | 3 | **每一行**标签到上下两条线等距（±1px）|
        | 4 | 末行 → 面板下沿 == 行内间距 + 底部留白（±1px）|
        | 5 | 两个标题上方留白一致（各 16px）|

        **⚠️ 测量口径：必须量「文字墨迹」**（`Range.selectNodeContents`），不是按钮盒 ——
        按钮盒含 padding，量到的就是 padding 本身，**永远看不出不对称**。

        **⚠️ 必须先收起所有分组**：展开体夹在标签与下一条线之间，展开着量会得到 202px / 281px
        而不是 10px（本次实测踩到）。且 `click()` 在同一个 `evaluate` 内只排队不重渲染，
        所以**收起与确认要分两次读**（否则读回旧状态、得到假数字）。

        **反向对照（命中 4 条）**：把 `gap: 8px` 加回去 ⇒ `panelGap:"8px"`、
        `under:18`、`lastUnder:27`、`title2Air:24` —— **精确回到修前的特征值**。

        #### 未决（无）

        #### 十、差分区"整体成一块"的候选方案（2026-10-09 记录，**未实施，逐个试**）

        > ⚠️ **已回滚到基线（2026-10-10）**：本节记录的是当时试过的方案，**当前代码不采用**。
        > 候选 M/O/A/B/C 全部保留为**设计记录**（用户要求"全部记录，然后一个个试"），
        > 但试过的两个形态（C、B）已回滚，当前代码是**基线**形态
        > （**加上第九节已重新实施的间距修复** —— 那是独立的一步，与本节方案无关）。
        > 各自的可达点：`scheme-C`（= `587f0a3`）/ `scheme-B`（= `91f07b9`）；
        > 间距修复前的原基线与修复后的当前代码分别见 `baseline-gap-unfixed` 与 HEAD。

        **背景**：第九节的间距修复**已生效**（实测中间行 `上14 / 下11~13`，修前是 `上14 / 下20`），
        但用户指出**两个仍然成立**的问题，并给出自己的方案。

        **问题 1：差分标题与上方内容"堆在一起"，产生误判。**
        实测（2026-10-09 23:35 截图，面板 x=620..1578）：

        ```
        说明文字「[方括号]内是你设置的内容…」   y=530-541
                   ↕ 8px
        「各状态下的分块差异」                    y=566-577
                   ↕ 106px（中间夹着面板底边与主注入块收尾）
        ────────────────────────────────── 线 y=683
        ```
        ⇒ 标题**上方只有 8px，下方到它自己管的分组却有 106px**。**不对称**：
        标题离"上一段内容"太近、离"自己管的分组"太远 ⇒ **读起来像上一段的尾巴，而不是下一段的头**。

        **问题 2：末尾多一条"假行线" + 末行多 8px。**
        实测全宽线位置：`683 / 756 / 793 / 875`。

        | 线 | 含义 |
        |---|---|
        | ①②③ | 三个分组行各自的 `border-top` |
        | **④（y=875）** | **`.injectionPanel` 自己的 `border-bottom`** —— 与 ①②③ **同色同宽**，看起来像"第 4 个空分组" |

        末行标签（y=844-854）→ 线 ④（875）= **21px**；中间两行是 **11~13px** ⇒ **末尾多 8px**。
        **根因**：面板 `padding-bottom: 8` + 末行按钮 `padding-bottom: 8` = 16px，再叠 `border-bottom`。

        ---

        ##### 方案 M：**用户方案**（2026-10-09 提出）

        > 「在差分标题处加分割线，然后下面内部的分割线全去掉，差分整体成一块。」

        ```
        当前注入内容
        ──────────────  ← 保留（面板顶部分界）
        <project-context> …（圆角框）
        [方括号]内是…                        ← 说明
        ──────────────  ← ★ 新增：标题上方的分割线（把差分与上面切开）
        各状态下的分块差异                     ← 标题，成为"一块"的头
          ⌄ owning project 段                 ← 内部线全去掉
          ⌄ relevant directories 段
          ⌄ related links 段
        ──────────────  ← 保留：块与块的边界（面板 border-bottom）
        ```

        ---

        ##### 方案 O：**官方两种现成语言**（探查所得，`deepseek-harness` 源码）

        **O-1 `border-bottom` 语义（官方段落模板）** —— `packages/client/ui-theme/src/client/AppearanceRow.module.css`：

        ```css
        .group {
          display: flex; flex-direction: column;
          gap: 8px;                /* 标题 → 内容 8px */
          padding: 16px 0;         /* 上下各 16px */
          border-bottom: 0.5px solid var(--dsw-alias-border-l2);   /* ← 线在下！ */
        }
        ```

        **与本插件现状的关键差异**：官方 **`border-bottom`（线在段的下方）**，
        本插件 **`border-top`（线在行的上方）**。

        | | 读法 |
        |---|---|
        | 官方「线在下」 | "**这一段到此结束**" ⇒ 段落边界 |
        | 本插件「线在上」 | 被读成"**这是一个列表项**" ⇒ 列表分隔 |

        ⇒ **方案 M 想要的效果，正是官方 `border-bottom` 的语义。**

        **O-2 内容块模板（靠底色而非分割线）** —— `packages/client/ui-deliverables/src/client/PresentRow.module.css:5`：

        ```css
        .output {
          padding: 12px;
          border-radius: var(--dsw-radius-lg);
          background: var(--dsw-alias-bg-layer-1);   /* ← 靠"底色 + 圆角"区分层次 */
        }
        ```

        ⇒ **官方区分层级用"底色 + 圆角"，不是"再加一条分割线"。**

        **结论**：官方**没有**专门的"二级分区组件/类"，但这两条是可复用的既有语言。

        ---

        ##### 候选 A / B / C：去掉内部三行线之后，三个折叠行靠什么分隔？

        | 候选 | 做法 | 依赖的官方语言 | 评价 |
        |---|---|---|---|
        | **A. 纯间距** | 行间 8px，无线 | 无 | 最干净，但"可点击"的暗示变弱 |
        | **B. 悬停底色** | `hover` 时整行加 `interactive-bg-hover` | 官方列表常见做法 | 保持可点击感；改动最小 |
        | **C. 缩进 + 底色块** | 三行放进一个 `bg-layer-1` 圆角容器 | **O-2**（`.output` 式） | 最贴近官方，"整体成一块"意象最强 |

        **Lead 倾向**：**C**（最像官方、意象最强）；**B** 改动最小。

        ---

        ##### 试的顺序（用户定：**一个个试**）

        1. 先试 **方案 M**（用户自己的方案）
        2. 再逐个试 **A / B / C**
        3. 每试一个，记录：实测间距 + 用户观感判定

        | # | 方案 | 状态 | 实测 | 用户判定 |
        |---|---|---|---|---|
        | 0 | （基线：三条内线 + 面板底边线） | ✅ 已实装过 | 中间行 上14/下11~13；末行 21；假第4条线在 | 用户否决（问题1+2） |
        | 1 | **C**（底色块） | ✅ **已实现，待用户观感判定** | 见下 §十一 | 待定 |
        | 2 | **M**（标题处加线 + 内部线全去） | ⬜ 未试 | — | — |
        | 3 | **A**（纯间距） | ⬜ 未试 | — | — |
        | 4 | **B**（悬停底色） | ⬜ 未试 | — | — |

        **用户 2026-10-10 决定：先做 C**（"开始实现c"）。

        **⚠️ 每个方案要改的公共部分**（无论选哪个）：
        - 末行的"假第 4 条线"：末行 `padding-bottom` 与中间行一致（去掉末行多出的 8px）
        - 标题上下的不对称：标题上方留白 ≥ 下方留白

        **⚠️ 试之前必须注意的护栏**：`probe-settings-card.mjs` section 7 的几何断言
        （见第九节）**是针对"每行上下各 8px + 三条线"形态写的**。换成 M/A/B/C 任一形态后，
        这些断言**必然需要同步改写**——否则会出现"断言过时但仍在骗人"的假绿。
        （**本次 C 已经踩到这一点**：见 §十一 的三处断言问题。）

        #### 十一、方案 C 实施记录（2026-10-10，已实现并全绿）

        > ⚠️ **已回滚到基线（2026-10-10）**：本节记录的是当时试过的方案，**当前代码不采用**。
        > C 与 B 的实现都保留在 git 里（`scheme-C` / `scheme-B` 两个标签），
        > 本节的技术结论（`bg-layer-1` 在 light 下与背景同色、断言要钉"性质"而非"形式"）
        > **仍然有效**，是试错留下的资产。

        ##### 实施内容

        | 文件 | 改动 |
        |---|---|
        | `src/client/injection-panel.tsx` | 三个分组包进 `<div className={css.injectionDiffList}>`（+1 层 DOM） |
        | `src/client/settings-card.module.css` | 新增 `.injectionDiffList`；`.injectionDiff` 删 `border-top`、加 `radius-md`；`.injectionDiffToggle` padding `8px 0`→`8px 6px`、hover 合并为一条（background + color）；`.injectionPanel` padding 回 `16px 0`；`.injectionDiffBody` padding-bottom `12`→`8` |
        | `scripts/probe-settings-card.mjs` | 旧 3 条几何断言删除，改为 6 条（见下） |

        ##### 实测（真实 DSH，`pg-schemeC-home`，2 次运行一致）

        **38 PASS / 0 FAIL / 退出码 0 / `console errors: (none)`**

        ```
        PASS  7) 差分区是一个带底色、且与背景有色差的整块
              — {"listFill":"rgb(245, 246, 247)","backdrop":{255,255,255},"diff":27,"radius":"16px"}
        PASS  7) 差分区内部不再有分割线（只剩面板底边一条）
              — {"dividers":[],"panelDivider":true}
        PASS  7) 分组之间没有额外间隙（block 未再加 gap）      — {"panelGap":"normal","boxGaps":[0,0]}
        PASS  7) 每行标签在其按钮内上下居中（±1px）              — {"rows":[{8,8},{8,8},{8,8}]}
        PASS  7) 标题紧接底色块（8px），且面板顶部留白 16px      — {"blockGapAbove":8,"topAir":16}
        PASS  7) 分组行有悬停底色（去线后可点击性的唯一提示）    — 规则在位
        ```

        **两种主题都可见**（探针只跑 light，dark 由只读脚本补测）：

        | 主题 | listFill | backdrop | 色差 |
        |---|---|---|---|
        | light | `rgb(245,246,247)` | `rgb(255,255,255)` | **27** |
        | dark | `rgb(53,54,56)` | `rgb(21,21,23)` | **98** |

        ##### 🔴 本次自己踩到并修掉的三处（**两条真问题 + 一条假绿**）

        **① 断言口径错（假 FAIL，不是实现缺陷）**
        初版断言②用 `panel.querySelectorAll('*')` 收集"有上下边框的元素"并断言 `<= 1`，
        结果把**四边框的盒子**（`.injectionText` 内容框、`.injectionDiffList` 外框）当成分割线，
        必然 FAIL（`{"wideLines":["KApx_W_injectionText","KApx_W_injectionDiffList"]}`）。
        更根本的是：`querySelectorAll('*')` **不含 context 元素自身**，所以面板底边那条**从未被计入**——
        `<= 1` 这个配额从来就不可能对应它声称的那条线。
        **修法**：只认**单边横线**（左右边框 = 0、上/下 > 0），并**显式**量面板自身底边。
        **教训**：「有上下边框」≠「是一条分割线」；用 `querySelectorAll('*')` 量"自身"必然漏掉自己。

        **② light 主题下底色块不可见（真问题）**
        初版底色用 `bg-layer-1`，而官方 token 定义（`ui-theme/src/styles/design-platform.css`）显示：

        | 主题 | `bg-layer-1` | `bg-base` | 结果 |
        |---|---|---|---|
        | **light** | `bluish-00` = `rgb(255,255,255)` | `bluish-00` = `rgb(255,255,255)` | **同色 → 块不可见** |
        | dark | `bluish-875` = `rgb(35,35,36)` | `bluish-950` = `rgb(21,21,23)` | 有对比 |

        ⇒ **light 下"底色块"根本看不见**，方案 C 的"整体成一块"在最常用主题下失效。
        **修法**：改用官方 settings 面板表达"面板上的有色编辑区"的 token
        **`bg-module-platform`**（出处 `ui-settings-models` 的 `.editor`，注释原话
        *"a filled module on the panel, matching the settings selector fill"*）——
        light `#F9FAFB`、dark `#353638`，两主题都可见。
        **教训**：官方先例（`.guide` 用 `bg-layer-1`）**不等于**该 token 在 light 下可见；
        token 语义要看**定义**，不能只看谁用过。

        **③ 断言①假绿（"非透明"不等于"看得见"）**
        初版只排除 `rgba(0,0,0,0)`/`transparent`，于是 `rgb(255,255,255)`（白底白）**照样 PASS**。
        **修法**：改为与**最近不透明祖先**比 RGB 色差，并把 `listFill`/`backdrop`/`diff` 写进 detail。
        **教训**：断言要钉"**性质**"（可见），不是"**形式**"（非透明）。

        ##### 待用户判定

        方案 C 已实现且护栏全绿，**但用户的观感判定尚未回填**。若判定不通过，
        继续试 M / A / B（§十 的表格已备好记录位），且**每次都要同步改这批几何断言**。

        ##### 方案 B 实施记录（2026-10-10，已实现并全绿）

        **用户 2026-10-10：「实现 b 吧」。** B 与 C 的差别**只有一处**：

        | | C（`587f0a3`，tag `scheme-C`） | B（`91f07b9`） |
        |---|---|---|
        | 三个折叠行外面 | 一个填充块（`bg-module-platform` + 圆角 + 边框） | **无容器**，行直接属于面板 |
        | 静态边界 | ✅ 有 | ⚠️ **无**，靠间距分开 |
        | hover 底色 | ✅ | ✅（**唯一**可点击提示） |
        | 行间分割线 | 无 | 无 |

        **B 的取舍被明说而非隐藏**：没有容器、没有分割线，三个折叠行在光标移上去之前
        **就是三行安静的文字**。换来的是"常驻展示 + 标题"这样两段式，而不是"大框套小框"。

        **实现要点（一处易踩的坑）**：标题下方的 8px 落在**第一行的 `margin-top`**，
        **不是按钮的 `padding-top`** —— 后者会破坏"每行标签在按钮内上下居中"这条性质，
        而它正是 hover 底色与标签对齐的前提，且探针会量它。

        **验证**：`probe-settings-card.mjs` **38 PASS / 0 FAIL**；`pnpm check` **718 PASS**。

        **🔴 一次假绿（值得记）**：首次跑出 38 PASS，但**探针 home 里是一份包副本而非
        junction**，测的是旧快照。**揭穿它的是反向对照** —— 把 C 的容器加回去，
        本该失败却仍 38 PASS。修正 junction 后重跑反向对照，**命中 2 条**：

        ```
        FAIL  7) 差分区没有外层容器 — {"hasEnclosingSurface":1}
        FAIL  7) 标题与第一行相距 8px — {"headingToFirstRow":5}   ← 容器的 padding 也改了几何
        ```

        **教训**：反向对照不是额外保险，它是**唯一**能识别"测的不是目标物"的手段。
        （与 Z-9 那轮"探针按包名定位、每次超时"同型：**先确认测的是目标，再谈结果**。）

  - [ ] **Z-13 项目包含关系与子项目**（2026-10-10 用户提出）
        **用户原话**：「项目包含关系和子项目功能。」

        **要做的**：让项目可以有**父子包含关系**，形成**子项目**层级。

        #### 已核实的前提（立项时的代码事实）

        1. **渲染层已经支持任意深度** —— `WorkspaceBrowser.tsx:1621` 的
           `renderGroup(group, depth)` 已经递归：`:1639` 的
           `group.expanded ? children.map(child => renderGroup(child, depth + 1)) : []`，
           并且 `:1734` 用 `--dsh-workspace-indent: ${depth * 12}px` 做缩进。
           ⇒ **树形渲染与缩进是现成的，不用改渲染层结构。**
        2. **数据模型里没有父子字段** —— `src/spec.ts` 的 `projectRecord` 只有
           `title / directories / links / docPath / docSpec* / docSpecUsed / docSpecIgnored /
           createdAt / updatedAt`，**没有 `parentId` 一类字段**。
           ⇒ 层级关系目前**无处存放**，这是本待办的主体。
        3. **`GroupSource` → `GroupNode` 的管线假定扁平** ——
           `src/client/grouping.ts` 的 `clientGrouping` 是 `readonly GroupSource[]`，
           `tree.ts` 的 `groupBySource` 产出一个**扁平数组**再逐个转 `GroupNode`。
           ⇒ 要支持父子，这条管线需要能表达"谁是谁的子"。

        #### ⚠️ 必须守住的既有约束（与 Z-6/Z-8 同族）

        - **`.default(...)` 与"不能 bump version"**：`single` 布局在域打开时逐条校验，
          缺字段会让**整个文件打不开、连累所有项目**；而 `single` **不允许 bump version**。
          新增父子字段**必须带默认值**（"无父"是合法默认），**且不能 bump version**。
          ⚠️ 比 Z-6 更难的一点：**父子关系不能用"缺字段=无父"之外的表达**，
          否则老数据读不回来。
        - **删除语义**：删父项目时子项目怎么办？**级联删 / 提升为顶层 / 拒绝删除** ——
          三选一，且与现有的"删项目会同时删 assignments"逻辑要对齐。
        - **`projectIds` 的顺序数组**（`globalRecord.projectIds`）是**全局扁平顺序**，
          与树形层级是**两套顺序**：层级改变时全局顺序如何维护？
        - **循环引用**：父子关系必须防环（A 父 B、B 父 A；或更长的环），
          因为存储层是**用户可手改的 JSON**。

        #### 要定的

        - **深度**：只允许一层父子，还是任意深度？（渲染层支持任意深度，是数据/UI 的限制）
        - **创建入口**：在父项目行上加「新建子项目」？还是拖拽改变父子关系？
          （拖拽已有实现，`commitWorkspaceDrag` 一族可复用）
        - **注入语义**：会话属于**子项目**时，注入块要不要提及其**父项目**？
          （这会影响 `renderProjectInjection` 与 `declaredSegments`，进而影响注入文本与断言）
        - **项目行显示**（与 **Z-7**、**Z-12** 同处）：折叠的父项目要不要显示
          "其下有 N 个子项目"？（**Z-12 的"有会话在跑"聚合**与此同构，
          `g.sessions` 是否含子项目的会话需先核实）
        - **未分组桶**是否有子项目概念（应无）。
        - **文档规范与关联目录**：子项目继承父项目吗？（这会与 `perProjectDocSpec` 交互）

        **未动代码。**

  - [x] **Z-10 改注入文案：声明段（已实施，2026-10-07）**
        **不是做功能，是改文案本身** —— 用户直接给出新文本，逐字替换并同步断言。
        **本次改动（仅声明段，两处）**：

        | # | 原文 | 改动后 |
        |---|---|---|
        | 1 | `It provides context information about the session's …` | `It provides context information **set by the user** about the session's …` |
        | 2 | `… fall into a single base workspace**.** The "working directory" injected …` | `… fall into a single base workspace **—** the "working directory" injected …`（破折号后 `The` 改小写 `the`，并入同句） |

        **改动后全文（`src/injection.ts` 的 `renderDeclaration`）**：
        ```
        This section is injected by the `project-groups` plugin. It provides context information set
        by the user about the session's `owning project` `relevant directories`. Project membership is
        classified by the plugin layer; the plugin does not modify the official workspace system, so
        all projects' workspace directories fall into a single base workspace — the "working directory"
        injected in the earlier system prompt is the official base workspace directory, and has no
        substantive relation to the project this session belongs to under this plugin.
        ```
        （显示折行；实际注入仍是**单行**。）

        **中文对照**：本节由 `project-groups` 插件注入，提供**由用户设置的**关于该会话的
        「所属项目」「相关目录」的上下文信息。项目归属由插件层自行分类；该插件不修改官方
        的工作区系统，因此所有项目的工作区目录都落入同一个底层工作区**——**前面系统提示里
        注入的「工作目录」是官方底层工作区目录，与本次会话在本插件下所属的项目没有实质关系。

        **连带改动**：`scripts/verify-project-injection.mjs:55-61` 的**手写**期望文本
        （`DECLARATION_TAIL` + `decl()`，刻意不从实现推导）已同步。
        全仓库无第三份副本（已 grep 确认）。

        **本次未动**：句 3 的实质内容保留 —— 它解决"模型把工作目录当成项目"的实测歧义
        （codearts 会话因此纠结 27 个 step），只是**从独立句子并入前句**，语义未减。
        **验收**：`pnpm check` 全绿（typecheck + 全部校验脚本 + 探针）。

        **其余段落的改文案需求仍可能后续追加**（未归属/已归属/目录行/文档行/规范行/漂移段），
        改造时连同各自的**动态段名**与**漂移段逐字匹配约束**一并处理。
  - [ ] **Z-11 可编辑注入文案（做功能）**（2026-10-07 用户提出）
        **目标**：让用户**自己改写注入文案**，而不是只能开关它。
        **与 Z-9 / Z-10 的关系**：Z-10 是**我们**改文案，Z-11 是**让用户**能改；
        Z-9（能看到当前文案）是 Z-11 的前置 —— 先能看，才能改。
        **必须守住的既有约束**：
        - **`<project-context>` 框架必须保留**：模型靠它识别这一段；
          去掉框架会让注入块与官方运行时上下文混在一起。
        - **声明段（`declaredSegments`）与实际渲染的段必须一致**：
          它按"能不能渲染"动态列名（`related links` 自 Z-6 起是**真段**，
          有链接才列入，见 `src/injection.ts:317`）；
          用户改写后若声明与实际不符，就会出现"承诺了却没有"的段。
        - **变量占位**：文案里嵌着项目名、路径、文档路径、规范路径等**运行时值**，
          所以"改写"实质是**模板**，而不是一段静态文字 ⇒ 需要一套占位符语法
          （如 `{project}` / `{directories}`），并定义**未知占位符**与
          **占位符缺失**时的行为。
        - **不本地化**：注入内容刻意保持英文（用户既有决定
          "插件注入内容不做本地化，仅选项和问题本地化"），可编辑功能不应把它变成中文。
        **要定的**：
        - 存放位置（进插件自有领域，还是像规范那样作为**可上传文件**）
        - 是**整段替换**还是**只改固定句、保留自动段**（后者更安全，前者更自由）
        - 编辑面（详情页文本框 / 上传文件 / 恢复默认按钮）
        - **校验**：保存时是否强制框架与占位符合法，非法时拒绝还是警告
        - 与 `injectProjectInfo` 开关的关系：关掉开关时自定义文案是否保留
        - **恢复默认**：内置文案是包内常量，用户改写后需要一个"复原"入口
        **未定，未动代码。**
  - [ ] **Z-12 项目折叠时仍能看出「项目内有正在进行的会话」**（2026-10-09 用户提出）
        **用户原话**：「现在官方工作区文件夹收起就看不到正在进行的会话，
        要增加项目收起也能显示表达项目内有正在进行中的会话。」

        **要做的**：项目行**折叠**时，在该行上给出一个指示，表示这个项目下有会话正在运行。

        #### 已核实的前提（待办立项时的代码事实）

        1. **折叠时行数据里根本没有会话** —— 这是核心障碍。
           `tree.ts:650-656`：`sessions: expanded ? sectionMembers(...).map(sessionNode) : []`
           ⇒ **折叠状态下 `group.sessions` 是空数组**。
           所以"从现有数据里算一个运行中"**做不到**，必须在数据侧新增一个**聚合字段**
           （在 `:641-657` 那个循环里，对 `g.sessions` 求值，**不受 `expanded` 影响**）。
        2. **单个会话的运行状态已经现成**：`SessionNode.running`
           （`tree.ts:200`、`sessionNode()` 在 `:590`：`status?.running ?? s.running`）。
           聚合可以复用同一判据 ⇒ **不会出现"行内说在跑、聚合说不跑"的分歧**。
        3. **`GroupNode.sessionCount` 已是"只定义不使用"**（`tree.ts:178` 定义、`:650` 赋值，
           渲染层零读取）—— 与我们 vendored 的上游一致。
           **上游同样没有运行聚合字段**：实测上游 `ui-workspace/lib/client.js`，
           `anyRunning` / `runningSubtree` / `hasRunning` **匹配数全为 0**，
           `sessionCount` 只在 `:499` 赋值、**从不被渲染层读取**。
        4. **渲染插入点已定位**：折叠/展开按钮在 `WorkspaceBrowser.tsx:1776-1779`
           （`recordExpansion(group.key, !group.expanded)`），
           行本身通过 `renderGroup` 的 `actions`（`:1828`）接收右侧控件。
           ⇒ 指示器应挂在**行标题附近**，而不是会话列表区（那里折叠时不存在）。

        #### ⚠️ 与 §0「界面与官方 1:1」的张力（必须先定）

        这是**官方没有的行为** —— 上游既不显示运行聚合，连 `sessionCount` 都不显示。
        **参照判例**：
        - **X-1**（hover 卡显示项目）因"分组视图里已肉眼可见"被判**未做**；
        - **Z-7**（项目行显示会话数）仍在待办，理由同族。

        **Z-12 与 Z-7 的关系**：两者都要在**折叠的项目行**上加信息，
        数据来源与插入点是**同一处**。差别是**语义紧迫性**：
        「有会话在跑」是**状态**（用户需要立刻知道、可能与自己的等待有关），
        而「几个会话」是**统计** —— 前者比后者更像"该做的"。
        ⇒ **建议一起定**：要么都做，要么先做 Z-12（状态优先于统计）。

        #### 要定的

        - **形态**：项目名后的转圈点 / 呼吸点 / 数字徽标 / 名称加粗？
          **必须与现有视觉语言协调**：官方在**会话行**上已有"运行中"转圈
          （`SessionNode.running`）、"完成未读"绿点（`completed`）。
          折叠行用同类符号可读性最高，但**不能与会话行混淆**。
        - **口径**：只算**直接**会话，还是**含子代理**？
          （会话行已经有 `runningSubagentCount`，`tree.ts:180-202`）
          折叠行的聚合是否也要分这两层？
        - **包含哪些状态**：仅 `running`？还是也要
          **等待用户交互**（`pendingInteraction`，`tree.ts:585`）与**完成未读**（`completed`）？
          「正在进行的会话」按用户措辞**只指 running**，但等待用户输入可能更该被折叠行提示。
        - **嵌套项目**：项目可以嵌套（`renderGroup` 的 `childRows`），
          折叠的**父**项目是否要反映**子**项目里正在跑的会话？
          （`g.sessions` 是否含子项目的会话，需先核实 `groupBySource` 的归属语义）
        - **一个项目都没有会话在跑时**：什么都不显示（推断如此，但需确认不改变行高）。
        - **未分组桶**是否同样显示。
        - **性能**：聚合要在每次 `statuses` 变化时重算 —— 需确认不引入全量扫描
          （现有设计刻意让渲染层"never scans"，见 `containsCurrent` 的注释 `tree.ts:180`）。

        **未动代码。**

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
官方没有对应行为。**但注意：这不削弱"插件关了就是官方原样"的保证**——插件的注入/监听器随插件 fiber 销毁，
关掉即零残留（**2026-10-04 更正**，原表述已由 §25.1 推翻）。

**⇒ 默认不做。** 要做需要明确点头，且必须在本节登记，而不是混进待办清单。

| # | 功能 | 状态 | 为什么是额外功能 |
|---|---|---|---|
| **X-1** | **会话 hover 卡显示所属项目** | 未做 | 官方 `SessionHoverContent` 只有标题/时间/槽位/状态/归档。分组视图里项目标题就在行上方**肉眼可见** ⇒ 加了是冗余；只在扁平模式/搜索下有信息量 |
| **X-2** | **工作文档**（`docPath` 绑定 + 注入开关 + 模板/大小上限） | **已实施**（2026-10-05，见 §26） | 官方没有这个概念。**格式规范与必读来源已做**；`docPath` 留作占位字段，文档实际路径由 `documentPath()` 运行时解析（§26.1） |

> **X-2 已不是"额外功能"，而是本插件的核心能力。** 下面的原稿保留作决策记录，
> **其中若干条已被 §26 推翻**：
>
> | 原稿 | 实际（§26） |
> |---|---|
> | 走 `agent/pre-step` 注入 | 走 `systemPrompt.context()`，与官方其它 contribution 同形 |
> | 注入**文档正文** | 注入**文档路径 + 规范路径**；正文由模型自己读（I/O 留在 Host 侧可控） |
> | `docPath` 可覆盖为任意路径 | **不可自定义路径**：统一 `$DSH_HOME/project-groups/<id>.md` |
> | 包在 `<system-reminder>` 里 | 不用 XML 框架，用 `Label: value` 陈述句 |
> | 文档过大截断 | 规范**大小不限**（用户定案）；注入内容本身很小 |
> | 位置 `$DSH_HOME/projects/` | `$DSH_HOME/project-groups/` |

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

---

## 25. 项目信息注入（已定案 2026-10-04）

> 定位：**既有基础功能的一部分（开关 + 关联目录），也有额外功能（文档）**。
> 本轮只实现 **基础部分**：开关 + 关联目录 + 文档路径。**不规定文档内容格式，不注入文档正文。**

### 25.1 边界原则：与官方完全分离（用户 2026-10-04 明确）

| 状态 | 行为 |
|---|---|
| **插件开** + 会话在某项目下 | 注入（见 §25.3 文案） |
| **插件开** + 会话未分组 | **同样注入**，各字段填「无」。**不区分是否分组——统一形式注入。** |
| **插件关** | **完全不注入**，会话回到官方底层工作区，官方链条零残留 |

**"插件关就不注入"为什么天然成立**：注入逻辑注册为 Cordis effect，随插件 fiber 销毁；置 `disabled: true` 后监听器随之消失。
因此**不需要**"清除已注入内容"的逻辑，**也不与官方 AGENTS.md 机制交叉**：两者是各自独立的消息、各自的来源 kind。

> ⚠️ 早期 §24 曾写"这会削弱『插件关了就是官方原样』的保证"——**该表述不成立**，已由本节更正。

**实测：provider 求值 ≠ 消息落盘（2026-10-04）**

| 层 | 频率 |
|---|---|
| `systemPrompt.assemble()` 调用 `text()` | **每个 prepared request** |
| 提交 `user/message` | **仅当合成文本与"当前生效的那条"不同** |

依据：`agent-loop/src/runtime-context.ts` 的 `project()`：
```ts
if (this.retained?.text === snapshot) return   // ← 不变则什么都不提交
```
本机实测佐证（会话日志统计）：`session-0dab5503` **315 个 step，`runtime-context` 只落盘 1 条**；
`session-712904f9` 359 step / 2 条。⇒ 真实节奏是「**首轮 + 压缩后 + 内容变化时**」，不是每步注入。

> **对插件的影响**：无需自己实现"首轮/压缩后/变化"这套调度——官方框架自动完成。
> 插件只需保证 `text()` 每次求值返回正确文本。**这也是改动下一步即生效的原因。**

### 25.2 注入通路：`systemPrompt.context()`（user 消息），不是 section

**实测依据**（`packages/core/system-prompt/src/index.ts`）：

```ts
// assemble() 末尾：complete section 会把 sections 整个替换成只剩它一个
if (completeSection === undefined && !runtimeContextSuppressed) return transformed
return {
  sections: completeSection === undefined ? transformed.sections : [completeSection],  // ← 只剩它
  contexts: runtimeContextSuppressed ? [] : transformed.contexts,                       // ← 只看 suppressor
}
```

| 通路 | 载体 | 官方 preset 启用了 `complete` 时 |
|---|---|---|
| `systemPrompt.section()` | system prompt | ❌ **被整个丢弃**（只剩 persona 那一个） |
| `systemPrompt.context()` | user 消息（runtime-context 快照） | ⚠️ 仅当该 preset 另设 `includeRuntimeContext: false` 时被清空 |

**官方 preset 实测**（`packages/bundle/web-app/presets/`）：

- `standard` / `ptc`：persona **未设** `complete` → 两条通路都通；
- `minimal`：`complete: true` **且** `includeRuntimeContext: false` → **两条通路都不通**。

**⇒ 采用 `systemPrompt.context()`**：多数 preset 下可用，且是官方"动态运行时事实"的既定形态（sandbox / approval 政策同层）。
⇒ **已知限制**：`minimal` preset 下不注入。记入 §25.6。

**接缝写法（2026-10-04 实测，两个陷阱方向相反）**

| 服务 | 裸属性 `ctx.X` | 原因 | 正确写法 |
|---|---|---|---|
| `systemPrompt` | ❌ **编译错误** TS2339 | `@deepseek-ai/dsh-system-prompt` **不是本包依赖**，augmentation 不在作用域 | 结构类型 + `scope.get('systemPrompt')` |
| `sessions` | ❌ **运行时抛错** | 包是依赖（类型没问题），但**裸属性读受 `inject` 门禁**：`cannot get property "sessions" without inject` | `ctx.get('sessions')` |
| `storageDomain` | ✅ 可用 | 已在顶层 `inject` | 保持 |

**⇒ 两者都必须走 `ctx.get(...)`，但失败时机不同**（一个在编译期，一个在运行期）——
这正是"看起来一样的两种写法"最容易踩空的地方。

**顶层 `inject` 保持 `['storageDomain']` 不变**：顶层是**门**，写进去的服务不出现则整个插件不激活。
`systemPrompt` 用**嵌套** `ctx.inject(['systemPrompt'], cb)` 只阻塞子 fiber。

**CONTEXT_ORDERS 实测**（同文件）：官方只登记三个名字（`SANDBOX_POLICY: 110` / `APPROVAL_POLICY: 115` / `SUBAGENT_DELEGATION: 120`），
`getContextOrder()` **只接受这三个名字**；但 `context()` 本身接受**任意有限数字** order。
⇒ 插件用自己的字面量 `200`（排在 120 之后，成为该快照的末段）。**不调用 `getContextOrder`。**

**实测验证（2026-10-04，真实构建产物）**

方法：从已安装 `app.asar` 提取**真实的** `@deepseek-ai/dsh-system-prompt@0.2.0-rc.2` 构建产物
（`/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js`，连同 `dsh-scope`、`schemastery`），
配项目自身的真实 `cordis@4.0.1`，在真 `Context` 上运行。**非 mock、非推理。**

| # | 问题 | 结果 |
|---|---|---|
| Q1a | 裸属性访问（无 `inject`） | **抛错** `cannot get property "systemPrompt" without inject` |
| Q1b | `ctx.get('systemPrompt')` | ✅ **解析成功** |
| Q1c | `ctx.inject(['systemPrompt'], cb)` | ✅ **触发且属性可读** |
| Q2 | `ctx.get` 注册 与 `ctx.inject` 的 scope 注册，谁能进 `assemble()` | ✅ **两者都能**，均出现在 `assembly.contexts` |
| Q2 | order 200/201 的位置 | ✅ 排在官方 110/115/120 **之后** |
| Q3 | `text()` 是否每次 `assemble()` 重新求值 | ✅ **是**——两次 assemble 之间改底层数据，第二次立即反映 |

**⇒ 三条结论**：

1. **`system-prompt` 是 base 平面的长驻服务，不是 `pluginNavigation` 那种瞬时服务**（§14 的坑不适用）。
   `ctx.get` 与 `ctx.inject` 都能解析；**无需**为"服务晚到"做额外处理。
2. **采用 `ctx.inject(['systemPrompt'], scope => scope.systemPrompt.context(…))`**：两种写法都能进
   assembly，选它是因为**与官方 `user-approval` / `sandbox-policy` 同形**，且注册随子 fiber 自动重注册。
3. **`text()` 每次 assemble 重算 ⇒ 改归属/目录后「下一步」即生效，不需要新会话。**（§25.6 原"待验证"项已由 Q3 关闭。）

> 探针脚本为一次性验证，跑完即删；结论以本表为准。

### 25.3 注入文案（定案：2026-10-06 重写，XML 块 + 声明段）

**形态**：`<project-context>` 包裹的**多行块**，字段平铺 `Label: value`。

> **本节 2026-10-06 被重写。** 旧定案（2026-10-05）是"纯文本、无 XML 包裹、两行块"，
> 现**已废止**。改动理由见本节末尾「为什么改回 XML」，其中记录了两条**实测证据**
> （真实会话里模型为定位自己而反复侦察），而不是审美偏好。

**这一段仍合进官方同一条 runtime-context 消息**（`joinContextSections`），
不存在独立的 user 消息；`<project-context>` 是**这条消息内部的块**。

结构固定为**三段**，其中前两段恒定、第三段随数据：

```
<project-context>
① 声明段        —— 恒定（除非「段清单」变化）
② Owning project —— 永远存在（未分组也在）
③ Relevant directory(ies) —— 按数量：0 / 1 / 多
   （文档段、链接段、漂移段依次接在其后）
</project-context>
```

#### 25.3.1 声明段（恒定）

```
This section is injected by the `project-groups` plugin. It provides context
information about the session's `owning project` `relevant directories` `related links`
`work document`. Project membership is classified by the plugin layer; the plugin does
not modify the official workspace system, so all projects' workspace directories fall
into a single base workspace. The "working directory" injected in the earlier system
prompt is the official base workspace directory, and has no substantive relation to the
project this session belongs to under this plugin.
```

**逐条理由**

| 句子 | 作用 |
|---|---|
| `This section is injected by the …` | **出处**。官方那条 cwd 来自 persona 层，自定义 profile 可去掉；写明出处后，即使它不在也能指向 |
| `about the session's `owning project` `relevant directories` `related links` `work document`` | **段清单，动态裁剪**（见 25.3.4）。**平铺、无 `and`、无逗号**（用户定案）。反引号**保留**（用户定案） |
| `classified by the plugin layer … single base workspace` | 解释**为什么**目录与项目无关：是架构决定，不是巧合 |
| `The "working directory" … has no substantive relation to the project` | **核心句**。直接免除模型"调和两条互相矛盾信息"的负担 |

**为什么必须有最后那句（实测证据）**

真实会话里，模型收到 `Your working directory is …\default-workspace`（官方）
与 `Current project: dsh-project-groups`（旧插件文案）后**反复侦察**：

| 会话 | 注入 | 注入后出现"哪个项目"犹豫的 step |
|---|---|---|
| codearts | `Current project: deepseek-harness-codearts` / `Related folders: none` | **27 个** |
| minecraft | `Current project: dsh-project-groups` | **3 个** |
| a18c5dad | `none (ungrouped)` | 6 个 |
| ac2b7c25 | `none (ungrouped)` | 0 |

模型的推理原文（minecraft，`seq 102`）：

> "But which project? The runtime says "Current project: dsh-project-groups" …
> **Hmm, but the working directory is the default-workspace.** … There's ambiguity"

codearts 会话里，模型为定位自己跑了 6 条侦察命令（含 `-Recurse -Depth 6 -Filter "*codearts*"`
和翻 `project_groups.json`），**27 个 step 后才确认**自己在哪个项目。

⇒ **不是"指向不清"，而是两条无定语信息并列且无人交代关系。** 最后那句就是那句交代。

#### 25.3.2 归属段（`Owning project`）

**两种情况分开写**（用户定案，不做统一句式）：

**已归档**
```
Owning project: You are currently working on this project, project name "dsh-project-groups"
```

**未分组**
```
Owning project: This conversation does not belong to any project. It is under the "Ungrouped" category.
```

**为什么分开**：统一句式会产出
`You are currently working on this project, project name "none (ungrouped)"` ——
**自相矛盾句**（说正在处理，名字却是"无"）。且 `none (ungrouped)` 是**代码常量**
（`UNFILED_PROJECT`），不是用户起的名字，套进 `project name "…"` 会被读成
"一个叫这名字的项目"。

#### 25.3.3 目录段（按数量三态，**标签随数量变**）

| 数量 | 渲染 |
|---|---|
| 0 | `Relevant directory: The user has not yet set up the relevant directory.` |
| 1 | `Relevant directory: C:\…\dsh-project-groups` |
| ≥2 | `Relevant directories:` + 每个一行 `- <路径>`（平铺破折号，**不用 XML 列表**） |

**0 条**用用户定案的句子（`The user has not yet set up the relevant directory.`），
**不用旧的 `none`** —— 旧写法是"没有"，新写法是"用户尚未设置"，**后者更有行动指向**，
且 `yet` 准确（目录确实可后加：codearts 那次会话 12:21 创建、目录 12:36 才关联）。

**单条也用单数标签**（用户定案）：1 条走 `directory`，≥2 走 `directories`。
这与旧定案"每条都用同一列表形态"**相反**，旧理由（形状只取决于数量）**已让位于**
"标签与数量一致"的可读性。

#### 25.3.4 段清单动态裁剪（用户定案）

声明段里的清单**只列实际会注入的段**，顺序固定：

```
owning project → relevant directories → related links → work document
```

| 段 | 列出条件 | 当前状态 |
|---|---|---|
| `owning project` | **永远**（未分组也列） | ✅ |
| `relevant directories` | 已归档时**永远**（0 目录也列，因为目录段本身会渲染） | ✅ |
| `related links` | 已归档时**永远**（0 链接也列 —— 链接段同样总有内容可说） | ✅ **已实现**（Z-6 结案；2026-10-13 改为与目录同规则） |
| `work document` | `injectProjectDoc` 开 **且** 已归档 | ✅（默认关） |

**⇒ 未分组时清单只剩 `` `owning project` ``** —— 这同时回答了"清单会不会为空"：
**永不为空，最少一项**。所以不需要"全空兜底"措辞。

#### 25.3.5 文档段与漂移段（沿用 §26，措辞不变）

文档段接在目录段之后，`injectProjectDoc` **开** 且**已归档**时才出现：

```
Project document: <绝对路径> — a failed read means it has not been created yet; create it following the spec.
Project document spec: <绝对路径>
```

**规范为「无」时**（含 `custom` 但文件名未选/文件已删 ⇒ 也解析为 `none`，`spec-store.ts:203`）：

```
Project document: <路径> — a failed read means it has not been created yet; create it as the project needs.
Project document spec: none — no format is required, and the document's format is left as it is: write freely if it has no format of its own, or add to the existing format rather than reorganising the document.
```

**漂移段**（§26.4 已定案，措辞与匹配规则不变）：三段标记 + 严格逐字 + `REWRITE-FLOW.md` 路径；
**问题与选项随界面语言**，其余句子恒为英文。

#### 25.3.6 全部可通状态（枚举自代码，2026-10-06）

可达性由主机侧三个决策点决定：

```
src/index.ts:753  injectProjectInfo 关 → 返回 ""（整个插件不贡献任何东西）
src/index.ts:756  projectId → 记录；记录已删 ⇒ project undefined（悬空 assignment）
src/index.ts:759  document 仅在【有项目】且【injectProjectDoc 开】时构造
src/injection.ts:235  未分组在【第一行就 return】，文档段代码不执行
```

| # | 状态 | 可达条件 | 段结构 |
|---|---|---|---|
| **A** | 注入总开关关 | `injectProjectInfo = false` | **空字符串** |
| **B** | 未分组 | 无 assignment | ①＋②未分组句 |
| **C** | **悬空 assignment** | assignment 有值但项目已删 ⇒ 与 B **同样渲染** | ①＋②未分组句 |
| **D/E/F** | 已归档 · 1 / 0 / 多 目录 · 文档关 | `injectProjectDoc = false` | ①＋②＋③ |
| **G/H/I** | 已归档 · 1 / 0 / 多 目录 · 文档开 | `spec.mode = default` | ①＋②＋③＋文档 |
| **J/K** | 已归档 · 文档开 · **规范=无** | `mode = none`；**`custom` 未选文件也解析成 `none`** | ①＋②＋③＋文档（无规范句） |
| **L** | 已归档 · 文档开 · **漂移（zh）** | `shouldAskSpecDrift` 为真 | ①＋②＋③＋文档＋漂移 |
| **M** | 漂移 + 规范=无 | **不可达**（无规范不询问，`shouldAskSpecDrift` 首条即返回 false） | — |
| **N** | 已归档 · 文档开 · 漂移（en） | `locale = en` | 同 L，问题与选项换英文 |

**三种段结构**：未分组 = 1 段；归档＋文档关 = 3 段；归档＋文档开 = 3~5 段。

**两处曾被误列（记录以免重犯）**

- **未分组 + 文档**：**结构上不可能**。文档挂在项目记录上（`docSpecUsed`、路径按 `projectId`），
  未分组没有记录 ⇒ 主机不发、渲染器也不执行。**不是"决定不给"，是"给不了"。**
- **`custom` + 未选文件**：解析结果是 **`mode: 'none'`**，不是 `'custom'`
  （`spec-store.ts:200-204`），故与 J 共用文案，**不是独立状态**。

#### 25.3.7 为什么改回 XML（2026-10-06，推翻 2026-10-05 的决定）

旧定案的两条理由，**现都不成立**：

| 旧理由 | 为什么不成立 |
|---|---|
| "官方 24 处 `context()` 无一处用 XML" | **块的性质变了**：从 1~2 行状态句变成 4~6 行、且**含用户自定义的项目名与路径**（半可信数据）。官方给不可信/无界内容加边界（`agent-instructions` 包用户的 `AGENTS.md` 并转义闭合标签），正是同一情形 |
| "加标签会在无标签正文末尾出现孤立标签" | **块现在有明确首尾**，不是孤立标签；而且**将来要加链接、文档等段**，需要一个能容纳扩展的容器 |

**仍有代价，已接受**：`context()` 的文本由 `RuntimeContextProjection.project()` 去重，
XML 不改变这一点；但声明段会随**段清单**变化（开关文档时），
⇒ 那一次会重新注入一条上下文消息。

**测试已同步（2026-10-07）**：`no XML frame wraps the block` 已**反向**为
断言"框在首尾各出现一次"，并新增四条断言：声明段的段清单随门控变化、
**空链接项目照常声明 `related links`**（Z-6 实施后该段已成为**真段**；
⚠️ 2026-10-13 更正：本条原写"不声明"，与用户 2026-10-06 的定案相反，
现断言的是"已归档就声明"）、
**未分组即便传入 document 也不渲染文档段**
（把"结构上不可能"钉成可执行的断言），以及单目录用单数标签。

**实现态（2026-10-07）：已实施。** `src/injection.ts` 渲染本节所述形态；
`src/index.ts` **未改动**（`injectionText` 的取值与门控原本就符合）。
`verify-project-injection.mjs` 61 条、`verify-doc-spec.mjs` 80 条，全量门禁通过。

---

### 25.3-old 旧定案（2026-10-05，**已废止**，留档）

**A. 项目下，2 个关联目录**（文档行待实施）
```
Current project: dsh-project-groups
Related folders:
- C:\Users\Think\Desktop\项目\dsh-project-groups
- C:\Users\Think\Documents\deepseek-harness\default-workspace
```

**B. 项目下，1 个关联目录**
```
Current project: dsh-project-groups
Related folders:
- C:\Users\Think\Desktop\项目\dsh-project-groups
```

**C. 项目下，0 个关联目录**
```
Current project: dsh-project-groups
Related folders: none
```

**D. 未分组**（**单行**）
```
Current project: none (ungrouped)
```

**E. `injectProjectInfo` 关**（非默认）：**整块不注入**，模型侧零残留。见 §25.4 的 master-gate 规则。

**未分组单行的理由（2026-10-04 定案）**：`directories` 是 **`projectRecord` 的字段**，
未分组**没有记录**，也就**没有编辑入口**（未分组行没有可设目录的按钮）。
若在那里输出 `Related folders:`，等于**指向一个不存在的设置**，会诱导模型报告"一个可以修好的缺失"。
⇒ **未分组只报状态**；而**已归类但无目录**的项目**保留该行**——因为那个项目**确有编辑入口**，
`none` 在那里是**可执行的**状态，不是缺失。这个不对称是有意的。

**格式规则（2026-10-04 定案）**：已归类项目 ⇒ 目录 **≥1 一律用 `- ` 列表**（含单个，不留特例）；
**0 条写 `none`**；**未分组 ⇒ 只有单行**。**无 XML 包裹**（← 此条 2026-10-06 已推翻）。

### 25.4 两个开关

| 开关 | 默认 | 控制 | 性质 | 实现状态 |
|---|---|---|---|---|
| `注入项目信息` | **开** | 项目行 + 关联目录行 | 基础功能 | ✅ **已实现** |
| `注入项目文档` | **关** | 「工作文档」那一行 | **额外功能** | ✅ **已实现**（§26） |
存储：`globalRecord` 增加两个带 default 的布尔（同 `createOpensSession` 的兼容机制，**不需要 bump version**）：

```ts
injectProjectInfo: z.boolean().default(true),
injectProjectDoc: z.boolean().default(false),
```

**`injectProjectInfo` 是 master gate**（已实现）：为 `false` 时插件**整块不注入**，`injectProjectDoc` 无法"单独开启"一个信息块。

**UI 联动规则**（定案）：

```
injectProjectInfo === false
  ⇒ injectProjectDoc 的 Switch：disabled，无法点击
  ⇒ 显示说明文案：「由「注入项目信息」控制，现已关闭」
  ⇒ 存储值保留，不联动改写（重开 info 时恢复用户原选择）
```

**已实现（2026-10-04）**：`src/client/settings-card.tsx` 两个 `Switch`；
master 关闭时 `disabled` + `title` + 描述行改用 `injectDocGated` 文案。
灰显的开关**仍显示其存储的 `checked`**（不强制为 `false`）——这正是"保留选择"的可视形态。
`probe-settings-injection-switches.mjs` 用真实浏览器断言了全部 6 条。

**文档功能当前状态**：`docPath` 字段与 `injectProjectDoc` 开关**仅存储**，后端不读文件、不注入文档行
（`src/injection.ts` 的 `renderProjectInjection` 不渲染该行）。因此前端该开关**灰显**。
这与 §25.7 的范围一致：文档格式规范与正文注入属额外功能，本轮不做。

### 25.5 关联目录

- **类型**：`directories: string[]`（**可多个**）。顺序即展示顺序。
- **主次目录**：**不做，且不预留任何字段/参数**（用户 2026-10-04 明确："不要主次不要主次"）。
  即 `directories` 就是 `string[]`，**不写 `{ path, primary }`、不加 `primary` 布尔、不加排序权重**。
- **人工可改**：**能**。入口是**「编辑项目」**——即现有行菜单的「重命名」扩展为"改名 + 改目录"
  （`WorkspaceBrowser.tsx` 的 rename 对话框扩展，菜单项文案由「重命名」改为「编辑项目」）。
- **模型改**：**本轮不做，也不加开关**，**仅记入设计**（见 §25.9）。默认**只由人工修改**。

#### 25.5.1 目录选择的交互（2026-10-04 暂定）

**决定：用 `remote.directoryPicker.pick()`——操作系统原生选择器。**

**关键区分（探查后修正）**：官方「添加工作区」用的**不是**这个：

| | 路径 A：`directoryFlow` 槽位 | **路径 B：`remote.directoryPicker.pick()`** |
|---|---|---|
| 形态 | **内置浏览面板**（面包屑 + **新建文件夹**） | **OS 原生对话框**（Windows 资源管理器） |
| 提供者 | `dsh-client-ui-directory-picker-browse`（占 slot） | `dsh-host-directory-picker-native` |
| 本插件依赖 | ❌ 未依赖 | ✅ 已在 vendored inject 列表（`remote.directoryPicker`） |

`dsh-host-directory-picker-auto` 会在启动时二选一挂载。官方 `WorkspacePicker.tsx` 的注释明确说
"the occupant's own create-folder affordance already covers creating one"——**那个创建文件夹的能力属于路径 A**。

**⇒ 暂定走 B（原生对话框）**，代价是**观感与官方「添加工作区」不一致**。理由：

1. **零成本**：接缝现成，不抢 `single` 槽位、不新增依赖；
2. 关联目录多为**已存在**的目录，"新建文件夹"需求弱；
3. OS 原生对话框在 Windows 上是**用户更熟悉**的交互。

**后续可选改动（保留）**：

| 方案 | 观感 | 代价 |
|---|---|---|
| **(b)** 复用 `directoryFlow` slot + `DirectoryFlowOwnerProps` 状态机 | ✅ 与官方一致（含新建文件夹） | ⚠️ 该槽是 `kind: 'single'`，**与官方「添加工作区」冲突**；须处理 priority 或自声明子槽位 |
| **(c)** 自调 `list()` / `createDirectory()` 渲染自己的面板 | ✅ 一致，且不抢槽 | 需自行实现目录浏览器 UI，工作量最大 |

> **改到 (b)/(c) 时**：只需替换 `ProjectActions.pickDirectory` 的实现与对话框里的调用点，
> 对话框其余部分（草稿状态、去重、移除、提交）**不用动**——这是把选择交互收敛到一个动词的原因。

### 25.6 已知限制

| 限制 | 说明 |
|---|---|
| `minimal` preset 下不注入 | 该 preset 设了 `complete: true` + `includeRuntimeContext: false`，两条通路都被关。**这是官方 preset 的能力边界，不是插件缺陷。** |
| 与 sandbox/approval 合并成一条消息 | `joinContextSections` 的既定行为，无法拆成独立消息 |
| ~~会话初始化只读一次？~~ | ✅ **已实测关闭（2026-10-04）**：`text()` 每次 `assemble()` 重新求值 ⇒ **改归属/目录后下一步即生效**。见 §25.2。 |
| 跨了"已关闭且未归类"的祖先会断链 | 见 §25.6.1 的遍历规则：父会话关闭后，其**项目**仍可读，但**再往上爬**需要父的 header，读不到就停。 |

#### 25.6.1 子代理血缘（2026-10-04 实测 + 实现）

**问题**：子代理会话**不在 `assignments` 里**——只有 `session.create` 带 `workspaceId` 才挂账，
而委派子代理走 Agent 注册表。若不处理，**每个子代理都会把自己报成「未分组」**。

**官方立场（三层证据）**：

| 层 | 事实 | 出处 |
|---|---|---|
| 候选账 | 子代理**不挂账** | 本机实测：18 会话 / `workspace.json` 仅 17 条，缺的正是 `origin: "subagent"` 那条 |
| UI | 子代理**不进树**：`if (session.origin === 'subagent') return false` | `packages/client/ui-workspace/src/client/tree.ts` |
| **归属** | **靠祖先回溯**：直接未命中且是 subagent ⇒ `traceSession` 找最近已挂账祖先 | `packages/api/session-controller/src/commands.ts` 的 `forkWorkspace` |
| **归档** | **同步逐级回溯**：`ctx.sessions.get()` + visited 集合 | `packages/api/session-controller/src/archived-session-gate.ts` 的 `underArchivedSession` |

**⇒ 采用与 `underArchivedSession` 同构的同步遍历**（`src/index.ts` 的 `projectOfSession`）：

```
1. assignments.get(sessionId) 命中 → 用它（普通会话的唯一路径）
2. 未命中：读 session header；origin !== 'subagent' → 停止（fork 是独立会话）
3. 循环：parentSession → visited 防环 → assignments 命中即返回
        → 未命中则 ctx.sessions.get(parent) 取 header 继续
        → 父不在活跃集合 → 停止（无法读它自己的 parentSession）
```

**关键实测结论（推翻早期判断）**：**祖先不需要是活跃会话。**

```
父已关闭，但父在账上        → 仍能读到父的项目 ✅
父已关闭且未归类，祖父在账上 → 停止，报未分组（无法读父的 header）
环形血缘                    → 终止，报未分组 ✅
```

原因：`assignments` 是本插件**自己的持久表**，按 session id 键；而父的 id 就带在
`header.parentSession` 上。**只有"继续往上爬"才需要活的父会话。**
官方 `underArchivedSession` 同样如此（父不活跃时仍用 id 查归档集）。

**为什么不用 `forkWorkspace` 那套**：它用异步 `sessionQuery.traceSession()`，而 `text()` **必须同步**
（实测 `PromptContext.text` 的签名是 `(context) => string`，不能 await）。合并成的调用点又**每个请求都跑**。

### 25.7 本轮范围（用户 2026-10-04 最终指定）

**做**：
1. `directories` 字段（`string[]`，**无主次**）+ 两个开关（存储层）✅ 已完成
2. `systemPrompt.context()` 注入（**项目名 + 关联目录**）✅ 已完成
3. **新建项目界面**加"关联文件夹"（可加多个）——对齐 Codex 的「创建项目」对话框 ✅ 已完成
4. **「重命名」扩展为「编辑项目」**（改名 + 改目录）✅ 已完成
5. 设置卡两个 `Switch`（doc 开关灰显）✅ 已完成

**不做**：文档内容格式规范（§8 暂缓）、**文档正文注入（后端不实现）**、
**主次目录（连字段都不预留）**、**任何模型工具**（§25.9）。

**实现落点**（全部已完成）：

| 文件 | 内容 |
|---|---|
| `src/injection.ts` | **新增**：纯渲染器 `renderProjectInjection`（项目名 + 关联目录，无文档行） |
| `src/index.ts` | 接缝类型 + `ctx.inject(['systemPrompt'])` 注册 + `injectionText` + `projectOfSession` 血缘遍历 + **原子 `update`**（`rename` 已删） |
| `src/vendored/client/tree.ts` | `GroupSource.directories` + 导出 `sameStringList` |
| `src/vendored/client/rows/WorkspaceBrowser.tsx` | 新建/编辑对话框的关联文件夹；`DirectoryRows` / `DirectoryHeader` |
| `src/vendored/client/rows/Rows.tsx` | 项目行菜单文案 →「编辑项目」 |
| `src/client/settings-card.tsx` | 两个 `Switch`；`injectProjectInfo` 为 master，关时 `injectProjectDoc` 灰显 |
| `src/client/grouping.ts` | `clientInjectProjectInfo` / `clientInjectProjectDoc` 两个 observable |

**验证脚本**：

| 脚本 | 覆盖 |
|---|---|
| `verify-project-directories.mjs` | 存储层：`directories` 存量兼容、`update` 原子性、开关往返 |
| `verify-project-injection.mjs` | 渲染器 9 项 + 漂移谓词 8 项 + 血缘遍历 11 项 |
| `probe-project-directories-dialog.mjs` | **真实浏览器**：预填/删除/重开不残留/空占位（17 项） |
| `probe-project-duplicate-name.mjs` | **真实浏览器**：重名拦截（含编辑对话框） |
| `probe-settings-injection-switches.mjs` | **真实浏览器**：两开关、灰显联动、独立写入（15 项） |

> **原生目录选择器无法自动化**：`pickDirectory` 打开的是 OS 系统对话框，Playwright 驱不动。
> 探针覆盖的是它**周围**的一切（渲染、删除、预填、去重、重置、原子提交）；
> "点添加文件夹能选到目录"这一步只能人工验。已写入该探针的模块注释。

### 25.8 社区先例（文档格式规范的参考，本轮不实施）

四种成熟手法，供 §8 将来定案时取用：

| 项目 | 手法 | 可借鉴点 |
|---|---|---|
| **Cline Memory Bank** | 固定文件名 + 每个文件的**职责清单**（bullet 列"装什么"） | §8 每个 `##` 区块补"装什么" |
| **Agent Skills** | YAML frontmatter **必填字段**，机器可校验 | §8.3 要"程序读文档"，**格式必须可校验** |
| **GitHub Spec Kit** | 模板即仓库文件 + `[占位符]` + `[NEEDS CLARIFICATION: …]` | 未决项强制显式标记 |
| **Kiro / EARS** | 受限文法 `WHEN … THE SYSTEM SHALL …` | 消除歧义（表达僵硬，谨慎采用） |

**注入分法共识**（Cline 与 ZCode 各自独立验证）：**格式规范放 system，内容/索引放 user。**

### 25.9 额外功能：模型自主更改项目信息（**仅记入设计，本轮不做**）

> 用户 2026-10-04 定案：**当作额外功能，本轮不做，也不加开关。** 默认只由人工修改。
> 本节只记录设计，供将来取用。**不预留任何代码、字段或开关。**

**设想功能**：让模型能够修改项目的**名称 / 关联目录**，对应一个开关（如 `模型自主更改关联项目信息`）。

**为什么是额外功能**：官方没有"项目"概念，更遑论"模型改项目元数据"。它会让模型能够
改变**注入给它的那份上下文自身的来源**，是比注入更强的介入。

**两条候选实现路线（均未采用，仅记录）**：

| 路线 | 机制 | 评价 |
|---|---|---|
| **A. 工具** | 插件注册一个 tool，模型调用它改 domain | 需要工具注册、参数校验、审批路径；介入面最大 |
| **B. 改文档文件** | 模型编辑项目文档，插件读文件并同步回 domain | 插件**只读文件**，但引入"文档字段 ↔ domain 字段"的双向同步与权威性冲突 |

**未决问题（将来若做必须先回答）**：

1. **权威性**：domain 的 `directories` 与文档里的字段，谁是权威？两者不一致时怎么办？
2. **审批**：改项目归属类信息是否需要用户确认？（参照官方"不可逆操作两阶段确认"）
3. **可见性**：模型改了之后，侧栏如何即时反映（走现有 `follow` 流即可，但需验证）。
4. **与注入的关系**：模型能改注入源，等于能改自己的上下文——是否需要防自指约束。

---

## 26. 工作文档功能（**已实现** 2026-10-05）

§8 的那份规范设计**已废弃**，由本节取代。实现落在 `src/spec-store.ts`、`src/injection.ts`、`src/index.ts`，
规范正文在 `spec/PROJECT-SPEC.md` 与 `spec/REWRITE-FLOW.md`（随包发布）。

### 26.1 为什么规范随包、文档存 `$DSH_HOME`

| 文件 | 位置 | 理由 |
|---|---|---|
| 项目文档 | `$DSH_HOME/project-groups/<projectId>.md` | 用户要能读到；**不可自定义路径**（2026-10-05 定案） |
| 上传的规范 | `$DSH_HOME/project-groups/specs/<name>.md` | 只存**文件名**，路径由插件拼 ⇒ 换机器自动正确 |
| 内置规范 | `<插件包>/spec/*.md` | **随包**：插件升级自动生效、无"用户编辑 vs 出厂默认"冲突 |

**两条路径都在运行时解析**，源码里没有任何绝对路径字面量：

```ts
// 官方解析顺序：profileContext.home → $DSH_HOME → ~/.dsh
harnessHome(ctx) = ctx.get('profileContext')?.home ?? process.env.DSH_HOME?.trim() ?? join(homedir(), '.dsh')

// 内置规范相对本模块解析（实测 `lib/` 产物中 import.meta.url 存活）
BUILT_IN_SPEC_PATH = fileURLToPath(new URL('../spec/PROJECT-SPEC.md', import.meta.url))
```

> **`spec/` 必须留在 `package.json` 的 `files`**，否则分发时不打包，模型读不到规范。

### 26.2 规范的身份 = **内容哈希**，不是文件名

用 SHA-1（与官方 `agent-instructions/src/digest.ts` 的 `instructionContentSha1` 同算法同用途）。

**为什么不是文件名**：

| 情况 | 比文件名 | **比哈希** |
|---|---|---|
| 覆盖同名上传 | ❌ 检测不到 | ✅ 检测到 |
| **插件升级改动内置规范** | ❌ 名字恒定 | ✅ 自动检测到，重新询问 |
| 内容相同的两个文件 | 误报变化 | ✅ 视为相同 |

哈希**同步**计算并**按 `path+mtime+size` 记忆化**——因为 `PromptContext.text` 是同步的
（`system-prompt/src/index.ts:66`），且每个 prepared request 都会求值。稳态下每次注入只有一次 `statSync`。

**渲染器保持纯函数**：哈希由 `src/index.ts` 算好作为参数传入，`injection.ts` 不碰文件系统。

### 26.3 三个状态值

| 字段 | 位置 | 含义 |
|---|---|---|
| `project.docSpecUsed` | 项目记录 | 文档**当前依据**的规范哈希。**absent = 文档从未创建** ⇒ 永不触发漂移询问 |
| `project.docSpecIgnored` | 项目记录 | 用户选「长期忽略」时的哈希 ⇒ 直到规范**再变**才重新询问 |
| 当前设置 | **实时解析** | 项目覆盖（`docSpec`）?? 全局（`docSpecMode` + `docSpecFileName`） |

**判定**（每次注入）—— 实现在 `shouldAskSpecDrift`（**纯函数，可直测**）：

```
current = 当前设置解析出的规范哈希
if (current === undefined)              → 不询问（没有迁移目标：无 / 自定义但文件已删）
else if (docSpecUsed === undefined)     → 不询问（没有文档可迁移）
else if (docSpecUsed === current)       → 不询问（已对齐）
else if (docSpecIgnored === current)    → 不询问（已忽略到下次变更）
else                                    → 注入询问指令
```

> #### 第一条前提是 2026-10-06 补上的（真 bug）
>
> 早先**没有** `current === undefined` 这一条。于是「无」下 —— 当前根本没有规范 ——
> **只要文档存在就触发询问**，而那份询问把模型指向规范文件与 `REWRITE-FLOW.md`，
> 后者的第一步是"**读取本次注入给出的规范文件全文**"。**那个文件不存在。**
>
> **症状**：一条注入里同时出现「no format is required」和"去按新规范重构文档"。
> 打印全部 10 个状态时发现。
>
> **根因**：迁移需要一个**目标**，而「无」没有目标 —— 它的含义是**不更新格式**。
> 作者在写入侧（`applyDriftChoice`）**已经**防住了（`spec.sha1 === undefined` 时不记任何选择），
> **计算侧漏了同一道判断**。修法是把判断抽成 `shouldAskSpecDrift` 并补上第一条前提。
>
> **抽成纯函数的理由**：这个 bug 的**表现是"什么都没出现"**，而渲染文本的断言
> **看不出区别**（"没有漂移"和"该有漂移却没有"渲染结果相同）。只有直测谓词才能锁住它。
>
> **`docSpecUsed` 保留旧值不动**，这正是往返正确的原因：
>
> | 场景 | 结果 |
> |---|---|
> | 有规范 → `无` | 不询问，文档不动 ✅ |
> | `无` → **回到同一个**规范 | 哈希相等 ⇒ 不询问（本来就没变）✅ |
> | `无` → **换成新**规范 | 哈希不等 ⇒ 询问（这时确实要迁移）✅ |

### 26.4 注入时机（**已实测**，不是每步）

| 触发 | 说明 |
|---|---|
| 会话首轮 | 首次注入 |
| **压缩后** | 快照重建 |
| **文本变化时** | 项目名/目录/规范/开关等任何影响渲染的值变了 |

**实测依据**：`RuntimeContextProjection.project()` 在文本与保留值相同时不提交
（`agent-loop/src/runtime-context.ts:155`）；session-0dab5503 **315 steps 只落 1 条** runtime-context，
54 轮共 5 条。

**⇒ 「本次忽略」不记任何状态即可**：文本未变 ⇒ 不重新提交 ⇒ 不循环。这是官方去重机制给的，不是我们加的。

### 26.5 询问闭环：**模型问，插件旁听**

**模型是提问主体**（用户 2026-10-05 定案），插件**不加工具、不伪造消息**。

```
① 注入（漂移时）：给出问题 id / 选项 / 描述，要求**严格逐字**使用，并禁止翻译；
                  同时指明「若选第一项，完整阅读 REWRITE-FLOW.md」
② 模型调用 ask_user_question → 用户选择
③ 模型从自己的工具结果得知答案 ⇒ 知道该重写
④ 插件订阅 session/event 旁听到答案 ⇒ 自动改状态
```

**为什么不用官方投影**：`sessionProjections.stateOf(session, 'userQuestions')` 只在会话头部记录的是
**timed** schema 时才收录问题（`projection.ts:248` `if (!fold.timed …) return fold`），
而 profile 三处 `tool-ask-user` 都是默认 `legacy` 模式 ⇒ **投影恒空**。故自己订阅两个事件：

| 事件 | 取什么 |
|---|---|
| `tool/call` | `name === 'ask_user_question'` 且参数含我们的问题 id ⇒ 记下 `callId` |
| `tool/result` | 匹配 `callId` ⇒ 读答案 JSON ⇒ 精确匹配标签 |

**匹配靠标签原文**（协议只回传 `selected: string[]`，无序号、无选项 id——`types.ts:60`）。
中英标签**都**在匹配表里，所以切换语言不会让历史答案失配。**失配 ⇒ 不记任何状态**（等价「本次忽略」，唯一安全行为）。

> 官方自己的 `AskUserQuestionIntent` 注释也说明选项身份「**Named rather than positional**」——
> 用标签名而非序号，是这个协议的既定做法。

### 26.6 三个选项的语义

| 选项 | 标签（zh / en） | 记录 |
|---|---|---|
| 1 | 按新规范重写 / Rewrite for the new spec | `docSpecUsed = current` |
| 2 | 本次忽略 / Skip this time | **什么都不记** ⇒ 下一次注入点再问 |
| 3 | 在规范再次变更前忽略 / Ignore until the spec changes again | `docSpecIgnored = current` |

**选项 2 的"本次"= 本次注入点**（用户 2026-10-05 明确）。不引入会话级抑制——注入去重已保证不循环。

### 26.7 本地化：**只本地化问题与选项**

| 部分 | 语言 | 读者 |
|---|---|---|
| 框架句（`Owning project:` / `The spec … differs …` / `strictly verbatim` …） | **恒英文** | **模型** |
| `question` / `options[].label` / `options[].description` | **按 Host 语言** | **用户** |

**Host 语言来源**：`settings` 服务的 `locale` 条目 `preference`；
**未设置时兜底中文**——因为系统语言由 Desktop preload 直接交给客户端，**Host 拿不到**，
而本部署的界面是中文（实测 `settings.yaml` 不存在 ⇒ `preference` 为 `undefined`）。

**⇒ 一条注入里中英混排是有意的：两个读者，两种语言。**

### 26.8 上传：**读内容，不取路径**

用 `<input type="file">` + `File.text()`，**不读 `window.__DSH_HOST_PATHS__`**。

**理由**：那个 preload 桥只在 DSH 桌面上存在（`ui-conversation/src/client/apply.ts:96-109` 的注释：
*a served Web page has none*），而**读内容两端都可行** ⇒ 桌面与远程行为一致。

**同名不覆盖**：拒绝并提示「已存在同名规范，请换一个文件名」。理由：文件可能已被手工编辑，
静默覆盖比让用户改名更糟。**删除前**弹确认框，并显示「有 N 个项目正在使用它」
——判据是**遍历项目解析有效规范的文件名**（不是哈希），因为此刻文件还在。

### 26.9 项目级覆盖

```
globalRecord.docSpecMode:      'none' | 'default' | 'custom'   default('default')
globalRecord.docSpecFileName:  string                          default('')
globalRecord.perProjectDocSpec: boolean                         default(false)  ← 开关，默认关

projectRecord.docSpec:         'none' | 'default' | <文件名> | absent   optional()
```

**absent 表示「跟随全局」**，不是 `'none'`——两者语义不同（跟随 vs 钉死无规范）。
**`'default'` 是第四个合法值**，与 `'none'` 一样是语义值而非文件名（见 26.11 三·补之二）。
**只有开关开启时**，新建/编辑对话框才多出一行下拉栏，列表**固定**为
`跟随全局 / 无 / 默认 / 各已上传规范…`，**不随全局选择变化**（同 26.11 三·补）。

### 26.10 沙箱与写入路径

**文档与规范都由 Host 侧写**（`uploadSpec` / `deleteUploadedSpec`），不由模型或工具写。
**模型只读**。

> 附带说明（转录自实测）：`fs-sandbox` 只 override `writeText`/`editText`
> （`fs-sandbox/src/index.ts:80,101,122`），**`readText` 不受限** ⇒ 模型能读 `$DSH_HOME` 下的文档与规范。
> 写则受沙箱限制（`sandbox/src/roots.ts:52` 的可写根 = 会话工作区 + 临时目录，不含 `$DSH_HOME`），
> 故**写入必须经 Host**。本项目的设计前提是**完全权限工作流**（§1），此处仍然遵循它。

### 26.11 卡片的显示与选择器的落点（2026-10-06 定案）

#### 一、卡片显示：说明后果，用警告色

| 存储状态 | 卡片显示 | 颜色 | 高亮 |
|---|---|---|---|
| `custom` + 文件名**存在** | 文件名 | 普通 | **自定义** |
| `custom` + 文件名**不存在/空**，且高亮在**自定义** | 「当前未选择规范，将自动解析为无规范」 | **警告色** | **自定义** |
| `custom` + 文件名**不存在/空**，且高亮在**无/默认** | 「未选择」 | 普通 | 无/默认 |
| `none` | 「不更新格式：无既定格式则自由书写，有既定格式则在其基础上书写」 | 普通 | 无 |
| `default` | 「使用插件内置的规范」 | 普通 | 默认 |

**四条规则**：

1. **悬空文件的旧名不显示**——`title`（悬停提示）也一并去掉。显示一个未生效的名字会
   暗示"这个规范正在用"，而实际生效的是 `none`。
2. **高亮跟随「存储的 mode」，不跟随解析结果**。
3. **高亮只在用户点卡片时移动。**
4. **第二行说明"后果"，且颜色随高亮变化**——只有你**正在依赖**这一格时，它的空才值得警告。
   高亮在无/默认时，同样的空格子只是普通的「未选择」；在那里报警是在为一个**没人依赖**的格子报警。

> **「无」说的是 POLICY，不是"没有要求"**（2026-10-06 定案）。
>
> ```
> 无 = 不更新格式
>      ├─ 文档没有格式 → 自由书写
>      └─ 文档已有格式 → 在其基础上书写（不重组）
> ```
>
> 早先的文案是「不要求任何格式」，**可以被读成"想怎么写就怎么写"**，那就等于**授权重组**
> 一份已有结构的文档 —— 与「无」的真实含义相反。现在两句都把两种文档情况点明。
>
> **三张卡各答一个问题**：`无` 说策略（不管格式）、`默认` 说来源（内置规范）、
> `自定义` 说具体文件 —— 并列时语义整齐。

> **第 2 条是改正，不是设计。** 早先一版让高亮跟随 resolver 的返回值，于是
> **删掉一个文件就让高亮自己跳到「无」**——看起来像"删除改了设置"，而实际**一个字段都没写**。
> 用户报为「删除只是删除，怎么自动跳到无规范了」。
>
> **参照物是同一页的「底层工作区」**：选过「指定工作区」后，即使那个工作区没了，
> 高亮也**一直停在「指定工作区」**，只是把路径标成警告色——它**从不自动跳回「默认工作区」**。
> 规范卡现在与之同构。
>
> **高亮只在用户点卡片时移动。** 断言成对锁住：`3e-d`/`3e-b2` 断言"删除或空确认都不移动高亮"，
> `3e-a`/`G` 断言"点卡片才移动"。

> **第 3 条改过两次。** 最初是「尚未选择」**普通三级色**，理由是"状态不该看起来像故障"；
> 然后改成**无条件警告色**。用户最终定的是**按高亮分色**：高亮在自定义时警告，
> 否则普通「未选择」。**理由**：那一行描述的是**自定义格子的状态**，只有你**正在用这一格**
> 时它的空才值得警告；在无/默认下报警是在为一个没人依赖的格子报警。

**名字仍保留在存储里**——同名文件回来（重新上传）即自动恢复生效，只是不显示而已。

#### 二、选择器：未选中时**只给一行提示**，不再弹第二层（2026-10-06 定案）

```
未选中（列表为空 或 列表非空但没选中任何行）
   → 在对话框内显示一行警告色提示
   → 不拦截任何出口
```

**「列表为空」和「没选中任何行」是同一个语义**，但**文案分两句**（原因不同、用户能采取的行动
不同）：空列表可用「上传」解决，非空未选只需点一行。两条都说明同一个后果。

| 列表 | 提示 | `确认` |
|---|---|---|
| 空 | 「当前列表为空，使用自定义规范时将自动解析为无规范」 | 可点 |
| 非空、未选中 | 「当前未选中任何规范，使用自定义规范时将自动解析为无规范」 | 可点 |
| 非空、已选中 | 无提示 | 可点 → 用该文件 |

> **措辞是"将自动解析为无规范"，不是"确认将回退到无"。** 早先那句已经**不成立**：
> 确认**不再改变模式**（见「二·补」），空的自定义格是靠 `resolveSpec` **自己**解析成
> `none` 的。旧文案把回退归因于那次点击，是错的。

**`确认` 永不禁用**——无可用选择是**一个选择**（等于选了「无」），不是死路。

**空选择不写 `mode`**——只有点卡片才写。详见下一节。

**`确认` 永不禁用**——无可用选择是**一个选择**（等于选了「无」），不是死路。

#### 二·补：「落成无」是**解析结果**，不是**高亮移动**

**这是本节最容易看错的一处，单独写清楚。**

```
高亮     = docSpecMode 的值 = 用户点的是哪张卡。只有点卡片能改。
自定义格  = 一个文件名，或空。
```

`自定义` + 空格子在语义上**就等于「无」**——`resolveSpec` 对 `custom` + 无可读文件
**本来就返回 `none`**（`spec-store.ts:195-198`），卡片第二行那句
「当前未选择规范，将自动解析为无规范」就是在说这件事。

⇒ **所以"落成无"指的是生效的规范解析成无，不是高亮跳到「无」卡片。**

**选择器只写「自定义」格的值**（文件名或空），**它不写 `docSpecMode`**：

| 高亮 | 选择器里确认（含空选择） | 结果 |
|---|---|---|
| 无 | 写值 | 高亮仍在**无** |
| 默认 | 写值 | 高亮仍在**默认** |
| 自定义 | 写值 | 高亮仍在**自定义**（值空 ⇒ 生效解析为无） |

> **唯一的例外**是点「自定义」卡片：那张卡没有可用值时**先开选择器**，
> 确认就等于**完成这次点击** ⇒ 此时才写 `custom`。这是用户点的意图，不是选择器替他决定。

> **早先错在哪**：空选择时无条件写 `none`。于是高亮在「默认」时进 `更换…`、
> 什么都没选、按确认，**模式被改成「无」**——用户只是编辑了自定义格的值，
> 却被换了高亮。这就是"替用户做选择"。修法：`mode` 的写入点从"无条件"**
> 收紧为"仅当自定义卡片是被点击的那张"**，而不是保留一个会自行移动的分支。

> **顺带否掉的一个说法**：注释里曾写"写 `none` 才能让存储与生效一致"。**不需要**——
> `resolveSpec` 本来就会解析成 `none`。落无是**解析的自然结果**，不是靠写一个 mode 换来的。

> #### 为什么删掉了原来的二次弹窗
>
> 旧版在**两个出口**都弹一层 `Modal`。两个毛病：
> 1. **那个弹窗里的「取消」会把整叠拆掉**，而不是退回列表——用户报为
>    「这个界面点取消就真的什么都不干了……应该返回上级菜单」。
> 2. **结构性错误**：嵌套 `Modal` 共用同一套 Escape / 焦点栈，所以那一层**没法单独关掉**，
>    必然连带拆掉外层。
>
> 改用**行内提示**后两个问题一起消失：只陈述后果，不拦截；`取消` 也不需要先"穿过"一层。

**`取消` = 只关闭，不写任何设置。** 现在这句是**字面事实**：改选、模式都没落盘，删除也**不由
它撤销**（删除在自己的确认框上承诺，那张框的文案写着「此操作不可撤销」）。准确说法：
**`取消` 放弃的是"这次规范选择"，不是"我刚才做的所有操作"。**

#### 三、删除：即时 + 一次确认，**不延后**（2026-10-06 定案）

点垃圾桶 → 弹一次确认 → **立即落盘**。

> **考虑过"前端标记待删、确认时才真删"**，并配"若删到了正在用的那个，取消时问是否恢复"。
> **放弃了**，理由是那个方案有一个说不通的状态：被标成待删的行**还在列表里**——
> 它还能被点选吗？能选就是"既删又用"，不能选就是列表里的一个洞，键盘导航还得跳过它。
> 再加上红色横幅已经警告过一次、保存时还要再警告一次，同一件事说两遍。
>
> **一次确认一次**更干净：确认那一刻就是承诺点，之后无论怎么退出都不反悔。

#### 三、`更换…` 才是打开选择器的入口

**卡片点击 = 选择模式**（与「底层工作区」同一分工）；**只有 `更换…` 打开选择器**。
例外：没有可用文件时点卡片会**只弹选择器、不写状态**（照抄底层工作区的规则）。

#### 三·补、每项目下拉栏：**跟随全局是独立的一行**（2026-10-06 定案）

列表**固定**，与全局选择**无关**：

```
跟随全局          ← 第 1 行，固定
无                ← 第 2 行，固定
默认              ← 第 3 行，固定
各已上传规范…      ← 第 4 行起，空列表就是没有，真空
```

**无分隔线**（平铺）· **无「（继承全局）」后缀** · 「自定义（无）」**不出现**

| 存储 `docSpec` | 选中的行 |
|---|---|
| absent (`null`) | **跟随全局** |
| `'none'` | 无 |
| `'default'` | 默认 |
| 文件名（文件在） | 该文件 |
| 文件名（**文件已删**） | **跟随全局** ← 显示"实际生效的" |

> #### 为什么从「继承标记」改成「独立的一行」
>
> 标记版必须判断**哪一项才是"全局那一项"**。全局选择是「自定义但为空」时，
> 这个问题**没有好答案**：实际生效的是**无**，可选的是**自定义** —— 标记要么**说谎**
> （标在「无」上但全局其实是自定义），要么**把「自定义」并进「无」那一行**（用户反对的正是这个）。
>
> **独立一行把这个问题取消了**：下拉栏**不再需要知道**全局选择是什么，
> 所以 `docSpecMode` / `docSpecFileName` 两个注入 hook **一并删掉**。
>
> **代价**（已确认接受）：「跟随全局」不再显示"当前跟的是哪个"，要看就回设置页。

> **顺带消掉一个既存混淆**：早先"项目显式选「无」"与"继承全局而全局解析为无"
> **共用同一行标签**（结果相同、来源不明）。现在前者选中「无」，后者选中「跟随全局」——
> **来源与效果都清楚**。

#### 三·补之二、`'default'` 曾经存不进去（2026-10-06 修复）

**新下拉栏把「默认」做成独立一行后，这个既存缺陷变得更容易踩到**，所以在同轮修掉。

```
实测回包: setProjectDocSpec("default")
          → {"ok":false,"error":{"message":"not a usable spec file name: \"default\""}}
```

**两处缺一半**：

| 位置 | 缺陷 |
|---|---|
| `index.ts` 写入守卫 | 只放行 `'none'`，`'default'` 被 `isSafeSpecName` 按"文件必须以 `.md` 结尾"拒掉 |
| `spec-store.ts` `resolveSpec` | **没有 `override === 'default'` 分支** ⇒ 落到全局选择，而不是内置规范 |

**后果**：选「默认」保存后**静默保持原值**；即使写进去，项目也会**跟随全局**——
与它自己对话框显示的**正好相反**。

**修法**：守卫放行 `'default'`；resolver 补一分支返回 `BUILT_IN_SPEC_PATH`。
`protocol.ts` 的请求注释也补成**四态表**（`null` / `'none'` / `'default'` / 文件名）。

**回归断言**（两侧都锁）：
- `verify-doc-spec.mjs`：`resolveSpec` 对 `'default'` 覆盖返回内置路径，
  且**能压过全局的 `'custom'`**（用非 default 的全局值断言，避免两者混淆）。
- `probe-doc-spec.mjs` `3c-3`：五态写入**都被接受**，且各自选中正确的行。

#### 四、`更换…` = 换记忆，**不动模式**（2026-10-06 定案）

同一个对话框有两个入口，**意图不同**，所以确认的写入也不同：

| 入口 | 用户意图 | 确认写入 |
|---|---|---|
| **卡片**（无可用值时） | "我要用这个模式" | 值 **+ mode** |
| **`更换…`** | "换掉记住的那个文件" | **只有值**，mode 不动 |

> **三件事都必须保留**：**预选**（打开时停在记忆上，替换只需一次点击）、**记忆**（切模式时不丢，
> 切回来能恢复）、**写入**（真的替换，不是丢弃请求）。**唯一不能做的是移动卡片**——卡片是切模式的。
>
> **为什么**：`docSpecFileName` / `base.path` 是**记忆**，按设计**跨模式保留**。早先确认一律写
> `mode='custom'`/`'specified'`，于是「默认」下点 `更换…` 选完文件，卡片也跟着跳到「自定义」——
> 用户报为「点更换然后点确定就跳到自定义了」。

**工作区的实现要点**：`setBaseWorkspace` 必须带 mode，而 `withDefaultMode` 在 `default` 分支
原本会用**已存的** path 覆盖请求里的 path ⇒ **替换被静默丢弃**。修法是让 `withDefaultMode`
接受可选的新记忆（`requested`），Host 与 Client **共用同一个助手**——那份文件的注释专门警告过
两边各写一遍会漂移。

**两个方向都锁死了断言**：写入**落地**（新路径/新文件名确实存进去了）+ 模式**不动**。
只测其中一个都不够——只测"不动"，丢弃请求也会通过；只测"落地"，跳模式也会通过。

### 26.12 验证

| 脚本 | 覆盖 | 断言数 |
|---|---|---|
| `verify-doc-spec.mjs` | 文件名安全、`$DSH_HOME` 解析、规范解析（含陈旧覆盖与 **`'default'` 覆盖**）、哈希、漂移渲染、标签匹配、**schema 兼容** | 79 |
| `verify-project-host.mjs` | 注册表行为 + **并发写不丢失**（12 轮两字段、七字段、复合写入完整性） | 100 |
| `verify-project-injection.mjs` | 六种注入形态 + **漂移谓词 8 项**（含「无」不询问的回归）+ 血缘遍历 | 52 |
| `probe-doc-spec.mjs` | **真实浏览器**：卡片渲染（含「无」的策略文案）、三重门控、卡片第二行的按高亮分色、未选中的行内提示、"高亮只跟点卡片"三模式矩阵、**下拉栏固定四项 + 覆盖五态各自选中哪一行（含 `'default'` 回归）**、悬空名显示、上传/拒绝/删除、色彩令牌、帧级无闪烁 | 127 |

**`verify-doc-spec.mjs` 里最关键的一条是 schema 兼容**：真实的存量 global 与 project 记录
（缺新字段）**必须仍能解析**——否则整个 domain open 被拒，用户所有项目一起读不出来。

**`probe-doc-spec.mjs` 里最该保住的是帧级闪烁断言**：它在深色主题下用 CDP 录屏测
"点无关开关时禁用卡不得跳变"，且**自带两条防空转护栏**（必须命中选中的禁用卡、必须与
页面底色可分辨）。没有那两条护栏时它会"测着一张白色卡片"稳定通过——那是假通过。





## 27. 自动化代码审查（ocr）的处置记录（2026-10-14）

外部工具 `@alibaba-group/open-code-review` 对 **0.3.0** 的树跑出 **641 条**发现。
本章记录处置方式与**哪些结论被实测推翻**——后者比"修了多少条"更重要，因为审查是模型产出的，
不是人核对过的。

### 27.1 分批与规模

| 阶段 | 范围 | 条数 | 状态 |
|---|---|---|---|
| 0 | 安全（最优先） | 11 | ✅ |
| 1 | 两条 CRITICAL | 2 | ✅ |
| 2 | `src/` 产品代码 | 143 | ✅ |
| 3 | CI 与打包配置 | 33 | ✅ |
| 4 | `scripts/lib/` | 17 | ✅ |
| 5 | `scripts/verify-*.mjs` | 52 | ✅ |
| 6 | `scripts/probe-*.mjs` | 386 | ✅ |
| 7 | `scripts/` 其它 | 5 | ✅ |

看板与逐条勾选在会话临时清单里（`.agent/temp/`），不进仓库——它是过程产物，不是产品文档。

### 27.2 被实测推翻的审查结论

这些**没有**按审查的说法改，因为所述机制在当前代码里不成立。每条都做了测量：

| 位置 | 审查的说法 | 实测 |
|---|---|---|
| `src/spec.ts:82/95/361` | 共享的可变 zod 默认值，跨解析累积 | zod 4.6.5 对数组/非空数组/对象字面量**每次解析返回新引用**；版本**精确锁定**无范围 |
| `src/client/tree.ts:307` | 遍历是 O(n²) | `includes` 调用次数**跟随 fork 数**而非节点数：n=200 且 0 fork → 0 次；5 fork → 5 次；200 fork → 200 次。代价是 O(forks × n)，`splice` 那部分是不可避免的 O(n) |
| `.gitattributes` | 索引里存有 CRLF，需 renormalize | 按**字节**扫描 143 个已跟踪文本 blob：**0 个含 CRLF**；`git add --renormalize .` 不暂存任何东西 |
| `scripts/compare-bundle.mjs:68` | 可选链不全，正则失配会抛 TypeError | 可选链**短路整条链**：`exec()?.[1].replace()` 得到 `undefined` 而不抛错。**但真问题更严重**：两侧产物都把 `inject` 写成变量引用，于是两侧都是 `undefined`，`undefined === undefined` ⇒ **恒真通过**。见 27.3 |
| `scripts/probe-base-workspace-routing.mjs:155` | `child.kill()` 收不到进程树，应改用 `taskkill /T /F` | 子进程以 `ELECTRON_RUN_AS_NODE=1` 直接跑 `bin.js`（服务本体），全仓清理约定就是 `child.kill()` |

### 27.3 按「形态」修类，而不是按审查的逐条清单

审查对同类缺陷只点了几处，实际分布广得多。**扫描形态**（而非读清单）发现的：

| 类 | 审查报的 | 实际 | 说明 |
|---|---|---|---|
| 凭证泄漏 | 3 处（其中 2 处早已修好） | **14 处未脱敏**，遍及 12 个 probe | 每个 probe 都从子进程 stdout 抓 `?token=<uuid>`——那是**活凭证**。启动失败时会把 token 打进 CI 日志 |
| `spawn` 无 `error` 监听 | 少数几处 | **59 个里只有 3 个有** | 失败的 spawn 发 `'error'` 且不写 stdout ⇒ 要么直接崩进程，要么 120 秒后误报 `boot timeout` |
| `chromium.launch` 在 `try` 外 | 少数几处 | **45 个** | 启动失败会抛出脚本，留下存活的 Host 和打开的浏览器 |
| 未读的 RPC 响应 | 2 处 | **4 处** | 丢弃响应 ⇒ setup 静默失败，后续断言测的是错的状态 |
| 硬编码机器路径 | 1 处 | **5 处 / 4 文件** | 在别的机器上会注册**错误的目录**，而输出里没有任何提示 |
| `let running = child` 别名 | 1 处 | **29 个**（去除 28 个） | 纯别名，在读者和真正被杀掉的进程之间加了一层 |

### 27.4 自己引入的回归，以及校准过的扫描

修类会引入新缺陷。本轮的三个都是**会让探针完全跑不起来**的：

1. **`page.on(...)` / `installRowKeyHelpers(page)` 留在模块顶层**，而 `page` 已改为在 `try` 内赋值
   ⇒ 对 `undefined` 调 `.on`，`TypeError`。涉及 **10 个文件**。
2. **`join(repoRoot, ...)` 被放进 `page.evaluate` 的页面侧函数体** ⇒ 浏览器里没有 `join`/`repoRoot`，
   `ReferenceError`，种子请求从未执行。
3. **`probe-upstream-upgrade.mjs` 的 boot promise 引用了该文件里不存在的 `child`**（阶段 1 引入）
   ⇒ 每次运行都 `ReferenceError`。

**教训（写下来是因为我犯过两次）**：扫描结果的**假阳性会误导大范围改动**。
第一版「顶层用了 `page`」扫描报了约 250 处，因为它把
`const isMasked = () => page.evaluate(...)` 这类**助手定义**当成顶层执行；校准（拿审查明确说"已正确"的
文件作反例）后真值是 **2 处**。同类地，第一版「浏览器侧引用 Node 常量」扫描把
`Array.prototype.join` 当成 `node:path` 的 `join`，报了 7 处假阳性。
**先校准再动手**，否则会白改两百多行本来正确的代码。

### 27.5 机械不变量（替代逐文件肉眼核对）

`scripts/` 下全部 59 个 probe，按形态检查六类；本阶段开始时六类都非零，现在全为 0：

    redaction          0 未脱敏的启动回显
    machinePath        0 硬编码 C:\Users\Think 路径
    errorListener      0（46 个 spawn DSH 的 probe 都有 error/exit 处理）
    launchOutsideTry   0 顶层 launch
    unguardedClose     0 未守卫的 browser.close()
    literalTrueCheck   0 恒真的 check(..., true, ...)

### 27.6 无法执行的部分（必须明说）

**52 / 59 个 probe 需要 live DSH 实例，本环境未能执行。** 根因已查明，且**不是代码问题**：

> 用户侧 DSH 正在运行（Electron 单例）。用隔离 `DSH_HOME` 启动的实例被既有实例接管，
> 于是进程存活、**既不监听端口也不产出任何 stdout/stderr**，探针因此 120 秒超时。

实际**执行**过的：`probe-approach-b`、`probe-slots`、`probe-service`、`probe-grouping-seam`、
`probe-inject-wait`、`probe-contribution`、`probe-retention`、`probe-service-timing`、
`probe-host-import`（含坏路径反向对照）、`compare-bundle.mjs`，以及 `redactToken` 的纯函数行为验证。
`service-timing` 还做了**负向对照**（用 `--import` 覆盖 `Context.prototype.get`）确认断言与退出码是真的。

每个提交都明写了未执行的部分。阶段 8.2/8.3（抽跑 6 个探针、真实 UI 实测）因此**待环境可用后补做**。

### 27.7 反向对照（证明"修好了"不是空话）

- `compare-bundle.mjs` 在门禁内（`verify:bundle`），所以能做完整反向对照：
  破坏 loader id → 2 个 FAIL；6 种构建机路径 → 各自 FAIL 且**每种恰好 1 处完整路径**；
  改动 `inject` 列表 → FAIL + exit 1；无法解析 → SKIP 而非通过；产物缺失 → 2 行诊断 + exit 2。
- `grouping.ts` 13 个座位在旧代码上 FAIL；`tree.ts` 6 个；`isValidLink` 3 个（大写 scheme）；
  purity gate 拒绝 `TYPE_ONLY` 值导入；`verify-projects` 的 pin 顺序 3 个；
  `verify-locales` 的死键检查能抓出伪造的未使用键；asar 6 个构造损坏输入各自给出具名错误。