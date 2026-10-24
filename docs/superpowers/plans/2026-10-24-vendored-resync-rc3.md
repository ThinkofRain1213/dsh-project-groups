# rc.3 重同步实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `src/vendored/` 从 DSH 0.2.1-rc.2 重同步到 0.2.1-rc.3，保住全部 107 条已登记 patch，并让 `pnpm check` 与真机探针都通过。

**Architecture:** 上游 rc.3 只改了 `ui-workspace/src/client/navigation.ts` 一个源文件（+21/−20），且改动**正落在我们打过补丁的区域** —— 三方合并会产生 2 个冲突块：一个是纯注释，一个是 `startSession` 的实质重写。其余 12 个我方 hunk 自动合并干净。因此本计划的本质是：**逐块解这 2 个冲突，并采用 rc.3 的新 `initializeDraft` 判定式，同时保留我方三层回调组合与三分支路由。**

**Tech Stack:** TypeScript / cordis 4.0.5 / tsdown / zod 4.4.3 / pnpm 12.4.1 / Node 24

**Spec:** `DESIGN.md` §5 L4.5（上游同步流程）、`src/vendored/README.md`（patch 台账）

## Global Constraints

- 上游来源：`dsh-v0.2.1-rc.3`，commit `1f81c047fc48fa190a683e469daa699857e9afe8`（2026-10-23）。
- **不 bump 领域 version**：`src/spec.ts` 的 `projectDomainSpec` 保持 `version: 1`。`single` 布局拒绝版本不符的存量文件。
- **新增 setting 字段必须带 `.default(...)`**：域打开时逐条校验，缺字段会让整个文件打不开。本计划不新增字段，但改动不得破坏此约束。
- **`baseline()` 逐字段列出，不 spread `global`**：新设置必须在其中显式加一行。
- 每处 vendored patch 必须满足「**不传即等官方行为**」。
- 中文注释与中文文档；代码标识符保持英文。
- `engines.dsh` 保持 `">=0.2.1-rc.2 <0.2.2"`（已覆盖 rc.3，**不需要改**）。
- 三个 dsh peer 的区间保持不变（同上）。
- 提交信息用英文祈使句，与既有 155 个提交同风格。

## Review Focus

- **`startSession` 的草稿语义**：rc.3 引入 `whenDraftExists: 'replace' | 'append' | 'keep'`。用户从「智能体预设」入口新建会话时，若旧实现把 `clearPreviousDraft` 当唯一判据，草稿可能被意外丢弃或意外保留。→ 由 Task 3 的断言钉住。
- **带 preset 的空白会话复用**：rc.3 的 `createInWorkspace` 新增「请求了 preset 时跳过写有别的 preset 的空白」。我们的 `recentDestination` 与 `placeUnscoped` 策略若与它冲突，会出现「点项目＋却落到另一个 preset 的空白会话」。→ 由 Task 3 的断言钉住。
- **`connectBlank` 的 `reuse` 变为必填**：我方两处调用点若仍传 `undefined`，运行时会在 `reuse.agentPreset` 上抛 TypeError（typecheck 能抓，但只在严格模式下）。
- **`resolveBaseWorkspace` 三分支与 rc.3 的单路调用**：合并时若误取上游那段 32 行，我方 `'missing'` 分支会消失，表现为「底层工作区缺失时静默创建会话」。
- **探针在 rc.3 真机上的行为**：`probe-new-session-target`、`probe-ungrouped-plus`、`probe-project-plus-routing` 三个探针直接测新会话落点，是本次唯一可能暴露运行时回归的手段。

---

### Task 1: 快照与备份

**Files:**
- Create: `.agent/backups/dsh-project-groups-vendored-pre-resync-021rc3-<YYYYMMDD-HHMM>/vendored-021rc2-before-resync/`
- Modify: `.agent/backups/INDEX.md`

**Interfaces:**
- Consumes: 无
- Produces: 一个可回滚的 `src/vendored/` 完整快照；分支 `resync/vendored-0.2.1-rc.3`

- [ ] **Step 1: 建分支**

```bash
cd "C:/Users/Think/Desktop/项目/dsh-project-groups"
git branch resync/vendored-0.2.1-rc.3
git checkout resync/vendored-0.2.1-rc.3
```

