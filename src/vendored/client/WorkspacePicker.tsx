/**
 * Workspace pick/add flow. WorkspacePickFlow is the reusable core (menu +
 * path error dialog) consumed directly by WorkspaceBrowser (same package) and
 * wrapped by WorkspacePicker for the conversation empty-state slot
 * registration. Directory picking itself lives in the composed flow package's
 * slot occupant (see the contract module doc): this core only opens the flow,
 * adopts the picked path, and owns the error surface. Adding a workspace has
 * exactly one route — pick a host directory, new or existing — because the
 * occupant's own create-folder affordance already covers creating one.
 */
import type { ReactNode, RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button, IconFolderCloseRegular, IconPlusOutlineRegular, Menu, Modal, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryFlowOwnerProps, WorkspacePickerProps } from './contract/slots.ts'
import css from './WorkspacePicker.module.css'

const ADD_WORKSPACE = '::add-workspace'

/**
 * The menu footer's loading row.
 *
 * Only ever compared against itself — it is never dispatched by `handleSelect`, because the
 * row is `disabled` — so unlike {@link ADD_WORKSPACE} it cannot collide with a Workspace id
 * in any way that matters.
 */
const PENDING_STATUS_ID = '::workspace-picker-pending'

/** Core flow props: the owner supplies popover control and pick semantics. */
export interface WorkspacePickFlowProps {
  /** The standard locale seat, forwarded by whichever slot entry hosts the flow. */
  t: WorkspacePickerProps['t']
  /** Popover visibility (anchor button toggle state, owner-local). */
  open: boolean
  /** The anchor button element — the popover's placement anchor. */
  anchorRef?: RefObject<HTMLElement | null> | undefined
  /** Selector hook over the workspace list (framework standard hook). */
  useWorkspaces: <S>(selector: (state: WorkspaceSnapshot) => S) => S
  /** Adopt a picked host directory as a real Workspace. */
  createWorkspace: (input: { path: string }) => Promise<WorkspaceView>
  /** Bound occupancy selector hook for this surface's directory-flow hole (empty leaves the surface with no add action). */
  useDirectoryFlow: SnapshotSelectorHook<boolean>
  /** Render this surface's directory-flow hole with the owner conversation (the entry's narrowed renderSlot). */
  renderDirectoryFlow: (owner: DirectoryFlowOwnerProps) => ReactNode
  /** A real Workspace was picked or created. */
  onPick: (workspaceId: WorkspaceId) => void
  /** Close the popover (outside click / Escape / post-pick). */
  onClose: () => void
  /** Report the picking interaction and adoption occupancy. */
  onBusyChange?: (busy: boolean) => void
  /** Only offer the add action, hide existing workspaces. */
  addOnly?: boolean
  /** Menu opening direction relative to the anchor. */
  side?: 'bottom' | 'top' | 'right'
  /** Currently active workspace (trailing check in the picker list). */
  selectedId?: WorkspaceId | undefined
}

/**
 * Render the pick menu plus the adoption error dialog.
 * @param props - owner-controlled flow props.
 * @returns menu + dialog elements.
 */
