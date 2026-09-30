# dsh-project-groups

**[中文](README.md) | English**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2-5965d8)](https://github.com/deepseek-ai/deepseek-harness)

A [DSH](https://github.com/deepseek-ai/deepseek-harness) plugin that owns the sidebar's
**Workspace** browser and takes grouping off the **directory** model, making it a pure
**front-end project assignment**.

> **The base feature set is "leave the official behaviour alone and only group by project".**
> Disable the plugin and stock DSH is exactly what you get back.

---

## Why this exists

DSH's official Workspace is a **directory ownership** record: a session belongs to a workspace
because its immutable `cwd` equals the workspace's `path`. Membership is *derived on every read*,
never stored as a relation.

That model asks you to **choose directories up front**. This plugin is for a **full-permission
workflow that is not organised by directory**, where that ceremony is pure overhead:

- there is no RPC to move a session between workspaces, and `cwd` is frozen by design (`deepFreeze`);
- creating a workspace forces a directory picker, and its initial title can only be the folder name;
- so a workspace can never answer "which of my projects is this conversation part of".

**This plugin takes grouping off that model**: a project has **no directory** — it is a label on a
session, used to keep different projects' conversations apart in the sidebar.

## What it does

Everything the official sidebar workspace browser does, under this plugin's own bundle id (a 1:1
copy), with these layered on top:

- **project grouping** — project rows plus an Ungrouped bucket, replacing the by-Workspace grouping;
- **drag to file** — move a session between projects, or back out to Ungrouped;
- **project CRUD** — create / rename / delete / drag-reorder, with unique titles;
- **where New Session lands** — a project row's ＋, Ungrouped's ＋, and the shell button all land in
  the base Workspace;
- **search result context** — a result row names its **project**, not a Workspace.

The official `@deepseek-ai/dsh-client-ui-workspace` row is **disabled** by `cordis.patch.yml`:
two claimants of the single slot (and two providers of those services) would be a hard startup
error rather than a merge. That is also what makes the 1:1 UI possible.

## Extra features (off by default)

These go **beyond** "leave the official behaviour alone" and are **not implemented** by default:

| Feature | Why it is extra |
|---|---|
| **Show the owning project on a session's hover card** | The official `SessionHoverContent` has no such concept, and in a grouped view the project title is already visible above the row |
| **Work documents** (`docPath` binding + `agent/pre-step` injection) | The official model has no such concept, and it is the only action that injects content into a session |

See [`DESIGN.md` §24](DESIGN.md) (Chinese).

## Install

Requires DSH **0.2.0-rc.2**. The plugin runs on the 0.2.0 shell with vendored source taken from
**0.2.0-rc.2** (the upstream sync process is L4.5 in [`DESIGN.md` §5](DESIGN.md), Chinese).

```bash
dsh plugin add dsh-project-groups
```

Restart DSH afterwards. The plugin's `cordis.patch.yml` inserts its row and disables the official one.

To install from a local checkout:

```bash
git clone https://github.com/ThinkofRain1213/dsh-project-groups.git
cd dsh-project-groups
pnpm install && pnpm build
dsh plugin add .
```

### Verifying

- the sidebar should be **indistinguishable from stock DSH** — same tree, search, view options, dialogs;
- with the plugin disabled, the official row is enabled again and behaviour is **fully stock**.

## How the replacement works

```jsonc
// cordis.patch.yml
- id: ui-workspace
  name: "@deepseek-ai/dsh-client-ui-workspace"
  disabled: true

- insert:
    - id: project-groups
      name: dsh-project-groups
```

Bundle patches apply in `dsh.profile.bundles` order, and the official row is declared by the web-app
bundle layer, which applies first — so the disable lands on a row that already exists.
`scripts/verify-patch.mjs` runs this through the Loader's real patch algorithm
(`applyEntryPatches`) and asserts nothing was skipped, since a patch naming an unknown id warns and
continues instead of failing loudly.

The bundle is built to satisfy the same module-edge rules upstream uses:

- shell-provided platform modules (`react`, `@deepseek-ai/cordis`, the slot registry, the UI
  primitives) stay `require()`d;
- wire and pure-fold layers (`dsh-util-values`, `dsh-util-workspace-path`,
  `dsh-api-workspace-controller/default-workspace`) inline, which is what upstream's own bundle does;
- any other cross-plugin value import is a **build error** rather than a silently duplicated runtime
  instance.

`scripts/compare-bundle.mjs` asserts the result resolves *exactly* the same externals as the
official bundle, read out of the installed `app.asar`.

## Development

```bash
pnpm install
pnpm typecheck        # tsc --noEmit over src (including the vendored tree)
pnpm build            # tsdown -> lib/index.js + lib/client.js
pnpm check            # typecheck + build + bundle/patch/grouping/project checks + probes (354 assertions)
```

Source layout:

| Path | Role |
|---|---|
| `src/index.ts` | Host half: the project domain, the Remotes, base-Workspace rebuild |
| `src/client/index.ts` | Browser entry: the grouping injection, the settings card, the chooser |
| `src/vendored/` | Copy of the official client source + **41 registered patches** (see its [README](src/vendored/README.md)) |
| `scripts/` | Probes and verification; `DESIGN.md` explains what each proves |
| `DESIGN.md` | Architecture, verified harness facts, the layer plan and the extra-feature list (Chinese) |

## Maintaining the fork

`src/vendored/` **started** as a byte-identical copy of upstream
`packages/client/ui-workspace/src/` at `dsh-v0.1.7-rc.2`, but is **no longer byte-identical**:
project grouping needed a grouping seam, and there are now **41 structural patches across 10 files**.
The current source version is **0.2.0-rc.2**.

Every one satisfies the same invariant — **omitted means upstream behaviour** — and all are listed
in the patch table in [`src/vendored/README.md`](src/vendored/README.md). **That table is the only
checklist for a re-sync**, and the basis for "re-sync = re-copy + re-apply each patch".

A DSH upgrade is the signal to re-sync: the official package ships at the same version as the
harness line, and this plugin's `devDependencies` pin the version the copy came from.

## License

[MIT](LICENSE). The vendored source is MIT-licensed, from the same project.