期望：`git branch --show-current` 输出 `resync/vendored-0.2.1-rc.3`。

- [ ] **Step 2: 快照 vendored 整树**

```bash
STAMP=$(date +%Y%m%d-%H%M)
DEST="C:/Users/Think/.agent/backups/dsh-project-groups-vendored-pre-resync-021rc3-$STAMP"
mkdir -p "$DEST/vendored-021rc2-before-resync"
cp -r src/vendored/. "$DEST/vendored-021rc2-before-resync/"
cp package.json pnpm-lock.yaml "$DEST/"
```

期望：`$DEST/vendored-021rc2-before-resync/` 下 28 个 `.ts`/`.tsx`/`.css` 文件 + `README.md`。

- [ ] **Step 3: 在备份索引里登记一行**

编辑 `C:\Users\Think\.agent\backups\INDEX.md`，在表格末尾追加一行，列出的内容：

- 目录名：`dsh-project-groups-vendored-pre-resync-021rc3-<STAMP>\`
- 一句话说明：**rc.3 重同步前的 `src/vendored/` 完整快照**。上游 rc.3 只改 `ui-workspace/src/client/navigation.ts`（+21/−20），但落在我们 patch 过的区域。
- 独有内容：rc.2 时代 `navigation.ts`（780 行，14 hunk / +238/−32）的唯一完整副本。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: snapshot src/vendored before the rc.3 re-sync"
```

---

### Task 2: 三方合并 navigation.ts 并解冲突

**Files:**
- Modify: `src/vendored/client/navigation.ts`（780 行 → 约 790 行）

**Interfaces:**
- Consumes: Task 1 的分支
- Produces: 一份既含 rc.3 上游改动、又保住全部我方 patch 的 `navigation.ts`。后续 Task 3 依赖它编译通过。

- [ ] **Step 1: 准备三方输入**

```bash
cd "C:/Users/Think/Desktop/项目/deepseek-harness"
TMP="C:/Users/Think/.agent/temp/rc3-resync"
mkdir -p "$TMP"
git show "dsh-v0.2.1-rc.2:packages/client/ui-workspace/src/client/navigation.ts" > "$TMP/base.ts"
git show "dsh-v0.2.1-rc.3:packages/client/ui-workspace/src/client/navigation.ts" > "$TMP/theirs.ts"
cp "C:/Users/Think/Desktop/项目/dsh-project-groups/src/vendored/client/navigation.ts" "$TMP/ours.ts"
```

期望：`base.ts` 574 行、`ours.ts` 780 行、`theirs.ts` 575 行。

- [ ] **Step 2: 跑三方合并**

```bash
git merge-file -p "$TMP/ours.ts" "$TMP/base.ts" "$TMP/theirs.ts" > "$TMP/merged.ts"
grep -c '^<<<<<<<' "$TMP/merged.ts"
```

期望：输出 `2`。**不是 2 就停下来**——说明上游又改了我们没预判的区域，需要重新评估后再继续。

- [ ] **Step 3: 解冲突 1（行 82–101，纯注释）**

冲突内容是 `startSession` 的 JSDoc。**合并方式**：以我方段落为骨架（它多了 `@param beforeOpen` 与 `底层工作区` 的说明，这是上游没有的信息），把上游新措辞并入。

替换为：

```ts
  /**
   * Open the Workspace blank `connectWorkspace` resolves, so New Session returns to that blank's
   * unsent draft. A creation the Host refuses is shown through the Workspace notice and leaves the
   * selection as it was.
   * @param workspaceId - explicit target; absent resolves this plugin's
   * 底层工作区 policy, then falls back to the Host's own resolution.
   * @param beforeOpen - optional synchronous preparation for the Session that
   * lands, run once it exists and before it becomes the main view. Best-effort:
   * a flow superseded mid-navigation never opens its Session, so this does not
   * run — which is the correct outcome for an abandoned click, since nothing was
   * opened to prepare. Absent, the flow is the fire-and-forget it always was.
   * @param options - initial content, the blank's preset, and `whenDraftExists`, which decides
   * whether existing text or attachments are kept, replaced, or followed by the prompt.
   */
```

- [ ] **Step 4: 解冲突 2（行 382–495，`startSession` 的实质重写）**

