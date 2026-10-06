# dsh-project-groups

**中文 | [English](README.en.md)**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2-5965d8)](https://github.com/deepseek-ai/deepseek-harness)

一个为 [DSH](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）打造的插件，做两件事：

1. **接管侧栏的「工作区」浏览区**，把分组从**目录**上摘下来，变成**纯前端的项目归属**；
2. **给每个项目一份工作文档**，并把它的**格式规范**注入会话——规范一变就提醒模型先问再迁移。

> **插件关掉即完全恢复官方行为**：注入与监听器随插件 fiber 销毁，零残留。

---

## 为什么需要它

### 一、分组不该绑在目录上

DSH 官方的工作区是**目录所有权**记录：一个会话属于某工作区，是因为它 Header 里**不可变**的
`cwd` 恰好等于该工作区的 `path`。成员关系**每次读取时现算**，从来没作为关系存下来。

这套模型要求你**事先手动指定目录**。而本插件的用法是**完全权限、不按目录划分工作**——
目录那一套在这里是多余的负担：

- 没有任何 RPC 能把会话在工作区之间搬运，`cwd` 在设计上就是冻结的（`deepFreeze`）；
- 新建工作区强制弹目录选择器，初始标题只能是文件夹名；
- 于是工作区永远回答不了"这个对话属于我哪个项目"。

**所以插件把分组摘下来**：项目**没有目录**，只是给会话贴的一个标签。

### 二、文档该有一份"怎么写"的规范

项目文档记的是**在做什么、做到哪、下一步**，因此需要一套结构（现状 / 关联资产 / 台账…）——
而**结构会演进**。规范一变，旧文档就与新的对不上，**但模型自己不知道**。

所以插件把**当前规范**注入运行时上下文；一旦发现文档是按**旧规范**写的，就要求模型
**先问用户**，再决定是否重写。

## 它做什么

官方侧栏工作区浏览器的一切，运行在本插件自己的 bundle id 下（1:1 复刻），在此之上叠加：

- **项目分组**——项目行 + 「未分组」桶，替代官方的按工作区分组；
- **拖拽归类**——会话在项目之间拖动，或拖回「未分组」；
- **项目自身的增删改排**——新建 / 重命名 / 删除 / 拖拽排序，标题唯一；
- **新会话落点**——项目行 ＋ / 未分组 ＋ / 顶栏按钮，都落在「底层工作区」；
- **搜索结果归属**——结果行显示所属**项目**，不是工作区。

官方的 `@deepseek-ai/dsh-client-ui-workspace` 行由 `cordis.patch.yml` **禁用**——
单槽位双占用、服务双提供是硬启动错误，不是合并。也因此界面 1:1 才成立。

## 工作文档与规范

每个项目一份 md 文档，统一放在 `$DSH_HOME/project-groups/`；上传的规范放在
同目录的 `specs/` 下。**路径不可自定义**，所以换机器自动正确。

**规范的三种来源**（设置页「文档规范」）：

| 卡片 | 含义 |
|---|---|
| **无** | 不更新格式：无既定格式则自由书写，有既定格式则在其基础上书写 |
| **默认** | 使用插件内置的规范（随包分发，插件升级即自动生效） |
| **自定义** | 用你自己上传的 md 规范，可逐个上传 / 切换 / 删除 |

另有「为每项目单独调整文档规范」开关：开启后，新建与编辑项目对话框会多出一行下拉栏
（`跟随全局 / 无 / 默认 / 各已上传规范`），让单个项目偏离全局选择。

**规范的身份是内容哈希，不是文件名**——所以覆盖同名规范、或插件升级改动内置规范，
**都会**被检出为"规范变了"。发现文档按旧规范写时，注入会要求模型用 `ask_user_question` 问一句：

```
① 按新规范重写   ② 本次忽略   ③ 在规范再次变更前忽略
```

选 ① 则模型按 [`spec/REWRITE-FLOW.md`](spec/REWRITE-FLOW.md) 执行，
**唯一不可违背的约束是"不得因格式迁移而丢失信息"**。

注入**不是每步都做**（官方对未变化的文本不重复提交）：会话首轮、压缩后、以及影响渲染的值
真正变化时。因此「本次忽略」**不记任何状态**即可——不会循环。

详见 [`DESIGN.md` §26](DESIGN.md)。内置规范见 [`spec/PROJECT-SPEC.md`](spec/PROJECT-SPEC.md)。

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
pnpm check            # typecheck + build + 11 个校验脚本 + 探针（652 条断言）
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
| `src/index.ts` | Host 半：项目领域、Remote、文档与规范解析、注入装配、底层工作区重建 |
| `src/injection.ts` | 注入文本渲染（**纯函数**，不碰文件系统）+ 漂移判定 |
| `src/spec-store.ts` | 规范与文档的路径解析、SHA-1（按 path+mtime+size 记忆化）、上传读写 |
| `src/spec.ts` | 领域 schema：项目记录、全局设置、三个状态值 |
| `src/client/index.ts` | 浏览器入口：注入分组、设置卡片、选择弹窗 |
| `src/client/spec-picker.tsx` | 规范选择 / 上传 / 删除对话框 |
| `src/vendored/` | 官方 client 源码副本 + **60 条登记的 patch**（见其 [README](src/vendored/README.md)） |
| `scripts/` | 探针与校验；`DESIGN.md` 说明每个脚本证明了什么 |
| `CHANGELOG.md` | 每个版本对使用者可见的变化 |
| `DESIGN.md` | 架构、已核实的 harness 事实、分层计划与决策记录 |

**`pnpm check` 会跑全部 11 个校验脚本与探针（652 条断言）。**
另有 `pnpm probe:doc-spec`（131 条浏览器端到端断言）需要**真实 DSH 与可用端口**，
故不在默认链上——改动注入或设置界面时应手动跑一次。

`verify:release` 专门守住发布相关的事实：版本号在三处一致、`locale` 描述与功能同步、
两版 README 结构对等、`files` 会打包到新增文件、以及没有误提交的 `.tgz`。

### 发布

`prepublishOnly` 就是 `pnpm check`，而其中 `verify:bundle` 会**读取本机已安装 DSH 的
`app.asar`**，用来对比产物解析的 external。

**⇒ 发布要在装了 DSH 的机器上做**；否则那个脚本找不到 `app.asar`，会以退出码 2 中止
（也可手动把官方 `lib/client.js` 的路径作为参数传给它）。

```bash
# 1. 改版本号：package.json 的 version + CHANGELOG.md 加一段
# 2. 全量门禁
pnpm check
# 3. 提交并打 tag
git commit -am "chore: release vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push && git push --tags
# 4. 发布（prepublishOnly 会再跑一次 check）
npm publish
```

## 维护这份 fork

`src/vendored/` **起点**是上游 `packages/client/ui-workspace/src/`（`dsh-v0.1.7-rc.2`）
的逐字节副本，**但现在已不再逐字节一致**：项目分组需要分组缝，
现有 **60 条结构性 patch、涉及 11 个文件**。当前来源版本是 **0.2.0-rc.2**。

每一处都满足同一条不变量——**不传即等官方行为**——并且全部登记在
[`src/vendored/README.md`](src/vendored/README.md) 的 patch 表里。
**那张表就是重同步时的唯一清单**，也是"重新同步 = 复制 + 逐条重打"的依据。

DSH 升级就是重新同步的信号：官方包与整条 harness 线同版本号，
本插件的 `devDependencies` 钉住这份副本的来源版本。

## 许可

[MIT](LICENSE)。vendor 的源码同为 MIT，来自同一项目。
