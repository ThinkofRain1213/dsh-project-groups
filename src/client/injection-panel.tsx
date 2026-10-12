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
import { useState } from 'react'
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
  // The largest injection the switches currently allow, or `null` when there is none.
  const main = mainInjectionSample(injectInfo, injectDoc)
  const groups = injectionDiffGroups(injectInfo, injectDoc, locale)
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
  /*
   * One `.group`, and nothing else.
   *
   * The card has no panel: this returns the same group shape 文档规范 uses — heading, content,
   * note — with the diff rows as further children of it. An earlier version wrapped the rows in a
   * bordered panel with a filled list inside; that surface is gone, because the reported problem
   * was precisely that the panel's edges competed with the dividers it contained.
   *
   * The rows are inside the group rather than siblings of it (which is how this was rebuilt
   * first). Outside, they sat 32px from the group like any other setting row and read as four new
   * settings — the group wanted them, and the note about brackets wanted something to introduce.
   * Inside, `.group`'s own `gap: 8px` spaces them, which is the same value the card uses between a
   * heading and what it introduces.
   */
  return (
    <div className={css.group}>
      <div className={css.groupTitle}>{t('injectionTitle')}</div>

      {/*
       * The group holds two parts, each with a label of its own: the full text below the current
       * switches, then the per-state differences.
       *
       * The labels are `.injectionSubTitle` — 13px against the group heading's 14px, both in
       * `label-primary`, with the diff rows below in `label-secondary` at the same 13px. So the
       * hierarchy is carried by colour rather than by size, and no value is invented: 13px is the
       * diff rows' own size, and `primary` is the heading's own colour.
       *
       * This is what makes the first part stop competing with the group heading. It used to be a
       * `groupTitle` itself, which read as a second heading of equal rank.
       */}
      <div className={css.injectionSubTitle}>{t('injectionCurrent')}</div>
      {main === null
        ? <div className={css.injectionOff}>{t('injectionOff')}</div>
        : <pre className={css.injectionText}>{main}</pre>}
      {/*
       * Below the block, not between the label and it as `groupHeading` does elsewhere: this
       * sentence explains how to read the brackets *inside* the block, so it can only be read
       * after the block exists. On other rows the note says what the setting is, which belongs
       * above its control.
       */}
      <div className={css.desc}>{t('injectionNote')}</div>

      {/* The second part's label. Same shape as the one above; the group's 8px separates both. */}
      {groups.length > 0 && <div className={css.injectionSubTitle}>{t('injectionDiffTitle')}</div>}

      {/*
       * One row per segment, each a child of this group so `gap: 8px` spaces them — the same value
       * that separates the heading from the block above. The rows are not given a padding of their
       * own: an 8px gap plus a 16px padding would read as 24px where every other gap in this group
       * reads 8px.
       */}
      {groups.map(group => (
        <div key={group.key} className={css.injectionDiffRow}>
          <button
            type="button"
            className={css.injectionDiffToggle}
            aria-expanded={open.has(group.key)}
            onClick={() => { toggle(group.key) }}
          >
            <IconChevronDownOutlineRegular
              className={open.has(group.key) ? `${css.chevron} ${css.chevronOpen}` : css.chevron}
            />
            {t(group.titleKey)}
          </button>
          {open.has(group.key) && (
            <div className={css.injectionDiffBody}>
              {group.variants.map(variant => (
                <div key={variant.key} className={css.injectionVariant}>
                  <div className={css.injectionVariantLabel}>{t(variant.labelKey)}</div>
                  {variant.text === ''
                    ? (
                      <div className={css.injectionVariantEmpty}>
                        {variant.hintKey === undefined ? '' : t(variant.hintKey)}
                      </div>
                    )
                    : <pre className={css.injectionText}>{variant.text}</pre>}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
