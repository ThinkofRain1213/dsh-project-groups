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
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's New Session destination card. */
    'settings.projectGroups': ProjectGroupsSettingsKey
  }
}
