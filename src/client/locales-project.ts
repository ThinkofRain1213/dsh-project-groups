/**
 * The 40 `workspace` dictionary keys this plugin adds on top of the official set, plus
 * the registration entry point that merges them into the namespace.
 *
 * ## Why these keys live here and not in `src/vendored/client/locales.ts`
 *
 * That file is a vendored copy of `ui-workspace`'s dictionary and is kept **byte-identical
 * to upstream** so a re-sync is a plain copy. Project copy is this plugin's own, so it is
 * held here instead: the vendored file stays upstream's, and the additions live in one
 * file a re-sync never touches.
 *
 * ## Why six languages fall back to English for this copy
 *
 * Upstream ships 8 languages. These 40 keys exist in `zh` and `en` only; `ja`, `es`, `fr`,
 * `de`, `ru` and `pt` do not translate them, so the locale service's per-key fallback
 * chain resolves them to English. That is a **known, accepted degradation** — recorded in
 * the plan's spec as B-2b and in the CHANGELOG — not a defect. Translating them into six
 * more languages is its own piece of work, and inventing copy here would be worse than
 * showing the English the fallback already shows.
 *
 * ## The one place the type is deliberately lied to
 *
 * `ctx.locale.register(ns, dicts)` demands every language carry every key of the
 * namespace, which the six no longer do. {@link workspaceDictionaries} therefore asserts
 * its return type. The assertion is safe because the runtime lookup walks the fallback
 * chain per key (`LocaleRuntime.lookup`), and every one of the six declares `en` as its
 * fallback — so a missing project key resolves to its English text, never to `undefined`.
 * Real completeness is proven where it matters: {@link ProjectWorkspaceKey} makes the two
 * dictionaries `satisfies Record<ProjectWorkspaceKey, string>`, so a key present in one
 * and not the other is a compile error.
 *
 * ## Two `WorkspaceKey` types, and which one to import
 *
 * `src/vendored/client/locales.ts` exports `WorkspaceKey = keyof typeof zh` — upstream's
 * 119 keys, byte-identical to upstream. This file exports a **wider** `WorkspaceKey`
 * (119 ∪ 40 = 159) because `src/vendored/client/index.ts`'s `LocaleNamespaceMap` block
 * (upstream's, left verbatim) types the `workspace` namespace with it, and the 60-odd
 * `t('project.*')` call sites must type-check against the wider set.
 *
 * The two are not interchangeable: import upstream's when you need the official key set,
 * this one when you are typing `t()`. The vendored copy is never edited to widen it —
 * that would break the byte-identical rule this split exists to preserve.
 */

import {
  de, en as upstreamEn, es, fr, ja, pt, ru, zh as upstreamZh,
  type WorkspaceKey as UpstreamWorkspaceKey,
} from '../vendored/client/locales.ts'

/**
 * Every `workspace` key this plugin adds on top of upstream's 119, in dictionary order.
 *
 * The key union is derived from this list rather than from `keyof typeof PROJECT_LOCALE_ZH`
 * so a key added to one dictionary and forgotten in the other is reported by `satisfies`
 * rather than silently narrowing the union.
 */
export const PROJECT_LOCALE_KEYS = [
  'project.add', 'project.create.title', 'project.create.placeholder', 'field.projectName',
  'create', 'rename.project.title', 'edit.project', 'edit.project.title', 'save',
  'field.directories', 'field.links', 'field.docSpec',
  'docSpec.followGlobal', 'docSpec.none', 'docSpec.default',
  'directory.add', 'directory.none', 'directory.remove',
  'link.add', 'link.none', 'link.remove', 'link.invalid', 'link.countInvalid', 'link.countBlank',
  'delete.project', 'delete.project.desc', 'delete.project.pending', 'conflict.projectNamed',
  'baseMissing.title', 'baseMissing.body', 'baseMissing.path', 'baseMissing.pathUnknown',
  'baseMissing.rebuild', 'baseMissing.respecify', 'baseMissing.confirmTitle',
  'baseMissing.confirmBody', 'baseMissing.confirmAction', 'baseMissing.confirmBusy',
  'baseMissing.confirmBack', 'actions.project.aria',
] as const

/** The key union of the 40 project-owned entries. */
export type ProjectWorkspaceKey = typeof PROJECT_LOCALE_KEYS[number]

