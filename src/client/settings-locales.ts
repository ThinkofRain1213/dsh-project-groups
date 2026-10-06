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
import type {} from '@deepseek-ai/dsh-client-ui-slots'

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
  confirm: '确认',
  // The base workspace: the directory every New Session lands in.
  baseTitle: '底层工作区',
  baseModeDefault: '默认工作区',
  baseDefaultHint: '官方首次创建的工作区',
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
  perProjectSpecTitle: 'Adjust the document spec per project',
  perProjectSpecDesc: 'Adds a spec row to the create and edit project dialogs',
  perProjectSpecGated: 'Controlled by "Inject project document"; currently off',
  baseTitle: 'Base workspace',
  baseModeDefault: 'Default workspace',
  baseDefaultHint: 'the workspace created on first use',
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
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's New Session destination card. */
    'settings.projectGroups': ProjectGroupsSettingsKey
  }
}
