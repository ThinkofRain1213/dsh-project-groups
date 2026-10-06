/**
 * The "choose a document spec" dialog, opened from the settings card's
 * 「选择或上传…」 and from a project's own spec row.
 *
 * ## Why it is not a `Modal` inside a `Modal`
 *
 * Deleting a spec needs a confirmation, and the obvious shape is a second
 * `Modal` on top of this one. It is not: the delete confirmation replaces this
 * dialog's content instead. Both are portaled into `document.body`, so nesting
 * them would put two focus traps and two Escape handlers on the same stack, and
 * `useModalLayer` resolves Escape for the topmost layer — the inner dialog would
 * have to own every key event to avoid closing the outer one behind it. One
 * dialog with two states has neither problem.
 *
 * ## The two exits
 *
 * 确认 commits whatever is staged, including "nothing" — which is a real choice,
 * stored as `'none'` by the caller. 取消 writes nothing at all: no setting, and
 * no deletion, since deletions commit on their own confirmation. That is the
 * whole meaning of the button, and it is why the frame has no other dialog on
 * top of it.
 *
 * ## Why "nothing selected" is an inline notice, not a dialog
 *
 * It used to raise a second `Modal` from BOTH exits, which had two faults. The
 * obvious one was that 取消 there closed the whole stack rather than one layer.
 * The structural one is that a nested modal shares this dialog's Escape and
 * focus handling (see above), so the notice could not be dismissed without
 * tearing down its parent. An amber line inside the body states the same outcome
 * — confirming now falls back to requiring no format — and blocks nothing.
 *
 * ## Why the upload lives in the footer
 *
 * `Modal` renders its header as a fixed title + close pair with no third seat,
 * so a header-mounted upload control would require `headless: true` and a
 * hand-built header — copying official chrome that this plugin would then have
 * to keep in step. The footer is a plain flex row, so putting the upload button
 * first with `margin-right: auto` pins it left and leaves 取消/确认 on the right
 * with no component change at all.
 *
 * ## Why the file is read, never addressed by path
 *
 * The picked `File` is read as text and sent as content. Nothing here asks for
 * its host path, so this works identically in the desktop shell and in a browser
 * over the network — where `window.__DSH_HOST_PATHS__` does not exist and a path
 * could not be obtained anyway.
 */
import { useRef, useState } from 'react'
import { Button, IconTrashOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SETTINGS_NS } from './settings-locales.ts'
import css from './settings-card.module.css'

/** Props of the spec chooser. */
export interface SpecPickerProps {
  /** Every uploaded spec, sorted. */
  specs: readonly string[]
  /** The currently selected file name, preselected when it still exists. */
  selected: string | undefined
  /** Store one uploaded spec; resolves false when the name is taken. */
  onUpload: (name: string, content: string) => Promise<boolean>
  /** Delete one uploaded spec; resolves false when nothing was removed. */
  onDelete: (name: string) => Promise<boolean>
  /** The titles of projects that would fall back if the named spec were deleted. */
  onUsedBy: (name: string) => Promise<readonly string[]>
  /**
   * Commit the chosen spec, or `undefined` for "no spec at all".
   *
   * `undefined` is not an error state: it is the choice the 无 card makes, and it
   * arrives here when the dialog is confirmed with nothing selected. The caller
   * stores `'none'` for it.
   */
  onConfirm: (name: string | undefined) => void
  /** Dismiss without writing anything. */
  onCancel: () => void
  t: PropsLocale<typeof SETTINGS_NS>['t']
}

/**
 * Render the spec chooser.
 * @param props - the uploaded list, the current choice, the four actions, and the locale seat.
 * @returns the dialog.
 */