/**
 * The namespace's complete key union: upstream's 119 plus this plugin's 40.
 *
 * This is what `LocaleNamespaceMap.workspace` must name, because that declaration types the
 * framework-injected `t` seat. Naming only {@link UpstreamWorkspaceKey} would make every
 * `t('project.…')` call site — 60-odd of them across `Rows.tsx`, `WorkspaceBrowser.tsx` and
 * `BaseWorkspaceMissing.tsx` — a compile error.
 */
export type WorkspaceKey = UpstreamWorkspaceKey | ProjectWorkspaceKey

/** Simplified Chinese project copy. */
export const PROJECT_LOCALE_ZH = {
  // Project copy. A project is a caller-supplied grouping, not a Workspace:
  // it has a title and a document, and no directory to pick.
  'project.add': '新建项目',
  'project.create.title': '新建项目',
  'project.create.placeholder': '项目名称',
  'field.projectName': '项目名称',
  'create': '创建',
  'rename.project.title': '重命名项目',
  // Project edit copy. The menu entry and the dialog title read 编辑项目 rather
  // than 重命名 because the dialog now commits a title *and* a directory list;
  // `save` labels its button for the same reason. `rename.project.title` stays
  // for the Workspace-side dictionary symmetry.
  'edit.project': '编辑项目',
  'edit.project.title': '编辑项目',
  'save': '保存',
  // Associated directories: the directories a project is linked to. Kept in the
  // project block because nothing else in this dictionary has the concept.
  // 「关联」rather than 「源」: the field records what a project is tied to, not
  // where anything is read from.
  // 关联目录：项目所绑定的目录。**用「目录」而不是「文件夹」** —— 设置卡里的
  // `injectInfoDesc` 早就写作「关联目录」，只有这个对话框用「文件夹」，
  // 同一样东西两个词会让用户以为它们是两回事。英文同理，统一到 `directory`。
  'field.directories': '关联目录',
  // Associated links: URLs a project is tied to, typically its upstream repository. Sibling
  // of the directories field above, and worded the same way for the same reason.
  'field.links': '关联链接',
  'field.docSpec': '文档规范',
  // The spec dropdown. 跟随全局 is its own first row rather than a marker spread
  // across the other entries: with a global choice of 自定义-but-empty there is no
  // single entry that could carry "this is the global one" without either lying
  // about the choice or merging 自定义 into the 无 row.
  'docSpec.followGlobal': '跟随全局',
  'docSpec.none': '无',
  'docSpec.default': '默认',
  'directory.add': '添加目录',
  'directory.none': '未添加关联目录',
  'directory.remove': '移除 {path}',
  // The link list. Its own keys rather than reusing the directory ones: the two lists sit
  // side by side in the same dialog, so a shared "添加" would leave two identical buttons
  // with no way to tell which list each one feeds.
  'link.add': '添加链接',
  'link.none': '未添加关联链接',
  'link.remove': '移除 {url}',
  // The amber ⓘ tooltip — the only place the rule itself is stated, since the mark alone
  // does not say what failed.
  'link.invalid': '需以 http:// 或 https:// 开头',
  // The header's summary, right of the label. 「条」 rather than 「行」: the counter's unit is
  // a link, not a line of text.
  'link.countInvalid': '{n} 条链接未通过校验',
  // The blank-row notice: rows the user visited and left empty. Dimmed rather than amber,
  // so it reads as "nothing to do" beside the invalid count's "fix this". Worded as the
  // behaviour the user will observe ("ignored on save"), not as our internal data handling.
  'link.countBlank': '{n} 行为空，保存时忽略',
  'delete.project': '删除项目',
  'delete.project.desc': '将删除项目“{name}”。其中的会话不会被删除，会回到“未分组”。',
  'delete.project.pending': '正在删除项目…',
  // A title another project already holds. Its own key rather than the shipped
  // `conflict.named`, whose wording says 工作区: to the user a project and a Workspace are
  // different things, so the message names the one they were actually editing.
  'conflict.projectNamed': '已存在名为“{name}”的项目。',
  // The missing-底层工作区 dialog. Its own keys rather than a rewrite of any shipped
  // one: the vendored dictionary stays upstream's copy for re-sync, and the additions
  // live in one contiguous block so a re-sync can re-add them mechanically.
  'baseMissing.title': '底层工作区缺失',
  'baseMissing.body': '它是本插件所有会话的落脚点，缺失时无法新建会话。',
  'baseMissing.path': '缺失：{path}',
  'baseMissing.pathUnknown': '缺失：默认工作区（路径未知）',
  'baseMissing.rebuild': '重建该工作区',
  'baseMissing.respecify': '重新指定底层工作区',
  // The confirmation stage. Its own keys rather than reusing `create`/`cancel`, because the
  // wording carries the reassurance that matters here: an existing directory is not touched.
  'baseMissing.confirmTitle': '确认重建',
  'baseMissing.confirmBody': '将在该路径创建目录并注册为工作区。若该目录已存在，其内容不会被修改。',
  'baseMissing.confirmAction': '确认重建',
  'baseMissing.confirmBusy': '正在重建…',
  'baseMissing.confirmBack': '返回',
  'actions.project.aria': '项目“{name}”的操作',
} as const satisfies Record<ProjectWorkspaceKey, string>

