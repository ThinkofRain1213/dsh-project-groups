/**
 * Locale-owned copy for this plugin's own settings card.
 *
 * A namespace of its own, not the vendored sidebar's: the card is this plugin's
 * surface, and the vendored half's dictionary is upstream's copy kept 1:1 for
 * re-sync (`src/vendored/README.md`). Mixing the two would make every future
 * upstream dictionary diff unreadable.
 *
 * The namespace name follows the official convention for a plugin's own settings
 * page (`settings.pluginInventory`, `settings.agentPreset`).
 */
// The augmentation target, and — since `LocaleNamespaceMap` is imported here — the type the
// namespace-id guard at the bottom compares against.
import type { LocaleNamespaceMap } from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace owned by the settings card. */
export const SETTINGS_NS = 'settings.projectGroups'

/** Chinese dictionary and key source. */
export const zh = {
  title: '新会话落点',
  description: '顶部“新会话”按钮与快捷键落在哪里',
  ungrouped: '未分组',
  current: '当前会话所在项目',
  recent: '最后活跃的会话所在项目',
  createOpensTitle: '新建项目时开启会话',
  createOpensDesc: '与官方「添加工作区」一致：建完项目直接进入一个可对话的会话',
  // Project-context injection. The base switch is the master: with it off the
  // plugin contributes no runtime context at all, which is why the document
  // switch below is rendered disabled rather than merely ineffective.
  injectInfoTitle: '注入项目信息',
  injectInfoDesc: '把当前会话所属项目的名称与关联目录写进模型的运行时上下文',
  injectDocTitle: '注入项目文档',
  injectDocDesc: '额外注入项目工作文档那一行',
  // Shown while the master switch is off. It names the switch that owns the
  // decision, so a disabled control does not read as a broken one.
  injectDocGated: '由「注入项目信息」控制，现已关闭',
  // The spec source: which document format the injected lines point at. The
  // three cards mirror the base-workspace row, so the wording does too.
  specTitle: '文档规范',
  specModeNone: '无',
  // The three cards each answer a different question: 无 states the POLICY, 默认
  // names the source, 自定义 names the file. 「不更新格式」 is that policy — the
  // plugin will not ask for a format change — and the two clauses state what it
  // means for a document that has a structure and for one that does not.
  //
  // Deliberately not just 「不要求任何格式」, which reads as "write it however you
  // like" and would license reorganising a document that already has a structure.
  specModeNoneHint: '不更新格式：无既定格式则自由书写，有既定格式则在其基础上书写',
  specModeDefault: '默认',
  specModeDefaultHint: '使用插件内置的规范',
  specModeCustom: '自定义',
  // The 更换… action inside the 自定义 card, and the two wordings its value line
  // takes when the slot holds no usable spec.
  //
  // The line is dynamic on purpose. "This slot is empty" only matters to a user
  // who is RELYING on the slot, so the warning appears only while 自定义 is the
  // highlighted card; with 无/默认 selected the same empty slot is just an
  // ordinary 「未选择」. Warning there would flag a slot nothing depends on.
  //
  // `specFileUnset` takes `.cubePath`'s ordinary colour, matching the Workspace
  // card's own 「未选择」; `specFilePlaceholder` takes `.cubeNotice` (amber).
  specFileUnset: '未选择',
  specFilePlaceholder: '当前未选择规范，将自动解析为无规范',
  specChoose: '更换…',
  // Selection dialog.
  specPickerTitle: '选择文档规范',
  specPickerAria: '已上传的规范',
  specUpload: '上传规范',
  specDelete: '删除',
  specDeleteTitle: '永久删除此规范？',
  specDeleteDesc: '「{name}」将被永久删除，此操作不可撤销。',
  specDeleteUsedOne: '有 1 个项目正在使用它；删除后该项目将回退为「无规范」。',
  specDeleteUsedMany: '有 {n} 个项目正在使用它；删除后它们将回退为「无规范」。',
  specDeleteConfirm: '永久删除',
  specExists: '已存在同名规范，请换一个文件名。',
  specNotMarkdown: '只接受 .md 文件。',
  specUploadFailed: '上传失败，请重试。',
  specDeleteFailed: '删除失败，请重试。',
  // The inline notice shown while nothing is selected. Two wordings because the
  // cause differs and the user can act on it: an empty list can be filled by
  // uploading, whereas a list with no row picked just needs a click. They share
  // one outcome, so they share one colour and one position.
  //
  // "将自动解析为" rather than "确认将回退到": confirming no longer changes the
  // mode, so an empty custom slot falls back through `resolveSpec` on its own.
  // The old wording claimed the click caused it.
  specNoticeNone: '当前未选中任何规范，使用自定义规范时将自动解析为无规范',
  specNoticeEmpty: '当前列表为空，使用自定义规范时将自动解析为无规范',
  // The per-project row switch.
  perProjectSpecTitle: '为每项目单独调整文档规范',
  perProjectSpecDesc: '开启后，新建与编辑项目对话框会多出一行规范选择',
  perProjectSpecGated: '由「注入项目文档」控制，现已关闭',
  // The link-validation switch. Its own row rather than a member of the spec group: a
  // project's links are registered whether or not anything about its document is injected.
  //
  // The description states what the switch does NOT do — a save is never refused — because
  // 「校验」 alone reads as a gate, and a user who expected one would read an accepted
  // non-URL as the rule having been applied and passed.
  validateLinksTitle: '开启http(s)://校验',
  validateLinksDesc: '标记不以 http:// 或 https:// 开头的关联链接；只作标记，不阻止保存',
  confirm: '确认',
  // The base workspace: the directory every New Session lands in.
  //
  // `baseDesc` is the user's own wording, settled 2026-10-12 in preference to the longer
  // versions drafted here. It states the need and the purpose in one clause, and deliberately
  // avoids 「落点」/「落在」: that word already names the setting above this one, which decides
  // which *project* a Session belongs to. Reusing it here would blur the two settings that are
  // easiest to confuse.
  baseTitle: '底层工作区',
  baseDesc: '需要选择一个真实工作区用于保存会话',
  baseModeDefault: '默认工作区',
  baseDefaultHint: '官方首次创建的工作区',
  // Shown instead of `baseDefaultHint` while the default Workspace cannot be resolved.
  //
  // 「会弹窗确认是否重建」, never 「会自动创建」: the official flow does not rebuild itself once
  // its pointer dangles, and a New Session click really does raise the confirmation dialog.
  baseDefaultMissing: '默认工作区缺失，新建会话时会弹窗确认是否重建',
  baseRebuild: '重建默认工作区',
  baseRebuildConfirmTitle: '确认重建默认工作区',
  baseRebuildConfirmBody: '将在默认位置创建目录并注册为工作区；若该目录已存在，其内容不会被修改。',
  baseRebuildBusy: '正在重建…',
  baseRebuildError: '重建失败，请重试。',
  baseModeSpecified: '指定工作区',
  baseNotChosen: '未选择',
  baseGone: '{name}（已不存在）',
  baseChoose: '更换…',
  baseDefaultName: '默认工作区',
  basePickerTitle: '选择底层工作区',
  basePickerAria: '现有工作区',
  basePickerEmpty: '暂无工作区',
  cancel: '取消',
  close: '关闭',
  // The injection preview. One block rather than keys beside the switches above: it is its own
  // subject with its own vocabulary, and the diff labels are only meaningful next to each other.
  //
  // The note explains the bracket convention, and only that. It used to carry a second sentence
  // about the link-validation switch (it marks and does not filter, so switching it off changes
  // nothing about what is injected); the user removed it (2026-10-13) — the switch sits several
  // rows above, and a sentence about it here explained the switch rather than this block.
  //
  // The preview is two groups (user's decision, 2026-10-13): 当前注入内容预览 is the text the
  // current switches produce, 不同状态下的分块差异 is the per-state differences. Each is a heading
  // over its own content, with a rule between them — so there is no second-level label under either.
  //
  // The first heading says 预览 deliberately: the block below it is a **sample**, assembled from
  // placeholders rather than from a real project, and a reader who took it for live data would look
  // for their own project's name in it.
  injectionTitle: '当前注入内容预览',
  injectionOff: '「注入项目信息」已关闭，本插件不向请求注入任何内容。',
  injectionNote: '[方括号] 内是你设置的内容，实际注入时按项目数据替换。',
  injectionDiffTitle: '不同状态下的分块差异',
  diffOwningTitle: 'owning project 段',
  diffOwningFiled: '有归属项目',
  diffOwningUnfiled: '未分组',
  diffDirectoriesTitle: 'relevant directories 段',
  // The dialog's own wording for the empty state, reused verbatim so the two places a user meets
  // an unset list — the edit dialog and this preview — say the same thing.
  diffDirectoriesNone: '未添加关联目录',
  diffDirectoriesOne: '只有一条',
  diffDirectoriesMany: '多条',
  diffLinksTitle: 'related links 段',
  diffLinksNone: '未添加关联链接',
  diffLinksOne: '只有一条',
  diffLinksMany: '多条',
  diffDocumentTitle: 'work document 段',
  diffDocumentSpec: '有规范',
  diffDocumentNoSpec: '无规范',
  diffDocumentDrift: '规范漂移',
}

