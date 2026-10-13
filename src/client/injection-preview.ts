/**
 * The samples the settings card renders to show what this plugin injects.
 *
 * ## Why this is derived from the real renderer
 *
 * Every string comes from {@link renderProjectInjection}, the same function the Host calls at
 * request time. A hand-written mock would be a second description of the block, free to drift from
 * the first — and the one question this panel exists to answer is "what does the model actually
 * read", which nothing but the real renderer can answer.
 *
 * ## Why the placeholders are passed **in**, not substituted afterwards
 *
 * The renderer copies a value into the block verbatim — `Relevant directory: ${directories[0]}`,
 * `Related link: ${present[0]}`, ``project name "${project.title}"`` — and applies no formatting to
 * it. So a placeholder handed in as the value comes back out as the placeholder, and no
 * post-processing pass is needed. (Checked against every value site in `injection.ts`;
 * `nonBlankLinks` keeps them, since it only tests for emptiness.)
 *
 * ## Why no Remote
 *
 * The panel shows the **shape** of the contribution, not one Session's live text: every value is a
 * placeholder, so nothing here depends on a project, a Session, or the Host. The renderer is a pure
 * function over plain data, so the browser can call it directly.
 *
 * ## Why the placeholders are not uniform
 *
 * Only values that **vary** — a project's title, its directories, its links, a derived document
 * path — become `[…]`. Text that is a constant in the source is rendered **verbatim**, because
 * bracketing a fixed string would claim it changes with the user's data. `"Ungrouped"`,
 * `DIRECTORY_UNSET`, the no-spec sentence and the rewrite-flow path are all constants: a first
 * draft of this panel bracketed `"Ungrouped"`, and that was wrong.
 *
 * ## Why the drift path is a placeholder too
 *
 * `REWRITE_FLOW_PATH` is derived from `import.meta.url` on the Host (`spec-store.ts:58`), so the
 * browser cannot reproduce it. Bracketing it keeps this feature free of a Remote round trip and of
 * any protocol change, at the cost of showing where that path goes rather than what it is.
 *
 * @module dsh-project-groups/src/client/injection-preview
 */
import type { ProjectRecord } from '../spec.ts'
import type { DocumentInjection, InjectionLocale, ProjectInjectionInput } from '../injection.ts'
import { renderProjectInjection } from '../injection.ts'
import type { ProjectGroupsSettingsKey } from './settings-locales.ts'

/**
 * The value placeholders.
 *
 * One object rather than literals at each call site: the panel's whole claim is that the bracketed
 * parts are the user's data, so they are declared once and reused by every sample.
 */
export const PREVIEW = {
  title: '[项目名称]',
  directories: ['[目录 1]', '[目录 2]'],
  links: ['[链接 1]', '[链接 2]'],
  docPath: '[文档路径]',
  specPath: '[规范路径]',
  rewriteFlowPath: '[重写流程路径]',
} as const

/**
 * A project record carrying placeholders.
 *
 * `docPath` is required by the record but unread by the renderer — the document half supplies the
 * path it prints. The optional schema fields (`docSpec`, `docSpecUsed`, `docSpecIgnored`) are
 * omitted, which is their real absent state.
 * @param directories - the placeholder directories to carry.
 * @param links - the placeholder links to carry.
 * @returns the record.
 */
function project(directories: readonly string[], links: readonly string[]): ProjectRecord {
  return {
    title: PREVIEW.title,
    directories: [...directories],
    links: [...links],
    docPath: '',
    createdAt: '2000-01-01T00:00:00.000Z',
    updatedAt: '2000-01-01T00:00:00.000Z',
  }
}

/**
 * The document half, for the shapes that carry one.
 *
 * `specPath` is **absent** for `'none'`: the renderer branches on it (`injection.ts:426`), and
 * supplying one would print the spec line a spec-less project never produces.
 * @param specMode - the effective spec mode.
 * @param drift - the drift prompt's inputs, when previewing that shape.
 * @returns the document state.
 */
