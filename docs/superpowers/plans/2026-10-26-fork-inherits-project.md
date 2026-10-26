# 分支会话继承父项目 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户从任一种入口分支时，新会话自动落到父会话相同的项目下。

**Architecture:** 包装 `ctx.sessions.fork`（`ClientSessions` 实例的原型方法），调用原方法成功后读父会话的项目并 `assign`。客户端全仓两个 `fork` 调用点（`ui-chat` 消息级、`ui-workspace` 侧栏与快捷键）都在调用时读取该属性，因此一处包装全覆盖。

**Tech Stack:** TypeScript、Cordis 插件体系、DSH 客户端 `ISessions` 服务、项目自有 `ProjectModel`。

**Spec:** `docs/superpowers/specs/2026-10-26-fork-inherits-project-design.md`

## Global Constraints

- 只做**一次性写入**：分支创建时写一次，之后系统不再干预。
- **不做历史回填**：已存在的分支不因本次改动归位。
- **单层继承**：父不在任何项目里就不继承；不追溯 subagent 祖先。
- `src/lineage.ts` **不得修改**（`verify-project-injection.mjs` 的断言依赖它）。
- **不得 vendored `ui-chat`**（本方案的存在意义就是避免它）。
- 中文注释与文档，遵循仓库既有风格。

## Review Focus

1. **`this` 绑定丢失** —— `ClientSessions.fork` 内部有 4 处 `this.`。包装时用 `original(opts)` 而非 `original.call(sessions, opts)` 会让分支功能整个坏掉，而不是仅仅没继承。
2. **调用方的 `onCreated` 被吞** —— 两个调用方都传了它（analytics）。覆盖而非串联会静默丢失统计。
3. **assign 失败导致 fork 失败** —— 分支已建好却抛错，用户看到"分支失败"但实际成功。必须 catch 只记日志。
4. **重复包装** —— 热重载后同一次 fork 写两遍 assignment。
5. **消息级入口未覆盖** —— 本方案相对上一版的核心修正点。只测侧栏等于没验证。

---

### Task 1: 包装逻辑与纯函数

**Files:**
- Create: `src/client/fork-inheritance.ts`
- Test: `scripts/verify-fork-inheritance.mjs`

**Interfaces:**
- Consumes:
  - `projectModel(): ProjectModel | undefined` —— `src/client/grouping.ts:147`（模型可能尚未就绪）。
  - `ProjectModel.projectOf(sessionId: SessionId): string | undefined` —— `src/client/projects.ts:541`。
  - `ProjectModel.assign(sessionId: SessionId, projectId: string): Promise<void>` —— `src/client/projects.ts:692`。
- Produces:
  - `inheritForkProject(parentId: SessionId, childId: SessionId, deps: ForkInheritanceDeps): void`
  - `wrapFork(sessions: ForkableSessions, deps: ForkInheritanceDeps): () => void`
  - `interface ForkableSessions { fork(opts: ForkOptions): Promise<SessionId> }`
  - `interface ForkInheritanceDeps { projectOf(parentId: SessionId): string | undefined; assign(childId: SessionId, projectId: string): Promise<void>; warn(message: string, error: unknown): void }`

- [ ] **Step 1: 写失败的测试**

新建 `scripts/verify-fork-inheritance.mjs`。用假对象驱动，不启动 DSH。

```js
import { wrapFork, inheritForkProject } from '../src/client/fork-inheritance.ts'

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// 一个记录调用的假 sessions：fork 内部像真实实现一样读 this
const fakeSessions = (outcome) => {
  const record = { forks: [], assigns: [] }
  const sessions = {
    marker: 'original',
    async fork(opts) {
      record.forks.push(opts.sessionId)
      if (outcome === 'throw') throw new Error('fork failed')
      opts.onCreated?.('child-1')
      return 'child-1'
    },
  }
  return { sessions, record }
}

const deps = (projectId, record) => ({
  projectOf: () => projectId,
  assign: async (childId, pid) => { record.assigns.push([childId, pid]) },
  warn: () => {},
})
```

断言（每条一个 `check`）：

