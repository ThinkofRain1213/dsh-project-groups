window.__ModuleLoader__.load({
	id: "dsh-project-groups",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/format.ts
		/**
		* Small formatting and visibility helpers for the flat session list.
		*
		* These mirror the official sidebar browser's list rules (subagent rows are
		* never listed, a blank placeholder only shows while it is the current
		* session, archived rows follow the viewer's filter) so that replacing the
		* browser does not silently change which conversations appear.
		*/
		/** Coarse re-render cadence for relative time labels. */
		const SESSION_ROW_TIME_TICK_MS = 6e4;
		/**
		* Whether one Session belongs in the browsing list.
		*
		* Subagent sessions are never top-level rows. A blank (never-prompted)
		* session is a provisional placeholder and only appears while it is the
		* selected session. Archived membership then follows the filter.
		*
		* @param row - the candidate row.
		* @param current - the selected session id, when one is open.
		* @param archived - the registry-global archived id set.
		* @param filter - the viewer's archived filter.
		* @returns true when the row should be listed.
		*/
		function sessionVisible(row, current, archived, filter) {
			if (row.origin === "subagent") return false;
			if (row.blank && row.id !== current) return false;
			switch (filter) {
				case "default": return !archived.has(row.id);
				case "show": return true;
				case "only": return archived.has(row.id);
			}
		}
		/**
		* A compact relative-time label ("now", "5 min", "3 h", "2 d").
		*
		* The unit words come from the registration's locale seat, so the plugin ships
		* one dictionary pair and needs no per-locale branching here.
		*
		* @param timestamp - epoch milliseconds of the row's last activity.
		* @param now - epoch milliseconds of the current tick.
		* @param t - locale seat bound to the `project-groups` namespace.
		* @returns the compact label.
		*/
		function relativeTime(timestamp, now, t) {
			const elapsed = Math.max(0, now - timestamp);
			const minute = 6e4;
			const hour = 60 * minute;
			const day = 24 * hour;
			if (elapsed < minute) return t("time.now");
			if (elapsed < hour) return t("time.min", { n: Math.floor(elapsed / minute) });
			if (elapsed < day) return t("time.hour", { n: Math.floor(elapsed / hour) });
			return t("time.day", { n: Math.floor(elapsed / day) });
		}
		//#endregion
		//#region src/client/ProjectGroups.tsx
		/**
		* The flat "Ungrouped" conversation list that replaces the sidebar's workspace
		* browser at L0.
		*
		* Every visible Session lands in one bucket. The list groups by nothing: the
		* plugin owns the sidebar region, and rendering one flat bucket is what
		* displaces the official workspace sections while this entry is the slot's
		* winner.
		*
		* Data comes entirely from the framework's global standard hooks
		* (`useSessions`, `useWorkspaces`, both provided at root by official plugins)
		* plus the injected `t` seat. No plugin-owned state exists at L0.
		*/
		/**
		* Render the flat list: a bucket header, the visible Session rows in the
		* framework's activity order, and a New Session affordance.
		* @param props - owner share, injected navigation, standard hooks, and locale seat.
		* @returns the browsing region's element tree.
		*/
		function ProjectGroups(props) {
			const useSessions = props.useSessions;
			const useWorkspaces = props.useWorkspaces;
			const list = useSessions((state) => state);
			const archivedIds = useWorkspaces((state) => state.archivedSessionIds);
			const now = useNow();
			const archived = react.useMemo(() => new Set(archivedIds), [archivedIds]);
			const rows = list.ids.flatMap((id) => {
				const row = list.byId[id];
				if (row === void 0) return [];
				return sessionVisible(row, void 0, archived, "default") ? [row] : [];
			});
			const t = props.t;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dpg-root",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dpg-header",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dpg-header-title",
							children: props.wide ? t("section.ungrouped") : ""
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dpg-header-count",
							children: rows.length
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: "dpg-new-session",
						"aria-label": t("action.newSession.aria"),
						onClick: () => {
							props.startSession();
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"aria-hidden": "true",
							children: "＋"
						}), props.wide && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("action.newSession") })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dpg-scroll",
						role: "list",
						children: [rows.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SessionRow, {
							row,
							now,
							openLabel: t("row.open.aria", { name: row.displayTitle }),
							timeText: relativeTime(row.updatedAt, now, t),
							onOpen: () => {
								props.open(row.id);
							}
						}, row.id)), rows.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dpg-empty",
							children: t("empty.sessions")
						})]
					})
				]
			});
		}
		/** One Session row: title, relative time, and a running indicator. */
		function SessionRow({ row, now, openLabel, timeText, onOpen }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dpg-row",
				role: "listitem",
				"aria-label": openLabel,
				"data-running": row.running ? "true" : void 0,
				tabIndex: 0,
				onClick: onOpen,
				onKeyDown: (event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						onOpen();
					}
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dpg-running",
						"aria-hidden": "true"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dpg-row-title",
						children: row.displayTitle
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dpg-row-time",
						"data-now": now,
						children: timeText
					})
				]
			});
		}
		/**
		* A coarse clock so relative labels ("5 min") re-render without a per-second
		* tick. The interval is owned by this component and cleared on unmount, so
		* unloading the plugin leaves no timer behind.
		* @returns epoch milliseconds, refreshed on a coarse tick.
		*/
		function useNow() {
			const [now, setNow] = react.useState(() => Date.now());
			react.useEffect(() => {
				const timer = window.setInterval(() => {
					setNow(Date.now());
				}, SESSION_ROW_TIME_TICK_MS);
				return () => {
					window.clearInterval(timer);
				};
			}, []);
			return now;
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* `project-groups` namespace dictionaries (the browsing region's copy).
		*
		* The registration declares `locale: NS`, so the renderer binds a `t` seat
		* from this namespace and injects it as a component prop. Simplified Chinese is
		* the key-set source of truth; the English dictionary is checked complete
		* against it.
		*/
		/** Dictionary namespace owned by this plugin's browsing region. */
		const NS = "project-groups";
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"section.ungrouped": "未分组",
			"section.sessions": "会话",
			"action.newSession": "新会话",
			"action.newSession.aria": "新会话",
			"empty.sessions": "还没有会话",
			"time.now": "刚刚",
			"time.min": "{n} 分钟",
			"time.hour": "{n} 小时",
			"time.day": "{n} 天",
			"row.running": "进行中",
			"row.open.aria": "打开会话“{name}”"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"section.ungrouped": "Ungrouped",
			"section.sessions": "Conversations",
			"action.newSession": "New session",
			"action.newSession.aria": "New session",
			"empty.sessions": "No conversations yet",
			"time.now": "now",
			"time.min": "{n} min",
			"time.hour": "{n} h",
			"time.day": "{n} d",
			"row.running": "Running",
			"row.open.aria": "Open conversation “{name}”"
		};
		//#endregion
		//#region \0dsh-css:src/client/styles.css.mjs
		const css = "/*\n * dsh-project-groups — browsing region styles.\n *\n * Deliberately built from the shell's design tokens (`--dsw-alias-*`,\n * `--dsw-radius-*`) rather than hard-coded colors, so the list follows the\n * app's light/dark theme and any future token change without a rebuild.\n */\n\n.dpg-root {\n  box-sizing: border-box;\n  display: flex;\n  flex-direction: column;\n  flex: 1;\n  min-height: 0;\n  color: var(--dsw-alias-label-primary);\n}\n\n.dpg-header {\n  box-sizing: border-box;\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  flex: none;\n  height: 36px;\n  margin-bottom: 4px;\n  padding-left: 4px;\n  color: var(--dsw-alias-label-tertiary);\n  overflow: hidden;\n}\n\n.dpg-header-title {\n  flex: none;\n  max-width: 45%;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  line-height: 20px;\n}\n\n.dpg-header-count {\n  flex: none;\n  font-size: 12px;\n  line-height: 17px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.dpg-new-session {\n  box-sizing: border-box;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  gap: 6px;\n  flex: none;\n  width: 100%;\n  height: 34px;\n  margin-bottom: 6px;\n  padding: 0 8px;\n  border: none;\n  border-radius: var(--dsw-radius-md);\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 14px;\n  cursor: pointer;\n}\n\n.dpg-new-session:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.dpg-scroll {\n  box-sizing: border-box;\n  display: flex;\n  flex-direction: column;\n  flex: 1;\n  min-height: 0;\n  overflow-y: auto;\n  overflow-x: hidden;\n  padding-right: var(--dsh-sidebar-inline-padding, 12px);\n}\n\n.dpg-row {\n  box-sizing: border-box;\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  flex: none;\n  height: 32px;\n  padding: 0 8px;\n  border-radius: var(--dsw-radius-md);\n  cursor: pointer;\n  user-select: none;\n}\n\n.dpg-row:hover,\n.dpg-row:focus-visible {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.dpg-row:focus-visible {\n  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));\n  outline-offset: -2px;\n}\n\n/* The running indicator keeps its cell even when idle, so titles align. */\n.dpg-running {\n  flex: none;\n  width: 6px;\n  height: 6px;\n  border-radius: 50%;\n  background: var(--dsw-alias-state-business-primary, currentColor);\n  opacity: 0;\n}\n\n.dpg-row[data-running='true'] .dpg-running {\n  opacity: 1;\n}\n\n.dpg-row-title {\n  flex: 1;\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  font-size: 14px;\n  line-height: 20px;\n}\n\n.dpg-row-time {\n  flex: none;\n  font-size: 12px;\n  line-height: 17px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.dpg-empty {\n  margin: 8px;\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 12px;\n}";
		const tagId = "dsh-project-groups/styles.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-project-groups";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region src/client/package-name.ts
		/**
		* This bundle's npm package name.
		*
		* Kept in its own module so both halves and the build config can name the
		* bundle without importing the client entry (which pulls in the stylesheet and
		* React component tree).
		*/
		/** The package name the client loader keys this bundle's registration under. */
		const PACKAGE_NAME = "dsh-project-groups";
		//#endregion
		//#region src/client/index.ts
		/** Registration priority for the browsing-region entry. */
		const PRIORITY = -100;
		/** Required services: the slot registry and the locale registry. */
		const inject = ["slots", "locale"];
		/**
		* Register the flat browsing list once the sidebar shell declares its hole,
		* and publish this namespace's dictionaries.
		*
		* `slots.inject` waits for the declaration and withdraws the contribution if
		* it collapses, so load order relative to the sidebar plugin does not matter.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "project-groups: dictionaries");
			ctx.slots.inject("sidebar.workspaces", () => ctx.slots.register({
				name: "sidebar.workspaces",
				priority: PRIORITY,
				locale: NS,
				inject: () => ({
					startSession: (workspaceId) => {
						ctx.get("uiWorkspace")?.startSession(workspaceId);
					},
					open: (sessionId) => {
						ctx.get("uiWorkspace")?.openSession(sessionId);
					}
				})
			}, ProjectGroups));
		}
		//#endregion
		exports.PACKAGE_NAME = PACKAGE_NAME;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map