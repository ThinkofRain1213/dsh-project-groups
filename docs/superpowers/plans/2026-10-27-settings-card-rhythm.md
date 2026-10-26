# 设置页间距对齐 UI 规范 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把设置卡从「32/40 两套间距」统一为「相邻块 24px、跨线 32px、卡片顶底 16px」，全部由 `.section` + 负边距机制产生。

**Architecture:** 卡片根改为 4 个 `div.section`，段间用现有 `div.rule` 分隔；每个 section `padding: 16px 0`，并用 `:first-child { margin-top: -12px }` / `:last-child { margin-bottom: -12px }` 吃掉首个和末个块自带的 12px。`.row` 与 `.group` 的 padding 统一为 12px，`.group` 的 gap 由 8px 改为 6px，删除 `.groupHeading`。

**Tech Stack:** TypeScript / React、CSS Modules、Playwright 真机探针。

**Spec:** `docs/superpowers/specs/2026-10-27-settings-card-rhythm-design.md`

## Global Constraints

- `.row` padding 必须是 `12px 0`（原 `16px 0`）。
- `.group` 必须是 `gap: 6px; padding: 12px 0`（原 `gap: 8px; padding: 16px 0`）。
- `.section` 必须是 `padding: 16px 0`，且带 `:first-child { margin-top: -12px }` 与 `:last-child { margin-bottom: -12px }`。
- `.groupHeading` 必须删除，⑩ 的 title/desc 提为 `.group` 直接孩子。
- **不动**字体（13/600、13/500、12/400）、颜色 token、横向间距（`.row` gap 8、`.cubeRow` gap 8、`.rowText` padding-right 48）、`.cube` padding 20/32 与 gap 4、`.injectionText` padding 12。
- **不改**任何交互与门控逻辑。
- 中文注释，遵循仓库既有风格。

## Review Focus

1. **负边距误伤嵌套元素** —— `:first-child` 若不加直接子选择器，会命中 `.group` 内部第一个孩子，把组内首块上移 12px。
2. **主开关关闭时的单段结构** —— `groups.length === 0` 时线 B 消失，⑧ 同时是首块与末块，上下各吸 12；若只写 `:last-child` 则卡片底多 12px。
3. **`injection-panel.tsx` 的 Fragment 改造** —— 它内部还有 `<>{}</>` 条件分支，包裹位置错了会多出一层或少一层 section。
4. **纯视觉改动无自动防线** —— 若不加计算样式断言，改错不会有任何东西变红。
5. **`.cube` 内部 4px 被误改** —— 那不是 title/desc 关系，不在「同一 6px」范围内。

---

### Task 1: 建立计算样式断言（先有防线）

**Files:**
- Create: `scripts/verify-settings-rhythm.mjs`
- Modify: `package.json`（新增 `verify:settings-rhythm`，接入 `check` 链）

**Interfaces:**
- Consumes: 无（纯静态读取 CSS 源码 + 断言）。
- Produces: `verify:settings-rhythm` 脚本名，Task 2/3 完成后由它守住数值。

- [ ] **Step 1: 写失败的断言**

新建 `scripts/verify-settings-rhythm.mjs`，读取 `src/client/settings-card.module.css` 源码并断言四个数值：

```js
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = await readFile(join(ROOT, 'src/client/settings-card.module.css'), 'utf8')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** 取一个类选择器的规则体，取不到返回 undefined。 */
const rule = (selector) => {
  const match = new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, 'm').exec(css)
  return match?.[1]
}

const rowBody = rule('.row')
const groupBody = rule('.group')
const sectionBody = rule('.section')

check('.row padding 是 12px 0', /padding:\s*12px\s+0/.test(rowBody ?? ''), rowBody?.trim())
check('.group gap 是 6px', /gap:\s*6px/.test(groupBody ?? ''), groupBody?.trim())
check('.group padding 是 12px 0', /padding:\s*12px\s+0/.test(groupBody ?? ''), groupBody?.trim())
check('.section padding 是 16px 0', /padding:\s*16px\s+0/.test(sectionBody ?? ''), sectionBody?.trim())
check('.section 有 :first-child 负边距', /:first-child\s*\{[^}]*margin-top:\s*-12px/.test(css))
check('.section 有 :last-child 负边距', /:last-child\s*\{[^}]*margin-bottom:\s*-12px/.test(css))
check('.groupHeading 已删除', rule('.groupHeading') === undefined)
check('.cube 的 gap 仍是 4px（未被误改）', /\.cube\s*\{[^}]*gap:\s*4px/s.test(css))

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
```

- [ ] **Step 2: 运行确认失败**

Run: `node scripts/verify-settings-rhythm.mjs`
Expected: 多条 FAIL（当前是 16px/8px、无 `.section`、`.groupHeading` 存在）。

- [ ] **Step 3: 登记到 package.json**

`scripts` 新增 `"verify:settings-rhythm": "node scripts/verify-settings-rhythm.mjs"`，并在 `check` 链里 `verify:fork-inheritance` 之后插入 `pnpm verify:settings-rhythm &&`。

