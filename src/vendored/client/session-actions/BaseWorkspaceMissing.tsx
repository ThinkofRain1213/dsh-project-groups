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
 * ## Why the two repairs are optional
 *
 * They arrive in later steps — `rebuildBaseWorkspace` with the Host-side directory
 * creation, `chooseBaseWorkspace` with the settings picker. A disabled button that
 * explains itself is honest; a button that appears to work and does nothing is the bug
 * this whole dialog exists to remove.
 */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BaseWorkspaceDialogProps, BaseWorkspaceMissingRequest } from '../contract/slots.ts'
import browserCss from '../rows/WorkspaceBrowser.module.css'

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

  return (
    <Modal
      open
      onClose={() => { if (!busy) settle() }}
      closeLabel={t('close')}
      title={t('baseMissing.title')}
      footer={(
        <div className={browserCss.baseMissingActions}>
          <Button
            variant="primary"
            disabled={busy || rebuild === undefined}
            onClick={() => { if (rebuild !== undefined) run(rebuild) }}
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
      <p className={browserCss.baseMissingBody}>{t('baseMissing.body')}</p>
      <p className={browserCss.baseMissingPath} role="note">
        {request.path === null
          ? t('baseMissing.pathUnknown')
          : t('baseMissing.path', { path: request.path })}
      </p>
      {error !== null && <div className={browserCss.renameError} role="alert">{error}</div>}
    </Modal>
  )
}
