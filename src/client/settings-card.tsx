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
import type { WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BaseWorkspaceSetting, NewSessionTarget } from '../protocol.ts'
import type { clientBaseWorkspace, clientNewSessionTarget } from './grouping.ts'
import type { SETTINGS_NS } from './settings-locales.ts'
import { BaseWorkspacePicker } from './base-workspace-picker.tsx'
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
  hooks: {
    target: typeof clientNewSessionTarget
    /** The stored base-workspace setting; see `spec.ts` for why a path, not an id. */
    baseWorkspace: typeof clientBaseWorkspace
    /**
     * The Workspace registry, for the chooser. Absent when the controller is not
     * composed, in which case the chooser reports "暂无工作区" rather than throwing.
     */
    workspaces?: WorkspaceSource | undefined
  }
  /** Persist one destination. Resolves after the Host accepts it. */
  setTarget: (target: NewSessionTarget) => void
  /** Persist the base-workspace choice. Resolves after the Host accepts it. */
  setBaseWorkspace: (setting: BaseWorkspaceSetting) => void
}

/** Full component props assembled by the Plugin manager renderer. */
export type ProjectGroupsCardProps =
  PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<typeof SETTINGS_NS>
  & InjectFace<ProjectGroupsCardInjected>

/**
 * Render the New Session destination selector and the base-workspace choice.
 * @param props - composed slot props.
 * @returns the settings rows.
 */
export function ProjectGroupsCard({
  useTarget, setTarget, useBaseWorkspace, setBaseWorkspace, useWorkspaces, t,
}: ProjectGroupsCardProps) {
  const target = useTarget(value => value)
  const [open, setOpen] = useState(false)
  // The type says the stored value is always one of the three, but a value
  // written by a future version is a real possibility; showing the default beats
  // rendering an empty pill and an empty label.
  const selected = OPTIONS.includes(target) ? target : 'ungrouped'

  const base = useBaseWorkspace(value => value)
  // The hook is optional in the face, so the call is guarded rather than assumed.
  const workspaceSnapshot = useWorkspaces === undefined ? undefined : useWorkspaces(value => value)
  const workspaces = workspaceSnapshot?.items ?? []
  const [picking, setPicking] = useState(false)

  // The Workspace the setting names, when it is still registered. Matched by **path**:
  // re-registering a directory mints a new id (see `spec.ts`), so an id comparison
  // would report a perfectly good Workspace as gone after a delete-and-re-add.
  const chosen = base.path === undefined
    ? null
    : workspaces.find(item => item.path === base.path) ?? null
  // The remembered Workspace is no longer registered. Deliberately **not** gated on
  // `mode`: the path survives a switch to 默认 (that is what lets switching back restore
  // the choice), so a stale memory deserves the note whichever mode is showing.
  // Reported, never auto-cleared: the user may have removed it by mistake and mean to
  // add it back, and clearing would decide that for them.
  const gone = base.path !== undefined && base.path !== '' && chosen === null
  const specifiedLabel = base.path === undefined || base.path === ''
    ? t('baseNotChosen')
    : gone
      ? t('baseGone', { name: base.name ?? base.path })
      : (base.name ?? base.path)

  return (
    <>
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

      {/*
        The base workspace, laid out as the official appearance row is (three cards
        there, two here). Its stylesheet is copied rather than imported: the client
        bundle's purity gate rejects a value import from a package outside
        PLATFORM_MODULES / INLINE_SAFE, and `ui-theme` is not one.
      */}
      <div className={css.group}>
        <div className={css.groupTitle}>{t('baseTitle')}</div>
        <div className={css.cubeRow}>
          <button
            type="button"
            aria-pressed={base.mode === 'default'}
            className={base.mode === 'default' ? `${css.cube} ${css.selected}` : css.cube}
            onClick={() => { setBaseWorkspace({ mode: 'default' }) }}
          >
            <span className={css.cubeName}>{t('baseModeDefault')}</span>
            {/* The official default Workspace's directory is derived on the Host and
              * is not part of the registry snapshot, so a card cannot name it without
              * an extra round trip. It says what the mode means instead; the path
              * appears where it is actionable — the missing-workspace dialog. */}
            <span className={css.cubePath}>{t('baseDefaultHint')}</span>
          </button>

          <button
            type="button"
            aria-pressed={base.mode === 'specified'}
            className={base.mode === 'specified' ? `${css.cube} ${css.selected}` : css.cube}
            onClick={() => {
              // Choosing "specified" **is** choosing a Workspace, so this opens the
              // chooser whenever there is no *usable* memory to restore: nothing stored
              // yet, or stored but no longer registered. Writing a dead path would be
              // either refused or silently unresolvable.
              //
              // The guard is on `chosen` rather than on `gone` so the narrow below is
              // real: `gone` is a boolean, and TS cannot see that it implies non-null.
              if (chosen === null) {
                setPicking(true)
                return
              }
              // A registered memory is restored directly, which is what makes toggling
              // 默认 ⇄ 指定 stop asking the user to pick again.
              setBaseWorkspace({ mode: 'specified', path: chosen.path, name: chosen.title })
            }}
          >
            <span className={css.cubeName}>{t('baseModeSpecified')}</span>
            <span
              className={gone ? `${css.cubePath} ${css.cubeWarn}` : css.cubePath}
              title={base.path ?? ''}
            >
              {specifiedLabel}
            </span>
            {/*
              A span, not a button: a <button> inside a <button> makes React log a
              validateDOMNesting error on every mount, and several probes fail on
              console errors. `stopPropagation` is required — without it this click
              also switches the mode (measured).
            */}
            <span
              role="button"
              tabIndex={0}
              className={css.cubeAction}
              aria-label={t('baseChoose')}
              onClick={(event) => { event.stopPropagation(); setPicking(true) }}
              onKeyDown={(event) => {
                // A span has no built-in activation, so Enter and Space are handled here.
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                event.stopPropagation()
                setPicking(true)
              }}
            >
              {t('baseChoose')}
            </span>
          </button>
        </div>
      </div>

      {picking && (
        <BaseWorkspacePicker
          workspaces={workspaces}
          selectedPath={base.path}
          onCancel={() => { setPicking(false) }}
          onConfirm={(workspace) => {
            setPicking(false)
            // Committed only here: a row click stages, the dialog's 确认 writes.
            setBaseWorkspace({ mode: 'specified', path: workspace.path, name: workspace.title })
          }}
          t={t}
        />
      )}
    </>
  )
}