这是本计划的核心。**规则：取我方 96 行为骨架，只把其中的 `initializeDraft` 判定式换成 rc.3 的版本，并保留 rc.3 新增的 `startSessionInDefaultWorkspace` 第三个参数语义。**

必须采用的判定式（逐字）：

```ts
    const initializeDraft = draftOptions !== undefined && (draftOptions.prompt !== undefined
      || (draftOptions.whenDraftExists ?? (draftOptions.clearPreviousDraft === true ? 'replace' : 'keep')) === 'replace')
```

冲突区之外、我方原本就有的这三段**必须原样保留**：

1. `announce` / `draftPreparation` / `withBeforeOpen` 三层组合（我方 patch，台账行 233/249）；
2. `resolveBaseWorkspace` 的 `'workspace'` / `'missing'` / `'official'` 三分支（台账行 257）；
3. 末尾 `placeUnscoped` 兜底与 `startSessionInDefaultWorkspace(...)` 的三参调用（台账行 242）。

**上游那 32 行里，只有下面两样要吸收，其余全部丢弃：**

| 上游内容 | 处理 |
|---|---|
| `initializeDraft` 的新判定式（含 `whenDraftExists`） | ✅ **吸收**（Step 4 第一段已给出逐字版本） |
| `agentPreset === undefined ? {} : { agentPreset }` 的最终调用形态 | ✅ 吸收（我方 `presetOptions` 具同义，保持我方写法即可） |
| `const workspace` / `sessions` / `current` / `currentWorkspaceId` / `recent` / `target` | ❌ **丢弃** —— 我方把「找哪个工作区」整个委托给 `resolveBaseWorkspace` 与 `startSessionInDefaultWorkspace`，自己算 target 会与 `底层工作区` 设置打架 |
| `if (target === undefined)` 里的 `draft.workspaceRequired` 通知 + `clearMain()` | ❌ **丢弃** —— 我方 `'missing'` 分支已用 `onBaseWorkspaceMissing` 报告同一件事，且报告的是"设置指向的工作区不存在"这个更准确的原因 |
| `const opening = this.openWorkspace(target, ...)` 的单路调用 | ❌ **丢弃** —— 我方有三条入口（显式 target / 设置指定的工作区 / 官方默认），合并成一路会丢两条 |

> **判据**：如果解完冲突后 `startSession` 函数体里出现了 `recentWorkspace(` 或 `currentWorkspaceId`，说明误取了上游那 32 行 —— 立即回退这一段重解。


- [ ] **Step 5: 确认冲突标记已清零**

```bash
grep -c '^<<<<<<<\|^=======$\|^>>>>>>>' src/vendored/client/navigation.ts
```

期望：输出 `0`。

- [ ] **Step 6: 确认我方符号一个不少**

```bash
for s in placeUnscoped onBaseWorkspaceMissing onNewSession resolveBaseWorkspace beforeOpen openNewSessionIn draftPreparation startSessionInDefaultWorkspace whenDraftExists; do
  printf '%-32s %s\n' "$s" "$(grep -c "$s" src/vendored/client/navigation.ts)"
done
```

期望：每一行计数都 ≥ 1，且 `whenDraftExists` 恰好 1（只在那条判定式里出现）。

- [ ] **Step 7: 覆盖 vendored 文件并 typecheck**

```bash
cd "C:/Users/Think/Desktop/项目/dsh-project-groups"
cp "$TMP/merged.ts" src/vendored/client/navigation.ts
pnpm typecheck
```

期望：exit 0。

---

### Task 3: 同步依赖版本并重建 lockfile

**Files:**
- Modify: `package.json`（28 个 devDependencies）
- Modify: `pnpm-lock.yaml`
- Modify: `pnpm-workspace.yaml`（若豁免表需增删）

**Interfaces:**
- Consumes: Task 2 的 `navigation.ts`
- Produces: rc.3 的依赖树；`pnpm check` 可跑

- [ ] **Step 1: 把 28 个 devDependencies 改成 rc.3**

