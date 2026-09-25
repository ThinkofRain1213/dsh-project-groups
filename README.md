# dsh-project-groups

**[中文](README.zh.md) | English**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH](https://img.shields.io/badge/DSH-0.1.7--rc.2-5965d8)](https://github.com/deepseek-ai/deepseek-harness)

A [DSH](https://github.com/deepseek-ai/deepseek-harness) plugin that owns the sidebar's **Workspace** browser so project-grouping logic can be layered onto the real UI — instead of a reimplementation that drifts from it.

> **Status: groundwork only.** This revision vendors the official implementation and changes **no behaviour**. The plugin is a drop-in replacement for the official package: same UI, same actions, same data. Project-group logic lands on top in the next revision.

---

## Why this exists

DSH's Workspace is a **directory ownership** record, not a grouping label:

- A session belongs to a workspace because its immutable `cwd` equals the workspace's `path` — membership is *derived on every read*, never stored as a relation.
- There is no RPC to move a session between workspaces, and `cwd` is frozen by design (`deepFreeze`; no writer anywhere in the harness).
- Creating a workspace forces a directory picker, and its initial title is the folder's basename.

So a workspace can never answer "which of my projects is this conversation part of".

## Why it vendors instead of wrapping

The obvious approach — keep the official UI and swap its data source — is not available. Every seam is closed by an explicit invariant, and `scripts/probe-approach-b.mjs` reproduces each one against the shipped machinery:

| Seam | Why it is closed |
|---|---|
| Replace the root `useWorkspaces` hook | `ctx.slots.provideRoot` rejects a duplicate root standard prop name — it is a union with a uniqueness invariant, not a merge point |
| Replace the `workspaces` service | `ctx.provide` refuses a second provider; `ctx.set` refuses a cross-fiber write |
| Re-declare the official child slots | registering a child another entry already declared throws; and `renderSlot` is authorised per entry, so a replacement cannot render the official actions either |

Keeping the UI 1:1 therefore requires owning a copy of it.

## What it does

Everything the official sidebar workspace browser does, under this plugin's own bundle id:

- the grouped / tree / flat conversation list, search, view options and archived filter;
- session row actions — rename, fork, pin, archive, unarchive — and their dialogs;
- the workspace picker in the conversation empty state;
- the `uiWorkspace` service that the sidebar shell and the directory pickers inject;
- the `workspaces` root hook the browsing region reads.

The official `@deepseek-ai/dsh-client-ui-workspace` row is **disabled** by this plugin's `cordis.patch.yml`, because two claimants of the single slot (and two providers of those services) would be a hard startup error rather than a merge.

## Install

Requires DSH **0.1.7-rc.2** — the vendored source is copied from that tag, and the two must not drift.

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

The sidebar should be **indistinguishable from stock DSH** — same grouping, same actions, same dialogs. That is the acceptance criterion for this revision.

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

Bundle patches apply in `dsh.profile.bundles` order, and the official row is declared by the web-app bundle layer, which applies first — so the disable lands on a row that already exists. `scripts/verify-patch.mjs` runs this through the Loader's real patch algorithm (`applyEntryPatches`) and asserts nothing was skipped, since a patch naming an unknown id warns and continues instead of failing loudly.

The bundle is built to satisfy the same module-edge rules upstream uses:

- shell-provided platform modules (`react`, `@deepseek-ai/cordis`, the slot registry, the UI primitives) stay `require()`d, so React and the slot registry are shared rather than duplicated;
- wire and pure-fold layers (`dsh-util-values`, `dsh-util-workspace-path`, `dsh-api-workspace-controller/default-workspace`) inline, which is what upstream's own bundle does;
- any other cross-plugin value import is a **build error** rather than a silently duplicated runtime instance.

`scripts/compare-bundle.mjs` asserts the result resolves *exactly* the same externals as the official bundle, read out of the installed `app.asar`.

## Development

```bash
pnpm install
pnpm typecheck        # tsc --noEmit over src (including the vendored tree)
pnpm build            # tsdown -> lib/index.js + lib/client.js
pnpm check            # typecheck + build + bundle + patch verification
```

Source layout:

| Path | Role |
|---|---|
| `src/index.ts` | Host half (no behaviour yet) |
| `src/client/index.ts` | Browser entry — the seam where project logic lands next |
| `src/vendored/` | Verbatim copy of the official client source (see its [README](src/vendored/README.md)) |
| `scripts/` | Probes and verification; `DESIGN.md` explains what each proves |
| `DESIGN.md` | Architecture, verified harness facts, and the layer plan |

## Maintaining the fork

`src/vendored/` is byte-identical to upstream `packages/client/ui-workspace/src/` at `dsh-v0.1.7-rc.2`. Re-syncing is a copy plus re-applying the short adaptation table in [`src/vendored/README.md`](src/vendored/README.md); nothing else in the tree has been edited.

A DSH upgrade is the signal to re-sync: the official package ships at the same version as the harness line, and this plugin's `devDependencies` pin the version the copy came from.

## License

[MIT](LICENSE). The vendored source is MIT-licensed, from the same project.
