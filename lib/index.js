import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { z } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
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
		schema: z.object({ projectIds: z.array(z.string()) }),
		initial: { projectIds: [] }
	},
	tables: {
		projects: domainTable(projectRecord),
		assignments: domainTable(assignmentRecord),
		expansions: domainTable(expansionRecord),
		orders: domainTable(orderRecord)
	}
});
//#endregion
//#region src/protocol.ts
/**
* Wire vocabulary shared by the Host half and this plugin's own Client
* contribution.
*
* Both halves key off the endpoint names below, so a rename here is a breaking
* change on both sides at once rather than a silent mismatch at runtime: the
* Client contribution's descriptors and the Host's `@Remote` exports are
* derived from the same constants.
*
* These are plain data shapes. Nothing crosses that is not JSON, which is what
* lets both codecs be pass-throughs (see `src/client/remote.ts`).
*/
/** The Cordis service key owning these methods, and the default wire namespace. */
const PROJECT_SERVICE_KEY = "projectController";
/** The Remote namespace the Client calls (`ctx.remote.projectGroups`). */
const PROJECT_NAMESPACE = "projectGroups";
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
				orders: Object.fromEntries([...domain.table("orders").entries()].map(([projectId, record]) => [projectId, [...record.sessionIds]]))
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
			await domain.global.set({ projectIds: [projectId, ...this.order()] });
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
			await domain.global.set({ projectIds: this.order().filter((id) => id !== request.projectId) });
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
			await domain.global.set({ projectIds });
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
