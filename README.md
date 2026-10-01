# dsh-project-groups

**中文 | [English](README.en.md)**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2-5965d8)](https://github.com/deepseek-ai/deepseek-harness)

一个为 [DSH](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）打造的插件：
**接管侧栏的「工作区」浏览区**，把分组从**目录**上摘下来，变成**纯前端的项目归属**。

> **基础功能 = 完全不动官方 + 只按项目分组。** 插件关掉即完全恢复官方行为。

---

## 为什么需要它

DSH 官方的工作区是**目录所有权**记录：一个会话属于某工作区，是因为它 Header 里**不可变**的
`cwd` 恰好等于该工作区的 `path`。成员关系**每次读取时现算**，从来没作为关系存下来。

这套模型要求你**事先手动指定目录**。而本插件的用法是**完全权限、不按目录划分工作**——
目录那一套在这里是多余的负担：

- 没有任何 RPC 能把会话在工作区之间搬运，`cwd` 在设计上就是冻结的（`deepFreeze`）；
- 新建工作区强制弹目录选择器，初始标题只能是文件夹名；
- 于是工作区永远回答不了"这个对话属于我哪个项目"。

**所以插件把分组摘下来**：项目**没有目录**，只是给会话贴的一个标签，
用来在侧栏里把不同项目的会话分开管理。

## 它做什么

官方侧栏工作区浏览器的一切，运行在本插件自己的 bundle id 下（1:1 复刻），在此之上叠加：

- **项目分组**——项目行 + 「未分组」桶，替代官方的按工作区分组；
- **拖拽归类**——会话在项目之间拖动，或拖回「未分组」；
- **项目自身的增删改排**——新建 / 重命名 / 删除 / 拖拽排序，标题唯一；
- **新会话落点**——项目行 ＋ / 未分组 ＋ / 顶栏按钮，都落在「底层工作区」；
- **搜索结果归属**——结果行显示所属**项目**，不是工作区。

官方的 `@deepseek-ai/dsh-client-ui-workspace` 行由 `cordis.patch.yml` **禁用**——
单槽位双占用、服务双提供是硬启动错误，不是合并。也因此界面 1:1 才成立。

## 额外功能（默认不做）

以下**超出**"完全不动官方"的范围，**默认不实现**，要做需明确确认：

| 功能 | 为什么是额外功能 |
|---|---|
| **会话 hover 卡显示所属项目** | 官方 `SessionHoverContent` 本来就没有这个概念；分组视图里项目标题已在行上方可见 |
| **工作文档**（`docPath` 绑定 + `agent/pre-step` 注入） | 官方没有这个概念，且它是唯一"往会话里注入内容"的动作 |

详见 [`DESIGN.md` §24](DESIGN.md)。

## 安装

需要 DSH **0.2.0-rc.2**。插件跑在 0.2.0 的壳上，vendor 源码同样取自 **0.2.0-rc.2**
（上游同步流程见 [`DESIGN.md` §5 的 L4.5](DESIGN.md)）。

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

- 侧栏界面应与**原版 DSH 无法区分**——同样的树、搜索、视图选项、对话框；
- 关掉插件后，官方行重新启用，**行为完全回到原版**。

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

bundle patch 按 `dsh.profile.bundles` 顺序应用，官方那一行由 web-app bundle 层声明、
先于本插件应用——所以这条 disable 落在了一行已存在的 entry 上。
`scripts/verify-patch.mjs` 会把它跑过 Loader 真实的 patch 算法（`applyEntryPatches`），
并断言没有任何 patch 被跳过——因为指向未知 id 的 patch 只会警告后继续，不会报错。

bundle 的构建满足与上游相同的模块边界规则：

- 壳提供的平台模块（`react`、`@deepseek-ai/cordis`、槽位注册表、UI primitives）保持 `require()`；
- 接线层与纯折叠层（`dsh-util-values`、`dsh-util-workspace-path`、`dsh-api-workspace-controller/default-workspace`）内联，与上游自己的 bundle 做法一致；
- 其余任何跨插件的值导入都是**构建期错误**，而不是静默产生一份重复的运行时实例。

`scripts/compare-bundle.mjs` 断言产物解析的 external 与官方 bundle **完全一致**——
官方那份直接从已安装的 `app.asar` 里读出。

## 开发

```bash
pnpm install
pnpm typecheck        # tsc --noEmit，覆盖 src（含 vendored 树）
pnpm build            # tsdown -> lib/index.js + lib/client.js
pnpm check            # typecheck + build + bundle/patch/分组/项目校验 + 探针（362 条断言）
```

> **⚠️ 本地开发（`dsh plugin add .` / `link:` 安装）时，改完 `src/` 必须
> 两步都做，缺一不可：**
> 1. **`pnpm build`** —— 重建 `lib/`（`link:` 装的是 `lib/` 里的产物，不是源码）
> 2. **重启 DSH** —— Host 半的 `lib/index.js` **不会热加载**
>
> 只重建不重启，看到的是旧 Host 行为；只重启不重建，同样不生效。
> （客户端 `lib/client.js` 可能热载，**Host 端不行**。）
> 这个坑曾导致一次真实的误判：修复已生效但未重启，被当成"没修好"。

源码结构：

| 路径 | 职责 |
|---|---|
| `src/index.ts` | Host 半：项目领域、Remote、底层工作区重建 |
| `src/client/index.ts` | 浏览器入口：注入分组、设置卡片、选择弹窗 |
| `src/vendored/` | 官方 client 源码副本 + **41 条登记的 patch**（见其 [README](src/vendored/README.md)） |
| `scripts/` | 探针与校验；`DESIGN.md` 说明每个脚本证明了什么 |
| `DESIGN.md` | 架构、已核实的 harness 事实、分层计划与额外功能清单 |

## 维护这份 fork

`src/vendored/` **起点**是上游 `packages/client/ui-workspace/src/`（`dsh-v0.1.7-rc.2`）
的逐字节副本，**但现在已不再逐字节一致**：项目分组需要分组缝，
现有 **41 条结构性 patch、涉及 10 个文件**。当前来源版本是 **0.2.0-rc.2**。

每一处都满足同一条不变量——**不传即等官方行为**——并且全部登记在
[`src/vendored/README.md`](src/vendored/README.md) 的 patch 表里。
**那张表就是重同步时的唯一清单**，也是"重新同步 = 复制 + 逐条重打"的依据。

DSH 升级就是重新同步的信号：官方包与整条 harness 线同版本号，
本插件的 `devDependencies` 钉住这份副本的来源版本。

## 许可

[MIT](LICENSE)。vendor 的源码同为 MIT，来自同一项目。