1. 父有项目 → `assigns` 收到 `['child-1', 'P1']`
2. 父无项目 → `assigns` 为空，且 fork 正常返回
3. `assign` 拒绝 → fork 仍返回 `child-1`，不抛
4. fork 抛错 → 异常原样抛出，`assigns` 为空
5. 调用方 `onCreated` 被调用恰好一次
6. 包装后 `sessions.marker` 仍是 `'original'`（证明 `this` 正确绑定到原实例）
7. 重复 `wrapFork` 两次 → 一次 fork 只产生一条 assign
8. 调用 `wrapFork` 返回的 cleanup 后 → 再 fork 不产生 assign
9. **原方法在 `onCreated` 之后才抛错**（模拟 rename 失败）→ 不写入，异常透传

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/verify-fork-inheritance.mjs`
Expected: FAIL —— 模块不存在（`ERR_MODULE_NOT_FOUND`）。

- [ ] **Step 3: 实现 `src/client/fork-inheritance.ts`**

三个导出：

```ts
/** Post-fork side effect: file the child under the parent's project. */
export function inheritForkProject(
  parentId: SessionId, childId: SessionId, deps: ForkInheritanceDeps,
): void
```

实现要点：整体 try/catch（`deps.projectOf` 若抛错不能外泄）；`projectId === undefined` 时直接返回；`deps.assign(...)` 的拒绝用 `.catch(e => deps.warn(...))`，不 await。

```ts
/** Wrap `sessions.fork` so every fork inherits its parent's project. */
export function wrapFork(sessions: ForkableSessions, deps: ForkInheritanceDeps): () => void
```

实现要点（每条对应一个失败形态）：

- **防止重复包装**：在包装函数上记一个标记；若 `(sessions.fork as any)[WRAPPED] === true`，返回空 cleanup。
- **`this` 绑定**：`const original = sessions.fork`，包装内 `await original.call(sessions, opts)`。这是全文件最容易写错的一行。
- **写入时机**：**`await` 原方法成功返回之后**才写，**不要**在 `opts.onCreated` 里写。`ClientSessions.fork` 的内部顺序是 `onCreated` → `rename` → `return`（`service.ts:474-482`），rename 失败会让整个 `fork` 抛错。若在 `onCreated` 里写，会留下一条件指向"失败分支"的孤儿记录。
- **`onCreated` 原样转交**：包装不拦截它，`{ ...opts }` 透传即可——原方法会照常调用调用方的回调。
- **失败不吞**：`original.call` 的异常直接透传（fork 失败必须让调用方看见），且此时**不写入**。
- **还原**：cleanup 里**赋回原方法**（`sessions.fork = current`），**不是 `delete`**。`delete` 只在原型方法上才会回退，实例自有属性会被整个删掉、`fork` 变 `undefined`；单测用普通对象驱动会立刻崩。另需**校验属主**（仅当 `sessions.fork === wrapped` 时才还原），否则旧 fiber 的 disposer 可能拆掉新 apply 装好的包装。

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/verify-fork-inheritance.mjs`
Expected: 8 条全 PASS，`ALL CHECKS PASSED`。

- [ ] **Step 5: 类型检查**

Run: `pnpm check`
Expected: 通过，无新增错误。

- [ ] **Step 6: 提交**

```bash
git add src/client/fork-inheritance.ts scripts/verify-fork-inheritance.mjs
git commit -m "feat(client): 分支时把子会话归入父会话的项目"
```

---

### Task 2: 在 apply 中安装包装

**Files:**
- Modify: `src/client/index.ts`（`apply` 内，靠近现有 `ctx.effect` 的位置）
- Test: `scripts/verify-fork-inheritance.mjs`（增补一条安装校验）

**Interfaces:**
- Consumes: Task 1 的 `wrapFork` / `inheritForkProject`。
- Produces: 无。

- [ ] **Step 1: 增补测试断言**

在 `scripts/verify-fork-inheritance.mjs` 末尾追加一条断言：当 `projectModel()` 返回 `undefined`（模型未就绪）时，包装后的 fork 不抛错、不写 assignment。

- [ ] **Step 2: 运行确认失败**

Run: `node scripts/verify-fork-inheritance.mjs`
Expected: 新断言 FAIL（若实现已覆盖则直接 PASS —— 此时记录并继续）。

- [ ] **Step 3: 在 `src/client/index.ts` 的 `apply` 中安装**

```ts
// One wrap covers every branch entry: the sidebar menu and shortcut go
// through `uiWorkspace.forkSession`, while the message-level action in the
// official `ui-chat` calls `ctx.sessions.fork` directly. Both read the
// method at call time, so shadowing it on the instance reaches them.
ctx.effect(() => {
  const sessions = ctx.get('sessions') as
    | (ForkableSessions & { fork: unknown }) | undefined
  if (sessions === undefined || typeof sessions.fork !== 'function') {
    // A composition without the Session service gets no inheritance rather
    // than a startup failure: the rest of the plugin does not need it.
    return () => {}
  }
  return wrapFork(sessions, {
    projectOf: (parentId) => projectModel()?.projectOf(parentId),
    assign: (childId, projectId) => projectModel()?.assign(childId, projectId) ?? Promise.resolve(),
    warn: (message, error) => { console.warn(message, error) },
  })
}, 'project-groups: fork inheritance')
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/verify-fork-inheritance.mjs`
Expected: 全部 PASS。

