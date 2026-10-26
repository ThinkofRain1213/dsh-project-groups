# 分支会话继承父会话的项目

> 状态：待审（第三版）
> 日期：2026-10-26
> 适用版本：dsh-project-groups（当前 main，HEAD `2c1f493`）

## 1. 意图与理由

官方三种「分支」入口产生的子会话都落在源会话所在的 Workspace。本插件把侧栏「工作区」换成了「项目」，但**分支出来的会话不继承父会话的项目，一律落到「未分组」**，用户必须每次手动拖一次。

用户要求：**分支时，子会话落到与父会话相同的项目。**

### 三个入口的真实调用路径（已逐一核实）

| 入口 | 调用 |
|---|---|
| 侧栏会话菜单「分叉会话」 | `uiWorkspace.forkSession(...)` → `this.sessions.fork(...)`（`src/vendored/client/navigation.ts:377`） |
| 快捷键 `Ctrl+Alt+F` | 同上（`src/vendored/client/shortcuts.ts:112`） |
| 消息下方「在新对话中分支」 | **`ctx.sessions.fork(...)` 直接调用**（官方 `packages/client/ui-chat/src/client/apply.ts:288`） |

**客户端全仓只有两个 `fork` 调用点**（`ui-chat/apply.ts:288`、`ui-workspace/navigation.ts:315`），二者最终都落到 `ClientSessions.fork`（`packages/api/session-controller/src/client/sessions/service.ts:459`）。

> 前一版设计把落点放在 `UiWorkspaceService.forkSession`，那会漏掉消息级入口——它绕过了 `uiWorkspace`。**本版修正为拦截 `ClientSessions.fork`。**

### 真机证据（本机，2026-10-26）

| 事实 | 数据 |
|---|---|
| 分支（`isSeeded: true` 且无 `origin`） | 16 |
| 其中父会话**有**项目归属 | **13 / 16** |
| 其中分支自身有归属 | 13 / 16 |

那 13 个是用户逐个手动拖进去的。

## 2. 目标 / 非目标

**目标**

- 用户点击任一「分支」入口时，子会话自动落到父会话所在的项目。
- 侧栏显示与运行时注入**同时**正确。

**非目标**

- **不做历史回填**：已存在的 16 个分支不因本次改动归位。
- 不引入「分支树」：项目仍是扁平标签，不建立父子嵌套。
- 不改变分叉/重命名/归档的既有交互。

**反目标（即使技术可行也算失败）**

- 让显示路径与注入路径给出不同答案。
- 系统在用户已经不打算干预的地方反复写入。
- 因为一次项目写入失败，导致分支本身失败。

## 3. 核心决策：在 fork 调用点写一次

**系统只在「用户触发分支」这一瞬间写一条 `assignment`，之后完全放手。**

先前版本打算被动订阅会话创建事件，由此引出「如何判断一个会话是新的」这个无解问题——因为 DSH 的 `session/created` 在 `resume` 时会**重新派发**（`packages/core/agent-loop/src/index.ts:658` 的 `announce` 由 `setupAndPublish:814` 调用，官方断言见 `resume.spec.ts:850`）。被动观察会让系统在用户把分支拖回「未分组」并重新打开后，又把记录写回去。

**主动写入没有这个问题**：按钮点一次，写一次。`resume` 不经过 `fork`。

由此本方案**不需要**时间判据、不需要「已判定」持久表、不需要 assignment 的 `source` 字段。

## 4. 方案：包装 `ctx.sessions.fork`

在客户端插件 `apply` 中，给 `ctx.get('sessions')` 实例的 `fork` 方法包一层：调用原方法，成功后读父项目并 `assign(childId, projectId)`。

### 为什么可行（逐项已验证）

| 前提 | 验证结果 |
|---|---|
| 三个入口共用此方法 | ✅ 客户端全仓只有两个 `fork` 调用点，都落到 `ClientSessions.fork` |
| 调用方在**调用时**读属性 | ✅ `ctx.sessions.fork(...)` / `this.sessions.fork(...)`，无提前捕获的引用，包装立即生效 |
| `fork` 是原型方法，可被实例属性遮蔽 | ✅ 定义在 class body（`service.ts:459`） |
| 实例未被 `Object.freeze` | ✅ 只冻结了 `retainedBy` 等数据对象 |
| 插件能拿到该实例 | ✅ `inject` 已含 `'sessions'`（`src/vendored/client/index.ts:109`），现有代码用 `ctx.get('sessions')` |
| 不能替换服务 | ❌ `reflect.provide` 对已注册名字直接抛错（`vendor/cordis/src/reflect.ts:290-292`）—— 所以只能包装方法，不能顶替服务 |

### 三条实现约束（每条都对应一个已知的失败形态）

**1. `this` 必须绑定回原实例**

`ClientSessions.fork` 内部有 4 处 `this.`（`this.list`、`this.manager`、`this.projectList()`）。包装时若写成 `const id = await original(opts)`，`this` 丢失，会在 `this.list.getSnapshot()` 处抛错——表现为**分支功能整个坏掉**，而不是「仅仅没继承」。必须 `original.call(sessions, opts)`。

