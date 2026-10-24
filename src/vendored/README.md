# Vendored official source — provenance and patch record

This directory is a **verbatim copy** of the official DSH sidebar workspace
browser, vendored so this plugin can own the sidebar region while keeping the
official UI 1:1.

## Provenance

| | |
|---|---|
| Upstream | `deepseek-ai/deepseek-harness` |
| Path | `packages/client/ui-workspace/src/` |
| Version | **0.2.1-rc.3** |
| Commit | `1f81c047fc` (`dsh-v0.2.1-rc.3`) |
| Re-synced | 2026-10-24 (from `687f282e86` / `dsh-v0.2.1-rc.2`, itself from `1600d8a1e1` / `dsh-v0.2.1-rc.1`, itself from `639ed01539` / `dsh-v0.2.0-rc.2`, itself re-synced 2026-09-30 from `477b4f420` / `dsh-v0.1.7-rc.2`) |
| Patch footprint | **10 files / 108 edits / 200 hunks / +4011 −192** against the upstream tag, plus one file upstream does not have (`client/session-actions/BaseWorkspaceMissing.tsx`) |

### The 0.2.1-rc.2 → 0.2.1-rc.3 step

Upstream touched **one file** in this directory: `client/navigation.ts`, +21 −20. It
is also one of the ten files this tree patches, so the step needed a three-way merge
rather than a copy. The merge produced exactly **2 conflicts**:

1. **`startSession`'s JSDoc** — upstream rewrote the comment; this tree had added
   `@param beforeOpen` and the 底层工作区 sentence. Resolved by keeping this tree's
   parameter documentation and adopting upstream's new wording.

2. **`startSession`'s body** — upstream replaced the `clearPreviousDraft` shorthand
   with `whenDraftExists: 'replace' | 'append' | 'keep'`, and collapsed two
   `openWorkspace` call paths into one. This tree's version composes three callbacks
   (`announce`, `beforeOpen`, `draftPreparation`) and routes an unscoped Session
   through `resolveBaseWorkspace` into `startSessionInDefaultWorkspace`. The
   resolution keeps this tree's 85-line body and swaps **only** the `initializeDraft`
   expression, so the new draft semantics apply without losing the composition or the
   底层工作区 branches.

Two upstream behaviour changes arrived with this step and are now live:

- **Blank reuse respects the Agent preset.** `createInWorkspace` skips a blank whose
  listed `projectionValues.agentPreset` differs from the requested one — a blank
  created under one preset is no longer handed to a request naming another.
- **`whenDraftExists` decides what happens to an existing draft**, replacing the
  `clearPreviousDraft` boolean as the primary switch (the boolean still acts as
  `'replace'` when the new field is absent).

Everything else in `ui-workspace/src` — 27 of the 28 files — is byte-identical to
rc.2. That is why `Added` is unchanged at 4011 while `Removed` drops from 194 to 192:
upstream's own edit removed two lines this tree had already deleted differently.

### The 0.2.1-rc.1 → 0.2.1-rc.2 step

**No source change at all.** `ui-workspace/src` is byte-identical between the two
tags — same 28 files, all hashes equal — so this tree did not need a merge, an
edit, or a re-derived patch table. The rc.2 release moved package **versions**
(the whole `@deepseek-ai/dsh-*` set to `0.2.1-rc.2`) without touching this
package's code.

What did move is outside this directory: the plugin's `peerDependencies` and
`devDependencies` had to follow the version bump, and the lockfile and the
`pnpm-workspace.yaml` exemptions had to be rebuilt. Verified with `pnpm check`
(845 assertions, 0 failures) and by evaluating DSH's own compatibility rule
against a `0.2.1-rc.2` runtime, which reports no unmet requirement.

A useful consequence: the patch footprint above is still the **0.2.1-rc.1**
figure, and it is also the rc.2 figure, because the upstream side of the diff did
not change. Any future count that differs means a real edit, not a version bump.

### How the 0.2.0 → 0.2.1 re-sync was done

DSH 0.2.1-rc.1 is a **large** release: `ui-workspace/src` changed 16 files,
+617 −217, and seven of them are files this tree patches. The re-sync used the
same three-way merge as the previous one, with `git merge-file`:

```
base   = upstream 0.2.0-rc.2   (git archive of the tag this tree was vendored from)
ours   = this tree             (0.2.0 + our patches)
theirs = upstream 0.2.1-rc.1   (git archive of the target tag)
```

The merge produced **23 conflicts across five files** — `rows/WorkspaceBrowser.tsx`
(10), `client/index.ts` (5), `client/navigation.ts` (4), `contract/slots.ts` (2),
`client/shortcuts.ts` (2) — while `tree.ts`, `rows/Rows.tsx`, `client/locales.ts`
and `rows/AnimatedRows.tsx` merged cleanly. Three of the conflicts were **semantic**
rather than textual, and each was resolved by letting the two designs coexist:

1. **`startSession`'s second parameter.** Upstream replaced "no second parameter" with
   `options: StartSessionOptions` (draft text, Agent preset). This plugin had already
   claimed the slot for `beforeOpen` (a project row files the Session it just created).
   Because upstream's own `openWorkspace` still keeps `beforeOpen` as *its* second
   parameter, both survive: `startSession(workspaceId?, beforeOpen?, options?)`, and the
   two compose inside one callback that `openWorkspace` runs.

2. **`installWorkspaceShortcuts`'s fifth parameter.** Upstream added
   `reportForkFailure`; this plugin had added `projectModel`. They answer different
   questions, so the function now takes both.

3. **`RowActionToast`.** Upstream rewrote it entirely, moving every notice into a new
   keyed `workspace.toast` slot with a shared Factory (`contract/toast.ts`,
   `toast/Toast.tsx`, `toast/register.ts`). This tree had never patched that file, so
   upstream's version is taken verbatim — but the plugin's own `BaseWorkspaceMissing`
   dialog stays, because it asks a question rather than reporting a notice.

Two upstream removals had to be followed through the whole tree: `dismissForkError`
disappeared from `WorkspaceBrowserInjected` (the shortcut's fork failure now travels
through the global toast), and `collapsedSessionRows` / `COLLAPSED_SESSION_LIMIT` /
`sessionLimits` were replaced by the watermark model (`watermarkRows`,
`SESSION_WATERMARK_BASE`, `SESSION_WATERMARK_AUTO_MAX`). Every reference in the
patched regions moved with them.

**Four files upstream added** and this tree now carries: `client/contract/toast.ts`,
`client/toast/Toast.tsx`, `client/toast/register.ts`, `client/session-actions/SessionId.tsx`.
The tree deliberately does **not** carry upstream's top-level `src/index.ts`: that file
is the plugin's empty node half, and this plugin's own `src/index.ts` is the real Host
half, so copying it would shadow ours.

### How the 0.1.7 → 0.2.0 re-sync was done

Upstream changed only **145 lines** in this package (`19 files changed, 145 insertions(+),
46 deletions(-)`), of which **7** are files this tree patches (`client/shortcuts.ts` among them).
Rather than re-applying the patch table by hand, each file was three-way merged with `git merge-file`:

```
base   = upstream 0.1.7-rc.2   (git archive of the tag we vendored)
ours   = this tree             (0.1.7 + our patches)
theirs = upstream 0.2.0-rc.2   (git archive of the target tag)
```

**All 10 patched files merged with zero conflicts**, and the result was verified in both directions:
upstream's 8 changes present, our 17 patch anchors intact. Two files needed attention beyond the
merge — `index.ts` (`forkSession` gained an `onCreated` observer and a `productAnalytics` call) and
`navigation.ts` (the same signature change) — and all three test fixtures gained a `title` field,
because `sessionTitle` reads the durable title rather than `displayTitle` as of 0.2.0. Upstream made
the same fixture change in its own `tree.client.spec.ts`, which is what confirmed the fix.

`devDependencies` moved to `0.2.0-rc.2` together with a new
`@deepseek-ai/dsh-client-product-analytics`. It is read with the ungated `ctx.get('productAnalytics')`
and imported as `import type {}`, exactly as upstream does, so it adds no bundled edge — `verify:bundle`
confirms the produced externals still match the installed official bundle name for name.

> **Reinstalling matters.** `pnpm install` over an existing `node_modules` left the 0.1.7 packages in
> `.pnpm`, so two copies of `dsh-typert-protocol` resolved and `tsc` failed with a `RemoteFailure`
> mismatch on two `DirectoryBrowseError` lines — code that is upstream's verbatim. Deleting
> `node_modules` and reinstalling resolved it; the lockfile itself was already clean.
>
> The 0.2.1 re-sync hit the same failure with a different pair. `zod` was declared `^4.4.3`, which
> resolves to the newest 4.x (`4.6.5`), while DSH 0.2.1's own packages pin it **exactly** to
> `4.4.3` (`@deepseek-ai/dsh-typert-registry` declares `zod: "4.4.3"`, no caret). Two resolved
> copies made every `defineDomain` / `domainTable` call a type error, with the mismatch reported
> across `$ZodCheck` internals. The fix is the same shape as upstream's: declare `zod` **exactly**,
> not with a caret. `cordis` had to move `4.0.1 → 4.0.5` in the same pass, because 0.2.1's packages
> peer on `~4.0.5`.

