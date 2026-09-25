/**
 * `project-groups` namespace dictionaries (the browsing region's copy).
 *
 * The registration declares `locale: NS`, so the renderer binds a `t` seat
 * from this namespace and injects it as a component prop. Simplified Chinese is
 * the key-set source of truth; the English dictionary is checked complete
 * against it.
 */

/** Dictionary namespace owned by this plugin's browsing region. */
export const NS = 'project-groups'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'section.ungrouped': '未分组',
  'section.sessions': '会话',
  'action.newSession': '新会话',
  'action.newSession.aria': '新会话',
  'empty.sessions': '还没有会话',
  'time.now': '刚刚',
  'time.min': '{n} 分钟',
  'time.hour': '{n} 小时',
  'time.day': '{n} 天',
  'row.running': '进行中',
  'row.open.aria': '打开会话“{name}”',
} satisfies Record<string, string>

/** The `project-groups` namespace key union. */
export type ProjectGroupsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'section.ungrouped': 'Ungrouped',
  'section.sessions': 'Conversations',
  'action.newSession': 'New session',
  'action.newSession.aria': 'New session',
  'empty.sessions': 'No conversations yet',
  'time.now': 'now',
  'time.min': '{n} min',
  'time.hour': '{n} h',
  'time.day': '{n} d',
  'row.running': 'Running',
  'row.open.aria': 'Open conversation “{name}”',
} satisfies Record<ProjectGroupsKey, string>