/** Keys accepted by the card's translator. */
export type ProjectGroupsSettingsKey = keyof typeof zh

/** English dictionary with the same complete key set. */
export const en: Record<ProjectGroupsSettingsKey, string> = {
  title: 'New Session destination',
  description: 'Where the New Session button and shortcut file an unscoped Session',
  ungrouped: 'Ungrouped',
  current: "The current Session's project",
  recent: 'The most recently active project',
  createOpensTitle: 'Open a Session on create',
  createOpensDesc: 'Like the official add-workspace flow: land in a Session you can type into',
  injectInfoTitle: 'Inject project info',
  injectInfoDesc: "Write the current Session's project name and associated directories into the model's runtime context",
  injectDocTitle: 'Inject project document',
  injectDocDesc: 'Also inject the line naming the project work document',
  injectDocGated: 'Controlled by "Inject project info"; currently off',
  specTitle: 'Document spec',
  specModeNone: 'None',
  specModeNoneHint: 'No format update: write freely, or build on the existing format',
  specModeDefault: 'Default',
  specModeDefaultHint: "use the plugin's built-in spec",
  specModeCustom: 'Custom',
  specFileUnset: 'none chosen',
  specFilePlaceholder: 'no spec chosen; a custom spec resolves to no spec',
  specChoose: 'Change…',
  specPickerTitle: 'Choose a document spec',
  specPickerAria: 'Uploaded specs',
  specUpload: 'Upload spec',
  specDelete: 'Delete',
  specDeleteTitle: 'Permanently delete this spec?',
  specDeleteDesc: '“{name}” will be permanently deleted. This cannot be undone.',
  specDeleteUsedOne: '1 project is using it; that project will fall back to "None".',
  specDeleteUsedMany: '{n} projects are using it; they will fall back to "None".',
  specDeleteConfirm: 'Delete permanently',
  specExists: 'A spec with that name already exists. Choose another file name.',
  specNoticeNone: 'No spec is selected; a custom spec resolves to no spec',
  specNoticeEmpty: 'The list is empty; a custom spec resolves to no spec',
  specNotMarkdown: 'Only .md files are accepted.',
  specUploadFailed: 'Upload failed. Try again.',
  specDeleteFailed: 'Delete failed. Try again.',
  perProjectSpecTitle: 'Adjust the document spec per project',
  perProjectSpecDesc: 'Adds a spec row to the create and edit project dialogs',
  perProjectSpecGated: 'Controlled by "Inject project document"; currently off',
  validateLinksTitle: 'Validate http(s)://',
  validateLinksDesc: 'Mark associated links that do not start with http:// or https://. Marks only; never blocks saving.',
  baseTitle: 'Base workspace',
  baseDesc: 'A real workspace must be selected to store sessions',
  baseModeDefault: 'Default workspace',
  baseDefaultHint: 'the workspace created on first use',
  baseDefaultMissing: 'The default workspace is missing; a New Session will ask whether to rebuild it',
  baseRebuild: 'Rebuild default workspace',
  baseRebuildConfirmTitle: 'Rebuild the default workspace?',
  baseRebuildConfirmBody: 'The directory will be created at the default location and registered as a workspace. An existing directory is left untouched.',
  baseRebuildBusy: 'Rebuilding…',
  baseRebuildError: 'Rebuild failed. Try again.',
  baseModeSpecified: 'Specific workspace',
  baseNotChosen: 'none chosen',
  baseGone: '{name} (no longer exists)',
  baseChoose: 'Change…',
  baseDefaultName: 'Default workspace',
  basePickerTitle: 'Choose a base workspace',
  basePickerAria: 'Existing workspaces',
  basePickerEmpty: 'No workspaces',
  confirm: 'Confirm',
  cancel: 'Cancel',
  close: 'Close',
  // The injection preview; see the zh block for why it is two groups, why the first heading says
  // "preview", and why the note is one sentence.
  injectionTitle: 'Preview of the current injection',
  injectionOff: '"Inject project info" is off, so this plugin injects nothing.',
  injectionNote: 'Text in [brackets] is your own content, substituted from the project at request time.',
  injectionDiffTitle: 'Segment differences across states',
  diffOwningTitle: 'owning project segment',
  diffOwningFiled: 'Filed under a project',
  diffOwningUnfiled: 'Ungrouped',
  diffDirectoriesTitle: 'relevant directories segment',
  diffDirectoriesNone: 'No associated directories',
  diffDirectoriesOne: 'Exactly one',
  diffDirectoriesMany: 'More than one',
  diffLinksTitle: 'related links segment',
  diffLinksNone: 'No associated links',
  diffLinksOne: 'Exactly one',
  diffLinksMany: 'More than one',
  diffDocumentTitle: 'work document segment',
  diffDocumentSpec: 'With a spec',
  diffDocumentNoSpec: 'Without a spec',
  diffDocumentDrift: 'Spec drift',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's New Session destination card. */
    'settings.projectGroups': ProjectGroupsSettingsKey
  }
}

/**
 * Compile-time guard: the literal in the augmentation above and {@link SETTINGS_NS} must be the
 * same string.
 *
 * The namespace is written twice because TypeScript requires an interface member key to be a
 * string literal, so the augmentation cannot reference the constant. That makes a one-sided
 * rename compile clean while silently detaching the typed lookup from the runtime namespace
 * registration — the card would then render untranslated keys with no error anywhere.
 *
 * `LocaleNamespaceMap` is imported rather than copied, so this compares against the same
 * interface the augmentation targets: change the literal there and `typeof SETTINGS_NS` no
 * longer extends its keys, the conditional resolves to `never`, and the assignment below fails
 * to compile. The `void` is what keeps the value from being reported as unused; the assertion
 * is the point, not the runtime value.
 */
type SettingsNamespaceIsRegistered =
  typeof SETTINGS_NS extends keyof LocaleNamespaceMap ? true : never
const settingsNamespaceIsRegistered: SettingsNamespaceIsRegistered = true
void settingsNamespaceIsRegistered
