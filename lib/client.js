window.__ModuleLoader__.load({
	id: "dsh-project-groups",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		let _deepseek_ai_cordis = require("@deepseek-ai/cordis");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/vendored/client/contract/slots.ts
		/**
		* Bind the row's render occurrence into the entries' `useMenuOpenState` hook:
		* the owner supplies its open-state pair as the occurrence's `hookContext`,
		* and the hook hands that pair back.
		* @param _standard - framework standard props (unused).
		* @param state - the menu's open-state pair from the render occurrence.
		* @returns the hook the entry calls.
		*/
		const menuOpenStateFactory = (_standard, state) => () => state;
		//#endregion
		//#region src/vendored/client/shortcuts.ts
		/**
		* Create the private browser request source shared by commands and controls.
		* @returns observable state and its complete mutation callbacks.
		*/
		function createWorkspaceShortcutControls() {
			const state = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({
				searchRequest: 0,
				addRequested: false,
				directoryBusy: false,
				renameTarget: null,
				forkError: null
			});
			let forkErrorSeq = 0;
			return {
				state,
				search: () => {
					state.set({
						...state.getSnapshot(),
						searchRequest: state.getSnapshot().searchRequest + 1
					});
				},
				add: () => {
					state.set(state.getSnapshot().directoryBusy ? state.getSnapshot() : {
						...state.getSnapshot(),
						addRequested: true
					});
				},
				closeAdd: () => {
					state.set({
						...state.getSnapshot(),
						addRequested: false
					});
				},
				directoryBusy: (busy) => {
					state.set({
						...state.getSnapshot(),
						directoryBusy: busy
					});
				},
				rename: (sessionId, currentTitle) => {
					state.set({
						...state.getSnapshot(),
						renameTarget: {
							sessionId,
							currentTitle
						}
					});
				},
				closeRename: () => {
					state.set({
						...state.getSnapshot(),
						renameTarget: null
					});
				},
				forkFailed: (reason) => {
					forkErrorSeq += 1;
					state.set({
						...state.getSnapshot(),
						forkError: {
							reason,
							seq: forkErrorSeq
						}
					});
				},
				dismissForkError: () => {
					state.set({
						...state.getSnapshot(),
						forkError: null
					});
				}
			};
		}
		/**
		* Register navigation commands against the existing workspace owner.
		* @param ctx - plugin context with the shortcut, locale, and model services.
		* @param navigation - session creation and forking from the pointer controls' navigation service.
		* @param controls - browser-owned opening requests.
		* @param archiveSession - shared archive action, including running-work confirmation and notices.
		* @param projectModel - whether the composition supplies a project model, which
		* changes what "add" means (and therefore the command's label).
		*/
		function installWorkspaceShortcuts(ctx, navigation, controls, archiveSession, projectModel) {
			const t = ctx.locale.bind("workspace");
			const current = () => Object.values(ctx.sessions.list.getSnapshot().byId).find((row) => (row.retainedBy.mainView ?? 0) > 0);
			const addReason = () => ctx.slots.entries("sidebar.workspaces.directoryFlow").length === 0 ? t("shortcut.noPicker") : controls.state.getSnapshot().directoryBusy ? t("shortcut.directoryBusy") : null;
			const register = (id, label, aliases, code, modifiers, webModifiers, resolve) => {
				ctx.effect(() => ctx.shortcuts.register({
					id,
					label,
					aliases,
					defaults: {
						"desktop:macos": {
							code,
							modifiers
						},
						"desktop:windows": {
							code,
							modifiers
						},
						"desktop:linux": {
							code,
							modifiers
						},
						"web:macos": {
							code,
							modifiers: webModifiers
						},
						"web:windows": {
							code,
							modifiers: webModifiers
						}
					},
					regions: ["page", "editable"],
					modals: [],
					resolve
				}), `ui-workspace: ${id}`);
			};
			register("session.new", () => t("session.new"), ["new session", "new chat"], "KeyN", ["primary"], ["primary", "alt"], () => ({
				status: "handled",
				run: () => {
					navigation.startSession();
				}
			}));
			register("session.search", () => t("search.sessions.aria"), ["search sessions"], "KeyK", ["primary"], ["primary", "alt"], () => ({
				status: "handled",
				run: controls.search
			}));
			register("workspace.add", () => t(projectModel ? "project.add" : "workspace.add"), projectModel ? ["new project"] : ["add workspace", "open folder"], "KeyO", ["primary"], ["primary", "alt"], () => {
				if (projectModel) return {
					status: "handled",
					run: controls.add
				};
				const reason = addReason();
				return reason === null ? {
					status: "handled",
					run: controls.add
				} : {
					status: "blocked",
					reason
				};
			});
			register("session.rename", () => t("rename.session.title"), ["rename session"], "KeyR", ["primary", "alt"], ["primary", "shift"], () => {
				const target = current();
				return target === void 0 ? {
					status: "blocked",
					reason: t("shortcut.noSession")
				} : {
					status: "handled",
					run: () => {
						controls.rename(target.id, target.displayTitle);
					}
				};
			});
			register("session.fork", () => t("menu.fork"), ["fork session"], "KeyF", ["primary", "alt"], ["primary", "shift"], () => {
				const target = current();
				if (target === void 0) return {
					status: "blocked",
					reason: t("shortcut.noSession")
				};
				if (target.blank) return {
					status: "blocked",
					reason: t("shortcut.noCompletedTurn")
				};
				return {
					status: "handled",
					run: () => {
						navigation.forkSession(target.id).catch((error) => {
							const unavailable = error instanceof Error && error.name === "SessionForkError" && error.rpcError.code === "session/fork-unavailable";
							controls.forkFailed(unavailable ? "unavailable" : "failed");
							if (!unavailable) console.warn("session fork rejected:", error);
						});
					}
				};
			});
			register("session.archive", () => t("menu.archiveSession"), ["archive session"], "KeyA", ["primary", "shift"], ["primary", "alt"], () => {
				const target = current();
				return target === void 0 ? {
					status: "blocked",
					reason: t("shortcut.noSession")
				} : {
					status: "handled",
					run: () => {
						archiveSession(target.id);
					}
				};
			});
		}
		//#endregion
		//#region node_modules/.pnpm/@deepseek-ai+dsh-util-value_beb1efbe3db988c8919fd21a05783bf3/node_modules/@deepseek-ai/dsh-util-values/lib/index.js
		/** Duplicate-install-safe JSON and immutable-value helpers. @module @deepseek-ai/dsh-util-values */
		/**
		* Mark an unreachable closed-union branch.
		* @param value - impossible value; an unhandled typed variant fails at the call site.
		* @param context - optional switch-site label included in the failure message.
		* @returns never; a runtime value that escaped its type always throws.
		*/
		function assertNever$1(value, context) {
			const rendered = JSON.stringify(value) ?? String(value);
			throw new Error(`unreachable variant${context ? ` in ${context}` : ""}: ${rendered}`);
		}
		//#endregion
		//#region node_modules/.pnpm/@deepseek-ai+dsh-util-works_6197df0f8f816091cfe9d2d9cb9dad6c/node_modules/@deepseek-ai/dsh-util-workspace-path/lib/index.js
		/**
		* Browser-safe Workspace path and display helpers.
		* @module @deepseek-ai/dsh-util-workspace-path
		*/
		/** Whether a path uses a Windows drive or UNC prefix. */
		function isWindowsStylePath(value) {
			return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith("\\\\");
		}
		/**
		* Abbreviate a POSIX home directory for display.
		* @param path - Absolute or already-short display path.
		* @param home - Host account home; absent skips abbreviation.
		* @returns `~` or `~/…` for the POSIX home and its descendants, otherwise `path`.
		*/
		function abbreviateHomePath(path, home) {
			if (home === void 0 || home === "") return path;
			if (isWindowsStylePath(path) || isWindowsStylePath(home)) return path;
			const root = home.replace(/\/+$/, "");
			if (root === "" || root === "/") return path;
			if (path.replace(/\/+$/, "") === root) return "~";
			if (path.startsWith(`${root}/`)) return `~${path.slice(root.length)}`;
			return path;
		}
		/**
		* Read the final non-empty segment of a Workspace path for display.
		* Workspace-label surfaces use this helper instead of deriving another basename.
		* @param path - Workspace directory path using POSIX or Windows separators.
		* @returns the final segment, or an empty string for a separator-only path.
		*/
		function workspaceTitleOf(path) {
			const trimmed = path.replace(/[/\\]+$/, "");
			const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
			return trimmed.slice(separator + 1);
		}
		/**
		* Resolve the Workspace browser group that owns one Session.
		* @param workspaces - authoritative Workspace membership.
		* @param sessionId - Session whose browser group is required.
		* @returns owning Workspace id, or {@link UNGROUPED_KEY} when no Workspace accounts for it.
		*/
		function owningGroupKey(workspaces, sessionId) {
			return workspaces.find((workspace) => workspace.sessionIds.includes(sessionId))?.workspaceId ?? "";
		}
		/**
		* Resolve the caller-supplied group that owns one Session, the {@link GroupSource}
		* counterpart of {@link owningGroupKey}.
		* @param sources - caller-supplied grouping model.
		* @param sessionId - Session whose group is required.
		* @returns owning group key, or {@link UNGROUPED_KEY} when no group claims it.
		*/
		function owningSourceKey(sources, sessionId) {
			return sources.find((source) => source.sessionIds.includes(sessionId))?.key ?? "";
		}
		function mainSessionId(list) {
			return Object.values(list.byId).find((session) => (session.retainedBy.mainView ?? 0) > 0)?.id;
		}
		/**
		* Directory display label: basename of the path (both separators accepted).
		* Ungrouped-bucket fallback for surfaces without a workspace title.
		* @param cwd - directory path, or undefined for the ungrouped bucket.
		* @returns basename, the raw cwd when it has no basename, or an empty ungrouped marker.
		*/
		function workspaceLabel(cwd) {
			if (cwd === void 0 || cwd === "") return "";
			const base = workspaceTitleOf(cwd);
			return base !== "" ? base : cwd;
		}
		/**
		* Project known account members by current Session recency.
		* @param sessionIds - authoritative account membership.
		* @param summaries - current Session summaries; members without a summary are omitted until it arrives.
		* @returns known members newest first, with Session identity as the deterministic tie-break.
		*/
		function orderByRecency(sessionIds, summaries) {
			return sessionIds.flatMap((id) => {
				const summary = summaries[id];
				if (summary === void 0) return [];
				return [{
					id,
					rank: summary.updatedAt
				}];
			}).sort((a, b) => {
				if (a.rank !== b.rank) return b.rank - a.rank;
				return a.id < b.id ? -1 : 1;
			}).map((member) => member.id);
		}
		/**
		* Reconcile a browser-local manual order with current account membership.
		* New ordinary forks precede their sources without changing saved entries' relative order.
		* @param memberIds - authoritative account membership.
		* @param savedOrder - previously saved browser-local order.
		* @param summaries - current Session metadata; unknown new members wait for their summaries.
		* @param rowState - global pin and archive membership; only account members can supplement the order.
		* @returns saved relative positions plus missing members ordered by pin, fork source, recency, and archive status.
		*/
		function reconcileManualOrder(memberIds, savedOrder, summaries, rowState) {
			const members = new Map(memberIds.map((id) => [id, id]));
			const included = /* @__PURE__ */ new Set();
			const ordered = [];
			for (const key of savedOrder ?? []) {
				const id = members.get(key);
				if (id === void 0 || included.has(key)) continue;
				ordered.push(id);
				included.add(key);
			}
			const archived = new Set(rowState?.archivedSessionIds);
			const pins = [];
			for (const sessionId of rowState?.pinnedSessionIds ?? []) {
				const id = members.get(sessionId);
				if (id === void 0 || included.has(id) || archived.has(id) || summaries[id] === void 0) continue;
				pins.push(id);
				included.add(id);
			}
			const ordinary = [];
			const archives = [];
			for (const id of orderByRecency([...members.values()].filter((id) => !included.has(id)), summaries)) if (archived.has(id)) archives.push(id);
			else ordinary.push(id);
			const result = [
				...pins,
				...ordered,
				...ordinary,
				...archives
			];
			const pending = new Set(ordinary);
			const placeFork = (id) => {
				if (!pending.delete(id)) return;
				const parentId = summaries[id]?.parentId;
				if (parentId === void 0 || parentId === id || !result.includes(parentId)) return;
				placeFork(parentId);
				result.splice(result.indexOf(id), 1);
				result.splice(result.indexOf(parentId), 0, id);
			};
			for (const id of [...ordinary].reverse()) placeFork(id);
			return result;
		}
		/**
		* Keep the selected provisional New Session ahead of either base order.
		* @param order - recency or reconciled manual order.
		* @param currentBlank - selected blank Session in this account, when present.
		* @returns a copy with the selected blank first and no duplicate slot.
		*/
		function pinCurrentBlank(order, currentBlank) {
			if (currentBlank === void 0) return [...order];
			return [currentBlank, ...order.filter((id) => id !== currentBlank)];
		}
		/**
		* Ordinary sessions are visible; among blank sessions, only the current one
		* is visible. Subagent children use their parent header catalog; archived
		* sessions follow the archived filter, while their accounting slots remain
		* either way so unarchiving restores position.
		*/
		function sessionVisible(session, current, archived, archivedFilter) {
			if (session.origin === "subagent") return false;
			if (session.blank && session.id !== current) return false;
			switch (archivedFilter) {
				case "default": return !archived.has(session.id);
				case "show": return true;
				case "only": return archived.has(session.id);
				/* v8 ignore next 2 -- closed-union backstop; only reached if the filter is forged */
				default: return assertNever$1(archivedFilter);
			}
		}
		/**
		* Keep the visible New Session placeholder first, then partition pinned and
		* ordinary rows without changing either partition's caller order.
		*/
		function sectionMembers(members, pinned, archived) {
			const placeholders = [];
			const leading = [];
			const rest = [];
			for (const member of members) if (member.blank) placeholders.push(member);
			else if (!archived.has(member.id) && pinned.has(member.id)) leading.push(member);
			else rest.push(member);
			return [
				...placeholders,
				...leading,
				...rest
			];
		}
		/**
		* A blank session is the selected Workspace's provisional New Session row;
		* its canonical title never enters search (blank rows are query-excluded)
		* and the renderer localizes its display label.
		*/
		function sessionTitle(session) {
			return session.blank ? "" : session.displayTitle;
		}
		/** Build one group without projecting session lineage into presentation. */
		function buildGroup(key, workspaceId, cwd, createdAt, label, members, kind = void 0) {
			return {
				key,
				workspaceId,
				cwd,
				createdAt,
				label,
				kind,
				sessions: [...members]
			};
		}
		/** Apply a stored Ungrouped order and append newly loose Sessions by recency. */
		function orderedUngrouped(members, stored, summaries) {
			const byId = new Map(members.map((session) => [session.id, session]));
			return (stored === void 0 ? orderByRecency(members.map((session) => session.id), summaries) : reconcileManualOrder(members.map((session) => session.id), stored, summaries)).flatMap((id) => {
				const session = byId.get(id);
				/* v8 ignore next -- ids are projected exclusively from the members used to build byId. */
				return session === void 0 ? [] : [session];
			});
		}
		/**
		* Group Sessions by Workspace: one group per caller-ordered entity, with
		* members resolved from caller-ordered sessionIds. Sessions outside every
		* Workspace trail in the browser-local Ungrouped order, which falls back to
		* recency before that order is initialized.
		*/
		function groupByWorkspace(list, workspaces, archived, archivedFilter, ungroupedOrder) {
			const current = mainSessionId(list);
			const groups = [];
			const accounted = /* @__PURE__ */ new Set();
			for (const workspace of workspaces) {
				const members = [];
				for (const id of workspace.sessionIds) {
					const summary = list.byId[id];
					if (summary === void 0) continue;
					accounted.add(id);
					if (!sessionVisible(summary, current, archived, archivedFilter)) continue;
					members.push(summary);
				}
				if (archivedFilter === "only" && members.length === 0) continue;
				groups.push(buildGroup(workspace.workspaceId, workspace.workspaceId, workspace.path, Date.parse(workspace.createdAt), workspace.title, members));
			}
			const stray = list.ids.map((id) => list.byId[id]).filter((s) => s !== void 0 && !accounted.has(s.id) && sessionVisible(s, current, archived, archivedFilter));
			if (stray.length > 0) groups.push(buildGroup("", void 0, void 0, void 0, "", orderedUngrouped(stray, ungroupedOrder, list.byId)));
			return groups;
		}
		/**
		* Group Sessions by a caller-supplied source instead of the Host Workspace
		* registry, using the exact rules {@link groupByWorkspace} applies: the same
		* visibility test, the same Ungrouped fallback for unclaimed Sessions, and the
		* same group shape. An empty source therefore puts every visible Session under
		* Ungrouped, and a populated one renders the caller's groups with the
		* expansion, ordering, archive filtering, and row presentation a Workspace
		* gets — the downstream derivation cannot tell the two apart.
		* @param list - current Session list state.
		* @param sources - caller-ordered groups; membership is by Session id.
		* @param archived - registry-global archive set.
		* @param archivedFilter - archived-row visibility choice.
		* @param ungroupedOrder - stored order for Sessions in no group.
		* @returns groups in source order, with the Ungrouped bucket last when non-empty.
		*/
		function groupBySource(list, sources, archived, archivedFilter, ungroupedOrder) {
			const current = mainSessionId(list);
			const groups = [];
			const accounted = /* @__PURE__ */ new Set();
			for (const source of sources) {
				const members = [];
				for (const id of source.sessionIds) {
					const summary = list.byId[id];
					if (summary === void 0) continue;
					accounted.add(id);
					if (!sessionVisible(summary, current, archived, archivedFilter)) continue;
					members.push(summary);
				}
				if (archivedFilter === "only" && members.length === 0) continue;
				groups.push(buildGroup(source.key, void 0, source.path, source.createdAt, source.label, members, source.kind));
			}
			const stray = list.ids.map((id) => list.byId[id]).filter((s) => s !== void 0 && !accounted.has(s.id) && sessionVisible(s, current, archived, archivedFilter));
			if (stray.length > 0 || archivedFilter !== "only") groups.push(buildGroup("", void 0, void 0, void 0, "", orderedUngrouped(stray, ungroupedOrder, list.byId)));
			return groups;
		}
		/** Keep navigation presentation independent from domain-owned interaction objects. */
		function visiblePendingKind(kind) {
			switch (kind) {
				case "approval":
				case "plan-review":
				case "question": return kind;
				default: return;
			}
		}
		function runningChildCount(list, parentId, statuses) {
			return list.projectionsBySession[parentId]?.values.subagentCatalog?.reduce((count, child) => count + ((statuses.get(child.id)?.running ?? list.byId[child.id]?.running) === true ? 1 : 0), 0) ?? 0;
		}
		function sessionNode(s, list, statuses, pinned, archived) {
			const status = statuses.get(s.id);
			const pendingInteraction = visiblePendingKind(status?.pendingInteraction?.kind);
			return {
				id: s.id,
				title: sessionTitle(s),
				blank: s.blank,
				running: status?.running ?? s.running,
				runningSubagentCount: runningChildCount(list, s.id, statuses),
				completed: status?.completionUnread === true,
				pinned: !archived.has(s.id) && pinned.has(s.id),
				archived: archived.has(s.id),
				updatedAt: s.updatedAt,
				...pendingInteraction === void 0 ? {} : { pendingInteraction }
			};
		}
		/**
		* Derive the workspace browser groups with every session as a top-level row.
		*
		* Every group shows, except that the archived-only filter drops groups
		* without visible members; sessions populate under expanded groups with
		* pinned rows leading in the selected local order. Blank sessions are
		* excluded except for the selected provisional New Session row; archived
		* sessions keep their slots and appear per the archived filter. Content
		* search lives outside this derivation (see {@link deriveSearchResults}).
		* @param list - sessions list snapshot (`mainView` retention feeds containsCurrent).
		* @param workspaces - real Workspaces in Host group order with caller-projected Session order.
		* @param rowState - registry-global pin and archive sets plus the archived filter.
		* @param statuses - unified UI status by Session.
		* @param view - local expansion arrays.
		* @returns group sections in render order.
		*/
		function deriveGroups(list, workspaces, rowState, statuses, view, sources) {
			const archived = new Set(rowState.archivedSessionIds);
			const pinned = new Set(rowState.pinnedSessionIds);
			const expandedGroups = new Set(view.expandedGroups);
			const current = mainSessionId(list);
			const derived = sources === void 0 ? groupByWorkspace(list, workspaces, archived, rowState.archivedFilter, view.ungroupedOrder) : groupBySource(list, sources, archived, rowState.archivedFilter, view.ungroupedOrder);
			const currentGroup = current === void 0 ? void 0 : sources === void 0 ? owningGroupKey(workspaces, current) : owningSourceKey(sources, current);
			const groups = [];
			for (const g of derived) {
				const expanded = expandedGroups.has(g.key);
				groups.push({
					key: g.key,
					workspaceId: g.workspaceId,
					cwd: g.cwd,
					createdAt: g.createdAt,
					label: g.label,
					kind: g.kind,
					sessionCount: g.sessions.length,
					expanded,
					containsCurrent: g.key === currentGroup,
					sessions: expanded ? sectionMembers(g.sessions, pinned, archived).map((session) => sessionNode(session, list, statuses, pinned, archived)) : []
				});
			}
			return groups;
		}
		/**
		* Select complete flat-list membership, independently of archive visibility.
		* @param list - sessions list snapshot.
		* @returns known ordinary Session ids, including archives and only the current blank.
		*/
		function sessionMemberIds(list) {
			return visibleSessionIds(list, [], "show");
		}
		/**
		* Select visible flat-list members without deriving row presentation or ordering.
		* @param list - sessions list snapshot.
		* @param archivedSessionIds - registry-global archive set.
		* @param archivedFilter - archived-row visibility choice.
		* @returns known visible Session ids in list order, including ordinary forks and only the current blank.
		*/
		function visibleSessionIds(list, archivedSessionIds, archivedFilter) {
			const archived = new Set(archivedSessionIds);
			const current = mainSessionId(list);
			return list.ids.filter((id) => {
				const s = list.byId[id];
				return s !== void 0 && sessionVisible(s, current, archived, archivedFilter);
			});
		}
		/**
		* Derive flat rows from the browser's complete ordered Session ids, with
		* pinned rows fronted ahead of the supplied order.
		* @param list - sessions list snapshot used to select the ids.
		* @param sessionIds - complete account members in the selected order, including hidden archives.
		* @param rowState - registry-global pin and archive sets plus the archived filter.
		* @param statuses - unified UI status by Session.
		* @returns flat rows in sectioned order with current status indicators.
		*/
		function deriveFlat(list, sessionIds, rowState, statuses) {
			const archived = new Set(rowState.archivedSessionIds);
			const pinned = new Set(rowState.pinnedSessionIds);
			const current = mainSessionId(list);
			return sectionMembers(sessionIds.flatMap((id) => {
				const session = list.byId[id];
				return session !== void 0 && sessionVisible(session, current, archived, rowState.archivedFilter) ? [session] : [];
			}), pinned, archived).map((session) => sessionNode(session, list, statuses, pinned, archived));
		}
		/**
		* Merge immediate title/Workspace substring matches with ranked Host content
		* matches. Local rows lead newest-first, content-only rows retain backend
		* order, and duplicate sessions receive the backend snippet in place.
		* @param list - session metadata authority.
		* @param workspaces - Workspace membership and display labels.
		* @param query - caller text; surrounding whitespace is ignored.
		* @param archivedSessionIds - registry-global archive set (members match per the archived filter).
		* @param archivedFilter - archived-row visibility choice; search follows it.
		* @param statuses - unified UI status by Session.
		* @param content - ranked Host content-search page.
		* @param limit - protocol-owned maximum merged row count.
		* @returns bounded deduplicated flat rows and a refine-query hint bit.
		*/
		function deriveSearchResults(list, workspaces, query, archivedSessionIds, archivedFilter, statuses, content, limit) {
			const q = query.trim().toLowerCase();
			if (q === "") return {
				items: [],
				hasMore: false
			};
			const archived = new Set(archivedSessionIds);
			const current = mainSessionId(list);
			const workspaceBySession = /* @__PURE__ */ new Map();
			for (const workspace of workspaces) for (const sessionId of workspace.sessionIds) if (!workspaceBySession.has(sessionId)) workspaceBySession.set(sessionId, workspace.title);
			const labelOf = (summary) => workspaceBySession.get(summary.id) ?? workspaceLabel(summary.cwd);
			const contentBySession = /* @__PURE__ */ new Map();
			for (const item of content.items) if (!contentBySession.has(item.sessionId)) contentBySession.set(item.sessionId, item);
			const local = [];
			for (const id of list.ids) {
				const summary = list.byId[id];
				if (summary === void 0 || summary.blank || !sessionVisible(summary, current, archived, archivedFilter)) continue;
				if (sessionTitle(summary).toLowerCase().includes(q) || labelOf(summary).toLowerCase().includes(q)) local.push(summary);
			}
			const localById = new Map(local.map((summary) => [summary.id, summary]));
			const orderedLocal = orderByRecency(local.map((summary) => summary.id), list.byId).map((id) => localById.get(id));
			const ordered = [];
			const included = /* @__PURE__ */ new Set();
			const include = (summary) => {
				if (included.has(summary.id)) return;
				included.add(summary.id);
				ordered.push(summary);
			};
			for (const summary of orderedLocal) include(summary);
			for (const item of content.items) {
				const summary = list.byId[item.sessionId];
				if (summary !== void 0 && !summary.blank && sessionVisible(summary, current, archived, archivedFilter)) include(summary);
			}
			return {
				items: ordered.slice(0, limit).map((summary) => {
					const match = contentBySession.get(summary.id);
					const status = statuses.get(summary.id);
					const pendingInteraction = visiblePendingKind(status?.pendingInteraction?.kind);
					return {
						id: summary.id,
						title: sessionTitle(summary),
						workspace: labelOf(summary),
						running: status?.running ?? summary.running,
						runningSubagentCount: runningChildCount(list, summary.id, statuses),
						...pendingInteraction === void 0 ? {} : { pendingInteraction },
						completed: status?.completionUnread === true,
						archived: archived.has(summary.id),
						...match === void 0 ? {} : { snippet: match.snippet }
					};
				}),
				hasMore: content.hasMore || ordered.length > limit
			};
		}
		/** Normalize separators for comparison without interpreting POSIX backslashes as separators. */
		function folderPath(path) {
			return (/^[A-Za-z]:[/\\]/.test(path) || path.startsWith("\\\\") ? path.replaceAll("\\", "/") : path).replace(/\/+$/, "");
		}
		/**
		* Find the nearest registered ancestor, excluding the Workspace directory itself.
		* Paths use Host spelling; matching is case-sensitive, like Workspace identity.
		* @param path - Workspace directory.
		* @param parents - registered Workspace directory paths.
		* @returns the owning parent path, or undefined when no parent contains the Workspace.
		*/
		function owningParentFolder(path, parents) {
			const child = folderPath(path);
			let owner;
			let length = -1;
			for (const parent of parents) {
				const root = folderPath(parent);
				if (root.length > length && child !== root && child.startsWith(`${root}/`)) {
					owner = parent;
					length = root.length;
				}
			}
			return owner;
		}
		//#endregion
		//#region src/vendored/client/stores.ts
		/**
		* The workspace browser's viewing store: the session-list grouping mode,
		* persisted across reloads. Module level exports the factory only (a
		* module-level handle would pin the store identity across plugin reloads);
		* register() receives the factory and the browser derives its PropsStore
		* share from the return type.
		*/
		/** Browser-local order account for the hierarchy-free flat Session list. */
		const FLAT_SESSION_ORDER_KEY = "__flat_session_order__";
		/** Copy read-only projections into the persisted mutable store representation. */
		function copySessionOrders(orders) {
			return Object.fromEntries(Object.entries(orders).map(([key, order]) => [key, [...order]]));
		}
		/**
		* Create the workspace browser viewing store handle.
		* @returns the store handle (spec + type + identity + factory in one).
		*/
		function createWorkspaceViewStore() {
			return (0, _deepseek_ai_dsh_client_store.defineStore)({
				init: () => ({
					groupBy: "workspace",
					orderBy: "updated",
					groupExpansion: {},
					sessionOrderByAccount: {},
					archivedFilter: "default"
				}),
				persist: "dsh.workspace.view.v5",
				actions: {
					setGroupBy: (d, mode) => {
						d.groupBy = mode;
					},
					setOrderBy: (d, mode, initialOrders) => {
						if (mode === d.orderBy) return;
						d.sessionOrderByAccount = mode === "manual" ? copySessionOrders(initialOrders) : {};
						d.orderBy = mode;
					},
					setGroupExpanded: (d, key, expanded) => {
						d.groupExpansion[key] = expanded;
					},
					retainAccountKeys: (d, workspaceKeys) => {
						const retained = new Set(workspaceKeys);
						d.groupExpansion = Object.fromEntries(Object.entries(d.groupExpansion).filter(([key]) => retained.has(key)));
						d.sessionOrderByAccount = Object.fromEntries(Object.entries(d.sessionOrderByAccount).filter(([key]) => retained.has(key)));
						delete d.sessionUpdatedAtByAccount;
					},
					syncSessionOrders: (d, orders) => {
						if (d.orderBy !== "manual") return;
						Object.assign(d.sessionOrderByAccount, copySessionOrders(orders));
					},
					setSessionOrder: (d, accountKey, order, initialOrders) => {
						if (d.orderBy === "updated") d.sessionOrderByAccount = copySessionOrders(initialOrders);
						else Object.assign(d.sessionOrderByAccount, copySessionOrders(initialOrders));
						d.orderBy = "manual";
						d.sessionOrderByAccount[accountKey] = [...order];
					},
					pinSessionOrder: (d, sessionId, accountKeys, source) => {
						const selected = new Set(accountKeys);
						d.sessionOrderByAccount = Object.fromEntries(Object.entries(source.members).map(([key, members]) => {
							const order = reconcileManualOrder(members, d.sessionOrderByAccount[key], source.summaries, source.rowState);
							return [key, selected.has(key) ? [sessionId, ...order.filter((id) => id !== sessionId)] : order];
						}));
					},
					setArchivedFilter: (d, filter) => {
						d.archivedFilter = filter;
					}
				}
			});
		}
		//#endregion
		//#region src/vendored/client/pin-order.ts
		/**
		* Every account's complete membership: each Workspace, Ungrouped, and the flat list.
		* @param workspaces - current Host Workspaces.
		* @param list - current Session list snapshot.
		* @param rowState - registry-global pin and archive sets.
		* @returns the order source for one pin write.
		*/
		function pinOrderSource(workspaces, list, rowState) {
			const accounted = new Set(workspaces.flatMap((workspace) => workspace.sessionIds));
			return {
				members: Object.fromEntries([
					...workspaces.map((workspace) => [workspace.workspaceId, workspace.sessionIds]),
					["", list.ids.filter((id) => list.byId[id] !== void 0 && !accounted.has(id))],
					[FLAT_SESSION_ORDER_KEY, sessionMemberIds(list)]
				]),
				summaries: list.byId,
				rowState
			};
		}
		/**
		* The accounts a pinned Session leads: its group (or Ungrouped) and the flat list.
		* @param workspaces - current Host Workspaces.
		* @param sessionId - the Session being pinned.
		* @returns the account keys `pinSessionOrder` fronts.
		*/
		function pinOrderAccounts(workspaces, sessionId) {
			return [owningGroupKey(workspaces, sessionId), FLAT_SESSION_ORDER_KEY];
		}
		//#endregion
		//#region src/vendored/client/navigation.ts
		/** Workspace archive and directory UI capability. */
		/** Structured directory failure exposed to directory UI consumers. */
		var DirectoryBrowseError = class extends Error {
			rpcError;
			name = "DirectoryBrowseError";
			/** @param rpcError - Host directory business failure. */
			constructor(rpcError) {
				super(`directory browse failed: ${rpcError.code}: ${rpcError.message}`);
				this.rpcError = rpcError;
			}
		};
		/** Implements Workspace archive and directory UI operations. */
		var UiWorkspaceService = class extends _deepseek_ai_cordis.Service {
			directoryPicker;
			workspaces;
			sessions;
			view;
			notify;
			placeUnscoped;
			onBaseWorkspaceMissing;
			resolveBaseWorkspace;
			connecting = /* @__PURE__ */ new Map();
			lifetime = new AbortController();
			selection = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({}, { persist: { name: "dsh.sessions.current" } });
			mainReference;
			/**
			* @param ctx - Client root Context.
			* @param directoryPicker - the directory-picking Remote namespace.
			* @param workspaces - pure Workspace Controller.
			* @param sessions - pure Session Controller.
			* @param view - the browser's viewing-store write set (one instance shared with its registration).
			* @param notify - show one notice through the Workspace notice channel.
			* @param placeUnscoped - optional destination for an unscoped New Session. The
			* caller decides where it goes; this service only supplies the Session that
			* landed and the one the user was looking at. Absent, the Session is left where
			* the default Workspace resolution put it, which is the shipped behaviour.
			* @param onBaseWorkspaceMissing - optional report for a New Session that could not
			* land because its 底层工作区 is gone. Absent, the flow is exactly the shipped one:
			* the click does nothing. The caller supplies the path, since deriving it needs a
			* Host query this service does not hold.
			* @param resolveBaseWorkspace - optional: where this plugin's 底层工作区 setting
			* points, for the entries that state no destination — the shell's New Session
			* button and its shortcut, ui-schedule, ui-agent-preset, and a caller-supplied
			* group's own ＋ (those groups carry no `workspaceId`; see `tree.ts`). The service
			* cannot answer this itself: the setting lives in the plugin's own domain, and
			* turning its stored **path** into a Workspace id needs a registry snapshot the
			* caller already holds.
			*
			* Synchronous by design. Both inputs are in-process observables
			* (`clientBaseWorkspace`, `workspaces.list`), so a promise here would put a
			* suspension point inside a click for no benefit. Absent — an unmodified
			* composition — the flow is exactly the shipped one.
			*/
			constructor(ctx, directoryPicker, workspaces, sessions, view, notify, placeUnscoped, onBaseWorkspaceMissing, resolveBaseWorkspace) {
				super(ctx, "uiWorkspace");
				this.directoryPicker = directoryPicker;
				this.workspaces = workspaces;
				this.sessions = sessions;
				this.view = view;
				this.notify = notify;
				this.placeUnscoped = placeUnscoped;
				this.onBaseWorkspaceMissing = onBaseWorkspaceMissing;
				this.resolveBaseWorkspace = resolveBaseWorkspace;
				ctx.effect(() => {
					const stop = this.watchNavigation();
					return () => {
						stop();
						this.lifetime.abort();
						const reference = this.mainReference;
						this.mainReference = void 0;
						reference?.release();
					};
				}, "ui-workspace: Workspace navigation policy");
			}
			async connectWorkspace(workspaceId) {
				const workspace = this.workspaces.list.getSnapshot().items.find((item) => item.workspaceId === workspaceId);
				if (workspace === void 0) throw new Error(`uiWorkspace.connectWorkspace: unknown workspace ${workspaceId}`);
				const inflight = this.connecting.get(workspaceId);
				if (inflight !== void 0) return inflight;
				const attempt = this.reuseOrCreateBlank(workspace).finally(() => {
					this.connecting.delete(workspaceId);
				});
				this.connecting.set(workspaceId, attempt);
				return attempt;
			}
			reuseOrCreateBlank(workspace) {
				const archived = this.workspaces.list.getSnapshot().archivedSessionIds;
				const sessions = this.sessions.list.getSnapshot();
				for (const id of sessions.ids) {
					const summary = sessions.byId[id];
					if (summary === void 0 || !summary.blank || summary.cwd !== workspace.path || !workspace.sessionIds.includes(id) || archived.includes(id)) continue;
					return this.reuseBlank(workspace.workspaceId, id);
				}
				return this.sessions.create({ workspaceId: workspace.workspaceId });
			}
			async reuseBlank(workspaceId, sessionId) {
				try {
					return await this.sessions.create({
						workspaceId,
						sessionId
					});
				} catch (error) {
					if (sessionCreateErrorOf(error)?.rpcError.code !== "session/writer-held") throw error;
					return this.sessions.create({ workspaceId });
				}
			}
			openSession(target) {
				this.replaceMain(target, this.lifetime.signal, "reveal");
			}
			async openWorkspace(workspaceId, beforeOpen) {
				const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal]);
				let sessionId;
				try {
					sessionId = await this.connectWorkspace(workspaceId);
				} catch (error) {
					if (!navigation.aborted) this.notify({
						kind: "createFailed",
						message: creationFailureMessage(error)
					});
					throw error;
				}
				if (navigation.aborted) return;
				this.replaceMain(sessionId, navigation, "reveal", beforeOpen);
			}
			async forkSession(sessionId) {
				await this.sessions.fork({
					sessionId,
					increaseTitle: true
				});
			}
			startSession(workspaceId, beforeOpen) {
				if (workspaceId !== void 0) {
					this.openNewSessionIn(workspaceId, beforeOpen);
					return;
				}
				const route = this.resolveBaseWorkspace?.();
				if (route?.kind === "workspace") {
					this.openNewSessionIn(route.workspaceId, beforeOpen);
					return;
				}
				if (route?.kind === "missing") {
					this.onBaseWorkspaceMissing?.({
						mode: "specified",
						path: route.path,
						name: route.name
					});
					return;
				}
				const prepared = beforeOpen ?? (this.placeUnscoped === void 0 ? void 0 : (sessionId) => {
					this.placeUnscoped?.(sessionId, this.mainReference?.sessionId);
				});
				this.startSessionInDefaultWorkspace(prepared);
			}
			/** Open the New Session flow in one already-known Workspace. */
			openNewSessionIn(workspaceId, beforeOpen) {
				this.openWorkspace(workspaceId, beforeOpen).catch((reason) => {
					console.warn("new session failed:", reason);
				});
			}
			/**
			* Resolve the Host's default Workspace, then start a Session in it.
			*
			* `initializeDefault` is a pure read once the registry records a default: it
			* returns the recorded entity before reaching any directory resolution, so
			* this creates and relocates nothing in normal use.
			*
			* Resolved per click rather than cached: a cached id would outlive a deleted
			* or replaced registration and then fail inside `connectWorkspace`, whereas a
			* stale read here simply resolves again.
			*
			* With no default Workspace to resolve (a deleted registration, or an install
			* ineligible for one) the click does nothing at all. It deliberately does not
			* fall back to another Workspace, and does not clear the current selection
			* the way the shipped guess did.
			* @param beforeOpen - preparation for the Session that lands; see
			* `startSession`. Skipped along with the whole flow when there is no default.
			*/
			async startSessionInDefaultWorkspace(beforeOpen) {
				const prepared = await this.initializeDefaultWorkspace(this.lifetime.signal);
				if (prepared === void 0) {
					this.onBaseWorkspaceMissing?.({
						mode: "default",
						path: null,
						name: null
					});
					return;
				}
				this.openNewSessionIn(prepared.workspaceId, beforeOpen);
			}
			async archiveSession(sessionId, options = {}) {
				await this.workspaces.archiveSession(sessionId, options);
				if (this.mainReference?.sessionId === sessionId) this.clearMain();
			}
			async unarchiveSession(sessionId) {
				await this.workspaces.unarchiveSession(sessionId);
			}
			async pinSession(sessionId) {
				await this.workspaces.pinSession(sessionId);
				const { items, pinnedSessionIds, archivedSessionIds } = this.workspaces.list.getSnapshot();
				this.view.pinSessionOrder(sessionId, pinOrderAccounts(items, sessionId), pinOrderSource(items, this.sessions.list.getSnapshot(), {
					pinnedSessionIds,
					archivedSessionIds
				}));
			}
			async unpinSession(sessionId) {
				await this.workspaces.unpinSession(sessionId);
			}
			async pickDirectory() {
				const result = await this.directoryPicker.pick();
				if (!result.ok) throw new Error(`directory picker failed: ${result.error.message}`);
				return result.value;
			}
			async listDirectory(path, signal) {
				const result = await this.directoryPicker.list(path, signal);
				if (!result.ok) throw new DirectoryBrowseError(result.error);
				return result.value;
			}
			async createDirectory(path, name) {
				const result = await this.directoryPicker.createDirectory(path, name);
				if (!result.ok) throw new DirectoryBrowseError(result.error);
				return result.value;
			}
			watchNavigation() {
				let initial = "waiting";
				const reconcile = () => {
					if (this.lifetime.signal.aborted) return;
					if (this.clearArchivedCurrent()) return;
					if (initial !== "waiting") return;
					const workspace = this.workspaces.list.getSnapshot();
					const sessions = this.sessions.list.getSnapshot();
					if (workspace.phase !== "ready" || sessions.phase !== "ready") return;
					if (this.mainReference !== void 0) {
						initial = "done";
						return;
					}
					initial = "connecting";
					this.restoreSelection(workspace, sessions).then(() => {
						initial = "done";
					}, (reason) => {
						if (this.lifetime.signal.aborted) return;
						initial = "waiting";
						console.warn("initial Session restoration failed:", reason);
					});
				};
				const disposeWorkspaces = this.workspaces.list.subscribe(reconcile);
				const disposeSessions = this.sessions.list.subscribe(reconcile);
				reconcile();
				return () => {
					this.lifetime.abort();
					disposeSessions();
					disposeWorkspaces();
				};
			}
			async restoreSelection(workspaces, sessions) {
				const saved = this.selection.getSnapshot();
				if (saved.subagentAddress !== void 0) {
					this.replaceMain(saved.subagentAddress, this.lifetime.signal, "preserve");
					return;
				}
				const summary = saved.sessionId === void 0 ? void 0 : sessions.byId[saved.sessionId];
				const workspace = summary === void 0 ? void 0 : workspaces.items.find((item) => item.sessionIds.includes(summary.id));
				if (summary !== void 0 && (!summary.blank || workspace === void 0)) {
					this.replaceMain(summary.id, this.lifetime.signal, "preserve");
					return;
				}
				const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal]);
				let sessionId;
				if (summary !== void 0 && workspace !== void 0 && summary.cwd === workspace.path && !workspaces.archivedSessionIds.includes(summary.id)) sessionId = await this.reuseBlank(workspace.workspaceId, summary.id);
				let target = workspace?.workspaceId ?? recentWorkspace(workspaces.items, sessions.byId);
				if (target === void 0 && workspaces.items.length === 0 && sessions.ids.length === 0) {
					const prepared = await this.initializeDefaultWorkspace(navigation);
					if (navigation.aborted) return;
					target = prepared?.workspaceId;
				}
				if (sessionId === void 0 && target !== void 0) sessionId = await this.connectWorkspace(target);
				if (sessionId !== void 0 && !navigation.aborted) this.replaceMain(sessionId, navigation, "preserve");
			}
			async initializeDefaultWorkspace(signal) {
				try {
					return await this.workspaces.initializeDefault(signal);
				} catch (_error) {
					if (!signal.aborted) this.notify({ kind: "defaultWorkspaceFailed" });
					return;
				}
			}
			/** @returns true when an archived current selection was cleared. */
			clearArchivedCurrent() {
				const current = this.mainReference?.sessionId;
				if (current === void 0 || !this.workspaces.list.getSnapshot().archivedSessionIds.includes(current)) return false;
				this.clearMain();
				return true;
			}
			clearMain() {
				const previous = this.mainReference;
				this.mainReference = void 0;
				this.selection.set({});
				previous?.release();
				this.ctx.layout.selectPanel(null);
			}
			replaceMain(target, signal, panel, beforeOpen) {
				signal.throwIfAborted();
				const reference = this.sessions.retain(target, { source: "mainView" });
				try {
					signal.throwIfAborted();
					beforeOpen?.(reference.sessionId);
					if (signal.aborted) {
						reference.release();
						return;
					}
					const subagentAddress = typeof target === "string" ? this.sessions.subagentAddress(reference.sessionId) : target;
					this.selection.set({
						sessionId: reference.sessionId,
						...subagentAddress === void 0 ? {} : { subagentAddress }
					});
				} catch (error) {
					reference.release();
					throw error;
				}
				const previous = this.mainReference;
				this.mainReference = reference;
				previous?.release();
				if (panel === "reveal") this.ctx.layout.selectPanel(null);
			}
		};
		/**
		* `error` as the Session Controller's creation failure, or undefined when it
		* is not one. Client plugin bundles do not share error-class identity, so the
		* name decides.
		*/
		function sessionCreateErrorOf(error) {
			return error instanceof Error && error.name === "SessionCreateError" ? error : void 0;
		}
		/**
		* The words a failed Session creation is reported in: a Host refusal keeps its
		* stable code and message; any other failure keeps its own message.
		*/
		function creationFailureMessage(error) {
			const refused = sessionCreateErrorOf(error);
			if (refused !== void 0) return `${refused.rpcError.code}: ${refused.rpcError.message}`;
			return error instanceof Error ? error.message : String(error);
		}
		/** Stable tie-breaking follows Host Workspace order. */
		function recentWorkspace(workspaces, sessions) {
			let selected;
			let selectedTime = Number.NEGATIVE_INFINITY;
			for (const workspace of workspaces) {
				let latest = Number.NEGATIVE_INFINITY;
				for (const sessionId of workspace.sessionIds) {
					const session = sessions[sessionId];
					if (session !== void 0) latest = Math.max(latest, session.updatedAt);
				}
				if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt);
				if (selected === void 0 || latest > selectedTime) {
					selected = workspace.workspaceId;
					selectedTime = latest;
				}
			}
			return selected;
		}
		//#endregion
		//#region node_modules/.pnpm/clsx@2.1.1/node_modules/clsx/dist/clsx.mjs
		function r(e) {
			var t, f, n = "";
			if ("string" == typeof e || "number" == typeof e) n += e;
			else if ("object" == typeof e) if (Array.isArray(e)) {
				var o = e.length;
				for (t = 0; t < o; t++) e[t] && (f = r(e[t])) && (n && (n += " "), n += f);
			} else for (f in e) e[f] && (n && (n += " "), n += f);
			return n;
		}
		function clsx() {
			for (var e, t, f = 0, n = "", o = arguments.length; f < o; f++) (e = arguments[f]) && (t = r(e)) && (n && (n += " "), n += t);
			return n;
		}
		/**
		* The text one Workspace is labeled with. A Workspace still carrying the
		* automatic first-use title reads as the caller's localized default name; every
		* other title reads verbatim in every language. A title the user typed as
		* exactly {@link DEFAULT_WORKSPACE_DIRECTORY} is labeled as the default too;
		* nothing else depends on the distinction.
		* @param title - stored Workspace title.
		* @param localizedDefault - the default Workspace name in the active language.
		* @returns the title to display.
		*/
		function workspaceDisplayTitle(title, localizedDefault) {
			return title === "default-workspace" ? localizedDefault : title;
		}
		//#endregion
		//#region \0dsh-css:src/vendored/client/rows/Rows.module.css.mjs
		const css$4 = "._2gigiW_projectRow,._2gigiW_sessionRow{border-radius:var(--dsw-radius-md);padding:0 8px;cursor:pointer;user-select:none;color:var(--dsw-alias-label-primary);align-items:center;gap:6px;padding-inline-start:calc(8px + var(--dsh-workspace-indent,0px));display:flex}._2gigiW_projectRow:hover,._2gigiW_sessionRow:hover,._2gigiW_sessionRow._2gigiW_selected{background:var(--dsw-alias-interactive-bg-hover)}._2gigiW_searchResultRow{box-sizing:border-box;border-radius:var(--dsw-radius-lg);cursor:pointer;text-align:left;width:100%;min-height:48px;color:var(--dsw-alias-label-primary);background:0 0;border:none;flex-direction:column;align-items:stretch;padding:4px 8px;display:flex}._2gigiW_searchResultRow:hover,._2gigiW_searchResultRow._2gigiW_selected{background:var(--dsw-alias-interactive-bg-hover)}._2gigiW_searchResultHeading{align-items:center;min-width:0;display:flex}._2gigiW_searchResultTitle{text-overflow:ellipsis;white-space:nowrap;flex:0 auto;min-width:0;margin-left:4px;font-size:14px;line-height:20px;overflow:hidden}._2gigiW_searchResultMeta{align-items:center;gap:6px;min-width:0;margin-left:20px;display:flex}._2gigiW_searchResultWorkspace,._2gigiW_searchResultSnippet{text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:17px;overflow:hidden}._2gigiW_searchResultWorkspace{max-width:40%;color:var(--dsw-alias-label-tertiary);flex:none}._2gigiW_searchResultWorkspace:only-child{max-width:100%}._2gigiW_searchResultSnippet{min-width:0;color:var(--dsw-alias-label-secondary);flex:1}._2gigiW_projectRow{box-sizing:border-box;align-items:center;height:34px}._2gigiW_projectRow ._2gigiW_rowActions{height:20px}._2gigiW_sessionRow{gap:0;height:32px}._2gigiW_sessionRow ._2gigiW_title{margin:0 6px 0 4px}._2gigiW_slot{width:16px;height:20px;color:var(--dsw-alias-label-tertiary);flex:none;justify-content:center;align-items:center;display:inline-flex}._2gigiW_visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}._2gigiW_folderActive{color:var(--dsw-alias-state-business-primary)}._2gigiW_projectRow ._2gigiW_chevron{display:none}._2gigiW_projectRow:hover ._2gigiW_chevron{display:inline-flex}._2gigiW_projectRow:hover ._2gigiW_folder{display:none}._2gigiW_arrow{transition:transform .15s var(--ds-ease-in-out)}._2gigiW_arrowOpen{transform:rotate(90deg)}._2gigiW_projectText{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex}._2gigiW_title{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:14px;line-height:20px;overflow:hidden}._2gigiW_renameInput{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-button-elevated-fill);min-width:0;color:inherit;outline:none;padding:0 2px;font-size:14px;line-height:20px}._2gigiW_sessionRow ._2gigiW_title{flex:1}._2gigiW_sessionRow ._2gigiW_title[data-scrolled]{mask-image:linear-gradient(90deg,#0000,#000 12px)}._2gigiW_sessionRow ._2gigiW_title[data-clipped]{mask-image:linear-gradient(270deg,#0000,#000 12px)}._2gigiW_sessionRow ._2gigiW_title[data-scrolled][data-clipped]{mask-image:linear-gradient(90deg,#0000,#000 12px calc(100% - 12px),#0000)}._2gigiW_meta{text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;overflow:hidden}._2gigiW_time{color:var(--dsw-alias-label-tertiary);flex:none;font-size:10px;line-height:16px}._2gigiW_pinIndicator{width:16px;height:20px;color:var(--dsw-alias-label-caption);flex:none;justify-content:center;align-items:center;margin-left:6px;display:inline-flex}._2gigiW_sessionRow._2gigiW_archived ._2gigiW_title,._2gigiW_searchResultRow._2gigiW_archived ._2gigiW_searchResultTitle,._2gigiW_searchResultRow._2gigiW_archived ._2gigiW_searchResultWorkspace,._2gigiW_searchResultRow._2gigiW_archived ._2gigiW_searchResultSnippet{color:var(--dsw-alias-label-caption)}._2gigiW_dot{flex:none}._2gigiW_rowActions{flex:none;align-items:center;gap:10px;display:none}._2gigiW_projectRow:hover ._2gigiW_rowActions,._2gigiW_sessionRow:hover ._2gigiW_rowActions,._2gigiW_searchResultRow:hover ._2gigiW_rowActions,._2gigiW_projectRow._2gigiW_menuOpen ._2gigiW_rowActions,._2gigiW_sessionRow._2gigiW_menuOpen ._2gigiW_rowActions{display:inline-flex}._2gigiW_searchResultHeading ._2gigiW_rowActions{margin-left:auto}._2gigiW_sessionRow:hover ._2gigiW_time,._2gigiW_sessionRow._2gigiW_menuOpen ._2gigiW_time,._2gigiW_sessionRow:hover ._2gigiW_pinIndicator,._2gigiW_sessionRow._2gigiW_menuOpen ._2gigiW_pinIndicator{display:none}@media (hover:hover){._2gigiW_sessionRow:hover ._2gigiW_title,._2gigiW_sessionRow._2gigiW_menuOpen ._2gigiW_title{text-overflow:clip}}._2gigiW_projectRow._2gigiW_menuOpen,._2gigiW_sessionRow._2gigiW_menuOpen{background:var(--dsw-alias-interactive-bg-hover)}._2gigiW_sessionRow._2gigiW_dropBefore,._2gigiW_sessionRow._2gigiW_dropAfter{position:relative}._2gigiW_sessionRow._2gigiW_dropBefore:before,._2gigiW_sessionRow._2gigiW_dropAfter:after{content:\"\";z-index:1;background:linear-gradient(55deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 0 / 5px 7px no-repeat, linear-gradient(125deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 5px / 5px 7px no-repeat, linear-gradient(var(--dsw-alias-state-business-primary) 0 0) 4px 5px / calc(100% - 4px) 2px no-repeat;pointer-events:none;height:12px;position:absolute;left:0;right:4px}._2gigiW_sessionRow._2gigiW_dropBefore:before{top:-7px}._2gigiW_sessionRow._2gigiW_dropAfter:after{bottom:-7px}._2gigiW_hoverContent{flex-direction:column;gap:8px;display:flex}._2gigiW_hoverTitle{color:#fff;overflow-wrap:break-word;font-size:14px;line-height:20px}._2gigiW_hoverPath{color:#cfd3d6;word-break:break-all;font-size:12px;line-height:16px}._2gigiW_hoverTime{color:#cfd3d6;font-size:12px;line-height:16px}._2gigiW_hoverStatus{color:#adb2b8;align-items:center;gap:8px;font-size:12px;line-height:20px;display:flex}._2gigiW_hoverArchived svg{flex-shrink:0;margin:0 -4px}._2gigiW_iconButton{border-radius:var(--dsw-radius-xs);cursor:pointer;width:16px;height:16px;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}._2gigiW_iconButton:hover{color:var(--dsw-alias-label-primary)}._2gigiW_chevron{color:var(--dsw-alias-label-caption)}@media (prefers-reduced-motion:reduce){._2gigiW_arrow{transition:none;animation:none}}";
		const tagId$4 = "dsh-project-groups/Rows.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$4) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-project-groups";
			tag.dataset.pluginCss = tagId$4;
			tag.textContent = css$4;
			document.head.appendChild(tag);
		}
		var Rows_module_css_default = {
			"archived": "_2gigiW_archived",
			"arrow": "_2gigiW_arrow",
			"arrowOpen": "_2gigiW_arrowOpen",
			"chevron": "_2gigiW_chevron",
			"dot": "_2gigiW_dot",
			"dropAfter": "_2gigiW_dropAfter",
			"dropBefore": "_2gigiW_dropBefore",
			"folder": "_2gigiW_folder",
			"folderActive": "_2gigiW_folderActive",
			"hoverArchived": "_2gigiW_hoverArchived",
			"hoverContent": "_2gigiW_hoverContent",
			"hoverPath": "_2gigiW_hoverPath",
			"hoverStatus": "_2gigiW_hoverStatus",
			"hoverTime": "_2gigiW_hoverTime",
			"hoverTitle": "_2gigiW_hoverTitle",
			"iconButton": "_2gigiW_iconButton",
			"menuOpen": "_2gigiW_menuOpen",
			"meta": "_2gigiW_meta",
			"pinIndicator": "_2gigiW_pinIndicator",
			"projectRow": "_2gigiW_projectRow",
			"projectText": "_2gigiW_projectText",
			"renameInput": "_2gigiW_renameInput",
			"rowActions": "_2gigiW_rowActions",
			"searchResultHeading": "_2gigiW_searchResultHeading",
			"searchResultMeta": "_2gigiW_searchResultMeta",
			"searchResultRow": "_2gigiW_searchResultRow",
			"searchResultSnippet": "_2gigiW_searchResultSnippet",
			"searchResultTitle": "_2gigiW_searchResultTitle",
			"searchResultWorkspace": "_2gigiW_searchResultWorkspace",
			"selected": "_2gigiW_selected",
			"sessionRow": "_2gigiW_sessionRow",
			"slot": "_2gigiW_slot",
			"time": "_2gigiW_time",
			"title": "_2gigiW_title",
			"visuallyHidden": "_2gigiW_visuallyHidden"
		};
		//#endregion
		//#region src/vendored/client/rows/Rows.tsx
		/**
		* Workspace browser tree row components (figma Cell set 14:3080): pure presentational —
		* all data and callbacks arrive via props. Hover swaps (folder->chevron,
		* time->ellipsis, action buttons) are CSS-only, and a session row's clipped
		* title marquees programmatically while the row is hovered. Workspace row
		* menus are visual-only except Rename/Delete. A Session row's "..." menu and
		* its hover buttons are the `sidebar.workspaces.session.menu.item` and
		* `sidebar.workspaces.session.row.action` lists, rendered through the
		* browser's `renderSlot` with the menu's open state as the occurrence's hook
		* context; this package's own actions are entries like any plugin's. The
		* session and workspace hover cards are suppressed while a menu is open.
		*/
		/** Row display title: blank rows show the localized New Session label. */
		function displayTitle(node, t) {
			return node.blank ? t("session.new") : node.title;
		}
		/**
		* One Session row's animation identity: `session:<id>@<groupKey>`.
		*
		* `AnimatedRows` chooses between an entry fade and a glide by whether a key was
		* present in the previous commit. A Session that changes group under an unchanged
		* key is therefore **glided** — the same row travelling from its old position to
		* its new one, straight across the sidebar — which the official sidebar never
		* shows, because there a Session's group is its Workspace and belongs to it from
		* creation rather than being re-filed later. Carrying the owning group makes the
		* same Session under a new group a *different* key: the old key leaves (exit fade)
		* and the new one arrives (entry fade), which is what the official cross-Workspace
		* transition does.
		*
		* `blank` is deliberately **not** part of the key. A blank New Session becoming
		* real stays in its group, so its key is unchanged, `sameRows` holds, and the row
		* is patched in place with no animation — matching the official transition, which
		* measured as one surviving DOM node with zero movement and zero fade.
		*
		* The `session:` prefix stays because the group views' selectors key off it. The
		* separator is `@`: a Session id is `session-<uuid>` and a group key is a uuid or
		* the empty Ungrouped key, none of which contain it — so Ungrouped (`''`) still
		* changes the key, as it must.
		* @param id - the Session id.
		* @param groupKey - owning group key; omitted by the flat list, which has no groups.
		* @returns the value for that row's `data-row-key`.
		*/
		function sessionRowKey(id, groupKey) {
			return groupKey === void 0 ? `session:${id}` : `session:${id}@${groupKey}`;
		}
		const MIN_TITLE_REVEAL_PX = 8;
		const TITLE_MARQUEE_PX_PER_MS = .03;
		/**
		* Place the title's scroll position and publish the stylesheet's fade-mask
		* hooks: `data-scrolled` while the title has left its start (left fade) and
		* `data-clipped` while text remains beyond the right edge (right fade).
		* @param title - the row's clipping title element.
		* @param left - scroll offset in CSS pixels.
		* @param range - the title's maximum scroll offset in CSS pixels.
		*/
		function placeTitle(title, left, range) {
			if (typeof title.scrollTo === "function") title.scrollTo({
				left,
				behavior: "instant"
			});
			else title.scrollLeft = left;
			if (left > 0) title.dataset.scrolled = "";
			else delete title.dataset.scrolled;
			if (left < range) title.dataset.clipped = "";
			else delete title.dataset.clipped;
		}
		/**
		* Return the title to its resting state: scrolled to the start with both fade
		* masks off, so the resting ellipsis renders at full strength.
		* @param title - the row's clipping title element.
		*/
		function restTitle(title) {
			if (typeof title.scrollTo === "function") title.scrollTo({
				left: 0,
				behavior: "instant"
			});
			else title.scrollLeft = 0;
			delete title.dataset.scrolled;
			delete title.dataset.clipped;
		}
		/**
		* Marquee a title wider than its one-line cell while its row is hovered: the
		* title clips its own text, so entering crawls it at a constant speed until the
		* far edge (a fork's incremented title, for example) is in view, then rests
		* there under the pointer. Overflow of at most {@link MIN_TITLE_REVEAL_PX}
		* stays put — a barely-clipped title moving a few pixels reads as jitter, not a
		* reveal. Leaving returns the title to the start in one step, because the
		* resting ellipsis and the narrowed cell would otherwise meet the text while it
		* travelled back. Reduced motion jumps to the far edge instead of crawling.
		* @param title - ref to the row's clipping title element.
		* @returns stable pointer enter/leave handlers for the row.
		*/
		function useTitleMarquee(title) {
			const frame = (0, react.useRef)(0);
			(0, react.useEffect)(() => () => {
				cancelAnimationFrame(frame.current);
			}, []);
			return (0, react.useMemo)(() => ({
				enter: () => {
					/* v8 ignore next -- defensive: the title span renders unconditionally. */
					if (title.current === null) return;
					const element = title.current;
					const range = element.scrollWidth - element.clientWidth;
					if (range <= MIN_TITLE_REVEAL_PX) return;
					if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
						placeTitle(element, range, range);
						return;
					}
					cancelAnimationFrame(frame.current);
					let previous;
					let position = 0;
					const step = (now) => {
						position += previous === void 0 ? 0 : (now - previous) * TITLE_MARQUEE_PX_PER_MS;
						previous = now;
						placeTitle(element, Math.min(position, range), range);
						if (position < range) frame.current = requestAnimationFrame(step);
					};
					frame.current = requestAnimationFrame(step);
				},
				leave: () => {
					cancelAnimationFrame(frame.current);
					/* v8 ignore next -- defensive: the title span renders unconditionally. */
					if (title.current === null) return;
					restTitle(title.current);
				}
			}), [title]);
		}
		/** Localized compact relative time ("刚刚"/"5分钟" in zh, "now"/"5min" in en). */
		function timeLabel(updatedAt, now, t) {
			const { unit, n } = (0, _deepseek_ai_dsh_client_ui_primitives.relativeTime)(updatedAt, now);
			return unit === "now" ? t("time.now") : t(`time.${unit}`, { n });
		}
		/** Hover-card variant: distances wrap in the ago template; the now bucket stays bare (no "now ago"). */
		function hoverTimeLabel(updatedAt, now, t) {
			const { unit, n } = (0, _deepseek_ai_dsh_client_ui_primitives.relativeTime)(updatedAt, now);
			return unit === "now" ? t("time.now") : t("time.ago", { t: t(`time.${unit}`, { n }) });
		}
		/**
		* Absolute creation time through the dictionary's date template (the message
		* clock pattern): `toLocaleString` would follow the browser language, not the
		* app locale, and produce mixed-language text after a switch.
		*/
		function createdLabel(createdAt, t) {
			const d = new Date(createdAt);
			const pad2 = (v) => String(v).padStart(2, "0");
			return t("hover.created", { time: `${t("date.ymd", {
				y: d.getFullYear(),
				m: d.getMonth() + 1,
				d: d.getDate()
			})} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` });
		}
		/** Hover-card body: workspace title, display directory path, absolute creation time. */
		function WorkspaceHoverContent({ label, cwd, createdAt, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: Rows_module_css_default.hoverContent,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: Rows_module_css_default.hoverTitle,
						children: label
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: Rows_module_css_default.hoverPath,
						children: cwd
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: Rows_module_css_default.hoverTime,
						children: createdLabel(createdAt, t)
					})
				]
			});
		}
		/** Pointer-position half of a row (insert line above or below). */
		function rowHalf(e) {
			const rect = e.currentTarget.getBoundingClientRect();
			return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
		}
		/**
		* Project (workspace) header row: folder + title;
		* hover reveals the chevron and create button, and dwelling on a real
		* Workspace shows its hover card (the ungrouped bucket has none).
		* `containsCurrent` arrives on the node (derivation fact, no renderer scan).
		* @param props.group - derived group node.
		* @param props.containsCurrentDescendant - highlight an ancestor even when its subtree is collapsed.
		* @param props.onToggle - expand/collapse the group.
		* @param props.onCreate - start a frontend Session inside this Workspace.
		* @param props.drag - optional workspace-row drag wiring.
		* @param props.home - host account home for POSIX hover-path abbreviation.
		* @param props.t - the browser root's locale seat.
		* @returns the row element.
		*/
		function ProjectRowItem({ group, containsCurrentDescendant = false, onToggle, onCreate, actions, drag, groupDrop, home, newShortcut, t }) {
			const row = group;
			const label = row.label === "" ? t("group.ungrouped") : row.label;
			const active = containsCurrentDescendant || group.expanded && group.containsCurrent;
			const [menuOpen, setMenuOpen] = (0, react.useState)(false);
			const deleteLabel = group.kind === "project" ? t("delete.project") : t("delete.workspace");
			const workspaceMenuItems = [{
				id: "rename",
				label: t("rename"),
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutlineRegular, {})
			}, {
				id: "delete",
				label: deleteLabel,
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutlineRegular, {}),
				danger: true
			}];
			const ownRow = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: clsx(Rows_module_css_default.projectRow, menuOpen && Rows_module_css_default.menuOpen),
				"data-row-key": `workspace:${group.key}`,
				role: "treeitem",
				"aria-expanded": row.expanded,
				onClick: onToggle,
				draggable: drag !== void 0,
				onDragStart: drag === void 0 ? void 0 : (e) => {
					e.dataTransfer.effectAllowed = "move";
					e.dataTransfer.setData("text/plain", row.key);
					drag.start();
				},
				onDragEnd: drag?.end,
				onDragEnter: groupDrop === void 0 ? void 0 : (e) => {
					e.preventDefault();
					groupDrop.enter();
				},
				onDragOver: groupDrop === void 0 ? void 0 : (e) => {
					e.preventDefault();
					e.stopPropagation();
					e.dataTransfer.dropEffect = "move";
					groupDrop.enter();
				},
				onDragLeave: groupDrop === void 0 ? void 0 : () => {
					groupDrop.leave();
				},
				onDrop: groupDrop === void 0 ? void 0 : (e) => {
					e.preventDefault();
					e.stopPropagation();
					groupDrop.drop();
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: clsx(Rows_module_css_default.slot, Rows_module_css_default.folder, active && Rows_module_css_default.folderActive),
						children: row.expanded ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpenRegular, {}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderCloseRegular, {})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: clsx(Rows_module_css_default.slot, Rows_module_css_default.chevron),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTriangleRightFillRegular, { className: clsx(Rows_module_css_default.arrow, row.expanded && Rows_module_css_default.arrowOpen) })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: Rows_module_css_default.projectText,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: Rows_module_css_default.title,
							children: label
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: Rows_module_css_default.rowActions,
						children: [actions !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
							open: menuOpen,
							onClose: () => {
								setMenuOpen(false);
							},
							items: workspaceMenuItems,
							onSelect: (id) => {
								setMenuOpen(false);
								/* v8 ignore next -- Menu can emit only the rename and delete rows supplied above. */
								if (id !== "rename" && id !== "delete") return;
								if (id === "rename") actions.rename();
								else actions.delete();
							},
							portal: true,
							closeOnPointerLeave: true,
							anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: Rows_module_css_default.iconButton,
								"aria-label": t(group.kind === "project" ? "actions.project.aria" : "actions.workspace.aria", { name: label }),
								onClick: (e) => {
									e.stopPropagation();
									setMenuOpen((v) => !v);
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEllipsisOutlineRegular, {})
							})
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
							label: t("actions.newSession"),
							shortcutKeys: newShortcut?.keys,
							side: "bottom",
							align: "end",
							delayMs: 500,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: Rows_module_css_default.iconButton,
								"aria-keyshortcuts": newShortcut?.aria,
								"aria-label": t("actions.newSession.aria", { name: label }),
								onClick: (e) => {
									e.stopPropagation();
									onCreate();
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconNewChatOutlineRegular, {})
							})
						})]
					})
				]
			});
			if (row.createdAt === void 0) return ownRow;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.HoverCard, {
				anchor: ownRow,
				content: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkspaceHoverContent, {
					label: row.label,
					cwd: row.cwd === void 0 ? void 0 : abbreviateHomePath(row.cwd, home),
					createdAt: row.createdAt,
					t
				}),
				openDelayMs: 800,
				disabled: menuOpen,
				copyText: row.cwd,
				copyLabel: t("copy"),
				copiedLabel: t("hover.copied")
			});
		}
		/* v8 ignore next 3 -- closed-union backstop; only reached if the status is forged */
		function assertNever(value) {
			throw new Error(`unknown pending interaction: ${String(value)}`);
		}
		/**
		* Session status presentation; pending interaction is primary and live activity
		* outranks completion reminders.
		*/
		function sessionStatuses(node, t) {
			const subagents = node.runningSubagentCount === 0 ? void 0 : {
				state: "ongoing",
				label: t(node.runningSubagentCount === 1 ? "status.subagentsRunning.one" : "status.subagentsRunning.other", { n: node.runningSubagentCount })
			};
			let pending;
			switch (node.pendingInteraction) {
				case "approval":
					pending = {
						state: "warning",
						label: t("status.waitingApproval"),
						trailingLabel: t("status.compact.approval")
					};
					break;
				case "plan-review":
					pending = {
						state: "warning",
						label: t("status.planReview"),
						trailingLabel: t("status.compact.planReview")
					};
					break;
				case "question":
					pending = {
						state: "warning",
						label: t("status.waitingAnswer"),
						trailingLabel: t("status.compact.answer")
					};
					break;
				case void 0: break;
				/* v8 ignore next -- closed PendingInteractionStatus union */
				default: return assertNever(node.pendingInteraction);
			}
			if (pending !== void 0) return subagents === void 0 ? [pending] : [pending, subagents];
			if (node.running) {
				const primary = {
					state: "ongoing",
					label: t("status.running")
				};
				return subagents === void 0 ? [primary] : [primary, subagents];
			}
			if (subagents !== void 0) return [subagents];
			if (node.completed) return [{
				state: "done",
				label: t("status.completed")
			}];
			return [{
				state: "idle",
				label: t("status.idle")
			}];
		}
		/** Primary status dot plus every status's screen-reader label, shared by the search and session rows. */
		function SessionStatusDots({ statuses }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: statuses[0].state }), statuses.map((status) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: Rows_module_css_default.visuallyHidden,
				children: status.label
			}, status.label))] });
		}
		/** Non-interactive pinned-row marker; the enclosing row remains the only action. */
		function PinnedIndicator({ t }) {
			const label = t("row.pinned");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: Rows_module_css_default.pinIndicator,
				role: "img",
				"aria-label": label,
				title: label,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPinFillRegular, { size: 14 })
			});
		}
		/**
		* Hover-card body: full title, relative time, the Session's own scheduled-task
		* section, and every relevant live status. The task section sits above the
		* status lines so they stay the card's trailing status line.
		*/
		function SessionHoverContent({ node, now, renderSlot, t }) {
			const statuses = sessionStatuses(node, t).filter((status) => !(node.archived && (status.state === "done" || status.state === "idle")));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: Rows_module_css_default.hoverContent,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: Rows_module_css_default.hoverTitle,
						children: displayTitle(node, t)
					}),
					!node.blank && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: Rows_module_css_default.hoverTime,
						children: hoverTimeLabel(node.updatedAt, now, t)
					}),
					renderSlot("sidebar.session.row.hover", { sessionId: node.id }),
					statuses.map((status) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: Rows_module_css_default.hoverStatus,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: status.state }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: status.label })]
					}, status.label)),
					node.archived && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: clsx(Rows_module_css_default.hoverStatus, Rows_module_css_default.hoverArchived),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutlineRegular, { size: 14 }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.archived") })]
					})
				]
			});
		}
		/**
		* One flat search result: title, Workspace context, and optional content
		* excerpt. Search navigation opens the session only; it does not address an
		* event inside the conversation. Archived rows carry a hover unarchive
		* button, because search is where the filter surfaces them for recovery.
		* @param props.result - merged local/content search row.
		* @param props.currentId - selected session id.
		* @param props.onOpen - open the selected session.
		* @param props.onUnarchive - unarchive an archived result row.
		* @param props.t - Workspace-browser translation seat.
		* @returns the result row.
		*/
		function SearchResultItem({ result, currentId, onOpen, onUnarchive, t }) {
			const selected = result.id === currentId;
			const statuses = sessionStatuses(result, t);
			const primaryStatus = statuses[0];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: clsx(Rows_module_css_default.searchResultRow, selected && Rows_module_css_default.selected, result.archived && Rows_module_css_default.archived),
				role: "treeitem",
				"aria-selected": selected,
				"aria-description": result.archived ? t("toast.archivedNotOpenable") : void 0,
				onClick: () => {
					onOpen(result.id);
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: Rows_module_css_default.searchResultHeading,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: Rows_module_css_default.slot,
							children: !result.archived && primaryStatus.state !== "idle" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SessionStatusDots, { statuses })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: Rows_module_css_default.searchResultTitle,
							children: result.title
						}),
						result.archived && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: Rows_module_css_default.rowActions,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
								label: t("actions.unarchive"),
								side: "bottom",
								align: "end",
								delayMs: 500,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: Rows_module_css_default.iconButton,
									"aria-label": t("menu.unarchiveSession"),
									onClick: (e) => {
										e.stopPropagation();
										onUnarchive(result.id);
									},
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconUnarchiveOutlineRegular, { size: 14 })
								})
							})
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: Rows_module_css_default.searchResultMeta,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: Rows_module_css_default.searchResultWorkspace,
						children: result.workspace || t("group.ungrouped")
					}), result.snippet !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: Rows_module_css_default.searchResultSnippet,
						children: result.snippet
					})]
				})]
			});
		}
		/**
		* One top-level 32px session row: leading 16px cell (status dot, or the
		* leading seat while the row's primary state is idle), title, relative time or
		* compact pending label, and the row actions menu. A row that owns a state dot
		* keeps that cell and renders no seat, so an ambient automation mark never
		* appears beside the row's own state dot. An archived row keeps the cell blank:
		* neither marker renders there, and its live status stays on the hover card.
		* @param props.node - derived session node.
		* @param props.currentId - selected session id (row highlight).
		* @param props.now - epoch ms for relative-time formatting.
		* @param props.onOpen - open a session by id.
		* @param props.onRenameRequest - open the rename dialog from a title double-click (id + current title).
		* @param props.renderSlot - child-seat renderer for the row's action lists
		* (`sidebar.workspaces.session.menu.item` / `sidebar.workspaces.session.row.action`),
		* its leading decoration, and its hover-card section.
		* @param props.onReveal - scroll this row into view after search navigation, then acknowledge it.
		* @param props.drag - optional row-drag target wiring; blank rows cannot start a drag.
		* @param props.rowKey - animation identity for this row; see {@link sessionRowKey}.
		* Omitted by the flat list, whose rows have no group to change.
		* @param props.t - the browser root's locale seat.
		* @returns the session row.
		*/
		function SessionNodeItem({ node, currentId, now, onOpen, onRenameRequest, renderSlot, onReveal, drag, rowKey, t }) {
			const row = node;
			const title = displayTitle(node, t);
			const selected = node.id === currentId;
			const statuses = sessionStatuses(node, t);
			const primaryStatus = statuses[0];
			const showStatus = primaryStatus.state !== "idle";
			const draggable = drag !== void 0 && !row.blank && !row.archived;
			const [menuOpen, setMenuOpen] = (0, react.useState)(false);
			const menuOpenState = (0, react.useMemo)(() => [menuOpen, setMenuOpen], [menuOpen]);
			const rowRef = (0, react.useRef)(null);
			const titleRef = (0, react.useRef)(null);
			const marquee = useTitleMarquee(titleRef);
			(0, react.useEffect)(() => {
				if (onReveal === void 0) return;
				rowRef.current?.scrollIntoView({ block: "nearest" });
				onReveal();
			}, [onReveal]);
			const ownRow = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: rowRef,
				"data-row-key": rowKey ?? sessionRowKey(node.id),
				className: clsx(Rows_module_css_default.sessionRow, selected && Rows_module_css_default.selected, menuOpen && Rows_module_css_default.menuOpen, row.archived && Rows_module_css_default.archived, drag?.marker === "before" && Rows_module_css_default.dropBefore, drag?.marker === "after" && Rows_module_css_default.dropAfter),
				role: "treeitem",
				"aria-selected": selected,
				"aria-description": row.archived ? t("toast.archivedNotOpenable") : void 0,
				onClick: () => {
					onOpen(node.id);
				},
				onPointerEnter: marquee.enter,
				onPointerLeave: marquee.leave,
				draggable,
				onDragStart: !draggable ? void 0 : (e) => {
					e.dataTransfer.effectAllowed = "move";
					e.dataTransfer.setData("text/plain", node.id);
					drag.start();
				},
				onDragEnd: !draggable ? void 0 : drag.end,
				onDragOver: drag === void 0 ? void 0 : (e) => {
					if (!drag.active) return;
					e.preventDefault();
					e.stopPropagation();
					e.dataTransfer.dropEffect = "move";
					drag.hover(rowHalf(e));
				},
				onDrop: drag === void 0 ? void 0 : (e) => {
					if (!drag.active) return;
					e.preventDefault();
					e.stopPropagation();
					drag.drop(rowHalf(e));
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: Rows_module_css_default.slot,
						children: !row.archived && !row.blank && (showStatus ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SessionStatusDots, { statuses }) : renderSlot("sidebar.session.row.leading", { sessionId: node.id }))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						ref: titleRef,
						className: Rows_module_css_default.title,
						onDoubleClick: row.blank ? void 0 : (e) => {
							e.stopPropagation();
							onRenameRequest(node.id, row.title);
						},
						children: title
					}),
					!row.blank && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: Rows_module_css_default.time,
						"aria-hidden": primaryStatus.trailingLabel === void 0 ? void 0 : true,
						children: primaryStatus.trailingLabel ?? timeLabel(row.updatedAt, now, t)
					}),
					row.pinned && !row.archived && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PinnedIndicator, { t }),
					!row.blank && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: Rows_module_css_default.rowActions,
						onClick: (e) => {
							e.stopPropagation();
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
							open: menuOpen,
							onClose: () => {
								setMenuOpen(false);
							},
							portal: true,
							closeOnPointerLeave: true,
							anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: Rows_module_css_default.iconButton,
								"aria-label": t("actions.session.aria", { name: title }),
								onClick: () => {
									setMenuOpen((v) => !v);
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEllipsisOutlineRegular, {})
							}),
							children: renderSlot("sidebar.workspaces.session.menu.item", {
								sessionId: node.id,
								displayTitle: row.title
							}, { hookContext: menuOpenState })
						}), renderSlot("sidebar.workspaces.session.row.action", {
							sessionId: node.id,
							displayTitle: row.title
						})]
					})
				]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.HoverCard, {
				anchor: ownRow,
				content: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SessionHoverContent, {
					node,
					now,
					renderSlot,
					t
				}),
				openDelayMs: 800,
				disabled: menuOpen || drag?.active === true,
				copyText: row.blank ? void 0 : row.title,
				copyLabel: t("copy"),
				copiedLabel: t("hover.copied")
			});
		}
		//#endregion
		//#region \0dsh-css:src/vendored/client/rows/AnimatedRows.module.css.mjs
		const css$3 = ".U1U4uW_exits{contain:strict;pointer-events:none;position:absolute;inset:0;overflow:clip}";
		const tagId$3 = "dsh-project-groups/AnimatedRows.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$3) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-project-groups";
			tag.dataset.pluginCss = tagId$3;
			tag.textContent = css$3;
			document.head.appendChild(tag);
		}
		var AnimatedRows_module_css_default = { "exits": "U1U4uW_exits" };
		//#endregion
		//#region src/vendored/client/rows/AnimatedRows.tsx
		/** React-commit-driven movement and entry/exit fades for the sidebar's keyed rows. */
		const ROW_FADE_MS = 100;
		const ROW_GLIDE_MS = 200;
		function sameRows(previous, next) {
			return previous.rowKeys.length === next.rowKeys.length && previous.rowKeys.every((key, index) => key === next.rowKeys[index]);
		}
		function intersects(row, viewport) {
			return row.bottom > viewport.top && row.top < viewport.bottom && row.right > viewport.left && row.left < viewport.right;
		}
		/**
		* Animates keyed sidebar rows only when their rendered membership or order changes.
		* Motion starts after the first pointer or keyboard input inside the mounted list.
		* The parent supplies a positioned container for the inert exit overlay.
		*/
		var AnimatedRows = class extends react.Component {
			armed = false;
			list = (0, react.createRef)();
			overlay = (0, react.createRef)();
			movements = /* @__PURE__ */ new Map();
			exits = /* @__PURE__ */ new Map();
			getSnapshotBeforeUpdate(previous) {
				const list = this.list.current;
				if (!this.armed || sameRows(previous, this.props) || previous.resetKey !== this.props.resetKey || !previous.ready || !this.props.ready || list === null || typeof list.animate !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
				const viewport = list.getBoundingClientRect();
				const positions = this.readPositions();
				const nextKeys = new Set(this.props.rowKeys);
				const removed = /* @__PURE__ */ new Map();
				for (const [key, row] of positions) {
					if (nextKeys.has(key) || !intersects(row.rect, viewport)) continue;
					const clone = row.element.cloneNode(true);
					clone.removeAttribute("data-row-key");
					clone.inert = true;
					clone.style.setProperty("--dsh-workspace-indent", getComputedStyle(row.element).getPropertyValue("--dsh-workspace-indent"));
					removed.set(key, {
						...row,
						element: clone
					});
				}
				return {
					positions,
					removed
				};
			}
			componentDidUpdate(previous, _state, snapshot) {
				if (snapshot === null) {
					if (!sameRows(previous, this.props) || previous.resetKey !== this.props.resetKey || previous.ready !== this.props.ready) this.clear();
					return;
				}
				this.cancelMovements();
				const list = this.list.current;
				const overlay = this.overlay.current;
				const viewport = list.getBoundingClientRect();
				const origin = overlay.getBoundingClientRect();
				const positions = this.readPositions();
				for (const [key, row] of positions) {
					this.removeExit(key);
					const previousRow = snapshot.positions.get(key);
					if (!intersects(row.rect, viewport) && (previousRow === void 0 || !intersects(previousRow.rect, viewport))) continue;
					if (previousRow === void 0) {
						this.move(row.element, [{ opacity: 0 }, { opacity: 1 }], ROW_FADE_MS);
						continue;
					}
					const dx = previousRow.rect.left - row.rect.left;
					const dy = previousRow.rect.top - row.rect.top;
					if (dx === 0 && dy === 0 && previousRow.opacity === 1) continue;
					this.move(row.element, [{
						transform: `translate(${String(dx)}px, ${String(dy)}px)`,
						opacity: previousRow.opacity
					}, {
						transform: "translate(0, 0)",
						opacity: 1
					}], ROW_GLIDE_MS);
				}
				for (const [key, row] of snapshot.removed) {
					const { element } = row;
					this.removeExit(key);
					Object.assign(element.style, {
						position: "absolute",
						margin: "0",
						transform: "none",
						boxSizing: "border-box",
						left: `${String(row.rect.left - origin.left)}px`,
						top: `${String(row.rect.top - origin.top)}px`,
						width: `${String(row.rect.width)}px`,
						height: `${String(row.rect.height)}px`
					});
					overlay.append(element);
					const animation = element.animate([{ opacity: row.opacity }, { opacity: 0 }], {
						duration: ROW_FADE_MS,
						easing: "ease-out",
						fill: "forwards"
					});
					this.exits.set(key, {
						element,
						animation
					});
					animation.onfinish = () => {
						this.removeExit(key);
					};
				}
			}
			componentWillUnmount() {
				this.clear();
			}
			readPositions() {
				const rows = this.list.current.querySelectorAll("[data-row-key]");
				return new Map(Array.from(rows, (element) => [element.dataset.rowKey, {
					element,
					rect: element.getBoundingClientRect(),
					opacity: this.movements.has(element) ? Number(getComputedStyle(element).opacity) : 1
				}]));
			}
			move(element, keyframes, duration) {
				const animation = element.animate(keyframes, {
					duration,
					easing: "ease-out"
				});
				this.movements.set(element, animation);
				animation.onfinish = () => {
					this.movements.delete(element);
					animation.cancel();
				};
			}
			cancelMovements() {
				for (const animation of this.movements.values()) {
					animation.onfinish = null;
					animation.cancel();
				}
				this.movements.clear();
			}
			removeExit(key) {
				const exit = this.exits.get(key);
				if (exit === void 0) return;
				exit.animation.onfinish = null;
				exit.animation.cancel();
				exit.element.remove();
				this.exits.delete(key);
			}
			clear() {
				this.cancelMovements();
				for (const key of this.exits.keys()) this.removeExit(key);
			}
			render() {
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					ref: this.list,
					className: this.props.className,
					role: "tree",
					"aria-label": this.props.label,
					onPointerDownCapture: () => {
						this.armed = true;
					},
					onKeyDownCapture: () => {
						this.armed = true;
					},
					children: this.props.children
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					ref: this.overlay,
					className: AnimatedRows_module_css_default.exits,
					"aria-hidden": "true"
				})] });
			}
		};
		//#endregion
		//#region \0dsh-css:src/vendored/client/WorkspacePicker.module.css.mjs
		const css$2 = ".HMTNMq_modalAction{min-width:72px}.HMTNMq_modalError,.HMTNMq_menuStatus{margin-top:8px;font-size:12px;line-height:18px}.HMTNMq_modalError{color:var(--dsw-alias-state-error-primary)}.HMTNMq_menuStatus{color:var(--dsw-alias-label-secondary)}";
		const tagId$2 = "dsh-project-groups/WorkspacePicker.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-project-groups";
			tag.dataset.pluginCss = tagId$2;
			tag.textContent = css$2;
			document.head.appendChild(tag);
		}
		var WorkspacePicker_module_css_default = {
			"menuStatus": "HMTNMq_menuStatus",
			"modalAction": "HMTNMq_modalAction",
			"modalError": "HMTNMq_modalError"
		};
		//#endregion
		//#region src/vendored/client/WorkspacePicker.tsx
		const ADD_WORKSPACE = "::add-workspace";
		/**
		* Render the pick menu plus the adoption error dialog.
		* @param props - owner-controlled flow props.
		* @returns menu + dialog elements.
		*/
		function WorkspacePickFlow({ t, open, anchorRef, useWorkspaces, createWorkspace, useDirectoryFlow, renderDirectoryFlow, onPick, onClose, addOnly = false, onBusyChange, side = "bottom", selectedId }) {
			const workspaceSnapshot = useWorkspaces((state) => state);
			const workspaces = workspaceSnapshot.items;
			const getAnchorRect = (0, react.useCallback)(() => anchorRef?.current?.getBoundingClientRect() ?? null, [anchorRef]);
			const [errorOpen, setErrorOpen] = (0, react.useState)(false);
			const [modalError, setModalError] = (0, react.useState)(null);
			const [flowOpen, setFlowOpen] = (0, react.useState)(false);
			const [pickingFolder, setPickingFolder] = (0, react.useState)(false);
			const flowBusy = flowOpen || pickingFolder;
			(0, react.useEffect)(() => {
				onBusyChange?.(flowBusy);
			}, [flowBusy, onBusyChange]);
			const flowAvailable = useDirectoryFlow((occupied) => occupied);
			(0, react.useEffect)(() => {
				if (flowOpen && !flowAvailable) setFlowOpen(false);
			}, [flowOpen, flowAvailable]);
			const addEntries = flowAvailable ? [{
				id: ADD_WORKSPACE,
				label: t("menu.addWorkspace"),
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutlineRegular, { size: 16 }),
				disabled: flowBusy
			}] : [];
			const pinAdd = !addOnly && workspaces.length > 0;
			const items = pinAdd ? workspaces.map((workspace) => ({
				id: workspace.workspaceId,
				label: workspaceDisplayTitle(workspace.title, t("workspace.defaultName")),
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderCloseRegular, { size: 16 }),
				disabled: flowBusy
			})) : addEntries;
			const menuIsEmpty = items.length === 0;
			const closeModal = () => {
				setErrorOpen(false);
				setModalError(null);
			};
			/** Adopt a picked directory; failures land in the folder-error dialog (Choose again reopens the flow). */
			const adoptDirectory = (path) => createWorkspace({ path }).then((workspace) => {
				setFlowOpen(false);
				onPick(workspace.workspaceId);
			}).catch((reason) => {
				setModalError(reason instanceof Error ? reason.message : String(reason));
				setFlowOpen(false);
				setErrorOpen(true);
			});
			const openDirectoryFlow = (0, react.useCallback)(() => {
				onClose();
				setErrorOpen(false);
				setModalError(null);
				setFlowOpen(true);
			}, [onClose]);
			const listSettled = addOnly || workspaceSnapshot.phase === "ready";
			const addIsTheOnlyEntry = !pinAdd && listSettled && addEntries.length === 1;
			(0, react.useEffect)(() => {
				if (open && addIsTheOnlyEntry && !flowBusy) openDirectoryFlow();
			}, [
				open,
				addIsTheOnlyEntry,
				flowBusy,
				openDirectoryFlow
			]);
			/** Owner side of the flow conversation: adopt keeps the flow open (busy) until the Host answers. */
			const flowOwner = {
				open: flowOpen,
				busy: pickingFolder,
				onPicked: (path) => {
					setPickingFolder(true);
					adoptDirectory(path).finally(() => {
						setPickingFolder(false);
					});
				},
				onCancel: () => {
					setFlowOpen(false);
				},
				onError: (message) => {
					setFlowOpen(false);
					setModalError(message);
					setErrorOpen(true);
				}
			};
			const handleSelect = (id) => {
				if (id === ADD_WORKSPACE) {
					openDirectoryFlow();
					return;
				}
				onPick(id);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
					open: open && !addIsTheOnlyEntry && !menuIsEmpty,
					anchor: null,
					items,
					...pinAdd ? { footer: addEntries } : {},
					selectedId,
					onSelect: handleSelect,
					onClose,
					side,
					portal: true,
					getAnchorRect
				}),
				open && !addIsTheOnlyEntry && !menuIsEmpty && workspaceSnapshot.phase === "pending" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: WorkspacePicker_module_css_default.menuStatus,
					role: "status",
					children: t("picker.loading")
				}),
				renderDirectoryFlow(flowOwner),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
					open: errorOpen,
					onClose: closeModal,
					closeLabel: t("close"),
					title: t("folderError.title"),
					footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "outline",
						className: WorkspacePicker_module_css_default.modalAction,
						onClick: closeModal,
						children: t("cancel")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "primary",
						className: WorkspacePicker_module_css_default.modalAction,
						disabled: !flowAvailable,
						onClick: openDirectoryFlow,
						children: t("folderError.retry")
					})] }),
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: WorkspacePicker_module_css_default.modalError,
						role: "alert",
						children: modalError
					})
				})
			] });
		}
		/**
		* The conversation empty-state registration: adapts the owner share to the
		* core flow (all state and semantics live in the flow / the owner).
		* @param props - empty-state slot props (owner share + injected creation callback).
		* @returns the flow element.
		*/
		function WorkspacePicker({ open, anchorRef, useWorkspaces, selectedId, onPick, onClose, createWorkspace, useDirectoryFlow, renderSlot, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkspacePickFlow, {
				t,
				open,
				anchorRef,
				useWorkspaces,
				createWorkspace,
				useDirectoryFlow,
				renderDirectoryFlow: (owner) => renderSlot("conversation.hero.workspace.directoryFlow", owner),
				selectedId,
				onPick,
				onClose
			});
		}
		//#endregion
		//#region \0dsh-css:src/vendored/client/rows/WorkspaceBrowser.module.css.mjs
		const css$1 = ".Ommxsq_root{--dsh-session-list-edge-inset:var(--dsh-sidebar-inline-padding);--dsh-session-list-scrollbar-width:5px;--dsh-session-list-scrollbar-offset:2px;box-sizing:border-box;min-height:0;padding-right:var(--dsh-session-list-edge-inset);flex-direction:column;flex:1;display:flex}.Ommxsq_root.Ommxsq_rail{padding-right:0}.Ommxsq_iconButton{border-radius:var(--dsw-radius-sm);cursor:pointer;width:28px;height:28px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.Ommxsq_iconButton:focus-visible,.Ommxsq_searchButton:focus-visible,.Ommxsq_clearButton:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}.Ommxsq_iconButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.Ommxsq_viewOptionsMenu{min-width:200px}.Ommxsq_sectionHeader{box-sizing:border-box;border-radius:var(--dsw-radius-md);height:36px;color:var(--dsw-alias-label-tertiary);flex:none;justify-content:flex-end;align-items:center;gap:4px;margin-bottom:4px;padding-left:4px;display:flex;overflow:hidden}.Ommxsq_root:not(.Ommxsq_rail) .Ommxsq_sectionHeader{margin-top:2px;margin-right:-4px}.Ommxsq_sectionLabel{white-space:nowrap;opacity:1;visibility:visible;min-width:0;max-width:45%;transition:max-width .18s var(--ds-ease-in-out), margin-right .18s var(--ds-ease-in-out), opacity .12s var(--ds-ease-in-out), transform .18s var(--ds-ease-in-out), visibility 0s linear;flex:none;line-height:20px;overflow:hidden}.Ommxsq_sectionLabelHidden{opacity:0;visibility:hidden;max-width:0;margin-right:-4px;transition-delay:0s,0s,0s,0s,.18s;transform:translate(-4px)}.Ommxsq_searchSlot{box-sizing:border-box;min-width:0;max-width:28px;transition:max-width .18s var(--ds-ease-in-out), padding-left .18s var(--ds-ease-in-out);flex:1;align-items:center;margin-left:auto;padding-left:0;display:flex}.Ommxsq_searchSlotExpanded{max-width:100%;padding-left:0}.Ommxsq_headerActions{opacity:1;visibility:visible;max-width:60px;transition:max-width .18s var(--ds-ease-in-out), opacity .12s var(--ds-ease-in-out), transform .18s var(--ds-ease-in-out), visibility 0s linear;flex:none;align-items:center;gap:4px;display:flex;overflow:hidden}.Ommxsq_headerActionsHidden{opacity:0;visibility:hidden;pointer-events:none;max-width:0;transition-delay:0s,0s,0s,.18s;transform:translate(4px)}.Ommxsq_search{box-sizing:border-box;border-radius:var(--dsw-radius-sm);cursor:text;width:100%;height:28px;color:var(--dsw-alias-label-secondary);transition:width .18s var(--ds-ease-in-out), padding .18s var(--ds-ease-in-out), border-color .18s var(--ds-ease-in-out), background-color .18s var(--ds-ease-in-out);background:0 0;border:none;flex:none;align-items:center;gap:0;margin:0;padding:0;display:flex;overflow:hidden}.Ommxsq_searchExpanded{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);width:calc(100% + 4px);height:30px;color:var(--dsw-alias-label-caption);background:0 0;margin-inline:-2px;padding:0 4px 0 0}.Ommxsq_searchButton{border-radius:var(--dsw-radius-sm);cursor:pointer;width:28px;height:28px;color:inherit;background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.Ommxsq_searchExpanded .Ommxsq_searchButton{width:28px;height:30px}.Ommxsq_searchButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.Ommxsq_searchExpanded .Ommxsq_searchButton:hover{background:0 0}.Ommxsq_searchInput{opacity:0;pointer-events:none;width:0;min-width:0;color:var(--dsw-alias-label-primary);transition:opacity .12s var(--ds-ease-in-out);background:0 0;border:none;outline:none;flex:1;font-size:13px;line-height:18px}.Ommxsq_searchExpanded .Ommxsq_searchInput{opacity:1;pointer-events:auto;margin-left:-2px}.Ommxsq_searchInput::placeholder{color:var(--dsw-alias-label-tertiary)}.Ommxsq_clearButton{border-radius:var(--dsw-radius-sm);cursor:pointer;width:24px;height:24px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.Ommxsq_clearButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.Ommxsq_rail .Ommxsq_sectionHeader{justify-content:flex-start;gap:0;margin-bottom:12px;padding-left:0}.Ommxsq_rail .Ommxsq_headerActions{max-width:none}.Ommxsq_rail .Ommxsq_iconButton{border-radius:var(--dsw-radius-md);width:36px;height:36px;color:var(--dsw-alias-label-primary)}.Ommxsq_rail .Ommxsq_search{border-radius:var(--dsw-radius-md);background:0 0;border-color:#0000;gap:0;width:36px;height:36px;margin:0 0 12px;padding:0}.Ommxsq_rail .Ommxsq_searchButton{border-radius:var(--dsw-radius-md);width:36px;height:36px;color:var(--dsw-alias-label-primary)}.Ommxsq_rail .Ommxsq_searchButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.Ommxsq_listArea{min-height:0;margin-left:-4px;margin-right:calc(-1 * var(--dsh-session-list-edge-inset));flex-direction:column;flex:1;padding-left:4px;display:flex;overflow:visible}.Ommxsq_rail .Ommxsq_listArea{margin-left:0;margin-right:0;padding-left:0}.Ommxsq_treeBody{flex-direction:column;flex:1;min-height:0;display:flex;position:relative}.Ommxsq_fade{left:0;right:var(--dsh-session-list-edge-inset);background:linear-gradient(to bottom, transparent, var(--dsw-specific-sidebar-fill));pointer-events:none;height:24px;position:absolute;bottom:0}[data-platform=darwin] .Ommxsq_fade{display:none}.Ommxsq_wide{animation:Ommxsq_wide-in .2s var(--ds-ease-in-out)}@keyframes Ommxsq_wide-in{0%{opacity:0}}.Ommxsq_list{min-height:0;margin-left:-4px;margin-right:var(--dsh-session-list-scrollbar-offset);padding-left:4px;padding-right:calc(var(--dsh-session-list-edge-inset) - var(--dsh-session-list-scrollbar-width) - var(--dsh-session-list-scrollbar-offset));scrollbar-gutter:stable;flex:1;padding-bottom:16px;overflow-y:auto}.Ommxsq_flatList>*+*,.Ommxsq_searchTree>[role=treeitem]+[role=treeitem],.Ommxsq_groupSection>*+*{margin-top:2px}.Ommxsq_searchStatus{color:var(--dsw-alias-label-tertiary);padding:10px 12px;font-size:12px;line-height:18px}.Ommxsq_skeletonRow{box-sizing:border-box;align-items:flex-start;gap:8px;min-height:48px;padding:6px 8px 7px;display:flex}.Ommxsq_skeletonDot{corner-shape:round;border-radius:50%;flex:none;width:16px;height:16px}.Ommxsq_skeletonBars{flex-direction:column;flex:1;gap:6px;min-width:0;display:flex}.Ommxsq_skeletonDot,.Ommxsq_skeletonBar{background:var(--dsw-alias-bg-skeleton);animation:2s cubic-bezier(.36,0,.64,1) infinite Ommxsq_search-skeleton}.Ommxsq_skeletonBar{border-radius:var(--dsw-radius-xs);width:65%;height:16px}.Ommxsq_skeletonBarWide{width:90%;height:13px}@keyframes Ommxsq_search-skeleton{0%{opacity:1}40%{opacity:.6}80%,to{opacity:1}}.Ommxsq_groupSection{position:relative}.Ommxsq_groupSection+.Ommxsq_groupSection{margin-top:4px}.Ommxsq_listTopDropIndicator,.Ommxsq_workspaceDropBefore:before,.Ommxsq_workspaceDropAfter:after{content:\"\";z-index:1;background:linear-gradient(55deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 0 / 5px 7px no-repeat, linear-gradient(125deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 5px / 5px 7px no-repeat, linear-gradient(var(--dsw-alias-state-business-primary) 0 0) 4px 5px / calc(100% - 4px) 2px no-repeat;pointer-events:none;height:12px;position:absolute;left:0;right:0}.Ommxsq_listTopDropIndicator{top:-8px;left:0;right:var(--dsh-session-list-edge-inset)}.Ommxsq_listTopDropActive>.Ommxsq_workspaceDropBefore:first-child:before{display:none}.Ommxsq_workspaceDropBefore:before{top:-8px}.Ommxsq_workspaceDropAfter:after{bottom:-8px}.Ommxsq_groupDropTarget{border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-secondary)}.Ommxsq_sessionOverflowButton{border-radius:var(--dsw-radius-sm);width:100%;height:28px;padding:0 12px 0 calc(28px + var(--dsh-workspace-indent,0px));cursor:pointer;text-align:left;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;font-size:12px}.Ommxsq_groupSection>.Ommxsq_sessionOverflowButton{margin-top:0}.Ommxsq_sessionOverflowButton:hover{color:var(--dsw-alias-label-secondary);background:0 0}.Ommxsq_empty{color:var(--dsw-alias-label-tertiary);padding:16px 12px;font-size:13px}.Ommxsq_emptyState{color:var(--dsw-alias-label-tertiary);flex-direction:column;align-items:center;gap:8px;margin-top:80px;padding:0 12px;font-size:13px;line-height:20px;display:flex}.Ommxsq_emptyState>svg{color:var(--dsw-alias-label-caption);margin-bottom:4px}.Ommxsq_emptyAction{cursor:pointer;color:var(--dsw-alias-link);background:0 0;border:none;padding:0;font-size:13px;line-height:20px}.Ommxsq_renameInput{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);width:100%;height:44px;color:var(--dsw-alias-label-primary);background:0 0;outline:none;padding:7px 14px;font-size:14px;font-weight:400;line-height:22px}.Ommxsq_renameInput:disabled{color:var(--dsw-alias-label-dimmed)}.Ommxsq_renameError{color:var(--dsw-alias-state-error-primary);margin-top:8px;font-size:12px;line-height:18px}.Ommxsq_deleteAction:not(:disabled){color:var(--dsw-alias-state-error-primary)}.Ommxsq_deleteStatus{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.Ommxsq_baseMissingActions{flex-direction:column;gap:8px;width:100%;display:flex}.Ommxsq_baseMissingActions>button{width:100%}.Ommxsq_baseMissingBody{color:var(--dsw-alias-label-primary);margin:0;font-size:13px;line-height:20px}.Ommxsq_baseMissingPath{overflow-wrap:anywhere;color:var(--dsw-alias-label-tertiary);margin:8px 0 0;font-size:12px;line-height:18px}.Ommxsq_baseMissingConfirm{color:var(--dsw-alias-label-primary);align-items:flex-start;gap:10px;font-size:13px;line-height:20px;display:flex}.Ommxsq_baseMissingConfirmIcon{color:var(--dsw-alias-state-error-primary);flex:none;margin-top:2px}.Ommxsq_archiveActivity{color:var(--dsw-alias-label-primary);margin:0 0 8px;padding-left:18px;font-size:13px;line-height:20px}.Ommxsq_archiveActivity li{overflow-wrap:anywhere}@media (prefers-reduced-motion:reduce){.Ommxsq_wide,.Ommxsq_skeletonDot,.Ommxsq_skeletonBar{animation:none}.Ommxsq_search,.Ommxsq_sectionLabel,.Ommxsq_searchSlot,.Ommxsq_searchInput,.Ommxsq_headerActions{transition:none}}";
		const tagId$1 = "dsh-project-groups/WorkspaceBrowser.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-project-groups";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var WorkspaceBrowser_module_css_default = {
			"archiveActivity": "Ommxsq_archiveActivity",
			"baseMissingActions": "Ommxsq_baseMissingActions",
			"baseMissingBody": "Ommxsq_baseMissingBody",
			"baseMissingConfirm": "Ommxsq_baseMissingConfirm",
			"baseMissingConfirmIcon": "Ommxsq_baseMissingConfirmIcon",
			"baseMissingPath": "Ommxsq_baseMissingPath",
			"clearButton": "Ommxsq_clearButton",
			"deleteAction": "Ommxsq_deleteAction",
			"deleteStatus": "Ommxsq_deleteStatus",
			"empty": "Ommxsq_empty",
			"emptyAction": "Ommxsq_emptyAction",
			"emptyState": "Ommxsq_emptyState",
			"fade": "Ommxsq_fade",
			"flatList": "Ommxsq_flatList",
			"groupDropTarget": "Ommxsq_groupDropTarget",
			"groupSection": "Ommxsq_groupSection",
			"headerActions": "Ommxsq_headerActions",
			"headerActionsHidden": "Ommxsq_headerActionsHidden",
			"iconButton": "Ommxsq_iconButton",
			"list": "Ommxsq_list",
			"listArea": "Ommxsq_listArea",
			"listTopDropActive": "Ommxsq_listTopDropActive",
			"listTopDropIndicator": "Ommxsq_listTopDropIndicator",
			"rail": "Ommxsq_rail",
			"renameError": "Ommxsq_renameError",
			"renameInput": "Ommxsq_renameInput",
			"root": "Ommxsq_root",
			"search": "Ommxsq_search",
			"search-skeleton": "Ommxsq_search-skeleton",
			"searchButton": "Ommxsq_searchButton",
			"searchExpanded": "Ommxsq_searchExpanded",
			"searchInput": "Ommxsq_searchInput",
			"searchSlot": "Ommxsq_searchSlot",
			"searchSlotExpanded": "Ommxsq_searchSlotExpanded",
			"searchStatus": "Ommxsq_searchStatus",
			"searchTree": "Ommxsq_searchTree",
			"sectionHeader": "Ommxsq_sectionHeader",
			"sectionLabel": "Ommxsq_sectionLabel",
			"sectionLabelHidden": "Ommxsq_sectionLabelHidden",
			"sessionOverflowButton": "Ommxsq_sessionOverflowButton",
			"skeletonBar": "Ommxsq_skeletonBar",
			"skeletonBarWide": "Ommxsq_skeletonBarWide",
			"skeletonBars": "Ommxsq_skeletonBars",
			"skeletonDot": "Ommxsq_skeletonDot",
			"skeletonRow": "Ommxsq_skeletonRow",
			"treeBody": "Ommxsq_treeBody",
			"viewOptionsMenu": "Ommxsq_viewOptionsMenu",
			"wide": "Ommxsq_wide",
			"wide-in": "Ommxsq_wide-in",
			"workspaceDropAfter": "Ommxsq_workspaceDropAfter",
			"workspaceDropBefore": "Ommxsq_workspaceDropBefore"
		};
		//#endregion
		//#region src/vendored/client/rows/WorkspaceBrowser.tsx
		/**
		* The workspace/session browsing region filling the sidebar shell's
		* `sidebar.workspaces` hole: section header (title + view options + add
		* workspace), search, the grouped tree or flat list, and the workspace
		* dialogs. Wide state renders the full browser; rail state renders the two
		* region icons (search / add workspace) as 36px controls on the shell's shared
		* rail entry path, each requesting expansion through the owner share. Adding
		* is the header button's one action, so it raises the directory flow with no
		* menu in between; the flow and its error dialog live in WorkspacePicker
		* (same package — direct composition, no slot between them). A Session row's
		* "..." menu and hover buttons are the `sidebar.workspaces.session.menu.item`
		* and `sidebar.workspaces.session.row.action` lists rendered through this
		* entry's `renderSlot`; the actions in them, this package's own included,
		* are slot entries with their own behavior, so this component threads no
		* action callbacks and hosts no action surface.
		*/
		/**
		* Column slide length (--ds-transition-duration-slow): rail-search focus waits it out —
		* focus() forces a synchronous layout and would jank the slide.
		*/
		const EXPAND_SLIDE_MS = 300;
		/** Pause between the latest keystroke and a Host content-search request. */
		const SEARCH_DEBOUNCE_MS = 250;
		/** `session.search` wire bound, measured in JavaScript UTF-16 code units. */
		const SEARCH_QUERY_MAX_CODE_UNITS = 500;
		/** Idle Session rows visible per Workspace before the local overflow control. */
		const COLLAPSED_SESSION_LIMIT = 5;
		/** Keep provisional and running rows outside the idle-session quota, including parents with running children. */
		function collapsedSessionRows(sessions, limit = COLLAPSED_SESSION_LIMIT) {
			let idleCount = 0;
			const rows = sessions.filter((session) => {
				if (session.blank || session.running || session.runningSubagentCount > 0) return true;
				if (idleCount >= limit) return false;
				idleCount += 1;
				return true;
			});
			return {
				rows,
				hiddenCount: sessions.length - rows.length
			};
		}
		/** Keep controlled input and RPC payload inside the session.search wire contract. */
		function sanitizeSearchQuery(value) {
			const withoutNul = value.replaceAll("\0", "");
			if (withoutNul.length <= SEARCH_QUERY_MAX_CODE_UNITS) return withoutNul;
			let end = SEARCH_QUERY_MAX_CODE_UNITS;
			const last = withoutNul.charCodeAt(end - 1);
			const next = withoutNul.charCodeAt(end);
			if (last >= 55296 && last <= 56319 && next >= 56320 && next <= 57343) end--;
			return withoutNul.slice(0, end);
		}
		/**
		* Accept the native drag at document level while a row drag is active: row
		* hover still owns the insertion marker, and releasing outside the list must
		* not be rendered as a rejected drop before dragend commits that last marker.
		*/
		function useNativeDragAcceptance(active) {
			(0, react.useEffect)(() => {
				if (!active) return;
				const acceptDrag = (event) => {
					event.preventDefault();
					if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "move";
				};
				const acceptDrop = (event) => {
					event.preventDefault();
				};
				document.addEventListener("dragover", acceptDrag);
				document.addEventListener("drop", acceptDrop);
				return () => {
					document.removeEventListener("dragover", acceptDrag);
					document.removeEventListener("drop", acceptDrop);
				};
			}, [active]);
		}
		/** Grouping, ordering, and archived-filter menu; own open state so it resets with the wide chrome. */
		function ViewOptionsMenu({ groupBy, orderBy, archivedFilter, onGroupPick, onOrderPick, onArchivedFilterPick, t }) {
			const [open, setOpen] = (0, react.useState)(false);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
				open,
				onClose: () => {
					setOpen(false);
				},
				items: [
					{
						type: "label",
						id: "group-by",
						text: t("groupBy.label")
					},
					{
						id: "workspace",
						label: t("groupBy.workspace"),
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderCloseRegular, {})
					},
					{
						id: "workspace-tree",
						label: t("groupBy.workspaceTree"),
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWorkspaceTreeOutlineRegular, {})
					},
					{
						id: "flat",
						label: t("groupBy.flat"),
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFlatListOutlineRegular, {})
					},
					{
						type: "separator",
						id: "order-by-separator"
					},
					{
						type: "label",
						id: "order-by",
						text: t("orderBy.label")
					},
					{
						id: "manual",
						label: t("orderBy.manual"),
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronsUpDownOutlineRegular, {})
					},
					{
						id: "updated",
						label: t("orderBy.updated"),
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconClockOutlineRegular, {})
					},
					{
						type: "separator",
						id: "archived-filter-separator"
					},
					{
						type: "label",
						id: "filter-by",
						text: t("filterBy.label")
					},
					{
						id: "hide-archived",
						label: t("viewOptions.hideArchived"),
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOffOutlineRegular, {})
					},
					{
						id: "show-archived",
						label: t("viewOptions.showArchived"),
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconQueueOutlineRegular, {})
					},
					{
						id: "only-archived",
						label: t("viewOptions.onlyArchived"),
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveCheckOutlineRegular, {})
					}
				],
				selectedIds: [
					groupBy,
					orderBy,
					{
						default: "hide-archived",
						show: "show-archived",
						only: "only-archived"
					}[archivedFilter]
				],
				onSelect: (id) => {
					if (id === "workspace" || id === "workspace-tree" || id === "flat") onGroupPick(id);
					else if (id === "manual" || id === "updated") onOrderPick(id);
					else if (id === "hide-archived") onArchivedFilterPick("default");
					else if (id === "show-archived") onArchivedFilterPick("show");
					else if (id === "only-archived") onArchivedFilterPick("only");
					setOpen(false);
				},
				align: "end",
				dense: true,
				listClassName: WorkspaceBrowser_module_css_default.viewOptionsMenu,
				portal: true,
				anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
					label: t("viewOptions.label"),
					side: "bottom",
					delayMs: 500,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: clsx(WorkspaceBrowser_module_css_default.iconButton, WorkspaceBrowser_module_css_default.wide),
						"aria-label": t("viewOptions.label"),
						onClick: () => {
							setOpen((v) => !v);
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSlidersTwoOutlineRegular, {})
					})
				})
			});
		}
		/**
		* Insert one Session at a drop position in a group it does not belong to yet.
		*
		* Distinct from {@link sessionDragOrder}, which reorders within one account: that
		* function looks the dragged row up among the *target* group's rows and bails
		* when it is not there, which is exactly the cross-group case.
		* @param order - the target group's current order.
		* @param moving - the Session being dropped.
		* @param overId - the row the pointer released on.
		* @param half - which side of that row.
		* @returns the target order with `moving` inserted.
		*/
		function insertIntoTargetOrder(order, moving, overId, half) {
			const next = order.filter((id) => id !== moving);
			const index = next.indexOf(overId);
			if (index === -1) return [moving, ...next];
			next.splice(index + (half === "after" ? 1 : 0), 0, moving);
			return next;
		}
		/** Apply a visible drop to the complete account without removing hidden members. */
		function sessionDragOrder(order, rows, drag, over) {
			const source = rows.find((row) => row.id === drag.sessionId);
			const target = rows.find((row) => row.id === over.id);
			if (source === void 0 || target === void 0 || source.blank || source.pinned !== drag.pinned || target.pinned !== drag.pinned || source.id === target.id || !order.includes(source.id)) return;
			const section = rows.filter((row) => row.pinned === drag.pinned);
			const sourceIndex = section.findIndex((row) => row.id === source.id);
			if (section.filter((row) => row.id !== source.id).findIndex((row) => row.id === target.id) + (over.half === "after" ? 1 : 0) === sourceIndex) return;
			const next = order.filter((id) => id !== source.id);
			const targetIndex = next.indexOf(target.id);
			if (targetIndex === -1) return;
			next.splice(targetIndex + (over.half === "after" ? 1 : 0), 0, source.id);
			return pinCurrentBlank(next, rows.find((row) => row.blank)?.id);
		}
		/** Resolve an insertion side across the Workspace header, descendants, and Sessions. */
		function workspaceGroupHalf(e) {
			const rect = e.currentTarget.getBoundingClientRect();
			return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
		}
		/** The list-empty placeholder — a glyph over the text; the archived-only view names its filter and offers the way back. */
		function EmptySessions({ rowState, onLeaveArchivedOnly, t }) {
			const archivedOnly = rowState.archivedFilter === "only";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: WorkspaceBrowser_module_css_default.emptyState,
				"data-row-key": "empty",
				children: [
					archivedOnly ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutlineRegular, { size: 24 }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconQueueOutlineRegular, { size: 24 }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: archivedOnly ? t("empty.noneArchived") : t("empty.none") }),
					archivedOnly && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: WorkspaceBrowser_module_css_default.emptyAction,
						onClick: onLeaveArchivedOnly,
						children: t("empty.viewOthers")
					})
				]
			});
		}
		/** The scrolling session tree; unmounting drops the sessions subscription and local row limits. */
		function SessionTree({ list, useSessionStatus, startSession, open, workspaces, groupingOverride, ungroupedSessionIds, rowState, onLeaveArchivedOnly, workspaceReady, animationResetKey, usePanelInfo, onRenameRequest, onDeleteRequest, onSessionRenameRequest, reorderProject, assignSession, unassignSession, orderBy, renderSlot, insertWorkspaceBefore, nestWorkspaces, groupExpansion, setGroupExpanded, projectExpansion, setProjectExpanded, setSessionOrder, home, t, revealSessionId, onSessionRevealed, shortcuts }) {
			const panelActive = usePanelInfo((info) => info.activePanelId !== null);
			const statuses = useSessionStatus((s) => s);
			const current = panelActive ? void 0 : Object.values(list.byId).find((session) => (session.retainedBy.mainView ?? 0) > 0)?.id;
			const revealGroup = revealSessionId === void 0 || !workspaceReady ? void 0 : groupingOverride === void 0 ? owningGroupKey(workspaces, revealSessionId) : owningSourceKey(groupingOverride, revealSessionId);
			const [sessionLimits, setSessionLimits] = (0, react.useState)({});
			const [drag, setDrag] = (0, react.useState)(null);
			const sessionDropCommitted = (0, react.useRef)(false);
			const dragRef = (0, react.useRef)(null);
			dragRef.current = drag;
			const [workspaceDrag, setWorkspaceDrag] = (0, react.useState)(null);
			const workspaceDragRef = (0, react.useRef)(null);
			workspaceDragRef.current = workspaceDrag;
			const workspaceDropCommitted = (0, react.useRef)(false);
			const nativeDragActive = drag !== null || workspaceDrag !== null;
			useNativeDragAcceptance(nativeDragActive);
			const currentGroup = current === void 0 || !workspaceReady ? void 0 : groupingOverride === void 0 ? owningGroupKey(workspaces, current) : owningSourceKey(groupingOverride, current);
			const projectKeys = (0, react.useMemo)(() => new Set(groupingOverride?.map((group) => group.key) ?? []), [groupingOverride]);
			const isCallerOwned = (0, react.useCallback)((key) => setProjectExpanded !== void 0 && projectKeys.has(key), [setProjectExpanded, projectKeys]);
			/**
			* Whether a group can take a Session dragged out of another group.
			*
			* A caller-supplied project is a real destination only when both verbs exist;
			* the Ungrouped bucket needs the unassign verb and is this browser's own
			* account, so it needs no project model. Without the verbs a cross-group drag
			* never activates, and the region behaves exactly as upstream.
			*/
			const canReceiveDrag = (0, react.useCallback)((key) => key === "" ? unassignSession !== void 0 : isCallerOwned(key) && assignSession !== void 0, [
				assignSession,
				isCallerOwned,
				unassignSession
			]);
			/** Whether a key has ever been recorded, by whichever owner applies. */
			const hasExpansion = (0, react.useCallback)((key) => isCallerOwned(key) ? Object.hasOwn(projectExpansion ?? {}, key) : Object.hasOwn(groupExpansion, key), [
				isCallerOwned,
				projectExpansion,
				groupExpansion
			]);
			/** Record one key's expansion with its owner. */
			const recordExpansion = (0, react.useCallback)((key, expanded) => {
				if (!isCallerOwned(key)) {
					setGroupExpanded(key, expanded);
					return;
				}
				setProjectExpanded?.(key, expanded).catch(() => {});
			}, [
				isCallerOwned,
				setGroupExpanded,
				setProjectExpanded
			]);
			(0, react.useEffect)(() => {
				if (current === void 0 || currentGroup === void 0 || hasExpansion(currentGroup)) return;
				recordExpansion(currentGroup, true);
			}, [
				current,
				currentGroup,
				hasExpansion,
				recordExpansion
			]);
			const parents = (0, react.useMemo)(() => {
				if (!nestWorkspaces) return /* @__PURE__ */ new Map();
				const keysByPath = new Map(workspaces.map((workspace) => [workspace.path, workspace.workspaceId]));
				const paths = [...keysByPath.keys()];
				return new Map(workspaces.map((workspace) => {
					const path = owningParentFolder(workspace.path, paths);
					return [workspace.workspaceId, path === void 0 ? void 0 : keysByPath.get(path)];
				}));
			}, [nestWorkspaces, workspaces]);
			const currentAncestors = (0, react.useMemo)(() => {
				const keys = /* @__PURE__ */ new Set();
				for (let key = currentGroup === void 0 ? void 0 : parents.get(currentGroup); key !== void 0; key = parents.get(key)) keys.add(key);
				return keys;
			}, [currentGroup, parents]);
			const expandedGroups = (0, react.useMemo)(() => {
				const ancestorKeys = new Set(parents.values());
				const keys = groupingOverride === void 0 ? workspaces.map((workspace) => workspace.workspaceId) : groupingOverride.map((group) => group.key);
				const expansion = {
					...groupExpansion,
					...projectExpansion
				};
				return [...keys, ""].filter((key) => expansion[key] ?? ancestorKeys.has(key));
			}, [
				groupExpansion,
				projectExpansion,
				parents,
				workspaces,
				groupingOverride
			]);
			const groups = (0, react.useMemo)(() => deriveGroups(list, workspaces, rowState, statuses, {
				expandedGroups,
				ungroupedOrder: ungroupedSessionIds
			}, groupingOverride), [
				list,
				workspaces,
				rowState,
				statuses,
				expandedGroups,
				ungroupedSessionIds,
				groupingOverride
			]);
			(0, react.useEffect)(() => {
				for (let key = revealGroup; key !== void 0; key = parents.get(key)) {
					const recorded = isCallerOwned(key) ? projectExpansion?.[key] : groupExpansion[key];
					if (recorded === false || key === revealGroup && recorded !== true) recordExpansion(key, true);
				}
			}, [
				groupExpansion,
				projectExpansion,
				parents,
				revealGroup,
				isCallerOwned,
				recordExpansion
			]);
			(0, react.useEffect)(() => {
				if (revealSessionId === void 0 || revealGroup === void 0) return;
				const group = groups.find((candidate) => candidate.key === revealGroup);
				if (group === void 0 || !group.expanded || !group.sessions.some((row) => row.id === revealSessionId)) return;
				if (collapsedSessionRows(group.sessions).rows.some((row) => row.id === revealSessionId)) return;
				setSessionLimits((limits) => limits[revealGroup] === Infinity ? limits : {
					...limits,
					[revealGroup]: Infinity
				});
			}, [
				groups,
				revealGroup,
				revealSessionId
			]);
			const now = Date.now();
			/**
			* Commit a Session drop.
			* @param activeDrag - the drag being committed.
			* @param over - the row under the pointer, or null when the drop landed on a
			* group itself (its header or empty body) rather than on a row.
			* @param targetKey - the group the pointer released on. Passed explicitly
			* rather than read from `activeDrag.overGroupKey`, because a handler's closed
			* state can predate the last `dragOver`.
			*/
			const commitSessionDrag = (activeDrag, over, targetKey = activeDrag.overGroupKey ?? activeDrag.accountKey) => {
				if (sessionDropCommitted.current) return;
				sessionDropCommitted.current = true;
				setDrag(null);
				if (over !== null && over.id === activeDrag.sessionId) return;
				if (targetKey !== activeDrag.accountKey) {
					commitCrossGroupDrag(activeDrag, targetKey, over);
					return;
				}
				const group = groups.find((candidate) => candidate.key === activeDrag.accountKey);
				if (group === void 0 || over === null) return;
				const accountSessionIds = activeDrag.accountKey === "" ? ungroupedSessionIds : workspaces.find((workspace) => workspace.workspaceId === activeDrag.accountKey)?.sessionIds ?? groupingOverride?.find((source) => source.key === activeDrag.accountKey)?.sessionIds;
				if (accountSessionIds === void 0) return;
				const renderedSessions = collapsedSessionRows(group.sessions, sessionLimits[group.key]).rows;
				const nextOrder = sessionDragOrder(accountSessionIds, renderedSessions, activeDrag, over);
				if (nextOrder !== void 0) setSessionOrder(activeDrag.accountKey, nextOrder);
			};
			/**
			* Move one Session into another group, and place it.
			*
			* Two paths, distinguished by whether the pointer released on a row:
			*
			*  - **on a row** — a positional drop. The Session is filed, inserted at that
			*    position, and the view switches to manual ordering, which is upstream's
			*    rule for any sort gesture.
			*  - **on the group itself** (its header or its empty body) — a drop *into* the
			*    group. Under recency nothing is stored: the member has no saved position,
			*    so `reconcileManualOrder` derives one from `updatedAt`, which is what
			*    recency means. Under manual it goes to the front, the one position a
			*    header drop can name.
			*
			* @param activeDrag - the drag being committed.
			* @param targetKey - the group the pointer is over; never the source group.
			* @param over - the row under the pointer, or null for a drop on the group.
			*/
			const commitCrossGroupDrag = (activeDrag, targetKey, over) => {
				const target = groups.find((candidate) => candidate.key === targetKey);
				if (target === void 0) return;
				const moving = activeDrag.sessionId;
				const targetOrder = collapsedSessionRows(target.sessions, sessionLimits[targetKey]).rows.map((row) => row.id);
				const positional = over !== null;
				const move = targetKey === "" ? unassignSession?.(moving) : assignSession?.(moving, targetKey);
				if (move === void 0) return;
				move.catch((reason) => {
					console.warn("session move rejected:", reason);
				});
				if (!positional && orderBy === "updated") {
					recordExpansion(targetKey, true);
					return;
				}
				setSessionOrder(targetKey, positional ? insertIntoTargetOrder(targetOrder, moving, over.id, over.half) : [moving, ...targetOrder.filter((id) => id !== moving)]);
				recordExpansion(targetKey, true);
			};
			const commitWorkspaceDrag = (activeDrag, over) => {
				if (workspaceDropCommitted.current) return;
				workspaceDropCommitted.current = true;
				setWorkspaceDrag(null);
				if (activeDrag.kind === "project") {
					if (over.id === activeDrag.rowId) return;
					(reorderProject === void 0 ? Promise.reject(/* @__PURE__ */ new Error("no project model")) : reorderProject(activeDrag.rowId, over.half === "before" ? over.id : void 0)).catch((reason) => {
						console.warn("project reorder rejected:", reason);
					});
					return;
				}
				const workspaceId = activeDrag.rowId;
				const owner = parents.get(workspaceId);
				const siblings = workspaces.filter((workspace) => parents.get(workspace.workspaceId) === owner);
				const rowIndex = siblings.findIndex((workspace) => workspace.workspaceId === over.id);
				if (rowIndex === -1) return;
				const anchor = over.half === "before" ? over.id : siblings[rowIndex + 1]?.workspaceId;
				if (anchor === workspaceId) return;
				const sourceIndex = siblings.findIndex((workspace) => workspace.workspaceId === workspaceId);
				const anchorIndex = anchor === void 0 ? siblings.length : siblings.findIndex((workspace) => workspace.workspaceId === anchor);
				if (sourceIndex !== -1 && (anchorIndex === sourceIndex || anchorIndex === sourceIndex + 1)) return;
				insertWorkspaceBefore(workspaceId, anchor).catch((reason) => {
					console.warn("workspace reorder rejected:", reason);
				});
			};
			const childrenByParent = (0, react.useMemo)(() => {
				const rendered = new Set(groups.map((group) => group.key));
				const children = /* @__PURE__ */ new Map();
				for (const group of groups) {
					let parent = parents.get(group.key);
					while (parent !== void 0 && !rendered.has(parent)) parent = parents.get(parent);
					const siblings = children.get(parent);
					if (siblings === void 0) children.set(parent, [group]);
					else siblings.push(group);
				}
				return children;
			}, [groups, parents]);
			const rootGroups = childrenByParent.get(void 0) ?? [];
			const workspaceDropAtListStart = rootGroups[0]?.workspaceId !== void 0 && workspaceDrag?.over?.id === rootGroups[0].workspaceId && workspaceDrag.over.half === "before";
			const rowKeys = groups.length === 0 ? ["empty"] : [];
			const renderGroup = (group, depth) => {
				const workspaceId = group.workspaceId;
				const children = childrenByParent.get(group.key) ?? [];
				const dragKind = group.kind === "project" ? "project" : workspaceId === void 0 ? void 0 : "workspace";
				const dragRowId = group.kind === "project" ? group.key : workspaceId;
				const compatibleDrag = workspaceDrag !== null && dragKind !== void 0 && workspaceDrag.kind === dragKind && (dragKind === "project" || parents.get(workspaceDrag.rowId) === parents.get(group.key));
				const collapsed = collapsedSessionRows(group.sessions);
				const visible = collapsedSessionRows(group.sessions, sessionLimits[group.key]);
				const sessionsExpanded = visible.hiddenCount === 0;
				rowKeys.push(`workspace:${group.key}`);
				const childRows = group.expanded ? children.map((child) => renderGroup(child, depth + 1)) : [];
				const sessions = visible.rows;
				for (const node of sessions) rowKeys.push(sessionRowKey(node.id, group.key));
				if (collapsed.hiddenCount > 0) rowKeys.push(`overflow:${group.key}`);
				const activeDrag = workspaceDrag;
				const markerOver = dragRowId !== void 0 && activeDrag !== null && activeDrag.kind === dragKind && activeDrag.over?.id === dragRowId ? activeDrag.over : null;
				const workspaceMarker = markerOver === null ? null : markerOver.half;
				const workspaceDragProps = dragKind === void 0 || dragRowId === void 0 ? void 0 : {
					start: () => {
						workspaceDropCommitted.current = false;
						setWorkspaceDrag({
							kind: dragKind,
							rowId: dragRowId,
							over: null
						});
					},
					end: () => {
						const active = workspaceDragRef.current;
						if (active?.over !== null && active?.over !== void 0) commitWorkspaceDrag(active, active.over);
						else setWorkspaceDrag(null);
						workspaceDropCommitted.current = false;
					}
				};
				const hoverWorkspace = dragRowId === void 0 || !compatibleDrag ? void 0 : (half) => {
					setWorkspaceDrag((active) => active === null ? active : {
						...active,
						over: {
							id: dragRowId,
							half
						}
					});
				};
				const dropWorkspace = dragRowId === void 0 || !compatibleDrag ? void 0 : (half) => {
					const active = workspaceDragRef.current;
					if (active === null) return;
					commitWorkspaceDrag(active, {
						id: dragRowId,
						half
					});
				};
				const groupDropTarget = drag !== null && drag.accountKey !== group.key && canReceiveDrag(group.key);
				const groupDropActive = groupDropTarget && drag.overGroupKey === group.key && drag.over === null;
				const groupDrop = groupDropTarget ? {
					enter: () => {
						setDrag((d) => d === null || d.overGroupKey === group.key && d.over === null ? d : {
							...d,
							over: null,
							overGroupKey: group.key
						});
					},
					leave: () => {
						setDrag((d) => d === null || d.overGroupKey !== group.key ? d : {
							...d,
							overGroupKey: void 0
						});
					},
					drop: () => {
						const active = dragRef.current;
						if (active !== null) commitSessionDrag(active, null, group.key);
					}
				} : void 0;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: { "--dsh-workspace-indent": `${depth * 12}px` },
					className: clsx(WorkspaceBrowser_module_css_default.groupSection, workspaceMarker === "before" && WorkspaceBrowser_module_css_default.workspaceDropBefore, workspaceMarker === "after" && WorkspaceBrowser_module_css_default.workspaceDropAfter, groupDropActive && WorkspaceBrowser_module_css_default.groupDropTarget),
					onDragOver: workspaceDrag === null ? void 0 : (e) => {
						e.preventDefault();
						if (hoverWorkspace === void 0 && parents.get(group.key) !== void 0) return;
						e.stopPropagation();
						if (hoverWorkspace === void 0) {
							e.dataTransfer.dropEffect = "none";
							if (workspaceDrag.over !== null) setWorkspaceDrag({
								...workspaceDrag,
								over: null
							});
						} else {
							e.dataTransfer.dropEffect = "move";
							hoverWorkspace(workspaceGroupHalf(e));
						}
					},
					onDrop: workspaceDrag === null ? void 0 : (e) => {
						e.preventDefault();
						if (dropWorkspace === void 0 && parents.get(group.key) !== void 0) return;
						e.stopPropagation();
						if (dropWorkspace === void 0) {
							workspaceDropCommitted.current = true;
							setWorkspaceDrag(null);
						} else dropWorkspace(workspaceGroupHalf(e));
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProjectRowItem, {
							newShortcut: shortcuts.find((row) => row.id === "session.new"),
							group,
							containsCurrentDescendant: currentAncestors.has(group.key),
							home,
							t,
							onToggle: () => {
								if (group.expanded) setSessionLimits((limits) => ({
									...limits,
									[group.key]: COLLAPSED_SESSION_LIMIT
								}));
								recordExpansion(group.key, !group.expanded);
							},
							onCreate: () => {
								recordExpansion(group.key, true);
								const isProject = group.kind === "project";
								const isUngrouped = group.key === "";
								const file = isProject && assignSession !== void 0 ? (sessionId) => assignSession(sessionId, group.key) : isUngrouped && unassignSession !== void 0 ? (sessionId) => unassignSession(sessionId) : void 0;
								startSession(group.workspaceId, file === void 0 ? void 0 : (sessionId) => {
									file(sessionId).catch((reason) => {
										console.warn("file session rejected:", reason);
									});
								});
							},
							drag: workspaceDragProps,
							groupDrop,
							actions: group.kind === "project" ? {
								rename: () => {
									onRenameRequest({
										kind: "project",
										id: group.key,
										title: group.label
									});
								},
								delete: () => {
									onDeleteRequest({
										kind: "project",
										id: group.key,
										title: group.label
									});
								}
							} : group.workspaceId === void 0 ? void 0 : {
								rename: () => {
									/* v8 ignore next -- narrowing guard: the actions object exists only for real-workspace groups. */
									if (group.workspaceId !== void 0) onRenameRequest({
										kind: "workspace",
										id: group.workspaceId,
										title: group.label
									});
								},
								delete: () => {
									/* v8 ignore next -- narrowing guard: the actions object exists only for real-workspace groups. */
									if (group.workspaceId !== void 0) onDeleteRequest({
										kind: "workspace",
										id: group.workspaceId,
										title: group.label
									});
								}
							}
						}),
						childRows.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							role: "group",
							children: childRows
						}),
						sessions.map((node) => {
							const sameGroupDrag = drag !== null && drag.accountKey === group.key;
							const crossGroupDrag = drag !== null && drag.accountKey !== group.key && canReceiveDrag(group.key);
							const compatibleTarget = (sameGroupDrag || crossGroupDrag) && drag.pinned === node.pinned;
							const normalizeHalf = (half) => node.blank ? "after" : half;
							const dragProps = {
								start: () => {
									sessionDropCommitted.current = false;
									setDrag({
										accountKey: group.key,
										sessionId: node.id,
										pinned: node.pinned,
										over: null
									});
								},
								active: compatibleTarget,
								marker: compatibleTarget && drag.over?.id === node.id ? drag.over.half : null,
								hover: (half) => {
									/* v8 ignore next -- narrowing guard: Rows gates hover on `active`, which is false while the drag state is null. */
									setDrag((d) => d === null ? d : {
										...d,
										over: {
											id: node.id,
											half: normalizeHalf(half)
										},
										overGroupKey: group.key === d.accountKey ? void 0 : group.key
									});
								},
								drop: (half) => {
									/* v8 ignore next -- narrowing guard: Rows gates drop on `active`, which is false while the drag state is null. */
									if (drag === null) return;
									commitSessionDrag(drag, {
										id: node.id,
										half: normalizeHalf(half)
									}, group.key);
								},
								end: () => {
									if (drag === null) setDrag(null);
									else if (drag.over !== null && drag.over !== void 0) commitSessionDrag(drag, drag.over, drag.overGroupKey ?? drag.accountKey);
									else if (drag.overGroupKey !== void 0) commitSessionDrag(drag, null, drag.overGroupKey);
									else setDrag(null);
									sessionDropCommitted.current = false;
								}
							};
							return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SessionNodeItem, {
								node,
								rowKey: sessionRowKey(node.id, group.key),
								currentId: current,
								now,
								onOpen: open,
								onRenameRequest: onSessionRenameRequest,
								renderSlot,
								onReveal: node.id === revealSessionId && group.key === revealGroup ? () => {
									onSessionRevealed(node.id);
								} : void 0,
								drag: dragProps,
								t
							}, node.id);
						}),
						collapsed.hiddenCount > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: WorkspaceBrowser_module_css_default.sessionOverflowButton,
							"data-row-key": `overflow:${group.key}`,
							"aria-expanded": sessionsExpanded,
							onClick: () => {
								setSessionLimits((limits) => ({
									...limits,
									[group.key]: sessionsExpanded ? COLLAPSED_SESSION_LIMIT : visible.hiddenCount <= COLLAPSED_SESSION_LIMIT ? Infinity : (limits[group.key] ?? COLLAPSED_SESSION_LIMIT) + COLLAPSED_SESSION_LIMIT
								}));
							},
							children: sessionsExpanded ? t("sessions.collapse") : t("sessions.expand", { n: visible.hiddenCount })
						})
					]
				}, group.key);
			};
			const groupRows = rootGroups.map((group) => renderGroup(group, 0));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: clsx(WorkspaceBrowser_module_css_default.treeBody, WorkspaceBrowser_module_css_default.wide),
				children: [
					workspaceDropAtListStart && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: WorkspaceBrowser_module_css_default.listTopDropIndicator,
						"aria-hidden": "true"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(AnimatedRows, {
						className: clsx(WorkspaceBrowser_module_css_default.list, workspaceDropAtListStart && WorkspaceBrowser_module_css_default.listTopDropActive),
						label: t("section.sessions"),
						rowKeys,
						ready: list.phase === "ready" && workspaceReady && !nativeDragActive,
						resetKey: JSON.stringify([animationResetKey, sessionLimits]),
						children: [groups.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptySessions, {
							rowState,
							onLeaveArchivedOnly,
							t
						}), groupRows]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: WorkspaceBrowser_module_css_default.fade })
				]
			});
		}
		/** The flat "In one list" body: every session is one draggable top-level row. */
		function FlatList({ list, sessionIds, rowState, onLeaveArchivedOnly, useSessionStatus, open, onSessionRenameRequest, usePanelInfo, setSessionOrder, workspaceReady, animationResetKey, revealSessionId, onSessionRevealed, renderSlot, t }) {
			const panelActive = usePanelInfo((info) => info.activePanelId !== null);
			const statuses = useSessionStatus((s) => s);
			const rows = (0, react.useMemo)(() => deriveFlat(list, sessionIds, rowState, statuses), [
				list,
				sessionIds,
				rowState,
				statuses
			]);
			const [drag, setDrag] = (0, react.useState)(null);
			const dropCommitted = (0, react.useRef)(false);
			useNativeDragAcceptance(drag !== null);
			const currentId = panelActive ? void 0 : Object.values(list.byId).find((session) => (session.retainedBy.mainView ?? 0) > 0)?.id;
			const commitDrag = (activeDrag, over) => {
				if (dropCommitted.current) return;
				dropCommitted.current = true;
				setDrag(null);
				const nextOrder = sessionDragOrder(sessionIds, rows, activeDrag, over);
				if (nextOrder !== void 0) setSessionOrder(FLAT_SESSION_ORDER_KEY, nextOrder);
			};
			const now = Date.now();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: clsx(WorkspaceBrowser_module_css_default.treeBody, WorkspaceBrowser_module_css_default.wide),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(AnimatedRows, {
					className: clsx(WorkspaceBrowser_module_css_default.list, WorkspaceBrowser_module_css_default.flatList),
					label: t("section.sessions"),
					rowKeys: rows.length === 0 ? ["empty"] : rows.map((row) => `session:${row.id}`),
					ready: list.phase === "ready" && workspaceReady && drag === null,
					resetKey: animationResetKey,
					children: [rows.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptySessions, {
						rowState,
						onLeaveArchivedOnly,
						t
					}), rows.map((node) => {
						const active = drag !== null && drag.pinned === node.pinned;
						const normalizeHalf = (half) => node.blank ? "after" : half;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SessionNodeItem, {
							node,
							currentId,
							now,
							onOpen: open,
							onRenameRequest: onSessionRenameRequest,
							renderSlot,
							onReveal: node.id === revealSessionId ? () => {
								onSessionRevealed(node.id);
							} : void 0,
							drag: {
								start: () => {
									dropCommitted.current = false;
									setDrag({
										accountKey: FLAT_SESSION_ORDER_KEY,
										sessionId: node.id,
										pinned: node.pinned,
										over: null
									});
								},
								active,
								marker: active && drag.over?.id === node.id ? drag.over.half : null,
								hover: (half) => {
									setDrag((current) => current === null ? current : {
										...current,
										over: {
											id: node.id,
											half: normalizeHalf(half)
										}
									});
								},
								drop: (half) => {
									if (drag !== null) commitDrag(drag, {
										id: node.id,
										half: normalizeHalf(half)
									});
								},
								end: () => {
									if (drag?.over !== null && drag?.over !== void 0) commitDrag(drag, drag.over);
									else setDrag(null);
									dropCommitted.current = false;
								}
							},
							t
						}, node.id);
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: WorkspaceBrowser_module_css_default.fade })]
			});
		}
		/** Flat search body: local metadata matches plus the current Host result page. */
		function SearchResults({ useSessions, useSessionStatus, open, onUnarchive, workspaces, archivedSessionIds, archivedFilter, query, remote, resultLimit, usePanelInfo, t }) {
			const panelActive = usePanelInfo((info) => info.activePanelId !== null);
			const list = useSessions((s) => s);
			const statuses = useSessionStatus((s) => s);
			const currentRemote = remote.query === query ? remote : {
				query,
				status: "loading",
				items: [],
				hasMore: false
			};
			const results = (0, react.useMemo)(() => deriveSearchResults(list, workspaces, query, archivedSessionIds, archivedFilter, statuses, currentRemote, resultLimit), [
				list,
				workspaces,
				query,
				archivedSessionIds,
				archivedFilter,
				statuses,
				currentRemote,
				resultLimit
			]);
			const pending = currentRemote.status === "loading";
			const currentId = panelActive ? void 0 : Object.values(list.byId).find((session) => (session.retainedBy.mainView ?? 0) > 0)?.id;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: clsx(WorkspaceBrowser_module_css_default.treeBody, WorkspaceBrowser_module_css_default.wide),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: WorkspaceBrowser_module_css_default.list,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: WorkspaceBrowser_module_css_default.searchTree,
							role: "tree",
							"aria-label": t("search.results.aria"),
							children: results.items.map((result) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SearchResultItem, {
								result,
								currentId,
								onOpen: open,
								onUnarchive,
								t
							}, result.id))
						}),
						pending && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							role: "status",
							"aria-label": t("search.pending"),
							children: (results.items.length === 0 ? [0, 1] : [0]).map((i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: WorkspaceBrowser_module_css_default.skeletonRow,
								"aria-hidden": "true",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: WorkspaceBrowser_module_css_default.skeletonDot }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: WorkspaceBrowser_module_css_default.skeletonBars,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: WorkspaceBrowser_module_css_default.skeletonBar }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: clsx(WorkspaceBrowser_module_css_default.skeletonBar, WorkspaceBrowser_module_css_default.skeletonBarWide) })]
								})]
							}, i))
						}),
						!pending && results.items.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: WorkspaceBrowser_module_css_default.empty,
							children: t("search.noMatches")
						}),
						results.hasMore && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: WorkspaceBrowser_module_css_default.searchStatus,
							children: t("search.hasMore", { n: resultLimit })
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: WorkspaceBrowser_module_css_default.fade })]
			});
		}
		/**
		* Render the browsing region.
		* @param props - composed slot props (shell owner share + store + injected actions).
		* @returns the region element tree.
		*/
		function WorkspaceBrowser({ wide, usePanelInfo, expandSidebar, useSessions, useSessionStatus, useWorkspaces, useGrouping, useStore, actions, startSession, open, requestSessionRename, notifyArchivedNotOpenable, renameWorkspace, deleteWorkspace, insertWorkspaceBefore, unarchiveSession, createWorkspace, searchSessions, searchResultLimit, useDirectoryFlow, useHostInfo, useShortcuts, useWorkspaceShortcuts, requestSearch, requestAddWorkspace, closeAddWorkspace, setDirectoryBusy, dismissForkError, createProject, renameProject, deleteProject, reorderProject, assignSession, unassignSession, setProjectExpanded, setProjectOrders, useExpansions, useOrders, renderSlot, t }) {
			const home = useHostInfo((info) => info.home);
			const shortcuts = useShortcuts((rows) => rows);
			const searchShortcut = shortcuts.find((row) => row.id === "session.search");
			const addShortcut = shortcuts.find((row) => row.id === "workspace.add");
			const projectModelAvailable = createProject !== void 0;
			const shortcutState = useWorkspaceShortcuts((state) => state);
			const list = useSessions((state) => state);
			const storedWorkspaces = useWorkspaces((state) => state.items);
			const groupingOverride = useGrouping((groups) => groups);
			const projectExpansion = useExpansions((expansion) => expansion);
			const projectOrders = useOrders((orders) => orders);
			const defaultWorkspaceName = t("workspace.defaultName");
			const workspaces = (0, react.useMemo)(() => storedWorkspaces.map((workspace) => ({
				...workspace,
				title: workspaceDisplayTitle(workspace.title, defaultWorkspaceName)
			})), [storedWorkspaces, defaultWorkspaceName]);
			const workspacePhase = useWorkspaces((state) => state.phase);
			const workspaceStreamState = useWorkspaces((state) => state.state);
			const archivedSessionIds = useWorkspaces((state) => state.archivedSessionIds);
			const pinnedSessionIds = useWorkspaces((state) => state.pinnedSessionIds);
			const directoryFlowAvailable = useDirectoryFlow((occupied) => occupied);
			const groupBy = useStore((s) => s.groupBy);
			const orderBy = useStore((s) => s.orderBy);
			const archivedFilter = useStore((s) => s.archivedFilter ?? "default");
			const groupExpansion = useStore((s) => s.groupExpansion);
			const sessionOrderByAccount = useStore((s) => s.sessionOrderByAccount);
			const guardedOpen = (sessionId) => {
				if (archivedSessionIds.includes(sessionId)) {
					notifyArchivedNotOpenable();
					return;
				}
				open(sessionId);
			};
			const leaveArchivedOnly = () => {
				actions.setArchivedFilter("default");
			};
			const workspaceReady = workspacePhase === "ready" && workspaceStreamState !== "loading";
			const mainSessionId = Object.values(list.byId).find((session) => (session.retainedBy.mainView ?? 0) > 0)?.id;
			const currentBlank = mainSessionId !== void 0 && list.byId[mainSessionId]?.blank === true ? mainSessionId : void 0;
			const ungroupedMemberIds = (0, react.useMemo)(() => {
				const claimed = groupingOverride === void 0 ? new Set(workspaces.flatMap((workspace) => workspace.sessionIds)) : new Set(groupingOverride.flatMap((group) => group.sessionIds));
				return list.ids.filter((id) => list.byId[id] !== void 0 && !claimed.has(id));
			}, [
				list,
				workspaces,
				groupingOverride
			]);
			const orderState = (0, react.useMemo)(() => ({
				pinnedSessionIds,
				archivedSessionIds
			}), [archivedSessionIds, pinnedSessionIds]);
			const rowState = (0, react.useMemo)(() => ({
				...orderState,
				archivedFilter
			}), [orderState, archivedFilter]);
			const flatMemberIds = (0, react.useMemo)(() => sessionMemberIds(list), [list]);
			const orderedWorkspaces = (0, react.useMemo)(() => workspaces.map((workspace) => {
				const memberIds = workspace.sessionIds;
				const baseOrder = orderBy === "updated" ? orderByRecency(memberIds, list.byId) : reconcileManualOrder(memberIds, sessionOrderByAccount[workspace.workspaceId], list.byId, orderState);
				return {
					...workspace,
					sessionIds: pinCurrentBlank(baseOrder, currentBlank !== void 0 && memberIds.includes(currentBlank) ? currentBlank : void 0)
				};
			}), [
				currentBlank,
				list.byId,
				orderBy,
				orderState,
				sessionOrderByAccount,
				workspaces
			]);
			const orderedProjects = (0, react.useMemo)(() => groupingOverride === void 0 ? void 0 : groupingOverride.map((source) => {
				const memberIds = source.sessionIds;
				const baseOrder = orderBy === "updated" ? orderByRecency(memberIds, list.byId) : reconcileManualOrder(memberIds, projectOrders[source.key], list.byId, orderState);
				return {
					...source,
					sessionIds: pinCurrentBlank(baseOrder, currentBlank !== void 0 && memberIds.includes(currentBlank) ? currentBlank : void 0)
				};
			}), [
				currentBlank,
				list.byId,
				orderBy,
				orderState,
				projectOrders,
				groupingOverride
			]);
			const allProjectOrders = (0, react.useCallback)(() => Object.fromEntries((orderedProjects ?? []).map((source) => [source.key, [...source.sessionIds]])), [orderedProjects]);
			const orderedUngroupedSessionIds = (0, react.useMemo)(() => {
				return pinCurrentBlank(orderBy === "updated" ? orderByRecency(ungroupedMemberIds, list.byId) : reconcileManualOrder(ungroupedMemberIds, sessionOrderByAccount[""], list.byId, orderState), currentBlank !== void 0 && ungroupedMemberIds.includes(currentBlank) ? currentBlank : void 0);
			}, [
				currentBlank,
				list.byId,
				orderBy,
				orderState,
				sessionOrderByAccount,
				ungroupedMemberIds
			]);
			const orderedFlatSessionIds = (0, react.useMemo)(() => {
				return pinCurrentBlank(orderBy === "updated" ? orderByRecency(flatMemberIds, list.byId) : reconcileManualOrder(flatMemberIds, sessionOrderByAccount[FLAT_SESSION_ORDER_KEY], list.byId, orderState), currentBlank !== void 0 && flatMemberIds.includes(currentBlank) ? currentBlank : void 0);
			}, [
				currentBlank,
				flatMemberIds,
				list.byId,
				orderBy,
				orderState,
				sessionOrderByAccount
			]);
			const activeSessionOrders = (0, react.useMemo)(() => Object.fromEntries([
				...orderedWorkspaces.map((workspace) => [workspace.workspaceId, workspace.sessionIds]),
				["", orderedUngroupedSessionIds],
				[FLAT_SESSION_ORDER_KEY, orderedFlatSessionIds]
			]), [
				orderedFlatSessionIds,
				orderedUngroupedSessionIds,
				orderedWorkspaces
			]);
			(0, react.useEffect)(() => {
				if (workspacePhase !== "ready") return;
				actions.retainAccountKeys([
					"",
					FLAT_SESSION_ORDER_KEY,
					...workspaces.map((workspace) => workspace.workspaceId)
				]);
			}, [
				actions.retainAccountKeys,
				workspacePhase,
				workspaces
			]);
			(0, react.useEffect)(() => {
				if (list.phase !== "ready" || workspaceReady || orderBy !== "manual" || currentBlank === void 0) return;
				const changed = {};
				for (const [key, ids] of Object.entries(activeSessionOrders)) {
					if (key !== "__flat_session_order__" && workspacePhase !== "ready") continue;
					const saved = sessionOrderByAccount[key] ?? [];
					if (ids[0] !== currentBlank || saved[0] === currentBlank) continue;
					changed[key] = [currentBlank, ...saved.filter((id) => id !== currentBlank)];
				}
				if (Object.keys(changed).length > 0) actions.syncSessionOrders(changed);
			}, [
				actions.syncSessionOrders,
				activeSessionOrders,
				currentBlank,
				list.phase,
				orderBy,
				sessionOrderByAccount,
				workspacePhase,
				workspaceReady
			]);
			(0, react.useEffect)(() => {
				if (list.phase !== "ready" || !workspaceReady || orderBy !== "manual" || currentBlank === void 0) return;
				if (Object.entries(activeSessionOrders).some(([key, ids]) => ids[0] === currentBlank && sessionOrderByAccount[key]?.[0] !== currentBlank)) actions.syncSessionOrders(activeSessionOrders);
			}, [
				actions.syncSessionOrders,
				activeSessionOrders,
				currentBlank,
				list.phase,
				orderBy,
				sessionOrderByAccount,
				workspaceReady
			]);
			const saveSessionOrder = (accountKey, order) => {
				if (!(setProjectOrders !== void 0 && (groupingOverride?.some((source) => source.key === accountKey) ?? false))) {
					actions.setSessionOrder(accountKey, order, activeSessionOrders);
					return;
				}
				const next = {
					...allProjectOrders(),
					[accountKey]: [...order]
				};
				if (orderBy === "updated") actions.setOrderBy("manual", activeSessionOrders);
				setProjectOrders?.(next).catch((reason) => {
					console.warn("project order rejected:", reason);
				});
			};
			const [query, setQuery] = (0, react.useState)("");
			const [searchExpanded, setSearchExpanded] = (0, react.useState)(false);
			const [revealSessionId, setRevealSessionId] = (0, react.useState)(void 0);
			const normalizedQuery = sanitizeSearchQuery(query).trim();
			const [remoteSearch, setRemoteSearch] = (0, react.useState)({
				query: "",
				status: "idle",
				items: [],
				hasMore: false
			});
			const searchRoot = (0, react.useRef)(null);
			const searchInput = (0, react.useRef)(null);
			const wsPickerOpen = !projectModelAvailable && shortcutState.addRequested;
			const addRequested = shortcutState.addRequested;
			(0, react.useEffect)(() => {
				if (!projectModelAvailable || !addRequested) return;
				closeAddWorkspace();
				setCreateDraft("");
				setCreateError(null);
				setCreating(true);
			}, [
				addRequested,
				projectModelAvailable,
				closeAddWorkspace
			]);
			const wsPlusRef = (0, react.useRef)(null);
			const composingRef = (0, react.useRef)(false);
			const openSearchResult = (sessionId) => {
				if (archivedSessionIds.includes(sessionId)) {
					notifyArchivedNotOpenable();
					return;
				}
				setRevealSessionId(sessionId);
				setQuery("");
				setSearchExpanded(false);
				open(sessionId);
			};
			const acknowledgeSessionReveal = (sessionId) => {
				setRevealSessionId((current) => current === sessionId ? void 0 : current);
			};
			(0, react.useEffect)(() => {
				if (normalizedQuery !== "") setRevealSessionId(void 0);
			}, [normalizedQuery]);
			const [searchOnExpand, setSearchOnExpand] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				if (wide && searchOnExpand) {
					const timer = window.setTimeout(() => {
						searchInput.current?.focus({ preventScroll: true });
						setSearchOnExpand(false);
					}, EXPAND_SLIDE_MS);
					return () => {
						window.clearTimeout(timer);
					};
				}
			}, [wide, searchOnExpand]);
			(0, react.useEffect)(() => {
				if (shortcutState.searchRequest === 0) return;
				closeAddWorkspace();
				setSearchExpanded(true);
				if (!wide) {
					setSearchOnExpand(true);
					expandSidebar();
				} else searchInput.current?.focus({ preventScroll: true });
			}, [shortcutState.searchRequest]);
			(0, react.useEffect)(() => {
				if (!wide || !searchExpanded || searchOnExpand) return;
				searchInput.current?.focus({ preventScroll: true });
			}, [
				wide,
				searchExpanded,
				searchOnExpand
			]);
			(0, react.useEffect)(() => {
				if (!wide || !searchExpanded || searchOnExpand) return;
				const onClick = (event) => {
					if (!(event.target instanceof Node) || searchRoot.current?.contains(event.target) === true) return;
					searchInput.current?.blur();
					if (normalizedQuery !== "") return;
					setSearchExpanded(false);
				};
				document.addEventListener("click", onClick);
				return () => {
					document.removeEventListener("click", onClick);
				};
			}, [
				normalizedQuery,
				wide,
				searchExpanded,
				searchOnExpand
			]);
			(0, react.useEffect)(() => {
				if (normalizedQuery === "") {
					setRemoteSearch({
						query: "",
						status: "idle",
						items: [],
						hasMore: false
					});
					return;
				}
				const controller = new AbortController();
				setRemoteSearch({
					query: normalizedQuery,
					status: "loading",
					items: [],
					hasMore: false
				});
				const timer = window.setTimeout(() => {
					searchSessions(normalizedQuery, controller.signal).then((result) => {
						if (controller.signal.aborted) return;
						setRemoteSearch({
							query: normalizedQuery,
							status: "ready",
							items: result.items,
							hasMore: result.hasMore
						});
					}).catch(() => {
						if (controller.signal.aborted) return;
						setRemoteSearch({
							query: normalizedQuery,
							status: "error",
							items: [],
							hasMore: false
						});
					});
				}, SEARCH_DEBOUNCE_MS);
				return () => {
					window.clearTimeout(timer);
					controller.abort();
				};
			}, [normalizedQuery, searchSessions]);
			const [renameTarget, setRenameTarget] = (0, react.useState)(null);
			const [renameDraft, setRenameDraft] = (0, react.useState)("");
			const [renaming, setRenaming] = (0, react.useState)(false);
			const [renameError, setRenameError] = (0, react.useState)(null);
			const renameTrimmed = renameDraft.trim();
			const renameDuplicate = renameTarget?.kind === "workspace" && renameTrimmed !== "" && workspaces.some((w) => w.workspaceId !== renameTarget.id && w.title === renameTrimmed);
			const renameBlocked = renaming || renameTrimmed === "" || renameTarget === null || renameTrimmed === renameTarget.storedTitle || renameDuplicate;
			const closeRename = () => {
				if (renaming) return;
				setRenameTarget(null);
				setRenameError(null);
			};
			const confirmRename = () => {
				if (renameBlocked || renameTarget === null) return;
				setRenaming(true);
				setRenameError(null);
				(renameTarget.kind === "workspace" ? renameWorkspace(renameTarget.id, renameTrimmed) : renameProject === void 0 ? Promise.reject(/* @__PURE__ */ new Error("no project model")) : renameProject(renameTarget.id, renameTrimmed)).then(() => {
					setRenaming(false);
					setRenameTarget(null);
				}).catch((reason) => {
					setRenaming(false);
					setRenameError(reason instanceof Error ? reason.message : String(reason));
				});
			};
			const [creating, setCreating] = (0, react.useState)(false);
			const [createDraft, setCreateDraft] = (0, react.useState)("");
			const [createBusy, setCreateBusy] = (0, react.useState)(false);
			const [createError, setCreateError] = (0, react.useState)(null);
			const createTrimmed = createDraft.trim();
			const createBlocked = createBusy || createTrimmed === "";
			const openCreate = () => {
				setCreateDraft("");
				setCreateError(null);
				setCreating(true);
			};
			const closeCreate = () => {
				if (createBusy) return;
				setCreating(false);
				setCreateError(null);
			};
			const confirmCreate = () => {
				if (createBlocked || createProject === void 0) return;
				setCreateBusy(true);
				setCreateError(null);
				createProject({ title: createTrimmed }).then(() => {
					setCreateBusy(false);
					setCreating(false);
				}).catch((reason) => {
					setCreateBusy(false);
					setCreateError(reason instanceof Error ? reason.message : String(reason));
				});
			};
			const onSessionUnarchive = (sessionId) => {
				unarchiveSession(sessionId).catch((reason) => {
					console.warn("session unarchive rejected:", reason);
				});
			};
			const [deleteTarget, setDeleteTarget] = (0, react.useState)(null);
			const [deleting, setDeleting] = (0, react.useState)(false);
			const [deleteCommittedId, setDeleteCommittedId] = (0, react.useState)(null);
			const [deleteError, setDeleteError] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				if (deleteCommittedId === null || workspaces.some((workspace) => workspace.workspaceId === deleteCommittedId)) return;
				setDeleting(false);
				setDeleteCommittedId(null);
				setDeleteTarget(null);
			}, [deleteCommittedId, workspaces]);
			const closeDelete = () => {
				if (deleting) return;
				setDeleteTarget(null);
				setDeleteError(null);
			};
			const confirmDelete = () => {
				/* v8 ignore next -- the Modal is absent without a target and its button is disabled while deleting. */
				if (deleting || deleteTarget === null) return;
				setDeleting(true);
				setDeleteCommittedId(null);
				setDeleteError(null);
				if (deleteTarget.kind === "project") {
					(deleteProject === void 0 ? Promise.reject(/* @__PURE__ */ new Error("no project model")) : deleteProject(deleteTarget.id)).then(() => {
						setDeleting(false);
						setDeleteTarget(null);
					}).catch((reason) => {
						setDeleting(false);
						setDeleteError(reason instanceof Error ? reason.message : String(reason));
					});
					return;
				}
				deleteWorkspace(deleteTarget.id).then(() => {
					setDeleteCommittedId(deleteTarget.id);
				}).catch((reason) => {
					setDeleting(false);
					setDeleteError(reason instanceof Error ? reason.message : String(reason));
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: clsx(WorkspaceBrowser_module_css_default.root, !wide && WorkspaceBrowser_module_css_default.rail),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: WorkspaceBrowser_module_css_default.sectionHeader,
						children: [
							wide && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: clsx(WorkspaceBrowser_module_css_default.sectionLabel, WorkspaceBrowser_module_css_default.wide, searchExpanded && WorkspaceBrowser_module_css_default.sectionLabelHidden),
								children: groupBy === "flat" ? t("section.sessions") : t("section.workspaces")
							}),
							wide && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: clsx(WorkspaceBrowser_module_css_default.searchSlot, searchExpanded && WorkspaceBrowser_module_css_default.searchSlotExpanded),
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									ref: searchRoot,
									className: clsx(WorkspaceBrowser_module_css_default.search, searchExpanded && WorkspaceBrowser_module_css_default.searchExpanded),
									onClick: () => {
										closeAddWorkspace();
										setSearchExpanded(true);
										searchInput.current?.focus();
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
											label: t("search"),
											shortcutKeys: searchShortcut?.keys,
											side: "bottom",
											delayMs: 500,
											disabled: searchExpanded,
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: WorkspaceBrowser_module_css_default.searchButton,
												"aria-label": t("search.sessions.aria"),
												"aria-keyshortcuts": searchShortcut?.aria,
												"aria-expanded": searchExpanded,
												onClick: () => {
													requestSearch();
												},
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSearchOutlineRegular, { size: searchExpanded ? 11 : 14 })
											})
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											ref: searchInput,
											className: WorkspaceBrowser_module_css_default.searchInput,
											type: "text",
											placeholder: t("search.placeholder"),
											maxLength: SEARCH_QUERY_MAX_CODE_UNITS,
											value: query,
											tabIndex: searchExpanded ? 0 : -1,
											onChange: (e) => {
												setQuery(sanitizeSearchQuery(e.target.value));
											},
											onKeyDown: (e) => {
												if (e.key !== "Escape") return;
												setQuery("");
												setSearchExpanded(false);
											}
										}),
										searchExpanded && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: WorkspaceBrowser_module_css_default.clearButton,
											"aria-label": t("search.clear"),
											onClick: (e) => {
												e.stopPropagation();
												setQuery("");
												setSearchExpanded(false);
											},
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseFillRegular, {})
										})
									]
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: clsx(WorkspaceBrowser_module_css_default.headerActions, wide && searchExpanded && WorkspaceBrowser_module_css_default.headerActionsHidden),
								children: [wide && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ViewOptionsMenu, {
									groupBy,
									orderBy,
									archivedFilter,
									onGroupPick: actions.setGroupBy,
									onOrderPick: (mode) => {
										actions.setOrderBy(mode, activeSessionOrders);
										if (setProjectOrders === void 0) return;
										setProjectOrders(mode === "manual" ? allProjectOrders() : {}).catch((reason) => {
											console.warn("project order rejected:", reason);
										});
									},
									onArchivedFilterPick: actions.setArchivedFilter,
									t
								}), (projectModelAvailable || directoryFlowAvailable) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
									label: t(projectModelAvailable ? "project.add" : "workspace.add"),
									shortcutKeys: projectModelAvailable ? void 0 : addShortcut?.keys,
									side: "bottom",
									delayMs: 500,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										ref: wsPlusRef,
										type: "button",
										className: WorkspaceBrowser_module_css_default.iconButton,
										"aria-label": t(projectModelAvailable ? "project.add" : "workspace.add"),
										onClick: () => {
											if (projectModelAvailable) openCreate();
											else requestAddWorkspace();
										},
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconProjectAddOutlineRegular, { size: wide ? 16 : 18 })
									})
								})]
							}),
							!projectModelAvailable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkspacePickFlow, {
								t,
								open: wsPickerOpen,
								anchorRef: wsPlusRef,
								useWorkspaces,
								createWorkspace,
								useDirectoryFlow,
								renderDirectoryFlow: (owner) => renderSlot("sidebar.workspaces.directoryFlow", owner),
								addOnly: true,
								onBusyChange: setDirectoryBusy,
								side: "right",
								onPick: (workspaceId) => {
									closeAddWorkspace();
									startSession(workspaceId);
								},
								onClose: () => {
									closeAddWorkspace();
								}
							})
						]
					}),
					!wide && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: WorkspaceBrowser_module_css_default.search,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
							label: t("search"),
							shortcutKeys: searchShortcut?.keys,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: WorkspaceBrowser_module_css_default.searchButton,
								"aria-label": t("search.sessions.aria"),
								"aria-keyshortcuts": searchShortcut?.aria,
								onClick: () => {
									requestSearch();
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSearchOutlineRegular, { size: 18 })
							})
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: WorkspaceBrowser_module_css_default.listArea,
						children: wide && (normalizedQuery !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SearchResults, {
							usePanelInfo,
							useSessions,
							useSessionStatus,
							open: openSearchResult,
							onUnarchive: onSessionUnarchive,
							workspaces,
							archivedSessionIds,
							archivedFilter,
							query: normalizedQuery,
							remote: remoteSearch,
							resultLimit: searchResultLimit,
							t
						}) : groupBy === "flat" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FlatList, {
							usePanelInfo,
							list,
							sessionIds: orderedFlatSessionIds,
							rowState,
							onLeaveArchivedOnly: leaveArchivedOnly,
							workspaceReady,
							animationResetKey: `${groupBy}/${orderBy}/${archivedFilter}`,
							useSessionStatus,
							open: guardedOpen,
							onSessionRenameRequest: requestSessionRename,
							renderSlot,
							setSessionOrder: saveSessionOrder,
							revealSessionId,
							onSessionRevealed: acknowledgeSessionReveal,
							t
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SessionTree, {
							usePanelInfo,
							list,
							shortcuts,
							useSessionStatus,
							onSessionRenameRequest: requestSessionRename,
							renderSlot,
							reorderProject,
							assignSession,
							workspaces: orderedWorkspaces,
							groupingOverride: orderedProjects,
							ungroupedSessionIds: orderedUngroupedSessionIds,
							workspaceReady,
							nestWorkspaces: groupBy === "workspace-tree",
							animationResetKey: `${groupBy}/${orderBy}/${archivedFilter}`,
							groupExpansion,
							setGroupExpanded: actions.setGroupExpanded,
							projectExpansion,
							setProjectExpanded,
							setSessionOrder: saveSessionOrder,
							rowState,
							onLeaveArchivedOnly: leaveArchivedOnly,
							startSession,
							open: guardedOpen,
							insertWorkspaceBefore,
							unassignSession,
							orderBy,
							revealSessionId,
							onSessionRevealed: acknowledgeSessionReveal,
							home,
							t,
							onRenameRequest: (row) => {
								setRenameTarget(row.kind === "project" ? {
									kind: "project",
									id: row.id,
									storedTitle: row.title
								} : {
									kind: "workspace",
									id: row.id,
									storedTitle: storedWorkspaces.find((w) => w.workspaceId === row.id)?.title ?? row.title
								});
								setRenameDraft(row.title);
								setRenameError(null);
							},
							onDeleteRequest: (row) => {
								setDeleteTarget({ ...row });
								setDeleteError(null);
							}
						}))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: renameTarget !== null,
						onClose: closeRename,
						closeLabel: t("close"),
						title: t(renameTarget?.kind === "project" ? "rename.project.title" : "rename.workspace.title"),
						footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							disabled: renaming,
							onClick: closeRename,
							children: t("cancel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							disabled: renameBlocked,
							onClick: confirmRename,
							children: t("rename")
						})] }),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: WorkspaceBrowser_module_css_default.renameInput,
								value: renameDraft,
								"aria-label": t(renameTarget?.kind === "project" ? "field.projectName" : "field.workspaceName"),
								"data-modal-autofocus": true,
								disabled: renaming,
								onFocus: (e) => {
									e.target.select();
								},
								onChange: (e) => {
									setRenameDraft(e.target.value);
									setRenameError(null);
								},
								onCompositionStart: () => {
									composingRef.current = true;
								},
								onCompositionEnd: () => {
									composingRef.current = false;
								},
								onKeyDown: (e) => {
									if (e.key === "Enter" && !composingRef.current) {
										e.preventDefault();
										confirmRename();
									}
								}
							}),
							renameDuplicate && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: WorkspaceBrowser_module_css_default.renameError,
								role: "alert",
								children: t("conflict.named", { name: renameTrimmed })
							}),
							renameError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: WorkspaceBrowser_module_css_default.renameError,
								role: "alert",
								children: renameError
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: deleteTarget !== null,
						onClose: closeDelete,
						closeLabel: t("close"),
						title: t(deleteTarget?.kind === "project" ? "delete.project" : "delete.workspace"),
						...deleteTarget === null ? {} : { description: t(deleteTarget.kind === "project" ? "delete.project.desc" : "delete.desc", { name: deleteTarget.title }) },
						footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							disabled: deleting,
							onClick: closeDelete,
							children: t("cancel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							className: WorkspaceBrowser_module_css_default.deleteAction,
							disabled: deleting,
							onClick: confirmDelete,
							children: t(deleteTarget?.kind === "project" ? "delete.project" : "delete.workspace")
						})] }),
						children: [deleting && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: WorkspaceBrowser_module_css_default.deleteStatus,
							role: "status",
							children: t(deleteTarget?.kind === "project" ? "delete.project.pending" : "delete.pending")
						}), deleteError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: WorkspaceBrowser_module_css_default.renameError,
							role: "alert",
							children: deleteError
						})]
					}),
					projectModelAvailable && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: creating,
						onClose: closeCreate,
						closeLabel: t("close"),
						title: t("project.create.title"),
						footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							disabled: createBusy,
							onClick: closeCreate,
							children: t("cancel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							disabled: createBlocked,
							onClick: confirmCreate,
							children: t("create")
						})] }),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: WorkspaceBrowser_module_css_default.renameInput,
							value: createDraft,
							"aria-label": t("field.projectName"),
							placeholder: t("project.create.placeholder"),
							"data-modal-autofocus": true,
							disabled: createBusy,
							onChange: (e) => {
								setCreateDraft(e.target.value);
							},
							onKeyDown: (e) => {
								if (e.key === "Enter") confirmCreate();
							}
						}), createError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: WorkspaceBrowser_module_css_default.renameError,
							role: "alert",
							children: createError
						})]
					}),
					shortcutState.forkError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
						text: t(shortcutState.forkError.reason === "unavailable" ? "shortcut.noCompletedTurn" : "shortcut.forkFailed"),
						onDone: dismissForkError
					}, shortcutState.forkError.seq)
				]
			});
		}
		//#endregion
		//#region src/vendored/client/session-actions/ArchiveSession.tsx
		/**
		* The archive action: a `sidebar.workspaces.session.menu.item` row and a
		* `sidebar.workspaces.session.row.action` button over one injected behavior,
		* plus the `shell.overlay` dialog that confirms stopping a Session's running
		* work before archiving it. The same entries restore an archived row; the
		* notice a successful archive raises and the diagnostics for Host rejections
		* live in the injected callbacks, not here.
		*/
		/**
		* Menu row (order 400): archive, or restore an archived row.
		* @param props - owner share, the archive share, and the menu open state.
		* @returns the row.
		*/
		function ArchiveSessionMenuItem({ sessionId, useArchived, useMenuOpenState, useShortcuts, archiveSession, unarchiveSession, t }) {
			const [, setMenuOpen] = useMenuOpenState();
			const shortcut = useShortcuts((rows) => rows.find((row) => row.id === "session.archive"));
			const archived = useArchived((set) => set.has(sessionId));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MenuItemButton, {
				shortcut: archived ? void 0 : shortcut,
				icon: archived ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconUnarchiveOutlineRegular, { size: 14 }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutlineRegular, { size: 14 }),
				onSelect: () => {
					setMenuOpen(false);
					(archived ? unarchiveSession : archiveSession)(sessionId);
				},
				children: t(archived ? "menu.unarchiveSession" : "menu.archiveSession")
			});
		}
		/**
		* Hover button (order 100): archive, or restore an archived row.
		* @param props - owner share and the archive share.
		* @returns the button.
		*/
		function ArchiveSessionRowButton({ sessionId, useArchived, archiveSession, unarchiveSession, t }) {
			const archived = useArchived((set) => set.has(sessionId));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label: t(archived ? "actions.unarchive" : "actions.archive"),
				side: "bottom",
				align: "end",
				delayMs: 500,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: Rows_module_css_default.iconButton,
					"aria-label": t(archived ? "menu.unarchiveSession" : "menu.archiveSession"),
					onClick: () => {
						(archived ? unarchiveSession : archiveSession)(sessionId);
					},
					children: archived ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconUnarchiveOutlineRegular, { size: 14 }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutlineRegular, { size: 14 })
				})
			});
		}
		/**
		* The `shell.overlay` entry: nothing while no confirmation is pending,
		* otherwise one dialog per request (keyed by the Session). Confirming asks
		* the Host to stop the listed work and archive; cancelling leaves the
		* Session running and visible.
		* @param props - the request hook, its settlement, the stop-and-archive hop, and the locale seat.
		* @returns the open dialog, or null.
		*/
		function SessionArchiveConfirmDialog({ useArchiveRequest, settleSessionArchive, stopAndArchiveSession, t }) {
			const request = useArchiveRequest((pending) => pending);
			if (request === null) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ArchiveConfirmForm, {
				request,
				stopAndArchiveSession,
				onSettle: settleSessionArchive,
				t
			}, request.sessionId);
		}
		/** One request's dialog: in-flight and error state die with it. */
		function ArchiveConfirmForm({ request, stopAndArchiveSession, onSettle, t }) {
			const [archiving, setArchiving] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const close = () => {
				if (archiving) return;
				onSettle();
			};
			const confirm = () => {
				setArchiving(true);
				setError(null);
				stopAndArchiveSession(request.sessionId).then(() => {
					setArchiving(false);
					onSettle();
				}).catch((reason) => {
					setArchiving(false);
					setError(reason instanceof Error ? reason.message : String(reason));
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open: true,
				onClose: close,
				closeLabel: t("close"),
				title: t("archive.confirm.title"),
				description: t("archive.confirm.desc", { title: request.displayTitle }),
				footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "outline",
					disabled: archiving,
					onClick: close,
					children: t("cancel")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "outline",
					className: WorkspaceBrowser_module_css_default.deleteAction,
					disabled: archiving,
					onClick: confirm,
					children: t("archive.confirm.action")
				})] }),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: WorkspaceBrowser_module_css_default.archiveActivity,
						"aria-label": t("archive.confirm.activity"),
						children: request.activity.map((entry, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: activityLine(entry, t) }, `${entry.kind}-${String(index)}`))
					}),
					archiving && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: WorkspaceBrowser_module_css_default.deleteStatus,
						role: "status",
						children: t("archive.confirm.pending")
					}),
					error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: WorkspaceBrowser_module_css_default.renameError,
						role: "alert",
						children: error
					})
				]
			});
		}
		/**
		* One family's line: its count and the items' labels (ids when a family
		* carries no label). A family this dictionary does not know — a provider
		* merged into the kind map — falls through to the generic line.
		*/
		function activityLine(entry, t) {
			const items = entry.items ?? [];
			const n = items.length;
			const names = items.map((item) => item.label ?? item.id).join(t("archive.confirm.listSeparator"));
			const plural = n === 1 ? "one" : "other";
			switch (entry.kind) {
				case "turn": return t("archive.confirm.turn");
				case "subagent": return t(`archive.confirm.subagents.${plural}`, {
					n,
					names
				});
				case "job": return t(`archive.confirm.jobs.${plural}`, {
					n,
					names
				});
				case "schedule": return t(`archive.confirm.schedules.${plural}`, {
					n,
					names
				});
				default: return t(`archive.confirm.other.${plural}`, {
					kind: entry.kind,
					n
				});
			}
		}
		//#endregion
		//#region src/vendored/client/session-actions/BaseWorkspaceMissing.tsx
		/**
		* The `shell.overlay` entry for a New Session whose 底层工作区 is gone.
		*
		* The shipped region does nothing in that case: `startSessionInDefaultWorkspace`
		* returns as soon as the default Workspace fails to resolve, so a click on New Session
		* had no visible effect whatsoever (the toast only covers the *throwing* path, and a
		* deleted registration does not throw). This surfaces the reason instead, and offers
		* the two repairs.
		*
		* ## Layout
		*
		* The actions are stacked, not laid out in a row. The shared `Modal` footer is a
		* right-aligned flex row, which gives three equal actions about 77px each in the
		* default 380px card — five Chinese characters, less than the labels here need. A
		* column footer gives each action the card's full width (measured: 304px usable in a
		* 380px card), and it is what the official plugin-manager dialog does
		* (`.installFooter { flex-direction: column }`).
		*
		* Order runs most-active first, so the destructive-feeling "取消" sits last.
		*
		* ## Two stages, one dialog
		*
		* The rebuild writes to the disk — in `'default'` mode to the official default Workspace's own
		* directory — so it asks first. The confirmation is a **second stage of this card**, not a second
		* `Modal`: measured, two modals would both sit at `z-index: 1000` and each installs its own
		* document-level Escape and Tab handler, so one Escape would close both and the focus trap could
		* escape outward. Switching the content of one card gets the confirmation without any of that.
		*
		* ## Why the two repairs are optional
		*
		* Both are wired now, but the callbacks stay optional: a composition that supplies neither renders
		* both buttons disabled, which is honest. A button that appears to work and does nothing is the bug
		* this whole dialog exists to remove.
		*/
		/**
		* Render the missing-Workspace dialog.
		* @param props - the pending report, its settlement, the two repairs, and the locale seat.
		* @returns the dialog, or null when nothing is pending.
		*/
		function BaseWorkspaceMissingDialog({ useBaseWorkspaceRequest, settleBaseWorkspaceMissing, rebuildBaseWorkspace, chooseBaseWorkspace, t }) {
			const request = useBaseWorkspaceRequest((current) => current);
			if (request === null) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(BaseWorkspaceMissingForm, {
				request,
				settle: settleBaseWorkspaceMissing,
				rebuild: rebuildBaseWorkspace,
				choose: chooseBaseWorkspace,
				t
			}, `${request.mode}:${request.path ?? ""}`);
		}
		/**
		* One report's dialog: busy and error state die with it.
		* @param props - the report and the actions it offers.
		* @returns the dialog.
		*/
		function BaseWorkspaceMissingForm({ request, settle, rebuild, choose, t }) {
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const [stage, setStage] = (0, react.useState)("report");
			const confirmRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (stage === "confirm") confirmRef.current?.focus();
			}, [stage]);
			const run = (action) => {
				setBusy(true);
				setError(null);
				action().then(() => {
					setBusy(false);
					settle();
				}).catch((reason) => {
					setBusy(false);
					setError(reason instanceof Error ? reason.message : String(reason));
				});
			};
			const close = () => {
				if (busy) return;
				if (stage === "confirm") {
					setStage("report");
					return;
				}
				settle();
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open: true,
				onClose: close,
				closeLabel: t("close"),
				title: stage === "confirm" ? t("baseMissing.confirmTitle") : t("baseMissing.title"),
				footer: stage === "confirm" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: WorkspaceBrowser_module_css_default.baseMissingActions,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						ref: confirmRef,
						variant: "primary",
						disabled: busy || rebuild === void 0,
						onClick: () => {
							if (rebuild !== void 0) run(rebuild);
						},
						children: busy ? t("baseMissing.confirmBusy") : t("baseMissing.confirmAction")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "outline",
						disabled: busy,
						onClick: () => {
							setStage("report");
						},
						children: t("baseMissing.confirmBack")
					})]
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: WorkspaceBrowser_module_css_default.baseMissingActions,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							disabled: busy || rebuild === void 0,
							onClick: () => {
								setStage("confirm");
							},
							children: t("baseMissing.rebuild")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							disabled: busy || choose === void 0,
							onClick: () => {
								settle();
								choose?.();
							},
							children: t("baseMissing.respecify")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "ghost",
							disabled: busy,
							"data-modal-autofocus": true,
							onClick: () => {
								if (!busy) settle();
							},
							children: t("cancel")
						})
					]
				}),
				children: [stage === "confirm" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: WorkspaceBrowser_module_css_default.baseMissingConfirm,
					role: "alert",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutlineRegular, {
						size: 18,
						className: WorkspaceBrowser_module_css_default.baseMissingConfirmIcon
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("baseMissing.confirmBody") })]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: WorkspaceBrowser_module_css_default.baseMissingPath,
					role: "note",
					children: request.path === null ? t("baseMissing.pathUnknown") : t("baseMissing.path", { path: request.path })
				})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: WorkspaceBrowser_module_css_default.baseMissingBody,
					children: t("baseMissing.body")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: WorkspaceBrowser_module_css_default.baseMissingPath,
					role: "note",
					children: request.path === null ? t("baseMissing.pathUnknown") : t("baseMissing.path", { path: request.path })
				})] }), error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: WorkspaceBrowser_module_css_default.renameError,
					role: "alert",
					children: error
				})]
			});
		}
		//#endregion
		//#region src/vendored/client/session-actions/derived.ts
		/**
		* Project one observable into another, recomputing only when the source
		* snapshot changes identity, so consumers that select from the projection
		* (a Set lookup per row) never rebuild it per read.
		* @param source - the observable to project.
		* @param project - pure projection of one source snapshot.
		* @returns the projected observable, subscribing through the source.
		*/
		function derive(source, project) {
			let seen;
			let value;
			return {
				getSnapshot: () => {
					const snapshot = source.getSnapshot();
					if (value === void 0 || snapshot !== seen) {
						seen = snapshot;
						value = project(snapshot);
					}
					return value;
				},
				subscribe: (listener) => source.subscribe(listener)
			};
		}
		//#endregion
		//#region src/vendored/client/session-actions/ForkSession.tsx
		/** The fork action: one `sidebar.workspaces.session.menu.item` row. */
		/**
		* Menu row (order 300): fork at the Session's last completed turn; the child
		* arrives through the Host list beside its source.
		* @param props - owner share, menu open state, and the fork share.
		* @returns the row.
		*/
		function ForkSessionMenuItem({ sessionId, useMenuOpenState, useShortcuts, forkSession, t }) {
			const [, setMenuOpen] = useMenuOpenState();
			const shortcut = useShortcuts((rows) => rows.find((row) => row.id === "session.fork"));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MenuItemButton, {
				shortcut,
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBranchOutlineRegular, {}),
				onSelect: () => {
					setMenuOpen(false);
					forkSession(sessionId);
				},
				children: t("menu.fork")
			});
		}
		//#endregion
		//#region src/vendored/client/session-actions/PinSession.tsx
		/**
		* The pin action: a `sidebar.workspaces.session.menu.item` row and a
		* `sidebar.workspaces.session.row.action` button over one injected behavior.
		* Pin and archive are mutually exclusive on the Host, so the action reads both
		* sets and does not offer itself on an archived row; what a pin does beyond
		* the Host call (fronting the Session in its saved orders, the failure
		* notice) lives in the injected callbacks, not here.
		*/
		/** The row's pin and archive membership, one Set lookup each. */
		function usePinState({ sessionId, usePinned, useArchived }) {
			return {
				pinned: usePinned((pinned) => pinned.has(sessionId)),
				archived: useArchived((archived) => archived.has(sessionId))
			};
		}
		/**
		* Menu row (order 100): pin or unpin by the row's current state; absent on archived rows.
		* @param props - owner share, the pin share, and the menu open state.
		* @returns the row, or null for an archived Session.
		*/
		function PinSessionMenuItem(props) {
			const { sessionId, useMenuOpenState, pinSession, unpinSession, t } = props;
			const [, setMenuOpen] = useMenuOpenState();
			const { pinned, archived } = usePinState(props);
			if (archived) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MenuItemButton, {
				icon: pinned ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPinFillRegular, {}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPinOutlineRegular, {}),
				onSelect: () => {
					setMenuOpen(false);
					(pinned ? unpinSession : pinSession)(sessionId);
				},
				children: t(pinned ? "menu.unpinSession" : "menu.pinSession")
			});
		}
		/**
		* Hover button (order 200, rightmost: it lands where the rest-state pin marker sits); absent on archived rows.
		* @param props - owner share and the pin share.
		* @returns the button, or null for an archived Session.
		*/
		function PinSessionRowButton(props) {
			const { sessionId, pinSession, unpinSession, t } = props;
			const { pinned, archived } = usePinState(props);
			if (archived) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label: t(pinned ? "actions.unpin" : "actions.pin"),
				side: "bottom",
				align: "end",
				delayMs: 500,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: Rows_module_css_default.iconButton,
					"aria-label": t(pinned ? "menu.unpinSession" : "menu.pinSession"),
					onClick: () => {
						(pinned ? unpinSession : pinSession)(sessionId);
					},
					children: pinned ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPinFillRegular, { size: 14 }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPinOutlineRegular, { size: 14 })
				})
			});
		}
		//#endregion
		//#region src/vendored/client/session-actions/RenameSession.tsx
		/**
		* The rename action: a `sidebar.workspaces.session.menu.item` row that raises
		* the rename request, and the `shell.overlay` dialog entry that answers it.
		* The dialog lives outside the row menu because the row unmounts with the
		* menu; the browser raises the same request from a title double-click.
		*/
		/**
		* Menu row (order 200): ask for the rename dialog, seeded with the row's current title.
		* @param props - owner share, menu open state, and the rename share.
		* @returns the row.
		*/
		function RenameSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, useShortcuts, requestSessionRename, t }) {
			const [, setMenuOpen] = useMenuOpenState();
			const shortcut = useShortcuts((rows) => rows.find((row) => row.id === "session.rename"));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MenuItemButton, {
				shortcut,
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutlineRegular, {}),
				onSelect: () => {
					setMenuOpen(false);
					requestSessionRename(sessionId, displayTitle);
				},
				children: t("rename")
			});
		}
		/**
		* The `shell.overlay` entry: nothing while no rename is requested, otherwise
		* one dialog per request (keyed by the Session, so a new request starts a
		* fresh draft). Sessions have no client-side name-conflict rule (the host
		* normalizes), and unlike Workspace rename an unchanged title is NOT
		* blocked: confirming the current automatic title is the gesture that pins it.
		* @param props - the request hook, its settlement, the rename hop, and the locale seat.
		* @returns the open dialog, or null.
		*/
		function SessionRenameDialog({ useRenameRequest, settleSessionRename, renameSession, t }) {
			const request = useRenameRequest((pending) => pending);
			if (request === null) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RenameForm, {
				request,
				renameSession,
				onSettle: settleSessionRename,
				t
			}, request.sessionId);
		}
		/** One request's dialog: the draft seeds from the request on mount; in-flight and error state die with it. */
		function RenameForm({ request, renameSession, onSettle, t }) {
			const [draft, setDraft] = (0, react.useState)(request.currentTitle);
			const [renaming, setRenaming] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const composingRef = (0, react.useRef)(false);
			const trimmed = draft.trim();
			const blocked = renaming || trimmed === "";
			const close = () => {
				if (renaming) return;
				onSettle();
			};
			const confirm = () => {
				if (blocked) return;
				setRenaming(true);
				setError(null);
				renameSession(request.sessionId, trimmed).then(() => {
					setRenaming(false);
					onSettle();
				}).catch((reason) => {
					setRenaming(false);
					setError(reason instanceof Error ? reason.message : String(reason));
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open: true,
				onClose: close,
				closeLabel: t("close"),
				title: t("rename.session.title"),
				footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "outline",
					disabled: renaming,
					onClick: close,
					children: t("cancel")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "primary",
					disabled: blocked,
					onClick: confirm,
					children: t("rename")
				})] }),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					className: WorkspaceBrowser_module_css_default.renameInput,
					value: draft,
					"aria-label": t("field.sessionName"),
					"data-modal-autofocus": true,
					disabled: renaming,
					onFocus: (e) => {
						e.target.select();
					},
					onChange: (e) => {
						setDraft(e.target.value);
						setError(null);
					},
					onCompositionStart: () => {
						composingRef.current = true;
					},
					onCompositionEnd: () => {
						composingRef.current = false;
					},
					onKeyDown: (e) => {
						if (e.key === "Enter" && !composingRef.current) {
							e.preventDefault();
							confirm();
						}
					}
				}), error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: WorkspaceBrowser_module_css_default.renameError,
					role: "alert",
					children: error
				})]
			});
		}
		//#endregion
		//#region src/vendored/client/session-actions/RowActionToast.tsx
		/**
		* The `shell.overlay` entry for Workspace and Session notices.
		* One notice is visible at a time; a parent rerender does not extend its hold.
		*/
		/**
		* Hold for the notices that take longer to read than a one-line warning: the
		* actionable archived notice (two buttons to react to) and a refused Session
		* creation, which quotes the Host's reason.
		*/
		const LONG_TOAST_HOLD_MS = 6e3;
		/**
		* Render the current notice: the archived and stopped-and-archived notices
		* with their undo action — plus the show-archived action while archived rows
		* are hidden — on a 6 s hold, a refused Session creation with the Host's
		* reason on the same hold, or a plain warning for a failed pin, an archived
		* row that was clicked, or default Workspace creation.
		* @param props - the notice hook, the shared viewing store, the notice dismissal, the two archived-notice actions, and the locale seat.
		* @returns the notice on display, or null.
		*/
		function RowActionToast({ useToast, useStore, dismissToast, undoArchive, showArchived, t }) {
			const toast = useToast((current) => current);
			const archivedRowsVisible = useStore((state) => (state.archivedFilter ?? "default") !== "default");
			if (toast === null) return null;
			if (toast.kind === "archived" || toast.kind === "stoppedAndArchived") {
				const { sessionId } = toast;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
					text: t(toast.kind === "archived" ? "toast.archived" : "toast.stoppedAndArchived"),
					tone: "success",
					holdMs: LONG_TOAST_HOLD_MS,
					actions: [{
						label: t("toast.archivedUndo"),
						onClick: () => {
							dismissToast();
							undoArchive(sessionId);
						}
					}, ...archivedRowsVisible ? [] : [{
						prefix: t("toast.archivedOr"),
						label: t("toast.archivedFilter"),
						onClick: () => {
							dismissToast();
							showArchived();
						}
					}]],
					onDone: dismissToast
				}, `toast-${String(toast.seq)}`);
			}
			if (toast.kind === "createFailed") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
				text: t("toast.createFailed", { message: toast.message }),
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutlineRegular, {}),
				holdMs: LONG_TOAST_HOLD_MS,
				onDone: dismissToast
			}, `toast-${String(toast.seq)}`);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
				text: plainNoticeText(toast, t),
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutlineRegular, {}),
				onDone: dismissToast
			}, `toast-${String(toast.seq)}`);
		}
		/** The copy of one plain warning, keyed by the notice kind the union closes over. */
		function plainNoticeText(toast, t) {
			switch (toast.kind) {
				case "pinFailed": return t("toast.pinFailed");
				case "unpinFailed": return t("toast.unpinFailed");
				case "defaultWorkspaceFailed": return t("defaultWorkspace.failed");
				case "archivedNotOpenable": return t("toast.archivedNotOpenable");
				/* v8 ignore next 2 -- closed-union backstop; only reached if a notice kind is forged */
				default: return assertNever$1(toast);
			}
		}
		//#endregion
		//#region src/vendored/client/locales.ts
		/**
		* `workspace` namespace dictionaries: the browsing region (section header,
		* search, tree rows, dialogs) and the pick/add flow. Runtime failure
		* messages (wire error strings) pass through untranslated by policy.
		*/
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh$1 = {
			"defaultWorkspace.failed": "无法创建默认工作区，请通过“选择工作区”选择文件夹",
			"group.ungrouped": "未分组",
			"session.new": "新会话",
			"shortcut.noSession": "请先选择一个会话",
			"shortcut.noPicker": "目录选择器不可用",
			"shortcut.directoryBusy": "正在选择或添加工作区",
			"shortcut.noCompletedTurn": "当前会话没有已结束的轮次",
			"shortcut.forkFailed": "无法分叉会话，请重试",
			"section.workspaces": "工作区",
			"section.sessions": "会话",
			"viewOptions.label": "视图选项",
			"groupBy.label": "分组方式",
			"groupBy.workspace": "按工作区",
			"groupBy.workspaceTree": "按工作区树",
			"groupBy.flat": "单列表",
			"orderBy.label": "排序方式",
			"orderBy.manual": "手动排序",
			"orderBy.updated": "最近更新",
			"filterBy.label": "筛选会话",
			"viewOptions.hideArchived": "隐藏已归档",
			"viewOptions.showArchived": "全部对话（显示已归档）",
			"viewOptions.onlyArchived": "仅显示已归档",
			"sessions.expand": "展开其余 {n} 个会话",
			"sessions.collapse": "收起",
			"empty.none": "暂无会话",
			"empty.noneArchived": "暂无已归档会话",
			"empty.viewOthers": "查看其他会话",
			"empty.noMatches": "无匹配结果",
			"workspace.add": "添加工作区",
			"project.add": "新建项目",
			"project.create.title": "新建项目",
			"project.create.placeholder": "项目名称",
			"field.projectName": "项目名称",
			"create": "创建",
			"rename.project.title": "重命名项目",
			"delete.project": "删除项目",
			"delete.project.desc": "将删除项目“{name}”。其中的会话不会被删除，会回到“未分组”。",
			"delete.project.pending": "正在删除项目…",
			"baseMissing.title": "底层工作区缺失",
			"baseMissing.body": "它是本插件所有会话的落脚点，缺失时无法新建会话。",
			"baseMissing.path": "当前：{path}",
			"baseMissing.pathUnknown": "当前：默认工作区（路径未知）",
			"baseMissing.rebuild": "重建该工作区",
			"baseMissing.respecify": "重新指定底层工作区",
			"baseMissing.confirmTitle": "确认重建",
			"baseMissing.confirmBody": "将在该路径创建目录并注册为工作区。若该目录已存在，其内容不会被修改。",
			"baseMissing.confirmAction": "确认重建",
			"baseMissing.confirmBusy": "正在重建…",
			"baseMissing.confirmBack": "返回",
			"search.sessions.aria": "搜索会话",
			"search.placeholder": "搜索会话名称",
			"search.clear": "清除搜索",
			"search.results.aria": "搜索结果",
			"search.pending": "正在搜索会话历史…",
			"search.noMatches": "无匹配会话",
			"search.hasMore": "仅显示前 {n} 条结果，请缩小搜索范围。",
			"menu.addWorkspace": "添加工作区…",
			"picker.loading": "正在加载工作区…",
			"conflict.named": "已存在名为“{name}”的工作区。",
			"folderError.title": "无法打开文件夹",
			"folderError.retry": "重新选择",
			"rename": "重命名",
			"rename.workspace.title": "重命名工作区",
			"rename.session.title": "重命名会话",
			"field.workspaceName": "工作区名称",
			"field.sessionName": "会话名称",
			"delete.workspace": "删除工作区",
			"delete.desc": "将把“{name}”从工作区列表中移除。文件夹与会话记录会保留，其会话将显示在“未分组”下。",
			"delete.pending": "正在删除工作区…",
			"menu.fork": "分叉会话",
			"menu.archiveSession": "归档会话",
			"menu.unarchiveSession": "取消归档",
			"menu.pinSession": "置顶会话",
			"menu.unpinSession": "取消置顶",
			"row.archived": "已归档",
			"row.pinned": "已置顶",
			"toast.archivedNotOpenable": "已归档对话暂时无法查看，请取消归档后查看",
			"toast.archived": "会话已归档，可",
			"toast.stoppedAndArchived": "已停止并归档，可",
			"archive.confirm.title": "停止并归档此会话？",
			"archive.confirm.desc": "“{title}”仍有正在进行的工作。归档会先停止这些工作；之后可在侧栏筛选“全部对话（显示已归档）”中恢复会话，被停止的工作不会自动继续。",
			"archive.confirm.activity": "将被停止的工作",
			"archive.confirm.turn": "进行中的回合",
			"archive.confirm.subagents.one": "{n} 个运行中的子智能体：{names}",
			"archive.confirm.subagents.other": "{n} 个运行中的子智能体：{names}",
			"archive.confirm.jobs.one": "{n} 个后台任务：{names}",
			"archive.confirm.jobs.other": "{n} 个后台任务：{names}",
			"archive.confirm.schedules.one": "{n} 条定时提醒：{names}",
			"archive.confirm.schedules.other": "{n} 条定时提醒：{names}",
			"archive.confirm.other.one": "{n} 项其他工作（{kind}）",
			"archive.confirm.other.other": "{n} 项其他工作（{kind}）",
			"archive.confirm.listSeparator": "、",
			"archive.confirm.action": "停止并归档",
			"archive.confirm.pending": "正在停止并归档…",
			"toast.archivedUndo": "撤销",
			"toast.archivedOr": "或",
			"toast.archivedFilter": "筛选已归档会话",
			"toast.pinFailed": "置顶失败，请稍后重试",
			"toast.unpinFailed": "取消置顶失败，请稍后重试",
			"toast.createFailed": "新建会话失败：{message}",
			"sessions.count.one": "{n} 个会话",
			"sessions.count.other": "{n} 个会话",
			"actions.workspace.aria": "工作区“{name}”的操作",
			"actions.project.aria": "项目“{name}”的操作",
			"actions.session.aria": "会话“{name}”的操作",
			"actions.archive": "归档会话",
			"actions.unarchive": "取消归档",
			"actions.pin": "置顶会话",
			"actions.unpin": "取消置顶",
			"actions.newSession": "新会话",
			"actions.newSession.aria": "在“{name}”中新建会话",
			"status.running": "进行中",
			"status.subagentsRunning.one": "{n} 个子智能体运行中",
			"status.subagentsRunning.other": "{n} 个子智能体运行中",
			"status.idle": "空闲",
			"status.waitingApproval": "等待审批",
			"status.planReview": "计划待审",
			"status.waitingAnswer": "等待回答",
			"status.compact.approval": "待审批",
			"status.compact.planReview": "计划待审",
			"status.compact.answer": "待回答",
			"status.completed": "已完成",
			"hover.created": "创建于 {time}",
			"hover.copied": "已复制",
			"date.ymd": "{y}年{m}月{d}日",
			"time.now": "刚刚",
			"time.minutes": "{n}分钟",
			"time.hours": "{n}小时",
			"time.days": "{n}天",
			"time.months": "{n}个月",
			"time.years": "{n}年",
			"time.ago": "{t}前"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en$1 = {
			"defaultWorkspace.failed": "Unable to create default workspace. Use Choose workspace to select a folder.",
			"group.ungrouped": "Ungrouped",
			"session.new": "New Session",
			"shortcut.noSession": "Select a session first",
			"shortcut.noPicker": "Directory picker unavailable",
			"shortcut.directoryBusy": "Selecting or adding a workspace",
			"shortcut.noCompletedTurn": "This session has no completed turn",
			"shortcut.forkFailed": "Could not fork the session. Try again.",
			"section.workspaces": "Workspaces",
			"section.sessions": "Sessions",
			"viewOptions.label": "View options",
			"groupBy.label": "Group by",
			"groupBy.workspace": "WorkSpace",
			"groupBy.workspaceTree": "Workspace Tree",
			"groupBy.flat": "In one list",
			"orderBy.label": "Order by",
			"orderBy.manual": "Manual",
			"orderBy.updated": "Last updated",
			"filterBy.label": "Filter sessions",
			"viewOptions.hideArchived": "Hide archived",
			"viewOptions.showArchived": "All conversations (show archived)",
			"viewOptions.onlyArchived": "Archived only",
			"sessions.expand": "Show {n} more sessions",
			"sessions.collapse": "Show less",
			"empty.none": "No sessions yet",
			"empty.noneArchived": "No archived sessions yet",
			"empty.viewOthers": "View other sessions",
			"empty.noMatches": "No matches",
			"workspace.add": "Add workspace",
			"project.add": "New project",
			"project.create.title": "New project",
			"project.create.placeholder": "Project name",
			"field.projectName": "Project name",
			"create": "Create",
			"rename.project.title": "Rename project",
			"delete.project": "Delete project",
			"delete.project.desc": "This deletes the project “{name}”. Its sessions are not deleted; they return to Ungrouped.",
			"delete.project.pending": "Deleting project…",
			"baseMissing.title": "Base workspace missing",
			"baseMissing.body": "It is where every session this plugin creates lands; without it, no session can be started.",
			"baseMissing.path": "Missing: {path}",
			"baseMissing.pathUnknown": "Missing: the default workspace (path unknown)",
			"baseMissing.rebuild": "Re-create this workspace",
			"baseMissing.respecify": "Choose another base workspace",
			"baseMissing.confirmTitle": "Confirm re-creation",
			"baseMissing.confirmBody": "This creates the directory at that path and registers it as a workspace. If it already exists, its contents are left untouched.",
			"baseMissing.confirmAction": "Re-create",
			"baseMissing.confirmBusy": "Re-creating…",
			"baseMissing.confirmBack": "Back",
			"search.sessions.aria": "Search sessions",
			"search.placeholder": "Search session names",
			"search.clear": "Clear search",
			"search.results.aria": "Search results",
			"search.pending": "Searching session history…",
			"search.noMatches": "No matching sessions",
			"search.hasMore": "Showing the first {n} results. Narrow your search.",
			"menu.addWorkspace": "Add workspace…",
			"picker.loading": "Loading workspaces…",
			"conflict.named": "A workspace named “{name}” already exists.",
			"folderError.title": "Couldn’t open folder",
			"folderError.retry": "Choose again",
			"rename": "Rename",
			"rename.workspace.title": "Rename workspace",
			"rename.session.title": "Rename session",
			"field.workspaceName": "Workspace name",
			"field.sessionName": "Session name",
			"delete.workspace": "Delete workspace",
			"delete.desc": "This removes “{name}” from the workspace list. The folder and session logs will be kept. Its sessions will appear under Ungrouped.",
			"delete.pending": "Deleting workspace…",
			"menu.fork": "Fork session",
			"menu.archiveSession": "Archive session",
			"menu.unarchiveSession": "Unarchive session",
			"menu.pinSession": "Pin session",
			"menu.unpinSession": "Unpin session",
			"row.archived": "Archived",
			"row.pinned": "Pinned",
			"toast.archivedNotOpenable": "Archived sessions cannot be opened. Unarchive it to view.",
			"toast.archived": "Session archived. You can ",
			"toast.stoppedAndArchived": "Session stopped and archived. You can ",
			"archive.confirm.title": "Stop and archive this session?",
			"archive.confirm.desc": "“{title}” still has work in progress. Archiving stops it first; you can restore the session later from the “All conversations (show archived)” filter in the sidebar, and the stopped work will not resume on its own.",
			"archive.confirm.activity": "Work that will be stopped",
			"archive.confirm.turn": "The turn in progress",
			"archive.confirm.subagents.one": "{n} running subagent: {names}",
			"archive.confirm.subagents.other": "{n} running subagents: {names}",
			"archive.confirm.jobs.one": "{n} background job: {names}",
			"archive.confirm.jobs.other": "{n} background jobs: {names}",
			"archive.confirm.schedules.one": "{n} scheduled reminder: {names}",
			"archive.confirm.schedules.other": "{n} scheduled reminders: {names}",
			"archive.confirm.other.one": "{n} other item of work ({kind})",
			"archive.confirm.other.other": "{n} other items of work ({kind})",
			"archive.confirm.listSeparator": ", ",
			"archive.confirm.action": "Stop and archive",
			"archive.confirm.pending": "Stopping and archiving…",
			"toast.archivedUndo": "undo",
			"toast.archivedOr": " or ",
			"toast.archivedFilter": "filter archived sessions",
			"toast.pinFailed": "Pin failed. Try again later.",
			"toast.unpinFailed": "Unpin failed. Try again later.",
			"toast.createFailed": "New session failed: {message}",
			"sessions.count.one": "{n} session",
			"sessions.count.other": "{n} sessions",
			"actions.workspace.aria": "Workspace actions for {name}",
			"actions.project.aria": "Project actions for {name}",
			"actions.session.aria": "Session actions for {name}",
			"actions.archive": "Archive",
			"actions.unarchive": "Unarchive",
			"actions.pin": "Pin",
			"actions.unpin": "Unpin",
			"actions.newSession": "New session",
			"actions.newSession.aria": "New session in {name}",
			"status.running": "Running",
			"status.subagentsRunning.one": "{n} subagent running",
			"status.subagentsRunning.other": "{n} subagents running",
			"status.idle": "Idle",
			"status.waitingApproval": "Waiting for approval",
			"status.planReview": "Plan awaiting review",
			"status.waitingAnswer": "Waiting for answer",
			"status.compact.approval": "Approval",
			"status.compact.planReview": "Plan review",
			"status.compact.answer": "Answer",
			"status.completed": "Completed",
			"hover.created": "Created {time}",
			"hover.copied": "Copied",
			"date.ymd": "{y}-{m}-{d}",
			"time.now": "now",
			"time.minutes": "{n}min",
			"time.hours": "{n}h",
			"time.days": "{n}d",
			"time.months": "{n}mo",
			"time.years": "{n}y",
			"time.ago": "{t} ago"
		};
		//#endregion
		//#region src/vendored/client/index.ts
		/** Dictionary namespace owned by this plugin. */
		const NS = "workspace";
		/**
		* Required services (cordis fiber inject). The target slots are declared by
		* the ui-sidebar / ui-conversation applies, whose activation order relative
		* to this one is NOT constrained: dsh.client.inject edges are informational
		* (loading/prefetch metadata, never apply sequencing) and neither owner
		* provides a waitable service. apply therefore depends on each slot
		* declaration through `slots.inject()` instead of assuming order.
		*/
		const inject$1 = [
			"slots",
			"sessions",
			"workspaces",
			"locale",
			"remote",
			"remote.directoryPicker",
			"layout",
			"shortcuts"
		];
		/** No caller-owned group has been touched: the default `expansions` snapshot. */
		const EMPTY_EXPANSIONS$1 = Object.freeze({});
		/** No caller-owned group has a recorded order: the default `orders` snapshot. */
		const EMPTY_ORDERS$1 = Object.freeze({});
		/**
		* Register the browser and picker once their slot declarations are on the
		* ledger. Inject factories return plain callbacks; data reads use the
		* framework's global hooks.
		* @param ctx - client root context.
		* @param groupingOverride - optional grouping model. Omitted — how the loader
		* calls this on an unmodified composition — the region groups by the Host
		* Workspace registry exactly as upstream. Supplied, the region renders those
		* groups instead, while Sessions keep their real Workspace account, `cwd`, and
		* archive state; see `contract/slots.ts` `grouping` and `tree.ts`
		* `GroupSource`.
		* @param projectActions - optional verbs behind the region's project rows.
		* Omitted, the header keeps the directory flow and caller-supplied groups have
		* no row actions.
		* @param expansionsOverride - optional record of caller-supplied groups'
		* expansion, keyed by group key. Omitted, every group's expansion lives in this
		* browser's own view store, exactly as upstream. Supplied, the caller owns that
		* state and this browser only reads and reports it — which is what lets a
		* caller keep it somewhere the official plugin's mount cannot prune.
		* @param ordersOverride - optional record of caller-supplied groups' manual
		* member order, keyed by group key. Omitted, every group's order lives in this
		* browser's own view store, exactly as upstream. Supplied, the caller owns it,
		* for the same reason as `expansionsOverride`.
		*/
		function apply$1(ctx, groupingOverride, projectActions, expansionsOverride, ordersOverride) {
			const sessions = ctx.get("sessions");
			const workspaces = ctx.get("workspaces");
			const viewHandle = createWorkspaceViewStore();
			const viewInstance = viewHandle.create();
			const viewStore = {
				...viewHandle,
				create: () => viewInstance
			};
			const rowToast = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(null);
			let toastSeq = 0;
			const notify = (toast) => {
				rowToast.set({
					...toast,
					seq: ++toastSeq
				});
			};
			const placeUnscoped = projectActions?.placeUnscopedSession === void 0 ? void 0 : (sessionId, currentSessionId) => {
				const byId = sessions.list.getSnapshot().byId;
				const activity = {};
				for (const [id, summary] of Object.entries(byId)) if (summary !== void 0 && !summary.blank) activity[id] = summary.updatedAt;
				projectActions.placeUnscopedSession?.({
					sessionId,
					currentSessionId,
					updatedAt: activity
				});
			};
			const uiWorkspace = new UiWorkspaceService(ctx, ctx.remote.directoryPicker, workspaces, sessions, viewInstance.actions, notify, placeUnscoped, (request) => {
				baseWorkspaceRequest.set(request);
				if (request.path !== null) return;
				projectActions?.defaultWorkspacePath?.(request).then((path) => {
					if (baseWorkspaceRequest.getSnapshot() !== request) return;
					baseWorkspaceRequest.set({
						...request,
						path
					});
				}).catch(() => {});
			}, projectActions?.resolveBaseWorkspace);
			ctx.slots.provideRoot({ hooks: { workspaces: workspaces.list } });
			ctx.effect(() => ctx.locale.register(NS, {
				zh: zh$1,
				en: en$1
			}), "ui-workspace: dictionaries");
			const shortcutControls = createWorkspaceShortcutControls();
			const searchSessions = async (query, signal) => {
				const result = await sessions.search(query, signal);
				if (!result.ok) throw new Error(result.error.message);
				return result.value;
			};
			const flowSource = (hole) => ({
				getSnapshot: () => ctx.slots.entries(hole).length > 0,
				subscribe: (listener) => ctx.slots.subscribe(hole, listener)
			});
			const browserFlowSource = flowSource("sidebar.workspaces.directoryFlow");
			const grouping = groupingOverride ?? {
				getSnapshot: () => void 0,
				subscribe: () => () => {}
			};
			const expansions = expansionsOverride ?? {
				getSnapshot: () => EMPTY_EXPANSIONS$1,
				subscribe: () => () => {}
			};
			const orders = ordersOverride ?? {
				getSnapshot: () => EMPTY_ORDERS$1,
				subscribe: () => () => {}
			};
			const hostInfo = {
				getSnapshot: () => ctx.remote.$host,
				subscribe: (listener) => ctx.on("connection/reset", listener)
			};
			const pickerFlowSource = flowSource("conversation.hero.workspace.directoryFlow");
			const openSession = (sessionId) => {
				uiWorkspace.openSession(sessionId);
			};
			const pinnedSet = derive(workspaces.list, (snapshot) => new Set(snapshot.pinnedSessionIds));
			const archivedSet = derive(workspaces.list, (snapshot) => new Set(snapshot.archivedSessionIds));
			const renameRequest = derive(shortcutControls.state, (state) => state.renameTarget);
			const archiveRequest = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(null);
			const baseWorkspaceRequest = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(null);
			const requestSessionRename = shortcutControls.rename;
			const unarchiveSession = (sessionId) => {
				uiWorkspace.unarchiveSession(sessionId).catch((reason) => {
					console.warn("session unarchive rejected:", reason);
				});
			};
			const renameSession = async (sessionId, title) => {
				const result = await sessions.using(sessionId, { source: "workspaceOperation" }, (reference) => reference.binding.session.rename(title));
				if (!result.ok) throw new Error(result.error.message);
			};
			const pinInjected = () => ({
				hooks: {
					pinned: pinnedSet,
					archived: archivedSet
				},
				pinSession: (sessionId) => {
					uiWorkspace.pinSession(sessionId).catch(() => {
						notify({ kind: "pinFailed" });
					});
				},
				unpinSession: (sessionId) => {
					uiWorkspace.unpinSession(sessionId).catch(() => {
						notify({ kind: "unpinFailed" });
					});
				}
			});
			const archiveInjected = () => ({
				hooks: { archived: archivedSet },
				archiveSession: (sessionId) => {
					uiWorkspace.archiveSession(sessionId).then(() => {
						notify({
							kind: "archived",
							sessionId
						});
					}).catch((reason) => {
						const activity = activeSessionRefusal(reason);
						if (activity === void 0) {
							console.warn("session archive rejected:", reason);
							return;
						}
						const displayTitle = sessions.list.getSnapshot().byId[sessionId]?.displayTitle ?? sessionId;
						archiveRequest.set({
							sessionId,
							displayTitle,
							activity
						});
					});
				},
				unarchiveSession
			});
			installWorkspaceShortcuts(ctx, uiWorkspace, shortcutControls, archiveInjected().archiveSession, projectActions !== void 0);
			const archiveConfirmInjected = () => ({
				hooks: { archiveRequest },
				settleSessionArchive: () => {
					archiveRequest.set(null);
				},
				stopAndArchiveSession: async (sessionId) => {
					await uiWorkspace.archiveSession(sessionId, { stopActivity: true });
					notify({
						kind: "stoppedAndArchived",
						sessionId
					});
				}
			});
			const baseWorkspaceInjected = () => ({
				hooks: { baseWorkspaceRequest },
				settleBaseWorkspaceMissing: () => {
					baseWorkspaceRequest.set(null);
				},
				rebuildBaseWorkspace: projectActions?.rebuildBaseWorkspace,
				chooseBaseWorkspace: projectActions?.chooseBaseWorkspace
			});
			const forkInjected = () => ({ forkSession: (sessionId) => {
				uiWorkspace.forkSession(sessionId).catch(() => {});
			} });
			const renameInjected = () => ({ requestSessionRename });
			const renameDialogInjected = () => ({
				hooks: { renameRequest },
				settleSessionRename: shortcutControls.closeRename,
				renameSession
			});
			const rowToastInjected = () => ({
				hooks: { toast: rowToast },
				dismissToast: () => {
					rowToast.set(null);
				},
				undoArchive: unarchiveSession,
				showArchived: () => {
					viewInstance.actions.setArchivedFilter("show");
				}
			});
			const browserInjected = () => ({
				startSession: (workspaceId, beforeOpen) => {
					uiWorkspace.startSession(workspaceId, beforeOpen);
				},
				open: openSession,
				searchSessions,
				searchResultLimit: sessions.searchResultLimit,
				requestSessionRename,
				notifyArchivedNotOpenable: () => {
					notify({ kind: "archivedNotOpenable" });
				},
				renameWorkspace: async (workspaceId, title) => {
					await workspaces.rename(workspaceId, title);
				},
				deleteWorkspace: async (workspaceId) => {
					await workspaces.delete(workspaceId);
				},
				insertWorkspaceBefore: async (workspaceId, beforeWorkspaceId) => {
					await workspaces.insertBefore(workspaceId, beforeWorkspaceId);
				},
				unarchiveSession: async (sessionId) => {
					await uiWorkspace.unarchiveSession(sessionId);
				},
				createWorkspace: (input) => workspaces.create(input),
				requestSearch: shortcutControls.search,
				requestAddWorkspace: shortcutControls.add,
				closeAddWorkspace: shortcutControls.closeAdd,
				setDirectoryBusy: shortcutControls.directoryBusy,
				dismissForkError: shortcutControls.dismissForkError,
				...projectActions === void 0 ? {} : {
					createProject: projectActions.createProject,
					renameProject: projectActions.renameProject,
					deleteProject: projectActions.deleteProject,
					reorderProject: projectActions.reorderProject,
					assignSession: projectActions.assignSession,
					unassignSession: projectActions.unassignSession,
					setProjectExpanded: projectActions.setProjectExpanded,
					setProjectOrders: projectActions.setProjectOrders
				},
				hooks: {
					directoryFlow: browserFlowSource,
					hostInfo,
					workspaceShortcuts: shortcutControls.state,
					shortcuts: ctx.shortcuts.catalog,
					grouping,
					expansions,
					orders
				}
			});
			const pickerInjected = () => ({
				createWorkspace: (input) => workspaces.create(input),
				hooks: { directoryFlow: pickerFlowSource }
			});
			ctx.slots.inject("sidebar.workspaces", () => ctx.slots.register({
				name: "sidebar.workspaces",
				children: {
					"sidebar.workspaces.directoryFlow": {
						kind: "single",
						scope: "root"
					},
					"sidebar.workspaces.session.menu.item": {
						kind: "list",
						scope: "root",
						inject: { hooks: {
							menuOpenState: menuOpenStateFactory,
							shortcuts: ctx.shortcuts.catalog
						} }
					},
					"sidebar.workspaces.session.row.action": {
						kind: "list",
						scope: "root"
					},
					"sidebar.session.row.leading": {
						kind: "list",
						scope: "root"
					},
					"sidebar.session.row.hover": {
						kind: "list",
						scope: "root"
					}
				},
				store: viewStore,
				inject: browserInjected,
				locale: NS
			}, WorkspaceBrowser));
			ctx.slots.inject("sidebar.workspaces.session.menu.item", function* () {
				yield ctx.slots.register({
					name: "sidebar.workspaces.session.menu.item",
					id: "pin",
					order: 100,
					locale: NS,
					inject: pinInjected
				}, PinSessionMenuItem);
				yield ctx.slots.register({
					name: "sidebar.workspaces.session.menu.item",
					id: "rename",
					order: 200,
					locale: NS,
					inject: renameInjected
				}, RenameSessionMenuItem);
				yield ctx.slots.register({
					name: "sidebar.workspaces.session.menu.item",
					id: "fork",
					order: 300,
					locale: NS,
					inject: forkInjected
				}, ForkSessionMenuItem);
				yield ctx.slots.register({
					name: "sidebar.workspaces.session.menu.item",
					id: "archive",
					order: 400,
					locale: NS,
					inject: archiveInjected
				}, ArchiveSessionMenuItem);
			});
			ctx.slots.inject("sidebar.workspaces.session.row.action", function* () {
				yield ctx.slots.register({
					name: "sidebar.workspaces.session.row.action",
					id: "archive",
					order: 100,
					locale: NS,
					inject: archiveInjected
				}, ArchiveSessionRowButton);
				yield ctx.slots.register({
					name: "sidebar.workspaces.session.row.action",
					id: "pin",
					order: 200,
					locale: NS,
					inject: pinInjected
				}, PinSessionRowButton);
			});
			ctx.slots.inject("shell.overlay", function* () {
				yield ctx.slots.register({
					name: "shell.overlay",
					id: "workspace.session-rename",
					locale: NS,
					inject: renameDialogInjected
				}, SessionRenameDialog);
				yield ctx.slots.register({
					name: "shell.overlay",
					id: "workspace.session-archive",
					locale: NS,
					inject: archiveConfirmInjected
				}, SessionArchiveConfirmDialog);
				yield ctx.slots.register({
					name: "shell.overlay",
					id: "workspace.base-missing",
					locale: NS,
					inject: baseWorkspaceInjected
				}, BaseWorkspaceMissingDialog);
				yield ctx.slots.register({
					name: "shell.overlay",
					id: "workspace.row-toast",
					locale: NS,
					store: viewStore,
					inject: rowToastInjected
				}, RowActionToast);
			});
			ctx.slots.inject("conversation.hero.workspace", () => ctx.slots.register({
				name: "conversation.hero.workspace",
				children: { "conversation.hero.workspace.directoryFlow": {
					kind: "single",
					scope: "root"
				} },
				inject: pickerInjected,
				locale: NS
			}, WorkspacePicker));
		}
		/**
		* The activity a Host `workspace/session-active` refusal reported, or nothing
		* for any other failure. The class identity check goes by name: client plugin
		* bundles do not share error-class identity.
		*/
		function activeSessionRefusal(reason) {
			if (!(reason instanceof Error) || reason.name !== "WorkspaceArchiveError") return void 0;
			const { rpcError } = reason;
			return rpcError.code === "workspace/session-active" ? rpcError.details.activity : void 0;
		}
		//#endregion
		//#region src/client/grouping.ts
		/** The override with no projects: one Ungrouped bucket. */
		const EMPTY = Object.freeze([]);
		/** No project row has been touched yet. */
		const EMPTY_EXPANSIONS = Object.freeze({});
		/** No project has a recorded manual order. */
		const EMPTY_ORDERS = Object.freeze({});
		/**
		* The live model, or `undefined` before the Remote namespace has answered.
		*
		* Module-level because the browser's inject face is registered during `apply`
		* while the model only becomes usable once its baseline lands; both must resolve
		* the same instance.
		*/
		let model;
		/** Listeners attached before the model existed, handed to it on install. */
		const pending = /* @__PURE__ */ new Set();
		/** The same, for {@link clientExpansions}; the two observables have separate seats. */
		const pendingExpansions = /* @__PURE__ */ new Set();
		/** The same, for {@link clientOrders}. */
		const pendingOrders = /* @__PURE__ */ new Set();
		/** The same, for {@link clientNewSessionTarget}. */
		const pendingTargets = /* @__PURE__ */ new Set();
		/** The same, for {@link clientBaseWorkspace}. */
		const pendingBase = /* @__PURE__ */ new Set();
		/** @returns the live model, once its baseline has landed. */
		function projectModel() {
			return model;
		}
		/**
		* Adopt the started model and wake any listeners that subscribed early.
		*
		* The browser subscribes to {@link clientGrouping} during its own registration,
		* which can precede the Remote baseline; those subscribers read an empty
		* snapshot then, and nothing would tell them the real one had arrived. They are
		* re-registered on the live model and notified once for the change in identity.
		* @param started - the started model.
		*/
		function installProjectModel(started) {
			model = started;
			const early = [...pending];
			pending.clear();
			for (const notify of early) started.grouping.subscribe(notify);
			for (const notify of early) notify();
			const earlyExpansions = [...pendingExpansions];
			pendingExpansions.clear();
			for (const notify of earlyExpansions) started.expansions.subscribe(notify);
			for (const notify of earlyExpansions) notify();
			const earlyOrders = [...pendingOrders];
			pendingOrders.clear();
			for (const notify of earlyOrders) started.orders.subscribe(notify);
			for (const notify of earlyOrders) notify();
			const earlyTargets = [...pendingTargets];
			pendingTargets.clear();
			for (const notify of earlyTargets) started.newSessionTarget$.subscribe(notify);
			for (const notify of earlyTargets) notify();
			const earlyBase = [...pendingBase];
			pendingBase.clear();
			for (const notify of earlyBase) started.baseWorkspace$.subscribe(notify);
			for (const notify of earlyBase) notify();
		}
		/**
		* The observable handed to the vendored browser.
		*
		* Reads through the module-level model so the browser may register before the
		* Remote namespace is ready: until the first baseline lands the snapshot is an
		* empty override, which renders exactly what a fresh install looks like.
		*/
		const clientGrouping = {
			getSnapshot: () => model?.grouping.getSnapshot() ?? EMPTY,
			subscribe: (listener) => {
				const live = model;
				if (live === void 0) {
					pending.add(listener);
					return () => {
						pending.delete(listener);
					};
				}
				return live.grouping.subscribe(listener);
			}
		};
		/**
		* The recorded expansion of each project row, handed to the vendored browser.
		*
		* A separate observable from {@link clientGrouping} because it is a separate
		* seat in the inject face: the region reads it with its own hook. It carries the
		* plugin's own Host state rather than the browser's view store, which the
		* official plugin shares and prunes — see `src/vendored/README.md`.
		*/
		const clientExpansions = {
			getSnapshot: () => model?.expansions.getSnapshot() ?? EMPTY_EXPANSIONS,
			subscribe: (listener) => {
				const live = model;
				if (live === void 0) {
					pendingExpansions.add(listener);
					return () => {
						pendingExpansions.delete(listener);
					};
				}
				return live.expansions.subscribe(listener);
			}
		};
		/**
		* The recorded manual order of each project's members, handed to the vendored
		* browser.
		*
		* Its own seat, for the same reason as {@link clientExpansions}: the region reads
		* it with its own hook, and it carries the plugin's Host state rather than the
		* view store the official plugin shares and prunes.
		*/
		const clientOrders = {
			getSnapshot: () => model?.orders.getSnapshot() ?? EMPTY_ORDERS,
			subscribe: (listener) => {
				const live = model;
				if (live === void 0) {
					pendingOrders.add(listener);
					return () => {
						pendingOrders.delete(listener);
					};
				}
				return live.orders.subscribe(listener);
			}
		};
		/**
		* The stored New Session destination, for this plugin's own settings card.
		*
		* Its own seat rather than a read of {@link projectModel} at render time: the
		* card can register before the Remote baseline lands, and it must follow later
		* changes (the optimistic write, and the Host's `follow` frame) like every other
		* observable here.
		*
		* Deliberately **not** handed to the vendored browser. That half renders groups
		* and has no business knowing where an unscoped New Session goes; the choice is
		* spent in `index.ts` when a Session actually lands, so only the settings card
		* needs to read it.
		*
		* Before the model exists the snapshot is `'ungrouped'`, matching
		* `EMPTY_STATE.newSessionTarget` and the Host's own default — so the card shows
		* the value a fresh install would actually use rather than a blank.
		*/
		const clientNewSessionTarget = {
			getSnapshot: () => model?.target() ?? "ungrouped",
			subscribe: (listener) => {
				const live = model;
				if (live === void 0) {
					pendingTargets.add(listener);
					return () => {
						pendingTargets.delete(listener);
					};
				}
				return live.newSessionTarget$.subscribe(listener);
			}
		};
		/** The base-workspace setting a fresh install uses: the official default Workspace. */
		const DEFAULT_BASE_WORKSPACE = Object.freeze({ mode: "default" });
		/**
		* The stored base workspace, for this plugin's own settings card.
		*
		* Its own seat, for the same reason as {@link clientNewSessionTarget}: the card can
		* register before the Remote baseline lands, and it must follow later changes (the
		* optimistic write, and the Host's `follow` frame).
		*
		* Deliberately **not** handed to the vendored browser: that half renders groups, and
		* the setting is spent elsewhere — by the card that writes it, and by the resolver
		* that chooses where a New Session lands.
		*
		* Before the model exists the snapshot is `{ mode: 'default' }`, which is both what
		* `EMPTY_STATE` carries and what the Host defaults to — so the card shows the value a
		* fresh install would actually use rather than a blank.
		*/
		const clientBaseWorkspace = {
			getSnapshot: () => model?.baseWorkspaceSetting() ?? DEFAULT_BASE_WORKSPACE,
			subscribe: (listener) => {
				const live = model;
				if (live === void 0) {
					pendingBase.add(listener);
					return () => {
						pendingBase.delete(listener);
					};
				}
				return live.baseWorkspace$.subscribe(listener);
			}
		};
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
		//#region src/client/projects.ts
		const EMPTY_STATE = Object.freeze({
			projects: Object.freeze([]),
			assignments: Object.freeze({}),
			expansions: Object.freeze({}),
			orders: Object.freeze({}),
			newSessionTarget: "ungrouped",
			baseWorkspace: Object.freeze({ mode: "default" })
		});
		/**
		* Field-wise equality for a base-workspace setting.
		*
		* Identity cannot be used: every `follow` frame lands a fresh object, so a card that
		* re-writes the mode it is already on would issue a redundant round trip on each
		* render. `name` is compared too — two Workspaces may share a title, so mode+path
		* alone would read a switch between them as no change.
		* @param left - one setting.
		* @param right - the other.
		* @returns whether the two would store the same value.
		*/
		function sameBaseWorkspace(left, right) {
			return left.mode === right.mode && (left.path ?? "") === (right.path ?? "") && (left.name ?? "") === (right.name ?? "");
		}
		/** Unwrap one Remote outcome, turning a failure into a thrown error. */
		function unwrap(outcome, what) {
			if (!outcome.ok) throw new Error(outcome.error?.message ?? `${what} failed`);
			return outcome.value;
		}
		/**
		* Client-side projection of the Host's project registry.
		*
		* A single instance is shared with the sidebar's inject face; see
		* `src/client/index.ts`.
		*/
		var ProjectModel = class {
			remote;
			state = EMPTY_STATE;
			derived;
			listeners = /* @__PURE__ */ new Set();
			/**
			* Placements written locally but not yet echoed by the Host.
			*
			* Session id → the target the user chose (`undefined` for Ungrouped) and the
			* token of that particular write. Overlaid onto every incoming baseline while
			* it lives: a frame produced *before* our write carries the previous owner, and
			* letting it through would revert the row for one render — the very move the
			* optimistic write exists to prevent.
			*
			* The **token**, not the value, identifies a write. Two writes of the *same*
			* target can be in flight for one Session (B → A → B), and the oldest one
			* failing must not clear the newest one's entry.
			*
			* Entries are retired when the Host echoes them, which is what makes this
			* self-terminating: the Host re-projects a full baseline after every landed
			* write, so "the frame carries our value" is "our write has landed". No timer.
			*
			* Known limit: a write the Host accepts but never echoes leaves its entry in
			* place, pinning that one Session's owner locally. The preconditions that make
			* this harmless are that the owner is written only through this class and that
			* one client is connected. If either stops holding, the fix is a generation
			* number on the baseline — not a timeout.
			*/
			pendingPlacements = /* @__PURE__ */ new Map();
			/** Monotonic write id; see {@link pendingPlacements}. */
			placementSeq = 0;
			/**
			* @param remote - the mounted `projectGroups` namespace.
			*/
			constructor(remote) {
				this.remote = remote;
			}
			/**
			* The grouping source handed to the vendored browser.
			*
			* Never `undefined`: see the module doc on why "no override" is a different
			* state from "an override with nothing in it".
			*/
			grouping = {
				getSnapshot: () => this.groupingSnapshot(),
				subscribe: (listener) => {
					this.listeners.add(listener);
					return () => {
						this.listeners.delete(listener);
					};
				}
			};
			/**
			* The recorded expansion of each project row.
			*
			* Served from this plugin's own Host domain rather than the browser's view
			* store, because that store is shared with the official plugin and its mount
			* prunes every non-Workspace key — which is what losing the state on a plugin
			* switch actually was.
			*
			* Only touched rows appear. The browser reads absence as "never opened", which
			* is what lets it auto-open the group holding the current Session once.
			*/
			expansions = {
				getSnapshot: () => this.state.expansions,
				subscribe: (listener) => {
					this.listeners.add(listener);
					return () => {
						this.listeners.delete(listener);
					};
				}
			};
			/**
			* The recorded manual order of each project's members.
			*
			* Served from this plugin's own Host domain for the same reason as
			* {@link expansions}: the browser's view store is shared with the official
			* plugin, whose mount prunes every key that is not a Workspace id.
			*
			* Only projects with a recorded order appear. A missing entry means "derive
			* position from recency", which is not the same as an empty list.
			*/
			orders = {
				getSnapshot: () => this.state.orders,
				subscribe: (listener) => {
					this.listeners.add(listener);
					return () => {
						this.listeners.delete(listener);
					};
				}
			};
			/**
			* Where an unscoped New Session lands.
			*
			* Unlike {@link grouping}, {@link expansions} and {@link orders}, this is never
			* handed to the vendored browser: the sidebar renders groups and knows nothing
			* about New Session destinations. It exists for the settings card and for the
			* placement policy, both of which live in `src/client/`.
			*/
			newSessionTarget$ = {
				getSnapshot: () => this.state.newSessionTarget,
				subscribe: (listener) => {
					this.listeners.add(listener);
					return () => {
						this.listeners.delete(listener);
					};
				}
			};
			/**
			* The base-workspace setting, for the settings card.
			*
			* Its own observable for the same reason as {@link newSessionTarget$}: it is a seat
			* the card reads with its own hook, and it is never handed to the vendored browser,
			* which renders groups and has no business knowing where Sessions land.
			*/
			baseWorkspace$ = {
				getSnapshot: () => this.state.baseWorkspace,
				subscribe: (listener) => {
					this.listeners.add(listener);
					return () => {
						this.listeners.delete(listener);
					};
				}
			};
			/** @returns projects in display order. */
			list() {
				return this.state.projects;
			}
			/** @returns the project with this id, or undefined. */
			get(id) {
				return this.state.projects.find((project) => project.projectId === id);
			}
			/** @returns the id of the project owning this Session, or undefined. */
			projectOf(sessionId) {
				return this.state.assignments[sessionId];
			}
			/** @returns the Session ids filed under this project, in no particular order. */
			membersOf(projectId) {
				return Object.entries(this.state.assignments).filter(([, owner]) => owner === projectId).map(([sessionId]) => sessionId);
			}
			/** @returns where an unscoped New Session should land. */
			target() {
				return this.state.newSessionTarget;
			}
			/** @returns the stored base-workspace setting. */
			baseWorkspaceSetting() {
				return this.state.baseWorkspace;
			}
			/**
			* Load the Host's current projection and subscribe to its changes.
			* @returns a disposer that stops following.
			*/
			async start() {
				const baseline = await this.remote.baseline();
				if (!baseline.ok) throw new Error(baseline.error?.message ?? "project baseline failed");
				this.accept(baseline.value);
				const handle = this.remote;
				const controller = new AbortController();
				(async () => {
					try {
						for await (const frame of handle.follow(controller.signal)) this.acceptFrame(frame);
					} catch (error) {
						console.warn("project stream ended:", error);
					}
				})();
				return () => {
					controller.abort();
				};
			}
			/** Create a project; the state updates when the Host's write reaches the stream. */
			async create(title) {
				unwrap(await this.remote.create({ title: title.trim() }), "create project");
			}
			/** Retitle a project. */
			async rename(projectId, title) {
				unwrap(await this.remote.rename({
					projectId,
					title: title.trim()
				}), "rename project");
			}
			/** Delete a project; its Sessions return to Ungrouped on the Host. */
			async remove(projectId) {
				unwrap(await this.remote.delete({ projectId }), "delete project");
			}
			/** Move a project before another; an absent anchor appends. */
			async reorder(projectId, beforeId) {
				unwrap(await this.remote.reorder(beforeId === void 0 ? { projectId } : {
					projectId,
					beforeId
				}), "reorder project");
			}
			/** File a Session under a project, replacing any previous assignment. */
			async assign(sessionId, projectId) {
				await this.place(sessionId, projectId);
			}
			/** Return a Session to Ungrouped. */
			async unassign(sessionId) {
				await this.place(sessionId, void 0);
			}
			/**
			* Replace the assignment map, invalidate the derived grouping, and notify.
			*
			* Clearing `derived` is not optional the way it is for the other optimistic
			* setters: the sidebar's groups are **derived from this map** and the derived
			* snapshot is cached by identity (`groupingSnapshot`), so an assignment written
			* without this would leave the row rendered under its previous owner, with no
			* error anywhere to say so.
			* @param assignments - the complete map to store.
			*/
			applyAssignments(assignments) {
				this.state = Object.freeze({
					...this.state,
					assignments: Object.freeze(assignments)
				});
				this.derived = void 0;
				for (const listener of [...this.listeners]) listener();
			}
			/**
			* One entry replaced, every other entry preserved.
			*
			* `delete` rather than assigning `undefined`: absence is what Ungrouped *means*,
			* and both `sameAssignments` and `groupingSnapshot` walk `Object.keys`, so a
			* present key holding `undefined` would count as an owner.
			* @param assignments - the map to copy.
			* @param sessionId - the Session to place.
			* @param projectId - the owner, or `undefined` for Ungrouped.
			* @returns the new map.
			*/
			withPlacement(assignments, sessionId, projectId) {
				const next = { ...assignments };
				if (projectId === void 0) delete next[sessionId];
				else next[sessionId] = projectId;
				return next;
			}
			/**
			* File a Session under a project, or return it to Ungrouped, optimistically.
			*
			* Optimistic because the sidebar renders this map directly. When a New Session
			* is clicked into a project, its row is created holding whatever assignment the
			* reused blank Session already carried — so a write that waits for the Host
			* renders that row under the project it is *leaving*, and only then glides to
			* the one it is joining. That is exactly why one project's ＋ faded while
			* another project's ＋ moved: the two differ solely in whether the owner
			* changed.
			*
			* The Host stays authoritative: `follow` replaces this state wholesale, so a
			* refusal is corrected rather than left wrong.
			* @param sessionId - the Session to file.
			* @param projectId - the owning project, or `undefined` for Ungrouped.
			*/
			async place(sessionId, projectId) {
				const before = this.state.assignments[sessionId];
				if (before === projectId) return;
				const token = ++this.placementSeq;
				this.pendingPlacements.set(sessionId, {
					projectId,
					token
				});
				this.applyAssignments(this.withPlacement(this.state.assignments, sessionId, projectId));
				try {
					const outcome = projectId === void 0 ? await this.remote.unassign({ sessionId }) : await this.remote.assign({
						sessionId,
						projectId
					});
					if (!outcome.ok) throw new Error(outcome.error?.message ?? "place session failed");
				} catch (error) {
					if (this.pendingPlacements.get(sessionId)?.token !== token) throw error;
					this.pendingPlacements.delete(sessionId);
					this.applyAssignments(this.withPlacement(this.state.assignments, sessionId, before));
					throw error;
				}
			}
			/**
			* Record whether one project row is open.
			*
			* Optimistic: the local map moves first so a click lands in the same frame, and
			* the Host is still authoritative — `follow` re-projects on every landed write,
			* so a refusal is corrected by the next frame rather than left wrong. The
			* rejection is rethrown so a caller that wants to surface it can, and the
			* revert happens regardless.
			* @param projectId - target project.
			* @param expanded - new state.
			*/
			async setExpanded(projectId, expanded) {
				const previous = this.state.expansions;
				if (previous[projectId] === expanded) return;
				this.state = Object.freeze({
					...this.state,
					expansions: Object.freeze({
						...previous,
						[projectId]: expanded
					})
				});
				for (const listener of [...this.listeners]) listener();
				try {
					unwrap(await this.remote.setExpanded({
						projectId,
						expanded
					}), "set project expansion");
				} catch (error) {
					if (this.state.expansions[projectId] === expanded) {
						this.state = Object.freeze({
							...this.state,
							expansions: previous
						});
						for (const listener of [...this.listeners]) listener();
					}
					throw error;
				}
			}
			/**
			* Replace the manual order of every project.
			*
			* Optimistic like {@link setExpanded}, and for the same reason: a drop has to
			* land in the frame the pointer is released in, or the row visibly springs back
			* before the Host's frame arrives. The Host stays authoritative — its `follow`
			* frame replaces this state wholesale — so a refusal is corrected rather than
			* left wrong.
			*
			* A project omitted from `orders` loses its record, which is how recency mode
			* discards manual order.
			* @param orders - the complete map to store.
			*/
			async setOrders(orders) {
				const previous = this.state.orders;
				const next = Object.freeze(Object.fromEntries(Object.entries(orders).map(([projectId, sessionIds]) => [projectId, Object.freeze([...sessionIds])])));
				if (sameOrders(previous, next)) return;
				this.state = Object.freeze({
					...this.state,
					orders: next
				});
				for (const listener of [...this.listeners]) listener();
				try {
					unwrap(await this.remote.setOrders({ orders: next }), "set project orders");
				} catch (error) {
					if (sameOrders(this.state.orders, next)) {
						this.state = Object.freeze({
							...this.state,
							orders: previous
						});
						for (const listener of [...this.listeners]) listener();
					}
					throw error;
				}
			}
			/**
			* Choose where a New Session with no stated destination lands.
			*
			* Optimistic like {@link setExpanded}, and for the same reason: the settings
			* card should reflect the choice in the frame it is clicked in. The Host stays
			* authoritative — its `follow` frame replaces this state wholesale — so a
			* refusal is corrected rather than left wrong.
			* @param target - the chosen destination.
			*/
			async setNewSessionTarget(target) {
				const previous = this.state.newSessionTarget;
				if (previous === target) return;
				this.state = Object.freeze({
					...this.state,
					newSessionTarget: target
				});
				for (const listener of [...this.listeners]) listener();
				try {
					unwrap(await this.remote.setNewSessionTarget({ target }), "set new session target");
				} catch (error) {
					if (this.state.newSessionTarget === target) {
						this.state = Object.freeze({
							...this.state,
							newSessionTarget: previous
						});
						for (const listener of [...this.listeners]) listener();
					}
					throw error;
				}
			}
			/**
			* Store the base workspace: the Workspace every New Session lands in.
			*
			* Optimistic like {@link setNewSessionTarget}, and for the same reason: the card
			* should show the chosen card as selected in the frame it is confirmed in. The Host
			* stays authoritative — its `follow` frame replaces this state wholesale — so a
			* refusal is corrected rather than left wrong.
			* @param setting - the chosen mode and, for `'specified'`, the Workspace.
			*/
			async setBaseWorkspace(setting) {
				const previous = this.state.baseWorkspace;
				const next = setting.mode === "default" ? withDefaultMode(previous) : setting;
				if (sameBaseWorkspace(previous, next)) return;
				this.state = Object.freeze({
					...this.state,
					baseWorkspace: Object.freeze({ ...next })
				});
				for (const listener of [...this.listeners]) listener();
				try {
					unwrap(await this.remote.setBaseWorkspace({ ...next }), "set base workspace");
				} catch (error) {
					if (sameBaseWorkspace(this.state.baseWorkspace, next)) {
						this.state = Object.freeze({
							...this.state,
							baseWorkspace: previous
						});
						for (const listener of [...this.listeners]) listener();
					}
					throw error;
				}
			}
			/**
			* Re-create the base Workspace on the Host.
			*
			* Deliberately **not** optimistic, unlike every other write in this class. The others change
			* state the user is already looking at, where a slow round trip reads as lag; this one creates a
			* directory and a registry row, and a failure has to reach the dialog rather than be painted
			* over. The resulting state arrives over `follow` like any other Host change.
			* @returns the repaired Workspace and the setting's mode afterwards.
			*/
			async rebuildBaseWorkspace() {
				return unwrap(await this.remote.rebuildBaseWorkspace(), "rebuild the base workspace");
			}
			/**
			* Ask the Host where the official default Workspace would live.
			*
			* A pure read, used only to label the missing-基层工作区 dialog. A failure is not
			* propagated: the dialog already renders "path unknown", and turning a label into
			* a thrown error out of a click handler would be worse than the label.
			* @returns the derived path, or null when the Host cannot produce one.
			*/
			async defaultWorkspacePath() {
				try {
					return unwrap(await this.remote.defaultWorkspacePath(), "derive the default workspace path").path ?? null;
				} catch {
					return null;
				}
			}
			acceptFrame(frame) {
				if (frame.type === "baseline") {
					this.accept(frame.value);
					return;
				}
				console.warn("project frame ignored:", frame.type);
			}
			accept(baseline) {
				const projects = Object.freeze(baseline.projects.map((project) => Object.freeze({ ...project })));
				for (const [sessionId, entry] of this.pendingPlacements) if (baseline.assignments[sessionId] === entry.projectId) this.pendingPlacements.delete(sessionId);
				const overlaid = { ...baseline.assignments };
				for (const [sessionId, entry] of this.pendingPlacements) if (entry.projectId === void 0) delete overlaid[sessionId];
				else overlaid[sessionId] = entry.projectId;
				const assignments = Object.freeze(overlaid);
				const expansions = Object.freeze({ ...baseline.expansions ?? {} });
				const orders = Object.freeze(Object.fromEntries(Object.entries(baseline.orders ?? {}).map(([projectId, sessionIds]) => [projectId, Object.freeze([...sessionIds])])));
				const newSessionTarget = baseline.newSessionTarget ?? "ungrouped";
				const baseWorkspace = baseline.baseWorkspace ?? { mode: "default" };
				if (sameProjects(this.state.projects, projects) && sameAssignments(this.state.assignments, assignments) && sameExpansions(this.state.expansions, expansions) && sameOrders(this.state.orders, orders) && this.state.newSessionTarget === newSessionTarget && sameBaseWorkspace(this.state.baseWorkspace, baseWorkspace)) return;
				this.state = Object.freeze({
					projects,
					assignments,
					expansions,
					orders,
					newSessionTarget,
					baseWorkspace
				});
				this.derived = void 0;
				for (const listener of [...this.listeners]) listener();
			}
			groupingSnapshot() {
				this.derived ??= Object.freeze(this.state.projects.map((project) => Object.freeze({
					key: project.projectId,
					label: project.title,
					sessionIds: Object.freeze(Object.entries(this.state.assignments).filter(([, projectId]) => projectId === project.projectId).map(([sessionId]) => sessionId)),
					kind: "project"
				})));
				return this.derived;
			}
		};
		/** Value equality over the project rows. */
		function sameProjects(left, right) {
			if (left.length !== right.length) return false;
			return left.every((project, index) => {
				const other = right[index];
				return other !== void 0 && project.projectId === other.projectId && project.title === other.title && project.docPath === other.docPath && project.updatedAt === other.updatedAt;
			});
		}
		/** Value equality over the assignment map. */
		function sameAssignments(left, right) {
			const leftKeys = Object.keys(left);
			if (leftKeys.length !== Object.keys(right).length) return false;
			return leftKeys.every((key) => left[key] === right[key]);
		}
		/**
		* Value equality over the expansion map.
		*
		* An absent key and a `false` value are different states, so the comparison is
		* over entries rather than over a defaulted value: folding a row the user had
		* never touched is a real change and must notify.
		*/
		function sameExpansions(left, right) {
			const leftKeys = Object.keys(left);
			if (leftKeys.length !== Object.keys(right).length) return false;
			return leftKeys.every((key) => left[key] === right[key]);
		}
		/**
		* Value equality over the order map.
		*
		* Order is the whole point of the value, so the comparison is positional: a
		* reordered project differs even though it holds the same members.
		*/
		function sameOrders(left, right) {
			const leftKeys = Object.keys(left);
			if (leftKeys.length !== Object.keys(right).length) return false;
			return leftKeys.every((key) => {
				const a = left[key];
				const b = right[key];
				if (b === void 0 || a === void 0 || a.length !== b.length) return false;
				return a.every((id, index) => id === b[index]);
			});
		}
		//#endregion
		//#region src/client/target.ts
		/**
		* Resolve the policy to a project id, or `undefined` for Ungrouped.
		*
		* Ungrouped is the absence of an assignment rather than a project, so
		* `undefined` is the value that means "no project" throughout this plugin.
		*
		* **With no current Session the answer is Ungrouped**, not a guess. That state is
		* reachable — archiving the current Session clears the selection — and the Host's
		* own answer to it is to show a workspace picker rather than choose. Ungrouped is
		* this model's legal default, so it needs no picker of its own.
		* @param target - the stored policy.
		* @param currentSessionId - the Session the user is looking at, when there is one.
		* @param projectOf - owner lookup for one Session.
		* @param recent - the destination holding the most recently active Session, which
		* may be Ungrouped (`undefined`).
		* @returns the project to file the new Session under, or `undefined` for Ungrouped.
		*/
		function resolveTarget(target, currentSessionId, projectOf, recent) {
			switch (target) {
				case "ungrouped": return;
				case "current": return currentSessionId === void 0 ? void 0 : projectOf(currentSessionId);
				case "recent": return recent();
			}
		}
		/**
		* The destination `recent` resolves to: the holder of the most recently active
		* Session, where the holder may be a project **or Ungrouped**.
		*
		* Ungrouped is a real answer rather than the absence of one. "The last Session I
		* worked in belongs to no project" is a state the user can be in, and there is no
		* equivalent in the Host's `recentWorkspace` because every Session there belongs
		* to some Workspace. So this mirrors that function's edge rules and adds the
		* third candidate it has no room for.
		*
		* Blank Sessions contribute nothing, because the activity map excludes them: a
		* blank row carries its creation time, and the Session being placed is itself
		* blank and already in the list — counting it would let the Session choose its
		* own destination. See the map's assembly in `vendored/client/index.ts`.
		*
		* @param projects - projects in display order.
		* @param activity - Session id → last activity, blank Sessions already excluded.
		* @param members - the Session ids filed under one project.
		* @param loose - the ids in no project, i.e. the Ungrouped bucket. Typed as plain
		* strings rather than `SessionId`s because it is, by construction, a subset of
		* `activity`'s own key domain — the caller derives it with `Object.keys`.
		* @returns the project id, or `undefined` for Ungrouped.
		*/
		function recentDestination(projects, activity, members, loose) {
			let selected;
			let selectedTime = Number.NEGATIVE_INFINITY;
			const consider = (candidate, latest) => {
				if (latest <= selectedTime) return;
				selected = candidate;
				selectedTime = latest;
			};
			for (const project of projects) {
				let latest = Number.NEGATIVE_INFINITY;
				for (const sessionId of members(project.projectId)) {
					const time = activity[sessionId];
					if (time !== void 0) latest = Math.max(latest, time);
				}
				if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(project.createdAt);
				consider(project.projectId, latest);
			}
			let looseLatest = Number.NEGATIVE_INFINITY;
			for (const sessionId of loose) {
				const time = activity[sessionId];
				if (time !== void 0) looseLatest = Math.max(looseLatest, time);
			}
			consider(void 0, looseLatest);
			return selected;
		}
		//#endregion
		//#region src/client/remote.ts
		/**
		* Pass-through codec: the wire value is already the payload.
		*
		* `parse` is identity because the boundary it guards is JSON-only by
		* construction; see the module doc for when that stops being true.
		*/
		const PASSTHROUGH = { parse: (value) => value };
		/**
		* One strict codec.
		* @param typeSymbol - names the value on the wire, for diagnostics.
		* @returns the codec the Client accepts.
		*/
		function codec(typeSymbol) {
			return {
				mode: "strict",
				typeSymbol,
				create: () => PASSTHROUGH
			};
		}
		/**
		* One JSON business parameter.
		* @param name - the Host method's parameter name, which the Gateway also uses
		* as the wire field for a signature-derived descriptor.
		* @returns the parameter descriptor.
		*/
		function json(name) {
			return {
				name,
				wire: name,
				source: "json",
				codec: codec(`dsh-project-groups#${name}`)
			};
		}
		/**
		* One unary method.
		* @param method - the `@Remote` export name on the Host.
		* @param parameters - business parameter names, in order.
		* @param result - result type symbol, for diagnostics.
		* @returns the descriptor.
		*/
		function unary(method, parameters, result) {
			return {
				id: `dsh-project-groups#${PROJECT_NAMESPACE}/${method}`,
				service: PROJECT_SERVICE_KEY,
				namespace: PROJECT_NAMESPACE,
				method,
				invocation: { kind: "direct" },
				parameters: parameters.map(json),
				result: codec(`dsh-project-groups#${result}`)
			};
		}
		/**
		* The contribution mounted with `ctx.remote.$mount`.
		*
		* `follow` carries `mode: 'stream'` so the installer treats it as a stream
		* handle rather than a unary call, and an `AbortSignal` parameter so the
		* Gateway's signature check supplies cancellation.
		*/
		const projectGroupsRemote = {
			package: "dsh-project-groups",
			descriptors: [
				unary("baseline", [], "ProjectBaseline"),
				unary("create", ["request"], "ProjectValueResult"),
				unary("rename", ["request"], "ProjectRenameValue"),
				unary("delete", ["request"], "ProjectDeleteValue"),
				unary("reorder", ["request"], "ProjectOrderValue"),
				unary("assign", ["request"], "ProjectAssignmentValue"),
				unary("unassign", ["request"], "ProjectUnassignValue"),
				unary("setExpanded", ["request"], "ProjectExpansionValue"),
				unary("setOrders", ["request"], "ProjectOrdersValue"),
				unary("setNewSessionTarget", ["request"], "ProjectNewSessionTargetValue"),
				unary("setBaseWorkspace", ["request"], "ProjectBaseWorkspaceValue"),
				unary("defaultWorkspacePath", [], "ProjectDefaultWorkspacePathValue"),
				unary("rebuildBaseWorkspace", [], "ProjectRebuildBaseWorkspaceValue"),
				{
					id: `dsh-project-groups#${PROJECT_NAMESPACE}/follow`,
					service: PROJECT_SERVICE_KEY,
					namespace: PROJECT_NAMESPACE,
					method: "follow",
					mode: "stream",
					invocation: { kind: "direct" },
					parameters: [],
					result: codec("dsh-project-groups#ProjectFollowFrame"),
					cancellation: { parameter: "signal" }
				}
			]
		};
		//#endregion
		//#region \0dsh-css:src/client/settings-card.module.css.mjs
		const css = ".KApx_W_row{align-items:center;gap:8px;padding:16px 0;display:flex}.KApx_W_rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}.KApx_W_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}.KApx_W_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}.KApx_W_selector{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;align-items:center;gap:12px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}.KApx_W_selector:hover{background:var(--dsw-alias-interactive-bg-hover)}.KApx_W_chevron{flex:none}.KApx_W_group{border-bottom:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:8px;padding:16px 0;display:flex}.KApx_W_groupTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}.KApx_W_cubeRow{flex-wrap:wrap;align-items:stretch;gap:8px;display:flex}.KApx_W_cube{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-xl);font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;flex-direction:column;flex:180px;justify-content:center;align-items:center;gap:4px;padding:20px 32px;font-size:14px;line-height:22px;display:flex}.KApx_W_cube:hover:not(.KApx_W_selected){background:var(--dsw-alias-interactive-bg-hover)}.KApx_W_selected{background:var(--dsw-alias-bg-module-platform);border-color:var(--dsw-static-neutral-bluish-400)}.KApx_W_cubeName{font-weight:500}.KApx_W_cubePath{overflow-wrap:anywhere;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.KApx_W_cubeWarn{color:var(--dsw-alias-state-warn-primary)}.KApx_W_cubeAction{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;margin-top:4px;padding:2px 10px;font-size:12px;line-height:18px}.KApx_W_cubeAction:hover{background:var(--dsw-alias-interactive-bg-hover)}.KApx_W_cubeAction:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}.KApx_W_pickerList{flex-direction:column;gap:2px;max-height:320px;margin:0 -8px;display:flex;overflow-y:auto}.KApx_W_pickerRow{border-radius:var(--dsw-radius-md);cursor:pointer;flex-direction:column;gap:2px;padding:8px;display:flex}.KApx_W_pickerRow:hover{background:var(--dsw-alias-interactive-bg-hover)}.KApx_W_pickerRowActive{background:var(--dsw-alias-bg-module-platform)}.KApx_W_pickerName{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}.KApx_W_pickerPath{overflow-wrap:anywhere;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.KApx_W_pickerEmpty{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}";
		const tagId = "dsh-project-groups/settings-card.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-project-groups";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var settings_card_module_css_default = {
			"chevron": "KApx_W_chevron",
			"cube": "KApx_W_cube",
			"cubeAction": "KApx_W_cubeAction",
			"cubeName": "KApx_W_cubeName",
			"cubePath": "KApx_W_cubePath",
			"cubeRow": "KApx_W_cubeRow",
			"cubeWarn": "KApx_W_cubeWarn",
			"desc": "KApx_W_desc",
			"group": "KApx_W_group",
			"groupTitle": "KApx_W_groupTitle",
			"pickerEmpty": "KApx_W_pickerEmpty",
			"pickerList": "KApx_W_pickerList",
			"pickerName": "KApx_W_pickerName",
			"pickerPath": "KApx_W_pickerPath",
			"pickerRow": "KApx_W_pickerRow",
			"pickerRowActive": "KApx_W_pickerRowActive",
			"row": "KApx_W_row",
			"rowText": "KApx_W_rowText",
			"selected": "KApx_W_selected",
			"selector": "KApx_W_selector",
			"title": "KApx_W_title"
		};
		//#endregion
		//#region src/client/base-workspace-picker.tsx
		/**
		* The "choose an existing workspace" dialog, opened from the settings card's
		* 「更换…」.
		*
		* ## Why a dialog rather than a dropdown
		*
		* Two Workspaces may share a display title — the registry allows it, and the official
		* picker lives with that by showing titles alone. This surface cannot: it decides where
		* **every** New Session lands, so a wrong pick is expensive, and two rows reading
		* "重要" would be indistinguishable. A dialog has the width for a second line, so each
		* row carries its **path** as a subtitle. That is the whole reason for the shape.
		*
		* The role vocabulary follows the shipped single-select lists (`role="listbox"` with
		* `role="option"` and `aria-selected`, as `ui-commands` / `ui-input-trigger` /
		* `ui-schedule` use) rather than `menuitem`, which is only valid inside a menu.
		*
		* ## Why selection is staged
		*
		* A row click only moves the highlight; the footer's 确认 writes. So a mis-click costs
		* nothing, and the user can see what they are about to commit. The actions are two, so
		* they take the shared `Modal` footer's row rather than the stacked layout the
		* three-action missing-workspace dialog needs (three equal row actions leave about
		* 77px each; two do not).
		*/
		/**
		* Render the workspace chooser.
		* @param props - the registry rows, the current choice, the two outcomes, and the locale seat.
		* @returns the dialog.
		*/
		function BaseWorkspacePicker({ workspaces, selectedPath, onConfirm, onCancel, t }) {
			const [staged, setStaged] = (0, react.useState)(selectedPath ?? null);
			const listRef = (0, react.useRef)(null);
			const stagedIndex = workspaces.findIndex((item) => item.path === staged);
			const tabStopIndex = stagedIndex >= 0 ? stagedIndex : 0;
			/**
			* Move the highlight with the arrow keys / Home / End.
			* @param delta - how many rows to move; clamped to the list.
			*/
			const move = (delta) => {
				if (workspaces.length === 0) return;
				const next = stagedIndex < 0 ? delta > 0 ? 0 : workspaces.length - 1 : Math.min(workspaces.length - 1, Math.max(0, stagedIndex + delta));
				const row = workspaces[next];
				if (row === void 0) return;
				setStaged(row.path);
				listRef.current?.querySelectorAll("[role=\"option\"]")[next]?.focus();
			};
			const stagedWorkspace = workspaces.find((item) => item.path === staged) ?? null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open: true,
				onClose: onCancel,
				closeLabel: t("close"),
				title: t("basePickerTitle"),
				footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "outline",
					onClick: onCancel,
					children: t("cancel")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "primary",
					disabled: stagedWorkspace === null,
					onClick: () => {
						if (stagedWorkspace !== null) onConfirm(stagedWorkspace);
					},
					children: t("confirm")
				})] }),
				children: workspaces.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: settings_card_module_css_default.pickerEmpty,
					role: "note",
					children: t("basePickerEmpty")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					ref: listRef,
					role: "listbox",
					"aria-label": t("basePickerAria"),
					className: settings_card_module_css_default.pickerList,
					onKeyDown: (event) => {
						switch (event.key) {
							case "ArrowDown":
								event.preventDefault();
								move(1);
								break;
							case "ArrowUp":
								event.preventDefault();
								move(-1);
								break;
							case "Home":
								event.preventDefault();
								move(-workspaces.length);
								break;
							case "End":
								event.preventDefault();
								move(workspaces.length);
								break;
							case "Enter":
							case " ":
								event.preventDefault();
								if (stagedWorkspace !== null) onConfirm(stagedWorkspace);
						}
					},
					children: workspaces.map((item, index) => {
						const active = item.path === staged;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							role: "option",
							"aria-selected": active,
							tabIndex: index === tabStopIndex ? 0 : -1,
							className: active ? `${settings_card_module_css_default.pickerRow} ${settings_card_module_css_default.pickerRowActive}` : settings_card_module_css_default.pickerRow,
							onClick: () => {
								setStaged(item.path);
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: settings_card_module_css_default.pickerName,
								children: workspaceDisplayTitle(item.title, t("baseDefaultName"))
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: settings_card_module_css_default.pickerPath,
								children: item.path
							})]
						}, item.workspaceId);
					})
				})
			});
		}
		//#endregion
		//#region src/client/settings-card.tsx
		/**
		* This plugin's own settings card, rendered on its Plugin manager page.
		*
		* The Plugins page declares `plugins.bundle.config` — a keyed slot dispatched by
		* the bundle's package name — and renders it between the page's description and
		* its "included components" list. Registering under this bundle's name is what
		* makes the page render the section at all: `config-ledger.ts` projects the
		* slot's keys into the `configured` flag that gates it.
		*
		* The page also offers `PluginConfigViewProps.form`, a Host-backed config form.
		* This card ignores it: the destination lives in this plugin's own domain and is
		* written through its own Remote, exactly as the official voice-input bundle
		* ignores `form` in favour of its `configure` Remote.
		*/
		/**
		* The destinations, in display order: the default first, then the two that
		* follow existing Sessions.
		*/
		const OPTIONS = [
			"ungrouped",
			"current",
			"recent"
		];
		/**
		* Render the New Session destination selector and the base-workspace choice.
		* @param props - composed slot props.
		* @returns the settings rows.
		*/
		function ProjectGroupsCard({ useTarget, setTarget, useBaseWorkspace, setBaseWorkspace, useWorkspaces, useChooserRequest, settleBaseWorkspaceChooser, t }) {
			const target = useTarget((value) => value);
			const [open, setOpen] = (0, react.useState)(false);
			const selected = OPTIONS.includes(target) ? target : "ungrouped";
			const base = useBaseWorkspace((value) => value);
			const workspaces = (useWorkspaces === void 0 ? void 0 : useWorkspaces((value) => value))?.items ?? [];
			const [picking, setPicking] = (0, react.useState)(false);
			const chooserRequest = useChooserRequest((value) => value);
			(0, react.useEffect)(() => {
				if (chooserRequest === null) return;
				setPicking(true);
				settleBaseWorkspaceChooser();
			}, [chooserRequest, settleBaseWorkspaceChooser]);
			const chosen = base.path === void 0 ? null : workspaces.find((item) => item.path === base.path) ?? null;
			const neverChosen = base.path === void 0 || base.path === "";
			const gone = !neverChosen && chosen === null;
			const specifiedLabel = neverChosen ? t("baseNotChosen") : gone ? t("baseGone", { name: base.name ?? base.path }) : base.name ?? base.path;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: settings_card_module_css_default.row,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: settings_card_module_css_default.rowText,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: settings_card_module_css_default.title,
							children: t("title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: settings_card_module_css_default.desc,
							children: t("description")
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
						open,
						onClose: () => {
							setOpen(false);
						},
						items: OPTIONS.map((value) => ({
							id: value,
							label: t(value)
						})),
						selectedId: selected,
						onSelect: (id) => {
							setOpen(false);
							setTarget(id);
						},
						align: "end",
						portal: true,
						anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: settings_card_module_css_default.selector,
							"aria-haspopup": "menu",
							"aria-expanded": open,
							onClick: () => {
								setOpen((value) => !value);
							},
							children: [t(selected), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutlineRegular, { className: settings_card_module_css_default.chevron })]
						})
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: settings_card_module_css_default.group,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: settings_card_module_css_default.groupTitle,
						children: t("baseTitle")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: settings_card_module_css_default.cubeRow,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							"aria-pressed": base.mode === "default",
							className: base.mode === "default" ? `${settings_card_module_css_default.cube} ${settings_card_module_css_default.selected}` : settings_card_module_css_default.cube,
							onClick: () => {
								setBaseWorkspace({ mode: "default" });
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: settings_card_module_css_default.cubeName,
								children: t("baseModeDefault")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: settings_card_module_css_default.cubePath,
								children: t("baseDefaultHint")
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							"aria-pressed": base.mode === "specified",
							className: base.mode === "specified" ? `${settings_card_module_css_default.cube} ${settings_card_module_css_default.selected}` : settings_card_module_css_default.cube,
							onClick: () => {
								if (chosen === null) {
									setPicking(true);
									return;
								}
								setBaseWorkspace({
									mode: "specified",
									path: chosen.path,
									name: chosen.title
								});
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: settings_card_module_css_default.cubeName,
									children: t("baseModeSpecified")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: gone ? `${settings_card_module_css_default.cubePath} ${settings_card_module_css_default.cubeWarn}` : settings_card_module_css_default.cubePath,
									title: base.path ?? "",
									children: specifiedLabel
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									role: "button",
									tabIndex: 0,
									className: settings_card_module_css_default.cubeAction,
									"aria-label": t("baseChoose"),
									onClick: (event) => {
										event.stopPropagation();
										setPicking(true);
									},
									onKeyDown: (event) => {
										if (event.key !== "Enter" && event.key !== " ") return;
										event.preventDefault();
										event.stopPropagation();
										setPicking(true);
									},
									children: t("baseChoose")
								})
							]
						})]
					})]
				}),
				picking && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(BaseWorkspacePicker, {
					workspaces,
					selectedPath: base.path,
					onCancel: () => {
						setPicking(false);
					},
					onConfirm: (workspace) => {
						setPicking(false);
						setBaseWorkspace({
							mode: "specified",
							path: workspace.path,
							name: workspace.title
						});
					},
					t
				})
			] });
		}
		//#endregion
		//#region src/client/settings-locales.ts
		/** Dictionary namespace owned by the settings card. */
		const SETTINGS_NS = "settings.projectGroups";
		/** Chinese dictionary and key source. */
		const zh = {
			title: "新会话落点",
			description: "顶部“新会话”按钮与快捷键落在哪里",
			ungrouped: "未分组",
			current: "当前会话所在项目",
			recent: "最后活跃的会话所在项目",
			baseTitle: "底层工作区",
			baseModeDefault: "默认工作区",
			baseDefaultHint: "官方首次创建的工作区",
			baseModeSpecified: "指定工作区",
			basePathUnknown: "路径未知",
			baseNotChosen: "未选择",
			baseGone: "{name}（已不存在）",
			baseChoose: "更换…",
			baseDefaultName: "默认工作区",
			basePickerTitle: "选择底层工作区",
			basePickerAria: "现有工作区",
			basePickerEmpty: "暂无工作区",
			confirm: "确认",
			cancel: "取消",
			close: "关闭"
		};
		/** English dictionary with the same complete key set. */
		const en = {
			title: "New Session destination",
			description: "Where the New Session button and shortcut file an unscoped Session",
			ungrouped: "Ungrouped",
			current: "The current Session's project",
			recent: "The most recently active project",
			baseTitle: "Base workspace",
			baseModeDefault: "Default workspace",
			baseDefaultHint: "the workspace created on first use",
			baseModeSpecified: "Specific workspace",
			basePathUnknown: "path unknown",
			baseNotChosen: "none chosen",
			baseGone: "{name} (no longer exists)",
			baseChoose: "Change…",
			baseDefaultName: "Default workspace",
			basePickerTitle: "Choose a base workspace",
			basePickerAria: "Existing workspaces",
			basePickerEmpty: "No workspaces",
			confirm: "Confirm",
			cancel: "Cancel",
			close: "Close"
		};
		//#endregion
		//#region src/client/index.ts
		/** The same service set the vendored half needs; see its own `inject`. */
		const inject = inject$1;
		/**
		* The Workspace registry snapshot, captured by {@link apply}.
		*
		* Module-level like the model itself, because {@link projectActions} is built at module
		* load while the service only exists once `apply` runs. `resolveBaseWorkspace` needs it to
		* turn the setting's stored **path** into a Workspace id.
		*/
		let workspacesRegistry;
		/**
		* The root context, captured by {@link apply}.
		*
		* {@link projectActions} is built at module load while the context only exists once `apply`
		* runs, so the verbs that need an ungated `ctx.get` read it from here. Ungated on purpose for
		* `pluginNavigation`, which the manager disposes with its page slot.
		*/
		let clientContext;
		/**
		* A request to open the base-workspace chooser, raised by the missing-workspace dialog and
		* consumed by the settings card.
		*
		* An object rather than a boolean: a **repeat** request has to be a new value to be observable,
		* and a value left at `true` cannot change. The card consumes it by setting `null`, so the value
		* only ever alternates and never accumulates. Same shape, and the same reason, as the vendored
		* half's own `baseWorkspaceRequest`.
		*/
		const chooserRequest = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(null);
		/**
		* The verbs the browser's row menu and drag drive.
		*
		* Each resolves only after the Host has accepted the write, so a dialog awaiting
		* one closes on a committed value and a refusal surfaces in the dialog rather
		* than behind it. The state itself arrives over the `follow` stream, not from
		* these calls.
		*/
		const projectActions = {
			createProject: async ({ title }) => {
				await requireModel().create(title);
			},
			renameProject: async (id, title) => {
				await requireModel().rename(id, title);
			},
			deleteProject: async (id) => {
				await requireModel().remove(id);
			},
			reorderProject: async (id, beforeId) => {
				await requireModel().reorder(id, beforeId);
			},
			assignSession: async (sessionId, projectId) => {
				await requireModel().assign(sessionId, projectId);
			},
			unassignSession: async (sessionId) => {
				await requireModel().unassign(sessionId);
			},
			setProjectExpanded: async (projectId, expanded) => {
				await requireModel().setExpanded(projectId, expanded);
			},
			setProjectOrders: async (orders) => {
				await requireModel().setOrders(orders);
			},
			placeUnscopedSession: ({ sessionId, currentSessionId, updatedAt }) => {
				const model = projectModel();
				if (model === void 0) return;
				const projectId = resolveTarget(model.target(), currentSessionId, (id) => model.projectOf(id), () => recentDestination(model.list(), updatedAt, (id) => model.membersOf(id), Object.keys(updatedAt).filter((id) => model.projectOf(id) === void 0)));
				(projectId === void 0 ? model.unassign(sessionId) : model.assign(sessionId, projectId)).catch((reason) => {
					console.warn("place new session rejected:", reason);
				});
			},
			defaultWorkspacePath: async () => {
				const model = projectModel();
				if (model === void 0) return null;
				return await model.defaultWorkspacePath();
			},
			rebuildBaseWorkspace: async () => {
				await requireModel().rebuildBaseWorkspace();
			},
			chooseBaseWorkspace: () => {
				(clientContext?.get("pluginNavigation"))?.openBundle("dsh-project-groups");
				chooserRequest.set({ kind: "pick" });
			},
			resolveBaseWorkspace: () => {
				const model = projectModel();
				if (model === void 0) return { kind: "official" };
				const setting = model.baseWorkspaceSetting();
				if (setting.mode !== "specified") return { kind: "official" };
				const path = setting.path ?? "";
				if (path === "") return { kind: "official" };
				const found = (workspacesRegistry?.getSnapshot().items ?? []).find((item) => item.path === path);
				return found === void 0 ? {
					kind: "missing",
					path,
					name: setting.name ?? null
				} : {
					kind: "workspace",
					workspaceId: found.workspaceId
				};
			}
		};
		/** @returns the started model, or throws when the Remote namespace is absent. */
		function requireModel() {
			const live = projectModel();
			if (live === void 0) throw new Error("the projectGroups namespace is not available");
			return live;
		}
		/**
		* Register the vendored browser with this plugin's grouping model.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			workspacesRegistry = ctx.get("workspaces")?.list;
			clientContext = ctx;
			mountProjects(ctx);
			apply$1(ctx, clientGrouping, projectActions, clientExpansions, clientOrders);
			registerSettingsCard(ctx);
		}
		/**
		* Contribute this plugin's configuration card to its own Plugin manager page.
		*
		* The `key` must be this bundle's package name: the page dispatches the keyed
		* slot by it, and that same key is what makes the page render the section at all
		* (`config-ledger.ts` projects `plugins.bundle.config`'s keys into the
		* `configured` flag). A key that does not match the installed bundle name is
		* silently not rendered, which is why `probe-settings-card.mjs` asserts the card
		* is present rather than trusting the registration.
		*
		* `slots.inject` waits for the Plugins page to declare the slot, so this needs no
		* ordering assumption and both sides leave together.
		* @param ctx - client root context.
		*/
		function registerSettingsCard(ctx) {
			ctx.effect(() => ctx.locale.register(SETTINGS_NS, {
				zh,
				en
			}), "project-groups: settings dictionaries");
			const workspaces = ctx.get("workspaces");
			ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
				name: "plugins.bundle.config",
				key: "dsh-project-groups",
				locale: SETTINGS_NS,
				inject: () => ({
					hooks: {
						target: clientNewSessionTarget,
						baseWorkspace: clientBaseWorkspace,
						...workspaces === void 0 ? {} : { workspaces: workspaces.list },
						chooserRequest
					},
					settleBaseWorkspaceChooser: () => {
						chooserRequest.set(null);
					},
					setTarget: (target) => {
						const live = projectModel();
						if (live === void 0) return;
						live.setNewSessionTarget(target).catch((reason) => {
							console.warn("set new session target rejected:", reason);
						});
					},
					setBaseWorkspace: (setting) => {
						const live = projectModel();
						if (live === void 0) return;
						live.setBaseWorkspace(setting).catch((reason) => {
							console.warn("set base workspace rejected:", reason);
						});
					}
				})
			}, ProjectGroupsCard));
		}
		/**
		* Mount this plugin's Remote namespace and start the projection.
		*
		* Both services are read with `ctx.get`, not as properties: cordis gates
		* property access on the fiber's declared dependencies, so `remote.projectGroups`
		* throws `cannot get property "..." without inject`. Declaring it in `inject`
		* would deadlock — the namespace exists only because this very call mounts it, so
		* the fiber would be waiting on itself. `ctx.get` is the ungated lookup, and it
		* is what makes mounting one's own namespace possible at all
		* (`scripts/probe-inject-wait.mjs` measures both shapes).
		*
		* `$mount` is read off the `remote` service rather than imported: the gateway's
		* Client face is not a platform module, so importing it would be a build-purity
		* violation. The structural types below are the parts of those faces this plugin
		* uses.
		* @param ctx - client root context.
		*/
		async function mountProjects(ctx) {
			try {
				const remote = ctx.get("remote");
				if (remote === void 0) throw new Error("the remote service is unavailable");
				await remote.$mount(projectGroupsRemote);
				const namespace = ctx.get(`remote.${PROJECT_NAMESPACE}`);
				if (namespace === void 0) throw new Error(`the ${PROJECT_NAMESPACE} namespace did not mount`);
				const model = new ProjectModel(namespace);
				const stop = await model.start();
				installProjectModel(model);
				ctx.effect(() => stop, "project-groups: follow stream");
			} catch (error) {
				console.error("dsh-project-groups: project namespace failed to mount:", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.clientBaseWorkspace = clientBaseWorkspace;
		exports.clientExpansions = clientExpansions;
		exports.clientGrouping = clientGrouping;
		exports.clientNewSessionTarget = clientNewSessionTarget;
		exports.clientOrders = clientOrders;
		exports.inject = inject;
		exports.projectModel = projectModel;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map