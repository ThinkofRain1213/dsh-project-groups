/**
 * The "what this plugin injects" panel, on the plugin's own settings card.
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
  return (
    <div className={css.injectionPanel}>
      <div className={css.groupTitle}>{t('injectionTitle')}</div>
      {/* The main display: always expanded, and present in both switch states. */}
      <div className={css.injectionMain}>
        {main === null
          ? <div className={css.injectionOff}>{t('injectionOff')}</div>
          : <pre className={css.injectionText}>{main}</pre>}
        <div className={css.injectionNote}>{t('injectionNote')}</div>
      </div>
      {groups.length > 0 && (
        <div className={css.injectionDiffTitle}>{t('injectionDiffTitle')}</div>
      )}
      {groups.length > 0 && (
        /*
         * The groups sit in one filled block rather than under a stack of dividers.
         *
         * The heading above them is the section's head, and a section whose content is a single
         * surface reads as one group; three hairline-separated rows read as a list that happens to
         * follow the heading. That distinction was the reported problem: with a divider under each
         * of the three rows, the last one and the panel's own bottom border were indistinguishable,
         * so the stack looked like a fourth, empty row.
         *
         * Copied from the official shape for exactly this (`ui-plugin-manager`'s `.guide`: a
         * `bg-layer-1` block with `radius-lg` and a `border-l4` hairline, opened by a divider-less
         * toggle). Rows keep their affordance through the hover fill instead of a divider.
         */
        <div className={css.injectionDiffList}>
          {groups.map(group => (
            <div key={group.key} className={css.injectionDiff}>
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
      )}
    </div>
  )
}