```bash
cd "C:/Users/Think/Desktop/项目/dsh-project-groups"
node -e "
const fs=require('fs');
const p=JSON.parse(fs.readFileSync('package.json','utf8'));
let n=0;
for(const [k,v] of Object.entries(p.devDependencies||{})){
  if(v==='0.2.1-rc.2'){ p.devDependencies[k]='0.2.1-rc.3'; n++; }
}
fs.writeFileSync('package.json', JSON.stringify(p,null,2)+'\n');
console.log('replaced '+n);
"
```

期望：`replaced 28`。

- [ ] **Step 2: 确认三处版本声明未被误改**

```bash
node -e "
const p=require('./package.json');
console.log('engines.dsh =', p.engines.dsh);
for(const k of Object.keys(p.peerDependencies).filter(k=>k.startsWith('@deepseek-ai/dsh-'))) console.log(k, '=', p.peerDependencies[k]);
"
```

期望：`engines.dsh = >=0.2.1-rc.2 <0.2.2`，三个 peer 同为该区间。**若被改成 rc.3 的精确值，立即改回。**

- [ ] **Step 3: 重装依赖**

```bash
rm -rf node_modules
pnpm install --no-frozen-lockfile
```

期望：exit 0。`node_modules/@deepseek-ai/dsh-client-ui-conversation/package.json` 的 `version` 为 `0.2.1-rc.3`。

- [ ] **Step 4: 跑 typecheck 与 build**

```bash
pnpm typecheck && pnpm build
```

期望：两者 exit 0。

---

### Task 4: 更新 patch 台账

**Files:**
- Modify: `src/vendored/README.md`

**Interfaces:**
- Consumes: Task 2 的最终 `navigation.ts`
- Produces: 与新树一致的台账；下一次 re-sync 的唯一清单

- [ ] **Step 1: 实测新的 patch 足迹**

先明确**口径**——这一步不搞清楚会写错台账：

| 口径 | 数值 | 说明 |
|---|---|---|
| `git diff -U0` 的 `@@` 行数 | `WorkspaceBrowser.tsx` = **114** | 相邻的两处添加会被拆成独立 hunk |
| 台账记录（本轮之前） | 同文件 = **48** | 数的是**语义改动点**（一处编辑 = 一个） |
| `--numstat` 的增删行 | 2097 / 135 | **与台账完全一致** |

**实测结论（2026-10-24 核对）**：现台账 10 个文件的**增删行数 10/10 全对**，但 hunk 数 9/10 偏小 —— 因为台账数的是"编辑点"而非 diff hunk。两者都对，只是口径不同。

```bash
cd "C:/Users/Think/Desktop/项目/deepseek-harness"
for f in client/rows/WorkspaceBrowser.tsx client/index.ts client/tree.ts client/rows/Rows.tsx client/navigation.ts client/locales.ts client/contract/slots.ts client/rows/AnimatedRows.tsx client/shortcuts.ts client/rows/WorkspaceBrowser.module.css; do
  git show "dsh-v0.2.1-rc.3:packages/client/ui-workspace/src/$f" > /tmp/up.ts 2>/dev/null || continue
  n=$(git diff --no-index -U0 /tmp/up.ts "C:/Users/Think/Desktop/项目/dsh-project-groups/src/vendored/$f" 2>/dev/null | grep -c '^@@')
  ns=$(git diff --no-index --numstat /tmp/up.ts "C:/Users/Think/Desktop/项目/dsh-project-groups/src/vendored/$f" 2>/dev/null | cut -f1,2)
  printf '%-45s %s hunks  +%s\n' "$f" "$n" "$ns"
done
```

**期望值（rc.2 基线，2026-10-24 实测）**：

| 文件 | hunk(-U0) | 增删 |
|---|---:|---|
| `WorkspaceBrowser.tsx` | 114 | +2097/−135 |
| `index.ts` | 17 | +426/−7 |
| `tree.ts` | 16 | +220/−6 |
| `Rows.tsx` | 15 | +121/−8 |
| `navigation.ts` | 14 | +238/−32 |
| `locales.ts` | 4 | +119/−0 |
| `slots.ts` | 6 | +314/−4 |
| `AnimatedRows.tsx` | 6 | +39/−1 |
| `shortcuts.ts` | 4 | +11/−1 |
| `WorkspaceBrowser.module.css` | 4 | +426/−0 |

rc.3 只有 `navigation.ts` 会变，其余 9 个应当**与上表逐字相同**。


- [ ] **Step 2: 更新 Provenance 表**