**2. 防止重复包装**

插件 `apply` 在热重载时可能重跑。无脑覆盖会产生 `包装(包装(原方法))`，同一次分支写两遍 assignment。需要在原方法上打标记（如 `original[WRAPPED] === true` 则跳过）。

**3. 卸载时必须还原**

用 `ctx.effect(() => () => { delete sessions.fork })` 的模式（参照 `src/vendored/client/index.ts:434` 的既有写法）。`sessions` 实例本身由 `rootCtx.effect` 管理（`service.ts:265-282`），它销毁时我们的包装自然失效；此时 `delete` 一个不存在的属性是安全的。

**4. 必须在原方法 `resolve` 之后写，不能在 `onCreated` 里写**

`ClientSessions.fork` 的内部顺序是（`service.ts:474-482`）：

```
onCreated?.(childId)        ← 先
rename(childId, ...)        ← 后，失败会让 fork 整体抛错
return childId
```

若把继承写进 `onCreated`，会在 rename 之前落库。此时 rename 失败、`fork` 抛错、调用方认为分支失败——但项目归属已经写进去了，留下一条指向"失败"分支的孤儿记录。

**因此包装必须 `await` 原方法成功返回后再写**，不能只转交 `onCreated`。

## 5. 判定规则

在包装的 `fork` 拿到 `childId` 之后：

```
1. 父会话 = 调用 fork 时传入的 opts.sessionId
2. 父项目 = projectModel()?.projectOf(父会话)
3. 模型未就绪 或 父无项目 → 什么都不做（子会话自然落未分组，这不是错误）
4. 有则 model.assign(childId, 父项目)
```

**单层，不向上追溯**：父会话不在任何项目里，子会话就不继承。这与「系统只做一次性的初值」一致。

### 与官方 `forkWorkspace()` 的关系（诚实说明）

官方对 Workspace 的处理（`packages/api/session-controller/src/commands.ts:550-560`）：

```ts
const direct = workspaces.find(ws => ws.sessionIds.includes(source.id))
if (direct !== undefined || source.origin !== 'subagent') return direct
const lineage = await this.ctx.sessionQuery.traceSession(source.id)   // 仅 subagent 走这里
for (const ancestor of lineage.ancestors) { … }
```

即：父是普通会话时单层取用；**父是 subagent 时才向上追溯祖先**。

本方案不做 subagent 的祖先追溯。理由：侧栏只把 ordinary forks 列为可分支行（`src/vendored/client/tree.ts:676`）。**这是已知差异，不是等价。**

## 6. 实现落点

| 文件 | 改动 |
|---|---|
| `src/client/fork-inheritance.ts` | **新建**：包装逻辑（安装/还原/防重复），以及可被测试直接调用的纯函数 |
| `src/client/index.ts` | 在 `apply` 中调用安装函数 |
| `src/lineage.ts` | **不改** |

**为什么不放进 `vendored/`**：`vendored/` 是官方源码的忠实副本 + 补丁台账，本改动与上游行为无关，是纯粹的插件增值功能。放进去会让台账难以解释。

## 7. 测试

现有 `scripts/verify-project-injection.mjs` 的 lineage 断言**全部保持不变**（`lineage.ts` 未改）。

新增 `scripts/verify-fork-inheritance.mjs`，覆盖包装逻辑的每条性质：

1. 调用方传入的 `onCreated` **仍被调用且只调用一次**（侧栏 analytics 依赖它）。
2. 父有项目 → 对子会话调用 `assign`。
3. 父无项目 → 不调用 `assign`，不抛错。
4. 模型未就绪（`projectModel()` 返回 undefined）→ 不抛错。
5. `assign` 拒绝 → `fork` 仍正常返回 `childId`、不抛错（只记日志）。
6. 原 `fork` 抛错（fork 失败）→ **不写入**，且异常原样抛出。
7. 重复安装 → 只包装一次（同一次 fork 只写一遍）。
8. 还原后 → `fork` 回到原方法。

端到端探针 `scripts/probe-fork-inherits-project.mjs`：

9. 用**侧栏「分叉会话」**分支 → 子会话落在父项目下。
10. 用**消息下方「在新对话中分支」**分支 → 同上。

第 9、10 条必须分别验证。消息级入口是本方案相对上一版的核心修正点，只测侧栏等于没验证。

## 8. 边界情形

| 情形 | 期望 |
|---|---|
| 父会话无项目 | 不写，子落未分组 |
| fork 失败 | 不写（原方法抛错，包装透传） |
| assign 失败 | 只记日志；分支照常存在 |
| 用户之后手动拖动 | 正常覆盖，系统不再干预 |
| 分支的分支 | 父是上一条分支，其已有 assignment → 逐层继承 |
| 从 subagent 会话分支 | 不继承（见第 5 节已知差异） |
| 未来新增的 fork 调用方 | 自动获得继承（语义一致，是预期行为） |

## 9. 留给实现者决定

- 包装标记的具体形式（Symbol 属性 vs. WeakSet）。
- `assign` 调用是否需要等待（倾向：不等待，fire-and-forget 并 catch）。