- [ ] **Step 4: 提交**

```bash
git add scripts/verify-settings-rhythm.mjs package.json
git commit -m "test: 为设置页间距建立静态断言"
```

---

### Task 2: 改 CSS 数值（不碰结构）

**Files:**
- Modify: `src/client/settings-card.module.css:29-34`（`.row`）
- Modify: `src/client/settings-card.module.css:135-140`（`.group`）
- Create: `.section` 规则（放在 `.stack` 之后）

**Interfaces:**
- Consumes: Task 1 的断言脚本。
- Produces: `.section` 类名，Task 3 在 JSX 中使用。

- [ ] **Step 1: 修改 `.row` 的 padding**

`src/client/settings-card.module.css:33`，`padding: 16px 0` 改为 `padding: 12px 0`。同时更新该规则上方的注释：原注释说这是「官方 settings-row 的几何」，需补一句现在的 12px 与 `.group` 一致、是为让段内节奏统一。

- [ ] **Step 2: 修改 `.group` 的 gap 与 padding**

`src/client/settings-card.module.css:135-140`：`gap: 8px` → `gap: 6px`，`padding: 16px 0` → `padding: 12px 0`。注释补明：6px 与 `.rowText` 的 title/desc 间距同值，让「组标题 → 内容」读作一种关系而不是两种。

- [ ] **Step 3: 新增 `.section` 规则**

在 `.stack` 之后插入：

```css
/* A card segment: everything between two rules, plus the two ends.
 *
 * The padding is the whole boundary. The negative margins cancel the 12px the
 * first and last block carry of their own, so 16px here is the only source —
 * which is what makes an unruled boundary and a ruled one both 32px
 * content-to-content. */
.section {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 16px 0;
}

/* Direct children only: `.group` has its own children 12px apart, and an
 * unqualified `:first-child` would drag the group's first block up by 12px. */
.section > :first-child { margin-top: -12px; }
.section > :last-child { margin-bottom: -12px; }
```

- [ ] **Step 4: 运行断言**

Run: `node scripts/verify-settings-rhythm.mjs`
Expected: 与 CSS 相关的几条 PASS，`.section` 两条负边距 PASS，`.groupHeading 已删除` 仍 FAIL（Task 4 才删）。

- [ ] **Step 5: 类型检查与构建**

Run: `pnpm check`
Expected: 通过（`.section` 未被引用时 CSS Modules 不会报错）。

- [ ] **Step 6: 提交**

```bash
git add src/client/settings-card.module.css
git commit -m "style(settings): 行与组的间距统一为 12px，组的 gap 改 6px"
```

---

### Task 3: 卡片根改成 section 分段

**Files:**
- Modify: `src/client/settings-card.tsx:365`（`.stack` 根）
- Modify: `src/client/injection-panel.tsx:122,207`（Fragment → section）

**Interfaces:**
- Consumes: Task 2 的 `.section` 类。
- Produces: 无。

- [ ] **Step 1: 卡片根包出四段**

`settings-card.tsx` 中，在 `.stack` 内把块按注释顺序包成四个 `div.section`：

1. `① ~ ⑦`（新会话落点到每项目独立规范）
2. `⑧ ~ ⑨`（`<InjectionPanel />` 整体——它自己会输出 section）
3. `⑩`（底层工作区组）

三条 `div.rule` 保持原位，分别落在段与段之间。**注意 `pickingSpec` / `picking` / `rebuilding` 三个弹窗块不参与分段**——它们经 portal 渲染，不占卡片流。

- [ ] **Step 2: `injection-panel.tsx` 从 Fragment 改为 section**

第 122 行的 `<>` 改为 `<div className={css.section}>`，第 207 行的 `</>` 改为 `</div>`。内部那个 `<>{}</>` 条件分支保留不变——它包的是「线 B + ⑨」，需要成为同一个 section 的孩子。

- [ ] **Step 3: 运行静态断言**

Run: `node scripts/verify-settings-rhythm.mjs`
Expected: 仅 `.groupHeading 已删除` 一条 FAIL。

- [ ] **Step 4: 类型检查与构建**

Run: `pnpm check`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add src/client/settings-card.tsx src/client/injection-panel.tsx
git commit -m "style(settings): 卡片按分隔线分段落，边界由 section padding 决定"
```

---

### Task 4: 删除 `.groupHeading`

**Files:**
- Modify: `src/client/settings-card.tsx:710-713`（⑩ 的 groupHeading）
- Modify: `src/client/settings-card.module.css:219-223`（删规则）
- Modify: `src/client/injection-panel.tsx:129`（注释里提到 groupHeading）

**Interfaces:**
- Consumes: 无。
- Produces: 无。

- [ ] **Step 1: 摊平 ⑩ 的结构**

把 `<div className={css.groupHeading}>` 内的两个子元素提为 `.group` 的直接孩子：

```tsx
<div className={css.group}>
  <div className={css.groupTitle}>{t('baseTitle')}</div>
  <div className={css.desc}>{t('baseDesc')}</div>
  <div className={css.cubeRow}>…</div>
