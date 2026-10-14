/** React-commit-driven movement and entry/exit fades for the sidebar's keyed rows. */
import { Component, createRef, type ReactNode } from 'react'
import css from './AnimatedRows.module.css'

const ROW_FADE_MS = 100
const ROW_GLIDE_MS = 200

interface AnimatedRowsProps {
  children: ReactNode
  className: string
  label: string
  /** Unique DOM-order keys matching the rendered data-row-key attributes. */
  rowKeys: readonly string[]
  ready: boolean
  /** Changes that replace the view or reveal hidden rows settle immediately. */
  resetKey: string
  /**
   * Keys that are arriving because a New Session flow just landed on them.
   *
   * A row whose key was absent from the previous commit fades in on its own — that is what
   * `previousRow === undefined` below means — so this covers the other half of the same gesture: a
   * New Session that **reused an existing blank Session** keeps its key, and without this the row
   * would glide from wherever that Session sat before (another project, or Ungrouped) to its new
   * home instead of arriving.
   *
   * Only a New Session belongs here. Re-filing an existing Session — a drag, a project being
   * deleted — is the row moving, and a move is a glide.
   */
  enteringKeys?: readonly string[] | undefined
  /**
   * Called from the commit that drew {@link enteringKeys}, so the owner drops them.
   *
   * Without dropping them the array would describe every later commit too, and the row would fade
   * in again on each scroll, expansion, or unrelated re-render. Reported rather than timed, because
   * only this component knows whether a commit drew anything: `getSnapshotBeforeUpdate` returns
   * `null` when it is not armed yet, when the motion preference is reduced, on a `resetKey` change,
   * and when the list is not ready — and in each of those the keys must still be released, or they
   * would be drawn by a later commit that has nothing to do with the arrival.
   */
  onEnteringKeysDrawn?: (() => void) | undefined
}

interface RowPosition {
  element: HTMLElement
  rect: DOMRect
  opacity: number
}

interface RowSnapshot {
  positions: Map<string, RowPosition>
  removed: Map<string, RowPosition>
}

function sameRows(previous: AnimatedRowsProps, next: AnimatedRowsProps): boolean {
  return previous.rowKeys.length === next.rowKeys.length
    && previous.rowKeys.every((key, index) => key === next.rowKeys[index])
}

function intersects(row: DOMRect, viewport: DOMRect): boolean {
  return row.bottom > viewport.top && row.top < viewport.bottom
    && row.right > viewport.left && row.left < viewport.right
}

/**
 * Animates keyed sidebar rows only when their rendered membership or order changes.
 * Motion starts after the first pointer or keyboard input inside the mounted list.
 * The parent supplies a positioned container for the inert exit overlay.
 */
export class AnimatedRows extends Component<AnimatedRowsProps> {
  private armed = false
  private readonly list = createRef<HTMLDivElement>()
  private readonly overlay = createRef<HTMLDivElement>()
  private readonly movements = new Map<HTMLElement, Animation>()
  private readonly exits = new Map<string, { element: HTMLElement; animation: Animation }>()
  /** Retained so the media query is parsed once; see {@link reducedMotion}. */
  private motionQuery: MediaQueryList | undefined

