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
import { useEffect, useState } from 'react'
import { Button, IconChevronDownOutlineRegular, Menu, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BaseWorkspaceSetting, DocSpecMode, NewSessionTarget } from '../protocol.ts'
import type { BaseWorkspaceChooserRequest } from './index.ts'
import type {
  clientBaseWorkspace, clientCreateOpensSession, clientDocSpecFileName, clientDocSpecMode,
  clientInjectProjectDoc, clientInjectProjectInfo, clientNewSessionTarget, clientPerProjectDocSpec,
  clientSpecs,
} from './grouping.ts'
import type { SETTINGS_NS } from './settings-locales.ts'
import { BaseWorkspacePicker } from './base-workspace-picker.tsx'
import { SpecPicker } from './spec-picker.tsx'
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
     * Whether creating a project also opens a Session inside it.
     *
     * The same observable the vendored sidebar reads, so the switch and the create
     * dialog can never disagree about the behaviour.
     */
    createOpensSession: typeof clientCreateOpensSession
    /**
     * Whether a Session's project info is injected into its requests.
     *
     * Host-side state: the injection happens at request time in `src/index.ts`,
     * so this seat exists only so the switch reflects the stored value.
     */
    injectProjectInfo: typeof clientInjectProjectInfo
    /**
     * Whether the work-document line is injected too.
     *
     * Rendered disabled while {@link injectProjectInfo} is off: the base switch
     * is the master, and a control that cannot take effect must not look like it
     * can.
     */
    injectProjectDoc: typeof clientInjectProjectDoc
    /** Which spec source applies before any per-project override. */
    docSpecMode: typeof clientDocSpecMode
    /** The uploaded spec `'custom'` names; `''` when none is chosen yet. */
    docSpecFileName: typeof clientDocSpecFileName
    /** Whether the project dialogs expose a per-project spec row. */
    perProjectDocSpec: typeof clientPerProjectDocSpec
    /** Every uploaded spec, sorted; feeds the picker and the per-project dropdown. */
    specs: typeof clientSpecs
    /**
     * The Workspace registry, for the chooser. Absent when the controller is not
     * composed, in which case the chooser reports "暂无工作区" rather than throwing.
     */
    workspaces?: WorkspaceSource | undefined
    /**
     * A request from elsewhere — today the missing-workspace dialog — to open the
     * chooser. Read on first render as well as on change, which is what makes it
     * survive the card not being mounted when the request was raised.
     */
    chooserRequest: HostObservable<BaseWorkspaceChooserRequest | null>
  }
  /** Consume the chooser request so a repeat is a new value rather than a silent no-op. */
  settleBaseWorkspaceChooser: () => void
  /** Persist one destination. Resolves after the Host accepts it. */
  setTarget: (target: NewSessionTarget) => void
  /** Persist the base-workspace choice. Resolves after the Host accepts it. */
  setBaseWorkspace: (setting: BaseWorkspaceSetting) => void
  /** Persist whether creating a project opens a Session. */
  setCreateOpensSession: (value: boolean) => void
  /** Persist whether a Session's project info is injected. */
  setInjectProjectInfo: (value: boolean) => void
  /** Persist whether the work-document line is injected too. */
  setInjectProjectDoc: (value: boolean) => void
  /** Persist which spec source applies before any per-project override. */
  setDocSpecMode: (mode: DocSpecMode) => void
  /** Persist the uploaded spec `'custom'` names. */
  setDocSpecFileName: (name: string) => void
  /** Persist whether the project dialogs expose a per-project spec row. */
  setPerProjectDocSpec: (value: boolean) => void
  /** Store one uploaded spec; resolves false when the name is taken. */
  uploadSpec: (name: string, content: string) => Promise<boolean>
  /** Delete one uploaded spec; resolves false when nothing was removed. */
  deleteSpec: (name: string) => Promise<boolean>
  /** The titles of projects that would fall back if the named spec were deleted. */
  specsUsedBy: (name: string) => Promise<readonly string[]>
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
  useTarget, setTarget, useBaseWorkspace, setBaseWorkspace, useWorkspaces,
  useChooserRequest, settleBaseWorkspaceChooser,
  useCreateOpensSession, setCreateOpensSession,
  useInjectProjectInfo, setInjectProjectInfo,
  useInjectProjectDoc, setInjectProjectDoc,
  useDocSpecMode, setDocSpecMode,
  useDocSpecFileName, setDocSpecFileName,
  usePerProjectDocSpec, setPerProjectDocSpec,
  useSpecs, uploadSpec, deleteSpec, specsUsedBy, t,
}: ProjectGroupsCardProps) {
  const target = useTarget(value => value)
  const [open, setOpen] = useState(false)
  // The type says the stored value is always one of the three, but a value
  // written by a future version is a real possibility; showing the default beats
  // rendering an empty pill and an empty label.
  const selected = OPTIONS.includes(target) ? target : 'ungrouped'

  const base = useBaseWorkspace(value => value)
  const openOnCreate = useCreateOpensSession(value => value)
  const injectInfo = useInjectProjectInfo(value => value)
  const injectDoc = useInjectProjectDoc(value => value)
  const docSpecMode = useDocSpecMode(value => value)
  const docSpecFileName = useDocSpecFileName(value => value)
  const perProjectSpec = usePerProjectDocSpec(value => value)
  const specs = useSpecs(value => value)
  /**
   * Whether `'custom'` currently names a spec that exists on disk.
   *
   * Both the card's click handler and the picker's empty case read this, so it is
   * derived once. `specs` is the Host's own listing, so a file deleted outside the
   * plugin is reflected without another round trip.
   */
  const hasUsableSpec = docSpecFileName !== '' && specs.includes(docSpecFileName)
  const [pickingSpec, setPickingSpec] = useState(false)
  /**
   * Whether confirming the spec chooser should also switch the mode to `'custom'`.
   *
   * The chooser has two entry points and they mean different things:
   *   - the 自定义 CARD (when it has no usable file) — "I want custom mode";
   *   - the 更换… action — "replace the remembered file".
   *
   * Only the first switches the mode. Confirming a replacement used to write
   * `'custom'` unconditionally, so replacing the file while 默认 was selected also
   * jumped the card to 自定义.
   */
  const [specPickerSwitchesMode, setSpecPickerSwitchesMode] = useState(true)  // The hook is optional in the face, so the call is guarded rather than assumed.
  const workspaceSnapshot = useWorkspaces === undefined ? undefined : useWorkspaces(value => value)
  const workspaces = workspaceSnapshot?.items ?? []
  const [picking, setPicking] = useState(false)

  // A request from the missing-workspace dialog. Read on mount as well as on change, which is
  // what makes it survive the ordering 3a creates: the request is written as the dialog
  // navigates here, so the card often mounts *after* the write. A snapshot read returns live
  // state, so the effect below sees it either way; consuming it (setting `null`) is what makes
  // a second request a new value rather than a repeat that never changes.
  const chooserRequest = useChooserRequest(value => value)
  useEffect(() => {
    if (chooserRequest === null) return
    setPicking(true)
    settleBaseWorkspaceChooser()
  }, [chooserRequest, settleBaseWorkspaceChooser])

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
  //
  // 「未选择」means **never picked one**, and nothing else. It must not be reachable by a
  // mode switch: a `'default'` write retains the memory (see `withDefaultMode`), and the
  // optimistic frame retains it too — so a missing path here really is a fresh setting.
  // Reading it as "no path on screen right now" is what let a one-frame
  // `{ mode: 'default' }` render 「未选择」 before flipping back.
  const neverChosen = base.path === undefined || base.path === ''
  const gone = !neverChosen && chosen === null
  const specifiedLabel = neverChosen
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
        Creating a project, and whether it also opens a Session. Placed between the
        destination and the base workspace because it belongs to the same question —
        what a New Session does — while the row below is a technical choice about
        where the directory is.
      */}
      <div className={css.row}>
        <div className={css.rowText}>
          <div className={css.title}>{t('createOpensTitle')}</div>
          <div className={css.desc}>{t('createOpensDesc')}</div>
        </div>
        <Switch
          checked={openOnCreate}
          onChange={setCreateOpensSession}
          label={t('createOpensTitle')}
        />
      </div>

      {/*
        Project-context injection. The first switch is the master: with it off the
        plugin contributes no runtime context at all, so the second is disabled
        rather than left clickable-but-ineffective. Its stored value is kept as it
        is — reopening the master restores whatever the user had chosen — which is
        why the disabled control still shows its `checked` state rather than a
        forced `false`.
      */}
      <div className={css.row}>
        <div className={css.rowText}>
          <div className={css.title}>{t('injectInfoTitle')}</div>
          <div className={css.desc}>{t('injectInfoDesc')}</div>
        </div>
        <Switch
          checked={injectInfo}
          onChange={setInjectProjectInfo}
          label={t('injectInfoTitle')}
        />
      </div>

      <div className={css.row}>
        <div className={css.rowText}>
          <div className={injectInfo ? css.title : `${css.title} ${css.gated}`}>{t('injectDocTitle')}</div>
          <div className={injectInfo ? css.desc : `${css.desc} ${css.gated}`}>
            {injectInfo ? t('injectDocDesc') : t('injectDocGated')}
          </div>
        </div>
        <Switch
          checked={injectDoc}
          onChange={setInjectProjectDoc}
          label={t('injectDocTitle')}
          disabled={!injectInfo}
          // Hover text states why the control is locked, which is what the
          // primitive's own contract asks for; the description line carries the
          // same fact for readers who do not hover.
          {...injectInfo ? {} : { title: t('injectDocGated') }}
        />
      </div>

      {/*
        The document spec group. Everything here is gated on the document switch:
        with no document line injected, a spec has nothing to describe, so the
        whole group is disabled rather than left settable-but-inert — the same
        reasoning that gates the document switch on the master one above.
      */}
      <div className={css.group}>
        <div className={injectDoc && injectInfo ? css.groupTitle : `${css.groupTitle} ${css.gated}`}>
          {t('specTitle')}
        </div>
        <div className={css.cubeRow}>
          {/*
            The three cards mirror the base-workspace row, **including its
            chooser**: the 自定义 card carries the 更换… action itself rather than
            a separate row below it. The earlier version had a read-only path
            field under the row, which is the rejected "point at a path" shape —
            a spec is an uploaded file, so the only meaningful action is opening
            the picker.
          */}
          {/*
            The highlight follows the STORED mode, never the resolved spec.
            
            Highlighting what the resolver would return made deleting a file look
            like it had changed the setting: the highlight moved to 无 on its own,
            with nothing written ("删除只是删除，怎么自动跳到无规范了"). The
            base-workspace card beside this one behaves the stored way too — the
            chosen Workspace is flagged when it is missing rather than unselected.

            The movement to 无 happens only through the 「未选中任何规范」
            confirmation, because that is what writes `'none'`.
          */}
          {([
            ['none', 'specModeNone', 'specModeNoneHint'],
            ['default', 'specModeDefault', 'specModeDefaultHint'],
          ] as const).map(([mode, name, hint]) => (
            <button
              key={mode}
              type="button"
              aria-pressed={docSpecMode === mode}
              disabled={!injectDoc || !injectInfo}
              className={docSpecMode === mode ? `${css.cube} ${css.selected}` : css.cube}
              onClick={() => { setDocSpecMode(mode) }}
            >
              <span className={css.cubeName}>{t(name)}</span>
              <span className={css.cubePath}>{t(hint)}</span>
            </button>
          ))}

          <button
            type="button"
            aria-pressed={docSpecMode === 'custom'}
            disabled={!injectDoc || !injectInfo}
            className={docSpecMode === 'custom' ? `${css.cube} ${css.selected}` : css.cube}
            onClick={() => {
              // The mode is written only when it names a file that EXISTS. Writing
              // `'custom'` with nothing chosen stores a mode whose resolved spec is
              // "none", so the card would sit highlighted on 自定义 while the
              // injection says no format is required — the illegal state the user
              // reported. A stored name whose file has since been deleted is the
              // same case, which is why this checks membership rather than an empty
              // string.
              //
              // The base-workspace card uses the identical rule: no usable value
              // means open the chooser and write nothing.
              if (!hasUsableSpec) {
                // Opened from the card: the user is choosing this mode, so
                // confirming must switch to it.
                setSpecPickerSwitchesMode(true)
                setPickingSpec(true)
                return
              }
              setDocSpecMode('custom')
            }}
          >
            <span className={css.cubeName}>{t('specModeCustom')}</span>
            {/*
              The value line, which is DYNAMIC when the slot holds no usable spec.
              
              An empty slot only matters to someone relying on it, so the amber
              warning shows only while 自定义 is the highlighted card. With 无/默认
              selected the same empty slot reads as an ordinary 「未选择」 — flagging
              it there would warn about a slot nothing depends on.
              
              A stored name whose file is gone takes the same two states: it is not
              in effect, so it is not displayed either way, and `title` carries only
              a name that is actually usable — leaving the stale name there would
              keep leaking it on hover after the visible text stopped showing it.
            */}
            <span
              className={
                hasUsableSpec
                  ? css.cubePath
                  : docSpecMode === 'custom'
                    ? `${css.cubePath} ${css.cubeNotice}`
                    : css.cubePath
              }
              {...hasUsableSpec ? { title: docSpecFileName } : {}}
            >
              {hasUsableSpec
                ? docSpecFileName
                : docSpecMode === 'custom' ? t('specFilePlaceholder') : t('specFileUnset')}
            </span>
            {/* A span, not a button: nesting a button inside a button makes React
              * log validateDOMNesting, and the browser probes fail on console
              * errors. `stopPropagation` keeps this click from also re-selecting
              * the mode. */}
            <span
              role="button"
              tabIndex={0}
              className={css.cubeAction}
              aria-label={t('specChoose')}
              onClick={(event) => {
                event.stopPropagation()
                // Opened from 更换…: replace the remembered file only. The mode
                // is whatever the cards say it is.
                setSpecPickerSwitchesMode(false)
                setPickingSpec(true)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                event.stopPropagation()
                setSpecPickerSwitchesMode(false)
                setPickingSpec(true)
              }}
            >
              {t('specChoose')}
            </span>
          </button>
        </div>

        <div className={css.row}>
          <div className={css.rowText}>
            <div className={injectDoc && injectInfo ? css.title : `${css.title} ${css.gated}`}>
              {t('perProjectSpecTitle')}
            </div>
            <div className={injectDoc && injectInfo ? css.desc : `${css.desc} ${css.gated}`}>
              {injectDoc && injectInfo ? t('perProjectSpecDesc') : t('perProjectSpecGated')}
            </div>
          </div>
          <Switch
            checked={perProjectSpec}
            onChange={setPerProjectDocSpec}
            label={t('perProjectSpecTitle')}
            disabled={!injectDoc || !injectInfo}
            {...injectDoc && injectInfo ? {} : { title: t('perProjectSpecGated') }}
          />
        </div>
      </div>

      {pickingSpec && (
        <SpecPicker
          specs={specs}
          // Preselected on the stored name, so the dialog opens on the current
          // state and a replacement is one click. The name is a memory that
          // outlives a mode switch, and showing it here is the point: this dialog
          // REPLACES the remembered spec.
          //
          // Guarded on existence only: a name whose file was deleted must not
          // stage a dead row that 确认 would then write straight back.
          selected={hasUsableSpec ? docSpecFileName : undefined}
          onUpload={uploadSpec}
          onDelete={deleteSpec}
          onUsedBy={specsUsedBy}
          onConfirm={(name) => {
            setPickingSpec(false)
            // The chooser edits the 自定义 slot's VALUE, and nothing else.
            //
            // `undefined` is the slot being emptied, which is a legitimate state
            // rather than an error: the card has no spec, so it RESOLVES to "no
            // format required" through `resolveSpec`. The amber line on the card
            // already says exactly that ("未选择规范，将会回退到无规范"), and it
            // keeps saying it after this write. What must NOT happen is moving the
            // highlight to 「无」 — that would be this dialog choosing a mode for
            // the user. The highlight moves only when the user clicks a card.
            setDocSpecFileName(name ?? '')
            // The one exception is the flag: confirming a chooser that was opened
            // by clicking the 自定义 card completes that click, so it switches the
            // mode. 更换… never sets this flag — it is the editor for the slot's
            // value, and confirming there means "use this file", not "switch me".
            if (specPickerSwitchesMode) setDocSpecMode('custom')
          }}
          onCancel={() => { setPickingSpec(false) }}
          t={t}
        />
      )}

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
          // Preselected on the stored path, so replacing the remembered Workspace
          // is one click. The path is a memory that outlives a switch to 默认, and
          // this dialog is what replaces it — so it belongs here even when the
          // mode is 默认.
          selectedPath={base.path}
          onCancel={() => { setPicking(false) }}
          onConfirm={(workspace) => {
            setPicking(false)
            // Committed only here: a row click stages, the dialog's 确认 writes.
            //
            // The MODE is carried through unchanged — this dialog replaces the
            // remembered Workspace, and picking one while 默认 is selected must
            // not also switch the mode. Switching is what the cards are for.
            // Sending `'specified'` here is what made 更换… jump the card.
            setBaseWorkspace({ mode: base.mode, path: workspace.path, name: workspace.title })
          }}
          t={t}
        />
      )}
    </>
  )
}