Copied files (27 — upstream's 28 minus its top-level `index.ts`, which this plugin supplies itself):

```
client/index.ts
client/navigation.ts
client/shortcuts.ts
client/stores.ts
client/tree.ts
client/pin-order.ts
client/locales.ts
client/contract/slots.ts
client/contract/toast.ts
client/toast/Toast.tsx
client/toast/register.ts
client/rows/Rows.tsx
client/rows/Rows.module.css
client/rows/AnimatedRows.tsx
client/rows/AnimatedRows.module.css
client/rows/WorkspaceBrowser.tsx
client/rows/WorkspaceBrowser.module.css
client/session-actions/ArchiveSession.tsx
client/session-actions/ForkSession.tsx
client/session-actions/PinSession.tsx
client/session-actions/RenameSession.tsx
client/session-actions/RowActionToast.tsx
client/session-actions/SessionId.tsx
client/session-actions/derived.ts
client/WorkspacePicker.tsx
client/WorkspacePicker.module.css
css-modules.d.ts
```

Plus one file upstream does not have — `client/session-actions/BaseWorkspaceMissing.tsx`, the
dialog a click opens when the configured base Workspace is gone. It is this plugin's own, not a
patch, so a re-sync copies nothing over it.

## Why vendored

The official package does not export its component, and every data seam that
could have let us swap behaviour underneath it is closed by an explicit
invariant — see `scripts/probe-approach-b.mjs` for the reproduction:

1. `ctx.slots.provideRoot` rejects a duplicate root standard hook
   (`useWorkspaces`), so the browser's data source cannot be replaced.
2. `ctx.provide` / `ctx.set` refuse a second provider for the `workspaces`
   service, so the controller cannot be replaced.
3. A replacement entry cannot re-declare the browser's child slots
   (`…session.menu.item` etc.), and `renderSlot` is authorised per entry, so it
   cannot render the official actions either.

Keeping the UI 1:1 therefore means owning a copy of it.

## De-branding

The vendored tree started as a **byte-identical copy** of upstream — verified by
hash, file by file, against `packages/client/ui-workspace/src/` at
`dsh-v0.1.7-rc.2`. It is no longer byte-identical: project grouping needed a
grouping seam, and the patches below are it. Every one is **structural and
optional**: with no override supplied, the code behaves exactly as upstream.

Most adaptation still lives *outside* this directory:

| Where | Adaptation | Reason |
|---|---|---|
| `src/client/index.ts` | wrapper that re-exports `apply` / `inject` and passes the grouping observable | gives project logic one seam to hook, and keeps the loader id this plugin's |
| `tsdown.config.ts` | specifier classification and the CSS Modules virtual loader | builds the tree as an independent plugin rather than as an official package |
| `cordis.patch.yml` | disables the official `ui-workspace` row | two claimants of the single slot, and two providers of `uiWorkspace`, would be a hard startup error |

### Patches inside this directory

Kept minimal and listed here so a re-sync is mechanical. Each is marked in the
source with a comment naming the seam.

**Measured footprint after the 0.2.1-rc.3 re-sync** (diffed against `dsh-v0.2.1-rc.3`,
per file, with `git diff --no-index -U0`):

| File | Edits | Hunks | Added | Removed |
|---|---:|---:|---:|---:|
| `client/rows/WorkspaceBrowser.tsx` | 48 | 114 | 2097 | 135 |
| `client/index.ts` | 12 | 17 | 426 | 7 |
| `client/tree.ts` | 12 | 16 | 220 | 6 |
| `client/rows/Rows.tsx` | 11 | 15 | 121 | 8 |
| `client/navigation.ts` | 8 | 14 | 238 | 30 |
| `client/locales.ts` | 4 | 4 | 119 | 0 |
| `client/contract/slots.ts` | 4 | 6 | 314 | 4 |
| `client/rows/AnimatedRows.tsx` | 4 | 6 | 39 | 1 |
| `client/shortcuts.ts` | 3 | 4 | 11 | 1 |
| `client/rows/WorkspaceBrowser.module.css` | 2 | 4 | 426 | 0 |
| **Total** | **108** | **200** | **4011** | **192** |

> **`Edits` and `Hunks` are two counts of the same diff, and the table needs both.**
> `Edits` counts semantic edit points — what this table has always meant. `Hunks` is what
> `git diff -U0` emits, and it is higher because two adjacent insertions are one edit but
> two hunks: `WorkspaceBrowser.tsx` is 48 edits and 114 hunks. `Added`/`Removed` are exact
> under both readings and are what a re-sync should reproduce. Before rc.3 only `Edits`
> was recorded, under the column name `Hunks`; both are now stated so neither number can
> be mistaken for the other again.
>
> Neither total equals the number of rows in the patch list below: that list is
> **76 rows** describing intents, and one row routinely covers several edits. The 108 is
> a diff measurement, the 76 is a seam inventory. They are not meant to match.
>
> `navigation.ts` moved from 7 to 8 edits and from −32 to −30 removed because rc.3
> rewrote the `startSession` body in a way that deletes two fewer lines.

The count grew from 75 to 108 edits not because features were added but because
upstream **rewrote** the regions this tree patches: `WorkspaceBrowser.tsx` alone went from a
handful of edits to 48 once the watermark model and `HoverCardGroup` landed inside the
same functions. The table below still describes **intent** — one row per seam — and is what a
re-sync re-applies; the counts above are what a re-sync should reproduce.

| File | Patch | Re-sync action |
|---|---|---|
| `tree.ts` | adds `GroupSource`, `owningSourceKey`, and `groupBySource` (a line-for-line twin of `groupByWorkspace`); `deriveGroups` takes an optional 6th `sources` parameter | re-apply on top of the new `groupByWorkspace` |
| `tree.ts` | `deriveSearchResults` takes an optional 9th `sources` parameter and labels a result row from it, so a search result names its project the way the tree does; the `sources === undefined` branch is upstream's, unchanged (see below) | add the parameter, the `groupBySession` map, and the branch in `labelOf` |
| `contract/slots.ts` | adds a mandatory `grouping` hook to `WorkspaceBrowserInjected.hooks`, plus the `GroupSource` type import | re-add the one field + import |
| `contract/slots.ts` | adds a mandatory `createOpensSession` hook to the same `hooks` block, and `createProject` returns `{ projectId }` rather than `void` (both **behaviour-relevant**, see below) | re-add the hook field and the return type |
| `client/index.ts` | `ProjectActions.createProject` returns `{ projectId }` rather than `void`, and `apply` takes a sixth `createOpensSessionOverride` argument threaded into that hook | re-add the return type, the parameter, and its two defaults |
| `shortcuts.ts` | `installWorkspaceShortcuts` takes a fifth argument, `projectModel: boolean`; with it the `workspace.add` command is relabelled and re-aliased to the project dialog (`project.add` / `new project`) and its directory-flow availability check is skipped (**behaviour change**, see below). Called with `false`, every branch is upstream's | re-add the parameter and the three `projectModel` branches; the call site is `client/index.ts` (`projectActions !== undefined`) |
| `rows/WorkspaceBrowser.tsx` | consumes `useGrouping`, threads `groupingOverride` into `SessionTree`, uses it for `ungroupedMemberIds` / `expandedGroups` / the two `owningGroupKey` call sites | re-apply the same six edits |
| `rows/WorkspaceBrowser.tsx` | `onCreate` drops its `if (group.workspaceId !== undefined)` guard and always expands (**behaviour change**, see below) | remove the guard again |
| `rows/WorkspaceBrowser.tsx` | `onCreate` files what a row creates: a project row under itself through `assignSession`, the Ungrouped bucket under **nothing** through `unassignSession` (see below) | re-apply the three-way `file` dispatch |
| `rows/WorkspaceBrowser.tsx` | the header's create dialog opens a Session after adding a caller-supplied project — the official add-workspace flow — filing it under the new project and gated on the `createOpensSession` hook (**behaviour change**, see below) | re-apply the `startSession` call, the hook read, and the closed-dialog ordering |
| `rows/WorkspaceBrowser.tsx` | expansion is routed by key ownership: caller-supplied keys go through `setProjectExpanded` / `projectExpansion`, every other key through the view store (see below) | re-apply `isCallerOwned` / `recordExpansion` / `hasExpansion` and the merge in `expandedGroups` |
| `rows/WorkspaceBrowser.tsx` | caller-supplied groups get the same two-mode member ordering the Workspace rows get, from `orderedProjects` + the `orders` hook; `commitSessionDrag` resolves a caller key after the Workspace lookup; `saveSessionOrder` and the order menu dispatch by key ownership (see below) | re-apply `orderedProjects` / `allProjectOrders`, the `?? groupingOverride?.find(...)` in `commitSessionDrag`, and the two dispatches |
| `rows/WorkspaceBrowser.tsx` | a Session can be dragged **between** groups: `DragState.overGroupKey` names the target, a row drop is positional and a header drop is not, and `commitCrossGroupDrag` files it through `assignSession` / `unassignSession` before writing the order (see below) | re-apply `overGroupKey`, `canReceiveDrag`, `insertIntoTargetOrder`, `commitCrossGroupDrag`, and the `groupDrop` wiring |
| `rows/Rows.tsx` | a Session row's `dragover` / `drop` call `stopPropagation`, so the row is the target rather than the enclosing group section; `ProjectRowItem` takes an optional `groupDrop` that makes the **header row** — not the section — the cross-group hit target (the highlight stays on the section, painted by the region) | re-add the two calls and the `groupDrop` prop and handlers |
| `tree.ts` | under a grouping override the Ungrouped bucket always renders, empty included — it is the drop target that takes a Session back out of a caller-supplied group (see below) | re-apply the `archivedFilter !== 'only'` alternative |
| `navigation.ts` | `startSession` takes an optional `beforeOpen` callback and threads it into `openWorkspace`, so a caller can act on the Session that lands (a project row files it). Omitted, the flow is unchanged | re-add the parameter and the pass-through |
| `navigation.ts` | **the `startSession` body composes upstream's draft preparation with this tree's three callbacks.** rc.3 changed the `initializeDraft` expression to honour `whenDraftExists`; this tree keeps that expression verbatim and wraps `openWorkspace`'s single `beforeOpen` so `announce` / `beforeOpen` / `draftPreparation` all run. A re-sync must merge these two, not pick one: taking upstream's 26-line conflict block drops `resolveBaseWorkspace` and `placeUnscoped`; taking this tree's body unchanged loses rc.3's draft semantics | re-apply the composition **and** keep upstream's `initializeDraft`, then re-check that `recentWorkspace` / `currentWorkspaceId` / `draft.workspaceRequired` did not come in with it |
| `rows/WorkspaceBrowser.tsx` | rename/delete dialogs and the group drag take a `kind`-tagged row (`RowRequest`), so a caller-supplied project row drives the same affordances as a Workspace row; the header's add control runs `createProject` when the composition supplies one, and the dialog titles/labels switch on that kind | re-apply the dispatch, the two dialog blocks, and the drag wiring |
| `rows/WorkspaceBrowser.tsx` | a **project** drop resolves its anchor against `groupingOverride`'s order and honours the side the marker showed, so the landed position equals the line the user saw (see below) | re-apply the `projectIds` lookup, the `half` from `activeDrag.over`, and the next-sibling anchor |
| `rows/WorkspaceBrowser.tsx` | a **project title is unique**: the create dialog blocks a name another project holds, the rename dialog does too, and the rename alert names the row kind it is warning about (see below) | re-apply `createDuplicate`, the `kind === 'project'` arm of `renameDuplicate`, and the `conflict.projectNamed` dispatch |
| `locales.ts` | `conflict.projectNamed` in both dictionaries | add the key |
| `rows/Rows.tsx` | labels the Ungrouped bucket by **empty label** rather than missing `workspaceId` | one-line change; a caller-supplied group has no Workspace id but does have a label |
| `rows/Rows.tsx` | the row menu's delete label and the menu's aria-label follow `group.kind` | small change; a project's delete removes a record, not a registry entry |
| `locales.ts` | project copy (`project.add`, `project.create.*`, `rename.project.title`, `delete.project*`, `field.projectName`, `create`, `actions.project.aria`) in both dictionaries | add the keys |
| `navigation.ts` | `startSession` without a target resolves the Host's default Workspace instead of guessing (**behaviour change**, see below) | restore the shipped guess, or re-apply |
| `navigation.ts` | the service takes an optional `placeUnscoped` callback, applied only when `beforeOpen` is absent, so the caller can file an unscoped New Session (**behaviour change**, see below) | re-add the parameter and the `beforeOpen ??` composition |
| `index.ts` | `apply` takes an optional `groupingOverride`, an optional `ProjectActions`, and optional `expansionsOverride` / `ordersOverride`, forwarding all into the inject face | re-add the parameters and the hook/verb fields |
| `rows/Rows.tsx` | adds `sessionRowKey(id)`: a Session row's animation identity is the Session itself (`session:<id>`), kept as one shared constructor so the ordered `rowKeys` array and the rendered attribute cannot drift | re-add the helper and its doc block |
| `rows/Rows.tsx` | `SessionNodeItem` takes an optional `rowKey`, and its `data-row-key` is `rowKey ?? sessionRowKey(node.id)` | re-add the prop and the fallback |
| `rows/WorkspaceBrowser.tsx` | the grouped view passes `sessionRowKey(node.id)` twice — into `rowKeys` and into the row's `rowKey` — in the same order | re-apply both call sites together |
| `rows/AnimatedRows.tsx` | takes `enteringKeys` / `onEnteringKeysDrawn`: a New Session that **reuses a blank Session** keeps its row key, so its entry fade is announced instead of inferred (**behaviour change**, see below) | drop both props and the `arriving` branch |
| `contract/slots.ts` | adds `newSessionLanded` to `WorkspaceBrowserInjected['hooks']`: `{ sessionId, seq } \| null`, the Session every New Session flow landed on, sequenced because the reused blank re-announces one id | drop the field |
| `navigation.ts` | the service takes an optional `onNewSession` callback, called from `startSession` for every entry, composed with `beforeOpen` rather than replacing it (**behaviour change**, see below). Omitted, the flow is unchanged | re-add the parameter and the two compositions |
| `contract/slots.ts` | adds `BaseWorkspaceMissingRequest` / `BaseWorkspaceDialogInjected` / `BaseWorkspaceDialogProps`: the report a New Session raises when its 底层工作区 is gone | re-add the three declarations |
| `navigation.ts` | the service takes an optional `onBaseWorkspaceMissing` callback, raised where `startSessionInDefaultWorkspace` previously returned silently (**behaviour change**, see below). Omitted, the flow is unchanged | re-add the parameter and the one call |
| `session-actions/BaseWorkspaceMissing.tsx` | **new file**: the `shell.overlay` dialog that reports that case and offers the two repairs | re-add the file and its `shell.overlay` registration |
| `locales.ts` | six `baseMissing.*` keys in both dictionaries, kept in one contiguous block rather than editing a shipped key | re-add the block |
| `rows/WorkspaceBrowser.module.css` | `.groupDropTarget`: the cross-group highlight painted on the group **section** while the pointer is on the header row (hit testing and highlight answer different questions; the section is the highlight's, the row is the target's) | re-add the one rule |
| `rows/WorkspaceBrowser.module.css` | `.baseMissingActions` (the column footer), `.baseMissingBody`, `.baseMissingPath` | re-add the three rules |
| `contract/slots.ts` | adds `BaseWorkspaceRoute`: which of three outcomes the caller's 底层工作区 setting resolved to | re-add the union |
| `navigation.ts` | the service takes an optional `resolveBaseWorkspace` callback, consulted by an unscoped `startSession` **before** the official default (**behaviour change**, see below). Omitted, the flow is unchanged | re-add the parameter and the two branches |
| `index.ts` | `ProjectActions` gains an optional `resolveBaseWorkspace`, passed as the constructor's last argument | re-add the field and the pass-through |
| `session-actions/BaseWorkspaceMissing.tsx` | the 重新指定底层工作区 button now consumes the report and calls `chooseBaseWorkspace`, handing the user to the settings card | re-add the `settle()` before the call |
| `session-actions/BaseWorkspaceMissing.tsx` | the 重建该工作区 button's action is live (step 3b) | re-add the `run(rebuild)` call |
| `session-actions/BaseWorkspaceMissing.tsx` | **two stages in one dialog**: pressing 重建该工作区 switches this card to a confirmation stage (warning icon, the path, 确认重建/返回) rather than opening a second `Modal` | re-add the `stage` state, the focus effect, and both footer branches |
| `locales.ts` | the confirmation's five keys in both dictionaries; the single `baseMissing.rebuildHint` is gone, its sentence having moved into the confirmation | re-add the five keys |
| `rows/WorkspaceBrowser.module.css` | `.baseMissingConfirm` / `.baseMissingConfirmIcon` | re-add the two rules |
| `contract/slots.ts` | `BaseWorkspaceDialogInjected.chooseBaseWorkspace` is documented as wired (step 3a); the type is unchanged | no code change beyond the doc |
| `tree.ts` | `GroupSource` gains an optional `directories`, and `sameStringList` is exported | re-add the field and the helper |
| `contract/slots.ts` | `WorkspaceBrowserInjected` gains `updateProject?` and `pickDirectory?`, and `createProject` takes a required `directories`; `renameProject?` is **gone** | re-add the two verbs, change the one signature, drop `renameProject` |
| `client/index.ts` | `ProjectActions` mirrors the above (`updateProject`, optional `pickDirectory`, `createProject` with `directories`, no `renameProject`), and `browserInjected` forwards them | re-apply the four signature changes and the forwarding block |
| `rows/WorkspaceBrowser.tsx` | the project rename dialog becomes an **edit** dialog: it seeds a `renameDirectories` draft from `RowRequest.directories`, renders the shared `DirectoryRows` / `DirectoryHeader`, and commits through `updateProject`; `renameBlocked` compares the list as well as the title (**behaviour change**, see below) | re-apply the target field, the two state values, the two helpers, the comparison, and the block |
| `rows/WorkspaceBrowser.tsx` | the create dialog collects source folders: `createDirectories` / `pickingCreateDirectory`, `openCreate` resets the list, and `confirmCreate` sends it | re-apply the two state values, the reset, the helper, the block, and the send |
| `rows/WorkspaceBrowser.tsx` | `RowRequest`'s project arm gains an optional `directories`, and the group header's rename action resolves it from `groupingOverride` | re-add the field and the lookup |
| `rows/WorkspaceBrowser.tsx` | adds the `DirectoryRows` / `DirectoryHeader` components and imports `IconCloseOutlineRegular` | re-add both components and the icon import |
| `rows/Rows.tsx` | the row menu's rename label follows `group.kind` (项目 rows say 编辑项目) while the menu **id** stays `rename` | reuse the label dispatch |
| `locales.ts` | `edit.project`, `edit.project.title`, `save`, `field.directories`, `directory.add`, `directory.none`, `directory.remove` in both dictionaries | add the keys |
| `rows/WorkspaceBrowser.module.css` | `.directoryBlock` / `.directoryHeader` / `.directoryLabel` / `.directoryEmpty` / `.directoryList` / `.directoryRow` / `.directoryPath` | re-add the block |
| `rows/WorkspaceBrowser.module.css` | `.directoryDialog.directoryDialog` widens the project dialogs past the shipped 380px card to **480px** — short of the official directory browser's 680px, which read as loose for a name field plus a few paths — using the same doubled-class specificity trick the official directory browser uses; `.directoryRow` is transparent until hover, matching the official `.row` | re-add the rule and the hover pair |
| `rows/WorkspaceBrowser.tsx` | both project dialogs pass `className={css.directoryDialog}`; the add control is the shell `Button` (`variant="ghost" size="sm" icon={<IconPlusOutlineRegular/>}`) and the remove control reuses this file's own `css.iconButton` — a bare `<button>` keeps the browser's native chrome | re-apply the two classNames, the `Button`, the `iconButton`, and the `IconPlusOutlineRegular` import |
| `rows/WorkspaceBrowser.tsx` | a `DocSpecRow` component (the per-project document-spec `Menu`) rendered by both project dialogs only while `perProjectDocSpec && injectProjectDoc && injectProjectInfo` — the same three-way gate the settings card uses; the list is fixed as `跟随全局 / 无 / 默认 / uploaded files…` with 跟随全局 as its own first row (the only row written as `null`), and no divider; `RowRequest` carries an optional `docSpec`, `RenameTarget` a `storedDocSpec`, and both dialogs keep a `renameDocSpec`/`createDocSpec` draft reset on open | re-add the component, the three-way gate, the two fields, and the two drafts |
| `tree.ts` | `GroupSource.docSpec?: string` — the per-project spec override, absent meaning "inherit the global choice" | re-add the field |
| `contract/slots.ts` | `hooks.perProjectDocSpec`, `hooks.injectProjectInfo`, `hooks.injectProjectDoc`, `hooks.specs`; `createProject` takes `docSpec`; `updateProject` takes a fourth `docSpec` argument; `uploadSpec` / `deleteSpec` / `specsUsedBy` verbs | re-add the four hooks, the extended signatures, and the three verbs |
| `client/index.ts` | the `DocSpecHooks` bundle threaded into `apply` as one trailing argument, defaulting each observable to the schema's answer (`false` for the two gates, so a composition without the feature hides the row) | re-add the interface, the parameter, and the four defaults |
| `tree.ts` | `GroupSource.links?: readonly string[]` — the project's associated URLs, absent meaning "none supplied" | re-add the field |
| `contract/slots.ts` | `hooks.validateLinks`; `createProject` takes `links`; `updateProject` takes a fourth `links` argument (before `docSpec`) | re-add the hook, the field, and the two signatures |
| `client/index.ts` | the `LinkHooks` bundle threaded into `apply` as a second trailing argument, defaulting `validateLinks` to `false` so a composition without the switch marks nothing | re-add the interface, the parameter, and the default |
| `rows/WorkspaceBrowser.tsx` | the create and edit dialogs collect a link draft (`createRows` / `renameRows`) as `LinkRowDraft[]` — a row's **id** plus its url, rendered by new `LinkHeader` / `LinkRows` / `LinkRow` components; `RowRequest` and `RenameTarget` each carry the stored list, and `renameBlocked` compares it (**behaviour change**, see below) | re-apply the components, the two state values, the two target fields, the comparison, and both blocks |
| `rows/WorkspaceBrowser.tsx` | link rows are keyed by `LinkRowDraft.id`, **not** by index and not by url. The draft carries ids that `linkUrls` drops at the two commit sites, so the protocol and the stored record keep plain strings. Keying by index made a removal hand every later component the next row's value — it re-checked text nobody had touched, and for one frame showed a verdict belonging to another row | re-add `LinkRowDraft`, `newLinkRow`, `linkUrls`, and the `key={row.id}` |
| `rows/WorkspaceBrowser.tsx` | **the only place this tree runs a debounced check**: `useLinkCheck` marks a row after 0.5s of no typing, showing a spinner while typing, a green check while valid *and* focused, and an amber ⓘ while invalid. Measured against the installed DSH, **no official component does this** — see the deviation note below | re-add `LinkCheck`, `useLinkCheck`, and `countInvalidLinks` |
| `rows/WorkspaceBrowser.tsx` | a freshly added link row takes focus (`LinkRow`'s `autoFocus` + the parent clearing its marker), and any empty row adds a **quiet** notice to the header (`countBlankLinks`, `.linkBlankCount`). The two are independent: the notice never consults focus, while the auto-focus is there so the user can type straight away | re-add the marker state, the focus effect, and the notice |
| `rows/WorkspaceBrowser.tsx` | `useSettledUrls` returns the url each row has **concluded on**, keyed by its id, rebuilt wholesale when the interval expires. The failing count counts a row only while `settled.get(id) === row.url`, which is what stops it reporting a value nothing has judged and stops it keeping a failure whose text is gone. The blank count reads the **live** draft instead, because emptiness is a fact and must not wait for a judgement — the two notices are deliberately on different clocks | re-add `useSettledUrls`, both count functions and their `LinkBlock` wiring |
| `rows/WorkspaceBrowser.tsx` | `LinkBlock` owns the link header, its rows and the state they share, and is mounted **with the dialog** — the official `Modal` returns `null` while closed. That is what keeps the header's settled snapshot from outliving the rows: with the hook at the dialog's top level, reopening a project skipped the wait and opening another showed the **previous** project's count | re-add the component and use it in both dialogs |
| `rows/WorkspaceBrowser.tsx` | imports `isValidLink` from `../../../protocol.ts` — the rule is shared with the Host half rather than reimplemented here | re-add the import |
| `locales.ts` | `field.links`, `link.add`, `link.none`, `link.remove`, `link.invalid`, `link.countInvalid`, `link.countBlank` in both dictionaries, in one contiguous block | re-add the block |
| `rows/WorkspaceBrowser.module.css` | `.linkBlock` / `.linkHeader` / `.linkHeading` / `.linkLabel` / `.linkInvalidCount` / `.linkBlankCount` / `.linkEmpty` / `.linkList` / `.linkRow` / `.linkField` / `.linkInput` / `.linkStatus` / `.linkValid` / `.linkInvalid` — the trailing-status slot the official `Input` does not offer (`position: relative` wrapper + `padding-right`), and the two-notice header whose alignment lives on the container | re-add the block |

Two invariants keep these patches honest:

1. **Absent override = upstream behaviour.** `deriveGroups(..., undefined)`
   takes the untouched `groupByWorkspace` path, and the browser's `grouping`
   observable defaults to `undefined` (override inactive). Automated:
   `scripts/verify-grouping.mjs` and `scripts/probe-grouping-seam.mjs`.
2. **Grouping is a derivation, never data.** Nothing here writes Workspace
   membership, `cwd`, or archive state; the Host is untouched by construction.

### Deliberate behaviour deviations

These are **not** structural seams: they change what the shipped code does.
They are listed apart so a re-sync does not silently drop them, and so an
upstream behavioural change is not mistaken for a merge conflict.

**1. New Session without a target goes to the default Workspace.**

Shipped: an unscoped `startSession()` guessed — the current Session's Workspace,
then the most recently used one — and cleared the selection when neither
existed. Now it resolves the Host's default Workspace through
`initializeDefault` (a pure read once the registry records one), and with no
default it does nothing: no guess, no cleared selection.

Rationale: every Session this plugin creates lives in that one Workspace, so the
destination should not depend on whatever the user last did.

Which **project** that Session joins is then a second question, and it belongs to
the caller: `startSession` takes an optional `placeUnscoped` callback, and when it
is present an unscoped call routes the landed Session through it. The callback is
given the new Session and the one the user was looking at; the caller owns the
project model and decides. Absent, the Session is left where the default Workspace
resolution put it.

This is the one place every unscoped entry converges, which is why the seam is
here rather than in the browser: the shell's New Session button and its shortcut,
and any plugin that starts a Session without a target, all reach it. A row's own
＋ never does — it states its destination through `beforeOpen`, and `beforeOpen`
wins.

**2. The Ungrouped bucket's ＋ button works.**

Shipped: `Rows.tsx` rendered the button unconditionally while
`WorkspaceBrowser.tsx` guarded its handler with `group.workspaceId !== undefined`,
so on the Ungrouped bucket (and on any group without a Workspace id) the button
rendered and did nothing. The same component guards its row menu, hover card and
drag wiring on that same field, so the missing guard reads as an oversight rather
than a decision — and one upstream test pins the inert behaviour
(`packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx`,
"…its ＋ is inert"), which is why it has survived.

Consequence for re-sync: that upstream test asserts the opposite of what this
copy does. Expect it to fail against our tree; it is not a regression.

Making the button work was not enough on its own. Its handler sent **no**
`beforeOpen` callback, which made the click indistinguishable from an unscoped one
— the shell's New Session button, whose destination the caller's policy decides.
The click then resolved the default Workspace, reused the blank Session already
sitting there, and inherited whatever project that Session had been filed under.
Since every project shares one Workspace (a project has no directory), using any
project's ＋ once was enough to make the Ungrouped ＋ create under that project
from then on.

So `onCreate` now states the destination for both rows: a project row files under
itself through `assignSession`, the Ungrouped bucket files under nothing through
`unassignSession`, and a real Workspace row — which predates projects — files
nothing at all. The third branch is unreachable in this composition (the override
is always an array, so the region always groups by source) but is kept explicit so
that composing this browser *without* an override cannot silently unassign a real
Workspace's Session.

**3. A caller-owned group's expansion is stored by the caller, not here.**

Shipped: every group's expansion lives in this browser's view store, which is
persisted to `dsh.workspace.view.v5`. The official plugin persists to the **same
key**, and its mount calls `retainAccountKeys` with the Workspace ids and the two
browser-local accounts — pruning every key it is not handed. That pruning is
correct for the official plugin's own data; it is fatal for a caller-supplied
group, whose key is not a Workspace id. A project's remembered expansion was
therefore deleted the first time the official sidebar mounted, which is exactly
what switching this plugin off does. Reloading alone did not lose it, which is
why the symptom looked intermittent.

The region now routes expansion by key ownership: a key the caller supplies goes
to the caller through `setProjectExpanded` and is read back from the `expansions`
hook, while every other key keeps using the view store exactly as upstream. The
two records cannot collide, because a caller-owned key is never written here.

This is why `expansions` is a **mandatory** hook with a default rather than an
optional one: the renderer binds hooks from the observable's identity, so a
composition without this state supplies an observable answering an empty record,
and with no verb alongside it every key resolves to the view store — upstream
behaviour, unchanged.

An earlier attempt kept the key in the view store and taught retention about it.
That was reverted: it left the caller's state in the official plugin's key space,
which is the coupling this design exists to remove. The measured account of that
attempt is in `DESIGN.md` under L2c.

**4. Caller-supplied groups order their members like Workspace rows do.**

Shipped: member position inside a group comes from `orderedWorkspaces` /
`orderedUngroupedSessionIds` / `orderedFlatSessionIds`, keyed by Workspace id, and
`commitSessionDrag` looks a dragged row's group up among Workspace ids — so a
caller-supplied group's key resolved to nothing and its drags committed no order.
The rows could be dragged and showed an insertion marker; releasing did nothing.

`orderedProjects` mirrors the same two-mode computation for caller-supplied
groups, reading their order from the `orders` hook instead of the view store, and
`commitSessionDrag` now resolves a caller key after the Workspace lookup. The
three shipped orderings are untouched, and `activeSessionOrders` deliberately
still excludes caller groups, so the two effects that reconcile blank-session
pinning and manual orders never see them.

The dispatch is by key ownership, as with expansion:

  - a caller-owned key writes through `setProjectOrders`;
  - every other key — a Workspace, and the Ungrouped bucket — keeps using
    `setSessionOrder` and the view store, exactly as upstream.

Because recency ordering needs no record (a member without one falls back to
`updatedAt`), the mode's lifecycle is expressed in the caller's store too: picking
manual writes every group's current order (freezing them), and picking recency
writes an empty map (discarding them). Without the freeze the menu would read
"manual" while an untouched group kept re-sorting itself.

Nothing else inside `src/vendored/` should be edited. A behaviour change that is
not one of the seams above belongs in `src/client/`.

**5. A Session can be dragged between caller-supplied groups.**

Shipped: a Session drag never leaves its group. `compatibleTarget` requires the
drag's account key to equal the group's, so a row in another group does not even
`preventDefault` the event, and the group section's `onDragOver` is `undefined`
unless a **Workspace-row** drag is in flight.

Two drop paths, and they mean different things:

  - **on a row** — a positional drop. The Session is filed, inserted at that
    position, and the view switches to manual ordering, which is upstream's rule
    for any sort gesture.
  - **on the header row** — a drop *into* the group. Under recency nothing is
    stored: the member has no saved position, so `reconcileManualOrder` derives one
    from `updatedAt`. Under manual it goes to the front, the one position a header
    drop can name.

The target is the header **row**, not the enclosing group section: the section is
taller than its children — it owns the 2px `margin-top` between each pair — and
covers the space beside them, so accepting a drop there would let a Session land in
a group from a pointer nowhere near a drop position. That is the flash seen while
dragging past a project.

The **highlight**, though, is painted on the whole group (the section). Hit testing
and highlight answer different questions here: the row is what can be dropped on,
the group is what the drop means. Painting the highlight on the row says the wrong
thing, and painting the *target* on the section is the bug above — so the two are
deliberately split. `GroupDropProps` therefore carries no `active` flag: the region
already holds the state and paints the section from it.

`DragState.overGroupKey` carries the target, and `over === null` distinguishes a
header drop from a positional one — which is why `commitSessionDrag`'s second
parameter is now nullable. Filing goes through `assignSession` /
`unassignSession`, and the order through the same key-ownership dispatch the
same-group path uses. With either verb absent, `canReceiveDrag` is false and the
region behaves exactly as upstream.

Three supporting changes:

  - a Session row's `dragover` / `drop` `stopPropagation`, so the row wins over
    the enclosing group section (which would otherwise replace the positional
    marker with a group-level target);
  - the header's `groupDrop` asserts the target on `dragover`, not only on
    `dragenter`. Both enter and leave also fire when the pointer crosses a *child*
    of the row (the folder glyph, the chevron, the title) and they bubble, so
    moving within the header would fire a `dragleave` that cancelled a highlight
    the pointer never left. Asserting on the continuously-firing `dragover` makes
    the state self-correcting; the setter is idempotent so those events do not
    re-render;
  - the Ungrouped bucket always renders under an override, because it is the drop
    target that takes a Session back out of a project. `groupByWorkspace` keeps
    the shipped strays-only rule, and the archived-only view still hides an empty
    bucket.

**6. A Session row's animation key is the Session; a New Session is announced separately.**

Shipped: a Session row's `data-row-key` is `session:<id>`, and `AnimatedRows` reads
that attribute to decide, per commit, whether a row is new (entry fade) or merely
moved (glide). Upstream gets away with a key that says nothing about the group,
because a Session's group there is its Workspace — assigned at creation and never
re-filed — so a row never changes group at all. Here it does: every project shares the
one default Workspace (a project has no directory), and the blank New Session is a
single Session the front end re-files between projects.

An earlier patch folded the group into the key (`session:<id>@<groupKey>`) so that
re-filing became a different key, which `AnimatedRows` renders as an exit-and-enter
fade. **That was wrong and has been reverted.** The key cannot answer the question it
was being asked to answer: a New Session and any other re-filing change the key in
exactly the same way, so the same mechanism that faded "A's ＋ then B's ＋" also faded
**deleting a project** (its Sessions lose their group and drop into Ungrouped) and
**"Ungrouped's ＋"** (which returns a Session to no project) — cases where the official
sidebar glides. The two are indistinguishable from the key alone, and no rule over
"same id, different group" can separate them, because the *cause* differs while the
key change is identical.

So the key is identity again — `sessionRowKey(id)` is `session:<id>` — and the one case
that genuinely is an arrival is stated rather than inferred:

- **A New Session fades.** Every entry that starts one passes through
  `UiWorkspace.startSession`, which calls an optional `onNewSession(sessionId)`; the
  browser turns that into `enteringKeys` for `AnimatedRows`. A Session that is actually
  new would fade on its own (its key is absent from the previous commit), but a New
  Session that **reuses the blank Session** is already in the tree under its old group —
  so without the announcement it would glide, which is the bug this replaces.
- **Everything else glides.** A drag, a deletion, a return to Ungrouped: the row is the
  same row in a new place, which is what the official sidebar draws.

The announcement carries a sequence number because the common case announces the *same*
id twice (the blank is reused); a store compares by value, so without it the second
arrival would read as no change. `AnimatedRows` reports back through
`onEnteringKeysDrawn` once the commit that drew the fade has run, so a later scroll or
expansion does not re-fade the row.

`blank` is deliberately **not** folded into the key: a blank New Session becoming
real stays in its group, so its key does not change and the row is patched in place
with **no** animation. That is what upstream does, measured as one surviving DOM
node with zero movement and zero fade, and folding `blank` in would replace it with
a cross-fade on every first prompt.

The flat "In one list" view needs no change: its rows have no group to change, and it
now builds the same string upstream does by construction rather than by omission.

Both call sites must agree — `rowKeys` (the ordered array `AnimatedRows` diffs) and
the row's own `data-row-key` — because the two are paired by position. They call the
same helper for that reason. `scripts/probe-row-key-motion.mjs` asserts all five
transitions, including that a cross-group drag **glides**; the reverted version failed
that check and the deletion case it stands for.

**7. A New Session with no resolvable Workspace says so.**

Shipped: `startSessionInDefaultWorkspace` returns as soon as the default Workspace
cannot be resolved, so clicking New Session did **nothing at all** — no Session, no
notice, no navigation. The failure notice in `RowToast` does not cover this case: it
belongs to the *throwing* path (`initializeDefaultWorkspace`'s `catch`), while a
deleted registration makes `initializeDefault` return `undefined` rather than throw.
The host-lookup test pins that notice, so it stays.

Now the service raises an optional `onBaseWorkspaceMissing` callback at that point,
and the region answers it with a dialog: the missing path, then the two repairs —
re-create the Workspace, or choose another one. Step ① of the rollout wires neither
repair, so the dialog renders both buttons **disabled** and 取消 is the only live
action. That is deliberate: a button that appears to work and does nothing is the
very bug this change removes.

The path comes from the Host (`projectGroups/defaultWorkspacePath`), because it starts
at the OS Documents folder and no browser can read that. It is filled in *after* the
dialog opens — the report is raised synchronously by the failing click, and a
`powershell.exe` spawn must not delay the dialog — so the dialog shows "path unknown"
for one beat when the Host answers. `src/default-workspace.ts` explains why the
official derivation is reimplemented rather than imported (its subpath is not in the
package's `exports`).

Layout: the actions are a **column**, not the shared `Modal` footer's right-aligned
row. Three equal row actions get about 77px each in the default card, which is less
than 「重新指定底层工作区」 needs; a column gives each the card's full width. The
official plugin-manager dialog does the same (`.installFooter { flex-direction: column }`).

**8. An unscoped New Session lands where the caller says.**

Shipped: `startSession()` without a target resolves the Host's default Workspace, and
that was patch 2 above. This patch adds a step **before** it: if the caller supplies a
`resolveBaseWorkspace`, its answer decides.

The callback returns a three-member union, and the third member is the point. "Use the
official default" and "the setting names a Workspace that is gone" both end up not
opening a specific Workspace, so an `workspaceId | undefined` return could not tell them
apart — collapsing them would either silence the report or make the healthy path shout.
`'missing'` therefore raises `onBaseWorkspaceMissing` with `mode: 'specified'` (the report
typed `'specified'` from the start; this is the patch that finally produces it) and
creates **nothing**. Falling back to the official default would be indistinguishable from
the setting being ignored, which is the defect the whole feature exists to fix.

Which entries reach this: every one that states no destination — the shell's New Session
button and its shortcut, `ui-schedule`, `ui-agent-preset`, **and a caller-supplied group's
own ＋**. That last one is easy to miss and is measured: `tree.ts` builds those groups
with `workspaceId: undefined`, so a project row's ＋ takes this same branch (confirmed by
watching `workspace/initializeDefault` fire on that click). The routing therefore also
applies to a project's ＋ and the Ungrouped bucket's ＋.

`beforeOpen` rides through on the `'workspace'` arm, which is what lets a Session land in
the chosen Workspace **and** still be filed: a project's ＋ files it under that project,
while the shell's button applies the caller's placement policy. Returning early there
would create the Session and drop the filing.

Omitted, the flow is byte-for-byte the shipped one — that is the "plugin off, official
behaviour" guarantee. `startSessionInDefaultWorkspace` is untouched, so the
`defaultWorkspaceFailed` notice and the host-lookup test that pins it are unaffected.

**9. The missing-workspace report hands off to the chooser.**

The dialog's 重新指定底层工作区 button used to render disabled: it needed a chooser, and the
chooser lives on this plugin's settings card, in another package. This patch wires it —
`settle()` first, then `chooseBaseWorkspace` — so the report does not follow the user to
the other page and stack over the dialog they are being sent to.

The navigation itself is the caller's (see `src/client/index.ts`): the plugin manager
publishes `pluginNavigation.openBundle(name)`, which does `selectPanel('plugins')` and
`setView({ kind: 'package', name })` in one call, measured to mount our card from a
third-party cordis fiber. Two details of that service are worth recording, because both
change how it must be reached:

- it is published from **inside the manager's page slot** and disposed with it
  (`ctx.reflect.provide` followed by a `yield` disposer, a couple of hundred characters
  inside a `slots.register` body), so declaring it in `inject` would gate the whole plugin
  on a service that comes and goes. The ungated `ctx.get` is the read;
- the official voice-input plugin's `inject: ['pluginNavigation']` is a **sub-fiber**
  (`ctx.inject([...], registerUi)`), so it is not a pattern that transfers to a plugin
  which must keep working without the manager.

Opening the chooser is a second handoff, dialog → card, and it rides a snapshot store
rather than a prop because the card generally mounts **after** the request: `openBundle`
navigates, the card is created by that render. A snapshot read returns live state, so a
card mounted later still sees the request, and consuming it (setting `null`) is what stops
**10. 重建该工作区 becomes live, and asks before it writes.**

The dialog's other repair lands in step 3b: the button's action now exists, and because it
creates a directory — in `'default'` mode the official default Workspace's own directory — it
asks first.

The confirmation is a **second stage of this card**, not a second `Modal`, and that is
deliberate: measured, two modals would both sit at `z-index: 1000` and each installs its own
document-level Escape and Tab handler, so one Escape would close both and the focus trap could
escape outward. Switching the content of one card gets the confirmation with none of that.
Escape on the confirm stage therefore steps **back** rather than dismissing: the user declined
the confirmation, not the attempt, and dismissing would make them click New Session again to
get back.

Focus survives the switch for a reason worth recording, because the obvious reasoning is wrong.
`Modal` focuses `data-modal-autofocus` in an effect keyed on `[dialog, open]`, which a stage
switch does not re-run — so it looked necessary to move focus by hand. It is not, today: both
stages render `div > Button, Button`, so React reconciles by position and the first button is
the same DOM element throughout (marked it in one stage, found the mark on the other, still
focused). The explicit move stays as insurance against that structure changing — reorder the
footers and the reuse stops — and the probe's focus assertion passes either way, which is
recorded rather than presented as proof.

**11. A project drop lands where its marker showed.**

Dragging one project onto another put the insertion line above the hovered row but released the
row below it. Two independent causes, both in the **project** branch (upstream has no projects, so
neither is a deviation from it):

- **`'after'` meant "append to the end".** The branch passed `undefined`, and the Host's `reorder`
  reads `beforeId === undefined` as `rest.length` — last. So a marker drawn under a project landed
  the row at the bottom of the list unless that project was already last. The Workspace branch
  resolves `'after'` to the next sibling; the project branch now does too, and `anchor === rowId`
  is skipped because the Host filters the moving id out first and would reject it as unknown.
- **The committed side was recomputed instead of the one shown.** `drop` fires at release, so
  movement across the row's mid-point after the last `dragover` flips `workspaceGroupHalf`'s
  comparison — and the commit clears the drag state before React repaints, so the line the user saw
  is already gone and the row lands on a side that was never marked. The project branch now honours
  `activeDrag.over.half` when that marker names the same row.

Both fixes are **scoped to the project branch on purpose.** The recomputation is upstream's own
`dropWorkspace`, and this repo's session path depends on re-reading live state rather than a closed
one ("a handler's closed state can predate the last `dragOver`"). Changing it for Workspace or
Session rows would deviate from upstream and re-open the staleness it exists to avoid, so those
paths are untouched.

A probe drives both scenarios against the running app and asserts the landed order, not just the
marker; each reverse control fails exactly its own two checks, landing on `B,C,A,D` and `B,C,D,A`
respectively — the two wrong positions the report describes.

**12. A project title is unique, like a Workspace title.**

Upstream enforces uniqueness twice, and only one of the two transfers to projects:

- the registry indexes Workspaces by **canonical path**, so choosing an existing directory reuses
  that row instead of registering a second one. A project has no directory — "a project is a
  Workspace without one" — so there is nothing to collide on and this rule does not apply;
- the rename dialog refuses a title another row holds (`workspaces.some(w => w.workspaceId !==
  renameTarget.workspaceId && w.title === renameTrimmed)`). This one applies directly, and both the
  create and rename dialogs were missing it, which is how two projects titled `abc` came to exist
  and be indistinguishable in the tree and in search.

The client check is a convenience, not the guarantee: the Remote is reachable without the dialog, so
the Host refuses a duplicate title as well. That is also why the dialog's exclusion of *itself* is by
id (`source.key !== renameTarget.id`) rather than by title — the same identity exclusion upstream
performs, so a project can keep the name it already has instead of being locked out of it.

The rule is exact and case-sensitive, matching upstream's `===`, and applied after trimming because
the trimmed title is what gets stored. Being stricter in the Host than in the dialog would refuse a
name the dialog had already accepted.

The alert names the row kind: the shipped `conflict.named` says 工作区, which is right for a
Workspace and wrong for a project, and one dialog serves both.

**13. A search result names its project, like the tree does.**

Search was grouped the same way the sidebar is, but its rows were not labeled that way. The result
row's context line came from `deriveSearchResults`, which reads only the Workspace registry —
`workspaceBySession.get(id) ?? workspaceLabel(summary.cwd)` — so with projects active every result
was captioned with a Workspace the sidebar never shows (`默认工作区`, and a real one named `重要`).
The same `labelOf` also feeds the match test, so a project's Sessions could not be found by the
name the user had given them.

The fix is the same seam the grouping already uses: an optional 9th `sources` parameter, and a
`labelOf` that picks a model rather than merging them. The two branches are exclusive on purpose —
with sources supplied the Workspace registry is **not** consulted, because this plugin replaces the
Workspace model rather than layering on it, and an unfiled Session is labeled empty so the renderer
localizes it exactly as the tree's Ungrouped bucket does. Falling back to a Workspace title would
reintroduce the mismatch this patch removes, and `scripts/verify-grouping.mjs` asserts that no row
carries a Workspace title or a cwd basename while groups are supplied.

Omitted, the parameter takes upstream's exact path, so the invariant above still holds: an inactive
override behaves byte-for-byte like the shipped browser.

**14. The add-workspace shortcut becomes the add-project shortcut.**

Shipped: `installWorkspaceShortcuts` registers `workspace.add` labelled 添加工作区 with the aliases
`add workspace` / `open folder`, and resolves it by checking the
`sidebar.workspaces.directoryFlow` picker slot — the command is *blocked*, with a reason, when no
picker is mounted.

Under a project model that check is meaningless: there is no directory to pick, because a project has
no directory, so the slot's presence says nothing about whether the command can run. The command is
therefore relabelled (`project.add`, aliases `new project`) and routed straight to the create-project
dialog, skipping the availability check entirely. Called with `false`, all three branches fall back to
the shipped ones — the parameter is the seam, and the check is only bypassed where the model exists.

The flag is passed as `projectActions !== undefined` at the single call site
(`client/index.ts`), so the composition decides by supplying the verbs rather than by a second
switch that could disagree with them.

Which key is bound is **not** part of this patch: upstream moved `session.rename` from `primary+alt+R`
to `primary+alt+G` in 0.2.0 and this copy followed, so a re-sync should take upstream's keymap as
given and re-apply only the label, aliases and the bypassed check.

**15. Adding a project also opens a Session in it, the way adding a Workspace does.**

Upstream's add-workspace flow is two steps, not one: `WorkspacePicker` calls
`createWorkspace({ path })` and then hands the new id to `onPick`, which runs
`startSession(workspaceId)` (`WorkspaceBrowser.tsx`). The user lands in a Session they can
type into rather than in an empty sidebar. This copy's header dialog did only the first
step, so adding a project left the cursor where it was.

The fix follows upstream with the one substitution a project forces: a project has no
Workspace id, so the target is the caller's base workspace and the filing rides
`beforeOpen` — exactly the call a project row's `＋` already makes. Without that filing the
Session would land in whatever project the reusable blank Session happened to belong to.

Two consequences are deliberate:

- **The flag is a hook, not a constant.** `createOpensSession` is a mandatory observable on
  the inject face, defaulting to `false` for a composition with no project model (where the
  dialog returns early anyway) and supplied from the user's own setting otherwise. The
  switch lives on the plugin's settings card and is stored in its domain, so the value
  survives a restart instead of being reinterpreted per launch.
- **A blank Session moves rather than accumulating.** Upstream's `reuseOrCreateBlank` keeps
  one blank Session per Workspace, and every project here shares one Workspace. Creating a
  second project therefore moves the blank to it — which is upstream's own behaviour for a
  second Workspace, and is pinned by `probe-recent-blank.mjs` and
  `probe-two-project-plus.mjs`. It is **not** a defect introduced here.

**16. A link row validates as the user types.**

Shipped: nothing in this tree — or anywhere in the installed DSH — validates an input while it
is being edited. A whole-asar scan for a debounce sitting next to input-and-validity semantics
found no candidate, so there was no precedent to copy and this is written from scratch:
`useLinkCheck` in `rows/WorkspaceBrowser.tsx`.

The behaviour, decided by the user rather than inferred from a precedent:

- typing shows a spinner (it is **checking**, not yet answering);
- 0.5s without a change runs the check;
- a passing link shows a green check **only while the row has focus**;
- a failing link shows an amber ⓘ **regardless of focus**, with the rule in its tooltip;
- an empty row shows nothing — at once, with no spinner — and the switch being off removes all
  states at once, in-flight timer included;
- **emptiness and a verdict take different clocks** (user's decision, 2026-10-09). Empty is a
  **fact** — visible in the input box, unable to be wrong — so it is applied the moment it is true.
  Passing and failing are **judgements**, which can be wrong while the user is still typing, so
  only those wait. The earlier version ran all three on one interval, which made a fact wait for a
  judgement: clearing a row left its ⓘ spinning for half a second and its failure counted for half
  a second after the text was gone.

Three details are load-bearing and easy to "fix" wrongly:

- **The visible state is derived, not stored.** The focus rule lives on the return value, which is
  what stops a focus change from overwriting a verdict that just landed. A focus gain deliberately
  does **not** re-run the check — an earlier version made it a dependency, and `focused` as a
  dependency meant a **blur** re-ran the check too, showing a spinner for half a second where the
  amber ⓘ is specified to stay. Nothing is lost: only an edit can change a verdict.
- **A verdict is stored with the value it judged** — `{ url, mark }`, not a bare mark. That single
  pairing is what makes a verdict expire on its own: when the value changes, the old verdict is not
  a stale answer to be cleared later, it is simply not a verdict **about this row** any more. A
  bare mark meant the render that changed the value still painted the previous one, and an effect
  corrected it a pass later. This is also what answers "reward early" (Baymard's *Remove Error
  Messages as Soon as the Field Is Corrected*): editing a failing row drops the failure in that
  same pass.
- **The rows are keyed by their own id** — neither the value nor the position. The value is what
  the user is editing, so keying on it remounts the row and drops focus on every keystroke
  (measured: `2) 输入后立刻是转圈 — none`). The position is no better, and worse in a way that is
  hard to see: a link's check runs off its **value**, so a removal keyed by index hands each later
  component the next row's value — it re-checks text nobody touched, and for one frame it paints
  the verdict that belonged to the value it used to hold. With a passing row above a failing one
  that frame reads as **passing** while the text is `not a url` (measured: `["none","invalid"]` →
  `["none"]` for ~17ms). Rows therefore carry an id that `linkUrls` drops at the commit sites, so
  nothing leaves the client. **The id is also what lets the header key its settled snapshot by row**
  (`useSettledUrls`), without which a removal would make the count read another row's verdict.

This is a **visible departure** from the official 1:1 interface, which is why it is recorded
here rather than treated as a seam. `probe-project-links.mjs` pins it against a real browser.

**A second, smaller departure lives in the same block: the header's second notice.**

An empty row is announced as `{n} 行为空，保存时忽略` — **dimmed, not amber**. The amber invalid
count asks the user to act; this one asks for nothing, because the row is dropped on save either
way. The two colours keep "needs attention" and "nothing to do" apart, and
`probe-project-links.mjs` asserts they differ with both on screen (measured: `rgb(245,158,11)`
vs `rgb(129,133,140)`).

Two details were each got wrong once and are worth stating plainly.

**It is driven by emptiness — not by focus.** The first version announced a row only after the
user had *left* it, which meant a row was reported as dropped later than it became droppable. The
user's rule is that a row is empty or it is not; a freshly added row therefore reads as blank at
once. The focus bookkeeping that the old rule needed — a type, two pieces of state, two resets,
two pass-throughs and two handler bindings — existed for that rule and nothing else, so it is gone.
The per-row green check keeps its own focus rule and must **not** be swept up with it: it is shown
only while focused, which is the official `ModelRow` behaviour and is deliberately unchanged. Note
that a focus gain no longer **re-runs** the check — the verdict is already right, and only an edit
can change it — so the focus handlers are display-only now. The **auto-focus** of a newly added row
is likewise unaffected; it is there so the user can type straight away.

**The colour was changed from `label-dimmed` to `label-tertiary`.** The first choice measured
**1.45** against the dark dialog surface: present, and effectively invisible — which is how the
user found it. `label-dimmed` is the wrong *category* of token here, not merely too dark: of its
14 uses in the installed DSH, every one is `:disabled` or `::placeholder`, so it means "not
interactive", not "quiet". `label-tertiary` is what the official styles use for quiet
explanatory text (367 uses) and measures **6.53** dark / **3.71** light. The light figure is below
AA for 12px text — accepted knowingly, since the failure the user actually hit was invisible in
dark, and this token is legible in both. A "different from amber" assertion passes happily on an
invisible colour, so the probe now measures **contrast against the surface**, in both themes.

**The count is derived, never accumulated.** The first version kept a set of row indices that
rows added themselves to on blur, and cleared it whole on removal on the theory that "the next
blur will redo it". A blur only happens when focus actually moves: after a removal focus sits
on the delete button, nothing re-blurs, and the notice vanished for every remaining blank row
and never returned. Asking "which rows are empty *right now*" (`countBlankLinks`) needs no
bookkeeping at all — removal, typing and reopening cannot stale it, because none of them is
remembered in the first place.

**A third departure in the same block: three layers, not one time line.**

The header summarised the raw draft while the rows debounced, so on the first keystroke it
announced `1 条链接未通过校验` while the row it named still spun — the same value called failing by
one control and unjudged by the other (measured: 450ms of disagreement on every check). An earlier
patch made it wait, then patched that again to skip the wait on blank transitions, then patched
*that* so the two notices came from one pass. Each patch was correct and the next one was needed
anyway, because all three shared a premise: **the rows and the header ran separate time lines from
separate sources.**

The premise was wrong, not just the implementation (user's decision, 2026-10-09):

- **Layer 1 — emptiness is a fact.** Visible in the input box, unable to be wrong, so it is applied
  the moment it is true: no spinner, no wait. The row's mark, the failing count and the blank
  notice all move in that same pass.
- **Layer 2 — a verdict is a judgement.** It can be wrong while the user is still typing, which is
  the only reason to wait, so passing and failing take `LINK_CHECK_DEBOUNCE_MS` and show a spinner.
- **Layer 3 — correction is automatic.** A verdict is stored with the value it judged
  (`{ url, mark }`), so when the value changes the old verdict is not a stale answer awaiting
  cleanup — it is not a verdict about this row any more. This layer is a consequence of the
  invariant, not code: **a verdict is only valid for the value it was reached for.**

The one interval for all three is what the previous versions had, and it was wrong in the expensive
direction: it made a **fact** wait for a **judgement**, so clearing a row left its ⓘ spinning for
half a second and its failure counted for half a second after the text was gone. Baymard's usability
testing names the second half directly — an error left after the field is corrected makes users
*"misinterpret their newly corrected, and now valid, input to still contain an error"*.

- **The header keys the settled snapshot by row id.** `useSettledUrls` returns the url each row has
  concluded on, rebuilt wholesale when the interval expires, and the failing count counts a row only
  while `settled.get(id) === row.url`. That one comparison is the whole rule: a value just typed has
  no verdict, so it cannot be reported as failing (the count used to lead the rows), and a value
  just cleared is no longer the judged one, so its failure disappears at once (the count used to lag
  them). It replaced `useSettledLinks` and `headerShouldWait`, which held the whole previous list
  and decided when to hold it — machinery for keeping two notices in step that is not needed when
  there is no stale number to hold.
- **The blank notice reads the live draft, not the snapshot**, because it is a fact and must not
  wait for a judgement. The two notices are deliberately on different clocks; that is the departure.
- **`isBlankLink` lives in `protocol.ts`** and `nonBlankLinks` uses it, so the storing side, the
  blank count and the row's own idle verdict cannot describe emptiness differently.
- **The hook lives in `LinkBlock`, which mounts with the dialog.** The official `Modal` returns
  `null` while closed, so the header's memory cannot outlive the rows it describes. With the hook
  at the dialog's top level it did: reopening a project skipped the wait and reported a count
  before anything was checked, and opening another project showed the **previous** project's count
  for the whole wait. Mounting them together also removed five hand-written resets and two
  `autoFocus` markers that existed only because the state outlived the dialog.

⚠️ **This is the `edited` ref's inverse.** It is gone: it existed only to tell a row **born** blank
from one the user **emptied**, and under layer 1 both are simply empty. Re-adding it, or making a
blank value wait again, reintroduces the single-time-line defect — `7c) 清空后行内不转圈` and
`7o) 清空全程没有任何一行转圈` both fail, the second showing the frame where the row starts spinning
*after* the count and the notice have already moved.

`probe-project-links.mjs` pins all of it. Its timing sections sample the mark and the count **in one
pass**, and the three-layer section records the mark **and both notices in every frame** — asserting
either alone passes while the other is stale, which is how the earlier versions shipped. Its
open-dialog sections install a `requestAnimationFrame` recorder **before** the dialog opens, because
a snapshot taken after an open sees only the settled state; an earlier version of that assertion
passed with the leak present.

## Keeping it in sync

Upstream ships this package at the same version as the whole harness line, so a DSH upgrade is the
signal to re-sync. The plugin's `devDependencies` pin the version the copy came from, and the
provenance table above records it.

This is the procedure the 0.1.7 → 0.2.0 re-sync actually used. The tree is **no longer
byte-identical** (see the patch table), so a re-sync is a merge, not a copy.

### 1. Stage the three versions

Both tags must be available; the checkout's working tree is not what gets read.

```bash
H="path/to/deepseek-harness"          # the upstream git checkout
git -C "$H" fetch origin tag dsh-vX.Y.Z-rc.N --no-tags
git -C "$H" archive dsh-v0.1.7-rc.2 packages/client/ui-workspace | tar -x -C /tmp/base
git -C "$H" archive dsh-vX.Y.Z-rc.N packages/client/ui-workspace | tar -x -C /tmp/theirs
```

`/tmp/base` is the tag recorded in the provenance table — **not** the previous target. Getting this
wrong turns every one of our patches into a conflict.

### 2. Read what upstream changed before merging anything

```bash
git -C "$H" diff --stat dsh-v0.1.7-rc.2 dsh-vX.Y.Z-rc.N -- packages/client/ui-workspace
git -C "$H" diff -U0   dsh-v0.1.7-rc.2 dsh-vX.Y.Z-rc.N -- packages/client/ui-workspace/src
```

For 0.2.0 this was 145 lines across 7 of our patched files. Cross-check each `@@` hunk against the
patch table below: a hunk landing in a file the table names is the one that needs a decision, and
everything else is mechanical.

### 3. Three-way merge every patched file

Do **not** `git merge` — this repo and upstream share no history. Merge per file instead:

```bash
for f in <the patch table's files>; do
  cp "$OURS/$f" "$OUT/$f"
  git merge-file -p "$OUT/$f" "/tmp/base/$f" "/tmp/theirs/$f" > "$OUT/$f"
done
```

`git merge-file` exits non-zero with markers left in the file when hunks collide. In 0.2.0 all nine
merged cleanly; the two that needed hand work were signature changes
(`forkSession(sessionId, onCreated?)`) that the merge could not resolve on its own because both sides
had rewritten the same lines.

### 4. Verify both directions, then the whole suite

The merge is only trustworthy once both halves are shown to have survived:

- **upstream's changes landed** — grep the target's distinctive identifiers;
- **our patches survived** — grep this table's seams;
- `pnpm install` (see the reinstall warning above), `pnpm typecheck`, `pnpm build`;
- `pnpm check` — 354 assertions, of which `compare-bundle.mjs` fails loudly if the produced
  externals no longer match the installed official bundle;
- the browser probes in the section below, each on its own `DSH_HOME`.

### 5. Update this file

Provenance table, the patch table, and `devDependencies`. A patch that moved but was
not recorded here is one the next re-sync will silently drop — which is the whole reason the table
exists.

## Verifying the deviations

Three of them are behavioural and cannot be seen from a unit test, so they have
browser probes that drive a live instance. They are run by hand rather than by
`pnpm check`, because each needs a booted server:

| Probe | What it drives | Why it is not in `check` |
|---|---|---|
| `scripts/probe-browser-console.mjs` | loads the UI and fails on any page error | needs a booted instance |
| `scripts/probe-browser-flow.mjs` | creates a project, files a Session, reloads, deletes | needs a booted instance |
| `scripts/probe-plugin-toggle.mjs` | boots **both** profiles itself and switches between them | spawns servers on a fixed port |
| `scripts/probe-project-reorder.mjs` | drags one Session over another inside a project | spawns a server |
| `scripts/probe-order-mode.mjs` | switches the order menu and reads the Host's stored records | spawns a server; **needs an empty `dshHome`** (it asserts the arriving state) |
| `scripts/probe-cross-group.mjs` | drags Sessions between projects and out to Ungrouped | spawns a server |
| `scripts/probe-drop-highlight.mjs` | checks the cross-group highlight is on the group section while the pointer is on the header row, and that the section itself accepts no drop | spawns a server |
| `scripts/probe-ungrouped-plus.mjs` | drives the Ungrouped ＋ after a project's ＋, and reads the Host's assignment table to see where the Session landed | spawns a server |
| `scripts/probe-new-session-target.mjs` | writes the destination setting over the plugin's own RPC, then drives the shell's New Session button under each value | spawns a server |
| `scripts/probe-settings-card.mjs` | drives this plugin's own Plugin manager page: the card renders at all, its menu is themed in both colour schemes, and a choice drives the New Session button | spawns a server |
| `scripts/probe-recent-blank.mjs` | rewrites two projects' `createdAt` with the Host stopped, so the one holding a reused blank Session must lose to the newer one | spawns a server, restarts it |
| `scripts/probe-new-session-motion.mjs` | records the sidebar frame by frame while a project row's ＋ is pressed, on a blank Session that has been collapsed and re-created, so a placement that renders the previous owner for one frame shows up as a glide instead of a fade | spawns a server; the pre-fix bundle must fail its two cross-project checks |
| `scripts/probe-row-key-motion.mjs` | samples every Session row each animation frame across all four transitions (a project's ＋, the same ＋ again, another project's ＋, a blank becoming real) plus a cross-group drag, so a glide shows as a run of intermediate positions and a fade as `opacity→opacity`; asserts the blank→real case has no animation at all | spawns a server; the shipped `session:<id>` key must fail its four cross-project checks |
| `scripts/probe-project-create-motion.mjs` | creates a project while sampling every project row from both a rAF loop and a MutationObserver, so a new row that starts at the bottom and travels to the top shows as a run of y values while a row that simply appears shows one; also records the keyframes each row ran | spawns a server; the pre-fix Host (with the order backfill) must fail it — measured `654→594→…→206`, against a constant `206` after the fix |
| `scripts/probe-two-project-plus.mjs` | clicks project A's ＋ and then B's, tracking Session **ids** rather than counts, so "the blank moved" is distinguishable from "each project got its own" | spawns a server; pins upstream's `reuseOrCreateBlank` semantics in the project model — measured: the same id leaves A and appears under B |
| `scripts/probe-project-directories-dialog.mjs` | drives the directory dialog's rows | spawns a server |
| `scripts/probe-project-links.mjs` | drives the whole link surface — the debounced check's three states, the focus rule, the header's two notices, the blank-row drop, the switch, and what reaches the Host. Its timing sections sample both the row's mark and the header's count **in one pass**, because either half alone passes while the other is stale — which is how the count-first and count-late versions both shipped. Its frame-order section installs a `requestAnimationFrame` recorder **inside the page** instead of polling with `evaluate`: the bad frame exists for a single commit, so a round trip between samples misses it | spawns a server |
| `scripts/probe-base-workspace-dialog.mjs` | deletes the default Workspace's **registration** (files and Sessions kept, by design) and then clicks New Session: asserts the dialog appears instead of silence, names the Host-derived path, stacks three full-width non-overflowing actions, leaves the two repairs disabled, and that 取消 closes it without writing | spawns a server; the shipped silent `return` must fail its "dialog appears" check |

`probe-plugin-toggle.mjs` owns its lifecycle deliberately: localStorage is scoped
to an origin, and an origin includes the port, so running the two profiles on
different ports would give them separate storage and the probe would pass whether
or not the bug existed. It boots each profile in turn on one fixed port with a
single browser context open across all three phases.

Usage (it needs the executable, the asar root, and an isolated home):

```
node scripts/probe-plugin-toggle.mjs \
  "C:\...\DeepSeek Harness.exe" \
  "C:\...\resources\app.asar" \
  "C:\...\.agent\temp\toggle-home"
```

The home must already have the two profiles prepared — `pg` with this plugin
added, and `official` without it. `probe-plugin-toggle.mjs` switches between them
and asserts that a project's expansion survives the round trip.