  override getSnapshotBeforeUpdate(previous: AnimatedRowsProps): RowSnapshot | null {
    const list = this.list.current
    // A pending `enteringKeys` must not be short-circuited by `sameRows`.
    //
    // The documented `enteringKeys` case — a New Session that **reused** an existing blank
    // Session — keeps the row set identical on purpose, since the key is the Session alone.
    // Testing `sameRows` on its own therefore returned `null` for exactly that case, and the
    // `componentDidUpdate` null branch drops the keys without ever drawing the entry fade:
    // the arrival only animated when the row also changed position. `onEnteringKeysDrawn`'s
    // doc lists the null reasons (not armed, reduced motion, resetKey, not ready) and omits
    // `sameRows`, which is the sign this was overlooked rather than intended.
    const entering = this.props.enteringKeys ?? []
    const nothingToDraw = sameRows(previous, this.props) && entering.length === 0
    if (!this.armed || nothingToDraw || previous.resetKey !== this.props.resetKey
      || !previous.ready || !this.props.ready || list === null
      || typeof list.animate !== 'function'
      || this.reducedMotion()) return null

    const viewport = list.getBoundingClientRect()
    const positions = this.readPositions(true)
    const nextKeys = new Set(this.props.rowKeys)
    const removed = new Map<string, RowPosition>()
    for (const [key, row] of positions) {
      if (nextKeys.has(key) || !intersects(row.rect, viewport)) continue
      const clone = row.element.cloneNode(true) as HTMLElement
      clone.removeAttribute('data-row-key')
      clone.inert = true
      clone.style.setProperty(
        '--dsh-workspace-indent', getComputedStyle(row.element).getPropertyValue('--dsh-workspace-indent'),
      )
      removed.set(key, { ...row, element: clone })
    }
    return { positions, removed }
  }

  override componentDidUpdate(previous: AnimatedRowsProps, _state: unknown, snapshot: RowSnapshot | null): void {
    const entering = this.props.enteringKeys ?? []
    const release = (): void => {
      if (entering.length > 0) this.props.onEnteringKeysDrawn?.()
    }
    if (snapshot === null) {
      if (!sameRows(previous, this.props) || previous.resetKey !== this.props.resetKey
        || previous.ready !== this.props.ready) this.clear()
      // Released even though nothing animated: this commit cannot draw an entry (not armed yet,
      // reduced motion, a reset, or no Web Animations), so holding the keys would make a later,
      // unrelated commit draw them instead.
      release()
      return
    }

    this.cancelMovements()
    // Guarded rather than asserted. `getSnapshotBeforeUpdate` already treats the list ref as
    // possibly null, so casting here was inconsistent with the rest of the component: a
    // `Cannot read properties of null` during commit is a much worse failure than skipping an
    // animation. The snapshot proves the list existed at the pre-update moment, not that it
    // still does.
    const list = this.list.current
    const overlay = this.overlay.current
    if (list === null || overlay === null) {
      release()
      return
    }
    const viewport = list.getBoundingClientRect()
    const origin = overlay.getBoundingClientRect()
    const positions = this.readPositions()
    const arriving = new Set(entering)

    for (const [key, row] of positions) {
      this.removeExit(key)
      const previousRow = snapshot.positions.get(key)
      if (!intersects(row.rect, viewport)
        && (previousRow === undefined || !intersects(previousRow.rect, viewport))) continue
      // Two ways to be an entry. A key that was not here last commit is new by construction; a key
      // the caller listed as arriving is a New Session that reused a blank Session already in the
      // tree, which the key cannot show because the key is now the Session alone.
      if (previousRow === undefined || arriving.has(key)) {
        this.move(row.element, [{ opacity: 0 }, { opacity: 1 }], ROW_FADE_MS)
        continue
      }
      const dx = previousRow.rect.left - row.rect.left
      const dy = previousRow.rect.top - row.rect.top
      if (dx === 0 && dy === 0 && previousRow.opacity === 1) continue
      this.move(row.element, [
        { transform: `translate(${String(dx)}px, ${String(dy)}px)`, opacity: previousRow.opacity },
        { transform: 'translate(0, 0)', opacity: 1 },
      ], ROW_GLIDE_MS)
    }

    for (const [key, row] of snapshot.removed) {
      const { element } = row
      this.removeExit(key)
      Object.assign(element.style, {
        position: 'absolute', margin: '0', transform: 'none', boxSizing: 'border-box',
        left: `${String(row.rect.left - origin.left)}px`,
        top: `${String(row.rect.top - origin.top)}px`,
        width: `${String(row.rect.width)}px`, height: `${String(row.rect.height)}px`,
      })
      overlay.append(element)
      const animation = element.animate([{ opacity: row.opacity }, { opacity: 0 }], {
        duration: ROW_FADE_MS, easing: 'ease-out', fill: 'forwards',
      })
      this.exits.set(key, { element, animation })
      animation.onfinish = () => { this.removeExit(key) }
    }

    release()
  }