把这三行改成：

| | |
|---|---|
| Version | **0.2.1-rc.3** |
| Commit | `1f81c047fc` (`dsh-v0.2.1-rc.3`) |
| Re-synced | 2026-10-23 (from `687f282e86` / `dsh-v0.2.1-rc.2`, itself from `1600d8a1e1` / `dsh-v0.2.1-rc.1`, …) |

`Patch footprint` 行按 Step 1 的实测值重写。**注意用 `Edits` 口径**（即现在表里那个数字体系），
并如实标注 rc.3 带来的变化：`navigation.ts` 的 Edits 7 → 8，Added 238 → 约 250（Step 1 实测）。


- [ ] **Step 3: 统一台账的 hunk 口径**

现台账写 `client/navigation.ts | 7 | 238 | 32`。**增删行数是准的**（实测 238/32），hunk 数不是 —— 实测 `-U0` 下是 14。

同样地，其余 8 个文件的 hunk 数也偏小（`WorkspaceBrowser.tsx` 台账 48、实测 114）。**这不是错误，是口径不同**：台账数的是语义改动点，`git diff -U0` 数的是 hunk（相邻添加会被拆成多块）。

**处理**：把表头从 `| Hunks |` 改成 `| Edits |`，并在表下补一段说明，**不重算全部数字**（重算会让这次 resync 的 diff 淹没真正的内容改动）：

```markdown
| File | Edits | Added | Removed |
|---|---:|---:|---:|

> **`Edits` counts semantic edits, not diff hunks.** Measured against the same tags with
> `git diff --no-index -U0`, the hunk counts are much higher — `WorkspaceBrowser.tsx` 48
> edits against 114 hunks, `navigation.ts` 7 against 14 — because two adjacent insertions
> are one edit and two hunks. `Added`/`Removed` are exact in both readings and are what a
> re-sync should reproduce; `Edits` is the number this table has always meant.
```

**`navigation.ts` 的 `Edits` 从 7 改成 8**：rc.3 的 `startSession` 重写替换了 `initializeDraft` 表达式，加上原有的 7 处，合计 8 处语义编辑。这一处是**真实变化**，需要改。


- [ ] **Step 4: 新增一节记录 rc.3 这一步**

在 `### The 0.2.1-rc.1 → 0.2.1-rc.2 step` 之前插入：

```markdown
### The 0.2.1-rc.2 → 0.2.1-rc.3 step

Upstream touched **one file** in this directory: `client/navigation.ts`, +21 −20. It is
also one of the ten files this tree patches, so the step needed a three-way merge rather
than a copy. The merge produced **2 conflicts**:

1. **`startSession`'s JSDoc** — upstream rewrote the comment; this tree had added
   `@param beforeOpen`. Resolved by keeping this tree's parameter documentation and
   adopting upstream's new wording.
2. **`startSession`'s body** — upstream replaced the `clearPreviousDraft` shorthand with
   `whenDraftExists: 'replace' | 'append' | 'keep'`, and collapsed two `openWorkspace`
   call paths into one. This tree's version composes three callbacks (`announce`,
   `beforeOpen`, `draftPreparation`) and routes through `resolveBaseWorkspace`; the
   resolution takes this tree's 96-line body and swaps **only** the `initializeDraft`
   expression, so the new draft semantics apply without losing the composition.

Two upstream behaviour changes arrived with this step and are now live:

- **Blank reuse respects the Agent preset.** `createInWorkspace` skips a blank whose
  listed `projectionValues.agentPreset` differs from the requested one.
- **`whenDraftExists` decides what happens to an existing draft**, replacing the
  `clearPreviousDraft` boolean as the primary switch (the boolean still acts as
  `'replace'` when the new field is absent).

Everything else in `ui-workspace/src` — 27 of the 28 files — is byte-identical to rc.2.
```

- [ ] **Step 5: Commit**

```bash
git add src/vendored/README.md
git commit -m "docs(vendored): record the rc.3 re-sync and correct the navigation.ts hunk count"
```

---

### Task 5: 门禁与文档收尾

**Files:**
- Modify: `CHANGELOG.md`（若决定发版）
- Modify: `README.md` / `README.en.md`（版本要求文案，若需要）
- Modify: `DESIGN.md`（L4.5 段落）

