/**
 * What this plugin injects, shown on the plugin's own settings card.
 *
 * ## One group, not a panel
 *
 * This renders a single `.group` — the same shape the 文档规范 row uses — so its parts are spaced
 * by that group's own `gap` and it has no surface of its own. An earlier version was a bordered
 * panel containing a filled block of rows; that was rolled back, and this rebuild keeps the card's
 * existing vocabulary instead of inventing a second one.
 *
 * ## The main display cannot be collapsed
 *
 * It is the answer this panel exists to give; the diffs below are a reference for states the user
 * has not hit. A collapsed answer is not an answer, so the main block is always expanded and only
 * the diffs are disclosures.
 *
 * ## Why it survives the master switch being off
 *
 * The heading and the block both stay, and the block says that nothing is injected. Hiding the
 * panel instead would make the setting look inert rather than off — and the fact that it is off is
 * exactly what a reader who scrolled here wants confirmed.
 *
 * ## Why `<pre>`
 *
 * The block's line breaks and indentation are part of it: the drift prompt's options are nested by
 * indentation, and the option list is only readable as a list. A normal element would collapse the
 * runs of spaces and lose that structure.
 *
 * ## Why the open groups are a `Set`
 *
 * Groups come from `injectionDiffGroups`, whose length depends on the switches; keying openness by
 * group key means adding a segment later needs no change here.
 *
 * @module dsh-project-groups/src/client/injection-panel
 */
import { useId, useMemo, useState } from 'react'
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { InjectionLocale } from '../injection.ts'
import type { SETTINGS_NS } from './settings-locales.ts'
import { injectionDiffGroups, mainInjectionSample } from './injection-preview.ts'
import css from './settings-card.module.css'

/** Props: the two switches that gate the block, the locale, and the translate seat. */
export interface InjectionPanelProps {
  /** The `注入项目信息` switch; off means nothing is injected at all. */
  readonly injectInfo: boolean
  /** The `注入项目文档` switch; off means no document segment. */
  readonly injectDoc: boolean
  /** The active locale, which the previewed drift question follows. */
  readonly locale: InjectionLocale
  /** The card's translate seat. */
  readonly t: TranslateNS<typeof SETTINGS_NS>
}

/**
 * Render the injection preview.
 * @param props - the two switches, the locale, and the translate seat.
 * @returns the panel.
 */
