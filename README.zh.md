# dsh-project-groups

**中文 | [English](README.md)**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH](https://img.shields.io/badge/DSH-0.1.7--rc.2-5965d8)](https://github.com/deepseek-ai/deepseek-harness)

一个为 [DSH](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）打造的插件：**接管侧栏的「工作区」浏览区**，以便把项目分组逻辑叠加在**真实的官方界面**上，而不是自己重写一套、任其与官方漂移。

> **当前状态：仅打地基。** 本版本把官方实现整个 vendor 进来，**不改任何行为**。插件是官方包的等价替换：同样的界面、同样的动作、同样的数据。项目分组逻辑将在下一版叠加。

---

## 为什么需要它

DSH 的工作区本质是**目录所有权**记录，不是分组标签：

- 会话属于某个工作区，是因为它 Header 里**不可变**的 `cwd` 恰好等于该工作区的 `path`——成员关系是**每次读取时现算的**，从来没作为关系存下来。
- 没有任何 RPC 能把会话在工区之间搬运；而 `cwd` 在设计上就是冻结的（`deepFreeze`，整个 harness 里没有任何写入路径）。
- 新建工作区强制弹目录选择器，初始标题就是文件夹名。

所以工作区永远回答不了"这个对话属于我哪个项目"。

## 为什么是 vendor，而不是包装

最直观的做法——保留官方界面、只替换它的数据源——**不可行**。每一条接缝都被显式不变式封死，`scripts/probe-approach-b.mjs` 会针对发行版机制逐条复现：

| 接缝 | 为什么封死 |
|---|---|
| 替换 root hook `useWorkspaces` | `ctx.slots.provideRoot` 拒绝重复的 root standard 属性名——它是带唯一性不变式的并集，不是合并点 |
| 替换 `workspaces` 服务 | `ctx.provide` 拒绝第二个提供者；`ctx.set` 拒跨 fiber 写入 |
| 重新声明官方的子槽位 | 声明已被别的 entry 占用的子槽位会抛错；且 `renderSlot` 是逐 entry 授权的，替代者也无法渲染官方那些动作 |

所以要让界面 1:1，只能自己持有一份副本。

## 它做什么

官方侧栏工作区浏览器的一切，运行在本插件自己的 bundle id 下：

- 分组 / 树形 / 平铺会话列表、搜索、视图选项、归档筛选；
- 会话行内动作——重命名、分叉、置顶、归档、取消归档——及其对话框；
- 对话空状态里的工作区选择器；
- 侧栏壳与目录选择器所注入的 `uiWorkspace` 服务；
- 浏览区读取的 `workspaces` root hook。

官方的 `@deepseek-ai/dsh-client-ui-workspace` 行由本插件的 `cordis.patch.yml` **禁用**——因为单槽位双占用、服务双提供是硬启动错误，不是合并。

## 安装

需要 DSH **0.1.7-rc.2**——vendor 的源码就取自该 tag，两者不可漂移。

```bash
dsh plugin add dsh-project-groups
```

之后重启 DSH。插件的 `cordis.patch.yml` 会插入自己的行并禁用官方那一行。

从本地检出安装：

```bash
git clone https://github.com/ThinkofRain1213/dsh-project-groups.git
cd dsh-project-groups
pnpm install && pnpm build
dsh plugin add .
```

### 验证

侧栏应与**原版 DSH 无法区分**——同样的分组、同样的动作、同样的对话框。这就是本版本的验收标准。

## 替换是怎么生效的

```jsonc
// cordis.patch.yml
- id: ui-workspace
  name: "@deepseek-ai/dsh-client-ui-workspace"
  disabled: true

- insert:
    - id: project-groups
      name: dsh-project-groups
```

bundle patch 按 `dsh.profile.bundles` 顺序应用，而官方那一行由 web-app bundle 层声明、先于本插件应用——所以这条 disable 落在了一行已存在的 entry 上。`scripts/verify-patch.mjs` 会把它跑过 Loader 真实的 patch 算法（`applyEntryPatches`），并断言没有任何 patch 被跳过——因为指向未知 id 的 patch 只会警告后继续，不会报错。

bundle 的构建满足与上游相同的模块边界规则：

- 壳提供的平台模块（`react`、`@deepseek-ai/cordis`、槽位注册表、UI primitives）保持 `require()`，让 React 与槽位注册表被共享而非重复打包；
- 接线层与纯折叠层（`dsh-util-values`、`dsh-util-workspace-path`、`dsh-api-workspace-controller/default-workspace`）内联，这也是上游自己的 bundle 做法；
- 其余任何跨插件的值导入都是**构建期错误**，而不是静默产生一份重复的运行时实例。

`scripts/compare-bundle.mjs` 断言产物解析的 external 与官方 bundle **完全一致**——官方那份直接从已安装的 `app.asar` 里读出。

## 开发

```bash
pnpm install
pnpm typecheck        # tsc --noEmit，覆盖 src（含 vendor 树）
pnpm build            # tsdown -> lib/index.js + lib/client.js
pnpm check            # typecheck + build + bundle 校验 + patch 校验
```

源码结构：

| 路径 | 职责 |
|---|---|
| `src/index.ts` | Host 半（暂无行为） |
| `src/client/index.ts` | 浏览器入口——下一版项目逻辑落在这里 |
| `src/vendored/` | 官方 client 源码的原样副本（见其 [README](src/vendored/README.md)） |
| `scripts/` | 探针与校验；`DESIGN.md` 说明每个脚本证明了什么 |
| `DESIGN.md` | 架构、已核实的 harness 事实、分层计划 |

## 维护这份 fork

`src/vendored/` 与上游 `packages/client/ui-workspace/src/`（`dsh-v0.1.7-rc.2`）**逐字节一致**。重新同步 = 复制 + 重看 [`src/vendored/README.md`](src/vendored/README.md) 里那张很短的适配表；树内没有任何被编辑过的文件。

DSH 升级就是重新同步的信号：官方包与整个 harness 线同版本号，本插件的 `devDependencies` 钉住了这份副本的来源版本。

## 许可

[MIT](LICENSE)。vendor 的源码同为 MIT，来自同一项目。