- [ ] **Step 5: 类型检查与门禁**

Run: `pnpm check`
Expected: 通过。

- [ ] **Step 6: 提交**

```bash
git add src/client/index.ts scripts/verify-fork-inheritance.mjs
git commit -m "feat(client): 在 apply 中安装分支继承"
```

---

### Task 3: 真机验证两个入口

**Files:**
- Create: `scripts/probe-fork-inherits-project.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `scripts/lib/boot-dsh.mjs` 的 `ensureProbeProfile` / `settleOnboarding` / `dismissModals`；模式参照 `scripts/probe-plugin-toggle-ui.mjs`。
- Produces: 无。

- [ ] **Step 1: 写探针**

启动真实 DSH，依次：

1. 新建项目 `fork-inherits-<时间戳>`。
2. 复用当前空白会话，发一条消息，等待轮次完成（消息级分支按钮要求「已完成轮次」）。
3. 把该会话归入项目（RPC `projectGroups/assign`）。
4. **侧栏「分叉会话」** → 等待新行出现 → 读 `project_groups.json` 断言子会话的 `projectId` 等于父的。
5. **对另一个已完成轮次的会话，用消息下方「在新对话中分支」** → 同样断言。

断言直接读存储文件的 `assignments` 表，比读 DOM 稳定。

- [ ] **Step 2: 运行探针**

Run: `node scripts/probe-fork-inherits-project.mjs <dshExe> <asarRoot> <临时DSH_HOME>`
Expected: 两个入口各至少一条 PASS，无 FAIL。

- [ ] **Step 3: 反向对照**

临时让 `wrapFork` 直接返回空 cleanup（不包装），重跑探针。
Expected: 两个入口都 FAIL。确认探针能失败后恢复。

- [ ] **Step 4: 登记脚本**

`package.json` 的 `scripts` 新增：
```json
"probe:fork-inherits": "node scripts/probe-fork-inherits-project.mjs"
```

- [ ] **Step 5: 提交**

```bash
git add scripts/probe-fork-inherits-project.mjs package.json
git commit -m "test(probe): 证明两种分支入口都把子会话归入父项目"
```

---

### Task 4: 文档

**Files:**
- Modify: `DESIGN.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 1–3 的最终实现与探针结果。
- Produces: 无。

- [ ] **Step 1: DESIGN.md 新增决策记录**

写清：现象（13/16 真机数据）；为什么不能被动观察（`session/created` 在 resume 重发，引 `agent-loop/src/index.ts:658` 与 `resume.spec.ts:850`）；为什么包装 `ctx.sessions.fork`（两个客户端调用点、调用时读属性、`reflect.provide` 不能顶替服务）；三条实现约束（`this` 绑定、防重复、还原）；已知差异（不追溯 subagent 祖先，引 `commands.ts:554-559`）。

- [ ] **Step 2: CHANGELOG 新增条目**

未发布区加一条：「分支出的会话现在继承父会话的项目（侧栏分叉、消息级分支、快捷键三个入口）。」

- [ ] **Step 3: 提交**

```bash
git add DESIGN.md CHANGELOG.md
git commit -m "docs: 记录分支继承项目的决策与已知差异"
```

---

## Self-Review

**1. Spec coverage**

| Spec 要求 | 任务 |
|---|---|
| 三入口全覆盖 | Task 1（包装点）+ Task 3（两入口各测） |
| 不做历史回填 | Task 1 天然满足（无被动观察） |
| 单层继承 | Task 1 `projectOf(parentId)` 直接返回 |
| `lineage.ts` 不改 | 全局约束 + 文件清单 |
| 不吞 onCreated | Task 1 Step 3 + 断言 5 |
| assign 失败不影响 fork | Task 1 Step 3 + 断言 3 |
| 父未分组不报错 | Task 1 提前返回 + 断言 2 |
| `this` 绑定正确 | Task 1 断言 6 |
| 防重复包装 | Task 1 断言 7 |
| 卸载还原 | Task 1 断言 8 |
| fork 失败不写入 | Task 1 断言 4、9 |
| 不 vendored ui-chat | 全局约束 |

**2. Step scan** —— 每步一个可核查结果。代码块只给签名与关键约束（`this` 绑定、标记、串联顺序），不给完整函数体。

**3. Type consistency** —— `wrapFork(sessions, deps)` / `inheritForkProject(parentId, childId, deps)` / `ForkInheritanceDeps` 在 Task 1 定义、Task 2 使用，签名一致。

**4. Review Focus** —— 五条各有落点：1→断言 6，2→断言 5，3→断言 3，4→断言 7，5→Task 3 Step 1 的第 5 项。

**5. Proportion** —— 计划短于设计文档，无逐行转写。
