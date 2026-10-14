/**
 * The `shell.overlay` entry for a New Session whose 底层工作区 is gone.
 *
 * The shipped region does nothing in that case: `startSessionInDefaultWorkspace`
 * returns as soon as the default Workspace fails to resolve, so a click on New Session
 * had no visible effect whatsoever (the toast only covers the *throwing* path, and a
 * deleted registration does not throw). This surfaces the reason instead, and offers
 * the two repairs.
 *
 * ## Layout
 *
 * The actions are stacked, not laid out in a row. The shared `Modal` footer is a
 * right-aligned flex row, which gives three equal actions about 77px each in the
 * default 380px card — five Chinese characters, less than the labels here need. A
 * column footer gives each action the card's full width (measured: 304px usable in a
 * 380px card), and it is what the official plugin-manager dialog does
 * (`.installFooter { flex-direction: column }`).
 *
 * Order runs most-active first, so the destructive-feeling "取消" sits last.
 *
 * ## Two stages, one dialog
 *
 * The rebuild writes to the disk — in `'default'` mode to the official default Workspace's own
 * directory — so it asks first. The confirmation is a **second stage of this card**, not a second
 * `Modal`: measured, two modals would both sit at `z-index: 1000` and each installs its own
 * document-level Escape and Tab handler, so one Escape would close both and the focus trap could
 * escape outward. Switching the content of one card gets the confirmation without any of that.
 *
 * ## Why the two repairs are optional
 *
 * Both are wired now, but the callbacks stay optional: a composition that supplies neither renders
 * both buttons disabled, which is honest. A button that appears to work and does nothing is the bug
 * this whole dialog exists to remove.
 */
