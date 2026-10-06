/**
 * Rendering of this plugin's runtime-context contribution.
 *
 * Pure by construction: the renderer takes the records and switch values it needs
 * and returns the exact text. Keeping it free of the Host context is what lets
 * the wording be tested without a composition, and what keeps the one question
 * that matters — what does the model actually read — in a single readable place.
 *
 * ## Why the wording is English and unwrapped
 *
 * This text is contributed through `systemPrompt.context()`, so it is joined
 * into the single official runtime-context message rather than sent as a message
 * of its own. Everything else in that message is an English declarative sentence
 * — `Current DSH file policy: …`, `Approval prompts are disabled …` — and every
 * one of the official `context()` contributions reads the same way
 * (`sandbox-policy`, `user-approval`, `subagent`): a `Label: value` sentence,
 * with no XML frame. The two official paths that *do* wrap their text in
 * `<system-reminder>` (`agent-instructions`, `skill-catalog`) build their own
 * user message instead, because a frame exists to bound untrusted or unbounded
 * content. What is rendered here is a title, our own directory list, and two
 * paths, so it takes the plain form and stays legible as one more state line.
 *
 * ## Why only the question is localized
 *
 * The framework sentences are read by the **model**, which is addressed in
 * English everywhere else in this very message. The question and option labels
 * are read by the **user**, in the `ask_user_question` card, so those — and only
 * those — follow the configured locale. Mixing languages inside one block is
 * therefore deliberate: it is two audiences in one payload.
 *
 * @module dsh-project-groups/src/injection
 */
import type { ProjectRecord } from './spec.ts'

/** The project value when the Session belongs to no project. */
export const UNFILED_PROJECT = 'none (ungrouped)'

/** The directories value when the project defines none. */
export const ABSENT = 'none'

/** Locales this plugin renders user-facing text for. */
export type InjectionLocale = 'zh' | 'en'

/**
 * Stable question id the drift prompt asks the model to use.
 *
 * The answer echoes this id, which is what lets the observer pick our question
 * out of every `ask_user_question` call in the session without reading prose.
 */
export const SPEC_DRIFT_QUESTION_ID = 'project-doc-spec-drift'

/**
 * The three choices, as the exact labels the model is told to use.
 *
 * Both languages are held here, and {@link matchSpecDriftChoice} matches against
 * both, so switching the configured locale does not orphan an answer recorded
 * under the other one. Nothing may be appended to these strings — no `(Recommended)`
 * suffix, no index — because the answer returns the label verbatim and the match
 * is exact.
 */
export const SPEC_DRIFT_LABELS = {
  rewrite: { zh: '按新规范重写', en: 'Rewrite for the new spec' },
  skip: { zh: '本次忽略', en: 'Skip this time' },
  ignore: { zh: '在规范再次变更前忽略', en: 'Ignore until the spec changes again' },
} as const

/** One of the three drift choices. */
export type SpecDriftChoice = keyof typeof SPEC_DRIFT_LABELS

/** The order the choices are presented in; the rewrite option is first. */
export const SPEC_DRIFT_CHOICES: readonly SpecDriftChoice[] = ['rewrite', 'skip', 'ignore']

/**
 * The description under each choice, in both locales.
 *
 * The `rewrite` description states that nothing is lost, which is the promise
 * `REWRITE-FLOW.md` exists to keep: it is the one line that tells the user the
 * migration is safe.
 */
const SPEC_DRIFT_DESCRIPTIONS: Record<SpecDriftChoice, Record<InjectionLocale, string>> = {
  rewrite: {
    zh: '按当前规范重构文档；已有信息不丢失。',
    en: 'Restructure the document to follow the current spec; no information is lost.',
  },
  skip: {
    zh: '保持文档不变；之后仍会询问。',
    en: 'Leave the document unchanged; you will be asked again later.',
  },
  ignore: {
    zh: '保持文档不变，且不再询问。',
    en: 'Leave the document unchanged, and do not ask again.',
  },
}

/** The localized question and its options. */
export interface SpecDriftQuestion {
  readonly question: string
  readonly options: readonly {
    readonly label: string
    readonly description: string
  }[]
}

/**
 * Build the localized question block.
 * @param locale - the configured locale.
 * @returns the question text and its three options, in presentation order.
 */
