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
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Button, IconArchiveCheckOutlineRegular, IconArchiveOffOutlineRegular, IconArchiveOutlineRegular,
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular, IconChevronsUpDownOutlineRegular, IconClockOutlineRegular, IconCloseFillRegular,
  IconCloseOutlineRegular, IconFlatListOutlineRegular, IconFolderCloseRegular,
  IconInfoOutlineRegular,
  IconPlusOutlineRegular,
  IconProjectAddOutlineRegular,
  IconQueueOutlineRegular, IconSearchOutlineRegular, IconSlidersTwoOutlineRegular,
  IconWorkspaceTreeOutlineRegular, Menu, type MenuEntry, Modal, StateDot, Toast, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  SessionListState, SessionSearchResultItem,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceBrowserProps } from '../contract/slots.ts'
import type {
  ArchivedFilter, GroupNode, GroupSource, SessionNode, SessionOrderBy, SessionRowState,
} from '../tree.ts'
import {
  deriveFlat, deriveGroups, deriveSearchResults, orderByRecency, owningGroupKey, owningParentFolder,
  owningSourceKey,
  pinCurrentBlank, reconcileManualOrder, sameStringList, sessionMemberIds, UNGROUPED_KEY,
} from '../tree.ts'
import { ProjectRowItem, SearchResultItem, SessionNodeItem, sessionRowKey } from './Rows.tsx'
import { AnimatedRows } from './AnimatedRows.tsx'
import { FLAT_SESSION_ORDER_KEY, type SessionGroupBy } from '../stores.ts'
// The validation rule itself, imported rather than reimplemented: it is shared with the
// Host half (`protocol.ts` is the two halves' vocabulary), and a local copy would be free
// to drift from what the Host means when it speaks about links. Registered as a vendored
// patch in `src/vendored/README.md`, like every other change to this tree.
import { isBlankLink, isValidLink } from '../../../protocol.ts'
import { WorkspacePickFlow } from '../WorkspacePicker.tsx'
import css from './WorkspaceBrowser.module.css'

/**
 * Column slide length (--ds-transition-duration-slow): rail-search focus waits it out —
 * focus() forces a synchronous layout and would jank the slide.
 */
const EXPAND_SLIDE_MS = 300
/** Pause between the latest keystroke and a Host content-search request. */
const SEARCH_DEBOUNCE_MS = 250
/** `session.search` wire bound, measured in JavaScript UTF-16 code units. */
const SEARCH_QUERY_MAX_CODE_UNITS = 500
/** Idle Session rows visible per Workspace before the local overflow control. */
const COLLAPSED_SESSION_LIMIT = 5
/**
 * Shared empty `enteringKeys`, so the ordinary render hands `AnimatedRows` a stable array.
 *
 * A fresh `[]` per render would be a new value each time, and the animation layer would have to
 * compare contents to stay quiet; one frozen empty array keeps identity meaningless when there is
 * nothing to animate.
 */
const EMPTY_ENTERING_KEYS: readonly string[] = Object.freeze([])

/** Keep provisional and running rows outside the idle-session quota, including parents with running children. */
function collapsedSessionRows(sessions: readonly SessionNode[], limit = COLLAPSED_SESSION_LIMIT): {
  rows: readonly SessionNode[]
  hiddenCount: number
} {
  let idleCount = 0
  const rows = sessions.filter((session) => {
    if (session.blank || session.running || session.runningSubagentCount > 0) return true
    if (idleCount >= limit) return false
    idleCount += 1
    return true
  })
  return { rows, hiddenCount: sessions.length - rows.length }
}

/** Keep controlled input and RPC payload inside the session.search wire contract. */
function sanitizeSearchQuery(value: string): string {
  const withoutNul = value.replaceAll('\0', '')
  if (withoutNul.length <= SEARCH_QUERY_MAX_CODE_UNITS) return withoutNul
  let end = SEARCH_QUERY_MAX_CODE_UNITS
  const last = withoutNul.charCodeAt(end - 1)
  const next = withoutNul.charCodeAt(end)
  if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end--
  return withoutNul.slice(0, end)
}

/**
 * Accept the native drag at document level while a row drag is active: row
 * hover still owns the insertion marker, and releasing outside the list must
 * not be rendered as a rejected drop before dragend commits that last marker.
 */
function useNativeDragAcceptance(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const acceptDrag = (event: DragEvent): void => {
      event.preventDefault()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
    }
    const acceptDrop = (event: DragEvent): void => { event.preventDefault() }
    document.addEventListener('dragover', acceptDrag)
    document.addEventListener('drop', acceptDrop)
    return () => {
      document.removeEventListener('dragover', acceptDrag)
      document.removeEventListener('drop', acceptDrop)
    }
  }, [active])
}

/** Grouping, ordering, and archived-filter menu; own open state so it resets with the wide chrome. */
function ViewOptionsMenu({ groupBy, orderBy, archivedFilter, onGroupPick, onOrderPick, onArchivedFilterPick, t }: {
  groupBy: SessionGroupBy
  orderBy: SessionOrderBy
  archivedFilter: ArchivedFilter
  onGroupPick: (mode: SessionGroupBy) => void
  onOrderPick: (mode: SessionOrderBy) => void
  onArchivedFilterPick: (filter: ArchivedFilter) => void
  t: WorkspaceBrowserProps['t']
}) {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={[
        { type: 'label' as const, id: 'group-by', text: t('groupBy.label') },
        { id: 'workspace', label: t('groupBy.workspace'), icon: <IconFolderCloseRegular /> },
        { id: 'workspace-tree', label: t('groupBy.workspaceTree'), icon: <IconWorkspaceTreeOutlineRegular /> },
        { id: 'flat', label: t('groupBy.flat'), icon: <IconFlatListOutlineRegular /> },
        { type: 'separator' as const, id: 'order-by-separator' },
        { type: 'label' as const, id: 'order-by', text: t('orderBy.label') },
        { id: 'manual', label: t('orderBy.manual'), icon: <IconChevronsUpDownOutlineRegular /> },
        { id: 'updated', label: t('orderBy.updated'), icon: <IconClockOutlineRegular /> },
        { type: 'separator' as const, id: 'archived-filter-separator' },
        { type: 'label' as const, id: 'filter-by', text: t('filterBy.label') },
        { id: 'hide-archived', label: t('viewOptions.hideArchived'), icon: <IconArchiveOffOutlineRegular /> },
        { id: 'show-archived', label: t('viewOptions.showArchived'), icon: <IconQueueOutlineRegular /> },
        { id: 'only-archived', label: t('viewOptions.onlyArchived'), icon: <IconArchiveCheckOutlineRegular /> },
      ]}
      selectedIds={[
        groupBy,
        orderBy,
        { default: 'hide-archived', show: 'show-archived', only: 'only-archived' }[archivedFilter],
      ]}
      onSelect={(id) => {
        if (id === 'workspace' || id === 'workspace-tree' || id === 'flat') onGroupPick(id)
        else if (id === 'manual' || id === 'updated') onOrderPick(id)
        else if (id === 'hide-archived') onArchivedFilterPick('default')
        else if (id === 'show-archived') onArchivedFilterPick('show')
        else if (id === 'only-archived') onArchivedFilterPick('only')
        setOpen(false)
      }}
      align="end"
      dense
      listClassName={css.viewOptionsMenu}
      // Portal: the section header clips overflow, so an in-place list would
      // be cut off at the header's bounds.
      portal
      anchor={(
        <Tooltip label={t('viewOptions.label')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={clsx(css.iconButton, css.wide)}
            aria-label={t('viewOptions.label')}
            onClick={() => { setOpen(v => !v) }}
          >
            <IconSlidersTwoOutlineRegular />
          </button>
        </Tooltip>
      )}
    />
  )
}