export function WorkspacePickFlow({
  t,
  open,
  anchorRef,
  useWorkspaces,
  createWorkspace,
  useDirectoryFlow,
  renderDirectoryFlow,
  onPick,
  onClose,
  addOnly = false,
  onBusyChange,
  side = 'bottom',
  selectedId,
}: WorkspacePickFlowProps) {
  const workspaceSnapshot = useWorkspaces(state => state)
  const workspaces = workspaceSnapshot.items
  const getAnchorRect = useCallback(
    () => anchorRef?.current?.getBoundingClientRect() ?? null,
    [anchorRef],
  )
  const [errorOpen, setErrorOpen] = useState(false)
  const [modalError, setModalError] = useState<string | null>(null)
  const [flowOpen, setFlowOpen] = useState(false)
  const [pickingFolder, setPickingFolder] = useState(false)
  // One picking interaction at a time: while the flow is open (native chooser
  // pending, browse dialog up) or its pick is being adopted, every other
  // menu action stays disabled — a late outcome must not race a concurrent
  // selection or adoption.
  const flowBusy = flowOpen || pickingFolder
  // The callback is held in a ref so the effect below depends only on `flowBusy`.
  //
  // Consumers pass inline callbacks, so `onBusyChange` is a new function on every render of
  // the owner; with it in the dependency list the effect re-fired on every one of those
  // renders, reporting a value that had not changed. A ref keeps the latest callback without
  // making its identity an input to the effect.
  const onBusyChangeRef = useRef(onBusyChange)
  onBusyChangeRef.current = onBusyChange
  useEffect(() => {
    onBusyChangeRef.current?.(flowBusy)
  }, [flowBusy])
  // Reset on unmount, in its own effect with no dependencies.
  //
  // Not as the return value of the effect above: a cleanup there runs before *every*
  // re-run, so a change false -> true would report `false` and then `true`, briefly
  // un-gating the owner for a value that was never current. With `[]` this cleanup runs
  // once, at unmount.
  //
  // Without it, a component that unmounted while `flowBusy` was true left the owner's flag
  // stuck true for the rest of the session — the sidebar's add-workspace shortcut stays
  // disabled with nothing on screen to explain why.
  useEffect(() => () => { onBusyChangeRef.current?.(false) }, [])

  // The occupied hole gates the picking affordance: with no composed flow the
  // entry simply is not there (the seam's documented no-flow default). The
  // framework-bound hook keeps occupancy live: flow plugins activate (and
  // HMR-reload) independently of this menu's renders.
  const flowAvailable = useDirectoryFlow(occupied => occupied)
  // An occupant that unloads mid-interaction leaves nobody to cancel: an
  // open flow over an empty hole withdraws so the menu actions come back.
  // flowOpen is a dependency because the flow can also OPEN over an already
  // empty hole (Choose again after the occupant unloaded with the error
  // dialog up) — that transition must snap back too, not just occupancy loss.
  useEffect(() => {
    if (flowOpen && !flowAvailable) setFlowOpen(false)
  }, [flowOpen, flowAvailable])
  const addEntries: MenuEntry[] = flowAvailable
    ? [{ id: ADD_WORKSPACE, label: t('menu.addWorkspace'), icon: <IconPlusOutlineRegular size={16} />, disabled: flowBusy }]
    : []
  // With workspaces listed, the add action pins below the scroll region
  // (divider + always visible); otherwise it IS the menu.
  const pinAdd = !addOnly && workspaces.length > 0
  const items: MenuEntry[] = pinAdd
    ? workspaces.map(workspace => ({
      id: workspace.workspaceId,
      label: workspaceDisplayTitle(workspace.title, t('workspace.defaultName')),
      icon: <IconFolderCloseRegular size={16} />,
      disabled: flowBusy,
    }))
    : addEntries
  // Nothing listed and nothing to add with (a composition that mounts this
  // package without any directory-picker): an empty popover would claim a
  // choice that does not exist, so the anchor gesture shows nothing at all.
  const menuIsEmpty = items.length === 0

  const closeModal = (): void => {
    setErrorOpen(false)
    setModalError(null)
  }

  /**
   * Adopt a picked directory; failures land in the folder-error dialog (Choose again reopens
   * the flow).
   *
   * `async`/`await` with one `try`/`catch` rather than a `.then`/`.catch` chain: the project's
   * async convention, and it keeps the success and failure transitions side by side instead of
   * in two callbacks.
   */
  const adoptDirectory = async (path: string): Promise<void> => {
    try {
      const workspace = await createWorkspace({ path })
      setFlowOpen(false)
      onPick(workspace.workspaceId)
    } catch (reason: unknown) {
      setModalError(reason instanceof Error ? reason.message : String(reason))
      setFlowOpen(false)
      setErrorOpen(true)
    }
  }

  const openDirectoryFlow = useCallback((): void => {
    onClose()
    setErrorOpen(false)
    setModalError(null)
    setFlowOpen(true)
  }, [onClose])

  // A menu exists to disambiguate between targets. With no workspaces listed
  // and the add action the only entry left, the anchor gesture IS that action:
  // a one-row popover would cost a click and offer nothing to choose between.
  // The owner's open request is consumed the same way selecting the entry
  // would consume it (close the popover, raise the flow). An empty list is
  // only final once the baseline lands — until then the menu stays up with its
  // loading status instead of jumping into a flow the arriving list would have
  // made unnecessary; the add-only surface lists nothing and never waits.
  const listSettled = addOnly || workspaceSnapshot.phase === 'ready'
  const addIsTheOnlyEntry = !pinAdd && listSettled && addEntries.length === 1
  // `flowBusy` gates this exactly as it disables the equivalent menu entry: a
  // pick still being adopted owns the surface until it settles.
  //
  // ## Why the request is marked consumed rather than inferred from `open`
  //
  // The original relied on an undocumented invariant: `openDirectoryFlow` calls the owner's
  // `onClose`, and this effect assumed that synchronously cleared `open`. It does today, but
  // nothing in this component's contract requires it — an owner that clears `open`
  // asynchronously, or not at all, would see the effect re-fire as soon as `flowBusy` returned
  // to false and reopen a flow the user had just cancelled: an open/cancel loop with no way
  // out of the popover.
  //
  // Tracking consumption locally makes one auto-open per `open` request, whatever the owner
  // does. The flag clears when `open` goes false, so the next request opens again.
  const autoFlowConsumed = useRef(false)
  useEffect(() => {
    if (!open) {
      autoFlowConsumed.current = false
      return
    }
    if (autoFlowConsumed.current) return
    if (addIsTheOnlyEntry && !flowBusy) {
      autoFlowConsumed.current = true
      openDirectoryFlow()
    }
  }, [open, addIsTheOnlyEntry, flowBusy, openDirectoryFlow])

  /** Owner side of the flow conversation: adopt keeps the flow open (busy) until the Host answers. */
  const flowOwner: DirectoryFlowOwnerProps = {
    open: flowOpen,
    busy: pickingFolder,
    onPicked: (path) => {
      // Guarded, not just gated in the UI. The menu-entry path is disabled by `flowBusy`,
      // but this callback is driven by the occupant, which is outside this component's
      // control — a duplicated or misbehaving signal would otherwise start a second
      // `createWorkspace` while the first adoption is still in flight, racing on `flowOpen`
      // and `modalError`. The `.finally` below still runs on a duplicate, so the guard is
      // what prevents the overlap rather than the state update.
      if (pickingFolder) return
      setPickingFolder(true)
      void adoptDirectory(path).finally(() => { setPickingFolder(false) })
    },
    onCancel: () => { setFlowOpen(false) },
    onError: (message) => {
      setFlowOpen(false)
      setModalError(message)
      setErrorOpen(true)
    },
  }

  /**
   * Dispatch one menu selection.
   *
   * ## Why the workspace list is consulted before the sentinel
   *
   * `id` arrives as a plain `string` from the menu, and the add entry is identified by the
   * `ADD_WORKSPACE` sentinel. The original checked the sentinel first and then cast the
   * remainder to `WorkspaceId`, which meant the brand was asserted rather than established —
   * and it made the sentinel a magic string that a real Workspace id must never equal: a
   * Workspace whose id *was* `'::add-workspace'` would have opened the add flow instead of
   * being selected.
   *
   * Looking the id up in `workspaces` first removes both problems. A genuine Workspace id is
   * matched whatever its spelling, and the value passed on is the one from the typed list
   * rather than a cast. The sentinel is then only reached when no Workspace claims the id,
   * so a collision is no longer possible.
   * @param id - the menu entry's id.
   */
  const handleSelect = (id: string): void => {
    const workspace = workspaces.find(item => item.workspaceId === id)
    if (workspace !== undefined) {
      onPick(workspace.workspaceId)
      return
    }
    if (id === ADD_WORKSPACE) openDirectoryFlow()
  }

  // The loading status belongs inside the menu, not beside it.
  //
  // It used to render as a *sibling* of `<Menu>`, which is `portal`ped: the popover is moved
  // into a portal container positioned against the anchor, while the status stayed in the
  // host's normal flow. Its only styles were `margin-top` / `font-size`, so with no anchor of
  // its own it landed wherever the component happened to sit in the tree rather than near the
  // popover it describes.
  //
  // Passed through the menu's `footer`, which is rendered inside the same portalled surface
  // and below the scrolling items area. Not appended to `items`: `menuIsEmpty` is derived from
  // `items.length`, and a status row there would make an otherwise-empty popover look
  // populated — the very thing the `menuIsEmpty` check exists to prevent.
  //
  // `role="status"` is kept on the label so the loading state is still announced; the row is
  // `disabled`, matching the fact that it reports rather than offers a choice.
  const menuPending = open && !addIsTheOnlyEntry && !menuIsEmpty && workspaceSnapshot.phase === 'pending'
  const menuFooter: readonly MenuEntry[] = [
    ...(pinAdd ? addEntries : []),
    ...(menuPending
      ? [{ id: PENDING_STATUS_ID, disabled: true, label: <span className={css.menuStatus} role="status">{t('picker.loading')}</span> }]
      : []),
  ]
  return (
    <>
      <Menu
        open={open && !addIsTheOnlyEntry && !menuIsEmpty}
        anchor={null}
        items={items}
        {...(menuFooter.length > 0 ? { footer: menuFooter } : {})}
        selectedId={selectedId}
        onSelect={handleSelect}
        onClose={onClose}
        side={side}
        portal
        getAnchorRect={getAnchorRect}
      />
      {renderDirectoryFlow(flowOwner)}
      <Modal
        open={errorOpen}
        onClose={closeModal}
        closeLabel={t('close')}
        title={t('folderError.title')}
        footer={(
          <>
            <Button variant="outline" className={css.modalAction} onClick={closeModal}>{t('cancel')}</Button>
            {/* Retrying needs an occupant to serve the flow; without one the
              * button would open a flow nobody can answer or cancel. */}
            <Button variant="primary" className={css.modalAction} disabled={!flowAvailable} onClick={openDirectoryFlow}>{t('folderError.retry')}</Button>
          </>
        )}
      >
        <div className={css.modalError} role="alert">{modalError}</div>
      </Modal>
    </>
  )
}

/**
 * The conversation empty-state registration: adapts the owner share to the
 * core flow (all state and semantics live in the flow / the owner).
 * @param props - empty-state slot props (owner share + injected creation callback).
 * @returns the flow element.
 */
export function WorkspacePicker({
  open,
  anchorRef,
  useWorkspaces,
  selectedId,
  onPick,
  onClose,
  createWorkspace,
  useDirectoryFlow,
  renderSlot,
  t,
}: WorkspacePickerProps) {
  return (
    <WorkspacePickFlow
      t={t}
      open={open}
      anchorRef={anchorRef}
      useWorkspaces={useWorkspaces}
      createWorkspace={createWorkspace}
      useDirectoryFlow={useDirectoryFlow}
      renderDirectoryFlow={owner => renderSlot('conversation.hero.workspace.directoryFlow', owner)}
      selectedId={selectedId}
      onPick={onPick}
      onClose={onClose}
    />
  )
}