export function SpecPicker({
  specs, selected, onUpload, onDelete, onUsedBy, onConfirm, onCancel, t,
}: SpecPickerProps) {
  // Staged locally: the setting is untouched until 确认, matching the base-workspace
  // chooser, so a mis-click costs nothing.
  const [staged, setStaged] = useState<string | undefined>(selected)
  /** The spec awaiting delete confirmation, if any. */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  /** The projects that would fall back, read before the confirmation shows. */
  const [deleteUsedBy, setDeleteUsedBy] = useState<readonly string[]>([])
  /** A rejection message shown beside the upload button. */
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  /**
   * Read the picked file and upload it.
   *
   * The input is cleared before the await so picking the same file twice fires
   * `change` again — otherwise the second attempt is silently ignored.
   * @param event - the input's change event.
   */
  const upload = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    setError(null)
    // The browser strips any directory from `name`, which is exactly what the
    // Host expects: a bare file name, joined onto its own directory.
    if (!file.name.toLowerCase().endsWith('.md')) {
      setError(t('specNotMarkdown'))
      return
    }
    setBusy(true)
    try {
      const written = await onUpload(file.name, await file.text())
      if (!written) {
        setError(t('specExists'))
        return
      }
      setStaged(file.name)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Ask to delete one spec, reading its dependants first.
   * @param name - the spec to remove.
   */
  const askDelete = async (name: string): Promise<void> => {
    setError(null)
    setPendingDelete(name)
    setDeleteUsedBy(await onUsedBy(name))
  }

  // The delete confirmation. One dialog with two states rather than a nested
  // `Modal`, so there is no second focus trap or Escape handler (see the module doc).
  if (pendingDelete !== null) {
    const count = deleteUsedBy.length
    return (
      <Modal
        open
        onClose={() => { setPendingDelete(null) }}
        closeLabel={t('close')}
        title={t('specDeleteTitle')}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setPendingDelete(null) }}>{t('cancel')}</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                void (async () => {
                  setBusy(true)
                  try {
                    await onDelete(pendingDelete)
                    if (staged === pendingDelete) setStaged(undefined)
                    setPendingDelete(null)
                  } finally {
                    setBusy(false)
                  }
                })()
              }}
            >
              {t('specDeleteConfirm')}
            </Button>
          </>
        )}
      >
        <p className={css.pickerEmpty}>{t('specDeleteDesc', { name: pendingDelete })}</p>
        {/* The dependants are named before the file is gone, which is the only
          * moment they can be read — afterwards the projects have already fallen
          * back and there is nothing left to warn about. */}
        {count > 0 && (
          <p className={css.pickerEmpty}>
            {count === 1 ? t('specDeleteUsedOne') : t('specDeleteUsedMany', { n: String(count) })}
          </p>
        )}
      </Modal>
    )
  }

  /**
   * Nothing is chosen — the list is empty, or it has rows and none is picked.
   *
   * One state, not two: in both cases the user is confirming "no spec", and both
   * get the same notice and the same outcome. It drives the amber line only; it
   * does NOT block 确认 or trap 取消, which is what the removed second dialog did.
   */
  const noneSelected = staged === undefined

  return (
    <Modal
      open
      // 取消 now means exactly "close without writing", so this is a bare cancel.
      onClose={onCancel}
      closeLabel={t('close')}
      title={t('specPickerTitle')}
      footer={(
        <>
          {/* First in the footer plus `margin-right: auto` pins it left; the
            * other two stay right-aligned. See the module doc. */}
          <Button
            variant="outline"
            className={css.footerLeading}
            disabled={busy}
            onClick={() => { fileInput.current?.click() }}
          >
            {t('specUpload')}
          </Button>
          {/* 取消 writes nothing, always: no setting, and no deletion of its own. */}
          <Button variant="outline" onClick={onCancel}>{t('cancel')}</Button>
          <Button
            variant="primary"
            // Never disabled. With nothing selected this commits "no spec", which
            // is a real choice rather than a dead end — the notice above has just
            // said so, and the caller stores 'none' for it.
            onClick={() => { onConfirm(staged) }}
          >
            {t('confirm')}
          </Button>
        </>
      )}
    >
      <input
        ref={fileInput}
        type="file"
        accept=".md,text/markdown"
        hidden
        onChange={(event) => { void upload(event) }}
      />
      {error !== null && <p className={css.specError} role="alert">{error}</p>}
      {/* The fallback notice. An inline line rather than a second dialog: the
        * outcome needs stating once, and a nested modal on the same Escape/focus
        * stack is what made 取消 tear down the whole dialog instead of one layer.
        *
        * `role="status"` so it is announced when it appears or clears; it is
        * informational, not an error, hence amber rather than red. */}
      {noneSelected && (
        <p className={css.specNotice} role="status">
          {specs.length === 0 ? t('specNoticeEmpty') : t('specNoticeNone')}
        </p>
      )}
      {specs.length === 0 ? null : (
        <div role="listbox" aria-label={t('specPickerAria')} className={css.pickerList}>
          {specs.map(name => {
            const active = name === staged
            return (
              <div
                key={name}
                role="option"
                aria-selected={active}
                className={active ? `${css.specRow} ${css.pickerRowActive}` : css.specRow}
                onClick={() => { setStaged(name) }}
              >
                <span className={css.pickerName}>{name}</span>
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={`${t('specDelete')}: ${name}`}
                  disabled={busy}
                  onClick={(event) => {
                    // The row's own click would otherwise stage the spec on the
                    // way to deleting it.
                    event.stopPropagation()
                    void askDelete(name)
                  }}
                >
                  <IconTrashOutlineRegular size={14} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </Modal>
  )
}