import { useEffect, useRef, useState } from 'react'
import {
  Button, IconWarningOutlineRegular, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { BaseWorkspaceDialogProps, BaseWorkspaceMissingRequest } from '../contract/slots.ts'
import browserCss from '../rows/WorkspaceBrowser.module.css'

/**
 * Which stage the dialog is showing.
 *
 * A named union rather than a boolean: the confirmation is the second of a sequence, and a third
 * ("the rebuild failed, try again") is plausible, where `isConfirming` would then have to become a
 * pair of flags that can disagree.
 */
type Stage = 'report' | 'confirm'

/**
 * Render the missing-Workspace dialog.
 * @param props - the pending report, its settlement, the two repairs, and the locale seat.
 * @returns the dialog, or null when nothing is pending.
 */
export function BaseWorkspaceMissingDialog({
  useBaseWorkspaceRequest, settleBaseWorkspaceMissing, rebuildBaseWorkspace, chooseBaseWorkspace, t,
}: BaseWorkspaceDialogProps) {
  const request = useBaseWorkspaceRequest(current => current)
  if (request === null) return null
  return (
    <BaseWorkspaceMissingForm
      // Keyed by the report so in-flight and error state die with it, the same way
      // the archive confirmation does one request per dialog.
      key={`${request.mode}:${request.path ?? ''}`}
      request={request}
      settle={settleBaseWorkspaceMissing}
      rebuild={rebuildBaseWorkspace}
      choose={chooseBaseWorkspace}
      t={t}
    />
  )
}

/**
 * One report's dialog: busy and error state die with it.
 * @param props - the report and the actions it offers.
 * @returns the dialog.
 */
function BaseWorkspaceMissingForm({ request, settle, rebuild, choose, t }: {
  request: BaseWorkspaceMissingRequest
  settle: () => void
  rebuild: (() => Promise<void>) | undefined
  choose: (() => void) | undefined
  t: BaseWorkspaceDialogProps['t']
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stage, setStage] = useState<Stage>('report')
  const confirmRef = useRef<HTMLButtonElement>(null)
  const reportPrimaryRef = useRef<HTMLButtonElement>(null)
  /** Skips the mount pass so `Modal`'s own `data-modal-autofocus` keeps initial focus. */
  const stageMounted = useRef(false)

  // `Modal` focuses `data-modal-autofocus` in an effect keyed on `[dialog, open]`, so a stage switch
  // does not re-run it: this effect is what moves focus across the switch.
  //
  // It is written to be **load-bearing rather than incidental**. As originally measured it was not:
  // both stages render `<div><Button/><Button/>…</div>`, so React reconciles by position, the first
  // button is the *same DOM element* across the switch, and the browser simply keeps focus on it —
  // removing the effect did not fail the probe. That made correctness depend on positional
  // reconciliation in a branch this one does not control: reorder a footer, wrap one in a fragment,
  // or give the primary action a different position, and the reuse stops and focus silently falls to
  // nothing.
  //
  // So it now names a target per stage and focuses it explicitly in both directions, which is
  // independent of whether React reuses the element. The mount pass is skipped so the modal's own
  // autofocus still decides where focus starts.
  useEffect(() => {
    if (!stageMounted.current) {
      stageMounted.current = true
      return
    }
    if (stage === 'confirm') confirmRef.current?.focus()
    else reportPrimaryRef.current?.focus()
  }, [stage])

  const run = (action: () => Promise<void>): void => {
    setBusy(true)
    setError(null)
    // The invocation itself is guarded, not just the promise it returns.
    //
    // `action` is injected and typed `() => Promise<void>`, but a type is not a runtime
    // guarantee: an implementation that throws synchronously — before it ever returns a
    // promise — would escape `run` entirely, because `.then`/`.catch` were only attached
    // *after* the call. Neither `setBusy(false)` nor `setError(...)` would run, leaving
    // the dialog permanently disabled in its busy state with no explanation.
    //
    // Written as a `try` around the call rather than `Promise.resolve().then(action)` so
    // the action still starts synchronously, exactly as before; only the failure path
    // changes. `Promise.resolve` then covers the case where the implementation returns a
    // non-promise anyway, which the type says cannot happen and a runtime can still do.
    let started: Promise<void>
    try {
      started = Promise.resolve(action())
    } catch (reason: unknown) {
      setBusy(false)
      setError(reason instanceof Error ? reason.message : String(reason))
      return
    }
    started.then(() => {
      setBusy(false)
      // Only a completed repair closes the dialog. A dialog that closed on a failed
      // rebuild would leave the user back where they started, with no explanation.
      settle()
    }).catch((reason: unknown) => {
      setBusy(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  const close = (): void => {
    // A rebuild in flight cannot be cancelled by closing the dialog — the request is already
    // sent — so Escape must not pretend otherwise.
    if (busy) return
    // On the confirm stage, Escape and a mask click step **back** rather than dismissing the
    // report: the user declined the confirmation, not the whole attempt, and dismissing would make
    // them click New Session again to get back here.
    if (stage === 'confirm') {
      setStage('report')
      return
    }
    settle()
  }

  // Hoisted rather than written twice. Both stages must name the same directory — the
  // confirm stage repeats it deliberately, because the confirmation is about *which*
  // directory is created — and two verbatim copies could drift apart, which would make the
  // two stages disagree about the one thing the user is being asked to check.
  const pathNotice = (
    <p className={browserCss.baseMissingPath} role="note">
      {request.path === null
        ? t('baseMissing.pathUnknown')
        : t('baseMissing.path', { path: request.path })}
    </p>
  )

  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={stage === 'confirm' ? t('baseMissing.confirmTitle') : t('baseMissing.title')}
      footer={stage === 'confirm'
        ? (
          <div className={browserCss.baseMissingActions}>
            <Button
              ref={confirmRef}
              variant="primary"
              disabled={busy || rebuild === undefined}
              onClick={() => { if (rebuild !== undefined) run(rebuild) }}
            >
              {busy ? t('baseMissing.confirmBusy') : t('baseMissing.confirmAction')}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => { setStage('report') }}>
              {t('baseMissing.confirmBack')}
            </Button>
          </div>
        )
        : (
          <div className={browserCss.baseMissingActions}>
            <Button
              ref={reportPrimaryRef}
              variant="primary"
              disabled={busy || rebuild === undefined}
              // The rebuild writes to the disk, so it asks first. This is a stage change, not a
              // second dialog — see the module note.
              onClick={() => { setStage('confirm') }}
            >
              {t('baseMissing.rebuild')}
            </Button>
            <Button
              variant="outline"
              disabled={busy || choose === undefined}
              onClick={() => {
                // The chooser lives on the settings card, so this hands the user to another page.
                // The report is consumed **first**: a report left pending would still be on screen
                // when the user arrives there, stacking a dialog about a missing Workspace over
                // the one asking them to pick a replacement.
                settle()
                // Guarded because `choose` is injected. Consuming the report and then throwing
                // out of the click handler would leave the user on a blank view with the report
                // already gone — nothing left to explain what happened, and no way back to it.
                // The same defensive shape as `run` above covers an injected callback that
                // throws before it returns anything.
                try {
                  choose?.()
                } catch (cause: unknown) {
                  console.warn('dsh-project-groups: base-workspace chooser failed', cause)
                }
              }}
            >
              {t('baseMissing.respecify')}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              data-modal-autofocus
              onClick={() => { if (!busy) settle() }}
            >
              {t('cancel')}
            </Button>
          </div>
        )}
    >
      {stage === 'confirm'
        ? (
          <>
            {/* `role="status"` (polite), not `role="alert"`: the error line below is also a
              * live region, and with both assertive a screen reader announces them over each
              * other. The error is the urgent one, so it keeps the assertive channel and this
              * static warning — which mounts with the stage rather than in response to a
              * failure — uses the polite one. */}
            <div className={browserCss.baseMissingConfirm} role="status">
              <IconWarningOutlineRegular size={18} className={browserCss.baseMissingConfirmIcon} />
              <p>{t('baseMissing.confirmBody')}</p>
            </div>
            {/* The path again, because the confirmation is precisely about **which** directory is
              * about to be created — the one thing the user must be able to check here. Shared
              * with the report stage through `pathNotice`, so the two cannot disagree. */}
            {pathNotice}
          </>
        )
        : (
          <>
            <p className={browserCss.baseMissingBody}>{t('baseMissing.body')}</p>
            {pathNotice}
          </>
        )}
      {error !== null && <div className={browserCss.renameError} role="alert">{error}</div>}
    </Modal>
  )
}
