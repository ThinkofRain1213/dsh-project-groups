/**
 * The `shell.overlay` entry for Workspace and Session notices.
 * One notice is visible at a time; a parent rerender does not extend its hold.
 */
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { RowToastProps, RowToastState } from '../contract/slots.ts'

/**
 * Hold for the notices that take longer to read than a one-line warning: the
 * actionable archived notice (two buttons to react to) and a refused Session
 * creation, which quotes the Host's reason.
 */
const LONG_TOAST_HOLD_MS = 6000

/**
 * Render the current notice: the archived and stopped-and-archived notices
 * with their undo action — plus the show-archived action while archived rows
 * are hidden — on a 6 s hold, a refused Session creation with the Host's
 * reason on the same hold, or a plain warning for a failed pin, an archived
 * row that was clicked, or default Workspace creation.
 * @param props - the notice hook, the shared viewing store, the notice dismissal, the two archived-notice actions, and the locale seat.
 * @returns the notice on display, or null.
 */
export function RowActionToast({ useToast, useStore, dismissToast, undoArchive, showArchived, t }: RowToastProps) {
  const toast = useToast(current => current)
  const archivedRowsVisible = useStore(state => (state.archivedFilter ?? 'default') !== 'default')
  if (toast === null) return null

  // The notice lifecycle, in one place.
  //
  // Every branch renders a `<Toast>` and every one needs the same two things: the per-show
  // sequence key (a new notice must restart the hold/fade cycle rather than continue the
  // previous one) and the dismissal callback. Written out per branch, a change to either had to
  // be made three times — and the keying is exactly the part that silently misbehaves when one
  // copy is missed, since a stale key means the timer never restarts.
  //
  // `onDone` is spread but `key` is not: React reads `key` off a props object, and recent
  // versions warn when one is spread into JSX. The value still comes from a single place, and
  // only the attribute name repeats.
  const seqKey = `toast-${String(toast.seq)}`
  const lifecycle = { onDone: dismissToast }

  if (toast.kind === 'archived' || toast.kind === 'stoppedAndArchived') {
    const { sessionId } = toast
    // The filter action only makes sense while archived rows are hidden; with them already
    // shown there would be nothing for it to reveal.
    //
    // Hoisted into a named list rather than spread from an inline ternary — `...cond ? [] : [x]`
    // reads as though the spread bound to the flag, and any later edit (a third element, a
    // reorder) has to re-derive that it does not.
    const filterAction = { prefix: t('toast.archivedOr'), label: t('toast.archivedFilter'), onClick: () => { dismissToast(); showArchived() } }
    const actions = archivedRowsVisible
      ? [{ label: t('toast.archivedUndo'), onClick: () => { dismissToast(); undoArchive(sessionId) } }]
      : [
          { label: t('toast.archivedUndo'), onClick: () => { dismissToast(); undoArchive(sessionId) } },
          filterAction,
        ]
    return (
      <Toast
        key={seqKey}
        {...lifecycle}
        text={t(toast.kind === 'archived' ? 'toast.archived' : 'toast.stoppedAndArchived')}
        tone="success"
        holdMs={LONG_TOAST_HOLD_MS}
        actions={actions}
      />
    )
  }
  if (toast.kind === 'createFailed') {
    return (
      <Toast
        key={seqKey}
        {...lifecycle}
        text={t('toast.createFailed', { message: toast.message })}
        icon={<IconWarningOutlineRegular />}
        holdMs={LONG_TOAST_HOLD_MS}
      />
    )
  }
  return (
    <Toast
      key={seqKey}
      {...lifecycle}
      text={plainNoticeText(toast, t)}
      icon={<IconWarningOutlineRegular />}
    />
  )
}

/** The copy of one plain warning, keyed by the notice kind the union closes over. */
function plainNoticeText(
  toast: Exclude<RowToastState, { kind: 'archived' | 'stoppedAndArchived' | 'createFailed' }>,
  t: RowToastProps['t'],
): string {
  switch (toast.kind) {
    case 'pinFailed': return t('toast.pinFailed')
    case 'unpinFailed': return t('toast.unpinFailed')
    case 'defaultWorkspaceFailed': return t('defaultWorkspace.failed')
    case 'archivedNotOpenable': return t('toast.archivedNotOpenable')
    /* v8 ignore next 2 -- closed-union backstop; only reached if a notice kind is forged */
    default:
      return assertNever(toast)
  }
}
