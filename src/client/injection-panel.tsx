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
  /*
   * Two kinds of block, both ordinary members of the card's `.stack`.
   *
   * The card has no panel: this returns a fragment so the main block and each diff row are
   * direct children of `.stack` alongside the switches, spaced by their own `padding` exactly
   * like everything else. An earlier version wrapped all of this in a bordered panel with a
   * filled list inside it; that surface is gone, because the reported problem was precisely
   * that the panel's edges competed with the dividers it contained.
   *
   * `Fragment` and not a wrapper element: a wrapper would generate a box and its children
   * would stop being `.stack`'s own, which is how the container gap returned the last time.
   */
  return (
    <>
      {/*
       * The main display, built on the card's existing group shape (heading, content, description)
       * rather than a new one — the same `.group` the 文档规范 row uses, with the rendered block
       * where that row puts its cards.
       *
       * The description sits **below** the block here, not between the heading and it as
       * `groupHeading` does elsewhere: the sentence explains how to read the brackets inside the
       * block, so it can only be read after the block exists. On the other rows the note explains
       * what the setting is, which belongs above its control.
       */}
      <div className={css.group}>
        <div className={css.groupTitle}>{t('injectionTitle')}</div>
        {main === null
          ? <div className={css.injectionOff}>{t('injectionOff')}</div>
          : <pre className={css.injectionText}>{main}</pre>}
        <div className={css.desc}>{t('injectionNote')}</div>
      </div>

      {/*
       * One block per segment. Each is its own row in the stack, so the gap between two of them is
       * the card's ordinary block gap and the diff section needs no container to hold it together.
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
    </>
  )
}