export function InjectionPanel({ injectInfo, injectDoc, locale, t }: InjectionPanelProps) {
  // Memoized on their actual inputs. Both run the full injection renderer and split its output
  // into lines, and their only inputs are the two switches and the locale — so without this
  // every unrelated render re-ran the renderer, including every disclosure toggle, which is
  // exactly the state this panel changes most.
  //
  // The largest injection the switches currently allow, or `null` when there is none.
  const main = useMemo(() => mainInjectionSample(injectInfo, injectDoc), [injectInfo, injectDoc])
  const groups = useMemo(
    () => injectionDiffGroups(injectInfo, injectDoc, locale),
    [injectInfo, injectDoc, locale],
  )
  /** The expanded groups. Empty is every group collapsed, which is the default asked for. */
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set<string>())
  const toggle = (key: string): void => {
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  // Openness is **derived**, so a key can never outlive the group it names.
  //
  // The stored set is never reconciled on its own, which had two consequences: a segment
  // expanded and then switched off kept its key, so switching back on re-showed it already
  // expanded — contradicting the documented "all collapsed by default" — and stale keys
  // accumulated across switch changes. Intersecting with the current keys makes the effective
  // state always a subset of what is rendered, and keeps the store harmless.
  const groupKeys = useMemo(() => new Set(groups.map(group => group.key)), [groups])
  const isOpen = (key: string): boolean => open.has(key) && groupKeys.has(key)

  // `useId` rather than the group key alone: keys are derived from segment names, which are
  // stable but not guaranteed unique across two panels, and an id has to be unique in the
  // document. The key is appended so the id is stable per group across renders.
  const panelId = useId()
  const bodyId = (key: string): string => `${panelId}-${key}`

  // One place that renders the previewed block, used by the main sample and by every variant.
  // The two copies were identical, so a change to the block's tag or class had to be made
  // twice — and the diff body is the third place the same shape appears.
  // A plain render function rather than a nested component: a component declared in a render
  // body is a new type on every render, which remounts its subtree.
  const renderBlock = (text: string, key?: string) => (
    <pre key={key} className={css.injectionText}>{text}</pre>
  )
  /*
   * Two groups, separated by a rule, **each in its own `.section`**, and a fragment around the
   * whole so both sections stay the card's own children — which is what keeps the rules between
   * them the same 16 + 16 apart as the card's own rules. Wrapping both halves in one section
   * instead made this rule's sides 12 + 12, the one line on the card that read tighter.
   *
   * The card has no panel: each half is the same `.group` shape 文档规范 uses (a heading and what
   * it introduces). They used to be one group holding both halves, with a `.injectionSubTitle` label
   * opening each; the user split them instead, because the two halves answer different questions —
   * "what will be injected" versus "how does each state differ" — and one heading over both made the
   * second read as a sub-part of the first.
   *
   * With them split, the second half gets a real `.groupTitle` of its own, so the group-internal
   * 500-weight label has no job left and is gone: the card now uses 600 for headings and 400 for
   * everything else inside a group.
   */
  return (
    // Two card segments, one per half, so the seam rule between them sits
    // *between* sections rather than inside one. A single wrapping section put the
    // rule-between-halves and the card's own rules at different distances (12 + 12
    // against 16 + 16), which made the middle line of three visibly tighter than its
    // neighbours. The fragment generates no element, so both sections stay direct
    // children of the card's `.stack`.
    <>
      <div className={css.section}>
        <div className={css.group}>
          <div className={css.groupTitle}>{t('injectionTitle')}</div>
        {main === null
          ? <div className={css.injectionOff}>{t('injectionOff')}</div>
          : renderBlock(main)}
        {/*
         * Below the block, not between the heading and it: this sentence explains how
         * to read the brackets *inside* the block, so it can only be read after the
         * block exists. On other rows the note says what the setting is, which belongs
         * above its control.
         *
         * Shown only while there is a block: with the master switch off there is no frame and no
         * brackets, so the sentence would have nothing to refer to. The off-state line says the
         * one thing that is true then.
         */}
        {main !== null && <div className={css.desc}>{t('injectionNote')}</div>}
        </div>
      </div>

      {/*
       * Everything below the first group belongs together: the seam rule and the differences group
       * are the preview's second half, and the second half exists only when there are states to
       * compare. With the master switch off `injectionDiffGroups` returns nothing, so both go — a
       * rule with no group under it would be a line with nothing on either side of it, and an
       * empty group would be a heading over no rows.
       */}
      {groups.length > 0 && (
        <>
          {/*
           * The rule between the halves, and only there: it marks where "what is injected" ends and
           * "how the states differ" begins, which is the seam the user wanted visible.
           *
           * It sits between two sections, like the card's own rules, so the distance across it is
           * the same 16 + 16 those get. Inside one section it would have been 12 + 12 and read as
           * a tighter seam than the lines above and below it.
           */}
          <div className={css.rule} role="separator" />

          <div className={css.section}>
          <div className={css.group}>
            <div className={css.groupTitle}>{t('injectionDiffTitle')}</div>
            {/*
             * One row per segment, each a child of this group so the group's own `gap` spaces
             * them. The rows carry no padding of their own: a gap plus a 12px padding would read
             * as much wider than the gap every other sibling in the group gets.
             */}
            {groups.map(group => (
              <div key={group.key} className={css.injectionDiffRow}>
                <button
                  type="button"
                  className={css.injectionDiffToggle}
                  aria-expanded={isOpen(group.key)}
                  // `aria-controls` names the region this button opens. Without it the
                  // `aria-expanded` state has nothing to point at, so assistive tech could
                  // report that *something* expanded but not what — the association between
                  // the toggle and its body existed only visually.
                  aria-controls={bodyId(group.key)}
                  onClick={() => { toggle(group.key) }}
                >
                  <IconChevronDownOutlineRegular
                    // Decorative: the button's own label already says what is expanded, so the
                    // chevron would otherwise be announced as an unnamed graphic.
                    aria-hidden="true"
                    className={isOpen(group.key) ? `${css.chevron} ${css.chevronOpen}` : css.chevron}
                  />
                  {t(group.titleKey)}
                </button>
                {isOpen(group.key) && (
                  <div className={css.injectionDiffBody} id={bodyId(group.key)}>
                    {group.variants.map(variant => (
                      <div key={variant.key} className={css.injectionVariant}>
                        <div className={css.injectionVariantLabel}>{t(variant.labelKey)}</div>
                        {renderBlock(variant.text, variant.key)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          </div>
        </>
      )}
    </>
  )
}