</div>
```

- [ ] **Step 2: 删除 CSS 规则**

删 `settings-card.module.css:219-223` 的 `.groupHeading`，并检查 `:763` 的注释是否还引用它、一并订正。

- [ ] **Step 3: 订正 `injection-panel.tsx:129` 的注释**

原文写「as `groupHeading` does elsewhere」，该类已不存在，改为描述实际结构。

- [ ] **Step 4: 运行全部静态断言**

Run: `node scripts/verify-settings-rhythm.mjs`
Expected: **ALL CHECKS PASSED**。

- [ ] **Step 5: 门禁**

Run: `pnpm check`
Expected: 通过。

- [ ] **Step 6: 提交**

```bash
git add src/client/settings-card.tsx src/client/settings-card.module.css src/client/injection-panel.tsx
git commit -m "style(settings): 删掉 groupHeading，底层工作区组与注入组同构"
```

---

### Task 5: 真机验证

**Files:**
- Create: `scripts/probe-settings-rhythm.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `scripts/lib/boot-dsh.mjs`、Task 1–4 的实现。
- Produces: 无。

- [ ] **Step 1: 写探针**

启动真实 DSH，打开本插件详情页，用 `getComputedStyle` 断言：

- 两个相邻 `.row` 之间（上一行 padding-bottom + 下一行 padding-top）= 24px
- `.section` 的 `paddingTop` / `paddingBottom` = 16px
- 卡片顶部到第一个 `.row` 内容的距离 = 16px
- 跨线：线上方块的 padding-bottom + 线 + 下方块的 padding-top 的合计内容距 = 32px

断言写成「读计算值与期望值相等」，不要只断言「元素存在」。

- [ ] **Step 2: 运行探针**

Run: `node scripts/probe-settings-rhythm.mjs <dshExe> <asarRoot> <临时DSH_HOME>`
Expected: 全部 PASS。

- [ ] **Step 3: 反向对照**

把 `.group` 的 `gap` 临时改回 `8px`，重新构建并跑探针。
Expected: 至少一条 FAIL。确认后恢复。

- [ ] **Step 4: 登记并提交**

`package.json` 新增 `"probe:settings-rhythm": "node scripts/probe-settings-rhythm.mjs"`。

```bash
git add scripts/probe-settings-rhythm.mjs package.json lib/
git commit -m "test(probe): 真机验证设置页纵向节奏"
```

---

### Task 6: 文档

**Files:**
- Modify: `DESIGN.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 1–5 的最终结果。
- Produces: 无。

- [ ] **Step 1: DESIGN.md 记录**

新增一节，写清：改动前 32/40 两套间距的成因（`.group` 的 gap 叠在行 padding 上）、目标模型（完整剖面）、以及**`:first-child` 负边距是《规范》没有、本项目补上的一条**及其理由。

- [ ] **Step 2: CHANGELOG 记录**

写进当前版本的已发布段（版本号已为 0.3.3）：设置页的纵向间距统一，行距 24px、跨线 32px、卡片顶底 16px。

- [ ] **Step 3: 门禁**

Run: `pnpm check`
Expected: 通过。

- [ ] **Step 4: 提交**

```bash
git add DESIGN.md CHANGELOG.md
git commit -m "docs: 记录设置页间距统一的目标模型与规范外补充"
```

---

## Self-Review

**1. Spec coverage**

| Spec 要求 | 任务 |
|---|---|
| `.row` padding 12px | Task 2 Step 1 |
| `.group` gap 6px / padding 12px | Task 2 Step 2 |
| `.section` padding 16px | Task 2 Step 3 |
| `:first-child` / `:last-child` 负边距 | Task 2 Step 3 |
| 四段结构与线 | Task 3 Step 1 |
| `injection-panel` 输出 section | Task 3 Step 2 |
| 删 `.groupHeading` | Task 4 |
| 不动字体/颜色/横向间距 | Global Constraints + Task 4 Step 1 保留 `.cubeRow` |
| 单段结构（主开关关闭） | Review Focus 2；Task 3 Step 2 的 `<>{}</>` 保留即满足 |
| 新增自动防线 + 反向对照 | Task 1、Task 5 |

**2. Step scan** —— 每步一个可核查结果。CSS 与 JSX 的改动都给了精确位置与目标值，未转写整段代码（除 `.section` 规则本身，因为它是新规则且数值由规范钉死）。

**3. Type consistency** —— `.section` 在 Task 2 定义、Task 3 使用，类名一致。`verify:settings-rhythm` 在 Task 1 定义、Task 2/3/4 复跑。

**4. Review Focus** —— 五条各有落点：1→Task 2 Step 3 的直接子选择器 + Task 5 探针；2→Task 3 Step 2 保留 `<>{}</>`；3→Task 3 Step 2；4→Task 1 + Task 5 Step 3 反向对照；5→Task 1 的「`.cube` gap 仍是 4px」断言。

**5. Proportion** —— 计划短于设计文档，无逐行转写。
