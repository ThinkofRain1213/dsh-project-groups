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
import { useState } from 'react'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NewSessionTarget } from '../protocol.ts'
import type { clientNewSessionTarget } from './grouping.ts'
import type { SETTINGS_NS } from './settings-locales.ts'
import css from './settings-card.module.css'

/**
 * The destinations, in display order: the default first, then the two that
 * follow existing Sessions.
 */
const OPTIONS: readonly NewSessionTarget[] = ['ungrouped', 'current', 'recent']

/** Registration-side face: the stored destination and its writer. */
export interface ProjectGroupsCardInjected {
  /**
   * The stored destination. Declared in the `hooks` compartment, so the renderer
   * binds it as a `useTarget` selector hook — the same mechanism the vendored
   * browser's `useWorkspaces` seat uses.
   */
  hooks: { target: typeof clientNewSessionTarget }
  /** Persist one destination. Resolves after the Host accepts it. */
  setTarget: (target: NewSessionTarget) => void
}

/** Full component props assembled by the Plugin manager renderer. */
export type ProjectGroupsCardProps =
  PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<typeof SETTINGS_NS>
  & InjectFace<ProjectGroupsCardInjected>

/**
 * Render the New Session destination selector.
 * @param props - composed slot props.
 * @returns the settings row.
 */
export function ProjectGroupsCard({ useTarget, setTarget, t }: ProjectGroupsCardProps) {
  const target = useTarget(value => value)
  const [open, setOpen] = useState(false)
  // The type says the stored value is always one of the three, but a value
  // written by a future version is a real possibility; showing the default beats
  // rendering an empty pill and an empty label.
  const selected = OPTIONS.includes(target) ? target : 'ungrouped'

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('title')}</div>
        <div className={css.desc}>{t('description')}</div>
      </div>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={OPTIONS.map(value => ({ id: value, label: t(value) }))}
        selectedId={selected}
        onSelect={(id) => {
          setOpen(false)
          setTarget(id as NewSessionTarget)
        }}
        align="end"
        // The card sits inside the Plugins page's scrolling detail column, whose
        // overflow would crop an in-place list.
        portal
        anchor={(
          <button
            type="button"
            className={css.selector}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setOpen(value => !value) }}
          >
            {t(selected)}
            <IconChevronDownOutlineRegular className={css.chevron} />
          </button>
        )}
      />
    </div>
  )
}
