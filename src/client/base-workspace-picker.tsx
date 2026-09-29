/**
 * The "choose an existing workspace" dialog, opened from the settings card's
 * 「更换…」.
 *
 * ## Why a dialog rather than a dropdown
 *
 * Two Workspaces may share a display title — the registry allows it, and the official
 * picker lives with that by showing titles alone. This surface cannot: it decides where
 * **every** New Session lands, so a wrong pick is expensive, and two rows reading
 * "重要" would be indistinguishable. A dialog has the width for a second line, so each
 * row carries its **path** as a subtitle. That is the whole reason for the shape.
 *
 * The role vocabulary follows the shipped single-select lists (`role="listbox"` with
 * `role="option"` and `aria-selected`, as `ui-commands` / `ui-input-trigger` /
 * `ui-schedule` use) rather than `menuitem`, which is only valid inside a menu.
 *
 * ## Why selection is staged
 *
 * A row click only moves the highlight; the footer's 确认 writes. So a mis-click costs
 * nothing, and the user can see what they are about to commit. The actions are two, so
 * they take the shared `Modal` footer's row rather than the stacked layout the
 * three-action missing-workspace dialog needs (three equal row actions leave about
 * 77px each; two do not).
 */
import { useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SETTINGS_NS } from './settings-locales.ts'
import css from './settings-card.module.css'

/** Props of the base-workspace picker. */
export interface BaseWorkspacePickerProps {
  /** Every registered Workspace, in registry order; empty renders the empty state. */
  workspaces: readonly WorkspaceView[]
  /**
   * The `path` the current setting names, preselected so the dialog opens on the
   * current state and 确认 is immediately usable. Absent when nothing is chosen yet.
   */
  selectedPath: string | undefined
  /** Commit the chosen path. Never called without one. */
  onConfirm: (workspace: WorkspaceView) => void
  /** Dismiss without writing anything. */
  onCancel: () => void
  t: PropsLocale<typeof SETTINGS_NS>['t']
}

/**
 * Render the workspace chooser.
 * @param props - the registry rows, the current choice, the two outcomes, and the locale seat.
 * @returns the dialog.
 */
export function BaseWorkspacePicker({
  workspaces, selectedPath, onConfirm, onCancel, t,
}: BaseWorkspacePickerProps) {
  // Staged locally: the card's setting is untouched until 确认.
  const [staged, setStaged] = useState<string | null>(selectedPath ?? null)
  const listRef = useRef<HTMLDivElement>(null)

  const stagedIndex = workspaces.findIndex(item => item.path === staged)
  // The row that carries the list's single tab stop. A staged path that is **not** in
  // the list (the setting names a Workspace since deleted) matches no row, so without
  // this fallback every row would be `tabIndex={-1}` and the list unreachable.
  const tabStopIndex = stagedIndex >= 0 ? stagedIndex : 0

  /**
   * Move the highlight with the arrow keys / Home / End.
   * @param delta - how many rows to move; clamped to the list.
   */
  const move = (delta: number): void => {
    if (workspaces.length === 0) return
    const next = stagedIndex < 0
      ? (delta > 0 ? 0 : workspaces.length - 1)
      : Math.min(workspaces.length - 1, Math.max(0, stagedIndex + delta))
    const row = workspaces[next]
    if (row === undefined) return
    setStaged(row.path)
    listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[next]?.focus()
  }

  const stagedWorkspace = workspaces.find(item => item.path === staged) ?? null

  return (
    <Modal
      open
      onClose={onCancel}
      closeLabel={t('close')}
      title={t('basePickerTitle')}
      footer={(
        <>
          <Button variant="outline" onClick={onCancel}>{t('cancel')}</Button>
          <Button
            variant="primary"
            // Nothing staged means nothing to write; a live button here would either
            // write the previous choice silently or do nothing at all.
            disabled={stagedWorkspace === null}
            onClick={() => { if (stagedWorkspace !== null) onConfirm(stagedWorkspace) }}
          >
            {t('confirm')}
          </Button>
        </>
      )}
    >
      {workspaces.length === 0 ? (
        <p className={css.pickerEmpty} role="note">{t('basePickerEmpty')}</p>
      ) : (
        <div
          ref={listRef}
          role="listbox"
          aria-label={t('basePickerAria')}
          className={css.pickerList}
          onKeyDown={(event) => {
            switch (event.key) {
              case 'ArrowDown': event.preventDefault(); move(1); break
              case 'ArrowUp': event.preventDefault(); move(-1); break
              case 'Home': event.preventDefault(); move(-workspaces.length); break
              case 'End': event.preventDefault(); move(workspaces.length); break
              case 'Enter':
              case ' ':
                event.preventDefault()
                if (stagedWorkspace !== null) onConfirm(stagedWorkspace)
                break
              default: break
            }
          }}
        >
          {workspaces.map((item, index) => {
            const active = item.path === staged
            return (
              <div
                key={item.workspaceId}
                role="option"
                aria-selected={active}
                tabIndex={index === tabStopIndex ? 0 : -1}
                className={active ? `${css.pickerRow} ${css.pickerRowActive}` : css.pickerRow}
                onClick={() => { setStaged(item.path) }}
              >
                <span className={css.pickerName}>
                  {workspaceDisplayTitle(item.title, t('baseDefaultName'))}
                </span>
                {/* The subtitle is the point of using a dialog: it is what tells two
                  * same-titled Workspaces apart. */}
                <span className={css.pickerPath}>{item.path}</span>
              </div>
            )
          })}
        </div>
      )}
    </Modal>
  )
}