function documentHalf(
  specMode: DocumentInjection['specMode'],
  drift?: DocumentInjection['drift'],
): DocumentInjection {
  return {
    docPath: PREVIEW.docPath,
    specMode,
    ...(specMode === 'none' ? {} : { specPath: PREVIEW.specPath }),
    ...(drift === undefined ? {} : { drift }),
  }
}

/**
 * The main display: the largest injection the current switches allow.
 *
 * "Largest" is per segment. The master switch decides **whether the block exists at all**; the
 * document switch decides **whether the document segment joins it**; and each segment that renders
 * is shown in its fullest form (two directories, two links).
 *
 * The drift prompt is deliberately **absent**: it is produced by a runtime hash comparison, not by
 * a switch, so it belongs to no "largest" configuration. It is previewed as a diff instead.
 * @param injectInfo - the `注入项目信息` switch.
 * @param injectDoc - the `注入项目文档` switch.
 * @returns the rendered block, or `null` when nothing is injected at all.
 */
export function mainInjectionSample(injectInfo: boolean, injectDoc: boolean): string | null {
  // With the master off the Host returns an empty string (`index.ts:757`), so this reports the
  // absence rather than showing a block that would never be sent. `null` rather than `''` keeps the
  // replacement wording in the component, where the translate seat lives.
  if (!injectInfo) return null
  return renderProjectInjection({
    project: project(PREVIEW.directories, PREVIEW.links),
    ...(injectDoc ? { document: documentHalf('custom') } : {}),
  })
}

/** One shape of one segment. */
export interface InjectionVariant {
  /** Stable key for React. */
  readonly key: string
  /** The label's dictionary key. */
  readonly labelKey: ProjectGroupsSettingsKey
  /** The rendered segment, always non-empty — every shape states something. */
  readonly text: string
}

/** One segment's shapes. */
export interface InjectionDiffGroup {
  /** Stable key for React and for the open-set. */
  readonly key: string
  /** The heading's dictionary key. */
  readonly titleKey: ProjectGroupsSettingsKey
  readonly variants: readonly InjectionVariant[]
}

/**
 * The labels that open a segment, in the order the block renders them.
 *
 * `segmentFrom` needs these because the renderer returns one string for the whole block: a
 * segment runs from its own opening label to whichever label comes next. This is therefore the
 * **second** place that knows the block's segment order, and the one that can drift — the
 * renderer's own order is the first. Kept beside the samples rather than in the renderer because
 * the renderer has no reason to expose its internals for a preview.
 */
const SEGMENT_STARTS = [
  'Owning project:',
  'Relevant directory:',
  'Relevant directories:',
  'Related link:',
  'Related links:',
  'Project document:',
] as const

/**
 * Take one segment out of a rendered block.
 *
 * The panel shows segments, so it does not repeat the frame and the declaration paragraph once per
 * group — the block as a whole is what the main display is for.
 *
 * The segment ends at the next known start, not at the end of the block. An earlier version sliced
 * to the last line, which made the directory segment swallow the link lines that follow it — the
 * two lists sit adjacent in the block by design, so every directory sample showed a link line too.
 * @param text - a rendered block.
 * @param from - the first line of the segment wanted.
 * @returns that segment, frame excluded.
 */
function segmentFrom(text: string, from: string): string {
  const lines = text.split('\n')
  const at = lines.findIndex(line => line.startsWith(from))
  if (at === -1) return text
  // The last line is always the closing frame; start by dropping it, then stop at the next start.
  const body = lines.slice(at, -1)
  const next = body.findIndex((line, index) => index > 0 && SEGMENT_STARTS.some(start => line.startsWith(start)))
  return (next === -1 ? body : body.slice(0, next)).join('\n').trimEnd()
}

