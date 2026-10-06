import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { z } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { execFile } from "node:child_process";
import { join, posix, win32 } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
//#region src/spec.ts
/**
* The projectGroups domain: this plugin's own durable state.
*
* ## Why a domain rather than a file
*
* `ctx.storageDomain` is the harness's standard data form: schema validation at
* the durable boundary, atomic writes, and a `domain/changed` event per landed
* write. It stores under `$DSH_HOME/storages/`, beside the official workspace
* registry — parallel, never mixed, so disabling this plugin leaves the official
* data exactly as it was.
*
* ## The four tables
*
* `projects` is keyed by project id and holds the display title. `assignments`
* is keyed by **session id**, which is what makes "a session belongs to at most
* one project" a structural fact rather than a rule to enforce: a key holds one
* value, so a second assignment replaces the first. Moving a session between
* projects is a single write, and removing it from its project is a delete.
*
* `expansions` and `orders` are keyed by project id and hold how the row is
* presented: whether it is open, and the manual order of its members. They are
* this plugin's own state rather than the browser's, because the browser's view
* store is **shared with the official plugin** — both persist to
* `dsh.workspace.view.v5`, and the official mount prunes every key that is not a
* Workspace id (`retainAccountKeys` prunes `groupExpansion` and
* `sessionOrderByAccount` alike). State kept there is deleted the first time the
* official sidebar mounts, which is exactly what happens when this plugin is
* switched off. See `src/vendored/README.md`.
*
* The Ungrouped bucket is deliberately not in `orders`: its key is in the
* official retention list, so its order stays in the shared store and its
* behaviour is upstream's, unchanged.
*
* `global.projectIds` is the display order, mirroring how the official registry
* keeps `workspaceIds`. It is declared at version 1 rather than added later, so
* reordering costs no schema migration.
*
* ## What is deliberately absent
*
* No directory: a project groups sessions, it does not own a folder. No session
* `cwd`, no workspace id — nothing here can move a session, because only the
* Host's session records decide that, and this domain never writes them.
*/
/**
* Durable shape of one project. `docPath` is reserved for the project's work
* document (L5); an empty string means "no document bound yet" and is stored
* rather than omitted so the field's absence never has to be distinguished
* from its emptiness.
*
* ## Why `directories` carries a default
*
* The domain parses every stored record through this schema when it opens
* (`storage-domain/src/index.ts`), and a record that fails validation makes the
* **whole open reject** — `invalidRecords` defaults to the rejecting policy, and
* only `'backup-and-skip'` would move a bad record aside. A missing field would
* therefore make an install written before this change unreadable, taking every
* project with it. `.default([])` reads such a record back as "no associated
* directories", which is exactly what it was.
*
* No version bump accompanies it, for the reason stated on
* `projectDomainSpec`: a `single`-layout unit rejects a stored version that
* differs from the spec's, so bumping would make every existing file fail the
* version check instead.
*/
const projectRecord = z.object({
	title: z.string(),
	/**
	* Directories associated with this project, in display order.
	*
	* Any number, including none. Deliberately a plain `string[]` rather than a
	* record with a primary/major flag: primary-vs-secondary was considered and
	* dropped, and the shape must not reserve room for it.
	*/
	directories: z.array(z.string()).default([]),
	docPath: z.string(),
	/**
	* Spec override for this project's document. Absent inherits the global
	* setting — a real state, not an empty one, which is why this is `.optional()`
	* rather than defaulted: `'none'` is a deliberate "no spec" and must stay
	* distinguishable from "follow the global choice".
	*
	* A string is an uploaded spec's **file name**, never a path: uploaded specs
	* live only under this plugin's own directory, so the name is the whole
	* identity and `$DSH_HOME` is resolved at read time.
	*/
	docSpec: z.union([z.literal("none"), z.string()]).optional(),
	/**
	* The spec the document was last written against, as the SHA-1 of that spec
	* file's content.
	*
	* **Absent means the document has never been written**, so there is nothing to
	* migrate and the drift check never fires. That is what keeps a project whose
	* document does not exist yet from being asked about a rewrite it cannot need.
	*
	* A content hash rather than a file name on purpose: overwriting an uploaded
	* spec under the same name, or a plugin upgrade changing the built-in spec,
	* both change the hash and are therefore detected. A name comparison would
	* miss both.
	*/
	docSpecUsed: z.string().optional(),
	/**
	* A spec content hash the user asked to stop being asked about.
	*
	* Recorded by the third drift choice ("ignore until the spec changes again").
	* Storing the hash rather than a boolean is what scopes the dismissal to one
	* spec: the next spec has a different hash and is therefore asked about
	* normally, which is exactly the difference between this choice and a
	* permanent off switch.
	*/
	docSpecIgnored: z.string().optional(),
	createdAt: z.string(),
	updatedAt: z.string()
});
/**
* Durable shape of one session's project membership. The key is the session id;
* `projectId` names the project that owns it.
*/
const assignmentRecord = z.object({
	projectId: z.string(),
	assignedAt: z.string()
});
/**
* Durable shape of one project's expansion state. The key is the project id.
*
* A record's **presence** carries meaning beyond its value: absent means "the
* user has never touched this row", which is what lets the browser open the
* group holding the current Session exactly once. A record with `expanded:
* false` means the user folded it deliberately, and nothing may reopen it. That
* distinction is why the state is a record per project rather than a boolean on
* the project itself — an absent field and a `false` field would be one value.
*/
const expansionRecord = z.object({ expanded: z.boolean() });
/**
* Where a New Session with no stated destination lands.
*
* The three entries cover the states a Session can already be in — loose, or
* inside some project — plus "the project that was used most recently". A fourth,
* "one specific project", is deliberately absent: it needs a project picker and a
* policy for what happens when that project is deleted, which is a design of its
* own. Adding it later is a compatible change (see the schema note below).
*/
const newSessionTarget = z.enum([
	"ungrouped",
	"current",
	"recent"
]);
/** How the base workspace is chosen. */
const baseWorkspaceMode = z.enum(["default", "specified"]);
/**
* The base workspace: the Workspace every New Session this plugin opens lands in.
*
* ## Why `path` and not `workspaceId`
*
* Re-registering the same directory mints a **new** Workspace id (measured: deleting a
* registration and creating the same path again yields a new id with an empty
* `sessionIds`). A stored id would therefore go stale the moment the user removes and
* re-adds the Workspace, while the path keeps resolving. Same reasoning as §3.8's
* "find by path, never by title".
*
* A useful consequence: a Workspace the user deleted and re-added at the same path is
* recognised again without them having to re-pick it.
*
* ## Why `name` is stored at all
*
* Display only. The card shows it without having to resolve the snapshot, and it is
* what makes "'D:\我的项目' is gone" readable rather than a bare path. It is captured
* at pick time and goes stale if the Workspace is renamed elsewhere — deliberately:
* the plugin must not rewrite the user's setting because someone else edited a title.
*/
const baseWorkspaceSetting = z.object({
	mode: baseWorkspaceMode,
	/**
	* The remembered Workspace, **retained even in `'default'` mode**.
	*
	* A memory rather than a mode field: keeping it is what lets 默认 → 指定 restore the
	* user's last pick instead of asking again. Every reader gates on `mode`, so a retained
	* path is never mistaken for an active one.
	*/
	path: z.string().optional(),
	/** Display name captured when the Workspace was picked. */
	name: z.string().optional()
});
/**
* Whether creating a project also opens a Session inside it.
*
* Defaults to **on**, which is the official add-workspace behaviour: that flow
* creates the row and then opens a Session in it (`WorkspacePicker.onPick` →
* `startSession`), so the user lands somewhere they can type instead of an empty
* sidebar. A project has no directory, so "in it" means the caller's 底层工作区 with
* the Session filed under the new project — the same call a project row's ＋ already
* makes.
*
* Off restores this plugin's earlier behaviour: the row appears and nothing else
* happens, which is what a user who files Sessions by hand wants.
*
* Carries a default rather than being optional, the same compatibility mechanism
* `newSessionTarget` uses: the domain parses the stored global through this schema on
* open, so a unit written before the field existed reads back as `true` — the official
* behaviour such an install already had. No version bump is needed, for the reason
* stated on `projectDomainSpec`.
*/
const createOpensSession = z.boolean().default(true);
/**
* Whether a Session's project info is injected into its requests.
*
* Defaults to **on**. Registered as a `systemPrompt.context()` contribution, so
* the model receives the project's title and associated directories as part of
* the runtime-context snapshot; this is the base feature, and it is the reason
* the plugin touches the model's context at all.
*
* Off restores the untouched official chain — no plugin-attributed context
* whatsoever. Disabling the plugin achieves the same thing structurally, because
* the contribution is a Cordis effect that dies with its fiber.
*
* Carries a default for the compatibility reason stated on
* `createOpensSession`: a global written before the field existed reads back as
* `true`, which is the behaviour such an install is about to get.
*/
const injectProjectInfo = z.boolean().default(true);
/**
* Whether the project's work-document line is injected alongside the base info.
*
* Defaults to **off**, and is deliberately a *separate* switch rather than part
* of {@link injectProjectInfo}: the document is the extra feature (see DESIGN.md
* §25.4 / §25.9). The base injection is a project name and its directories;
* naming the document is an addition on top of it, so it must be opt-in even
* though the base is on by default.
*
* Carries a default for the same compatibility reason.
*/
const injectProjectDoc = z.boolean().default(false);
/**
* Which spec source a project document follows, before any per-project override.
*
* `'default'` and `'custom'` are both real specs and differ only in where the
* file lives (inside this package, or under the plugin's own home directory);
* `'none'` says no format is required at all.
*/
const docSpecMode = z.enum([
	"none",
	"default",
	"custom"
]);
/**
* A recoverable in-flight mutation marker, mirroring the official registry's
* `pendingMutation` (`packages/workspace/workspace/src/spec.ts`).
*
* A create or a delete is several writes, and a crash between them leaves a
* half-applied state that no reader could tell from corruption. The marker is
* written first, so startup can name what was in flight instead of guessing.
*
* Both operations recover the same way — the record must not survive — because
* the order is written *after* the record on create and *before* it on delete.
* Either interruption therefore leaves the id **absent** from `projectIds`, so
* the leftover is always the record set, and removing it is the whole repair.
*/
const pendingMutation = z.discriminatedUnion("operation", [z.object({
	operation: z.literal("create"),
	projectId: z.string()
}), z.object({
	operation: z.literal("delete"),
	projectId: z.string()
})]);
/**
* Durable shape of the global singleton: the project display order plus the
* destination policy for unscoped New Sessions.
*
* `newSessionTarget` carries a default rather than being optional, and that is
* what makes adding it compatible: the domain parses the stored global through
* this schema on open (`storage-domain/src/index.ts`), so a unit written before
* the field existed reads back as `'ungrouped'` instead of `undefined`. Verified
* against the installed zod, and pinned by a host test.
*
* `baseWorkspace` uses the same mechanism for the same reason: a global written
* before it existed reads back as `{ mode: 'default' }`, which is exactly the
* behaviour such an install already had.
*
* `pendingMutation` is `.optional()` for the same compatibility reason: a global
* written before it existed reads back as `undefined`, which is the correct
* "nothing was in flight". No version bump is needed — see the note on
* `projectDomainSpec` below.
*/
const globalRecord = z.object({
	projectIds: z.array(z.string()),
	newSessionTarget: newSessionTarget.default("ungrouped"),
	baseWorkspace: baseWorkspaceSetting.default({ mode: "default" }),
	/** Whether creating a project also opens a Session inside it. */
	createOpensSession: createOpensSession.default(true),
	/** Whether a Session's project name and directories are injected. */
	injectProjectInfo: injectProjectInfo.default(true),
	/** Whether the project's work-document line is injected too. */
	injectProjectDoc: injectProjectDoc.default(false),
	/**
	* Which spec a project document follows when the project names no override.
	*
	* `'default'` is the spec shipped inside this package; `'custom'` names one
	* the user uploaded; `'none'` says no format is required. Defaulting to
	* `'default'` means a fresh install injects the shipped spec's path rather
	* than nothing, which is the behaviour an install is about to get.
	*/
	docSpecMode: docSpecMode.default("default"),
	/**
	* The uploaded spec's file name when {@link docSpecMode} is `'custom'`.
	*
	* Empty means the mode names a file the user has not chosen yet. The pair is
	* deliberately two fields rather than one nullable name: `'custom'` with no
	* name is a state the settings surface must show as "selected but unset", and
	* folding it into `null` would erase the difference between that and `'none'`.
	*/
	docSpecFileName: z.string().default(""),
	/**
	* Whether the project dialogs expose a per-project spec row.
	*
	* Off by default: the document feature's common case is one spec for every
	* project, and a fourth row in the create dialog costs more than the override
	* is worth until a user asks for it.
	*/
	perProjectDocSpec: z.boolean().default(false),
	/** The mutation a previous process left unfinished, if any. */
	pendingMutation: pendingMutation.optional()
});
/**
* Value served before the first global write.
*
* Typed rather than written inline: an inline literal widens `newSessionTarget`
* to `string`, which makes the domain's global handle a union of the schema's
* output and the widened initial, and every write then has to satisfy both.
*/
const initialGlobal = {
	projectIds: [],
	newSessionTarget: "ungrouped",
	baseWorkspace: { mode: "default" },
	createOpensSession: true,
	injectProjectInfo: true,
	injectProjectDoc: false,
	docSpecMode: "default",
	docSpecFileName: "",
	perProjectDocSpec: false
};
/**
* Durable shape of one project's manual session order. The key is the project id.
*
* This mirrors the browser view store's `sessionOrderByAccount`, which the
* official plugin also writes to — and prunes. Keeping a project's order here
* rather than there is what makes it survive the official sidebar mounting, the
* same reason `expansions` lives here.
*
* Only the manual order is stored: under recency ordering a member's position is
* derived from its `updatedAt`, so there is nothing to record.
*/
const orderRecord = z.object({ sessionIds: z.array(z.string()) });
/**
* The domain declaration. `defineDomain` validates the name, version and table
* names at module load, before any medium is touched.
*
* `version` stays 1 while tables are added: a `single`-layout unit rejects a
* stored version that differs from the spec's, and has no migration step, so
* bumping it would make every existing file unreadable. An added table needs no
* bump — a unit that predates it simply reads that table as empty
* (`storage-json/src/format.ts`).
*/
const projectDomainSpec = defineDomain({
	name: "project_groups",
	version: 1,
	global: {
		schema: globalRecord,
		initial: initialGlobal
	},
	tables: {
		projects: domainTable(projectRecord),
		assignments: domainTable(assignmentRecord),
		expansions: domainTable(expansionRecord),
		orders: domainTable(orderRecord)
	}
});
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-api-worksp_f4fc36b9eec32464ee79d565ab09e781/node_modules/@deepseek-ai/dsh-api-workspace-controller/lib/types/default-workspace.js
/**
* Fixed first-use Workspace naming, shared by the Host that creates the
* directory and by browser consumers that label the resulting row. A pure fold
* with no imports, so client bundles inline it instead of requesting a
* module-table row this package does not publish.
* @module @deepseek-ai/dsh-api-workspace-controller/default-workspace
*/
/**
* Leaf directory name of the first-use Workspace under
* `<Documents>/deepseek-harness`. Language-neutral, so one installation keeps
* one on-disk path across language switches. The registry derives the initial
* title from this same segment, which is the title
* {@link workspaceDisplayTitle} recognizes as automatic.
*/
const DEFAULT_WORKSPACE_DIRECTORY = "default-workspace";
//#endregion
//#region src/default-workspace.ts
/**
* The official default Workspace's directory, derived on the Host.
*
* ## Why this exists
*
* The missing-底层工作区 dialog names the path that is gone, and only the Host can
* produce it: the path starts at the OS Documents folder, which a browser cannot read.
* `initializeDefault` is not a substitute — it returns `undefined` once its recorded
* `defaultWorkspaceId` dangles (measured), and it is a *write* path besides.
*
* ## Why it is reimplemented rather than imported
*
* The official derivation is `defaultWorkspaceDirectory` in
* `@deepseek-ai/dsh-api-workspace-controller/lib/types/default-directory.js`, and that
* subpath is **not** in the package's `exports` map — importing it fails with
* `ERR_PACKAGE_PATH_NOT_EXPORTED` (measured against the installed asar). So the three
* parts are reassembled here:
*
*   1. the leaf name, imported from the **exported** `./default-workspace` entry, so it
*      stays in step with the title the registry derives from it;
*   2. the Documents folder, from the same native query the official code runs;
*   3. the `deepseek-harness` intermediate segment.
*
* The validation is copied too, including the Windows-specific root check: a failed
* `[Environment]::GetFolderPath` returns `\`, and joining that would silently produce
* `\deepseek-harness\default-workspace` — a path that is absolute yet meaningless.
*
* ## Cost control
*
* The Documents query spawns a child process, so it is bounded by a timeout and any
* failure yields `null` rather than throwing: this runs to *label* a dialog, and a
* dialog that fails to open because it could not name the path would be worse than one
* that says the path is unknown.
*/
/**
* How long the Documents lookup may take before it is abandoned.
*
* The official deployment keeps its own bound (`documentsLookupTimeoutMs`). Spawning
* `powershell.exe` on a cold, loaded machine is the slow case; three seconds is
* generous for a query that reads one environment value, and the fallback (`null`) is
* a readable dialog rather than a hang.
*/
const LOOKUP_TIMEOUT_MS = 3e3;
/**
* Run one native command and return its stdout, or `null` when it fails or times out.
* @param file - executable to run.
* @param args - its arguments.
* @returns stdout with the trailing newline removed, or `null`.
*/
async function stdoutOf(file, args) {
	return await new Promise((resolve) => {
		execFile(file, [...args], {
			timeout: LOOKUP_TIMEOUT_MS,
			windowsHide: true
		}, (error, stdout) => {
			if (error !== null) {
				resolve(null);
				return;
			}
			resolve(stdout.replace(/[\r\n]+$/, ""));
		});
	});
}
/**
* Ask the OS for the account's Documents folder.
*
* The commands are the official ones, verbatim, including the flags that matter:
* `-NoProfile -NonInteractive` so a user profile script cannot change the answer, and
* `DoNotVerify` so the query itself does not **create** the Documents folder — the
* official code documents the same reason ("without creating files").
* @param platform - the host platform.
* @returns the raw spelling, or `null` when unavailable.
*/
async function documentsDirectoryOf(platform) {
	switch (platform) {
		case "win32": return await stdoutOf("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments, [Environment+SpecialFolderOption]::DoNotVerify)"
		]);
		case "darwin": return await stdoutOf("osascript", ["-e", "POSIX path of (path to documents folder from user domain without folder creation)"]);
		case "linux": return await stdoutOf("xdg-user-dir", ["DOCUMENTS"]);
		default: return null;
	}
}
/**
* The directory the official default Workspace occupies on this Host.
*
* Pure read: nothing is created, moved, or registered. The answer is derived on every
* call rather than cached, matching the navigation policy that resolves per click —
* a cached path would outlive the OS setting it came from.
* @param platform - the host platform; injectable for tests.
* @returns the absolute path, or `null` when the Documents folder is unavailable.
*/
async function defaultWorkspacePath(platform = process.platform) {
	const documents = await documentsDirectoryOf(platform);
	if (documents === null) return null;
	const paths = platform === "win32" ? win32 : posix;
	if (documents === "" || !paths.isAbsolute(documents)) return null;
	if (platform === "win32") {
		const root = paths.parse(documents).root;
		if (root === "\\" || root === "/") return null;
	}
	return paths.join(paths.normalize(documents), "deepseek-harness", DEFAULT_WORKSPACE_DIRECTORY);
}
//#endregion
//#region src/injection.ts
/** The frame this plugin's block is wrapped in. */
const PROJECT_CONTEXT_OPEN = "<project-context>";
/** @see PROJECT_CONTEXT_OPEN */
const PROJECT_CONTEXT_CLOSE = "</project-context>";
/**
* Shown when a filed project has no directory yet.
*
* A sentence rather than a bare `none`: it says the user has not set one, which is
* actionable, and `yet` is accurate — a directory can be added at any time, and a
* session that began without one has been given one mid-conversation.
*/
const DIRECTORY_UNSET = "The user has not yet set up the relevant directory.";
/**
* Stable question id the drift prompt asks the model to use.
*
* The answer echoes this id, which is what lets the observer pick our question
* out of every `ask_user_question` call in the session without reading prose.
*/
const SPEC_DRIFT_QUESTION_ID = "project-doc-spec-drift";
/**
* The three choices, as the exact labels the model is told to use.
*
* Both languages are held here, and {@link matchSpecDriftChoice} matches against
* both, so switching the configured locale does not orphan an answer recorded
* under the other one. Nothing may be appended to these strings — no `(Recommended)`
* suffix, no index — because the answer returns the label verbatim and the match
* is exact.
*/
const SPEC_DRIFT_LABELS = {
	rewrite: {
		zh: "按新规范重写",
		en: "Rewrite for the new spec"
	},
	skip: {
		zh: "本次忽略",
		en: "Skip this time"
	},
	ignore: {
		zh: "在规范再次变更前忽略",
		en: "Ignore until the spec changes again"
	}
};
/** The order the choices are presented in; the rewrite option is first. */
const SPEC_DRIFT_CHOICES = [
	"rewrite",
	"skip",
	"ignore"
];
/**
* The description under each choice, in both locales.
*
* The `rewrite` description states that nothing is lost, which is the promise
* `REWRITE-FLOW.md` exists to keep: it is the one line that tells the user the
* migration is safe.
*/
const SPEC_DRIFT_DESCRIPTIONS = {
	rewrite: {
		zh: "按当前规范重构文档；已有信息不丢失。",
		en: "Restructure the document to follow the current spec; no information is lost."
	},
	skip: {
		zh: "保持文档不变；之后仍会询问。",
		en: "Leave the document unchanged; you will be asked again later."
	},
	ignore: {
		zh: "保持文档不变，且不再询问。",
		en: "Leave the document unchanged, and do not ask again."
	}
};
/**
* Build the localized question block.
* @param locale - the configured locale.
* @returns the question text and its three options, in presentation order.
*/
function specDriftQuestion(locale) {
	return {
		question: locale === "zh" ? "项目文档依据的规范已变更，如何处理已有文档？" : "The project document was written under a different spec. How should the existing document be handled?",
		options: SPEC_DRIFT_CHOICES.map((choice) => ({
			label: SPEC_DRIFT_LABELS[choice][locale],
			description: SPEC_DRIFT_DESCRIPTIONS[choice][locale]
		}))
	};
}
/**
* Map one answered label back to its choice.
*
* Exact match in either language, because the answer carries the label the model
* passed in. A label the model rewrote or translated matches nothing, and the
* caller then records nothing — the safe outcome, since the alternative would be
* acting on a choice the user may not have made.
* @param label - the answered label.
* @returns the choice, or undefined when it matches none.
*/
function matchSpecDriftChoice(label) {
	for (const choice of SPEC_DRIFT_CHOICES) {
		const labels = SPEC_DRIFT_LABELS[choice];
		if (label === labels.zh || label === labels.en) return choice;
	}
}
/**
* Whether the drift question applies to one project.
*
* Four conditions, and each rules out a case where asking would be wrong:
*
*   - `currentSha1 !== undefined` — there is a spec to migrate TO. 无 (and a
*     custom name whose file is gone) resolves to no spec, and the prompt points
*     the model at the spec file plus `REWRITE-FLOW.md`, whose first step is to
*     read "the spec file given in this injection". Asking without one instructs
*     the model to restructure a document to follow a spec that does not exist.
*     无 means "no format update", so there is nothing to migrate.
*   - `usedSha1 !== undefined` — the document has been written. Absent means it
*     has never existed, so there is nothing to migrate FROM.
*   - `usedSha1 !== currentSha1` — the content actually changed. A content hash
*     rather than a name catches an overwritten file and a plugin upgrade.
*   - `ignoredSha1 !== currentSha1` — the user did not dismiss this very content.
*
* Pure, and exported for that reason: the guard is the one thing about the drift
* feature that cannot be seen from the rendered text, since its effect is that no
* drift text appears at all.
* @param state - the recorded hashes and the current spec's hash.
* @returns whether the caller should emit the drift prompt.
*/
function shouldAskSpecDrift(state) {
	const { usedSha1, ignoredSha1, currentSha1 } = state;
	if (currentSha1 === void 0) return false;
	if (usedSha1 === void 0) return false;
	if (usedSha1 === currentSha1) return false;
	return ignoredSha1 !== currentSha1;
}
/**
* Render the injection for one Session.
*
* ## Shape
*
* A framed block: a constant declaration paragraph, an `Owning project` line, then
* the directory lines and — when that feature is on and the session is filed — the
* document lines.
*
* ## Why unfiled and filed state different things, not empty ones
*
* `directories` is a field of the **project record**. An unfiled Session has no
* record, so there is nowhere a directory could be associated with it — the
* Ungrouped row offers no editing surface because there is nothing to edit. Naming
* a directory there would point at a setting that does not exist and cannot be
* changed, inviting the model to report a fixable absence. The same absence rules
* out the document lines: a document hangs off the record, so an unfiled Session
* cannot have one. This is a structural impossibility, not a policy choice, and it
* is why the unfiled branch returns before any document code runs — a caller that
* passes one anyway still gets no document.
*
* A **filed** project with no directories keeps its line, and that asymmetry is
* the point: that project *does* have an edit surface («编辑项目»), so the
* unset-directory sentence is a real, actionable state rather than a missing one.
*
* ## Why the declaration is a separate paragraph
*
* The model reads two unqualified statements — the official working directory and
* this project — and nothing used to relate them. The declaration states the
* relation once, so the rest of the block can be read as data. It also names the
* segments it is about to carry, each only while that segment is renderable.
*
* ## Why the drift block drops the document's trailing sentence
*
* The trailing sentence says a failed read means the document does not exist
* yet. Drift is only ever reported for a document that **does** exist (an absent
* `docSpecUsed` means it was never written), so keeping that sentence would
* contradict the block it sits in.
* @param input - the project, and the document state when that feature is on.
* @returns the contribution text; never empty.
*/
function renderProjectInjection(input) {
	const { project, document } = input;
	const body = [];
	if (project === void 0) body.push("Owning project: This conversation does not belong to any project. It is under the \"Ungrouped\" category.");
	else {
		body.push(`Owning project: You are currently working on this project, project name "${project.title}"`);
		body.push(...renderDirectoryLines(project.directories));
		if (document !== void 0) {
			body.push("");
			body.push(renderDocumentLine(document));
			body.push(renderSpecLine(document));
			if (document.drift !== void 0) body.push(renderDriftBlock(document.drift));
		}
	}
	return [
		PROJECT_CONTEXT_OPEN,
		renderDeclaration(input),
		"",
		...body,
		PROJECT_CONTEXT_CLOSE
	].join("\n");
}
/**
* The segments the declaration announces, in presentation order.
*
* Dynamic by design: a segment is named only while it can actually be rendered, so
* the declaration never promises a field the block does not carry. `related links`
* is reserved for the project-link feature, which does not exist yet — naming it
* here would send the model looking for a value that is always absent.
* @param input - the same input the block is rendered from.
* @returns the segment names, space-separated.
*/
function declaredSegments(input) {
	const segments = ["`owning project`"];
	if (input.project !== void 0) segments.push("`relevant directories`");
	if (input.document !== void 0) segments.push("`work document`");
	return segments.join(" ");
}
/**
* The constant opening paragraph.
*
* The closing sentence rules out the one reading that was measured to cost turns:
* that the working directory indicates which project is being worked on. It does
* not — every project shares a single base workspace by construction — and saying
* so is what lets the model skip reconciling two unqualified statements.
* @param input - the same input the block is rendered from.
* @returns the paragraph as one line, matching the node's other state lines.
*/
function renderDeclaration(input) {
	return `This section is injected by the \`project-groups\` plugin. It provides context information about the session's ${declaredSegments(input)}. Project membership is classified by the plugin layer; the plugin does not modify the official workspace system, so all projects' workspace directories fall into a single base workspace. The "working directory" injected in the earlier system prompt is the official base workspace directory, and has no substantive relation to the project this session belongs to under this plugin.`;
}
/**
* The directory lines, whose label follows the count.
*
* Three shapes rather than one: a single path under a plural heading reads as a
* truncated list, and the design settled on matching the label to the count. The
* multi-directory form still uses plain dashes; it is not an XML list, so the only
* markup in the block stays the frame itself.
* @param directories - the project's associated directories, in display order.
* @returns one or more lines.
*/
function renderDirectoryLines(directories) {
	if (directories.length === 0) return [`Relevant directory: ${DIRECTORY_UNSET}`];
	if (directories.length === 1) return [`Relevant directory: ${directories[0]}`];
	return ["Relevant directories:", ...directories.map((directory) => `- ${directory}`)];
}
/**
* The `Project document:` line.
*
* The trailing sentence is an instruction, not a claim about the filesystem: the
* plugin never stats the document, so the model is told what a failed read
* *means* and left to do the reading. That keeps this module free of I/O and
* keeps the cost off every request.
* @param document - the document state.
* @returns the line.
*/
function renderDocumentLine(document) {
	const head = `Project document: ${document.docPath}`;
	if (document.drift !== void 0) return head;
	if (document.specMode === "none") return `${head} — a failed read means it has not been created yet; create it as the project needs.`;
	return `${head} — a failed read means it has not been created yet; create it following the spec.`;
}
/**
* The `Project document spec:` line.
*
* The spec-less wording states the POLICY, not just the absence of a format:
* "no format is required" alone can be read as "write it however you like", which
* would license reorganising a document that already has a structure. 无 means the
* plugin does not ask for a format update — an unstructured document may be
* written freely, and a structured one may be added to freely, but neither is a
* migration. This is also why no drift question is ever emitted in this state
* (see `documentInjection`): there is no target spec to migrate to.
* @param document - the document state.
* @returns the line.
*/
function renderSpecLine(document) {
	if (document.specPath === void 0) return "Project document spec: none — no format is required, and the document's format is left as it is: write freely if it has no format of its own, or add to the existing format rather than reorganising the document.";
	return `Project document spec: ${document.specPath}`;
}
/**
* The drift prompt: what the model must ask, verbatim, and what to do next.
*
* The option labels are reproduced exactly as {@link matchSpecDriftChoice} will
* receive them back — this text is the only place they are written for the
* model, so a change here and a change there cannot drift apart without the
* matcher's own spec failing.
* @param drift - the locale and the rewrite procedure's path.
* @returns the prompt block.
*/
function renderDriftBlock(drift) {
	const { question, options } = specDriftQuestion(drift.locale);
	return [
		"The spec the project document currently uses differs from the spec this plugin currently configures. Before continuing, call `ask_user_question` and use the following question, options, and descriptions strictly verbatim — do not rewrite or translate them:",
		`  id: ${SPEC_DRIFT_QUESTION_ID}`,
		`  question: ${question}`,
		"  options:",
		...options.flatMap((option, index) => [`    ${String(index + 1)}. label: ${option.label}`, `       description: ${option.description}`]),
		"If the user selects the first option, read this file in full and follow it exactly:",
		drift.rewriteFlowPath
	].join("\n");
}
//#endregion
//#region src/spec-store.ts
/**
* Where the work-document feature keeps its files, and how a spec is identified.
*
* ## Two roots, both resolved at run time
*
* Nothing here is a literal absolute path, because the plugin ships to other
* machines:
*
*  - the **document** and every **uploaded spec** live under `$DSH_HOME`, whose
*    resolution order copies the official one (`profileContext.home` first, then
*    `$DSH_HOME`, then `~/.dsh` — the order `dsh-home-paths` documents and the
*    peer plugin `dsh-codearts-auth` also uses);
*  - the **built-in spec** is resolved from this module's own URL, so both a
*    `link:` install (this checkout) and a `git`/registry install (under
*    `node_modules`) find it. `@deepseek-ai/dsh-skill-office` locates its assets
*    the same way.
*
* ## Why a content hash identifies a spec
*
* The drift check asks "is the document aligned with the spec now configured?".
* Comparing file names would answer a different question: overwriting an
* uploaded spec under the same name, or a plugin upgrade rewriting the built-in
* one, both leave the name identical while changing what the document should
* follow. A SHA-1 of the content detects both. The algorithm matches the
* official `instructionContentSha1` in `@deepseek-ai/dsh-agent-instructions`,
* which solves the same "has this content changed" problem for instruction
* files; this is content identity, not a security boundary.
*
* @module dsh-project-groups/src/spec-store
*/
/** Directory under the Harness home holding this feature's document + specs. */
const FEATURE_DIR = "project-groups";
/** Uploaded specs live in this subdirectory, one file each. */
const SPECS_DIR = "specs";
/**
* The built-in spec, resolved against this module rather than a configured root.
*
* `../spec/...` because this file compiles to `lib/index.js` while the spec
* ships at the package root.
*/
const BUILT_IN_SPEC_PATH = fileURLToPath(new URL("../spec/PROJECT-SPEC.md", import.meta.url));
/** The rewrite procedure the drift prompt points the model at. */
const REWRITE_FLOW_PATH = fileURLToPath(new URL("../spec/REWRITE-FLOW.md", import.meta.url));
/**
* Resolve the Harness home, most specific source first.
*
* `profileContext.home` is the launcher's own answer and outranks the
* environment; the environment outranks the OS home; a blank `$DSH_HOME` is
* treated as unset rather than resolving to the current directory, matching the
* official resolver.
* @param ctx - Host context, for the optional launcher-provided profile.
* @returns the absolute Harness home.
*/
function harnessHome(ctx) {
	const profile = ctx.get("profileContext");
	if (profile?.home !== void 0 && profile.home.length > 0) return profile.home;
	const fromEnv = process.env.DSH_HOME?.trim();
	return fromEnv !== void 0 && fromEnv.length > 0 ? fromEnv : join(homedir(), ".dsh");
}
/** @returns the directory holding uploaded specs (not created here). */
function specsDirectory(ctx) {
	return join(harnessHome(ctx), FEATURE_DIR, SPECS_DIR);
}
/**
* @param ctx - Host context.
* @param projectId - owning project.
* @returns the absolute path of that project's document.
*/
function documentPath(ctx, projectId) {
	return join(harnessHome(ctx), FEATURE_DIR, `${projectId}.md`);
}
/** @returns the absolute path of one uploaded spec, or undefined for a bad name. */
function uploadedSpecPath(ctx, fileName) {
	if (!isSafeSpecName(fileName)) return void 0;
	return join(specsDirectory(ctx), fileName);
}
/**
* Whether a name is a bare, single-segment spec file name.
*
* The check is what keeps an upload or a delete from addressing anything outside
* the specs directory: a name carrying a separator, a drive, or a parent hop
* would let a Remote caller write wherever it liked.
* @param name - candidate file name.
* @returns true when the name may be joined onto the specs directory.
*/
function isSafeSpecName(name) {
	if (name.length === 0 || name.length > 128) return false;
	if (!name.endsWith(".md")) return false;
	if (name.includes("/") || name.includes("\\")) return false;
	if (name.includes("\0")) return false;
	if (name.startsWith(".")) return false;
	if (/[\u0000-\u001f]/.test(name)) return false;
	return true;
}
/** Last hash per path; the file's mtime+size is the invalidation key. */
const hashes = /* @__PURE__ */ new Map();
/**
* SHA-1 of one file's content, memoized on path + mtime + size.
*
* Synchronous because the caller is `PromptContext.text`, which the official
* registry evaluates synchronously per assembly. A stat is microseconds and the
* read only happens when the file actually changed, so a steady state costs one
* `statSync` per injected request.
* @param path - absolute file path.
* @returns the lowercase hex digest, or undefined when the file is absent.
*/
function specSha1(path) {
	let stat;
	try {
		stat = statSync(path);
	} catch {
		hashes.delete(path);
		return;
	}
	const memo = hashes.get(path);
	if (memo !== void 0 && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) return memo.sha1;
	try {
		const sha1 = createHash("sha1").update(readFileSync(path)).digest("hex");
		hashes.set(path, {
			path,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			sha1
		});
		return sha1;
	} catch {
		hashes.delete(path);
		return;
	}
}
/**
* Resolve the effective spec for one project.
*
* A project override wins over the global choice, and an override that names a
* file the user has since deleted falls back to the global choice rather than
* to "none": the override is stale, not a decision to drop the format.
* @param ctx - Host context.
* @param global - the stored global settings.
* @param project - the project's override, when it has one.
* @returns the effective mode and, when it names a file, that file.
*/
function resolveSpec(ctx, global, project) {
	const override = project?.docSpec;
	if (override !== void 0) {
		if (override === "none") return { mode: "none" };
		if (override === "default") return {
			mode: "default",
			path: BUILT_IN_SPEC_PATH
		};
		const path = uploadedSpecPath(ctx, override);
		if (path !== void 0 && existsSync(path)) return {
			mode: "custom",
			path,
			fileName: override
		};
	}
	if (global.docSpecMode === "none") return { mode: "none" };
	if (global.docSpecMode === "default") return {
		mode: "default",
		path: BUILT_IN_SPEC_PATH
	};
	const path = uploadedSpecPath(ctx, global.docSpecFileName);
	if (path === void 0 || !existsSync(path)) return { mode: "none" };
	return {
		mode: "custom",
		path,
		fileName: global.docSpecFileName
	};
}
/**
* Snapshot the effective spec and its content hash.
* @param ctx - Host context.
* @param global - the stored global settings.
* @param project - the project's override, when it has one.
* @returns the identity the drift check compares against the document's.
*/
function specIdentity(ctx, global, project) {
	const spec = resolveSpec(ctx, global, project);
	if (spec.path === void 0) return { mode: spec.mode };
	return {
		mode: spec.mode,
		path: spec.path,
		sha1: specSha1(spec.path)
	};
}
/**
* Every uploaded spec's file name, sorted for a stable display order.
* @param ctx - Host context.
* @returns the names; empty when the directory does not exist yet.
*/
async function listUploadedSpecs(ctx) {
	try {
		return (await readdir(specsDirectory(ctx))).filter(isSafeSpecName).sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}
/**
* Write one uploaded spec, refusing to replace an existing name.
*
* Refusing rather than overwriting is the settings surface's rule: a spec the
* user may have hand-edited must not be destroyed by a second upload of the same
* name, and the surface reports "already exists" so the user can rename instead.
* @param ctx - Host context.
* @param name - bare `*.md` file name.
* @param content - the file's text.
* @returns whether the write landed; false when the name is unsafe or taken.
*/
async function writeUploadedSpec(ctx, name, content) {
	const path = uploadedSpecPath(ctx, name);
	if (path === void 0 || existsSync(path)) return false;
	await mkdir(specsDirectory(ctx), { recursive: true });
	await writeFile(path, content, "utf8");
	return true;
}
/**
* Read one uploaded spec's text, for the surface's preview.
* @param ctx - Host context.
* @param name - bare `*.md` file name.
* @returns the text, or undefined when absent.
*/
async function readUploadedSpec(ctx, name) {
	const path = uploadedSpecPath(ctx, name);
	if (path === void 0) return void 0;
	try {
		return await readFile(path, "utf8");
	} catch {
		return;
	}
}
/**
* Delete one uploaded spec.
*
* The caller owns the confirmation: a spec may be referenced by projects, and
* only the surface knows how to say so.
* @param ctx - Host context.
* @param name - bare `*.md` file name.
* @returns whether a file was removed.
*/
async function deleteUploadedSpec(ctx, name) {
	const path = uploadedSpecPath(ctx, name);
	if (path === void 0) return false;
	try {
		await rm(path);
		return true;
	} catch {
		return false;
	}
}
//#endregion
//#region src/protocol.ts
/** The Cordis service key owning these methods, and the default wire namespace. */
const PROJECT_SERVICE_KEY = "projectController";
/** The Remote namespace the Client calls (`ctx.remote.projectGroups`). */
const PROJECT_NAMESPACE = "projectGroups";
/**
* The setting a `'default'` write stores: switch the mode, **keep the memory**.
*
* `path`/`name` record which Workspace the user last picked, and switching to 默认 must
* not discard that — otherwise switching back has nothing to restore, which is how it was
* reported ("切回默认再回来又要重新选").
*
* ## Why this is a function and not two matching expressions
*
* The rule has to hold in **both** halves: the Host decides what to persist, and the
* Client's optimistic write decides what to render in the frame the user clicked. It was
* written out twice — the Host applied it, the Client did not — and the two drifted, which
* is what made the card flash 「未选择」 for one animation frame before the Host's frame
* corrected it. A single implementation cannot drift.
*
* Stated here rather than in `spec.ts` because that module imports `zod` as a **value** and
* therefore cannot be reached from the browser bundle. This module is already the two
* halves' shared vocabulary (see the constants above), so the rule belongs with them.
*
* Note that the `'specified'` direction is deliberately **not** mirrored here: it is
* genuinely asymmetric — a `name` that arrives absent is cleared, where `'default'` retains
* one — and forcing the two through one shape would erase that difference.
*
* ## The optional new memory
*
* `requested` is the Workspace the caller is storing now. The 更换… chooser replaces
* the remembered Workspace **without touching the mode**, so it calls this with the
* current mode and the newly picked path; a plain click on the 默认 card passes nothing
* and keeps what was already there.
*
* Keeping that in one place is the whole point of this function: the alternative was a
* second expression at each call site, which is exactly the drift described above.
* @param stored - the setting as it stands, or `undefined` before any write.
* @param requested - the memory being stored now; absent leaves the stored one alone.
* @returns the `'default'` setting, carrying whichever memory applies.
*/
function withDefaultMode(stored, requested) {
	return {
		mode: "default",
		path: requested?.path ?? stored?.path,
		name: requested?.name ?? stored?.name
	};
}
//#endregion
//#region src/index.ts
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) {
			if (kind === "field") initializers.unshift(_);
			else descriptor[key] = _;
		}
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/**
* Required Host services. The storage domain facility opens this plugin's
* domain; without it there is nowhere durable to put a project.
*
* Deliberately minimal. Both services this class reads opportunistically —
* `systemPrompt` for the injection and `sessions` for the subagent lineage walk —
* are read with `ctx.get` rather than declared here, because a name in this list
* is a **gate**: the whole plugin stays inactive until that service appears.
* Naming `sessions` would tie every project verb to the Session store, and naming
* `systemPrompt` would tie them to the prompt registry.
*/
const inject = ["storageDomain"];
/** Whether a parsed JSON value is a plain object to read keys from. */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* Reject a project spec override that is not one of the four storable values.
*
* Shared by BOTH write paths (`create` and `setProjectDocSpec`) because they must
* agree: `setProjectDocSpec` refused `'default'` while `create` accepted anything,
* so the same value was storable or not depending on which dialog the user opened.
* That is the one-sided-guard shape this codebase has already been bitten by twice.
*
* The four values are `null` (inherit), `'none'`, `'default'`, and an uploaded
* file name. `'none'` and `'default'` are semantic, not file names, so they must
* bypass the `.md` check that `isSafeSpecName` applies.
*
* Validating rather than coercing: a refused write surfaces as an error, where a
* silently-dropped field is what let the create dialog's choice vanish unnoticed.
* @param spec - the override as it arrived, or undefined/absent.
* @returns the override unchanged.
* @throws when the value is not storable.
*/
function assertUsableDocSpec(spec) {
	if (spec === void 0 || spec === null) return spec;
	if (spec === "none" || spec === "default") return spec;
	if (!isSafeSpecName(spec)) throw new Error(`not a usable spec file name: ${JSON.stringify(spec)}`);
	return spec;
}
/**
* Narrow one event's `data` to the `tool/call` fields it should hold.
* @param data - the event's untyped payload.
* @returns the fields, or undefined when the payload is not a tool call.
*/
function asToolCall(data) {
	if (!isRecord(data)) return void 0;
	if (typeof data.name !== "string" || typeof data.callId !== "string" || typeof data.arguments !== "string") return void 0;
	return {
		name: data.name,
		callId: data.callId,
		arguments: data.arguments
	};
}
/**
* Narrow one event's `data` to the `tool/result` fields it should hold.
* @param data - the event's untyped payload.
* @returns the fields, or undefined when the payload is not a tool result.
*/
function asToolResult(data) {
	if (!isRecord(data) || !isRecord(data.message)) return void 0;
	const message = data.message;
	if (typeof message.toolCallId !== "string") return void 0;
	const content = message.content;
	if (!Array.isArray(content)) return { message: {
		toolCallId: message.toolCallId,
		...message.isError === true ? { isError: true } : {},
		content: []
	} };
	const blocks = content.filter(isRecord).map((block) => ({
		type: typeof block.type === "string" ? block.type : "",
		...typeof block.text === "string" ? { text: block.text } : {}
	}));
	return { message: {
		toolCallId: message.toolCallId,
		...message.isError === true ? { isError: true } : {},
		content: blocks
	} };
}
/**
* Parse a model-produced argument string, tolerating anything malformed.
* @param raw - the raw JSON string from `tool/call`.
* @returns the object, or undefined when it is not a JSON object.
*/
function parseJsonObject(raw) {
	try {
		const parsed = JSON.parse(raw);
		return isRecord(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
/**
* The first selected label in an `ask_user_question` result.
*
* The tool renders its answer as one text block holding
* `{ answers: [{ id, selected: [...] }] }`, so the label is read out of that
* JSON rather than out of prose. Only the first question's first selection is
* used: our question is single-select and is the only one we ask for.
* @param content - the result message's content blocks.
* @returns the label, or undefined when the payload is not an answer batch.
*/
function firstAnswerLabel(content) {
	const text = content.find((block) => block.type === "text")?.text;
	if (text === void 0) return void 0;
	const answers = parseJsonObject(text)?.answers;
	if (!Array.isArray(answers)) return void 0;
	const first = answers[0];
	if (!isRecord(first)) return void 0;
	const selected = first.selected;
	if (!Array.isArray(selected)) return void 0;
	const label = selected[0];
	return typeof label === "string" ? label : void 0;
}
/**
* Order of this plugin's contribution within the runtime-context snapshot.
*
* A literal rather than a lookup: the official `getContextOrder` knows only
* `SANDBOX_POLICY` (110), `APPROVAL_POLICY` (115) and `SUBAGENT_DELEGATION` (120),
* so a plugin has no name to ask for. 200 places this block after all three — the
* end of the joined snapshot, which is where "which project am I working in"
* reads most naturally.
*/
const INJECTION_CONTEXT_ORDER = 200;
/** Contribution name, following the official `<area>:<aspect>` form. */
const INJECTION_CONTEXT_NAME = "project:info";
/**
* Host project registry: the durable table, its order, and the assignment map,
* plus the Remote methods the Client calls.
*
* Extends `TypertRemoteService` rather than plain `Service`: that base's
* constructor installs the `typertRemote` binding the Gateway's SRC discovery
* reads, and without it none of the `@Remote` markers below would be reachable.
*
* Reads are synchronous from the domain's in-memory state; every write queues on
* the domain's own chain, so a rejected durable write leaves memory untouched.
*/
let ProjectController = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _baseline_decorators;
	let _create_decorators;
	let _update_decorators;
	let _remove_decorators;
	let _reorder_decorators;
	let _assign_decorators;
	let _unassign_decorators;
	let _setExpanded_decorators;
	let _setOrders_decorators;
	let _setNewSessionTarget_decorators;
	let _setCreateOpensSession_decorators;
	let _setDirectories_decorators;
	let _setInjectProjectInfo_decorators;
	let _setInjectProjectDoc_decorators;
	let _setDocSpecMode_decorators;
	let _setDocSpecFileName_decorators;
	let _setPerProjectDocSpec_decorators;
	let _setProjectDocSpec_decorators;
	let _uploadSpec_decorators;
	let _deleteSpec_decorators;
	let _specsUsedBy_decorators;
	let _readSpec_decorators;
	let _setBaseWorkspace_decorators;
	let _rebuildBaseWorkspace_decorators;
	let _defaultWorkspacePath_decorators;
	let _follow_decorators;
	return class ProjectController extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_baseline_decorators = [Remote("baseline")];
			_create_decorators = [Remote("create")];
			_update_decorators = [Remote("update")];
			_remove_decorators = [Remote("delete")];
			_reorder_decorators = [Remote("reorder")];
			_assign_decorators = [Remote("assign")];
			_unassign_decorators = [Remote("unassign")];
			_setExpanded_decorators = [Remote("setExpanded")];
			_setOrders_decorators = [Remote("setOrders")];
			_setNewSessionTarget_decorators = [Remote("setNewSessionTarget")];
			_setCreateOpensSession_decorators = [Remote("setCreateOpensSession")];
			_setDirectories_decorators = [Remote("setDirectories")];
			_setInjectProjectInfo_decorators = [Remote("setInjectProjectInfo")];
			_setInjectProjectDoc_decorators = [Remote("setInjectProjectDoc")];
			_setDocSpecMode_decorators = [Remote("setDocSpecMode")];
			_setDocSpecFileName_decorators = [Remote("setDocSpecFileName")];
			_setPerProjectDocSpec_decorators = [Remote("setPerProjectDocSpec")];
			_setProjectDocSpec_decorators = [Remote("setProjectDocSpec")];
			_uploadSpec_decorators = [Remote("uploadSpec")];
			_deleteSpec_decorators = [Remote("deleteSpec")];
			_specsUsedBy_decorators = [Remote("specsUsedBy")];
			_readSpec_decorators = [Remote("readSpec")];
			_setBaseWorkspace_decorators = [Remote("setBaseWorkspace")];
			_rebuildBaseWorkspace_decorators = [Remote("rebuildBaseWorkspace")];
			_defaultWorkspacePath_decorators = [Remote("defaultWorkspacePath")];
			_follow_decorators = [Remote({ mode: "stream" })];
			__esDecorate(this, null, _baseline_decorators, {
				kind: "method",
				name: "baseline",
				static: false,
				private: false,
				access: {
					has: (obj) => "baseline" in obj,
					get: (obj) => obj.baseline
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _create_decorators, {
				kind: "method",
				name: "create",
				static: false,
				private: false,
				access: {
					has: (obj) => "create" in obj,
					get: (obj) => obj.create
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _update_decorators, {
				kind: "method",
				name: "update",
				static: false,
				private: false,
				access: {
					has: (obj) => "update" in obj,
					get: (obj) => obj.update
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remove_decorators, {
				kind: "method",
				name: "remove",
				static: false,
				private: false,
				access: {
					has: (obj) => "remove" in obj,
					get: (obj) => obj.remove
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _reorder_decorators, {
				kind: "method",
				name: "reorder",
				static: false,
				private: false,
				access: {
					has: (obj) => "reorder" in obj,
					get: (obj) => obj.reorder
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _assign_decorators, {
				kind: "method",
				name: "assign",
				static: false,
				private: false,
				access: {
					has: (obj) => "assign" in obj,
					get: (obj) => obj.assign
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _unassign_decorators, {
				kind: "method",
				name: "unassign",
				static: false,
				private: false,
				access: {
					has: (obj) => "unassign" in obj,
					get: (obj) => obj.unassign
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setExpanded_decorators, {
				kind: "method",
				name: "setExpanded",
				static: false,
				private: false,
				access: {
					has: (obj) => "setExpanded" in obj,
					get: (obj) => obj.setExpanded
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setOrders_decorators, {
				kind: "method",
				name: "setOrders",
				static: false,
				private: false,
				access: {
					has: (obj) => "setOrders" in obj,
					get: (obj) => obj.setOrders
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setNewSessionTarget_decorators, {
				kind: "method",
				name: "setNewSessionTarget",
				static: false,
				private: false,
				access: {
					has: (obj) => "setNewSessionTarget" in obj,
					get: (obj) => obj.setNewSessionTarget
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setCreateOpensSession_decorators, {
				kind: "method",
				name: "setCreateOpensSession",
				static: false,
				private: false,
				access: {
					has: (obj) => "setCreateOpensSession" in obj,
					get: (obj) => obj.setCreateOpensSession
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setDirectories_decorators, {
				kind: "method",
				name: "setDirectories",
				static: false,
				private: false,
				access: {
					has: (obj) => "setDirectories" in obj,
					get: (obj) => obj.setDirectories
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setInjectProjectInfo_decorators, {
				kind: "method",
				name: "setInjectProjectInfo",
				static: false,
				private: false,
				access: {
					has: (obj) => "setInjectProjectInfo" in obj,
					get: (obj) => obj.setInjectProjectInfo
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setInjectProjectDoc_decorators, {
				kind: "method",
				name: "setInjectProjectDoc",
				static: false,
				private: false,
				access: {
					has: (obj) => "setInjectProjectDoc" in obj,
					get: (obj) => obj.setInjectProjectDoc
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setDocSpecMode_decorators, {
				kind: "method",
				name: "setDocSpecMode",
				static: false,
				private: false,
				access: {
					has: (obj) => "setDocSpecMode" in obj,
					get: (obj) => obj.setDocSpecMode
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setDocSpecFileName_decorators, {
				kind: "method",
				name: "setDocSpecFileName",
				static: false,
				private: false,
				access: {
					has: (obj) => "setDocSpecFileName" in obj,
					get: (obj) => obj.setDocSpecFileName
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setPerProjectDocSpec_decorators, {
				kind: "method",
				name: "setPerProjectDocSpec",
				static: false,
				private: false,
				access: {
					has: (obj) => "setPerProjectDocSpec" in obj,
					get: (obj) => obj.setPerProjectDocSpec
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setProjectDocSpec_decorators, {
				kind: "method",
				name: "setProjectDocSpec",
				static: false,
				private: false,
				access: {
					has: (obj) => "setProjectDocSpec" in obj,
					get: (obj) => obj.setProjectDocSpec
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _uploadSpec_decorators, {
				kind: "method",
				name: "uploadSpec",
				static: false,
				private: false,
				access: {
					has: (obj) => "uploadSpec" in obj,
					get: (obj) => obj.uploadSpec
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _deleteSpec_decorators, {
				kind: "method",
				name: "deleteSpec",
				static: false,
				private: false,
				access: {
					has: (obj) => "deleteSpec" in obj,
					get: (obj) => obj.deleteSpec
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _specsUsedBy_decorators, {
				kind: "method",
				name: "specsUsedBy",
				static: false,
				private: false,
				access: {
					has: (obj) => "specsUsedBy" in obj,
					get: (obj) => obj.specsUsedBy
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _readSpec_decorators, {
				kind: "method",
				name: "readSpec",
				static: false,
				private: false,
				access: {
					has: (obj) => "readSpec" in obj,
					get: (obj) => obj.readSpec
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setBaseWorkspace_decorators, {
				kind: "method",
				name: "setBaseWorkspace",
				static: false,
				private: false,
				access: {
					has: (obj) => "setBaseWorkspace" in obj,
					get: (obj) => obj.setBaseWorkspace
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _rebuildBaseWorkspace_decorators, {
				kind: "method",
				name: "rebuildBaseWorkspace",
				static: false,
				private: false,
				access: {
					has: (obj) => "rebuildBaseWorkspace" in obj,
					get: (obj) => obj.rebuildBaseWorkspace
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _defaultWorkspacePath_decorators, {
				kind: "method",
				name: "defaultWorkspacePath",
				static: false,
				private: false,
				access: {
					has: (obj) => "defaultWorkspacePath" in obj,
					get: (obj) => obj.defaultWorkspacePath
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _follow_decorators, {
				kind: "method",
				name: "follow",
				static: false,
				private: false,
				access: {
					has: (obj) => "follow" in obj,
					get: (obj) => obj.follow
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static inject = ["storageDomain"];
		domain = __runInitializers(this, _instanceExtraInitializers);
		/** Live followers, each woken by a landed write. */
		followers = /* @__PURE__ */ new Set();
		/** Serializes domain opens so repeated activation cannot open twice. */
		opening;
		/** Listener for `domain/changed`, held so the close path can drop it. */
		detach;
		/**
		* Tail of the compound-mutation chain.
		*
		* The domain serializes each individual write, but a create or a delete is
		* three to five writes plus a marker, and a second caller interleaving between
		* them would observe a half-applied mutation — or, worse, overwrite the marker
		* that makes recovery possible. Mirrors the official registry's
		* `operationTail` (`workspace/src/index.ts`).
		*/
		operationTail = Promise.resolve();
		/**
		* `ask_user_question` calls carrying our drift question, by call id.
		*
		* The call and its result arrive as two separate `session/event`s, and only the
		* result carries the answer, so the call id has to be remembered in between.
		* Keyed by call id alone because the id is unique per session; the value keeps
		* the session so the answer can be attributed to the right project.
		*/
		pendingDriftCalls = /* @__PURE__ */ new Map();
		/**
		* The tail of the global-write chain.
		*
		* Every global write is a read-modify-write (`get()` then spread then `set()`),
		* so two writes that overlap in flight both read the pre-write snapshot and the
		* later one silently drops the earlier one's field. That was measured, not
		* theorised: firing `setDocSpecFileName` and `setDocSpecMode` together lost the
		* name in 12 of 12 runs, leaving `mode: 'custom'` with an empty file name — the
		* exact "empty custom" state the setting must never hold.
		*
		* Chaining each write onto the previous one makes the `get()` happen after the
		* previous `set()` has landed. It lives here rather than in the one call site
		* that exposed it because the hazard is a property of `setGlobal`, not of that
		* pair of fields: any two overlapping global writes can lose one another.
		*
		* A second queue beside {@link operationTail}, not a replacement for it. That
		* one orders *compound* mutations (create/delete, several writes plus a recovery
		* marker); this one orders the individual read-modify-write, and so also covers
		* the settings verbs that never enter `operate` — which is precisely where the
		* lost update was measured. The two nest harmlessly: a write inside `operate`
		* simply waits for its own chain too.
		*/
		globalWriteChain = Promise.resolve();
		/**
		* @param ctx - Host context carrying the storage-domain facility.
		*/
		constructor(ctx) {
			super(ctx, PROJECT_SERVICE_KEY, { namespace: PROJECT_NAMESPACE });
			ctx.effect(() => () => this.close(), "project-groups: domain close");
			ctx.inject(["systemPrompt"], (scope) => {
				this.installInjection(scope);
			});
			ctx.effect(() => this.observeSessions(ctx), "project-groups: spec-drift answers");
		}
		/**
		* Follow every Session's events to learn which drift choice the user made.
		*
		* ## Why the event stream rather than the official projection
		*
		* `ctx.sessionProjections.stateOf(session, 'userQuestions')` looks like the
		* natural source, and it is what `@deepseek-ai/dsh-user-questions` uses
		* internally. It is empty here: that projection records a question only when
		* the Session header shows the **timed** `ask_user_question` schema
		* (`projection.ts`: `if (!fold.timed …) return fold`), and the shipped
		* profile mounts the tool with its default `legacy` mode. Reading it would
		* silently never fire, which is the worst kind of failure.
		*
		* So this reads the two events the tool itself produces — `tool/call` carries
		* the questions, `tool/result` carries the answers — and selects ours by the
		* question id rather than by matching prose.
		*
		* `{ global: true }` is what makes a plugin receive events from Sessions it
		* does not own; the official `user-questions` plugin uses the same option for
		* the same purpose.
		* @param ctx - Host context to subscribe on.
		* @returns the disposer the owning effect drops on unload.
		*/
		observeSessions(ctx) {
			const off = ctx.on("session/event", (session, event) => {
				try {
					this.observeEvent(session.id, event);
				} catch (error) {
					ctx.logger.warn("project-groups: spec-drift observation failed: %o", error);
				}
			}, { global: true });
			return () => {
				off();
				this.pendingDriftCalls.clear();
			};
		}
		/**
		* Apply one Session event to the drift bookkeeping.
		* @param sessionId - the Session the event belongs to.
		* @param event - the event.
		*/
		observeEvent(sessionId, event) {
			if (event.type === "tool/call") {
				const call = asToolCall(event.data);
				if (call === void 0 || call.name !== "ask_user_question") return;
				if (!this.askCarriesDriftQuestion(call.arguments)) return;
				const domain = this.domain;
				if (domain === void 0) return;
				const projectId = this.projectOfSession(domain, sessionId);
				if (projectId === void 0) return;
				this.pendingDriftCalls.set(call.callId, {
					sessionId,
					projectId
				});
				return;
			}
			if (event.type !== "tool/result") return;
			const result = asToolResult(event.data);
			if (result === void 0) return;
			const pending = this.pendingDriftCalls.get(result.message.toolCallId);
			if (pending === void 0) return;
			this.pendingDriftCalls.delete(result.message.toolCallId);
			if (result.message.isError === true) return;
			const label = firstAnswerLabel(result.message.content);
			if (label === void 0) return;
			const choice = matchSpecDriftChoice(label);
			if (choice === void 0) return;
			this.applyDriftChoice(pending.projectId, choice).catch((error) => {
				this.ctx.logger.warn("project-groups: recording the spec-drift choice failed: %o", error);
			});
		}
		/**
		* Whether one `ask_user_question` argument JSON asks our drift question.
		*
		* The id is the selector; the prompt tells the model to reuse it verbatim, and
		* a mismatch simply means this is somebody else's question.
		* @param raw - the model's raw argument JSON.
		* @returns true when one of the questions carries our id.
		*/
		askCarriesDriftQuestion(raw) {
			const questions = parseJsonObject(raw)?.questions;
			if (!Array.isArray(questions)) return false;
			return questions.some((question) => isRecord(question) && question.id === "project-doc-spec-drift");
		}
		/**
		* Record the user's choice.
		*
		* The two durable choices both name the spec **content** they refer to, so a
		* later spec change re-opens the question; the middle choice deliberately
		* writes nothing, which is what makes it "this time" rather than "from now on".
		* @param projectId - the project whose document is under discussion.
		* @param choice - the matched choice.
		*/
		async applyDriftChoice(projectId, choice) {
			const domain = await this.ready();
			const record = domain.table("projects").get(projectId);
			if (record === void 0) return;
			if (choice === "skip") return;
			const spec = specIdentity(this.ctx, domain.global.get(), record);
			if (spec.sha1 === void 0) return;
			const now = (/* @__PURE__ */ new Date()).toISOString();
			const { docSpecIgnored: _previous, ...rest } = record;
			const next = choice === "rewrite" ? {
				...rest,
				docSpecUsed: spec.sha1,
				updatedAt: now
			} : {
				...rest,
				docSpecIgnored: spec.sha1,
				updatedAt: now
			};
			await domain.table("projects").put(projectId, next);
		}
		/**
		* Open this plugin's domain once, on first use.
		*
		* Deferred rather than done in the constructor because `open` is async and a
		* Service constructor is not; a composition that never touches projects pays
		* nothing for it.
		* @returns the open domain.
		*/
		async ready() {
			this.opening ??= (async () => {
				this.domain = await this.ctx.storageDomain.open(projectDomainSpec);
				await this.recoverPendingMutation(this.domain);
				this.detach = this.ctx.on("domain/changed", (change) => {
					if (change.domain !== "project_groups") return;
					for (const wake of [...this.followers]) wake();
				});
			})();
			await this.opening;
			/* v8 ignore next -- the open assigned `domain`, or it threw and this line is unreachable. */
			return this.domain;
		}
		async close() {
			const domain = this.domain;
			this.detach?.();
			this.detach = void 0;
			this.domain = void 0;
			this.opening = void 0;
			this.followers.clear();
			if (domain !== void 0) await domain.close();
		}
		/** Current display order; empty before the first order write. */
		order() {
			return this.domain?.global.get().projectIds ?? [];
		}
		/**
		* Finish whatever a previous process left in flight.
		*
		* A marker names one compound mutation that did not complete. Its id is absent
		* from `projectIds` whichever direction it was going (see `pendingMutation` in
		* `spec.ts`), so the leftover is always the record set, and removing every
		* trace of that project is the whole repair. Nothing can reference it: an
		* assignment is only written after `assign` has seen the record exist.
		*
		* The sweep is wider than the official registry's single-record delete because
		* a delete here touches four tables, so an interruption can strand an
		* assignment, an expansion or an order alongside the record. Deleting a set
		* that is partly absent is a no-op per missing key, so this is idempotent —
		* which matters, because it also runs before the next mutation and again on
		* every start.
		* @param domain - the open domain.
		*/
		async recoverPendingMutation(domain) {
			const pending = domain.global.get().pendingMutation;
			if (pending === void 0) return;
			const { projectId } = pending;
			for (const [sessionId, record] of [...domain.table("assignments").entries()]) if (record.projectId === projectId) await domain.table("assignments").delete(sessionId);
			await domain.table("projects").delete(projectId);
			await domain.table("expansions").delete(projectId);
			await domain.table("orders").delete(projectId);
			await this.setGlobal(domain, { pendingMutation: void 0 });
		}
		/**
		* Run one compound mutation on the shared tail, finishing any interrupted
		* predecessor first.
		*
		* Recovery runs inside the slot rather than only at startup because a marker
		* left behind must be cleared before this operation writes its own — otherwise
		* this one would overwrite the record of what still needs repairing.
		* @param domain - the open domain.
		* @param operation - the mutation to run.
		* @returns the operation's result.
		*/
		operate(domain, operation) {
			const result = this.operationTail.then(async () => {
				await this.recoverPendingMutation(domain);
				return await operation();
			});
			this.operationTail = result.then(() => {}, () => {});
			return result;
		}
		/**
		* Reject a title another project already uses.
		*
		* Titles are unique, the way Workspace titles are: `dsh-client-ui-workspace` blocks a rename
		* whose trimmed title another row holds (`workspaces.some(w => w.workspaceId !==
		* renameTarget.workspaceId && w.title === renameTrimmed)`). That check only guards its own
		* dialog, so the rule is enforced here as well — the Remote is a public entry point, and a
		* caller that skips the dialog would otherwise be able to create two indistinguishable rows.
		*
		* Compared after trimming, because the trimmed title is what gets stored: `'a '` and `'a'` are
		* the same name. Otherwise exact and case-sensitive, mirroring the dialog's `===`; being
		* stricter here would refuse a name that dialog accepted.
		* @param domain - the open domain.
		* @param title - the trimmed candidate title.
		* @param exceptId - project allowed to keep this title (itself, on a rename).
		*/
		assertTitleFree(domain, title, exceptId) {
			for (const [id, record] of domain.table("projects").entries()) if (id !== exceptId && record.title === title) throw new Error(`a project named "${title}" already exists`);
		}
		/**
		* Write the global singleton, changing only the fields given.
		*
		* `Domain.global.set` replaces the whole value rather than merging into it, so
		* every writer must spread what is already stored. Routing them all through
		* here means a writer cannot drop a field it does not know about — which is
		* exactly what the type checker caught when `newSessionTarget` was added to a
		* singleton three existing call sites were writing whole.
		* @param domain - the open domain.
		* @param patch - the fields to change.
		*/
		/**
		* Merge a patch into the global record, serialized against every other global
		* write.
		*
		* The read and the write are one critical section: `get()` runs only after the
		* previous write in the chain has settled, so no two overlapping callers can
		* read the same snapshot. The chain continues past a failure — a rejected write
		* must not wedge every later one — and the failure still reaches its own caller.
		*
		* **Deliberately not merged into one verb per field pair.** A combined
		* `setDocSpecModeAndFileName` would fix the reported symptom while leaving the
		* hazard for the next pair of fields, which is why the queue is here instead.
		* @param domain - the open domain.
		* @param patch - the fields to merge into the stored global.
		* @returns when this write has landed.
		*/
		async setGlobal(domain, patch) {
			const write = this.globalWriteChain.then(() => domain.global.set({
				...domain.global.get(),
				...patch
			}));
			this.globalWriteChain = write.then(() => void 0, () => void 0);
			return write;
		}
		projectValue(projectId, record) {
			return {
				projectId,
				title: record.title,
				directories: [...record.directories],
				docPath: record.docPath,
				...record.docSpec !== void 0 ? { docSpec: record.docSpec } : {},
				...record.docSpecUsed !== void 0 ? { docSpecUsed: record.docSpecUsed } : {},
				createdAt: record.createdAt,
				updatedAt: record.updatedAt
			};
		}
		/**
		* Register this plugin's runtime-context contribution for the lifetime of the
		* injected scope.
		*
		* Scoped to the child fiber `ctx.inject` created, so it is disposed with the
		* plugin and needs no separate effect: a disabled plugin contributes nothing,
		* which is what "switching it off restores the official chain" means
		* mechanically — there is nothing left to clean up.
		* @param scope - the context whose scope owns the contribution.
		*/
		installInjection(scope) {
			const prompt = scope.get("systemPrompt");
			if (prompt === void 0) return;
			prompt.context({
				name: INJECTION_CONTEXT_NAME,
				order: INJECTION_CONTEXT_ORDER,
				text: (context) => this.injectionText(context)
			});
		}
		/**
		* Render this plugin's contribution for one assembly.
		*
		* Synchronous because `PromptContext.text` is: the registry renders during
		* request preparation and cannot await. Every read below is therefore an
		* in-memory domain read, which is what `Domain` provides — tables and the
		* global singleton are synchronous, only opening and writing are not.
		*
		* The provider is evaluated for every prepared request, but the registry
		* commits a message only when the composed text differs from the one it
		* retained (`agent-loop/src/runtime-context.ts`), so an unchanged project costs
		* nothing in history. That is also why an edit becomes visible on the next
		* request: the text is re-derived rather than cached here.
		* @param context - the assembly's context; `agent` is absent on bare assemblies.
		* @returns the contribution, or `''` to contribute nothing.
		*/
		injectionText(context) {
			const sessionId = context.agent?.session?.id;
			if (sessionId === void 0) return "";
			const domain = this.domain;
			if (domain === void 0) {
				this.ready().catch((error) => {
					this.ctx.logger.warn("project-groups: the project domain could not be opened for injection: %o", error);
				});
				return "";
			}
			if (!domain.global.get().injectProjectInfo) return "";
			const projectId = this.projectOfSession(domain, sessionId);
			const project = projectId === void 0 ? void 0 : domain.table("projects").get(projectId);
			return renderProjectInjection({
				project,
				document: projectId === void 0 || project === void 0 || !domain.global.get().injectProjectDoc ? void 0 : this.documentInjection(domain, projectId, project)
			});
		}
		/**
		* Assemble the document half of the contribution for one filed project.
		*
		* ## Why the hashing happens here and not in the renderer
		*
		* `renderProjectInjection` is pure and covered by tests that pass plain
		* objects. Reading the spec file is I/O, so it stays on this side and the
		* renderer receives a finished value. This is also the only place that knows
		* the configured locale, which the drift question needs.
		*
		* ## Why a missing `docSpecUsed` never reports drift
		*
		* That field is absent exactly when the document has never been written, and a
		* document that does not exist has nothing to migrate. Asking about it would
		* send the user a question whose first option ("rewrite the existing document")
		* has nothing to act on.
		* @param domain - the open domain.
		* @param projectId - the owning project id.
		* @param project - its record.
		* @returns the document lines, including the drift prompt when it applies.
		*/
		documentInjection(domain, projectId, project) {
			const global = domain.global.get();
			const spec = specIdentity(this.ctx, global, project);
			const docPath = documentPath(this.ctx, projectId);
			const drift = shouldAskSpecDrift({
				usedSha1: project.docSpecUsed,
				ignoredSha1: project.docSpecIgnored,
				currentSha1: spec.sha1
			}) ? {
				locale: this.injectionLocale(),
				rewriteFlowPath: REWRITE_FLOW_PATH
			} : void 0;
			return {
				docPath,
				specMode: spec.mode,
				specPath: spec.path,
				drift
			};
		}
		/**
		* The locale for user-facing injection text.
		*
		* Read from the launcher's settings document, where the `locale` entry keeps
		* its `preference`. The Host cannot see the operating-system language — the
		* Desktop preload hands that straight to the browser — so an absent preference
		* means "follow the system", and Chinese is the honest default for this
		* deployment while an explicit choice is what makes the answer exact.
		* @returns the locale to render the drift question in.
		*/
		injectionLocale() {
			try {
				return ((this.ctx.get("settings")?.describe?.().find((entry) => entry.ns === "locale"))?.value)?.preference === "en" ? "en" : "zh";
			} catch {
				return "zh";
			}
		}
		/**
		* Resolve the project owning one Session, following subagent lineage.
		*
		* ## Why this walk exists
		*
		* A subagent's session never reaches `assignments`: only `session.create` with a
		* `workspaceId` attaches anything, and a delegated child is created through the
		* Agent registry instead. Without this, every delegated child would report itself
		* ungrouped even though it is working inside its parent's project.
		*
		* ## Mirrored from the official walk
		*
		* The shape copies `underArchivedSession`
		* (`packages/api/session-controller/src/archived-session-gate.ts`):
		* the same synchronous store hop, the same `origin === 'subagent'` gate on the
		* edge, and the same visited set against a corrupt lineage. That function is the
		* one to copy rather than `forkWorkspace`, which answers the same question with
		* an async `sessionQuery.traceSession()` and is therefore only usable from an
		* occasional caller — this runs for every prepared request.
		*
		* ## A closed ancestor is still readable
		*
		* The parent's **project** is available even after that parent Session has
		* closed: `assignments` is this plugin's own durable table keyed by session id,
		* and the id survives in `header.parentSession`. Only climbing *past* the
		* ancestor needs the live store. The official walk reads its set the same way —
		* `archived.includes(parentId)` when the parent Session is absent.
		* @param domain - the open domain.
		* @param sessionId - the Session whose owning project is required.
		* @returns the owning project id, or undefined when the Session is unfiled.
		*/
		projectOfSession(domain, sessionId) {
			const assignments = domain.table("assignments");
			const direct = assignments.get(String(sessionId))?.projectId;
			if (direct !== void 0) return direct;
			const sessions = this.ctx.get("sessions");
			if (sessions === void 0) return void 0;
			let header = sessions.get(sessionId)?.header;
			if (header === void 0) return void 0;
			if (header.origin !== "subagent") return void 0;
			const visited = /* @__PURE__ */ new Set([sessionId]);
			while (header.parentSession !== void 0) {
				const parentId = header.parentSession;
				if (visited.has(parentId)) return void 0;
				visited.add(parentId);
				const filed = assignments.get(String(parentId))?.projectId;
				if (filed !== void 0) return filed;
				const parent = sessions.get(parentId);
				if (parent === void 0) return void 0;
				header = parent.header;
				if (header.origin !== "subagent") return void 0;
			}
		}
		/**
		* The complete Client projection: projects in display order, the order itself,
		* and every assignment.
		*
		* Derived from the order alone, the way the official registry derives its list
		* from `workspaceIds` (`workspace/src/index.ts`). A record whose id has not
		* reached the order is **not** part of the projection, and that is what makes a
		* create one visible transition: the interval between the record write and the
		* order write is indistinguishable from the state before it, so the client's
		* value-equality guard drops that frame and only the completed write renders.
		* Listing such a record instead — appended below the ordered rows — showed the
		* new row at the bottom and then moved it to the top, which read as a slide.
		*
		* Nothing is lost by not rendering it: a record can only be order-less while a
		* mutation is in flight, and `recoverPendingMutation` removes whatever an
		* interruption left, so the state cannot persist across a start.
		* @returns the baseline a following generation opens with.
		*/
		async baseline() {
			const domain = await this.ready();
			const projects = domain.table("projects");
			const assignments = domain.table("assignments");
			const ordered = this.order().filter((id) => projects.get(id) !== void 0);
			return {
				projects: ordered.map((id) => this.projectValue(id, projects.get(id))),
				projectIds: ordered,
				assignments: Object.fromEntries([...assignments.entries()].map(([sessionId, record]) => [sessionId, record.projectId])),
				expansions: Object.fromEntries([...domain.table("expansions").entries()].map(([projectId, record]) => [projectId, record.expanded])),
				orders: Object.fromEntries([...domain.table("orders").entries()].map(([projectId, record]) => [projectId, [...record.sessionIds]])),
				newSessionTarget: domain.global.get().newSessionTarget,
				baseWorkspace: domain.global.get().baseWorkspace,
				createOpensSession: domain.global.get().createOpensSession,
				injectProjectInfo: domain.global.get().injectProjectInfo,
				injectProjectDoc: domain.global.get().injectProjectDoc,
				docSpecMode: domain.global.get().docSpecMode,
				docSpecFileName: domain.global.get().docSpecFileName,
				perProjectDocSpec: domain.global.get().perProjectDocSpec,
				specs: await listUploadedSpecs(this.ctx)
			};
		}
		/**
		* Create a project, at the **front** of the display order.
		*
		* Prepend rather than append, matching the Host's own Workspace registry
		* (`packages/workspace/workspace/src/index.ts`: `workspaceIds: [id,
		* ...state.workspaceIds]`). A new row appears where the user is looking instead
		* of below however many rows already exist, which is what makes a long list
		* workable.
		*
		* Three writes, in the official registry's order — marker, record, order — and
		* the sequence carries two separate guarantees:
		*
		* - **The order is written last**, so an interruption always leaves the id
		*   absent from `projectIds` and the record as the only thing recovery has to
		*   name. Writing it earlier would strand the id there, where the marker
		*   cannot reach it.
		* - **The marker is its own write**, even though it shares the global with the
		*   order. Folding the two together would publish the id in the order while
		*   the record does not yet exist, which is the same stranding with extra
		*   steps.
		*
		* Only the last write changes the projection, so the sidebar renders one
		* insert. The first two produce frames that are value-equal to the one before
		* them, and the client drops those (`src/client/projects.ts` compares by
		* value before publishing). Without that, the record-only frame would show the
		* new row appended below the ordered ones and then move it to the top, which
		* reads as a slide.
		* @param request - display title; surrounding whitespace is trimmed.
		* @returns the created project.
		*/
		async create(request) {
			const title = request.title.trim();
			if (title === "") throw new Error("a project title is required");
			const directories = [...request.directories ?? []];
			assertUsableDocSpec(request.docSpec);
			const domain = await this.ready();
			return await this.operate(domain, async () => {
				this.assertTitleFree(domain, title);
				const projectId = newProjectId();
				const now = (/* @__PURE__ */ new Date()).toISOString();
				const record = {
					title,
					directories,
					docPath: "",
					...request.docSpec !== void 0 && request.docSpec !== null ? { docSpec: request.docSpec } : {},
					createdAt: now,
					updatedAt: now
				};
				await this.setGlobal(domain, { pendingMutation: {
					operation: "create",
					projectId
				} });
				await domain.table("projects").put(projectId, record);
				await this.setGlobal(domain, {
					projectIds: [projectId, ...this.order()],
					pendingMutation: void 0
				});
				return { project: this.projectValue(projectId, record) };
			});
		}
		/**
		* Replace one project's title and directories in a single write.
		*
		* ## Why one verb and one write
		*
		* The edit dialog commits both fields with one button. A title write followed
		* by a directory write would leave the row retitled while its directories were
		* still the old ones — a state the user never asked for and can observe — and a
		* failure between the two calls would leave exactly that state durably. A table
		* `put` replaces the whole record, so doing both here costs nothing over one.
		*
		* These two fields are also the whole of what a project is to its owner: its
		* name and where it lives. Separate verbs would make "edit a project" a
		* caller-side protocol rather than a domain operation.
		*
		* ## What it preserves
		*
		* Every field it does not name, `docPath` included: the record is spread and
		* re-put rather than rebuilt, so a field added later cannot be dropped here.
		*
		* ## Validation
		*
		* The title is trimmed, must be non-blank, and must be free — the same rule the
		* former `rename` enforced and which `create` shares, excluded by id so
		* re-submitting a project's own name is not a conflict with itself. Directories
		* are **not** validated: they are user-declared associations, not proofs (see
		* {@link setDirectories}).
		* @param request - target project, its complete title and directory list.
		* @returns the project as stored.
		*/
		async update(request) {
			const title = request.title.trim();
			if (title === "") throw new Error("a project title is required");
			const domain = await this.ready();
			const record = domain.table("projects").get(request.projectId);
			if (record === void 0) throw new Error(`unknown project: ${request.projectId}`);
			this.assertTitleFree(domain, title, request.projectId);
			const next = {
				...record,
				title,
				directories: [...request.directories],
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			};
			await domain.table("projects").put(request.projectId, next);
			return { project: this.projectValue(request.projectId, next) };
		}
		/**
		* Remove one project, every assignment onto it, and its presentation records.
		*
		* Sessions are not touched: an assignment is this plugin's own record, and a
		* Session without one is simply Ungrouped. The expansion and order go with the
		* project because both are keyed by project id and would otherwise be
		* unreachable state.
		*
		* The order is written **first** here, the mirror of create and the official
		* registry's shape (`workspace/src/index.ts`). The row leaves the display
		* before its records are dropped, so an interruption leaves the id absent from
		* `projectIds` — which is what lets recovery treat a half-finished delete
		* exactly like a half-finished create: delete the record set, clear the
		* marker. Writing the order last would leave the id in it with nothing to
		* name, and the marker could not repair that.
		*
		* It also makes the row disappear on the first write rather than after four
		* table sweeps, which is what the user is watching.
		* @param request - target project.
		*/
		async remove(request) {
			const domain = await this.ready();
			await this.operate(domain, async () => {
				await this.setGlobal(domain, {
					projectIds: this.order().filter((id) => id !== request.projectId),
					pendingMutation: {
						operation: "delete",
						projectId: request.projectId
					}
				});
				for (const [sessionId, record] of [...domain.table("assignments").entries()]) if (record.projectId === request.projectId) await domain.table("assignments").delete(sessionId);
				await domain.table("projects").delete(request.projectId);
				await domain.table("expansions").delete(request.projectId);
				await domain.table("orders").delete(request.projectId);
				await this.setGlobal(domain, { pendingMutation: void 0 });
			});
		}
		/**
		* Move one project in display order.
		* @param request - project to move and the project it should precede.
		* @returns the new order.
		*/
		async reorder(request) {
			const domain = await this.ready();
			const current = [...this.order()];
			if (!current.includes(request.projectId)) throw new Error(`unknown project: ${request.projectId}`);
			const rest = current.filter((id) => id !== request.projectId);
			const index = request.beforeId === void 0 ? rest.length : rest.indexOf(request.beforeId);
			if (index === -1) throw new Error(`unknown project: ${String(request.beforeId)}`);
			const projectIds = [
				...rest.slice(0, index),
				request.projectId,
				...rest.slice(index)
			];
			await this.setGlobal(domain, { projectIds });
			return { projectIds };
		}
		/**
		* File one Session under one project, replacing any previous assignment.
		* @param request - Session and target project.
		* @returns the landed assignment.
		*/
		async assign(request) {
			const domain = await this.ready();
			if (domain.table("projects").get(request.projectId) === void 0) throw new Error(`unknown project: ${request.projectId}`);
			await domain.table("assignments").put(request.sessionId, {
				projectId: request.projectId,
				assignedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			return {
				sessionId: request.sessionId,
				projectId: request.projectId
			};
		}
		/**
		* Return one Session to Ungrouped.
		* @param request - Session to unassign.
		* @returns whether an assignment was removed.
		*/
		async unassign(request) {
			const removed = await (await this.ready()).table("assignments").delete(request.sessionId);
			return {
				sessionId: request.sessionId,
				removed
			};
		}
		/**
		* Record one project row's open/closed state.
		*
		* Stored here rather than in the browser's view store because that store is
		* shared with the official plugin, whose mount prunes every key that is not a
		* Workspace id — so a project's expansion kept there is lost the first time the
		* official sidebar mounts, which is precisely what switching this plugin off
		* does.
		*
		* A write is always recorded, `false` included: "folded deliberately" and
		* "never touched" must stay distinguishable, since only the latter lets the
		* browser open the group holding the current Session.
		* @param request - target project and its new state.
		* @returns the recorded state.
		*/
		async setExpanded(request) {
			const domain = await this.ready();
			if (domain.table("projects").get(request.projectId) === void 0) throw new Error(`unknown project: ${request.projectId}`);
			await domain.table("expansions").put(request.projectId, { expanded: request.expanded });
			return {
				projectId: request.projectId,
				expanded: request.expanded
			};
		}
		/**
		* Replace the manual order of every project.
		*
		* Whole-map, because the callers need exactly that: a drop rewrites the target
		* project and freezes the rest, switching to manual freezes all of them, and
		* switching to recency discards them all. A project absent from the request has
		* its record **deleted** — that is what makes recency mode mean "no manual
		* order" rather than "a stale one".
		*
		* Writes are diffed against what is stored. Every landed write makes the
		* follower re-project, so skipping unchanged projects keeps a frame's cost
		* proportional to the real change rather than to the number of projects.
		*
		* Unknown project ids are dropped, not refused: they can only come from a race
		* with a delete, and refusing would turn that race into a lost drag.
		* @param request - the complete order map to store.
		* @returns the map the Host actually holds.
		*/
		async setOrders(request) {
			const domain = await this.ready();
			const projects = domain.table("projects");
			const orders = domain.table("orders");
			const next = Object.fromEntries(Object.entries(request.orders).filter(([projectId]) => projects.get(projectId) !== void 0).map(([projectId, sessionIds]) => [projectId, [...sessionIds]]));
			for (const projectId of [...orders.keys()]) if (next[projectId] === void 0) await orders.delete(projectId);
			for (const [projectId, sessionIds] of Object.entries(next)) {
				const stored = orders.get(projectId)?.sessionIds;
				if (!(stored !== void 0 && stored.length === sessionIds.length && stored.every((id, index) => id === sessionIds[index]))) await orders.put(projectId, { sessionIds });
			}
			return { orders: next };
		}
		/**
		* Choose where a New Session with no stated destination lands.
		*
		* The stored global is spread before the write because `Domain.global.set`
		* replaces the whole singleton rather than merging into it: sending only the
		* target would drop `projectIds` and make every project disappear from the
		* sidebar.
		* @param request - the chosen destination.
		* @returns the stored choice.
		*/
		async setNewSessionTarget(request) {
			const domain = await this.ready();
			await this.setGlobal(domain, { newSessionTarget: request.target });
			return { target: request.target };
		}
		/**
		* Choose whether creating a project also opens a Session inside it.
		*
		* The stored global is spread before the write because `Domain.global.set`
		* replaces the whole singleton rather than merging into it: sending only this
		* value would drop `projectIds` and make every project disappear from the
		* sidebar.
		* @param request - the chosen behaviour.
		* @returns the stored value.
		*/
		async setCreateOpensSession(request) {
			const domain = await this.ready();
			await this.setGlobal(domain, { createOpensSession: request.value });
			return { value: request.value };
		}
		/**
		* Replace one project's associated directories.
		*
		* **Whole-list**, matching {@link setOrders}: the caller is the edit dialog,
		* which already holds the complete list it wants stored, so a partial add/remove
		* protocol would only force the Host to reconstruct intent it was never given.
		*
		* The record is spread and re-put rather than field-updated, because a table
		* `put` replaces the whole value — writing only `directories` would silently
		* drop the title and the document binding.
		*
		* `updatedAt` is stamped, exactly as {@link rename} stamps it: the list is part
		* of what a project *is*, so a change to it is a real mutation rather than a
		* presentation-only write.
		*
		* Directories are **not** validated. They are user-declared associations, not
		* filesystem proofs: a directory may be planned, temporarily offline, or on a
		* drive that is not mounted right now, and refusing the write would make the
		* setting unusable in precisely those cases. Nothing in this plugin resolves
		* them, so an unresolvable entry costs nothing until something tries to read it.
		* @param request - target project and its complete directory list.
		* @returns the list as stored.
		*/
		async setDirectories(request) {
			const domain = await this.ready();
			const record = domain.table("projects").get(request.projectId);
			if (record === void 0) throw new Error(`unknown project: ${request.projectId}`);
			const directories = [...request.directories];
			await domain.table("projects").put(request.projectId, {
				...record,
				directories,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			return {
				projectId: request.projectId,
				directories: [...directories]
			};
		}
		/**
		* Choose whether a Session's project info is injected.
		*
		* Written through {@link setGlobal}, which spreads the stored singleton: a whole
		* write would drop `projectIds` and empty the sidebar.
		* @param request - the chosen behaviour.
		* @returns the stored value.
		*/
		async setInjectProjectInfo(request) {
			const domain = await this.ready();
			await this.setGlobal(domain, { injectProjectInfo: request.value });
			return { value: request.value };
		}
		/**
		* Choose whether the work-document line is injected alongside the base info.
		*
		* Independent of {@link setInjectProjectInfo} on purpose: the document is the
		* extra feature, so its switch governs one line rather than riding the base
		* switch. The injection itself reads both flags — the document line is emitted
		* only when **this** is on, and the base block only when the other is.
		* @param request - the chosen behaviour.
		* @returns the stored value.
		*/
		async setInjectProjectDoc(request) {
			const domain = await this.ready();
			await this.setGlobal(domain, { injectProjectDoc: request.value });
			return { value: request.value };
		}
		/**
		* Choose which spec source applies before any per-project override.
		*
		* Switching modes keeps `docSpecFileName`: it records which file the user last
		* uploaded, so returning to `'custom'` restores that choice rather than
		* forcing another upload. Readers branch on the mode, so a retained name
		* cannot be mistaken for an active one.
		* @param request - the chosen mode.
		* @returns the stored mode.
		*/
		async setDocSpecMode(request) {
			const domain = await this.ready();
			await this.setGlobal(domain, { docSpecMode: request.mode });
			return { mode: request.mode };
		}
		/**
		* Name the uploaded spec that `'custom'` mode refers to.
		*
		* An empty name is accepted and stored: it is the state the card renders as
		* "selected but not chosen yet", and refusing it would make switching to
		* `'custom'` before picking a file impossible.
		* @param request - the bare `*.md` file name, or `''`.
		* @returns the stored name.
		*/
		async setDocSpecFileName(request) {
			const name = request.name.trim();
			if (name !== "" && !isSafeSpecName(name)) throw new Error(`not a usable spec file name: ${JSON.stringify(request.name)}`);
			const domain = await this.ready();
			await this.setGlobal(domain, { docSpecFileName: name });
			return { name };
		}
		/**
		* Choose whether the project dialogs expose a per-project spec row.
		* @param request - the chosen behaviour.
		* @returns the stored value.
		*/
		async setPerProjectDocSpec(request) {
			const domain = await this.ready();
			await this.setGlobal(domain, { perProjectDocSpec: request.value });
			return { value: request.value };
		}
		/**
		* Set or clear one project's spec override.
		*
		* `null` clears the field rather than storing a sentinel, because absence is
		* what "inherit the global choice" means; `'none'` is a deliberate "no spec"
		* and must stay distinguishable from it.
		* @param request - the project and its override, or `null` to inherit.
		* @returns the override as stored.
		*/
		async setProjectDocSpec(request) {
			const domain = await this.ready();
			const record = domain.table("projects").get(request.projectId);
			if (record === void 0) throw new Error(`no such project: ${request.projectId}`);
			assertUsableDocSpec(request.spec);
			const now = (/* @__PURE__ */ new Date()).toISOString();
			const { docSpec: _cleared, ...rest } = record;
			const next = request.spec === null ? {
				...rest,
				updatedAt: now
			} : {
				...rest,
				docSpec: request.spec,
				updatedAt: now
			};
			await domain.table("projects").put(request.projectId, next);
			return {
				projectId: request.projectId,
				spec: request.spec
			};
		}
		/**
		* Store one uploaded spec.
		*
		* Refusing a taken name rather than replacing it is the surface's rule: the
		* file may have been hand-edited since it was uploaded, and destroying it
		* silently is worse than making the user rename. The reply carries the current
		* list so the caller refreshes in the same round trip.
		* @param request - the file name and its text.
		* @returns whether the write landed, plus the names now present.
		*/
		async uploadSpec(request) {
			return {
				written: await writeUploadedSpec(this.ctx, request.name.trim(), request.content),
				specs: await listUploadedSpecs(this.ctx)
			};
		}
		/**
		* Delete one uploaded spec.
		*
		* The confirmation is the caller's: only the surface can tell the user which
		* projects reference the file, and this method deliberately does not check —
		* a project whose override points at a deleted file falls back to the global
		* choice, which `resolveSpec` already handles.
		* @param request - the file to remove.
		* @returns whether a file was removed, plus the remaining names.
		*/
		async deleteSpec(request) {
			return {
				removed: await deleteUploadedSpec(this.ctx, request.name.trim()),
				specs: await listUploadedSpecs(this.ctx)
			};
		}
		/**
		* List the projects that would stop using the named spec if it were deleted.
		*
		* Read before the confirmation, while the file still exists, so the dialog can
		* say "N projects use this". A project counts when its **effective** spec is
		* that file, which includes projects inheriting it from the global choice.
		* @param request - the spec file name.
		* @returns the titles of the affected projects, sorted.
		*/
		async specsUsedBy(request) {
			const domain = await this.ready();
			const global = domain.global.get();
			const titles = [];
			for (const id of this.order()) {
				const record = domain.table("projects").get(id);
				if (record === void 0) continue;
				const spec = resolveSpec(this.ctx, global, record);
				if (spec.mode === "custom" && spec.fileName === request.name) titles.push(record.title);
			}
			return { titles: titles.sort((a, b) => a.localeCompare(b)) };
		}
		/**
		* Read one uploaded spec's text, for the surface's preview.
		* @param request - the spec file name.
		* @returns the text, or `null` when the file is absent.
		*/
		async readSpec(request) {
			return { content: await readUploadedSpec(this.ctx, request.name.trim()) ?? null };
		}
		/**
		* Choose the Workspace every New Session this plugin opens lands in.
		*
		* ## `path`/`name` are a **memory**, not part of the mode
		*
		* Switching to `'default'` **keeps** the stored `path` and `name`. They record which
		* Workspace the user last picked, so switching 默认 → 指定 restores that choice instead
		* of forcing them to pick again. Clearing them — which this did at first — made the
		* setting look like it could not be remembered at all, which is exactly how it was
		* reported.
		*
		* Every reader gates on `mode`, so a retained path cannot be mistaken for an active
		* one: the card's "已不存在" note only fires in `'specified'`, and the resolver branches
		* on `mode` too.
		*
		* A `'specified'` write without a path is still refused: it would be a setting that can
		* never resolve, which is the very failure this feature reports.
		*
		* The write goes through {@link setGlobal}, which spreads the stored singleton —
		* writing it whole would drop `projectIds` and empty the sidebar.
		* @param request - the chosen mode and, for `'specified'`, the Workspace.
		* @returns the setting as stored, including the retained memory for `'default'`.
		*/
		async setBaseWorkspace(request) {
			const domain = await this.ready();
			if (request.mode === "specified" && (request.path ?? "") === "") throw new Error("a specified base workspace needs a path");
			const next = request.mode === "default" ? withDefaultMode(domain.global.get().baseWorkspace, request) : {
				mode: "specified",
				path: request.path,
				name: request.name ?? ""
			};
			await this.setGlobal(domain, { baseWorkspace: next });
			return next;
		}
		/**
		* Re-create the base Workspace: make its directory, then register it.
		*
		* Ordered, because registration requires the directory to exist — the registry resolves the path
		* with `realpathNormalize` and rejects a non-directory (measured: `workspace/invalid-path` when
		* the directory is absent, and also when only its parent exists).
		*
		* ## Why `mkdir -p`
		*
		* The realistic rebuild case is a path whose parents may be gone too. `recursive: true` is
		* idempotent for a directory that already exists, so it costs nothing in the common case and is
		* the difference between working and not in the other.
		*
		* ## Why the registry is read with `ctx.get` at call time
		*
		* The service is provided by `dsh-workspace`, which arrives about a second after this plugin's
		* `apply` runs (measured: absent at 0 ms and 250 ms, present at 1000 ms). Declaring it in `inject`
		* would hold this whole plugin inactive until then, and would make every project verb depend on a
		* service that has nothing to do with them. The ungated read also means a composition without it
		* degrades to a refused rebuild rather than a dead plugin.
		*
		* ## Why `'default'` mode is adopted rather than pointed at
		*
		* `initializeDefault` returns `entities.get(defaultWorkspaceId)` as soon as that field is set and
		* never falls through to creation, so after a deletion a re-registered path is an id the pointer
		* does not adopt and the dialog would reappear on the next click. Rewriting that pointer would
		* mean editing another plugin's durable state behind its invariants; instead this plugin records
		* the rebuilt path as **its own** `'specified'` setting, which its resolver does read. `mode` in
		* the result reports that, because it changes what the settings card shows.
		* @returns the Workspace now at the base path, and the setting's mode afterwards.
		*/
		async rebuildBaseWorkspace() {
			const domain = await this.ready();
			const stored = domain.global.get().baseWorkspace;
			const usesStoredPath = stored.mode === "specified";
			const path = usesStoredPath ? stored.path ?? "" : await defaultWorkspacePath() ?? "";
			if (path === "") throw new Error("there is no base workspace path to rebuild");
			const title = usesStoredPath ? stored.name : void 0;
			const registry = this.ctx.get("workspaceRegistry");
			if (registry === void 0) throw new Error("the Workspace registry is unavailable, so the directory cannot be re-registered");
			await mkdir(path, { recursive: true });
			const entity = await registry.create(path, title);
			const mode = stored.mode;
			if (mode === "default") await this.setGlobal(domain, { baseWorkspace: {
				mode: "specified",
				path: entity.path ?? path,
				name: entity.title
			} });
			return {
				path: entity.path ?? path,
				workspaceId: String(entity.id),
				title: entity.title ?? "",
				mode: mode === "default" ? "specified" : mode
			};
		}
		/**
		* Report where the official default Workspace would live.
		*
		* The missing-底层工作区 dialog names the path that is gone, and no Client-side
		* caller can produce it: the derivation starts at the OS Documents folder, which
		* only this half can query (`src/default-workspace.ts` explains why the official
		* helper is reimplemented rather than imported).
		*
		* A pure read — nothing is created or registered — and `path: null` when the
		* Documents folder is unreadable, so the dialog can say "unknown" instead of
		* showing a path it did not verify.
		* @returns the derived path, or `null`.
		*/
		async defaultWorkspacePath() {
			return { path: await defaultWorkspacePath() };
		}
		/**
		* Stream the projection: a baseline first, then a fresh baseline per landed
		* write.
		*
		* Every frame is a complete projection rather than a diff. That is what makes
		* reconnection trivial (a new generation opens with a baseline and the Client
		* replaces its state) and what keeps the two sides from having to agree on
		* increment semantics. The writes here are user gestures, not a hot path, so
		* re-projecting costs nothing that matters.
		* @param signal - caller lifetime; the follower leaves with it.
		* @returns the frame stream.
		*/
		async *follow(signal) {
			const frames = [];
			let wake;
			const push = () => {
				const pending = wake;
				wake = void 0;
				pending?.();
			};
			const refresh = async () => {
				frames.push({
					type: "baseline",
					value: await this.baseline()
				});
				push();
			};
			yield {
				type: "baseline",
				value: await this.baseline()
			};
			await this.ready();
			const onChanged = () => {
				refresh();
			};
			this.followers.add(onChanged);
			const leave = () => {
				this.followers.delete(onChanged);
			};
			signal.addEventListener("abort", leave, { once: true });
			try {
				while (!signal.aborted) {
					const next = frames.shift();
					if (next !== void 0) {
						yield next;
						continue;
					}
					await new Promise((resolve) => {
						wake = resolve;
					});
				}
			} finally {
				leave();
				signal.removeEventListener("abort", leave);
			}
		}
	};
})();
/**
* A fresh project id.
*
* `randomUUID` is present on every supported Node line; the fallback keeps an
* exotic runtime working rather than throwing during a create.
* @returns a unique id.
*/
function newProjectId() {
	const random = globalThis.crypto?.randomUUID?.();
	if (random !== void 0) return random;
	return `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
/**
* Mount the Host half.
* @param ctx - Host context.
*/
function apply(ctx) {
	new ProjectController(ctx);
}
//#endregion
export { ProjectController, apply, inject };