export function specDriftQuestion(locale: InjectionLocale): SpecDriftQuestion {
  return {
    question: locale === 'zh'
      ? '项目文档依据的规范已变更，如何处理已有文档？'
      : 'The project document was written under a different spec. How should the existing document be handled?',
    options: SPEC_DRIFT_CHOICES.map(choice => ({
      label: SPEC_DRIFT_LABELS[choice][locale],
      description: SPEC_DRIFT_DESCRIPTIONS[choice][locale],
    })),
  }
}

/**
 * Map one answered label back to its choice.
 *
 * Exact match in either language, because the answer carries the label the model
 * passed in. A label the model rewrote or translated matches nothing, and the
 * caller then records nothing — the safe outcome, since the alternative would be
 * acting on a choice the user may not have made.
 * @param label - the answered label.
 * @returns the choice, or undefined when it matches none.
 */
export function matchSpecDriftChoice(label: string): SpecDriftChoice | undefined {
  for (const choice of SPEC_DRIFT_CHOICES) {
    const labels = SPEC_DRIFT_LABELS[choice]
    if (label === labels.zh || label === labels.en) return choice
  }
  return undefined
}

/**
 * Whether the drift question applies to one project.
 *
 * Four conditions, and each rules out a case where asking would be wrong:
 *
 *   - `currentSha1 !== undefined` — there is a spec to migrate TO. 无 (and a
 *     custom name whose file is gone) resolves to no spec, and the prompt points
 *     the model at the spec file plus `REWRITE-FLOW.md`, whose first step is to
 *     read "the spec file given in this injection". Asking without one instructs
 *     the model to restructure a document to follow a spec that does not exist.
 *     无 means "no format update", so there is nothing to migrate.
 *   - `usedSha1 !== undefined` — the document has been written. Absent means it
 *     has never existed, so there is nothing to migrate FROM.
 *   - `usedSha1 !== currentSha1` — the content actually changed. A content hash
 *     rather than a name catches an overwritten file and a plugin upgrade.
 *   - `ignoredSha1 !== currentSha1` — the user did not dismiss this very content.
 *
 * Pure, and exported for that reason: the guard is the one thing about the drift
 * feature that cannot be seen from the rendered text, since its effect is that no
 * drift text appears at all.
 * @param state - the recorded hashes and the current spec's hash.
 * @returns whether the caller should emit the drift prompt.
 */
export function shouldAskSpecDrift(state: {
  readonly usedSha1: string | undefined
  readonly ignoredSha1: string | undefined
  readonly currentSha1: string | undefined
}): boolean {
  const { usedSha1, ignoredSha1, currentSha1 } = state
  if (currentSha1 === undefined) return false
  if (usedSha1 === undefined) return false
  if (usedSha1 === currentSha1) return false
  return ignoredSha1 !== currentSha1
}

/** The document feature's state for one Session, when it is on. */
export interface DocumentInjection {
  /** Absolute path of this project's document. */
  readonly docPath: string
  /** The effective spec's mode. */
  readonly specMode: 'none' | 'default' | 'custom'
  /** Absolute spec path; absent for `'none'` and for an unset custom name. */
  readonly specPath?: string | undefined
  /**
   * Present only when the document exists, its recorded spec differs from the
   * configured one, and the user has not already dismissed that difference.
   */
  readonly drift?: {
    readonly locale: InjectionLocale
    /** Absolute path of the rewrite procedure the prompt points at. */
    readonly rewriteFlowPath: string
  } | undefined
}

/** Everything the renderer needs. */
export interface ProjectInjectionInput {
  /** The owning project's record, or undefined when unfiled. */
  readonly project: ProjectRecord | undefined
  /** The document lines; absent when the document feature is off. */
  readonly document?: DocumentInjection | undefined
}