/**
 * The block's segments, each with the shapes it can take.
 *
 * ## Why grouped rather than listed flat
 *
 * The block is built one function per segment, and a reader arrives with a segment in mind — "what
 * happens to my links" — not with a shape in mind. Grouping also makes the one genuinely surprising
 * contrast visible: an unset directory still prints a sentence, while an empty link list prints
 * **no line at all**.
 *
 * ## Gated exactly as the Host gates
 *
 * A segment that cannot render has no group either: the document group needs both switches, and the
 * directory and link groups need a project to hang from. An unfiled Session renders only the
 * `owning project` segment, which is why its group carries that shape.
 * @param injectInfo - the `注入项目信息` switch.
 * @param injectDoc - the `注入项目文档` switch.
 * @param locale - the configured locale; the drift question follows it.
 * @returns the groups, in the block's own order.
 */
export function injectionDiffGroups(
  injectInfo: boolean,
  injectDoc: boolean,
  locale: InjectionLocale,
): readonly InjectionDiffGroup[] {
  if (!injectInfo) return []
  const dir = PREVIEW.directories[0]
  const link = PREVIEW.links[0]
  /** One project's render, with the frame and declaration dropped by `segmentFrom`. */
  const renderProject = (directories: readonly string[], links: readonly string[]): string =>
    renderProjectInjection({ project: project(directories, links) })
  const groups: InjectionDiffGroup[] = [
    {
      key: 'owning',
      titleKey: 'diffOwningTitle',
      variants: [
        { key: 'filed', labelKey: 'diffOwningFiled', text: segmentFrom(renderProject([dir], [link]), 'Owning project:') },
        { key: 'unfiled', labelKey: 'diffOwningUnfiled', text: segmentFrom(renderProjectInjection({ project: undefined }), 'Owning project:') },
      ],
    },
    {
      key: 'directories',
      titleKey: 'diffDirectoriesTitle',
      variants: [
        { key: 'none', labelKey: 'diffDirectoriesNone', text: segmentFrom(renderProject([], [link]), 'Relevant directory:') },
        { key: 'one', labelKey: 'diffDirectoriesOne', text: segmentFrom(renderProject([dir], [link]), 'Relevant directory:') },
        { key: 'many', labelKey: 'diffDirectoriesMany', text: segmentFrom(renderProject(PREVIEW.directories, [link]), 'Relevant directories:') },
      ],
    },
    {
      key: 'links',
      titleKey: 'diffLinksTitle',
      variants: [
        // Three shapes for three counts, matching the directory group above: an unset link states
        // itself rather than vanishing, so no shape here is empty and none needs a substitute note.
        { key: 'none', labelKey: 'diffLinksNone', text: segmentFrom(renderProject([dir], []), 'Related link:') },
        { key: 'one', labelKey: 'diffLinksOne', text: segmentFrom(renderProject([dir], [link]), 'Related link:') },
        { key: 'many', labelKey: 'diffLinksMany', text: segmentFrom(renderProject([dir], PREVIEW.links), 'Related links:') },
      ],
    },
  ]
  if (injectDoc) {
    /** One document segment, with or without the drift block. */
    const renderDocument = (specMode: DocumentInjection['specMode'], drift?: DocumentInjection['drift']): string =>
      segmentFrom(
        renderProjectInjection({
          project: project([dir], [link]),
          document: documentHalf(specMode, drift),
        }),
        'Project document:',
      )
    groups.push({
      key: 'document',
      titleKey: 'diffDocumentTitle',
      variants: [
        { key: 'spec', labelKey: 'diffDocumentSpec', text: renderDocument('custom') },
        { key: 'noSpec', labelKey: 'diffDocumentNoSpec', text: renderDocument('none') },
        { key: 'drift', labelKey: 'diffDocumentDrift', text: renderDocument('custom', { locale, rewriteFlowPath: PREVIEW.rewriteFlowPath }) },
      ],
    })
  }
  return groups
}
