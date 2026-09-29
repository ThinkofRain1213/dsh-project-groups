import { mkdir } from "node:fs/promises";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { z } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { execFile } from "node:child_process";
import { posix, win32 } from "node:path";
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
*/
const projectRecord = z.object({
	title: z.string(),
	docPath: z.string(),
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
*/
const globalRecord = z.object({
	projectIds: z.array(z.string()),
	newSessionTarget: newSessionTarget.default("ungrouped"),
	baseWorkspace: baseWorkspaceSetting.default({ mode: "default" })
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
	baseWorkspace: { mode: "default" }
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
//#region node_modules/.pnpm/@deepseek-ai+dsh-api-worksp_2f5bbc1cb2f7448435f409c8ba205750/node_modules/@deepseek-ai/dsh-api-workspace-controller/lib/types/default-workspace.js
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
* @param stored - the setting as it stands, or `undefined` before any write.
* @returns the `'default'` setting, carrying the remembered Workspace through.
*/
function withDefaultMode(stored) {
	return {
		mode: "default",
		path: stored?.path,
		name: stored?.name
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
*/
const inject = ["storageDomain"];
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
	let _rename_decorators;
	let _remove_decorators;
	let _reorder_decorators;
	let _assign_decorators;
	let _unassign_decorators;
	let _setExpanded_decorators;
	let _setOrders_decorators;
	let _setNewSessionTarget_decorators;
	let _setBaseWorkspace_decorators;
	let _rebuildBaseWorkspace_decorators;
	let _defaultWorkspacePath_decorators;
	let _follow_decorators;
	return class ProjectController extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_baseline_decorators = [Remote("baseline")];
			_create_decorators = [Remote("create")];
			_rename_decorators = [Remote("rename")];
			_remove_decorators = [Remote("delete")];
			_reorder_decorators = [Remote("reorder")];
			_assign_decorators = [Remote("assign")];
			_unassign_decorators = [Remote("unassign")];
			_setExpanded_decorators = [Remote("setExpanded")];
			_setOrders_decorators = [Remote("setOrders")];
			_setNewSessionTarget_decorators = [Remote("setNewSessionTarget")];
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
			__esDecorate(this, null, _rename_decorators, {
				kind: "method",
				name: "rename",
				static: false,
				private: false,
				access: {
					has: (obj) => "rename" in obj,
					get: (obj) => obj.rename
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
		* @param ctx - Host context carrying the storage-domain facility.
		*/
		constructor(ctx) {
			super(ctx, PROJECT_SERVICE_KEY, { namespace: PROJECT_NAMESPACE });
			ctx.effect(() => () => this.close(), "project-groups: domain close");
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
		async setGlobal(domain, patch) {
			await domain.global.set({
				...domain.global.get(),
				...patch
			});
		}
		projectValue(projectId, record) {
			return {
				projectId,
				title: record.title,
				docPath: record.docPath,
				createdAt: record.createdAt,
				updatedAt: record.updatedAt
			};
		}
		/**
		* The complete Client projection: projects in display order, the order itself,
		* and every assignment.
		* @returns the baseline a following generation opens with.
		*/
		async baseline() {
			const domain = await this.ready();
			const projects = domain.table("projects");
			const assignments = domain.table("assignments");
			const ordered = this.order().filter((id) => projects.get(id) !== void 0);
			const seen = new Set(ordered);
			for (const id of projects.keys()) if (!seen.has(id)) ordered.push(id);
			return {
				projects: ordered.map((id) => this.projectValue(id, projects.get(id))),
				projectIds: ordered,
				assignments: Object.fromEntries([...assignments.entries()].map(([sessionId, record]) => [sessionId, record.projectId])),
				expansions: Object.fromEntries([...domain.table("expansions").entries()].map(([projectId, record]) => [projectId, record.expanded])),
				orders: Object.fromEntries([...domain.table("orders").entries()].map(([projectId, record]) => [projectId, [...record.sessionIds]])),
				newSessionTarget: domain.global.get().newSessionTarget,
				baseWorkspace: domain.global.get().baseWorkspace
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
		* @param request - display title; surrounding whitespace is trimmed.
		* @returns the created project.
		*/
		async create(request) {
			const title = request.title.trim();
			if (title === "") throw new Error("a project title is required");
			const domain = await this.ready();
			const projectId = newProjectId();
			const now = (/* @__PURE__ */ new Date()).toISOString();
			const record = {
				title,
				docPath: "",
				createdAt: now,
				updatedAt: now
			};
			await domain.table("projects").put(projectId, record);
			await this.setGlobal(domain, { projectIds: [projectId, ...this.order()] });
			return { project: this.projectValue(projectId, record) };
		}
		/**
		* Retitle one project.
		* @param request - target project and its new title.
		* @returns the updated project.
		*/
		async rename(request) {
			const title = request.title.trim();
			if (title === "") throw new Error("a project title is required");
			const domain = await this.ready();
			const record = domain.table("projects").get(request.projectId);
			if (record === void 0) throw new Error(`unknown project: ${request.projectId}`);
			const next = {
				...record,
				title,
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
		* @param request - target project.
		*/
		async remove(request) {
			const domain = await this.ready();
			for (const [sessionId, record] of [...domain.table("assignments").entries()]) if (record.projectId === request.projectId) await domain.table("assignments").delete(sessionId);
			await domain.table("projects").delete(request.projectId);
			await domain.table("expansions").delete(request.projectId);
			await domain.table("orders").delete(request.projectId);
			await this.setGlobal(domain, { projectIds: this.order().filter((id) => id !== request.projectId) });
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
			const next = request.mode === "default" ? withDefaultMode(domain.global.get().baseWorkspace) : {
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
