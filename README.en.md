# dsh-project-groups

**[中文](README.md) | English**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2-5965d8)](https://github.com/deepseek-ai/deepseek-harness)

A [DSH](https://github.com/deepseek-ai/deepseek-harness) plugin that does two things:

1. it **owns the sidebar's Workspace browser** and takes grouping off the **directory** model,
   making it a pure **front-end project assignment**;
2. it gives every project a **work document** and injects that document's **format spec** into the
   session — so when the spec changes, the model is told to ask before migrating.

> **Disable the plugin and stock DSH is exactly what you get back**: injections and listeners are
> torn down with the plugin's fiber, leaving nothing behind.

---

## Why this exists

### 1. Grouping should not be tied to directories

DSH's official Workspace is a **directory ownership** record: a session belongs to a workspace
because its immutable `cwd` equals the workspace's `path`. Membership is *derived on every read*,
never stored as a relation.

That model asks you to **choose directories up front**. This plugin is for a **full-permission
workflow that is not organised by directory**, where that ceremony is pure overhead:

- there is no RPC to move a session between workspaces, and `cwd` is frozen by design (`deepFreeze`);
- creating a workspace forces a directory picker, and its initial title can only be the folder name;
- so a workspace can never answer "which of my projects is this conversation part of".

**This plugin takes grouping off that model**: a project has **no directory** — it is a label on a
session.

### 2. A document deserves a spec for *how* it is written

A project document records **what the project is doing, how far it has got, and what is next**, so it
needs a structure (status / assets / log…). **Structure evolves.** When the spec changes, existing
documents no longer match it — and **the model has no way to know that on its own**.

So the plugin injects the **current spec** into the runtime context, and when it finds a document
written under an **older** spec it requires the model to **ask the user first** before migrating.

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

## Work documents and specs

Each project has one markdown document, kept under `$DSH_HOME/project-groups/`; uploaded specs live
in the `specs/` directory beside it. **The paths are not configurable**, so they stay correct on
another machine.

**Three sources for the spec** (the settings page's "Document spec"):

| Card | Meaning |
|---|---|
| **None** | No format update: write freely if the document has no format of its own, or add to the existing one |
| **Default** | The plugin's built-in spec (ships with the package, so a plugin upgrade applies automatically) |
| **Custom** | Your own uploaded markdown spec — upload, switch and delete them individually |

There is also an "Adjust the document spec per project" switch: with it on, the create and edit
project dialogs gain a dropdown (`Follow global / None / Default / each uploaded spec`) that lets one
project diverge from the global choice.

**A spec's identity is a content hash, not a file name** — so overwriting a file and a plugin upgrade
changing the built-in spec **both** register as a change. When a document is found to be written under
an older spec, the injection requires the model to ask, via `ask_user_question`:

```
1. Rewrite for the new spec   2. Skip this time   3. Ignore until the spec changes again
```

Choosing 1 sends the model through [`spec/REWRITE-FLOW.md`](spec/REWRITE-FLOW.md), whose one
inviolable constraint is that **no information may be lost in the migration**.

Injection happens **not on every step** (the official projection does not recommit unchanged text):
on a session's first turn, after a compaction, and whenever a value that affects the text actually
changes. That is why "Skip this time" needs to **store nothing at all** — it cannot loop.

See [`DESIGN.md` §26](DESIGN.md) (Chinese). The built-in spec is
[`spec/PROJECT-SPEC.md`](spec/PROJECT-SPEC.md).

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
pnpm check            # typecheck + build + 11 verification scripts + probes (662 assertions)
```

> **⚠️ When developing locally (`dsh plugin add .` / a `link:` install), a change under `src/`
> needs BOTH steps — neither alone is enough:**
> 1. **`pnpm build`** — rebuild `lib/` (a `link:` install consumes the artifacts in `lib/`,
>    not the sources);
> 2. **restart DSH** — the Host half's `lib/index.js` is **not hot-loaded**.
>
> Rebuilding without restarting shows the old Host behaviour; restarting without rebuilding has no
> effect either. (The client's `lib/client.js` may hot-reload; **the Host half will not**.) This trap
> once caused a real misjudgement: a fix was already live but unreloaded, and was reported as "not
> fixed".

Source layout:

| Path | Role |
|---|---|
| `src/index.ts` | Host half: the project domain, the Remotes, document/spec resolution, injection assembly, base-Workspace rebuild |
| `src/injection.ts` | Injection text rendering (**pure**, no filesystem access) plus the drift decision |
| `src/spec-store.ts` | Spec/document path resolution, SHA-1 (memoized on path+mtime+size), upload read/write |
| `src/spec.ts` | Domain schema: the project record, global settings, the three state values |
| `src/client/index.ts` | Browser entry: the grouping injection, the settings card, the dialogs |
| `src/client/spec-picker.tsx` | The spec choose / upload / delete dialog |
| `src/vendored/` | Copy of the official client source + **60 registered patches** (see its [README](src/vendored/README.md)) |
| `scripts/` | Probes and verification; `DESIGN.md` explains what each proves |
| `CHANGELOG.md` | What changed in each release, as users see it |
| `DESIGN.md` | Architecture, verified harness facts, the layer plan and the decision record (Chinese) |

**`pnpm check` runs all 11 verification scripts and the probes (662 assertions).**
`pnpm probe:doc-spec` (131 browser end-to-end assertions) additionally needs a **real DSH and a free
port**, so it is not on the default chain — run it by hand when touching the injection or the settings
surface.

`verify:release` guards the facts a release turns on: the version agreeing in all three places, the
`locale` descriptions matching what the plugin now does, the two READMEs staying structurally equal,
`files` covering every newly shipped path, and no stray `.tgz` in the tree.

### Releasing

`prepublishOnly` is `pnpm check`, and `verify:bundle` inside it **reads the locally installed DSH's
`app.asar`** to compare the resolved externals.

**⇒ A release must be cut on a machine with DSH installed**; otherwise that script cannot find the
`app.asar` and stops with exit code 2. (You can also pass it the official `lib/client.js` path as an
argument.)

```bash
# 1. bump: package.json's version + a new CHANGELOG.md section
# 2. the full gate
pnpm check
# 3. commit and tag
git commit -am "chore: release vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push && git push --tags
# 4. publish (prepublishOnly runs the gate again)
npm publish
```

## Maintaining the fork

`src/vendored/` **started** as a byte-identical copy of upstream
`packages/client/ui-workspace/src/` at `dsh-v0.1.7-rc.2`, but is **no longer byte-identical**:
project grouping needed a grouping seam, and there are now **60 structural patches across 11 files**.
The current source version is **0.2.0-rc.2**.

Every one satisfies the same invariant — **omitted means upstream behaviour** — and all are listed
in the patch table in [`src/vendored/README.md`](src/vendored/README.md). **That table is the only
checklist for a re-sync**, and the basis for "re-sync = re-copy + re-apply each patch".

A DSH upgrade is the signal to re-sync: the official package ships at the same version as the
harness line, and this plugin's `devDependencies` pin the version the copy came from.

## License

[MIT](LICENSE). The vendored source is MIT-licensed, from the same project.