  override componentWillUnmount(): void {
    this.clear()
  }

  /**
   * Read every keyed row's element and viewport rect.
   *
   * ## Why the key is validated rather than asserted
   *
   * `[data-row-key]` proves the attribute is **present**, not that its value is usable. The
   * previous `element.dataset.rowKey as string` asserted a non-empty key that nothing checked:
   * an empty attribute yielded `''`, and duplicate keys silently collapsed into one map entry —
   * both corrupt the position diff and the computed `removed` set, producing wrong motion with
   * no error. A row without a usable key is skipped, which is the honest reading: it cannot be
   * tracked across commits, so it must not be treated as if it were.
   *
   * ## Why opacity is opt-in
   *
   * `getComputedStyle` forces a style recalculation, and the post-update pass never reads the
   * value it produces: at that point `cancelMovements()` has already run, so `movements.has()`
   * is always false, and the pre-update opacity it would compare against is carried in the
   * snapshot instead. Reading it there was a forced layout per row for a value nothing used.
   * @param withOpacity - read computed opacity for rows mid-animation (forces style recalc).
   * @returns one entry per keyed row, keyed by its `data-row-key`.
   */
  private readPositions(withOpacity = false): Map<string, RowPosition> {
    const positions = new Map<string, RowPosition>()
    const list = this.list.current
    if (list === null) return positions
    const rows = list.querySelectorAll<HTMLElement>('[data-row-key]')
    for (const element of rows) {
      const key = element.dataset.rowKey
      if (key === undefined || key === '') continue
      positions.set(key, {
        element,
        rect: element.getBoundingClientRect(),
        opacity: withOpacity && this.movements.has(element)
          ? Number(getComputedStyle(element).opacity)
          : 1,
      })
    }
    return positions
  }

  /**
   * Whether the user has asked for reduced motion.
   *
   * The `MediaQueryList` is created once and only its `matches` is re-read: constructing a new
   * one per `getSnapshotBeforeUpdate` re-parses the query on every animated commit, while
   * caching the boolean would go stale if the OS setting changed mid-session. Reading
   * `matches` off a retained list is what gives both.
   */
  private reducedMotion(): boolean {
    this.motionQuery ??= window.matchMedia('(prefers-reduced-motion: reduce)')
    return this.motionQuery.matches
  }

  private move(element: HTMLElement, keyframes: Keyframe[], duration: number): void {
    const animation = element.animate(keyframes, { duration, easing: 'ease-out' })
    this.movements.set(element, animation)
    animation.onfinish = () => { this.movements.delete(element); animation.cancel() }
  }

  private cancelMovements(): void {
    for (const animation of this.movements.values()) {
      animation.onfinish = null
      animation.cancel()
    }
    this.movements.clear()
  }

  private removeExit(key: string): void {
    const exit = this.exits.get(key)
    if (exit === undefined) return
    exit.animation.onfinish = null
    exit.animation.cancel()
    exit.element.remove()
    this.exits.delete(key)
  }

  private clear(): void {
    this.cancelMovements()
    for (const key of this.exits.keys()) this.removeExit(key)
  }

  override render(): ReactNode {
    return <>
      <div
        ref={this.list}
        className={this.props.className}
        role="tree"
        aria-label={this.props.label}
        onPointerDownCapture={() => { this.armed = true }}
        onKeyDownCapture={() => { this.armed = true }}
      >
        {this.props.children}
      </div>
      <div ref={this.overlay} className={css.exits} aria-hidden="true" />
    </>
  }
}
