# dsh-project-groups

**中文 | [English](README.md)**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.1.7--rc.2-5965d8)](https://github.com/deepseek-ai/deepseek-harness)

一个为 [DSH](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）打造的插件：**把侧栏的「工作区」浏览区替换成一份平铺会话列表**，所有会话收进一个「未分组」桶。

这是「项目分组」插件的第一层（L0），面向**完全权限工作流**——在这种工作流里，绑定目录的工作区机制反而碍事。

---

## 为什么做这个

DSH 的工作区本质是**目录所有权**记录，不是分组标签：

- 会话属于某个工作区，是因为它 Header 里**不可变**的 `cwd` 恰好等于该工作区的 `path`——成员关系是**每次读取时现算的**，从来没有作为关系存下来。
- 没有任何 RPC 能把会话在工区之间搬运；而 `cwd` 在设计上就是冻结的（`deepFreeze`，整个 harness 里没有任何写入路径）。
- 新建工作区强制弹目录选择器，初始标题就是文件夹名。

所以工作区永远回答不了"这个会话属于我哪个项目"。本插件接管侧栏来回答这个问题，同时**一个字节都不碰官方数据**。

## 当前能力（L0）

- **接管浏览区**。以低于官方工作区浏览器的优先级注册进侧栏的 `sidebar.workspaces` 槽位。该槽位是 `single`，最低优先级者渲染，官方那个注册项只是不再渲染、仍留在账上。
- **全部收进一个桶**。所有可见会话平铺在一个「未分组」标题下。官方归属在不同工作区里的会话会并排出现。
- **沿用官方列表规则**。子代理会话、空白占位、已归档会话都遵循官方浏览器同一套可见性规则，所以替换它不会改变你能看到哪些会话。
- **完全可逆**。不写任何数据。停用或卸载插件，官方工作区浏览器原样回来——包括你改过的名字。

## 当前**不**做的事

L0 是六层计划中的第一层。刻意缺席的部分：

- 项目记录与拖拽归类（**L1–L2**）
- 被接管遮蔽的会话动作——归档、置顶、重命名、分叉、搜索（**L3**）
- 新会话的默认工作区创建（**L4**）
- 每个项目的工作文档及其对新会话的注入（**L5**）

在 **L3** 之前，请知悉：插件接管侧栏期间，那些行内动作不可用。关掉插件立刻恢复。

## 安装

需要 DSH **≥ 0.1.7-rc.2**。

```bash
dsh plugin add dsh-project-groups
```

或从本地检出安装：

```bash
git clone https://github.com/ThinkofRain1213/dsh-project-groups.git
cd dsh-project-groups
pnpm install && pnpm build
dsh plugin add .
```

之后重启 DSH。插件自带 `cordis.patch.yml`，把自己的行插入 web profile 的客户端名单。

### 验证

1. 侧栏的「工作区」区被 **未分组** 取代，会话平铺列出。
2. 点击某行能打开该会话；**新会话** 仍能正常创建。
3. 停用插件 → 官方「工作区」区原样回来。

## 实现方式

插件注册进 DSH 壳声明的槽位：

```ts
ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
  { name: 'sidebar.workspaces', priority: -100, locale: NS, inject: () => ({ startSession, open }) },
  ProjectGroups,
))
```

`sidebar.workspaces` 是 `single` 槽位：每个优先级单元只有一个 entry 渲染，**最低**优先级胜出，落败的 entry 仍保持注册。所以优先级 `-100` 只是遮住官方浏览器（它用默认的 `0`），并没有摧毁它——注销本插件的注册，官方那个立刻回来，无需任何额外处理。

会话数据来自框架的全局标准 hook（`useSessions`、`useWorkspaces`），由官方插件在 root 提供。L0 不持久化任何东西，因此没有任何 host 侧行为。

### 可逆性是设计约束

一切都在显示层：

| | |
|---|---|
| 会话 `cwd` / Header | 从不写入 |
| 官方 `archivedSessionIds` | 只读 |
| 会话日志与目录 | 从不触碰 |
| 官方工作区注册表 | 从不写入 |

## 兼容性

- **DSH：** ≥ 0.1.7-rc.2
- **平台：** web（`dsh.client.platform: web`）
- **Host：** L0 无 host 侧行为

插件在本地重述了槽位契约，而不是导入官方包，因此不会被钉死在某个 DSH 版本线。官方包只作为可选的开发期 peer 依赖出现，用于类型检查。

## 开发

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm build       # tsdown → lib/index.js + lib/client.js
pnpm watch       # 变更即重建
```

`lib/` 已提交，因此插件可以直接从 git clone 安装。

源码结构：

| 路径 | 职责 |
|---|---|
| `src/index.ts` | Host 半（L0 无行为） |
| `src/client/index.ts` | 浏览器 apply：槽位注册 |
| `src/client/ProjectGroups.tsx` | 平铺列表组件 |
| `src/client/format.ts` | 可见性规则与相对时间标签 |
| `src/client/locales.ts` | 中英文字典 |
| `src/client/sidebar-contract.ts` | 本地纯类型槽位契约 |
| `DESIGN.md` | 完整架构、已核实的 harness 事实、L0–L5 计划 |

## 设计备注

`DESIGN.md` 记录了本插件依赖的 harness 事实，每条都对照发行版 `app.asar` 核实过：

- 工作区成员关系由 `cwd` 派生，而 `cwd` 不可变（全仓库无写入方）；
- 删除工作区会**永久**丢失其会话记账——重新导入同一目录只得到空工作区；
- `session/create` 只有传 `workspaceId` 才挂账；传 `cwd` 会留下未分组；
- 官方 `initializeDefault` 在非全新安装下拒绝执行；
- 遮蔽 `single` 槽位会连带压制它声明的子槽位——这正是被遮蔽的行内动作要在 **L3** 回归的原因。

## 许可

[MIT](LICENSE)
