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

  // `Modal` focuses `data-modal-autofocus` in an effect keyed on `[dialog, open]`, so a stage switch
  // does not re-run it.
  //
  // Measured, because the obvious reasoning is wrong: this is **not** currently load-bearing. Both
  // stages render `<div><Button/><Button/>…</div>`, so React reconciles by position and the first
  // button is the *same DOM element* across the switch — marked it in one stage and found the mark
  // on the other, still focused — and the browser keeps focus on an element that was never replaced.
  // Removing this effect does not fail the probe today.
  //
  // It stays as insurance against exactly that fragile structure: reorder the two stages' footers,
  // wrap one in a fragment, or give the primary action a different position, and the reuse stops and
  // focus silently falls to nothing. The cost is one effect that is a no-op in the current layout.
  useEffect(() => {
    if (stage === 'confirm') confirmRef.current?.focus()
  }, [stage])

  const run = (action: () => Promise<void>): void => {
    setBusy(true)
    setError(null)
    action().then(() => {
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
                choose?.()
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
            <div className={browserCss.baseMissingConfirm} role="alert">
              <IconWarningOutlineRegular size={18} className={browserCss.baseMissingConfirmIcon} />
              <p>{t('baseMissing.confirmBody')}</p>
            </div>
            {/* The path again, because the confirmation is precisely about **which** directory is
              * about to be created — the one thing the user must be able to check here. */}
            <p className={browserCss.baseMissingPath} role="note">
              {request.path === null
                ? t('baseMissing.pathUnknown')
                : t('baseMissing.path', { path: request.path })}
            </p>
          </>
        )
        : (
          <>
            <p className={browserCss.baseMissingBody}>{t('baseMissing.body')}</p>
            <p className={browserCss.baseMissingPath} role="note">
              {request.path === null
                ? t('baseMissing.pathUnknown')
                : t('baseMissing.path', { path: request.path })}
            </p>
          </>
        )}
      {error !== null && <div className={browserCss.renameError} role="alert">{error}</div>}
    </Modal>
  )
}