/** In-flight root-row drag: source identity plus the current insert marker. */
interface DragState {
  /** Workspace id, or {@link UNGROUPED_KEY} for the browser-local loose-session account. */
  accountKey: string
  sessionId: SessionNode['id']
  /** Source row was pinned at drag start; drop targets share the pinned block. */
  pinned: boolean
  /** Row the marker sits on and which half (insert above/below it). */
  over: { id: SessionNode['id']; half: 'before' | 'after' } | null
  /**
   * Group the pointer is currently over, when it differs from {@link accountKey}.
   *
   * Set while hovering another group's row (a positional drop) or its header
   * (a drop into the group, which leaves `over` null). `undefined` means the drag
   * has not left its own group, which is what keeps the shipped same-group
   * reorder path unchanged.
   */
  overGroupKey?: string | undefined
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
function insertIntoTargetOrder(
  order: readonly SessionId[],
  moving: SessionId,
  overId: SessionId,
  half: 'before' | 'after',
): SessionId[] {
  const next = order.filter(id => id !== moving)
  const index = next.indexOf(overId)
  // An unknown anchor cannot place the row: the front is the one position that is
  // always valid, and it matches a header drop.
  if (index === -1) return [moving, ...next]
  next.splice(index + (half === 'after' ? 1 : 0), 0, moving)
  return next
}

/** Apply a visible drop to the complete account without removing hidden members. */
function sessionDragOrder(
  order: readonly SessionId[],
  rows: readonly SessionNode[],
  drag: DragState,
  over: NonNullable<DragState['over']>,
): SessionId[] | undefined {
  const source = rows.find(row => row.id === drag.sessionId)
  const target = rows.find(row => row.id === over.id)
  if (source === undefined || target === undefined || source.blank
    || source.pinned !== drag.pinned || target.pinned !== drag.pinned
    || source.id === target.id || !order.includes(source.id)) return
  const section = rows.filter(row => row.pinned === drag.pinned)
  const sourceIndex = section.findIndex(row => row.id === source.id)
  const withoutSource = section.filter(row => row.id !== source.id)
  const insertAt = withoutSource.findIndex(row => row.id === target.id) + (over.half === 'after' ? 1 : 0)
  if (insertAt === sourceIndex) return
  const next = order.filter(id => id !== source.id)
  const targetIndex = next.indexOf(target.id)
  if (targetIndex === -1) return
  next.splice(targetIndex + (over.half === 'after' ? 1 : 0), 0, source.id)
  return pinCurrentBlank(next, rows.find(row => row.blank)?.id)
}

/**
 * In-flight group-row drag: source identity plus the current marker.
 *
 * The id is a Workspace id or a caller-supplied project key depending on
 * `kind`; both are plain strings on the wire, and the commit picks the verb.
 */
interface WorkspaceDragState {
  readonly kind: 'workspace' | 'project'
  readonly rowId: string
  over: { id: string; half: 'before' | 'after' } | null
}

/**
 * One group row requesting a dialog. A project row is not a Workspace, so the
 * request names which kind it is and lets the owner pick the right subject.
 */
export type RowRequest =
  | { readonly kind: 'workspace'; readonly id: WorkspaceId; readonly title: string }
  | {
    readonly kind: 'project'
    readonly id: string
    readonly title: string
    /**
     * Current directories, so the edit dialog starts from what is stored.
     *
     * Optional because the delete dialog shares this type and has no use for it:
     * a required field would force that caller to fabricate an empty list, which
     * is a value it holds no opinion about.
     */
    readonly directories?: readonly string[] | undefined
    /**
     * Current links, so the edit dialog starts from what is stored.
     *
     * Optional for the same reason as `directories`: the delete dialog shares this
     * type and has no use for it.
     */
    readonly links?: readonly string[] | undefined
    /**
     * The stored spec override: `'none'`, an uploaded file name, or absent to
     * inherit the global choice.
     *
     * Optional for the same reason as `directories`: the delete dialog shares
     * this type and has no use for it.
     */
    readonly docSpec?: string | undefined
  }

/** Resolve an insertion side across the Workspace header, descendants, and Sessions. */
function workspaceGroupHalf(e: { clientY: number; currentTarget: HTMLElement }): 'before' | 'after' {
  const rect = e.currentTarget.getBoundingClientRect()
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

/**
 * The source-folder rows shared by the create and edit dialogs.
 *
 * One component rather than two copies: the rows, their order and their remove
 * affordance are identical, and a second copy is where a styling or behaviour
 * difference would appear without anyone deciding it should.
 *
 * The remove control reuses {@link css.iconButton}, this file's own
 * icon-button rule — the same 28×28 transparent control the section header's
 * actions use. A bare `<button>` with only a colour set keeps the browser's
 * native chrome (grey fill, inset border), which is what made the first version
 * read as a foreign element inside an official-styled dialog.
 * @param props - the current list, whether the dialog is busy, and the remove sink.
 * @returns the empty placeholder, or the list.
 */
function DirectoryRows({
  paths, disabled, onRemove, t,
}: {
  paths: readonly string[]
  disabled: boolean
  onRemove: (path: string) => void
  t: WorkspaceBrowserProps['t']
}) {
  if (paths.length === 0) return <div className={css.directoryEmpty}>{t('directory.none')}</div>
  return (
    <ul className={css.directoryList}>
      {paths.map(path => (
        // Keyed by path, not index: removing a middle row would otherwise make
        // React reuse the wrong identity for every row after it.
        <li key={path} className={css.directoryRow}>
          <span className={css.directoryPath} title={path}>{path}</span>
          <button
            type="button"
            className={css.iconButton}
            disabled={disabled}
            aria-label={t('directory.remove', { path })}
            onClick={() => { onRemove(path) }}
          >
            <IconCloseOutlineRegular size={14} />
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * The add-folder header above {@link DirectoryRows}, shared by both dialogs.
 *
 * The control is the shell's own `Button` (`size="sm"`, `ghost`) with the add
 * glyph the official "new …" actions use — `ui-plugin-manager` and `ui-schedule`
 * both build theirs as `Button variant="primary" size="sm" icon={<IconPlusOutlineRegular/>}`.
 * `ghost` rather than `primary` because this is a repeatable, in-dialog action
 * beside a field, not the dialog's own commit; the primary weight belongs to
 * 创建 / 保存 in the footer.
 *
 * The first version was a bare `<button>` with only a colour set, which keeps the
 * browser's native chrome — grey fill, inset border — and inside an
 * official-styled dialog that reads as a foreign element.
 * @param props - the label, the add control's state, and its sink.
 * @returns the header row.
 */
function DirectoryHeader({
  label, onAdd, disabled, t,
}: {
  label: string
  onAdd: () => void
  disabled: boolean
  t: WorkspaceBrowserProps['t']
}) {
  return (
    <div className={css.directoryHeader}>
      <span className={css.directoryLabel}>{label}</span>
      <Button
        variant="ghost"
        size="sm"
        icon={<IconPlusOutlineRegular size={13} />}
        disabled={disabled}
        onClick={onAdd}
      >
        {t('directory.add')}
      </Button>
    </div>
  )
}

/**
 * The header above {@link LinkRows}, shared by both project dialogs.
 *
 * Same shape as {@link DirectoryHeader} plus one addition: the count of rows that fail the
 * `http(s)://` check, sitting **right of the label** rather than on its own line. Amber,
 * because it reports the same kind of fact the settings card's amber lines do — something
 * the surface remembers is not in the state its name implies.
 *
 * The count is passed in rather than derived here: the verdict belongs to each row's own
 * debounced check, and this component would otherwise have to duplicate the rule.
 * @param props - the label, the add control's state and sink, and the failing-row count.
 * @returns the header row.
 */
function LinkHeader({
  label, onAdd, disabled, invalidCount, blankCount, t,
}: {
  label: string
  onAdd: () => void
  disabled: boolean
  invalidCount: number
  /**
   * Rows left empty after being visited. Shown in a **dimmed** tone, not the amber the
   * invalid count uses: that one asks the user to fix something, while an empty row asks
   * for nothing — it is dropped on save either way. One colour for both would flatten
   * "needs attention" and "nothing to do" into a single signal.
   */
  blankCount: number
  t: WorkspaceBrowserProps['t']
}) {
  return (
    <div className={css.linkHeader}>
      {/*
        The label and both notices are one group, and the add control is the header's other
        child. That grouping is what makes the layout independent of the notices: with all
        of them as direct children the count had to carry `margin-right: auto` to push the
        button right, so the button's position collapsed to the left the moment there was
        nothing to report (measured). Splitting the alignment across a container and a child
        is what broke it; both ends are laid out by the container now, so neither notice can
        move the button.
      */}
      <span className={css.linkHeading}>
        <span className={css.linkLabel}>{label}</span>
        {/* `role="status"` rather than `alert`: a count that changes as the user types is
          * progress, not an error, and an alert on every keystroke would interrupt. */}
        {invalidCount > 0 && (
          <span className={css.linkInvalidCount} role="status">
            {t('link.countInvalid', { n: invalidCount })}
          </span>
        )}
        {blankCount > 0 && (
          <span className={css.linkBlankCount} role="status">
            {t('link.countBlank', { n: blankCount })}
          </span>
        )}
      </span>
      <Button
        variant="ghost"
        size="sm"
        icon={<IconPlusOutlineRegular size={13} />}
        disabled={disabled}
        onClick={onAdd}
      >
        {t('link.add')}
      </Button>
    </div>
  )
}

/** What a link row shows at its right edge; `idle` renders nothing. */
type LinkCheck = 'idle' | 'checking' | 'valid' | 'invalid'

/**
 * One link row of a dialog, as the **draft** holds it.
 *
 * ## Why a row carries an id at all
 *
 * The rows were keyed by **index** while a link's check runs off its **value**, so the two
 * identities disagreed the moment a row was removed. Deleting index `i` left every later
 * component holding the *next* value: each re-ran a check for a value no user had touched, and —
 * worse — for one frame it painted the verdict belonging to the value it used to hold onto the
 * value it now held.
 *
 * Measured with a passing row above a failing one: `["none","invalid"]` became `["none"]` and
 * stayed that way for ~17ms before the check restarted, so the row read as **passing** while its
 * text was `not a url`. With four rows that all failed the mispaired frame is invisible, because
 * a wrong verdict looks exactly like the right one.
 *
 * The id makes the component's identity and the data's identity the same thing again, so a row
 * can move without changing what it is. `key={url}` is not an option: the value is what the user
 * is editing, so keying on the value would remount the row — and drop focus — on every keystroke.
 */
interface LinkRowDraft {
  /** Stable for the row's whole life in the draft; never derived from the url or the position. */
  readonly id: string
  readonly url: string
}

/**
 * A fresh row identity.
 *
 * A counter rather than `crypto.randomUUID()`: ids only have to be unique **within one dialog's
 * draft**, so a counter cannot collide and needs nothing from the platform. Called from event
 * handlers and from the open handler — never during render, where a double invocation would burn
 * ids (`StrictMode` runs render twice; the ids would merely skip, but there is no reason to).
 */
let linkRowSeq = 0
function newLinkRow(url = ''): LinkRowDraft {
  linkRowSeq += 1
  return { id: `link-${linkRowSeq}`, url }
}

/**
 * The urls of a draft, in display order.
 *
 * This is the shape the check, both counts and the Host all consume, so it is also the only place
 * a draft's ids are dropped — the protocol and the stored record keep plain strings.
 * @param rows - the draft rows.
 * @returns their urls, in order.
 */
function linkUrls(rows: readonly LinkRowDraft[]): string[] {
  return rows.map(row => row.url)
}

/**
 * How many rows are empty, for the header's blank notice.
 *
 * ## Derived, not accumulated
 *
 * The first version kept a **set of indices** that rows added themselves to on blur. That
 * model was wrong, and the way it failed is worth keeping: removing a row cleared the whole
 * set on the theory that "every later index moved, and the next blur will redo it" — but a
 * blur only happens when focus actually moves. After a removal focus sits on the delete
 * button, nothing re-blurs, and the notice vanished for every remaining blank row and never
 * came back (reported from a screenshot: five empty rows, no notice).
 *
 * The set was also accumulating state that had to be patched in three places — typing,
 * removing, and opening the dialog — and every patch was a chance to drift from reality.
 * Asking "which rows are empty **right now**" needs no patches at all:
 *
 *   - removing a row cannot stale it, because the row is simply no longer in the list;
 *   - typing cannot stale it, because a non-blank row fails the emptiness test;
 *   - reopening cannot stale it, because the list is the draft that was just seeded.
 *
 * ## Empty alone, with no regard to focus
 *
 * An earlier rule also required the row to be **unfocused**, so the notice appeared only after
 * the user *left* a row. The user changed that on 2026-10-08: the row is dropped on save
 * because it is empty, and that is already true the moment it exists — waiting for a blur
 * stated the fact later than it became true. The focus bookkeeping existed for that rule and
 * nothing else, so it went with it.
 *
 * Two neighbours are **not** affected and keep their own focus logic: the per-row green check
 * (shown only while focused) and the auto-focus of a newly added row.
 *
 * ## Live, not settled
 *
 * It reads the **live** draft, and that is a deliberate layering decision (2026-10-09):
 * emptiness is a **fact** — visible in the input box, unable to be wrong — while a verdict is a
 * **judgement** that has to wait for the typing to stop. Feeding this count the settled snapshot
 * made a fact wait for a judgement, which is what showed clearing a row as an ⓘ that kept
 * spinning for half a second around a notice that had already appeared.
 *
 * From the live draft it can be reported the moment it is true: clearing a row adds one here in
 * the same pass as its ⓘ disappearing and the failing count dropping. The three move together
 * because all three describe the value that is on screen now.
 *
 * The `trim()` is {@link isBlankLink}'s, shared with `nonBlankLinks` on the storing side and
 * with the `idle` verdict `useLinkCheck` gives a blank row, so the three cannot describe
 * emptiness differently.
 * @param rows - the live draft.
 * @returns the number of empty rows.
 */
function countBlankLinks(rows: readonly LinkRowDraft[]): number {
  return rows.filter(row => isBlankLink(row.url)).length
}

/**
 * How long a row waits after the last change before it shows a verdict.
 *
 * Shared by the row's own check and the header's summary, and that sharing is the point: they
 * used to disagree, and the disagreement was user-visible (see {@link useSettledInvalidCount}).
 */
const LINK_CHECK_DEBOUNCE_MS = 500

/**
 * How many rows are failing, for the header's count.
 *
 * ## One condition, three defects
 *
 * A row counts only while the url it holds is **the one that was judged** — the same pairing
 * {@link useLinkCheck} applies to a single row. Everything the count has ever got wrong came from
 * missing that condition, and all of it goes away with it:
 *
 *   - a value the user has just typed **has no verdict yet**, so it cannot be announced as failing
 *     while the row beside it still spins (the count led the rows);
 *   - a value the user has just **cleared is no longer the judged one**, so its failure
 *     disappears in that same pass rather than half a second later (the count lagged them, and it
 *     kept asserting a failure about text that was no longer on screen);
 *   - deriving both notices in one render pass is what stops the failing count and the blank
 *     notice from appearing one pass apart.
 *
 * The first two were patched separately before this: a shared interval from a shared function, and
 * a "hold the previous number" mechanism on top. Both were treatments of the symptom, and this
 * pair is what makes them unnecessary — there is no previous number to hold, because an
 * unjudged row is simply not counted.
 *
 * ## Why `settled` is keyed by id
 *
 * The snapshot has to name **which** row reached a verdict, and an index would name the wrong row
 * after a removal — the mispairing this file already had once (see {@link LinkRowDraft}). Keyed by
 * id, a row that moved keeps its own entry.
 * @param rows - the live draft.
 * @param settled - the url each row concluded on; see {@link useSettledUrls}.
 * @param enabled - the 开启http(s)://校验 setting; off means nothing is counted.
 * @returns the number of rows whose current value was judged failing.
 */
function countInvalidLinks(
  rows: readonly LinkRowDraft[],
  settled: ReadonlyMap<string, string>,
  enabled: boolean,
): number {
  if (!enabled) return 0
  return rows.filter((row) => {
    // Not the judged value: either it is new (spinner) or it was just cleared (nothing to judge).
    if (settled.get(row.id) !== row.url) return false
    // A blank row is not a failing one — a failure is a verdict about content, and empty is the
    // absence of content. This arm is what keeps a cleared row out of the count even before the
    // pairing above would have.
    if (isBlankLink(row.url)) return false
    return !isValidLink(row.url.trim())
  }).length
}

/**
 * The url each row has concluded on, keyed by row id.
 *
 * ## Why the url, and not just a "settled" flag
 *
 * A verdict is only valid for the value it was reached for (see {@link useLinkCheck}), so the
 * header has to know **which value** each row's verdict belongs to. A boolean per row would say
 * "something settled" without saying what, which is exactly the gap the failing count fell
 * through: it needs to count a row only while the url on screen is the one that was judged.
 *
 * ## Why this replaced a "hold the previous snapshot" model
 *
 * The previous version kept the whole previous **list** and a separate function
 * (`headerShouldWait`) deciding when to hold it. That machinery existed to keep two notices in
 * step while a check was in flight, and it had to be re-reasoned for every transition — an
 * addition, a removal, an emptied row, the switch turning on. Two of those reasonings were wrong
 * in turn, and each was fixed by adding one more condition.
 *
 * This shape has no previous list to hold. A row whose url is not the settled one contributes
 * nothing, so "in flight" and "about to be judged" both fall out of a single comparison in the
 * consumer rather than out of a decision function here. There is nothing to hold because there is
 * nothing stale to display: the count simply does not include a row that has not concluded.
 *
 * ## Keyed by id
 *
 * The snapshot has to name **which** row concluded. An index would name the wrong row after a
 * removal — the mispairing this file already had once (see {@link LinkRowDraft}) — so the map is
 * keyed by the row's id and a row that moved keeps its own entry.
 *
 * ## Replaced wholesale, so nothing leaks
 *
 * The map is rebuilt from scratch when the interval expires: a removed row cannot leave an entry
 * behind, and the map cannot grow with the dialog's history. `setSettled` is called only in the
 * timer, never during render, so a render that does not commit cannot change what is displayed.
 *
 * ## The switch being off
 *
 * Nothing is judged with it off, so nothing is concluded — the map is emptied rather than left
 * describing a verdict the disabled setting no longer produces.
 *
 * ## Why this may lag a row's own spinner by a frame
 *
 * Both this interval and each row's own start from the same `rows` change, so they land within
 * the same frame. Should they ever be a frame apart, the failure mode is benign **by
 * construction**: a mismatch excludes a row from the count, it never adds one. The worst case is
 * therefore a count that appears one frame late — never a count that reports a verdict the row
 * beside it has not reached.
 *
 * It lives inside {@link LinkBlock}, which mounts and unmounts with its dialog (the official
 * `Modal` returns `null` when closed), so the map cannot outlive the rows it describes. The
 * version that kept this state at the dialog's top level survived the close and showed the
 * **previous** project's count on the next dialog; mounting them together is what removes that,
 * rather than a reset somebody has to remember.
 * @param rows - the live draft.
 * @param enabled - the 开启http(s)://校验 setting.
 * @returns the concluded url per row id; a row absent from it has not concluded.
 */
function useSettledUrls(
  rows: readonly LinkRowDraft[],
  enabled: boolean,
): ReadonlyMap<string, string> {
  const [settled, setSettled] = useState<ReadonlyMap<string, string>>(() => new Map<string, string>())
  useEffect(() => {
    // Off: nothing is judged, so nothing is concluded.
    if (!enabled) {
      setSettled(prev => (prev.size === 0 ? prev : new Map<string, string>()))
      return
    }
    // Any change restarts the interval for the whole list, which is the same rule each row applies
    // to itself: once it expires, nothing has moved for a full interval, so every row's verdict —
    // and only those — is current.
    const timer = setTimeout(() => {
      setSettled(new Map(rows.map(row => [row.id, row.url])))
    }, LINK_CHECK_DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [rows, enabled])
  return settled
}

/**
 * Debounced `http(s)://` validation for one link row.
 *
 * ## Why this is written by hand
 *
 * Measured against the installed DSH: **no official component validates an input as the
 * user types** — a whole-asar scan for a debounce next to input-and-validity semantics
 * found nothing. So there is no precedent to copy here, and this is a **deliberate
 * deviation** from the 1:1 UI, registered in `src/vendored/README.md`.
 *
 * ## Two layers, not one time line
 *
 * Emptiness and a verdict are different kinds of statement, so they get different clocks
 * (user's decision, 2026-10-09):
 *
 *   - **Emptiness is a fact.** It is visible in the input box, it cannot be wrong, and the three
 *     consumers of it — the row's own mark, the failing count, and the blank notice — all say
 *     what is true the moment it becomes true. So it is applied on the spot, with no wait.
 *   - **A verdict is a judgement.** It can be wrong while the user is still typing, which is the
 *     only reason to wait. So it takes `LINK_CHECK_DEBOUNCE_MS` and shows a spinner while it
 *     waits.
 *
 * Running the two on **one** time line is what the earlier version did, and it was wrong in the
 * expensive direction: it made a fact wait for a judgement, so clearing a row left its ⓘ spinning
 * for half a second and its failure counted for half a second after the text was gone. The wait
 * mechanism was then patched repeatedly — a shared interval, a "hold the previous number", a
 * blank-value fast path — because each patch treated a symptom of the two layers sharing a clock.
 *
 * ## The verdict is stored with its value
 *
 * `verdict` holds the mark **and the url it was reached for**, and the mark is derived during
 * render by comparing the two. That single pairing is what makes a verdict expire on its own:
 *
 *   - the url changed, so the old verdict is not a verdict **about this row** any more — it does
 *     not need to be cleared, it is already inapplicable, and no frame can paint it over the new
 *     value;
 *   - the url is unchanged and matches, so the verdict applies;
 *   - the url is unchanged and does not match yet, so the judgement is still in flight.
 *
 * Storing the mark alone (the earlier shape) meant the render that changed the value still
 * painted the previous mark, and an effect corrected it one pass later — a frame of the wrong
 * verdict, which is the same defect as the mispairing fixed by keying rows on an id.
 *
 * This is what answers "reward early": editing a row that was failing drops the failure in that
 * same pass, because its verdict no longer applies to the value now on screen. `edited` — the ref
 * that existed only to tell a born-blank row from an emptied one — is gone with it, since both are
 * simply empty now.
 *
 * ## Focus: shown, but not re-checked
 *
 * The **visible** state is derived on the way out rather than stored: a `valid` verdict shows
 * only while focused, while `checking` and `invalid` show regardless. That is the official
 * `ModelRow` behaviour and is deliberately kept.
 *
 * A focus gain no longer re-runs the check (user's decision, 2026-10-08: the verdict is already
 * right). The earlier version re-ran it, which is why this hook once carried a focus-gain
 * counter as a dependency — `focused` itself as the dependency made a **blur** re-run the check,
 * showing a spinner for half a second where the amber ⓘ is specified to stay. Nothing that can
 * change a verdict is lost by dropping the counter: editing changes `value`, and a focus change
 * does not.
 * @param value - the row's current input.
 * @param enabled - the 开启http(s)://校验 setting.
 * @returns the mark to render, plus the two handlers the input must bind.
 */
function useLinkCheck(value: string, enabled: boolean): {
  mark: LinkCheck
  onFocus: () => void
  onBlur: () => void
} {
  /**
   * The last verdict **and the url it was reached for**.
   *
   * `null` means this row has not concluded anything yet — either the value has never been judged
   * or it has changed since. Both are the same thing to the render below, which is why no
   * separate "not yet" state is needed.
   */
  const [verdict, setVerdict] = useState<{ url: string; mark: LinkCheck } | null>(null)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    // The switch being off takes the whole set away, so an in-flight timer goes too.
    if (!enabled) { setVerdict(null); return }
    // Emptiness is a fact, applied at once: there is nothing to judge, so there is no verdict and
    // no spinner. This is the layer that used to wait, and waiting is what made clearing a row
    // look like a check in progress.
    if (isBlankLink(value)) { setVerdict(null); return }
    // A non-blank value is judged, and the judgement waits for the typing to stop.
    const timer = setTimeout(() => {
      setVerdict({ url: value, mark: isValidLink(value.trim()) ? 'valid' : 'invalid' })
    }, LINK_CHECK_DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [value, enabled])
  /**
   * Derived during render rather than stored, so the mark always describes the value that is on
   * screen in this pass. A verdict whose url is not the current one contributes nothing.
   *
   * The switch is checked **here** as well as in the effect, and that is not redundant: with it
   * off the effect clears `verdict`, which would otherwise leave a non-blank row falling through
   * to `checking` — a spinner that never lands, because nothing is going to conclude. Caught by
   * `8) 关掉后不出标记` when this derivation was first written without it.
   */
  const settled: LinkCheck = !enabled || isBlankLink(value)
    ? 'idle'
    : verdict !== null && verdict.url === value
      ? verdict.mark
      : 'checking'
  return {
    // A green check is shown only while the row has focus; the other two show regardless.
    mark: settled === 'valid' && !focused ? 'idle' : settled,
    onFocus: () => { setFocused(true) },
    onBlur: () => { setFocused(false) },
  }
}

/**
 * One editable link row: a rounded field, its verdict at the right edge, and a remove
 * control.
 *
 * Modelled on the official `ModelRow` (`dsh-client-ui-settings-models`) rather than on
 * {@link DirectoryRows} beside it. The difference is the point: a directory is picked
 * through the native chooser and therefore rendered read-only, while a link is **typed**,
 * so the row has to be an input.
 *
 * Keyed by the row's own **id**, not by its value and not by its position. The value is what the
 * user edits, so keying on it would remount the row — and drop focus — on every keystroke; and
 * keying on the position made a removal hand this component the *next* row's value, so it
 * re-checked text nobody had touched and briefly showed a verdict belonging to another row.
 * @param props - the row's identity, its value, its position, and the two sinks.
 * @returns the row.
 */
function LinkRow({
  id, url, index, disabled, enabled, autoFocus, onEdit, onRemove, onAutoFocused, t,
}: {
  /** The row's stable identity within the draft; see {@link LinkRowDraft}. */
  id: string
  url: string
  /** 1-based position for the accessible name only — **not** an identity. */
  index: number
  disabled: boolean
  enabled: boolean
  /** Whether this is the row 「添加链接」 just created; see {@link LinkRow.onAutoFocused}. */
  autoFocus: boolean
  onEdit: (id: string, url: string) => void
  onRemove: (id: string) => void
  /**
   * Take focus on mount, because this row was just created by 「添加链接」.
   *
   * So the cursor is in the new row and the user can type straight away. It is **not** tied to
   * the header's blank notice: that notice counts empty rows regardless of focus, so a
   * freshly added row reads as blank immediately rather than being held back until it loses focus.
   * @param autoFocus - whether this is the freshly added row.
   * @param onAutoFocused - called once the focus has been taken, so the parent clears its
   * marker and a later render cannot steal focus back from wherever the user has moved on to.
   */
  onAutoFocused: () => void
  t: WorkspaceBrowserProps['t']
}) {
  const { mark: check, onFocus, onBlur } = useLinkCheck(url, enabled)
  const inputRef = useRef<HTMLInputElement>(null)
  // The callback through a ref: it is a fresh closure per parent render, and depending on it
  // directly would re-run this effect on every keystroke elsewhere in the dialog.
  const settled = useRef(onAutoFocused)
  settled.current = onAutoFocused
  useEffect(() => {
    if (!autoFocus) return
    inputRef.current?.focus()
    settled.current()
  }, [autoFocus])
  // The position is in the label because several rows share the same accessible name
  // otherwise — the official `ModelRow` does the same for its per-row controls.
  const position = String(index + 1)
  return (
    <li className={css.linkRow}>
      <span className={css.linkField}>
        <input
          ref={inputRef}
          className={css.linkInput}
          type="text"
          value={url}
          disabled={disabled}
          aria-label={`${t('field.links')} ${position}`}
          // `onFocus` / `onBlur` are `useLinkCheck`'s: they keep the green check visible only while
          // focused. A focus gain no longer re-runs the check, so these are display-only now.
          onFocus={onFocus}
          onBlur={onBlur}
          onChange={(event) => {
            // Nothing to tell the check any more: whether the row was born blank or emptied by the
            // user, empty is empty, and the hook reads it from `value` in the same pass.
            onEdit(id, event.target.value)
          }}
        />
        {check !== 'idle' && (
          <span
            className={css.linkStatus}
            // The tooltip carries the rule: an ⓘ alone does not say what failed.
            {...check === 'invalid' ? { title: t('link.invalid') } : {}}
          >
            {check === 'checking' && <StateDot state="ongoing" size={14} />}
            {check === 'valid' && <IconCheckOutlineRegular size={14} className={css.linkValid} />}
            {check === 'invalid' && <IconInfoOutlineRegular size={14} className={css.linkInvalid} />}
          </span>
        )}
      </span>
      {/* A real `<button>`, unlike the settings card's `role="button"` spans: this one is
        * not nested inside another button, so the native element is available. */}
      <button
        type="button"
        className={css.iconButton}
        disabled={disabled}
        aria-label={t('link.remove', { url })}
        onClick={() => { onRemove(id) }}
      >
        <IconCloseOutlineRegular size={14} />
      </button>
    </li>
  )
}

/**
 * The link list shared by the create and edit dialogs.
 *
 * The two dialogs render the same rows with the same rules; a second copy is where a
 * styling or behaviour difference would appear without anyone deciding it should — the
 * same reasoning {@link DirectoryRows} carries.
 * @param props - the list, the editing state, and the two sinks.
 * @returns the empty placeholder, or the list.
 */
function LinkRows({
  rows, disabled, enabled, autoFocusId, onAutoFocused, onEdit, onRemove, t,
}: {
  rows: readonly LinkRowDraft[]
  disabled: boolean
  enabled: boolean
  /**
   * The row 「添加链接」 just created, which takes focus on mount.
   *
   * So the cursor lands in the new row and the user can type straight away. It no longer
   * decides anything about the header's blank notice, which counts empty rows regardless of
   * focus.
   */
  autoFocusId: string | null
  /** Clears the marker once the focus has been taken, so a later render cannot steal it. */
  onAutoFocused: () => void
  onEdit: (id: string, url: string) => void
  onRemove: (id: string) => void
  t: WorkspaceBrowserProps['t']
}) {
  if (rows.length === 0) return <div className={css.linkEmpty}>{t('link.none')}</div>
  return (
    <ul className={css.linkList}>
      {rows.map((row, index) => (
        <LinkRow
          // The row's **own** identity. Keying by index made a removal hand every later component
          // the next row's value, so it re-checked text nobody touched and briefly showed the
          // verdict that belonged to the value it used to hold.
          key={row.id}
          id={row.id}
          url={row.url}
          // Position is still passed, but only to label the row: it is not an identity.
          index={index}
          disabled={disabled}
          enabled={enabled}
          autoFocus={row.id === autoFocusId}
          onAutoFocused={onAutoFocused}
          onEdit={onEdit}
          onRemove={onRemove}
          t={t}
        />
      ))}
    </ul>
  )
}

/**
 * The link block of a project dialog: its header, its rows, and the state they share.
 *
 * ## Why this is a component rather than inline JSX in the dialog
 *
 * The header's memory must not outlive the rows it describes. Measured before this existed: the
 * settled-count hook lived at the **dialog** component's top level, where it survives the dialog
 * closing, while every row unmounts with the dialog. That asymmetry produced two defects, and the
 * second is not a timing artefact at all:
 *
 *   - reopening the **same** project found the draft unchanged, so the header skipped the wait
 *     and showed its count before any row had been checked;
 *   - opening a **different** project showed the previous project's count for the whole wait —
 *     one project's number painted on another project's dialog.
 *
 * The official `Modal` returns `null` while closed (read from `dsh-client-ui-primitives`), so
 * mounting this with the dialog is enough: both halves are created and destroyed together, and
 * there is no "remember to reset" for a later edit to forget.
 *
 * It also removes five hand-written resets that existed only because the state outlived the
 * dialog, and the two `autoFocus` markers that had to be cleared from four different places.
 * @param props - the draft, its sink, and the switch and disabled flag both dialogs share.
 * @returns the block.
 */
function LinkBlock({ rows, onRowsChange, enabled, disabled, t }: {
  rows: readonly LinkRowDraft[]
  onRowsChange: (next: readonly LinkRowDraft[]) => void
  enabled: boolean
  disabled: boolean
  t: WorkspaceBrowserProps['t']
}) {
  // The id-keyed snapshot of what each row has concluded; see `useSettledUrls`.
  const settled = useSettledUrls(rows, enabled)
  /**
   * The row 「添加链接」 just created, which takes focus on mount.
   *
   * An id rather than an index: a removal shifts every later index, so an index marker could name
   * a row the user never added.
   */
  const [autoFocusId, setAutoFocusId] = useState<string | null>(null)
  return (
    <div className={css.linkBlock}>
      <LinkHeader
        label={t('field.links')}
        disabled={disabled}
        onAdd={() => {
          const row = newLinkRow()
          setAutoFocusId(row.id)
          onRowsChange([...rows, row])
        }}
        // Two layers, two sources, and that is the point: the blank notice is a **fact** about the
        // live draft, so it is reported the moment it is true, while the failing count is a
        // **judgement** and counts only rows whose current url is the one that was judged.
        invalidCount={countInvalidLinks(rows, settled, enabled)}
        blankCount={countBlankLinks(rows)}
        t={t}
      />
      <LinkRows
        rows={rows}
        disabled={disabled}
        enabled={enabled}
        autoFocusId={autoFocusId}
        onAutoFocused={() => { setAutoFocusId(null) }}
        onEdit={(id, url) => {
          // By id, not by position: the row being edited is the one the user typed in, whatever
          // slot it currently occupies.
          onRowsChange(rows.map(row => (row.id === id ? { ...row, url } : row)))
        }}
        onRemove={(id) => {
          onRowsChange(rows.filter(row => row.id !== id))
          // Not an index shift any more: this can only mean the row itself is gone.
          setAutoFocusId(current => (current === id ? null : current))
        }}
        t={t}
      />
    </div>
  )
}

/**
 * The per-project document-spec dropdown, shared by both project dialogs.
 *
 * ## 跟随全局 is a ROW, not a marker
 *
 * The list is fixed as `跟随全局 / 无 / 默认 / uploaded files…`, and inheritance is
 * the first row rather than a suffix spread across the others.
 *
 * The marker version needed a way to decide WHICH row was "the global one", and
 * with a global choice of 自定义-but-empty that question had no good answer: the
 * effective value is 无, but the choice is 自定义, so the marker either lied about
 * the choice or merged 自定义 into the 无 row. An explicit row removes the
 * question — the drop-down no longer needs to know what the global choice is at
 * all, which is why this component no longer takes it.
 *
 * | stored   | selected row                                |
 * |----------|---------------------------------------------|
 * | `null`   | 跟随全局                                    |
 * | `'none'` | 无                                          |
 * | name     | that uploaded file                          |
 *
 * A stored name whose file has been deleted resolves to the global choice, so it
 * selects 跟随全局: the row states what is IN EFFECT, the same rule the settings
 * card follows when it declines to display a spec that is not applied.
 *
 * ## Why no divider
 *
 * The two semantic choices and the uploaded files are the same kind of thing —
 * each is one value the project can hold, and selecting any of them is the same
 * act. A rule between them only implied a hierarchy that does not exist.
 * @param props - the draft, the uploaded names, and the change sink.
 * @returns the row.
 */
function DocSpecRow({
  value, specs, disabled, onChange, t,
}: {
  value: string | null
  specs: readonly string[]
  disabled: boolean
  onChange: (next: string | null) => void
  t: WorkspaceBrowserProps['t']
}) {
  const [open, setOpen] = useState(false)

  /**
   * Id of the row that means "inherit the global choice".
   *
   * A sentinel rather than `null`: a menu item needs a string id, and `null` is
   * already the stored value this row WRITES, so reusing it as the row id would
   * blur "the row" with "the setting".
   *
   * It cannot collide with a real entry: uploaded specs must end in `.md`
   * (`isSafeSpecName`), and the other two ids are `none` / `default`.
   */
  const FOLLOW_GLOBAL = 'follow-global'

  /**
   * The selectable rows, kept in their own array so the selected label can be read
   * off it: `MenuEntry` is a union that includes separators and headings, which
   * have no `label`, so searching the `items` array directly would not type-check.
   */
  const choices: readonly { readonly id: string; readonly label: string }[] = [
    { id: FOLLOW_GLOBAL, label: t('docSpec.followGlobal') },
    { id: 'none', label: t('docSpec.none') },
    { id: 'default', label: t('docSpec.default') },
    ...specs.map(name => ({ id: name, label: name })),
  ]

  const items: readonly MenuEntry[] = choices

  /**
   * Whether the stored override names a file that no longer exists.
   *
   * The Host's resolver treats a missing file as a stale override and falls back
   * to the global choice. Showing the stored name anyway would label the row with
   * a spec that is NOT in effect, so the failure shows up as a project quietly
   * following a different spec than its dialog claims.
   */
  const stale = value !== null && value !== 'none' && value !== 'default'
    && !specs.includes(value)

  /**
   * The row the current draft selects.
   *
   * `null` means "whatever the global choice is", and so does a stale override —
   * both are in effect "the global choice", so both select the 跟随全局 row.
   */
  const selectedId = value === null || stale ? FOLLOW_GLOBAL : value
  const selectedLabel = choices.find(entry => entry.id === selectedId)?.label
    ?? t('docSpec.followGlobal')

  return (
    /*
     * ONE row: label on the left, the selector pill on the right — the same
     * shape the directory block's header uses for its add action. The first
     * version stacked a label above a full-width button, which read as two
     * unrelated rows rather than one setting.
     */
    <div className={css.docSpecRow}>
      <span className={css.directoryLabel}>{t('field.docSpec')}</span>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={items}
        selectedId={selectedId}
        onSelect={(id) => {
          setOpen(false)
          // Picking 跟随全局 clears the override. It is the only row that writes
          // `null`, so no other selection can be confused with it.
          onChange(id === FOLLOW_GLOBAL ? null : id)
        }}
        align="end"
        // The project dialog clips its own overflow, so an in-place list is cut
        // off at the dialog's edge (measured: the list ran 7px past it and the
        // last row was sliced). The same reason the view-options menu above
        // portals.
        portal
        // The wrapper span is content-sized, so a percentage max-width would be
        // measured against the pill rather than the row. The class carries a
        // value relative to the row instead.
        className={css.docSpecMenu}
        anchor={(
          <button
            type="button"
            className={css.docSpecSelector}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={t('field.docSpec')}
            title={selectedLabel}
            disabled={disabled}
            onClick={() => { setOpen(open => !open) }}
          >
            <span className={css.docSpecValue}>{selectedLabel}</span>
            <IconChevronDownOutlineRegular size={14} className={css.chevron} />
          </button>
        )}
      />
    </div>
  )
}

type SessionTreeProps = Pick<
  WorkspaceBrowserProps,
  'useSessionStatus' | 'startSession' | 'open'
  | 'insertWorkspaceBefore' | 't' | 'usePanelInfo'
> & PropsRenderSlots<
  | 'sidebar.workspaces.session.menu.item'
  | 'sidebar.workspaces.session.row.action'
  | 'sidebar.session.row.leading'
  | 'sidebar.session.row.hover'
> & {
  shortcuts: readonly import('@deepseek-ai/dsh-client-shortcuts/client').ShortcutCatalogEntry[]
  /** Always-mounted Session list snapshot. */
  list: SessionListState
  /** Host account home for POSIX hover-path abbreviation. */
  home?: string | undefined
  /** Workspaces in Host group order with browser-projected Session order. */
  workspaces: readonly WorkspaceView[]
  /**
   * Active grouping-model override, or `undefined` to group by `workspaces`.
   * Group headings and the Ungrouped bucket follow this; row presentation,
   * drag targets and the Workspace dialogs keep using `workspaces`.
   */
  groupingOverride: readonly GroupSource[] | undefined
  /** Browser-projected order for Sessions outside every Workspace. */
  ungroupedSessionIds: readonly SessionId[]
  /** Whether the current Workspace stream has a complete Host baseline. */
  workspaceReady: boolean
  /** Grouping, ordering, and filter changes replace the view without row motion. */
  animationResetKey: string
  /** Nest Workspaces under their nearest registered ancestors. */
  nestWorkspaces: boolean
  /** Explicit persisted group expansion, including descendants in tree mode. */
  groupExpansion: Readonly<Record<string, boolean>>
  /** Persist one Workspace group's expansion. */
  setGroupExpanded: (key: string, expanded: boolean) => void
  /**
   * Expansion the caller owns, keyed by group key; absent when it does not.
   *
   * These keys are the caller's, not this browser's: writing them to the view
   * store would put them where the official plugin's mount prunes them, so a
   * caller that needs them kept supplies both this and `setProjectExpanded`.
   */
  projectExpansion?: Readonly<Record<string, boolean>> | undefined
  /** Record one caller-owned group's expansion. */
  setProjectExpanded?: ((key: string, expanded: boolean) => Promise<void>) | undefined
  /** Save a drag order and select Manual. */
  setSessionOrder: (accountKey: string, order: readonly string[]) => void
  /** Registry-global pin and archive sets plus the archived-visibility choice. */
  rowState: SessionRowState
  /** Switch the archived filter back to the default hide-archived view. */
  onLeaveArchivedOnly: () => void
  /** Open the browser-owned rename dialog for a group row. */
  onRenameRequest: (row: RowRequest) => void
  /** Open the browser-owned delete-confirmation dialog for a group row. */
  onDeleteRequest: (row: RowRequest) => void
  /**
   * Move one caller-supplied project before another; absent anchor appends.
   * Absent entirely without a project model, in which case project rows are
   * not draggable (a caller-supplied group with no verb behind it).
   */
  reorderProject?: ((id: string, beforeId?: string) => Promise<void>) | undefined
  /**
   * File one Session under one project. Absent, a project row's ＋ still creates
   * a Session but leaves it unfiled; see the inject face's note.
   */
  assignSession?: ((sessionId: SessionId, projectId: string) => Promise<void>) | undefined
  /**
   * Return one Session to Ungrouped.
   *
   * Paired with {@link assignSession}: together they are what makes a cross-group
   * drop possible. Absent either, a Session stays in the group it was dragged
   * from and the region behaves exactly as upstream.
   */
  unassignSession?: ((sessionId: SessionId) => Promise<void>) | undefined
  /** Current ordering mode; a positional cross-group drop switches it to manual. */
  orderBy: 'manual' | 'updated'
  /** Open the rename dialog from a row title double-click. */
  onSessionRenameRequest: (sessionId: SessionNode['id'], currentTitle: string) => void
  /** One Session chosen from search that must be exposed and scrolled into view. */
  revealSessionId?: SessionId | undefined
  /** Acknowledge that the chosen Session row has been revealed. */
  onSessionRevealed: (sessionId: SessionId) => void
  /**
   * Row keys arriving because a New Session flow just landed on them.
   *
   * Empty in the ordinary case. Non-empty only when the Session that landed reused a blank
   * Session already in the tree — its key was present last commit, so the entry fade has to be
   * asked for rather than inferred. See `AnimatedRows`.
   */
  enteringKeys: readonly string[]
  /** Release {@link enteringKeys} once the commit that drew them has run. */
  onEnteringKeysDrawn: () => void
}

/** The list-empty placeholder — a glyph over the text; the archived-only view names its filter and offers the way back. */
function EmptySessions({ rowState, onLeaveArchivedOnly, t }: Pick<SessionTreeProps, 'rowState' | 'onLeaveArchivedOnly' | 't'>) {
  const archivedOnly = rowState.archivedFilter === 'only'
  return (
    <div className={css.emptyState} data-row-key="empty">
      {archivedOnly ? <IconArchiveOutlineRegular size={24} /> : <IconQueueOutlineRegular size={24} />}
      <div>{archivedOnly ? t('empty.noneArchived') : t('empty.none')}</div>
      {archivedOnly && (
        <button type="button" className={css.emptyAction} onClick={onLeaveArchivedOnly}>
          {t('empty.viewOthers')}
        </button>
      )}
    </div>
  )
}

/** The scrolling session tree; unmounting drops the sessions subscription and local row limits. */
function SessionTree({
  list, useSessionStatus, startSession, open, workspaces, groupingOverride, ungroupedSessionIds,
  rowState, onLeaveArchivedOnly,
  workspaceReady, animationResetKey, usePanelInfo,
  onRenameRequest, onDeleteRequest, onSessionRenameRequest,
  reorderProject,
  assignSession,
  unassignSession,
  orderBy,
  renderSlot,
  insertWorkspaceBefore,
  nestWorkspaces, groupExpansion, setGroupExpanded,
  projectExpansion, setProjectExpanded,
  setSessionOrder, home, t,
  revealSessionId, onSessionRevealed, shortcuts, enteringKeys, onEnteringKeysDrawn,
}: SessionTreeProps) {
  const panelActive = usePanelInfo(info => info.activePanelId !== null)
  const statuses = useSessionStatus(s => s)
  const current = panelActive
    ? undefined
    : Object.values(list.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
  const revealGroup = revealSessionId === undefined || !workspaceReady
    ? undefined
    : groupingOverride === undefined
      ? owningGroupKey(workspaces, revealSessionId)
      : owningSourceKey(groupingOverride, revealSessionId)
  const [sessionLimits, setSessionLimits] = useState<Readonly<Record<string, number>>>({})
  // Transient drag marker state; the selected mode owns the resulting order.
  const [drag, setDrag] = useState<DragState | null>(null)
  const sessionDropCommitted = useRef(false)
  // Same value as `drag`, read from drag handlers. A handler closes over the
  // render that created it, so the state variable would be the value from that
  // render — stale by the time a drop fires.
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag
  const [workspaceDrag, setWorkspaceDrag] = useState<WorkspaceDragState | null>(null)
  // Same value as `workspaceDrag`, read from drag handlers. A handler closes
  // over the render that created it, so the state variable would be the value
  // from that render — stale by the time a drop fires.
  const workspaceDragRef = useRef<WorkspaceDragState | null>(null)
  workspaceDragRef.current = workspaceDrag
  const workspaceDropCommitted = useRef(false)
  const nativeDragActive = drag !== null || workspaceDrag !== null
  useNativeDragAcceptance(nativeDragActive)
  const currentGroup = current === undefined || !workspaceReady
    ? undefined
    : groupingOverride === undefined
      ? owningGroupKey(workspaces, current)
      : owningSourceKey(groupingOverride, current)
  // Expansion has two possible owners, and which one applies depends on the key.
  //
  // A caller-supplied project key is the caller's: it is written to their store
  // through `setProjectExpanded`, and read back from `projectExpansion`. Every
  // other key — a Workspace id, and the Ungrouped bucket — is this browser's, and
  // keeps using the view store exactly as upstream. The split exists because the
  // view store is shared with the official plugin, whose mount prunes every key
  // that is not a Workspace id, so a project's expansion kept there is lost as
  // soon as the official sidebar mounts.
  const projectKeys = useMemo(
    () => new Set(groupingOverride?.map(group => group.key) ?? []),
    [groupingOverride],
  )
  const isCallerOwned = useCallback(
    (key: string): boolean => setProjectExpanded !== undefined && projectKeys.has(key),
    [setProjectExpanded, projectKeys],
  )
  /**
   * Whether a group can take a Session dragged out of another group.
   *
   * A caller-supplied project is a real destination only when both verbs exist;
   * the Ungrouped bucket needs the unassign verb and is this browser's own
   * account, so it needs no project model. Without the verbs a cross-group drag
   * never activates, and the region behaves exactly as upstream.
   */
  const canReceiveDrag = useCallback((key: string): boolean => key === UNGROUPED_KEY
    ? unassignSession !== undefined
    : isCallerOwned(key) && assignSession !== undefined,
  [assignSession, isCallerOwned, unassignSession])
  /** Whether a key has ever been recorded, by whichever owner applies. */
  const hasExpansion = useCallback(
    (key: string): boolean => (isCallerOwned(key)
      ? Object.hasOwn(projectExpansion ?? {}, key)
      : Object.hasOwn(groupExpansion, key)),
    [isCallerOwned, projectExpansion, groupExpansion],
  )
  /** Record one key's expansion with its owner. */
  const recordExpansion = useCallback((key: string, expanded: boolean): void => {
    if (!isCallerOwned(key)) {
      setGroupExpanded(key, expanded)
      return
    }
    // The caller's store is remote, so the write is fire-and-forget here: their
    // model applies it optimistically and its own state drives the re-render.
    // A rejection is their concern to surface, not a render-time throw.
    void setProjectExpanded?.(key, expanded).catch(() => {})
  }, [isCallerOwned, setGroupExpanded, setProjectExpanded])
  useEffect(() => {
    if (current === undefined || currentGroup === undefined || hasExpansion(currentGroup)) return
    recordExpansion(currentGroup, true)
  }, [current, currentGroup, hasExpansion, recordExpansion])
  const parents = useMemo(() => {
    if (!nestWorkspaces) return new Map<string, WorkspaceId | undefined>()
    const keysByPath = new Map(workspaces.map(workspace => [workspace.path, workspace.workspaceId]))
    const paths = [...keysByPath.keys()]
    return new Map<string, WorkspaceId | undefined>(workspaces.map((workspace) => {
      const path = owningParentFolder(workspace.path, paths)
      return [workspace.workspaceId, path === undefined ? undefined : keysByPath.get(path)]
    }))
  }, [nestWorkspaces, workspaces])
  const currentAncestors = useMemo(() => {
    const keys = new Set<string>()
    for (let key = currentGroup === undefined ? undefined : parents.get(currentGroup); key !== undefined; key = parents.get(key)) {
      keys.add(key)
    }
    return keys
  }, [currentGroup, parents])
  const expandedGroups = useMemo(() => {
    const ancestorKeys = new Set<string | undefined>(parents.values())
    // Under an override the group keys are the caller's, not Workspace ids;
    // nesting still keys off `parents` (Workspace paths) and so contributes
    // only when the caller's keys happen to match — which they do not, leaving
    // the explicit expansion record in charge, exactly as in flat mode.
    const keys = groupingOverride === undefined
      ? workspaces.map(workspace => workspace.workspaceId)
      : groupingOverride.map(group => group.key)
    // The two records cannot collide: `projectExpansion` holds only keys the
    // caller owns, and a caller-owned key is never written to the view store.
    const expansion = { ...groupExpansion, ...projectExpansion }
    return [...keys, UNGROUPED_KEY]
      .filter(key => expansion[key] ?? ancestorKeys.has(key))
  }, [groupExpansion, projectExpansion, parents, workspaces, groupingOverride])
  const groups = useMemo(
    () => deriveGroups(list, workspaces, rowState, statuses, {
      expandedGroups,
      ungroupedOrder: ungroupedSessionIds,
    }, groupingOverride),
    [list, workspaces, rowState, statuses, expandedGroups, ungroupedSessionIds, groupingOverride],
  )
  useEffect(() => {
    for (let key = revealGroup; key !== undefined; key = parents.get(key)) {
      const recorded = isCallerOwned(key) ? projectExpansion?.[key] : groupExpansion[key]
      if (recorded === false || (key === revealGroup && recorded !== true)) {
        recordExpansion(key, true)
      }
    }
  }, [groupExpansion, projectExpansion, parents, revealGroup, isCallerOwned, recordExpansion])
  useEffect(() => {
    if (revealSessionId === undefined || revealGroup === undefined) return
    const group = groups.find(candidate => candidate.key === revealGroup)
    if (group === undefined || !group.expanded || !group.sessions.some(row => row.id === revealSessionId)) return
    if (collapsedSessionRows(group.sessions).rows.some(row => row.id === revealSessionId)) return
    setSessionLimits(limits => limits[revealGroup] === Infinity ? limits : { ...limits, [revealGroup]: Infinity })
  }, [groups, revealGroup, revealSessionId])
  const now = Date.now()
  /**
   * Commit a Session drop.
   * @param activeDrag - the drag being committed.
   * @param over - the row under the pointer, or null when the drop landed on a
   * group itself (its header or empty body) rather than on a row.
   * @param targetKey - the group the pointer released on. Passed explicitly
   * rather than read from `activeDrag.overGroupKey`, because a handler's closed
   * state can predate the last `dragOver`.
   */
  const commitSessionDrag = (
    activeDrag: DragState,
    over: NonNullable<DragState['over']> | null,
    targetKey: string = activeDrag.overGroupKey ?? activeDrag.accountKey,
  ): void => {
    if (sessionDropCommitted.current) return
    sessionDropCommitted.current = true
    setDrag(null)
    if (over !== null && over.id === activeDrag.sessionId) return

    // A drop outside the source group moves the Session between groups. That is
    // two decisions, not one: who owns it (the caller's assignment map) and where
    // it sits (the target's order).
    if (targetKey !== activeDrag.accountKey) {
      commitCrossGroupDrag(activeDrag, targetKey, over)
      return
    }

    const group = groups.find(candidate => candidate.key === activeDrag.accountKey)
    if (group === undefined || over === null) return
    const accountSessionIds = activeDrag.accountKey === UNGROUPED_KEY
      ? ungroupedSessionIds
      : workspaces.find(workspace => workspace.workspaceId === activeDrag.accountKey)?.sessionIds
        ?? groupingOverride?.find(source => source.key === activeDrag.accountKey)?.sessionIds
    if (accountSessionIds === undefined) return
    const renderedSessions = collapsedSessionRows(group.sessions, sessionLimits[group.key]).rows
    const nextOrder = sessionDragOrder(accountSessionIds, renderedSessions, activeDrag, over)
    if (nextOrder !== undefined) setSessionOrder(activeDrag.accountKey, nextOrder)
  }
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
  const commitCrossGroupDrag = (
    activeDrag: DragState,
    targetKey: string,
    over: NonNullable<DragState['over']> | null,
  ): void => {
    const target = groups.find(candidate => candidate.key === targetKey)
    if (target === undefined) return
    const moving = activeDrag.sessionId
    // A caller-supplied group's order lives in the caller's store; the Ungrouped
    // bucket's lives in the view store. `saveSessionOrder` dispatches on that.
    const targetOrder = collapsedSessionRows(target.sessions, sessionLimits[targetKey]).rows.map(row => row.id)
    const positional = over !== null

    // The Session must leave its old group and join the new one. Ungrouped is the
    // absence of an assignment rather than a project, so it takes the other verb.
    const move = targetKey === UNGROUPED_KEY
      ? unassignSession?.(moving)
      : assignSession?.(moving, targetKey)
    if (move === undefined) return
    void move.catch((reason: unknown) => { console.warn('session move rejected:', reason) })

    // Recency plus a header drop stores nothing: position comes from `updatedAt`.
    if (!positional && orderBy === 'updated') {
      recordExpansion(targetKey, true)
      return
    }
    const next = positional
      ? insertIntoTargetOrder(targetOrder, moving, over.id, over.half)
      : [moving, ...targetOrder.filter(id => id !== moving)]
    // A positional drop is a sort gesture, so it selects manual ordering; a
    // header drop under manual already is manual. `setSessionOrder` writes the
    // whole project map, which freezes every project in the same step.
    setSessionOrder(targetKey, next)
    recordExpansion(targetKey, true)
  }
  const commitWorkspaceDrag = (
    activeDrag: WorkspaceDragState,
    over: NonNullable<WorkspaceDragState['over']>,
  ): void => {
    if (workspaceDropCommitted.current) return
    workspaceDropCommitted.current = true
    setWorkspaceDrag(null)
    if (activeDrag.kind === 'project') {
      // Project order is the caller's list, not a Workspace tree: every project is a
      // sibling, and the anchor resolves the same way the Workspace branch below
      // resolves it — `'after'` names the **next** row, not "no anchor".
      //
      // Passing `undefined` for `'after'` read as "append to the end" to the Host
      // (`reorder`: `beforeId === undefined ? rest.length : …`), so a marker drawn
      // under one project landed the row at the bottom of the list whenever the
      // hovered row was not already last. Resolving the next sibling, as the
      // Workspace branch does for its own rows, keeps the landed position equal to
      // the marker in every case; a drop under the final row really does append.
      const projectIds = groupingOverride?.map(source => source.key) ?? []
      const rowIndex = projectIds.indexOf(over.id)
      if (rowIndex === -1) return
      // Commit the side the marker showed, not a side recomputed from the release point.
      // `dropWorkspace` measures the side again from the drop event's coordinates, which is the
      // shipped behaviour for Workspace rows (kept below, unchanged); but `drop` fires at release,
      // so a few pixels of movement after the last `dragover` flip the mid-point test and the row
      // lands on the side the user never saw marked. `activeDrag.over` **is** that last hovered
      // marker, so when it names this same row it is the side to honour.
      const half = activeDrag.over?.id === over.id ? activeDrag.over.half : over.half
      const anchor = half === 'before' ? over.id : projectIds[rowIndex + 1]
      // A drop whose anchor is the moving row is not a move. It also cannot be sent:
      // the Host filters the moving id out before looking the anchor up, so it would
      // reject it as an unknown project.
      if (anchor === activeDrag.rowId) return
      const commit = reorderProject === undefined
        ? Promise.reject(new Error('no project model'))
        : reorderProject(activeDrag.rowId, anchor)
      commit.catch((reason: unknown) => { console.warn('project reorder rejected:', reason) })
      return
    }
    const workspaceId = activeDrag.rowId as WorkspaceId
    const owner = parents.get(workspaceId)
    const siblings = workspaces.filter(workspace => parents.get(workspace.workspaceId) === owner)
    const rowIndex = siblings.findIndex(workspace => workspace.workspaceId === over.id)
    if (rowIndex === -1) return
    const anchor: WorkspaceId | undefined = over.half === 'before'
      ? over.id as WorkspaceId
      : siblings[rowIndex + 1]?.workspaceId
    if (anchor === workspaceId) return
    const sourceIndex = siblings.findIndex(workspace => workspace.workspaceId === workspaceId)
    const anchorIndex = anchor === undefined
      ? siblings.length
      : siblings.findIndex(workspace => workspace.workspaceId === anchor)
    if (sourceIndex !== -1 && (anchorIndex === sourceIndex || anchorIndex === sourceIndex + 1)) return
    insertWorkspaceBefore(workspaceId, anchor).catch((reason: unknown) => {
      console.warn('workspace reorder rejected:', reason)
    })
  }
  const childrenByParent = useMemo(() => {
    const rendered = new Set(groups.map(group => group.key))
    const children = new Map<string | undefined, GroupNode[]>()
    for (const group of groups) {
      // The archived-only view drops empty groups, so an ancestor may be
      // absent; nest under the nearest rendered one.
      let parent = parents.get(group.key)
      while (parent !== undefined && !rendered.has(parent)) parent = parents.get(parent)
      const siblings = children.get(parent)
      if (siblings === undefined) children.set(parent, [group])
      else siblings.push(group)
    }
    return children
  }, [groups, parents])
  const rootGroups = childrenByParent.get(undefined) ?? []
  const workspaceDropAtListStart = rootGroups[0]?.workspaceId !== undefined
    && workspaceDrag?.over?.id === rootGroups[0].workspaceId
    && workspaceDrag.over.half === 'before'

  const rowKeys: string[] = groups.length === 0 ? ['empty'] : []
  const renderGroup = (group: GroupNode, depth: number): ReactNode => {
    const workspaceId = group.workspaceId
    const children = childrenByParent.get(group.key) ?? []
    // Which verb this row's drag drives. A project is never a Workspace row and
    // the Ungrouped bucket is neither, so the two join only where both are
    // draggable entities: a project drags among projects, a Workspace among
    // its siblings.
    const dragKind: 'workspace' | 'project' | undefined = group.kind === 'project'
      ? 'project'
      : workspaceId === undefined ? undefined : 'workspace'
    const dragRowId = group.kind === 'project' ? group.key : workspaceId
    const compatibleDrag = workspaceDrag !== null && dragKind !== undefined
      && workspaceDrag.kind === dragKind
      && (dragKind === 'project' || parents.get(workspaceDrag.rowId as WorkspaceId) === parents.get(group.key))
    const collapsed = collapsedSessionRows(group.sessions)
    const visible = collapsedSessionRows(group.sessions, sessionLimits[group.key])
    const sessionsExpanded = visible.hiddenCount === 0
    rowKeys.push(`workspace:${group.key}`)
    const childRows = group.expanded ? children.map(child => renderGroup(child, depth + 1)) : []
    const sessions = visible.rows
    // Invariant: these keys must match the `data-row-key` the rows below render,
    // in the same order — `AnimatedRows` pairs the two by position. Both sides call
    // `sessionRowKey` for that reason; writing the string out here instead would let
    // them drift, and a drift shows up as wrong motion rather than as an error.
    for (const node of sessions) rowKeys.push(sessionRowKey(node.id))
    if (collapsed.hiddenCount > 0) rowKeys.push(`overflow:${group.key}`)
    const activeDrag = workspaceDrag
    const markerOver = dragRowId !== undefined && activeDrag !== null
      && activeDrag.kind === dragKind && activeDrag.over?.id === dragRowId
      ? activeDrag.over
      : null
    const workspaceMarker = markerOver === null ? null : markerOver.half
    const workspaceDragProps = dragKind === undefined || dragRowId === undefined ? undefined : {
      start: () => {
        workspaceDropCommitted.current = false
        setWorkspaceDrag({ kind: dragKind, rowId: dragRowId, over: null })
      },
      end: () => {
        const active = workspaceDragRef.current
        if (active?.over !== null && active?.over !== undefined) {
          commitWorkspaceDrag(active, active.over)
        } else {
          setWorkspaceDrag(null)
        }
        workspaceDropCommitted.current = false
      },
    }
    const hoverWorkspace = dragRowId === undefined || !compatibleDrag
      ? undefined
      : (half: 'before' | 'after') => {
        setWorkspaceDrag(active => active === null
          ? active
          : { ...active, over: { id: dragRowId, half } })
      }
    const dropWorkspace = dragRowId === undefined || !compatibleDrag
      ? undefined
      : (half: 'before' | 'after') => {
        const active = workspaceDragRef.current
        if (active === null) return
        commitWorkspaceDrag(active, { id: dragRowId, half })
      }
    // A Session dragged out of another group can be dropped on this group's
    // **header row** — a drop *into* the group, as opposed to the positional drop
    // a Session row gives.
    //
    // Hit testing is the row, not this section: the section also spans the 2px
    // gaps between rows and the empty space beside them, and accepting a drop
    // there would let a Session land from a pointer nowhere near a drop position.
    // `drag.over === null` is what distinguishes this from the row target below,
    // since a positional drop always names a row.
    //
    // The highlight, though, is painted on the section (`groupDropActive` below):
    // the row is what can be dropped on, the group is what the drop means.
    //
    // The two drags are mutually exclusive, so `workspaceDrag === null` plus a
    // live session drag is enough to tell them apart, and the shipped workspace
    // handlers below are reached unchanged whenever a row drag is in flight.
    const groupDropTarget = drag !== null && drag.accountKey !== group.key
      && canReceiveDrag(group.key)
    const groupDropActive = groupDropTarget
      && drag.overGroupKey === group.key && drag.over === null
    const groupDrop = groupDropTarget ? {
      // Idempotent: `dragover` fires continuously while the pointer is over the
      // row, so returning the same state when it already holds keeps those events
      // from re-rendering the tree.
      enter: () => {
        setDrag(d => (d === null || (d.overGroupKey === group.key && d.over === null)
          ? d
          : { ...d, over: null, overGroupKey: group.key }))
      },
      // The pointer left the header. Without this the highlight would stick until
      // some other target claimed the drag, which is what makes a gap between rows
      // flash the whole group.
      //
      // Only cleared while this header is still the target: a `dragleave` can
      // arrive after the next target has already claimed the drag, and clearing
      // then would drop a marker that is now correct.
      leave: () => {
        setDrag(d => (d === null || d.overGroupKey !== group.key
          ? d
          : { ...d, overGroupKey: undefined }))
      },
      drop: () => {
        const active = dragRef.current
        if (active !== null) commitSessionDrag(active, null, group.key)
      },
    } : undefined
    return (
    // Group section: header, descendant Workspaces, and own Session rows. The
    // inter-group breathing room is the section's own margin
    // (WorkspaceBrowser.module.css).
      <div
        key={group.key}
        style={{ '--dsh-workspace-indent': `${depth * 12}px` } as CSSProperties}
        className={clsx(
          css.groupSection,
          workspaceMarker === 'before' && css.workspaceDropBefore,
          workspaceMarker === 'after' && css.workspaceDropAfter,
          groupDropActive && css.groupDropTarget,
        )}
        onDragOver={workspaceDrag === null
          ? undefined
          : (e) => {
            e.preventDefault()
            if (hoverWorkspace === undefined && parents.get(group.key) !== undefined) return
            e.stopPropagation()
            if (hoverWorkspace === undefined) {
              e.dataTransfer.dropEffect = 'none'
              if (workspaceDrag.over !== null) setWorkspaceDrag({ ...workspaceDrag, over: null })
            } else {
              e.dataTransfer.dropEffect = 'move'
              hoverWorkspace(workspaceGroupHalf(e))
            }
          }}
        onDrop={workspaceDrag === null
          ? undefined
          : (e) => {
            e.preventDefault()
            if (dropWorkspace === undefined && parents.get(group.key) !== undefined) return
            e.stopPropagation()
            if (dropWorkspace === undefined) {
              workspaceDropCommitted.current = true
              setWorkspaceDrag(null)
            } else {
              dropWorkspace(workspaceGroupHalf(e))
            }
          }}
      >
        <ProjectRowItem
          newShortcut={shortcuts.find(row => row.id === 'session.new')}
          group={group}
          containsCurrentDescendant={currentAncestors.has(group.key)}
          home={home}
          t={t}
          onToggle={() => {
            if (group.expanded) {
              setSessionLimits(limits => ({ ...limits, [group.key]: COLLAPSED_SESSION_LIMIT }))
            }
            recordExpansion(group.key, !group.expanded)
          }}
          onCreate={() => {
            // Expand even when no Session ends up created: a collapsed group
            // would swallow the new row and read as "the click did nothing".
            recordExpansion(group.key, true)
            // How this row files the Session it creates. A project row files it
            // under itself and the Ungrouped bucket files it under nothing; both
            // state a destination, which is what separates them from the unscoped
            // entries — the shell's New Session button and its shortcut — where
            // nothing states one and the caller's policy decides.
            //
            // The Ungrouped case must be stated rather than left as "no callback".
            // Sending none made the click indistinguishable from an unscoped one:
            // it resolved the default Workspace, reused the blank Session already
            // there, and inherited whatever project that Session was filed under,
            // so clicking ＋ under Ungrouped created nothing under Ungrouped.
            //
            // A real Workspace row files nothing — it predates projects — and
            // keeping that branch explicit is what stops such a row from being
            // unassigned if this browser is ever composed without an override.
            //
            // The filing rides `beforeOpen`, which the navigation runs once the
            // Session exists and before it becomes the main view. A rejection is
            // logged rather than surfaced: the Session was created and opened, so
            // a filing failure must not read as a failed New Session. It is also
            // best-effort by design — a navigation superseded mid-flight never
            // opens its Session, and an unfiled Session is the right outcome for
            // an abandoned click.
            const isProject = group.kind === 'project'
            const isUngrouped = group.key === UNGROUPED_KEY
            const file = isProject && assignSession !== undefined
              ? (sessionId: SessionId) => assignSession(sessionId, group.key)
              : isUngrouped && unassignSession !== undefined
                ? (sessionId: SessionId) => unassignSession(sessionId)
                : undefined
            startSession(
              group.workspaceId,
              file === undefined
                ? undefined
                : (sessionId) => {
                  void file(sessionId).catch((reason: unknown) => {
                    console.warn('file session rejected:', reason)
                  })
                },
            )
          }}
          drag={workspaceDragProps}
          groupDrop={groupDrop}
          actions={group.kind === 'project'
            ? {
              rename: () => {
                onRenameRequest({
                  kind: 'project',
                  id: group.key,
                  title: group.label,
                  // Resolved from the override by key rather than carried on the
                  // node: the derived tree is presentation, and a directory list
                  // is not something it renders. `?? []` because a consumer
                  // grouping by something else supplies none.
                  directories: groupingOverride?.find(source => source.key === group.key)?.directories ?? [],
                  // Same lookup, same reason as the directories above.
                  links: groupingOverride?.find(source => source.key === group.key)?.links ?? [],
                  // Same lookup, same reason: the spec override is data, not
                  // presentation, so it stays on the source rather than the node.
                  ...(() => {
                    const stored = groupingOverride?.find(source => source.key === group.key)?.docSpec
                    return stored === undefined ? {} : { docSpec: stored }
                  })(),
                })
              },
              delete: () => { onDeleteRequest({ kind: 'project', id: group.key, title: group.label }) },
            }
            : group.workspaceId === undefined
              ? undefined
              : {
                rename: () => {
                  /* v8 ignore next -- narrowing guard: the actions object exists only for real-workspace groups. */
                  if (group.workspaceId !== undefined) {
                    onRenameRequest({ kind: 'workspace', id: group.workspaceId, title: group.label })
                  }
                },
                delete: () => {
                  /* v8 ignore next -- narrowing guard: the actions object exists only for real-workspace groups. */
                  if (group.workspaceId !== undefined) {
                    onDeleteRequest({ kind: 'workspace', id: group.workspaceId, title: group.label })
                  }
                },
              }}
        />
        {childRows.length > 0 && (
          <div role="group">
            {childRows}
          </div>
        )}
        {sessions.map((node) => {
        // A row reorders within its own browser-local account, and also accepts a
        // Session dragged out of another group. Pinned rows stay in their leading
        // block either way, so both paths require a matching pinned state.
          const sameGroupDrag = drag !== null && drag.accountKey === group.key
          const crossGroupDrag = drag !== null && drag.accountKey !== group.key
            && canReceiveDrag(group.key)
          const compatibleTarget = (sameGroupDrag || crossGroupDrag) && drag.pinned === node.pinned
          const normalizeHalf = (half: 'before' | 'after'): 'before' | 'after' =>
            node.blank ? 'after' : half
          const dragProps = {
            start: () => {
              sessionDropCommitted.current = false
              setDrag({ accountKey: group.key, sessionId: node.id, pinned: node.pinned, over: null })
            },
            active: compatibleTarget,
            marker: compatibleTarget && drag.over?.id === node.id ? drag.over.half : null,
            hover: (half: 'before' | 'after') => {
            /* v8 ignore next -- narrowing guard: Rows gates hover on `active`, which is false while the drag state is null. */
              setDrag(d => (d === null ? d : {
                ...d,
                over: { id: node.id, half: normalizeHalf(half) },
                // Hovering a row in the source group clears any group-level target
                // a previous header hover left behind.
                overGroupKey: group.key === d.accountKey ? undefined : group.key,
              }))
            },
            drop: (half: 'before' | 'after') => {
            /* v8 ignore next -- narrowing guard: Rows gates drop on `active`, which is false while the drag state is null. */
              if (drag === null) return
              commitSessionDrag(drag, { id: node.id, half: normalizeHalf(half) }, group.key)
            },
            end: () => {
              // Fallback for a release that produced no `drop` event; the
              // commit guard makes a double commit a no-op.
              if (drag === null) setDrag(null)
              else if (drag.over !== null && drag.over !== undefined) {
                commitSessionDrag(drag, drag.over, drag.overGroupKey ?? drag.accountKey)
              } else if (drag.overGroupKey !== undefined) {
                commitSessionDrag(drag, null, drag.overGroupKey)
              } else setDrag(null)
              sessionDropCommitted.current = false
            },
          }
          return (
            <SessionNodeItem
              key={node.id}
              node={node}
              // Must equal the matching entry `rowKeys` pushed above; see the note
              // there. `key` stays the bare id so React re-parents the row rather
              // than remounting it when the Session changes group.
              rowKey={sessionRowKey(node.id)}
              currentId={current}
              now={now}
              onOpen={open}
              onRenameRequest={onSessionRenameRequest}
              renderSlot={renderSlot}
              onReveal={node.id === revealSessionId && group.key === revealGroup
                ? () => { onSessionRevealed(node.id) }
                : undefined}
              drag={dragProps}
              t={t}
            />
          )
        })}
        {collapsed.hiddenCount > 0 && (
          <button
            type="button"
            className={css.sessionOverflowButton}
            data-row-key={`overflow:${group.key}`}
            aria-expanded={sessionsExpanded}
            onClick={() => {
              setSessionLimits(limits => ({
                ...limits,
                [group.key]: sessionsExpanded
                  ? COLLAPSED_SESSION_LIMIT
                  : visible.hiddenCount <= COLLAPSED_SESSION_LIMIT
                    ? Infinity
                    : (limits[group.key] ?? COLLAPSED_SESSION_LIMIT) + COLLAPSED_SESSION_LIMIT,
              }))
            }}
          >
            {sessionsExpanded
              ? t('sessions.collapse')
              : t('sessions.expand', { n: visible.hiddenCount })}
          </button>
        )}
      </div>
    )
  }

  const groupRows = rootGroups.map(group => renderGroup(group, 0))
  return (
    <div className={clsx(css.treeBody, css.wide)}>
      {workspaceDropAtListStart && <span className={css.listTopDropIndicator} aria-hidden="true" />}
      <AnimatedRows
        className={clsx(css.list, workspaceDropAtListStart && css.listTopDropActive)}
        label={t('section.sessions')}
        rowKeys={rowKeys}
        ready={list.phase === 'ready' && workspaceReady && !nativeDragActive}
        resetKey={JSON.stringify([animationResetKey, sessionLimits])}
        enteringKeys={enteringKeys}
        onEnteringKeysDrawn={onEnteringKeysDrawn}
      >
        {groups.length === 0 && (
          <EmptySessions rowState={rowState} onLeaveArchivedOnly={onLeaveArchivedOnly} t={t} />
        )}
        {groupRows}
      </AnimatedRows>
      <span className={css.fade} />
    </div>
  )
}

/** The flat "In one list" body: every session is one draggable top-level row. */
function FlatList({
  list, sessionIds, rowState, onLeaveArchivedOnly, useSessionStatus, open, onSessionRenameRequest,
  usePanelInfo, setSessionOrder, workspaceReady, animationResetKey,
  revealSessionId, onSessionRevealed, renderSlot, t, enteringKeys, onEnteringKeysDrawn,
}: Pick<
  SessionTreeProps,
  | 'useSessionStatus'
  | 'open'
  | 'onSessionRenameRequest'
  | 'renderSlot'
  | 'usePanelInfo'
  | 'setSessionOrder'
  | 'workspaceReady'
  | 'animationResetKey'
  | 'revealSessionId'
  | 'onSessionRevealed'
  | 'rowState'
  | 'onLeaveArchivedOnly'
  | 't'
  | 'enteringKeys'
  | 'onEnteringKeysDrawn'
> & {
  list: SessionListState
  sessionIds: readonly SessionId[]
}) {
  const panelActive = usePanelInfo(info => info.activePanelId !== null)
  const statuses = useSessionStatus(s => s)
  const rows = useMemo(
    () => deriveFlat(list, sessionIds, rowState, statuses),
    [list, sessionIds, rowState, statuses],
  )
  const [drag, setDrag] = useState<DragState | null>(null)
  const dropCommitted = useRef(false)
  useNativeDragAcceptance(drag !== null)
  const currentId = panelActive
    ? undefined
    : Object.values(list.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
  const commitDrag = (activeDrag: DragState, over: NonNullable<DragState['over']>): void => {
    if (dropCommitted.current) return
    dropCommitted.current = true
    setDrag(null)
    const nextOrder = sessionDragOrder(sessionIds, rows, activeDrag, over)
    if (nextOrder !== undefined) setSessionOrder(FLAT_SESSION_ORDER_KEY, nextOrder)
  }
  const now = Date.now()
  return (
    <div className={clsx(css.treeBody, css.wide)}>
      <AnimatedRows
        className={clsx(css.list, css.flatList)}
        label={t('section.sessions')}
        rowKeys={rows.length === 0 ? ['empty'] : rows.map(row => `session:${row.id}`)}
        ready={list.phase === 'ready' && workspaceReady && drag === null}
        resetKey={animationResetKey}
        enteringKeys={enteringKeys}
        onEnteringKeysDrawn={onEnteringKeysDrawn}
      >
        {rows.length === 0 && (
          <EmptySessions rowState={rowState} onLeaveArchivedOnly={onLeaveArchivedOnly} t={t} />
        )}
        {rows.map((node) => {
          const active = drag !== null && drag.pinned === node.pinned
          const normalizeHalf = (half: 'before' | 'after'): 'before' | 'after' =>
            node.blank ? 'after' : half
          return (
            <SessionNodeItem
              key={node.id}
              node={node}
              currentId={currentId}
              now={now}
              onOpen={open}
              onRenameRequest={onSessionRenameRequest}
              renderSlot={renderSlot}
              onReveal={node.id === revealSessionId
                ? () => { onSessionRevealed(node.id) }
                : undefined}
              drag={{
                start: () => {
                  dropCommitted.current = false
                  setDrag({ accountKey: FLAT_SESSION_ORDER_KEY, sessionId: node.id, pinned: node.pinned, over: null })
                },
                active,
                marker: active && drag.over?.id === node.id ? drag.over.half : null,
                hover: (half) => {
                  setDrag(current => current === null ? current : {
                    ...current, over: { id: node.id, half: normalizeHalf(half) },
                  })
                },
                drop: (half) => {
                  if (drag !== null) commitDrag(drag, { id: node.id, half: normalizeHalf(half) })
                },
                end: () => {
                  if (drag?.over !== null && drag?.over !== undefined) commitDrag(drag, drag.over)
                  else setDrag(null)
                  dropCommitted.current = false
                },
              }}
              t={t}
            />
          )
        })}
      </AnimatedRows>
      <span className={css.fade} />
    </div>
  )
}

interface RemoteSearchState {
  query: string
  status: 'idle' | 'loading' | 'ready' | 'error'
  items: readonly SessionSearchResultItem[]
  hasMore: boolean
}

/** Flat search body: local metadata matches plus the current Host result page. */
function SearchResults({
  useSessions,
  useSessionStatus,
  open,
  onUnarchive,
  workspaces,
  groupingOverride,
  archivedSessionIds,
  archivedFilter,
  query,
  remote,
  resultLimit,
  usePanelInfo,
  t,
}: Pick<WorkspaceBrowserProps, 'useSessions' | 'useSessionStatus' | 'open' | 't' | 'usePanelInfo'> & {
  workspaces: readonly WorkspaceView[]
  /** Caller-supplied groups, so a result row names the project its Session is filed under. */
  groupingOverride: readonly GroupSource[] | undefined
  archivedSessionIds: readonly SessionNode['id'][]
  /** Search matches follow the archived filter selected for the list. */
  archivedFilter: ArchivedFilter
  /** Unarchive an archived result row in place. */
  onUnarchive: (id: SessionNode['id']) => void
  query: string
  remote: RemoteSearchState
  resultLimit: number
}) {
  const panelActive = usePanelInfo(info => info.activePanelId !== null)
  const list = useSessions(s => s)
  const statuses = useSessionStatus(s => s)
  const currentRemote = remote.query === query
    ? remote
    : { query, status: 'loading' as const, items: [], hasMore: false }
  const results = useMemo(
    () => deriveSearchResults(
      list,
      workspaces,
      query,
      archivedSessionIds,
      archivedFilter,
      statuses,
      currentRemote,
      resultLimit,
      groupingOverride,
    ),
    [list, workspaces, query, archivedSessionIds, archivedFilter, statuses, currentRemote, resultLimit,
      groupingOverride],
  )
  const pending = currentRemote.status === 'loading'
  const currentId = panelActive
    ? undefined
    : Object.values(list.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id

  return (
    <div className={clsx(css.treeBody, css.wide)}>
      <div className={css.list}>
        <div className={css.searchTree} role="tree" aria-label={t('search.results.aria')}>
          {results.items.map(result => (
            <SearchResultItem
              key={result.id}
              result={result}
              currentId={currentId}
              onOpen={open}
              onUnarchive={onUnarchive}
              t={t}
            />
          ))}
        </div>
        {pending && (
          /* Two skeleton rows on an empty list, one when local matches already
             show and only the content hits are outstanding. */
          <div role="status" aria-label={t('search.pending')}>
            {(results.items.length === 0 ? [0, 1] : [0]).map(i => (
              <div key={i} className={css.skeletonRow} aria-hidden="true">
                <span className={css.skeletonDot} />
                <span className={css.skeletonBars}>
                  <span className={css.skeletonBar} />
                  <span className={clsx(css.skeletonBar, css.skeletonBarWide)} />
                </span>
              </div>
            ))}
          </div>
        )}
        {!pending && results.items.length === 0 && (
          <div className={css.empty}>{t('search.noMatches')}</div>
        )}
        {results.hasMore && (
          <div className={css.searchStatus}>
            {t('search.hasMore', { n: resultLimit })}
          </div>
        )}
      </div>
      <span className={css.fade} />
    </div>
  )
}

/**
 * Render the browsing region.
 * @param props - composed slot props (shell owner share + store + injected actions).
 * @returns the region element tree.
 */
export function WorkspaceBrowser({
  wide,
  usePanelInfo,
  expandSidebar,
  useSessions,
  useSessionStatus,
  useWorkspaces,
  useGrouping,
  useStore,
  actions,
  startSession,
  open,
  requestSessionRename,
  notifyArchivedNotOpenable,
  renameWorkspace,
  deleteWorkspace,
  insertWorkspaceBefore,
  unarchiveSession,
  createWorkspace,
  searchSessions,
  searchResultLimit,
  useDirectoryFlow,
  useHostInfo,
  useShortcuts,
  useWorkspaceShortcuts,
  requestSearch,
  requestAddWorkspace,
  closeAddWorkspace,
  setDirectoryBusy,
  dismissForkError,
  createProject,
  updateProject,
  pickDirectory,
  deleteProject,
  reorderProject,
  assignSession,
  unassignSession,
  setProjectExpanded,
  setProjectOrders,
  useExpansions,
  useOrders,
  useNewSessionLanded,
  useCreateOpensSession,
  usePerProjectDocSpec,
  useInjectProjectInfo,
  useInjectProjectDoc,
  useSpecs,
  useValidateLinks,
  renderSlot,
  t,
}: WorkspaceBrowserProps) {
  const home = useHostInfo(info => info.home)
  const shortcuts = useShortcuts(rows => rows)
  const searchShortcut = shortcuts.find(row => row.id === 'session.search')
  const addShortcut = shortcuts.find(row => row.id === 'workspace.add')
  // Whether this composition supplies a project model. Derived here, not beside
  // the dialog, because the header's add control and the add-request effect both
  // read it and both run above the dialog's state block.
  const projectModelAvailable = createProject !== undefined
  const shortcutState = useWorkspaceShortcuts(state => state)
  // Ordering remains live while the rail or search replaces the list body.
  const list = useSessions(state => state)
  const storedWorkspaces = useWorkspaces(state => state.items)
  // Grouping override: `undefined` keeps the Host Workspace registry as the
  // grouping model (the whole point of the default). The Workspace rows, the
  // picker, drag targets and the phase/archive reads below all stay official
  // either way — only the group headings change.
  const groupingOverride = useGrouping(groups => groups)
  // Expansion the caller owns, keyed by their own group keys. A composition with
  // no such state supplies an observable answering an empty record, and with no
  // `setProjectExpanded` verb every key resolves to this browser's view store.
  const projectExpansion = useExpansions(expansion => expansion)
  // Manual order the caller owns, keyed by their own group keys. Same shape as
  // the expansion seat: a composition without it supplies an empty record, and
  // with no `setProjectOrders` verb every key resolves to the view store.
  const projectOrders = useOrders(orders => orders)
  // Whether the caller wants creating a project to open a Session, the way the
  // official add-workspace flow does. A composition without the state supplies an
  // observable answering `true`, which is that official behaviour.
  const openSessionOnCreate = useCreateOpensSession(value => value)
  // The document-spec facts, read only by the project dialogs' spec row. A
  // composition without a document model supplies observables answering the
  // schema defaults, and the row is hidden by the switch below.
  const perProjectDocSpec = usePerProjectDocSpec(value => value)
  const injectProjectInfo = useInjectProjectInfo(value => value)
  const injectProjectDoc = useInjectProjectDoc(value => value)
  /**
   * Whether the project dialogs may show the per-project spec row.
   *
   * The SAME three-way chain the settings card uses: the row is meaningless
   * unless a document line is injected, and the document line is itself gated on
   * the master project-info line. Gating on the switch alone offered a spec
   * setting while the settings page showed the whole group as unavailable — the
   * user could set a spec for a project whose document is never described.
   */
  const showDocSpecRow = perProjectDocSpec && injectProjectDoc && injectProjectInfo
  const specs = useSpecs(value => value)
  // Whether the dialogs mark links that are not `http(s)://` URLs. Independent of the
  // three document gates above: registering a link has nothing to do with whether the
  // project's context is injected, so this switch is read on its own.
  const validateLinks = useValidateLinks(value => value)
  // The resolved name, not `t`, is the memo dependency: the bound seat keeps
  // its identity across a language switch.
  const defaultWorkspaceName = t('workspace.defaultName')
  const workspaces = useMemo(
    () => storedWorkspaces.map(workspace => ({
      ...workspace,
      title: workspaceDisplayTitle(workspace.title, defaultWorkspaceName),
    })),
    [storedWorkspaces, defaultWorkspaceName],
  )
  const workspacePhase = useWorkspaces(state => state.phase)
  const workspaceStreamState = useWorkspaces(state => state.state)
  const archivedSessionIds = useWorkspaces(state => state.archivedSessionIds)
  const pinnedSessionIds = useWorkspaces(state => state.pinnedSessionIds)
  // Live occupancy of this surface's directory-flow hole (the same source the
  // flow reads): a composition without a picking affordance can add nothing.
  const directoryFlowAvailable = useDirectoryFlow(occupied => occupied)
  const groupBy = useStore(s => s.groupBy)
  const orderBy = useStore(s => s.orderBy)
  // Persisted view blobs written before the archived filter existed rehydrate
  // without the field; they read as the default hide-archived view.
  const archivedFilter = useStore(s => s.archivedFilter ?? 'default')
  const groupExpansion = useStore(s => s.groupExpansion)
  const sessionOrderByAccount = useStore(s => s.sessionOrderByAccount)
  // Archived sessions are not openable: the row stays visible under the
  // filter but a click explains instead of navigating.
  const guardedOpen = (sessionId: SessionId): void => {
    if (archivedSessionIds.includes(sessionId)) {
      notifyArchivedNotOpenable()
      return
    }
    open(sessionId)
  }
  const leaveArchivedOnly = (): void => { actions.setArchivedFilter('default') }
  const workspaceReady = workspacePhase === 'ready' && workspaceStreamState !== 'loading'
  const mainSessionId = Object.values(list.byId)
    .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
  const currentBlank = mainSessionId !== undefined && list.byId[mainSessionId]?.blank === true
    ? mainSessionId
    : undefined
  const ungroupedMemberIds = useMemo(() => {
    // Under an override, "ungrouped" means unclaimed by the override rather
    // than unaccounted by a Workspace; the two differ as soon as the caller
    // groups Sessions the Workspace registry already accounts for.
    const claimed = groupingOverride === undefined
      ? new Set(workspaces.flatMap(workspace => workspace.sessionIds))
      : new Set(groupingOverride.flatMap(group => group.sessionIds))
    return list.ids.filter(id => list.byId[id] !== undefined && !claimed.has(id))
  }, [list, workspaces, groupingOverride])
  const orderState = useMemo(
    () => ({ pinnedSessionIds, archivedSessionIds }),
    [archivedSessionIds, pinnedSessionIds],
  )
  const rowState = useMemo<SessionRowState>(
    () => ({ ...orderState, archivedFilter }),
    [orderState, archivedFilter],
  )
  const flatMemberIds = useMemo(() => sessionMemberIds(list), [list])
  const orderedWorkspaces = useMemo(() => workspaces.map((workspace) => {
    const memberIds = workspace.sessionIds
    const baseOrder = orderBy === 'updated'
      ? orderByRecency(memberIds, list.byId)
      : reconcileManualOrder(memberIds, sessionOrderByAccount[workspace.workspaceId], list.byId, orderState)
    return {
      ...workspace,
      sessionIds: pinCurrentBlank(
        baseOrder,
        currentBlank !== undefined && memberIds.includes(currentBlank) ? currentBlank : undefined,
      ),
    }
  }), [currentBlank, list.byId, orderBy, orderState, sessionOrderByAccount, workspaces])
  // Caller-supplied groups get the same two-mode ordering the Workspace rows get,
  // from the caller's own order record rather than the shared view store — the
  // official plugin prunes that store's non-Workspace keys on mount.
  //
  // A group with no recorded order falls to `reconcileManualOrder`'s recency
  // fallback, which is exactly what recency ordering wants and why recency mode
  // stores nothing.
  const orderedProjects = useMemo(() => groupingOverride === undefined
    ? undefined
    : groupingOverride.map((source) => {
      const memberIds = source.sessionIds
      const baseOrder = orderBy === 'updated'
        ? orderByRecency(memberIds, list.byId)
        : reconcileManualOrder(memberIds, projectOrders[source.key], list.byId, orderState)
      return {
        ...source,
        sessionIds: pinCurrentBlank(
          baseOrder,
          currentBlank !== undefined && memberIds.includes(currentBlank) ? currentBlank : undefined,
        ),
      }
    }), [currentBlank, list.byId, orderBy, orderState, projectOrders, groupingOverride])
  // Every project's currently rendered order. A drop writes this whole map with
  // the target project replaced: in recency mode that freezes every project at
  // once, which is what switching to manual has to do for the mode to mean
  // anything (`reconcileManualOrder` falls back to recency without a record).
  const allProjectOrders = useCallback(
    (): Record<string, readonly SessionId[]> => Object.fromEntries(
      (orderedProjects ?? []).map(source => [source.key, [...source.sessionIds]]),
    ),
    [orderedProjects],
  )
  const orderedUngroupedSessionIds = useMemo(() => {
    const baseOrder = orderBy === 'updated'
      ? orderByRecency(ungroupedMemberIds, list.byId)
      : reconcileManualOrder(ungroupedMemberIds, sessionOrderByAccount[UNGROUPED_KEY], list.byId, orderState)
    return pinCurrentBlank(
      baseOrder,
      currentBlank !== undefined && ungroupedMemberIds.includes(currentBlank) ? currentBlank : undefined,
    )
  }, [currentBlank, list.byId, orderBy, orderState, sessionOrderByAccount, ungroupedMemberIds])
  const orderedFlatSessionIds = useMemo(() => {
    const baseOrder = orderBy === 'updated'
      ? orderByRecency(flatMemberIds, list.byId)
      : reconcileManualOrder(flatMemberIds, sessionOrderByAccount[FLAT_SESSION_ORDER_KEY], list.byId, orderState)
    return pinCurrentBlank(
      baseOrder,
      currentBlank !== undefined && flatMemberIds.includes(currentBlank) ? currentBlank : undefined,
    )
  }, [currentBlank, flatMemberIds, list.byId, orderBy, orderState, sessionOrderByAccount])
  const activeSessionOrders = useMemo<Readonly<Record<string, readonly SessionId[]>>>(() => Object.fromEntries([
    ...orderedWorkspaces.map(workspace => [workspace.workspaceId, workspace.sessionIds] as const),
    [UNGROUPED_KEY, orderedUngroupedSessionIds] as const,
    [FLAT_SESSION_ORDER_KEY, orderedFlatSessionIds] as const,
  ]), [orderedFlatSessionIds, orderedUngroupedSessionIds, orderedWorkspaces])
  useEffect(() => {
    if (workspacePhase !== 'ready') return
    actions.retainAccountKeys([
      UNGROUPED_KEY,
      FLAT_SESSION_ORDER_KEY,
      ...workspaces.map(workspace => workspace.workspaceId),
    ])
  }, [actions.retainAccountKeys, workspacePhase, workspaces])
  useEffect(() => {
    if (list.phase !== 'ready' || workspaceReady || orderBy !== 'manual' || currentBlank === undefined) return
    // A first prompt can end blank pinning before the Workspace baseline arrives.
    // Preserve saved members until that baseline can establish departures.
    const changed: Record<string, readonly string[]> = {}
    for (const [key, ids] of Object.entries(activeSessionOrders)) {
      if (key !== FLAT_SESSION_ORDER_KEY && workspacePhase !== 'ready') continue
      const saved = sessionOrderByAccount[key] ?? []
      if (ids[0] !== currentBlank || saved[0] === currentBlank) continue
      changed[key] = [currentBlank, ...saved.filter(id => id !== currentBlank)]
    }
    if (Object.keys(changed).length > 0) actions.syncSessionOrders(changed)
  }, [
    actions.syncSessionOrders,
    activeSessionOrders,
    currentBlank,
    list.phase,
    orderBy,
    sessionOrderByAccount,
    workspacePhase,
    workspaceReady,
  ])
  useEffect(() => {
    if (list.phase !== 'ready' || !workspaceReady || orderBy !== 'manual' || currentBlank === undefined) return
    const moved = Object.entries(activeSessionOrders).some(([key, ids]) =>
      ids[0] === currentBlank && sessionOrderByAccount[key]?.[0] !== currentBlank)
    if (moved) actions.syncSessionOrders(activeSessionOrders)
  }, [
    actions.syncSessionOrders,
    activeSessionOrders,
    currentBlank,
    list.phase,
    orderBy,
    sessionOrderByAccount,
    workspaceReady,
  ])
  const saveSessionOrder = (accountKey: string, order: readonly string[]): void => {
    // A caller-supplied group's order is the caller's state: it goes to their
    // store, never to the view store, which the official plugin prunes. Every
    // other key — a Workspace, and the Ungrouped bucket — keeps using the view
    // store exactly as upstream.
    const callerOwned = setProjectOrders !== undefined
      && (groupingOverride?.some(source => source.key === accountKey) ?? false)
    if (!callerOwned) {
      actions.setSessionOrder(accountKey, order, activeSessionOrders)
      return
    }
    // One write covers both modes: the whole map freezes every project at its
    // current order, and the target is replaced with the drop's result. In manual
    // mode the rest of the map is already what is stored, so nothing else moves.
    const next = { ...allProjectOrders(), [accountKey]: [...order] }
    if (orderBy === 'updated') actions.setOrderBy('manual', activeSessionOrders)
    void setProjectOrders?.(next).catch((reason: unknown) => {
      console.warn('project order rejected:', reason)
    })
  }
  // The query outlives the tree and the input (both wide-only) so collapsing
  // does not silently drop an in-progress filter.
  const [query, setQuery] = useState('')
  const [searchExpanded, setSearchExpanded] = useState(false)
  const [revealSessionId, setRevealSessionId] = useState<SessionId | undefined>(undefined)
  // The Session a New Session flow announced, and whether its entry fade has been drawn.
  //
  // Derived during **render** from the announcement, not copied into state by an effect. The
  // announcement and the re-filing that puts the row in its new group are written in the same
  // synchronous step, so React batches them into one commit; an effect would set this *after* that
  // commit, by which time the row has already glided and there is nothing left to fade.
  const announcedLanded = useNewSessionLanded(value => value)
  const [drawnLandedSeq, setDrawnLandedSeq] = useState<number | null>(null)
  const releaseLanded = useCallback(() => {
    setDrawnLandedSeq(announcedLanded === null ? null : announcedLanded.seq)
  }, [announcedLanded])
  // Compared by sequence, not by id: the same blank Session is reused for every New Session, so an
  // id comparison would suppress the fade on every arrival after the first.
  const enteringKeys = useMemo(
    () => (announcedLanded === null || announcedLanded.seq === drawnLandedSeq
      ? EMPTY_ENTERING_KEYS
      : [sessionRowKey(announcedLanded.sessionId)]),
    [announcedLanded, drawnLandedSeq],
  )
  const normalizedQuery = sanitizeSearchQuery(query).trim()
  const [remoteSearch, setRemoteSearch] = useState<RemoteSearchState>({
    query: '',
    status: 'idle',
    items: [],
    hasMore: false,
  })
  const searchRoot = useRef<HTMLDivElement | null>(null)
  const searchInput = useRef<HTMLInputElement | null>(null)
  // The section-header ＋ opens the picker menu (same popover in wide and rail
  // states; the menu anchors on this button) — or the project dialog, which is
  // what "add" means under a project model. The shortcut sets the same request
  // either way, so a project composition must consume it too; otherwise Ctrl+O
  // would resolve as handled and do nothing.
  const wsPickerOpen = !projectModelAvailable && shortcutState.addRequested
  const addRequested = shortcutState.addRequested
  useEffect(() => {
    if (!projectModelAvailable || !addRequested) return
    // Clear the request first: the dialog's own state is what keeps it open, and
    // leaving the flag set would re-open it on every later render.
    closeAddWorkspace()
    setCreateDraft('')
    setCreateError(null)
    setCreating(true)
  }, [addRequested, projectModelAvailable, closeAddWorkspace])
  const wsPlusRef = useRef<HTMLButtonElement>(null)
  const composingRef = useRef(false)

  const openSearchResult = (sessionId: SessionId): void => {
    if (archivedSessionIds.includes(sessionId)) {
      notifyArchivedNotOpenable()
      return
    }
    setRevealSessionId(sessionId)
    setQuery('')
    setSearchExpanded(false)
    open(sessionId)
  }
  const acknowledgeSessionReveal = (sessionId: SessionId): void => {
    setRevealSessionId(current => current === sessionId ? undefined : current)
  }
  useEffect(() => {
    if (normalizedQuery !== '') setRevealSessionId(undefined)
  }, [normalizedQuery])

  // Rail search = expand + land in the search box: the flag arms before the
  // expand request; once the shell flips wide the input mounts and takes focus.
  const [searchOnExpand, setSearchOnExpand] = useState(false)
  useEffect(() => {
    if (wide && searchOnExpand) {
      const timer = window.setTimeout(() => {
        searchInput.current?.focus({ preventScroll: true })
        setSearchOnExpand(false)
      }, EXPAND_SLIDE_MS)
      return () => { window.clearTimeout(timer) }
    }
  }, [wide, searchOnExpand])
  useEffect(() => {
    if (shortcutState.searchRequest === 0) return
    closeAddWorkspace()
    setSearchExpanded(true)
    if (!wide) {
      setSearchOnExpand(true)
      expandSidebar()
    } else searchInput.current?.focus({ preventScroll: true })
  }, [shortcutState.searchRequest])

  useEffect(() => {
    if (!wide || !searchExpanded || searchOnExpand) return
    searchInput.current?.focus({ preventScroll: true })
  }, [wide, searchExpanded, searchOnExpand])

  // Outside-click dismissal stays off while the rail gesture is in flight
  // (searchOnExpand): the rail click flips the shell wide and mounts this
  // listener during its own dispatch, then keeps bubbling to document with
  // the now-unmounted rail button as its target — outside searchRoot, so the
  // listener would dismiss the search that click just opened.
  useEffect(() => {
    if (!wide || !searchExpanded || searchOnExpand) return
    const onClick = (event: MouseEvent): void => {
      if (!(event.target instanceof Node) || searchRoot.current?.contains(event.target) === true) return
      searchInput.current?.blur()
      if (normalizedQuery !== '') return
      setSearchExpanded(false)
    }
    document.addEventListener('click', onClick)
    return () => { document.removeEventListener('click', onClick) }
  }, [normalizedQuery, wide, searchExpanded, searchOnExpand])

  useEffect(() => {
    if (normalizedQuery === '') {
      setRemoteSearch({ query: '', status: 'idle', items: [], hasMore: false })
      return
    }
    const controller = new AbortController()
    setRemoteSearch({
      query: normalizedQuery,
      status: 'loading',
      items: [],
      hasMore: false,
    })
    const timer = window.setTimeout(() => {
      searchSessions(normalizedQuery, controller.signal).then((result) => {
        if (controller.signal.aborted) return
        setRemoteSearch({
          query: normalizedQuery,
          status: 'ready',
          items: result.items,
          hasMore: result.hasMore,
        })
      }).catch(() => {
        if (controller.signal.aborted) return
        setRemoteSearch({
          query: normalizedQuery,
          status: 'error',
          items: [],
          hasMore: false,
        })
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [normalizedQuery, searchSessions])

  // Rename dialog (browser-owned so it outlives row unmounts during collapse).
  // The stored title decides whether confirming is a real rename; the draft is
  // seeded with the label on screen. They differ for a Workspace still
  // carrying its automatic title, so confirming the prefill pins that name.
  //
  // One dialog serves both row kinds: a project row edits its caller-supplied
  // record through `updateProject`, a Workspace row renames a registry entry.
  // Only the commit differs, so the target carries which one it is.
  type RenameTarget =
    | { readonly kind: 'workspace'; readonly id: WorkspaceId; readonly storedTitle: string }
    | {
      readonly kind: 'project'
      readonly id: string
      readonly storedTitle: string
      /** Directories as stored, so the dirty check compares against the truth. */
      readonly storedDirectories: readonly string[]
      /** Links as stored, so the dirty check compares against the truth. */
      readonly storedLinks: readonly string[]
      /**
       * The spec override as stored: `'none'`, a file name, or `null` for
       * "inherit the global choice". Seeded on open so the dropdown's dirty
       * check compares against the truth rather than against a leftover draft.
       */
      readonly storedDocSpec: string | null
    }
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  // The project's directory draft. Seeded on every open, exactly like `renameDraft`:
  // a list left from the previous edit would otherwise leak into this one, which is
  // the same trap `openCreate` resets its draft for.
  const [renameDirectories, setRenameDirectories] = useState<readonly string[]>([])
  /** The project's link draft, reset per open for the same reason as the list above. */
  const [renameRows, setRenameRows] = useState<readonly LinkRowDraft[]>([])
  /** The project's spec draft; `null` means "inherit the global choice". */
  const [renameDocSpec, setRenameDocSpec] = useState<string | null>(null)
  /** The create dialog's spec draft, reset per open like its directory list. */
  const [createDocSpec, setCreateDocSpec] = useState<string | null>(null)
  const [pickingRenameDirectory, setPickingRenameDirectory] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const renameTrimmed = renameDraft.trim()
  // Self is excluded by identity, not by title: the draft is seeded with the
  // localized label, which for an automatically titled Workspace equals its
  // own displayed title without being a conflict with itself. A project holds the
  // same rule — originally it did not, and neither did the Host, so two projects
  // could share a name and be indistinguishable in the tree and in search.
  const renameDuplicate = renameTrimmed !== '' && (
    renameTarget?.kind === 'workspace'
      ? workspaces.some(w => w.workspaceId !== renameTarget.id && w.title === renameTrimmed)
      : renameTarget?.kind === 'project'
        // A project's `key` **is** its project id, so this is the same identity
        // exclusion the Workspace arm performs.
        ? (groupingOverride?.some(source =>
          source.key !== renameTarget.id && source.label === renameTrimmed) ?? false)
        : false
  )
  // A project is edited by title AND directories, so "nothing changed" is both
  // being unchanged. Without the list comparison, changing only the directories
  // would leave the confirm button disabled — which reads as a bug, because the
  // dialog is showing the change the user just made.
  const renameDirectoriesChanged = renameTarget?.kind === 'project'
    && !sameStringList(renameDirectories, renameTarget.storedDirectories)
  /**
   * The link list counts as dirty on the same rule as the directories.
   *
   * Omitting this is the trap the directory comparison documents above: editing only the
   * links would leave 保存 disabled, which reads as a broken dialog rather than as "nothing
   * changed" — the change the user just made is on screen.
   */
  const renameLinksChanged = renameTarget?.kind === 'project'
    && !sameStringList(linkUrls(renameRows), renameTarget.storedLinks)
  /**
   * The spec dropdown counts as dirty only when the feature is on.
   *
   * With the per-project row hidden the draft is never seeded from the record,
   * so comparing it would report every edit as a spec change and write an
   * override the user never saw.
   */
  const renameDocSpecChanged = showDocSpecRow
    && renameTarget?.kind === 'project'
    && renameDocSpec !== renameTarget.storedDocSpec
  const renameBlocked = renaming || renameTrimmed === ''
    || renameTarget === null || renameDuplicate
    || (renameTrimmed === renameTarget.storedTitle && !renameDirectoriesChanged
      && !renameLinksChanged && !renameDocSpecChanged)
  const closeRename = () => {
    if (renaming) return
    setRenameTarget(null)
    setRenameError(null)
  }
  const confirmRename = () => {
    if (renameBlocked || renameTarget === null) return
    setRenaming(true)
    setRenameError(null)
    const commit = renameTarget.kind === 'workspace'
      ? renameWorkspace(renameTarget.id, renameTrimmed)
      : updateProject === undefined
        ? Promise.reject(new Error('no project model'))
        : updateProject(renameTarget.id, renameTrimmed, renameDirectories, linkUrls(renameRows), renameDocSpec)
    commit.then(() => {
      setRenaming(false)
      setRenameTarget(null)
    }).catch((reason: unknown) => {
      setRenaming(false)
      setRenameError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  /**
   * Add one directory from the Host picker to the edit dialog's list.
   *
   * Mirrors the create dialog's helper, including the cancel and dedupe rules;
   * the two differ only in which list they write and which error slot they fill.
   */
  const addRenameDirectory = (): void => {
    if (pickDirectory === undefined) return
    setPickingRenameDirectory(true)
    pickDirectory().then((path) => {
      if (path !== null) setRenameDirectories(list => list.includes(path) ? list : [...list, path])
    }).catch((reason: unknown) => {
      setRenameError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setPickingRenameDirectory(false) })
  }

  // New-project dialog. Structurally the rename dialog with an empty seed: a
  // project is a title plus the directories it associates, and neither exists
  // until the dialog is confirmed. Browser-owned for the same reason the others
  // are (it must outlive any row).
  //
  // It exists only when the composition supplies a project model. Without one
  // the header keeps the shipped directory flow, which is the only "add" a
  // composition without projects can perform.
  const [creating, setCreating] = useState(false)
  const [createDraft, setCreateDraft] = useState('')
  /**
   * Whether the create dialog's name field is mid-composition (IME).
   *
   * Its own ref rather than the rename dialog's `composingRef`: the two dialogs can be
   * open at different times and share no state, so one flag for both would let one
   * dialog's composition block or unblock the other's Enter.
   */
  const createComposingRef = useRef(false)
  const [createDirectories, setCreateDirectories] = useState<readonly string[]>([])
  /** The create dialog's link draft, reset per open like its directory list. */
  const [createRows, setCreateRows] = useState<readonly LinkRowDraft[]>([])
  const [pickingCreateDirectory, setPickingCreateDirectory] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const createTrimmed = createDraft.trim()
  // A title another project already holds is not available — the same rule the rename dialog
  // applies below, and the same one the Host enforces. This only spares the user a round trip that
  // is certain to fail; the Host is the authority, because the dialog is not the only entry point.
  const createDuplicate = createTrimmed !== ''
    && (groupingOverride?.some(source => source.label === createTrimmed) ?? false)
  const createBlocked = createBusy || createTrimmed === '' || createDuplicate
  /**
   * Add one directory from the Host picker to the create dialog's list.
   *
   * Cancelling is a decision, not a failure: a null answer adds nothing and
   * reports nothing. A chosen path already on the list is ignored, because two
   * identical rows are indistinguishable and the remove button filters by path —
   * so one click would delete both.
   */
  const addCreateDirectory = (): void => {
    if (pickDirectory === undefined) return
    setPickingCreateDirectory(true)
    pickDirectory().then((path) => {
      if (path !== null) setCreateDirectories(list => list.includes(path) ? list : [...list, path])
    }).catch((reason: unknown) => {
      setCreateError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setPickingCreateDirectory(false) })
  }
  const openCreate = () => {
    setCreateDraft('')
    // Reset per open, like the draft above: a list left from the previous create
    // would otherwise leak into this one.
    setCreateDirectories([])
    setCreateRows([])
    setCreateDocSpec(null)
    setCreateError(null)
    setCreating(true)
  }
  const closeCreate = () => {
    if (createBusy) return
    setCreating(false)
    setCreateError(null)
  }
  const confirmCreate = () => {
    if (createBlocked || createProject === undefined) return
    setCreateBusy(true)
    setCreateError(null)
    createProject({ title: createTrimmed, directories: createDirectories, links: linkUrls(createRows), docSpec: createDocSpec }).then(({ projectId }) => {
      setCreateBusy(false)
      setCreating(false)
      // The official add-workspace flow opens a Session as part of creating the row
      // (`WorkspacePicker.onPick` → `startSession`), so the user lands in something
      // they can type into instead of an empty sidebar. This follows it, with the
      // substitution a project forces: it has no Workspace id, so the target is the
      // caller's base workspace and the filing rides `beforeOpen` — exactly the call
      // a project row's ＋ makes. That filing is what puts the Session under the
      // project just created.
      //
      // A reused blank Session moves here rather than being duplicated, which is
      // upstream's own behaviour: `reuseOrCreateBlank` keeps one blank Session per
      // Workspace, and every project shares one Workspace. So this reads as "the
      // current blank moves to the project you just made", not as a second Session.
      //
      // Guarded like the row's own opening: the Session is best-effort, and a failure
      // to open must not read as a failure to create — the project exists and is on
      // screen either way. The dialog closes in both cases too, which is why the flag
      // is read after `setCreating(false)` rather than before it.
      if (!openSessionOnCreate) return
      startSession(undefined, assignSession === undefined
        ? undefined
        : (sessionId) => {
          void assignSession(sessionId, projectId).catch((reason: unknown) => {
            console.warn('file session rejected:', reason)
          })
        })
    }).catch((reason: unknown) => {
      setCreateBusy(false)
      setCreateError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  // The search results' restore button; the row actions own the rest of the
  // Session verbs as slot entries.
  const onSessionUnarchive = (sessionId: SessionNode['id']) => {
    unarchiveSession(sessionId).catch((reason: unknown) => {
      console.warn('session unarchive rejected:', reason)
    })
  }

  // Delete dialog is separate from the row so a successful removal can
  // unmount that row without tearing down the in-flight confirmation state.
  // Like the rename dialog it serves both row kinds; only the commit and what
  // "the row is gone" means differ.
  type DeleteTarget =
    | { readonly kind: 'workspace'; readonly id: WorkspaceId; readonly title: string }
    | { readonly kind: 'project'; readonly id: string; readonly title: string }
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteCommittedId, setDeleteCommittedId] = useState<WorkspaceId | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  useEffect(() => {
    // Workspace removals wait for the registry projection to drop the id, as
    // shipped. A project commit closes on its own resolution instead: the
    // grouping override is the caller's observable, and this component must
    // not assume it has already re-rendered by the time the promise settles.
    if (deleteCommittedId === null
      || workspaces.some(workspace => workspace.workspaceId === deleteCommittedId)) return
    setDeleting(false)
    setDeleteCommittedId(null)
    setDeleteTarget(null)
  }, [deleteCommittedId, workspaces])
  const closeDelete = () => {
    if (deleting) return
    setDeleteTarget(null)
    setDeleteError(null)
  }
  const confirmDelete = () => {
    /* v8 ignore next -- the Modal is absent without a target and its button is disabled while deleting. */
    if (deleting || deleteTarget === null) return
    setDeleting(true)
    setDeleteCommittedId(null)
    setDeleteError(null)
    if (deleteTarget.kind === 'project') {
      const commit = deleteProject === undefined
        ? Promise.reject(new Error('no project model'))
        : deleteProject(deleteTarget.id)
      commit.then(() => {
        setDeleting(false)
        setDeleteTarget(null)
      }).catch((reason: unknown) => {
        setDeleting(false)
        setDeleteError(reason instanceof Error ? reason.message : String(reason))
      })
      return
    }
    deleteWorkspace(deleteTarget.id).then(() => {
      // Keep the confirmation pending until this component has rendered the
      // committed list projection without the deleted id. Closing earlier
      // exposes one stale React frame to the next Create Workspace gesture.
      setDeleteCommittedId(deleteTarget.id)
    }).catch((reason: unknown) => {
      setDeleting(false)
      setDeleteError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return (
    <div className={clsx(css.root, !wide && css.rail)}>
      <div className={css.sectionHeader}>
        {wide && (
          <span className={clsx(css.sectionLabel, css.wide, searchExpanded && css.sectionLabelHidden)}>
            {groupBy === 'flat' ? t('section.sessions') : t('section.workspaces')}
          </span>
        )}
        {wide && (
          <div className={clsx(css.searchSlot, searchExpanded && css.searchSlotExpanded)}>
            <div
              ref={searchRoot}
              className={clsx(css.search, searchExpanded && css.searchExpanded)}
              onClick={() => {
                closeAddWorkspace()
                setSearchExpanded(true)
                searchInput.current?.focus()
              }}
            >
              <Tooltip label={t('search')} shortcutKeys={searchShortcut?.keys} side="bottom" delayMs={500} disabled={searchExpanded}>
                <button
                  type="button"
                  className={css.searchButton}
                  aria-label={t('search.sessions.aria')}
                  aria-keyshortcuts={searchShortcut?.aria}
                  aria-expanded={searchExpanded}
                  onClick={() => {
                    requestSearch()
                  }}
                >
                  <IconSearchOutlineRegular size={searchExpanded ? 11 : 14} />
                </button>
              </Tooltip>
              <input
                ref={searchInput}
                className={css.searchInput}
                type="text"
                placeholder={t('search.placeholder')}
                maxLength={SEARCH_QUERY_MAX_CODE_UNITS}
                value={query}
                tabIndex={searchExpanded ? 0 : -1}
                onChange={(e) => { setQuery(sanitizeSearchQuery(e.target.value)) }}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') return
                  setQuery('')
                  setSearchExpanded(false)
                }}
              />
              {searchExpanded && (
                <button
                  type="button"
                  className={css.clearButton}
                  aria-label={t('search.clear')}
                  onClick={(e) => {
                    e.stopPropagation()
                    setQuery('')
                    setSearchExpanded(false)
                  }}
                >
                  <IconCloseFillRegular />
                </button>
              )}
            </div>
          </div>
        )}
        <div className={clsx(css.headerActions, wide && searchExpanded && css.headerActionsHidden)}>
          {wide && (
            <ViewOptionsMenu
              groupBy={groupBy}
              orderBy={orderBy}
              archivedFilter={archivedFilter}
              onGroupPick={actions.setGroupBy}
              onOrderPick={(mode) => {
                actions.setOrderBy(mode, activeSessionOrders)
                // Caller-owned orders follow the same lifecycle as the view
                // store's: manual freezes what is on screen (a project with no
                // record would otherwise keep re-sorting by recency, making the
                // menu's "manual" a lie), and recency discards it.
                if (setProjectOrders === undefined) return
                void setProjectOrders(mode === 'manual' ? allProjectOrders() : {}).catch((reason: unknown) => {
                  console.warn('project order rejected:', reason)
                })
              }}
              onArchivedFilterPick={actions.setArchivedFilter}
              t={t}
            />
          )}
          {/* With a project model the header adds a project; without one it
              keeps the shipped directory flow, which is the only "add" a
              composition without projects can perform. */}
          {(projectModelAvailable || directoryFlowAvailable) && (
            <Tooltip
              label={t(projectModelAvailable ? 'project.add' : 'workspace.add')}
              shortcutKeys={projectModelAvailable ? undefined : addShortcut?.keys}
              side="bottom"
              delayMs={500}
            >
              <button
                ref={wsPlusRef}
                type="button"
                className={css.iconButton}
                aria-label={t(projectModelAvailable ? 'project.add' : 'workspace.add')}
                onClick={() => {
                  if (projectModelAvailable) openCreate()
                  else requestAddWorkspace()
                }}
              >
                <IconProjectAddOutlineRegular size={wide ? 16 : 18} />
              </button>
            </Tooltip>
          )}
        </div>
        {/* Add flow + its error dialog (same package — direct composition).
            Absent under a project model: adding is the project dialog's job
            there, and a directory flow nobody can reach would only keep the
            picking slot occupied. */}
        {!projectModelAvailable && (
          <WorkspacePickFlow
            t={t}
            open={wsPickerOpen}
            anchorRef={wsPlusRef}
            useWorkspaces={useWorkspaces}
            createWorkspace={createWorkspace}
            useDirectoryFlow={useDirectoryFlow}
            renderDirectoryFlow={owner => renderSlot('sidebar.workspaces.directoryFlow', owner)}
            addOnly
            onBusyChange={setDirectoryBusy}
            side="right"
            onPick={(workspaceId) => {
              closeAddWorkspace()
              startSession(workspaceId)
            }}
            onClose={() => { closeAddWorkspace() }}
          />
        )}
      </div>

      {/* The collapsed rail keeps search as its own 36px control. */}
      {!wide && <div className={css.search}>
        <Tooltip label={t('search')} shortcutKeys={searchShortcut?.keys}>
          <button
            type="button"
            className={css.searchButton}
            aria-label={t('search.sessions.aria')}
            aria-keyshortcuts={searchShortcut?.aria}
            onClick={() => {
              requestSearch()
            }}
          >
            <IconSearchOutlineRegular size={18} />
          </button>
        </Tooltip>
      </div>}

      {/* Always-mounted seat keeps the region's flex slot while the list
          itself is wide-only. */}
      <div className={css.listArea}>
        {wide && (normalizedQuery !== ''
          ? (
            <SearchResults
              usePanelInfo={usePanelInfo}
              useSessions={useSessions}
              useSessionStatus={useSessionStatus}
              open={openSearchResult}
              onUnarchive={onSessionUnarchive}
              workspaces={workspaces}
              groupingOverride={groupingOverride}
              archivedSessionIds={archivedSessionIds}
              archivedFilter={archivedFilter}
              query={normalizedQuery}
              remote={remoteSearch}
              resultLimit={searchResultLimit}
              t={t}
            />
          )
          : groupBy === 'flat'
            ? (
              <FlatList
                usePanelInfo={usePanelInfo}
                list={list}
                sessionIds={orderedFlatSessionIds}
                rowState={rowState}
                onLeaveArchivedOnly={leaveArchivedOnly}
                workspaceReady={workspaceReady}
                animationResetKey={`${groupBy}/${orderBy}/${archivedFilter}`}
                useSessionStatus={useSessionStatus}
                open={guardedOpen}
                onSessionRenameRequest={requestSessionRename}
                renderSlot={renderSlot}
                setSessionOrder={saveSessionOrder}
                revealSessionId={revealSessionId}
                onSessionRevealed={acknowledgeSessionReveal}
                enteringKeys={enteringKeys}
                onEnteringKeysDrawn={releaseLanded}
                t={t}
              />
            )
            : (
              <SessionTree
                usePanelInfo={usePanelInfo}
                list={list}
                shortcuts={shortcuts}
                useSessionStatus={useSessionStatus}
                onSessionRenameRequest={requestSessionRename}
                renderSlot={renderSlot}
                reorderProject={reorderProject}
                assignSession={assignSession}
                workspaces={orderedWorkspaces}
                groupingOverride={orderedProjects}
                ungroupedSessionIds={orderedUngroupedSessionIds}
                workspaceReady={workspaceReady}
                nestWorkspaces={groupBy === 'workspace-tree'}
                animationResetKey={`${groupBy}/${orderBy}/${archivedFilter}`}
                groupExpansion={groupExpansion}
                setGroupExpanded={actions.setGroupExpanded}
                projectExpansion={projectExpansion}
                setProjectExpanded={setProjectExpanded}
                setSessionOrder={saveSessionOrder}
                rowState={rowState}
                onLeaveArchivedOnly={leaveArchivedOnly}
                startSession={startSession}
                open={guardedOpen}
                insertWorkspaceBefore={insertWorkspaceBefore}
                unassignSession={unassignSession}
                orderBy={orderBy}
                revealSessionId={revealSessionId}
                onSessionRevealed={acknowledgeSessionReveal}
                enteringKeys={enteringKeys}
                onEnteringKeysDrawn={releaseLanded}
                home={home}
                t={t}
                onRenameRequest={(row) => {
                  setRenameTarget(row.kind === 'project'
                    ? {
                      kind: 'project',
                      id: row.id,
                      storedTitle: row.title,
                      // `?? []` because the field is optional on the shared request
                      // type — the delete dialog has no directories to carry.
                      storedDirectories: row.directories ?? [],
                      // Same `?? []`: this field is optional on the shared request type.
                      storedLinks: row.links ?? [],
                      // `undefined` on the wire means "inherit", which the
                      // dropdown can only express as its own `null` — an absent
                      // key and "no override" are the same state, but the draft
                      // needs a value to compare.
                      storedDocSpec: row.docSpec ?? null,
                    }
                    : {
                      kind: 'workspace',
                      id: row.id,
                      storedTitle: storedWorkspaces.find(w => w.workspaceId === row.id)?.title ?? row.title,
                    })
                  setRenameDraft(row.title)
                  // Reset per open, exactly like `openCreate` resets its list: a
                  // directory set left from the previous edit would otherwise leak
                  // into this one.
                  setRenameDirectories(row.kind === 'project' ? [...(row.directories ?? [])] : [])
                  setRenameRows(row.kind === 'project' ? (row.links ?? []).map(url => newLinkRow(url)) : [])
                  setRenameDocSpec(row.kind === 'project' ? row.docSpec ?? null : null)
                  setRenameError(null)
                }}
                onDeleteRequest={(row) => {
                  setDeleteTarget({ ...row })
                  setDeleteError(null)
                }}
              />
            ))}
      </div>

      <Modal
        open={renameTarget !== null}
        onClose={closeRename}
        closeLabel={t('close')}
        title={t(renameTarget?.kind === 'project' ? 'edit.project.title' : 'rename.workspace.title')}
        // Wider only for a project: that dialog carries a directory list, and the
        // shipped 380px card clips even a middling path. The Workspace arm keeps
        // the standard width, so the two rows do not drift.
        {...renameTarget?.kind === 'project' ? { className: css.directoryDialog } : {}}
        footer={(
          <>
            <Button variant="outline" disabled={renaming} onClick={closeRename}>{t('cancel')}</Button>
            {/* A project row commits a title *and* a directory list, so its button
              * says 保存; a Workspace row only renames. */}
            <Button variant="primary" disabled={renameBlocked} onClick={confirmRename}>
              {t(renameTarget?.kind === 'project' ? 'save' : 'rename')}
            </Button>
          </>
        )}
      >
        <input
          className={css.renameInput}
          value={renameDraft}
          aria-label={t(renameTarget?.kind === 'project' ? 'field.projectName' : 'field.workspaceName')}
          data-modal-autofocus
          disabled={renaming}
          onFocus={(e) => { e.target.select() }}
          onChange={(e) => { setRenameDraft(e.target.value); setRenameError(null) }}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !composingRef.current) {
              e.preventDefault()
              confirmRename()
            }
          }}
        />
        {renameDuplicate && (
          <div className={css.renameError} role="alert">
            {/* The shipped key says 工作区, which is right for one row kind and wrong for the
              * other: this dialog serves both, so the message names whichever the user is
              * actually editing. */}
            {t(renameTarget?.kind === 'project' ? 'conflict.projectNamed' : 'conflict.named',
              { name: renameTrimmed })}
          </div>
        )}
        {/*
          The directory block exists only for a project row: a Workspace has no
          associated directories, and its own `cwd` lives in the registry.
        */}
        {renameTarget?.kind === 'project' && (
          <div className={css.directoryBlock}>
            <DirectoryHeader
              label={t('field.directories')}
              disabled={renaming || pickingRenameDirectory || pickDirectory === undefined}
              onAdd={addRenameDirectory}
              t={t}
            />
            <DirectoryRows
              paths={renameDirectories}
              disabled={renaming}
              onRemove={(path) => {
                setRenameDirectories(list => list.filter(item => item !== path))
              }}
              t={t}
            />
          </div>
        )}
        {/*
          The link block, on the same condition as the directory block above: links hang
          off a project record, so a Workspace row has none. Rendered as one component because
          the header's settled-count state must die with the rows it describes — see
          {@link LinkBlock}.
        */}
        {renameTarget?.kind === 'project' && (
          <LinkBlock
            rows={renameRows}
            onRowsChange={setRenameRows}
            enabled={validateLinks}
            disabled={renaming}
            t={t}
          />
        )}
        {/*
          The spec dropdown, present only for a project **and** only while the
          per-project switch is on: with the switch off there is one spec for
          every project, and a fourth row would offer a choice the user turned
          off. 跟随全局 is its own first row, so the list needs no knowledge of
          what the global choice currently is.
        */}
        {renameTarget?.kind === 'project' && showDocSpecRow && (
          <DocSpecRow
            value={renameDocSpec}
            specs={specs}
            disabled={renaming}
            onChange={setRenameDocSpec}
            t={t}
          />
        )}
        {renameError !== null && <div className={css.renameError} role="alert">{renameError}</div>}
      </Modal>

      <Modal
        open={deleteTarget !== null}
        onClose={closeDelete}
        closeLabel={t('close')}
        title={t(deleteTarget?.kind === 'project' ? 'delete.project' : 'delete.workspace')}
        {...deleteTarget === null
          ? {}
          : { description: t(deleteTarget.kind === 'project' ? 'delete.project.desc' : 'delete.desc', { name: deleteTarget.title }) }}
        footer={(
          <>
            <Button variant="outline" disabled={deleting} onClick={closeDelete}>{t('cancel')}</Button>
            <Button
              variant="outline"
              className={css.deleteAction}
              disabled={deleting}
              onClick={confirmDelete}
            >
              {t(deleteTarget?.kind === 'project' ? 'delete.project' : 'delete.workspace')}
            </Button>
          </>
        )}
      >
        {deleting && <div className={css.deleteStatus} role="status">
          {t(deleteTarget?.kind === 'project' ? 'delete.project.pending' : 'delete.pending')}
        </div>}
        {deleteError !== null && <div className={css.renameError} role="alert">{deleteError}</div>}
      </Modal>

      {/* New project: a title plus the directories it associates. Present only
          under a project model, so an upstream composition renders no dialog it
          could reach. */}
      {projectModelAvailable && (
        <Modal
          open={creating}
          onClose={closeCreate}
          closeLabel={t('close')}
          title={t('project.create.title')}
          // The same widened card the project edit dialog uses: both show a
          // directory list, so a long path must not be clipped in one and fit in
          // the other.
          className={css.directoryDialog}
          footer={(
            <>
              <Button variant="outline" disabled={createBusy} onClick={closeCreate}>{t('cancel')}</Button>
              <Button variant="primary" disabled={createBlocked} onClick={confirmCreate}>{t('create')}</Button>
            </>
          )}
        >
          <input
            className={css.renameInput}
            value={createDraft}
            aria-label={t('field.projectName')}
            placeholder={t('project.create.placeholder')}
            data-modal-autofocus
            disabled={createBusy}
            onChange={(e) => { setCreateDraft(e.target.value) }}
            // The same IME guard the rename dialog carries. Without it, pressing Enter
            // to commit a Chinese or Japanese composition also fires `confirmCreate()`,
            // creating the project with the half-composed name the user was still
            // editing. `onCompositionStart`/`End` bracket the composition; Enter during
            // one belongs to the IME, not to this dialog.
            onCompositionStart={() => { createComposingRef.current = true }}
            onCompositionEnd={() => { createComposingRef.current = false }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !createComposingRef.current) confirmCreate() }}
          />
          <div className={css.directoryBlock}>
            <DirectoryHeader
              label={t('field.directories')}
              disabled={createBusy || pickingCreateDirectory || pickDirectory === undefined}
              onAdd={addCreateDirectory}
              t={t}
            />
            <DirectoryRows
              paths={createDirectories}
              disabled={createBusy}
              onRemove={(path) => {
                setCreateDirectories(list => list.filter(item => item !== path))
              }}
              t={t}
            />
          </div>
          {/* The link block, mirroring the edit dialog's — including being its own component,
            * so its header state cannot outlive the rows. `open={creating}` already unmounts
            * this subtree (the official `Modal` returns `null` while closed), and the explicit
            * gate keeps that independence of the Modal's internals. */}
          {creating && (
            <LinkBlock
              rows={createRows}
              onRowsChange={setCreateRows}
              enabled={validateLinks}
              disabled={createBusy}
              t={t}
            />
          )}
          {/* The per-project spec row, gated exactly as the edit dialog's is. */}
          {showDocSpecRow && (
            <DocSpecRow
              value={createDocSpec}
              specs={specs}
              disabled={createBusy}
              onChange={setCreateDocSpec}
              t={t}
            />
          )}
          {createDuplicate && (
            <div className={css.renameError} role="alert">
              {t('conflict.projectNamed', { name: createTrimmed })}
            </div>
          )}
          {createError !== null && <div className={css.renameError} role="alert">{createError}</div>}
        </Modal>
      )}
      {shortcutState.forkError !== null && <Toast key={shortcutState.forkError.seq}
        text={t(shortcutState.forkError.reason === 'unavailable' ? 'shortcut.noCompletedTurn' : 'shortcut.forkFailed')}
        onDone={dismissForkError} />}
    </div>
  )
}