/** English project copy, checked complete against the zh key set. */
export const PROJECT_LOCALE_EN = {
  'project.add': 'New project',
  'project.create.title': 'New project',
  'project.create.placeholder': 'Project name',
  'field.projectName': 'Project name',
  'create': 'Create',
  'rename.project.title': 'Rename project',
  'edit.project': 'Edit project',
  'edit.project.title': 'Edit project',
  'save': 'Save',
  'field.directories': 'Associated directories',
  'field.links': 'Associated links',
  'field.docSpec': 'Document spec',
  'docSpec.followGlobal': 'Follow global',
  'docSpec.none': 'None',
  'docSpec.default': 'Default',
  'directory.add': 'Add directory',
  'directory.none': 'No associated directories',
  'directory.remove': 'Remove {path}',
  'link.add': 'Add link',
  'link.none': 'No associated links',
  'link.remove': 'Remove {url}',
  'link.invalid': 'Must start with http:// or https://',
  'link.countInvalid': '{n} links failed validation',
  // "row(s)" is deliberate: `verify-locales` checks key and placeholder parity, not English
  // grammar, so avoiding a plural branch costs nothing and saves a second key.
  'link.countBlank': '{n} empty row(s) ignored on save',
  'delete.project': 'Delete project',
  'delete.project.desc': 'This deletes the project “{name}”. Its sessions are not deleted; they return to Ungrouped.',
  'delete.project.pending': 'Deleting project…',
  'conflict.projectNamed': 'A project named “{name}” already exists.',
  'baseMissing.title': 'Base workspace missing',
  'baseMissing.body': 'It is where every session this plugin creates lands; without it, no session can be started.',
  'baseMissing.path': 'Missing: {path}',
  'baseMissing.pathUnknown': 'Missing: the default workspace (path unknown)',
  'baseMissing.rebuild': 'Re-create this workspace',
  'baseMissing.respecify': 'Choose another base workspace',
  'baseMissing.confirmTitle': 'Confirm re-creation',
  'baseMissing.confirmBody': 'This creates the directory at that path and registers it as a workspace. If it already exists, its contents are left untouched.',
  'baseMissing.confirmAction': 'Re-create',
  'baseMissing.confirmBusy': 'Re-creating…',
  'baseMissing.confirmBack': 'Back',
  'actions.project.aria': 'Project actions for {name}',
} as const satisfies Record<ProjectWorkspaceKey, string>

/**
 * The eight `workspace` dictionaries in the shape
 * `ctx.locale.register('workspace', …)` accepts.
 *
 * `zh` and `en` carry all 159 keys; the six rc.1 languages are upstream's dictionaries
 * untouched — 119 keys each, no project copy — and resolve the 40 through the fallback
 * chain to English. See the module doc for why that is safe.
 *
 * The return type is asserted through `unknown` because the six really are incomplete and
 * `register`'s type demands completeness. That is the accepted degradation, not an
 * oversight: the assertion is the one line where the accepted gap is visible, and the two
 * `satisfies` checks above are where completeness for `zh`/`en` is actually proven.
 *
 * @returns all eight dictionaries keyed by locale id.
 */
export function workspaceDictionaries(): Record<'zh' | 'en', Record<WorkspaceKey, string>>
  & Record<string, Record<WorkspaceKey, string>> {
  const merged = {
    // Upstream's text wins on a collision. There is none today — the 40 keys were chosen to
    // be absent from upstream — and if a future upstream key ever lands on one of ours, its
    // wording is the one that should ship.
    zh: { ...PROJECT_LOCALE_ZH, ...upstreamZh },
    en: { ...PROJECT_LOCALE_EN, ...upstreamEn },
    ja, es, fr, de, ru, pt,
  }
  return merged as unknown as Record<'zh' | 'en', Record<WorkspaceKey, string>>
    & Record<string, Record<WorkspaceKey, string>>
}