**Interfaces:**
- Consumes: Task 2–4 的全部改动
- Produces: 一份可以发布的树

- [ ] **Step 1: 跑完整门禁**

```bash
cd "C:/Users/Think/Desktop/项目/dsh-project-groups"
pnpm check 2>&1 | tail -5
```

期望：`ALL CHECKS PASSED`，且 PASS 计数 ≥ 859。

- [ ] **Step 2: 若 `verify:release` 因 CHANGELOG 而红，按它的报错补一段**

发版时才需要。不发版则跳过。

- [ ] **Step 3: 更新 DESIGN.md 的 L4.5 段落**

在 L4.5 的同步记录里追加一行：rc.2 → rc.3，1 个文件、2 个冲突、两个上游行为变更。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: follow DSH 0.2.1-rc.3"
```

---

### Task 6: 真机验证（**需要本机 DSH 已升级到 rc.3**）

**Files:** 无改动

**Interfaces:**
- Consumes: Task 5 的最终树
- Produces: 运行时回归证据

- [ ] **Step 1: 确认本机 DSH 是 rc.3**

```bash
node -e "
const fs=require('fs');
const p=process.env.LOCALAPPDATA+'/Programs/DeepSeek Harness/resources/app.asar';
const fd=fs.openSync(p,'r');const b=Buffer.alloc(8);fs.readSync(fd,b,0,8,0);
const h=b.readUInt32LE(4);const hb=Buffer.alloc(h);fs.readSync(fd,hb,0,h,8);
const t=hb.toString('utf8');const j=JSON.parse(t.slice(t.indexOf('{'),t.lastIndexOf('}')+1));
function walk(n,path){for(const [k,v] of Object.entries(n.files||{})){const np=path+'/'+k;if(k==='package.json'&&np.includes('ui-workspace')){const sz=Number(v.size),off=Number(v.offset);const buf=Buffer.alloc(sz);fs.readSync(fd,buf,0,sz,8+h+off);console.log('ui-workspace =',JSON.parse(buf.toString('utf8').replace(/\0+\$/,'')).version)}if(v.files)walk(v,np)}}
walk(j,'');fs.closeSync(fd);
"
```

期望：`ui-workspace = 0.2.1-rc.3`。**不是 rc.3 就停下**，先升级 DSH。

- [ ] **Step 2: 跑三个直接测新会话落点的探针**

每个探针用独立空 `DSH_HOME`：

```bash
EXE="$LOCALAPPDATA/Programs/DeepSeek Harness/DeepSeek Harness.exe"
ASAR="$LOCALAPPDATA/Programs/DeepSeek Harness/resources/app.asar"
for p in probe-new-session-target probe-ungrouped-plus probe-project-plus-routing; do
  H="C:/Users/Think/.agent/temp/rc3-verify-$p"
  rm -rf "$H"; mkdir -p "$H"
  echo "=== $p ==="
  node "scripts/$p.mjs" "$EXE" "$ASAR" "$H" 2>&1 | tail -3
done
```

期望：三个都 `ALL CHECKS PASSED`。

- [ ] **Step 3: 跑其余关键探针**

```bash
for p in probe-order-mode probe-settings-card probe-doc-spec probe-cross-group probe-row-key-motion; do
  H="C:/Users/Think/.agent/temp/rc3-verify-$p"
  rm -rf "$H"; mkdir -p "$H"
  echo "=== $p ==="
  node "scripts/$p.mjs" "$EXE" "$ASAR" "$H" 2>&1 | tail -3
done
```

期望：全部 `ALL CHECKS PASSED`。任一个失败都是**运行时回归**，回到 Task 2 重新解冲突。

- [ ] **Step 4: 记录结果**

在 `DESIGN.md` L4.5 追加真机验证结论（跑了哪几个探针、各多少断言）。

---

## 回滚

任一步失败：

```bash
cd "C:/Users/Think/Desktop/项目/dsh-project-groups"
git checkout main
git branch -D resync/vendored-0.2.1-rc.3
```

`src/vendored/` 从 Task 1 的备份目录整树拷回即可。**本机运行的 DSH 不受影响** —— 改动只在仓库里，`link:` 安装要 `pnpm build` + 重启才生效。