/**
 * Render the injection for one Session.
 *
 * ## Why the unfiled case is one line and a filed case is two
 *
 * `directories` is a field of the **project record**. An unfiled Session has no
 * record, so there is nowhere a directory could be associated with it — the
 * Ungrouped row offers no editing surface because there is nothing to edit.
 * Emitting a `Related folders:` line there would name a setting that does not
 * exist and cannot be changed, which is worse than saying nothing: it invites
 * the model to report a fixable absence.
 *
 * A **filed** project with no directories keeps its line, and that asymmetry is
 * the point: that project *does* have an edit surface («编辑项目»), so `none` is
 * a real, actionable state rather than a missing one.
 *
 * ## Shape rules
 *
 * A **single** associated directory uses the same list form as two or more. A
 * one-line special case would make the block's shape depend on how many
 * directories happen to be associated, which is the kind of rule that drifts
 * once a second writer touches it.
 *
 * ## Why the drift block drops the document's trailing sentence
 *
 * The trailing sentence says a failed read means the document does not exist
 * yet. Drift is only ever reported for a document that **does** exist (an absent
 * `docSpecUsed` means it was never written), so keeping that sentence would
 * contradict the block it sits in.
 * @param input - the project, and the document state when that feature is on.
 * @returns the contribution text; never empty.
 */
export function renderProjectInjection(input: ProjectInjectionInput): string {
  const { project, document } = input
  if (project === undefined) return `Current project: ${UNFILED_PROJECT}`

  const lines = [`Current project: ${project.title}`]

  const directories = project.directories
  if (directories.length === 0) {
    lines.push(`Related folders: ${ABSENT}`)
  } else {
    lines.push('Related folders:')
    for (const directory of directories) lines.push(`- ${directory}`)
  }

  if (document !== undefined) {
    lines.push(renderDocumentLine(document))
    lines.push(renderSpecLine(document))
    if (document.drift !== undefined) lines.push(renderDriftBlock(document.drift))
  }

  return lines.join('\n')
}

/**
 * The `Project document:` line.
 *
 * The trailing sentence is an instruction, not a claim about the filesystem: the
 * plugin never stats the document, so the model is told what a failed read
 * *means* and left to do the reading. That keeps this module free of I/O and
 * keeps the cost off every request.
 * @param document - the document state.
 * @returns the line.
 */
function renderDocumentLine(document: DocumentInjection): string {
  const head = `Project document: ${document.docPath}`
  if (document.drift !== undefined) return head
  // No spec means there is no procedure to follow, so the instruction cannot
  // promise one.
  if (document.specMode === 'none') {
    return `${head} — a failed read means it has not been created yet; create it as the project needs.`
  }
  return `${head} — a failed read means it has not been created yet; create it following the spec.`
}

/**
 * The `Project document spec:` line.
 *
 * The spec-less wording states the POLICY, not just the absence of a format:
 * "no format is required" alone can be read as "write it however you like", which
 * would license reorganising a document that already has a structure. 无 means the
 * plugin does not ask for a format update — an unstructured document may be
 * written freely, and a structured one may be added to freely, but neither is a
 * migration. This is also why no drift question is ever emitted in this state
 * (see `documentInjection`): there is no target spec to migrate to.
 * @param document - the document state.
 * @returns the line.
 */
function renderSpecLine(document: DocumentInjection): string {
  if (document.specPath === undefined) {
    return 'Project document spec: none — no format is required, and the document\'s format is '
      + 'left as it is: write freely if it has no format of its own, or add to the existing '
      + 'format rather than reorganising the document.'
  }
  return `Project document spec: ${document.specPath}`
}

/**
 * The drift prompt: what the model must ask, verbatim, and what to do next.
 *
 * The option labels are reproduced exactly as {@link matchSpecDriftChoice} will
 * receive them back — this text is the only place they are written for the
 * model, so a change here and a change there cannot drift apart without the
 * matcher's own spec failing.
 * @param drift - the locale and the rewrite procedure's path.
 * @returns the prompt block.
 */
function renderDriftBlock(drift: NonNullable<DocumentInjection['drift']>): string {
  const { question, options } = specDriftQuestion(drift.locale)
  return [
    'The spec the project document currently uses differs from the spec this plugin currently configures. '
    + 'Before continuing, call `ask_user_question` and use the following question, options, and descriptions '
    + 'strictly verbatim — do not rewrite or translate them:',
    `  id: ${SPEC_DRIFT_QUESTION_ID}`,
    `  question: ${question}`,
    '  options:',
    ...options.flatMap((option, index) => [
      `    ${String(index + 1)}. label: ${option.label}`,
      `       description: ${option.description}`,
    ]),
    'If the user selects the first option, read this file in full and follow it exactly:',
    drift.rewriteFlowPath,
  ].join('\n')
}
