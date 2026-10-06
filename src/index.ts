/**
 * Host half of dsh-project-groups.
 *
 * Owns the durable project table and serves it over the plugin's own Remote
 * namespace. Everything the sidebar shows about projects comes from here; the
 * Host's workspace registry is never written, so a Session's `cwd` and its
 * official Workspace account are exactly what they were before this plugin was
 * installed.
 *
 * ## Why no generated Typert artifact
 *
 * The official Remote owners ship a `typert.remote-client.js` produced by
 * `@deepseek-ai/dsh-typert-generator`. That generator is built for the harness
 * monorepo: it discovers packages only under `<root>/packages` (or `vendor`) and
 * requires a `tsconfig.host.json` at the workspace root, so an out-of-tree
 * plugin cannot use it without masquerading as a monorepo.
 *
 * It is not needed here. The Gateway has an SRC fallback
 * (`packages/api/gateway/src/index.ts`, `resolveSrcDescriptor`) that derives an
 * invocation descriptor at runtime from the service's `typertRemote` binding
 * plus the `@Remote` markers its prototype carries — and `TypertRemoteService`
 * is what supplies that binding. So `@Remote` is sufficient on this side, and
 * the Client ships hand-written descriptors instead of generated ones
 * (`src/client/remote.ts`).
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdir } from 'node:fs/promises'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain, DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { PROJECT_DOMAIN_NAME, projectDomainSpec, type BaseWorkspaceSetting, type GlobalRecord, type ProjectRecord } from './spec.ts'
import { defaultWorkspacePath as deriveDefaultWorkspacePath } from './default-workspace.ts'
import {
  renderProjectInjection,
  shouldAskSpecDrift,
  SPEC_DRIFT_QUESTION_ID,
  matchSpecDriftChoice,
  type DocumentInjection,
  type InjectionLocale,
  type SpecDriftChoice,
} from './injection.ts'
import {
  documentPath,
  specIdentity,
  resolveSpec,
  REWRITE_FLOW_PATH,
  listUploadedSpecs,
  writeUploadedSpec,
  deleteUploadedSpec,
  readUploadedSpec,
  isSafeSpecName,
} from './spec-store.ts'

/**
 * The slice of the settings service this plugin reads to resolve the locale.
 *
 * Structural, and reached with `ctx.get`: `@deepseek-ai/dsh-settings` is not a
 * dependency of this package, and the property read is gated on the `inject`
 * list. Only the one entry the locale preference lives on is described.
 */
interface SettingsDescriptorLike {
  readonly ns: string
  readonly value: unknown
}
import {
  PROJECT_NAMESPACE, PROJECT_SERVICE_KEY, withDefaultMode,
  type ProjectAssignRequest, type ProjectAssignmentValue, type ProjectBaseline,
  type ProjectBaseWorkspaceValue,
  type ProjectCreateRequest, type ProjectDeleteRequest, type ProjectExpansionValue,
  type ProjectCreateOpensSessionValue,
  type ProjectFollowFrame, type ProjectOrderValue, type ProjectOrdersValue,
  type ProjectNewSessionTargetValue,
  type ProjectUpdateRequest, type ProjectUpdateValue, type ProjectReorderRequest, type ProjectRebuildBaseWorkspaceValue,
  type ProjectSetBaseWorkspaceRequest,
  type ProjectSetCreateOpensSessionRequest,
  type ProjectSetDirectoriesRequest, type ProjectDirectoriesValue,
  type ProjectSetInjectProjectInfoRequest, type ProjectInjectProjectInfoValue,
  type ProjectSetInjectProjectDocRequest, type ProjectInjectProjectDocValue,
  type ProjectSetDocSpecModeRequest, type ProjectDocSpecModeValue,
  type ProjectSetDocSpecFileNameRequest, type ProjectDocSpecFileNameValue,
  type ProjectSetPerProjectDocSpecRequest, type ProjectPerProjectDocSpecValue,
  type ProjectSetProjectDocSpecRequest, type ProjectProjectDocSpecValue,
  type ProjectUploadSpecRequest, type ProjectUploadSpecValue,
  type ProjectDeleteSpecRequest, type ProjectDeleteSpecValue,
  type ProjectSpecsUsedByRequest, type ProjectSpecsUsedByValue,
  type ProjectReadSpecRequest, type ProjectReadSpecValue,
  type ProjectSetExpandedRequest, type ProjectSetNewSessionTargetRequest, type ProjectSetOrdersRequest,
  type ProjectUnassignRequest, type ProjectUnassignValue,
  type ProjectValue, type ProjectValueResult,
  type ProjectDefaultWorkspacePathValue,
} from './protocol.ts'

/**
 * Required Host services. The storage domain facility opens this plugin's
 * domain; without it there is nowhere durable to put a project.
 *
 * Deliberately minimal. Both services this class reads opportunistically —
 * `systemPrompt` for the injection and `sessions` for the subagent lineage walk —
 * are read with `ctx.get` rather than declared here, because a name in this list
 * is a **gate**: the whole plugin stays inactive until that service appears.
 * Naming `sessions` would tie every project verb to the Session store, and naming
 * `systemPrompt` would tie them to the prompt registry.
 */
export const inject = ['storageDomain']

/**
 * The slice of `@deepseek-ai/dsh-system-prompt` this plugin consumes.
 *
 * Declared structurally rather than imported: that package is **not** a
 * dependency of this one, so its `Context.systemPrompt` augmentation is out of
 * scope and a bare `ctx.systemPrompt` read is a compile error — measured, TS2339.
 * The shape mirrors the official `PromptContext`, plus the `agent` field
 * `@deepseek-ai/dsh-agent` merges into `AssembleContext`.
 *
 * Only `agent.session.id` is read. Spelling the used surface out, rather than
 * casting to `any`, is what keeps an upstream interface change a compile error at
 * the single call site instead of a silent behaviour change.
 */
interface PromptAssemblyContext {
  /** Agent for this assembly; absent on diagnostics and bare assemblies. */
  readonly agent?: { readonly session?: { readonly id?: SessionId } } | undefined
}

/** One dynamic runtime-context contribution, as registered. */
interface SystemPromptContextContribution {
  readonly name: string
  readonly order: number
  readonly text: (context: PromptAssemblyContext) => string
}

/** The `systemPrompt` service face this plugin consumes. */
interface SystemPromptFace {
  context(contribution: SystemPromptContextContribution): () => void
}

/**
 * The slice of the Session store the lineage walk reads.
 *
 * The header fields below are the whole of what is needed, and they are
 * structural for the same reason the prompt face is: the walk must not depend on
 * `@deepseek-ai/dsh-session`'s full `Session` type to read three fields.
 */
interface SessionHeaderFace {
  readonly id: SessionId
  /** Present and `'subagent'` on a delegated child; absent on an ordinary Session. */
  readonly origin?: 'subagent'
  /** The Session this one was forked from; the next rung of the lineage walk. */
  readonly parentSession?: SessionId
}

/**
 * The slice of the Session store this plugin reads.
 *
 * Reached with `ctx.get('sessions')`, never as a property: `sessions` is not in
 * this plugin's `inject` list, and the property read is gated on that list — a
 * bare `ctx.sessions` throws at runtime (measured). The package *is* a
 * dependency, so the type alone would resolve; it is the gate, not the type, that
 * forbids the property.
 */
interface SessionsFace {
  get(id: SessionId): { readonly header: SessionHeaderFace } | undefined
}

/**
 * The fields the drift observer reads out of a Session event.
 *
 * Both variants carry the same `type`/`data` shape as the real event; the
 * observer narrows on `event.type` and reads a few fields, so this mirrors only
 * those. Every other event type is ignored, and a shape change upstream turns
 * the reads below into compile errors rather than silent misses.
 */
interface SessionEventLike {
  readonly type: string
  readonly data: unknown
}

/** The `tool/call` payload, as far as this plugin reads it. */
interface ToolCallData {
  readonly name: string
  readonly callId: string
  readonly arguments: string
}

/** The `tool/result` payload, as far as this plugin reads it. */
interface ToolResultData {
  readonly message: {
    readonly toolCallId: string
    readonly isError?: boolean
    readonly content: readonly { readonly type: string; readonly text?: string }[]
  }
}

/** Whether a parsed JSON value is a plain object to read keys from. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reject a project spec override that is not one of the four storable values.
 *
 * Shared by BOTH write paths (`create` and `setProjectDocSpec`) because they must
 * agree: `setProjectDocSpec` refused `'default'` while `create` accepted anything,
 * so the same value was storable or not depending on which dialog the user opened.
 * That is the one-sided-guard shape this codebase has already been bitten by twice.
 *
 * The four values are `null` (inherit), `'none'`, `'default'`, and an uploaded
 * file name. `'none'` and `'default'` are semantic, not file names, so they must
 * bypass the `.md` check that `isSafeSpecName` applies.
 *
 * Validating rather than coercing: a refused write surfaces as an error, where a
 * silently-dropped field is what let the create dialog's choice vanish unnoticed.
 * @param spec - the override as it arrived, or undefined/absent.
 * @returns the override unchanged.
 * @throws when the value is not storable.
 */
function assertUsableDocSpec(spec: string | null | undefined): string | null | undefined {
  if (spec === undefined || spec === null) return spec
  if (spec === 'none' || spec === 'default') return spec
  if (!isSafeSpecName(spec)) {
    throw new Error(`not a usable spec file name: ${JSON.stringify(spec)}`)
  }
  return spec
}

/**
 * Narrow one event's `data` to the `tool/call` fields it should hold.
 * @param data - the event's untyped payload.
 * @returns the fields, or undefined when the payload is not a tool call.
 */
function asToolCall(data: unknown): ToolCallData | undefined {
  if (!isRecord(data)) return undefined
  if (typeof data.name !== 'string' || typeof data.callId !== 'string' || typeof data.arguments !== 'string') return undefined
  return { name: data.name, callId: data.callId, arguments: data.arguments }
}

/**
 * Narrow one event's `data` to the `tool/result` fields it should hold.
 * @param data - the event's untyped payload.
 * @returns the fields, or undefined when the payload is not a tool result.
 */
function asToolResult(data: unknown): ToolResultData | undefined {
  if (!isRecord(data) || !isRecord(data.message)) return undefined
  const message = data.message
  if (typeof message.toolCallId !== 'string') return undefined
  const content = message.content
  if (!Array.isArray(content)) {
    return { message: { toolCallId: message.toolCallId, ...message.isError === true ? { isError: true } : {}, content: [] } }
  }
  const blocks = content.filter(isRecord).map(block => ({
    type: typeof block.type === 'string' ? block.type : '',
    ...typeof block.text === 'string' ? { text: block.text } : {},
  }))
  return {
    message: {
      toolCallId: message.toolCallId,
      ...message.isError === true ? { isError: true } : {},
      content: blocks,
    },
  }
}

/**
 * Parse a model-produced argument string, tolerating anything malformed.
 * @param raw - the raw JSON string from `tool/call`.
 * @returns the object, or undefined when it is not a JSON object.
 */
function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * The first selected label in an `ask_user_question` result.
 *
 * The tool renders its answer as one text block holding
 * `{ answers: [{ id, selected: [...] }] }`, so the label is read out of that
 * JSON rather than out of prose. Only the first question's first selection is
 * used: our question is single-select and is the only one we ask for.
 * @param content - the result message's content blocks.
 * @returns the label, or undefined when the payload is not an answer batch.
 */
function firstAnswerLabel(content: readonly { readonly type: string; readonly text?: string }[]): string | undefined {
  const text = content.find(block => block.type === 'text')?.text
  if (text === undefined) return undefined
  const parsed = parseJsonObject(text)
  const answers = parsed?.answers
  if (!Array.isArray(answers)) return undefined
  const first = answers[0]
  if (!isRecord(first)) return undefined
  const selected = first.selected
  if (!Array.isArray(selected)) return undefined
  const label = selected[0]
  return typeof label === 'string' ? label : undefined
}

/**
 * Order of this plugin's contribution within the runtime-context snapshot.
 *
 * A literal rather than a lookup: the official `getContextOrder` knows only
 * `SANDBOX_POLICY` (110), `APPROVAL_POLICY` (115) and `SUBAGENT_DELEGATION` (120),
 * so a plugin has no name to ask for. 200 places this block after all three — the
 * end of the joined snapshot, which is where "which project am I working in"
 * reads most naturally.
 */
const INJECTION_CONTEXT_ORDER = 200

/** Contribution name, following the official `<area>:<aspect>` form. */
const INJECTION_CONTEXT_NAME = 'project:info'

/**
 * Host project registry: the durable table, its order, and the assignment map,
 * plus the Remote methods the Client calls.
 *
 * Extends `TypertRemoteService` rather than plain `Service`: that base's
 * constructor installs the `typertRemote` binding the Gateway's SRC discovery
 * reads, and without it none of the `@Remote` markers below would be reachable.
 *
 * Reads are synchronous from the domain's in-memory state; every write queues on
 * the domain's own chain, so a rejected durable write leaves memory untouched.
 */
export class ProjectController extends TypertRemoteService {
  static inject = ['storageDomain']

  private domain: Domain<typeof projectDomainSpec> | undefined
  /** Live followers, each woken by a landed write. */
  private readonly followers = new Set<() => void>()
  /** Serializes domain opens so repeated activation cannot open twice. */
  private opening: Promise<void> | undefined
  /** Listener for `domain/changed`, held so the close path can drop it. */
  private detach: (() => void) | undefined
  /**
   * Tail of the compound-mutation chain.
   *
   * The domain serializes each individual write, but a create or a delete is
   * three to five writes plus a marker, and a second caller interleaving between
   * them would observe a half-applied mutation — or, worse, overwrite the marker
   * that makes recovery possible. Mirrors the official registry's
   * `operationTail` (`workspace/src/index.ts`).
   */
  private operationTail: Promise<void> = Promise.resolve()

  /**
   * `ask_user_question` calls carrying our drift question, by call id.
   *
   * The call and its result arrive as two separate `session/event`s, and only the
   * result carries the answer, so the call id has to be remembered in between.
   * Keyed by call id alone because the id is unique per session; the value keeps
   * the session so the answer can be attributed to the right project.
   */
  private readonly pendingDriftCalls = new Map<string, { readonly sessionId: SessionId; readonly projectId: string }>()

  /**
   * The tail of the global-write chain.
   *
   * Every global write is a read-modify-write (`get()` then spread then `set()`),
   * so two writes that overlap in flight both read the pre-write snapshot and the
   * later one silently drops the earlier one's field. That was measured, not
   * theorised: firing `setDocSpecFileName` and `setDocSpecMode` together lost the
   * name in 12 of 12 runs, leaving `mode: 'custom'` with an empty file name — the
   * exact "empty custom" state the setting must never hold.
   *
   * Chaining each write onto the previous one makes the `get()` happen after the
   * previous `set()` has landed. It lives here rather than in the one call site
   * that exposed it because the hazard is a property of `setGlobal`, not of that
   * pair of fields: any two overlapping global writes can lose one another.
   *
   * A second queue beside {@link operationTail}, not a replacement for it. That
   * one orders *compound* mutations (create/delete, several writes plus a recovery
   * marker); this one orders the individual read-modify-write, and so also covers
   * the settings verbs that never enter `operate` — which is precisely where the
   * lost update was measured. The two nest harmlessly: a write inside `operate`
   * simply waits for its own chain too.
   */
  private globalWriteChain: Promise<void> = Promise.resolve()

  /**
   * @param ctx - Host context carrying the storage-domain facility.
   */
  constructor(ctx: Context) {
    super(ctx, PROJECT_SERVICE_KEY, { namespace: PROJECT_NAMESPACE })
    ctx.effect(() => () => this.close(), 'project-groups: domain close')
    // Nested `inject`, never the plugin's top-level one. The top-level list is a
    // gate: a service named there holds the WHOLE plugin inactive until it
    // appears. This child fiber waits for `systemPrompt` on its own, so the Host
    // half keeps serving every project verb whether or not a prompt registry is
    // composed — a product without one simply gets no contribution.
    ctx.inject(['systemPrompt'], (scope) => { this.installInjection(scope) })
    ctx.effect(() => this.observeSessions(ctx), 'project-groups: spec-drift answers')
  }

  /**
   * Follow every Session's events to learn which drift choice the user made.
   *
   * ## Why the event stream rather than the official projection
   *
   * `ctx.sessionProjections.stateOf(session, 'userQuestions')` looks like the
   * natural source, and it is what `@deepseek-ai/dsh-user-questions` uses
   * internally. It is empty here: that projection records a question only when
   * the Session header shows the **timed** `ask_user_question` schema
   * (`projection.ts`: `if (!fold.timed …) return fold`), and the shipped
   * profile mounts the tool with its default `legacy` mode. Reading it would
   * silently never fire, which is the worst kind of failure.
   *
   * So this reads the two events the tool itself produces — `tool/call` carries
   * the questions, `tool/result` carries the answers — and selects ours by the
   * question id rather than by matching prose.
   *
   * `{ global: true }` is what makes a plugin receive events from Sessions it
   * does not own; the official `user-questions` plugin uses the same option for
   * the same purpose.
   * @param ctx - Host context to subscribe on.
   * @returns the disposer the owning effect drops on unload.
   */
  private observeSessions(ctx: Context): () => void {
    const off = ctx.on('session/event', (session, event) => {
      try {
        this.observeEvent(session.id, event)
      } catch (error: unknown) {
        // An observation failure must never reach the Session's own append path.
        ctx.logger.warn('project-groups: spec-drift observation failed: %o', error)
      }
    }, { global: true })
    return () => {
      off()
      this.pendingDriftCalls.clear()
    }
  }

  /**
   * Apply one Session event to the drift bookkeeping.
   * @param sessionId - the Session the event belongs to.
   * @param event - the event.
   */
  private observeEvent(sessionId: SessionId, event: SessionEventLike): void {
    if (event.type === 'tool/call') {
      const call = asToolCall(event.data)
      if (call === undefined || call.name !== 'ask_user_question') return
      if (!this.askCarriesDriftQuestion(call.arguments)) return
      const domain = this.domain
      if (domain === undefined) return
      const projectId = this.projectOfSession(domain, sessionId)
      if (projectId === undefined) return
      this.pendingDriftCalls.set(call.callId, { sessionId, projectId })
      return
    }
    if (event.type !== 'tool/result') return
    const result = asToolResult(event.data)
    if (result === undefined) return
    const pending = this.pendingDriftCalls.get(result.message.toolCallId)
    if (pending === undefined) return
    this.pendingDriftCalls.delete(result.message.toolCallId)
    // A failed call carries no answer; the question simply returns next time.
    if (result.message.isError === true) return
    const label = firstAnswerLabel(result.message.content)
    if (label === undefined) return
    const choice = matchSpecDriftChoice(label)
    // An unmatched label records nothing, which is the safe outcome: the model
    // rewrote a label we could not verify, and acting on a guess could rewrite a
    // document the user asked to keep.
    if (choice === undefined) return
    void this.applyDriftChoice(pending.projectId, choice).catch((error: unknown) => {
      this.ctx.logger.warn('project-groups: recording the spec-drift choice failed: %o', error)
    })
  }

  /**
   * Whether one `ask_user_question` argument JSON asks our drift question.
   *
   * The id is the selector; the prompt tells the model to reuse it verbatim, and
   * a mismatch simply means this is somebody else's question.
   * @param raw - the model's raw argument JSON.
   * @returns true when one of the questions carries our id.
   */
  private askCarriesDriftQuestion(raw: string): boolean {
    const parsed = parseJsonObject(raw)
    const questions = parsed?.questions
    if (!Array.isArray(questions)) return false
    return questions.some(question => isRecord(question) && question.id === SPEC_DRIFT_QUESTION_ID)
  }

  /**
   * Record the user's choice.
   *
   * The two durable choices both name the spec **content** they refer to, so a
   * later spec change re-opens the question; the middle choice deliberately
   * writes nothing, which is what makes it "this time" rather than "from now on".
   * @param projectId - the project whose document is under discussion.
   * @param choice - the matched choice.
   */
  private async applyDriftChoice(projectId: string, choice: SpecDriftChoice): Promise<void> {
    const domain = await this.ready()
    const record = domain.table('projects').get(projectId)
    if (record === undefined) return
    if (choice === 'skip') return
    const spec = specIdentity(this.ctx, domain.global.get(), record)
    if (spec.sha1 === undefined) return
    const now = new Date().toISOString()
    const { docSpecIgnored: _previous, ...rest } = record
    const next: ProjectRecord = choice === 'rewrite'
      // Aligned: the model was told, in the same snapshot that asked the
      // question, to rewrite the document when this option was chosen.
      ? { ...rest, docSpecUsed: spec.sha1, updatedAt: now }
      // Dismissed until the spec changes, which a different hash expresses.
      : { ...rest, docSpecIgnored: spec.sha1, updatedAt: now }
    await domain.table('projects').put(projectId, next)
  }

  /**
   * Open this plugin's domain once, on first use.
   *
   * Deferred rather than done in the constructor because `open` is async and a
   * Service constructor is not; a composition that never touches projects pays
   * nothing for it.
   * @returns the open domain.
   */
  private async ready(): Promise<Domain<typeof projectDomainSpec>> {
    this.opening ??= (async () => {
      this.domain = await this.ctx.storageDomain.open(projectDomainSpec)
      // A marker left by a crash is cleared before any reader can observe the
      // half-applied state, and before a later mutation could overwrite the only
      // durable record of what still needs repairing.
      await this.recoverPendingMutation(this.domain)
      this.detach = this.ctx.on('domain/changed', (change) => {
        if (change.domain !== PROJECT_DOMAIN_NAME) return
        for (const wake of [...this.followers]) wake()
      })
    })()
    await this.opening
    /* v8 ignore next -- the open assigned `domain`, or it threw and this line is unreachable. */
    return this.domain as Domain<typeof projectDomainSpec>
  }

  private async close(): Promise<void> {
    const domain = this.domain
    this.detach?.()
    this.detach = undefined
    this.domain = undefined
    this.opening = undefined
    this.followers.clear()
    if (domain !== undefined) await domain.close()
  }

  /** Current display order; empty before the first order write. */
  private order(): readonly string[] {
    return this.domain?.global.get().projectIds ?? []
  }

  /**
   * Finish whatever a previous process left in flight.
   *
   * A marker names one compound mutation that did not complete. Its id is absent
   * from `projectIds` whichever direction it was going (see `pendingMutation` in
   * `spec.ts`), so the leftover is always the record set, and removing every
   * trace of that project is the whole repair. Nothing can reference it: an
   * assignment is only written after `assign` has seen the record exist.
   *
   * The sweep is wider than the official registry's single-record delete because
   * a delete here touches four tables, so an interruption can strand an
   * assignment, an expansion or an order alongside the record. Deleting a set
   * that is partly absent is a no-op per missing key, so this is idempotent —
   * which matters, because it also runs before the next mutation and again on
   * every start.
   * @param domain - the open domain.
   */
  private async recoverPendingMutation(domain: Domain<typeof projectDomainSpec>): Promise<void> {
    const pending = domain.global.get().pendingMutation
    if (pending === undefined) return
    const { projectId } = pending
    for (const [sessionId, record] of [...domain.table('assignments').entries()]) {
      if (record.projectId === projectId) await domain.table('assignments').delete(sessionId)
    }
    await domain.table('projects').delete(projectId)
    await domain.table('expansions').delete(projectId)
    await domain.table('orders').delete(projectId)
    await this.setGlobal(domain, { pendingMutation: undefined })
  }

  /**
   * Run one compound mutation on the shared tail, finishing any interrupted
   * predecessor first.
   *
   * Recovery runs inside the slot rather than only at startup because a marker
   * left behind must be cleared before this operation writes its own — otherwise
   * this one would overwrite the record of what still needs repairing.
   * @param domain - the open domain.
   * @param operation - the mutation to run.
   * @returns the operation's result.
   */
  private operate<T>(
    domain: Domain<typeof projectDomainSpec>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = this.operationTail.then(async () => {
      await this.recoverPendingMutation(domain)
      return await operation()
    })
    // The tail observes failure without adopting it: a rejected mutation must not
    // poison every later one. Same shape as the official registry's chain.
    this.operationTail = result.then(() => {}, () => {})
    return result
  }

  /**
   * Reject a title another project already uses.
   *
   * Titles are unique, the way Workspace titles are: `dsh-client-ui-workspace` blocks a rename
   * whose trimmed title another row holds (`workspaces.some(w => w.workspaceId !==
   * renameTarget.workspaceId && w.title === renameTrimmed)`). That check only guards its own
   * dialog, so the rule is enforced here as well — the Remote is a public entry point, and a
   * caller that skips the dialog would otherwise be able to create two indistinguishable rows.
   *
   * Compared after trimming, because the trimmed title is what gets stored: `'a '` and `'a'` are
   * the same name. Otherwise exact and case-sensitive, mirroring the dialog's `===`; being
   * stricter here would refuse a name that dialog accepted.
   * @param domain - the open domain.
   * @param title - the trimmed candidate title.
   * @param exceptId - project allowed to keep this title (itself, on a rename).
   */
  private assertTitleFree(
    domain: Domain<typeof projectDomainSpec>,
    title: string,
    exceptId?: string,
  ): void {
    // Scanned over the table rather than `order()`: the order is the display list, and a record
    // that is not in it must still reserve its name — otherwise two records could hold one title
    // and the duplicate would surface the moment either became visible. Recovery keeps the set
    // free of interrupted creates; this remains a guard against external corruption.
    for (const [id, record] of domain.table('projects').entries()) {
      if (id !== exceptId && record.title === title) {
        throw new Error(`a project named "${title}" already exists`)
      }
    }
  }

  /**
   * Write the global singleton, changing only the fields given.
   *
   * `Domain.global.set` replaces the whole value rather than merging into it, so
   * every writer must spread what is already stored. Routing them all through
   * here means a writer cannot drop a field it does not know about — which is
   * exactly what the type checker caught when `newSessionTarget` was added to a
   * singleton three existing call sites were writing whole.
   * @param domain - the open domain.
   * @param patch - the fields to change.
   */
  /**
   * Merge a patch into the global record, serialized against every other global
   * write.
   *
   * The read and the write are one critical section: `get()` runs only after the
   * previous write in the chain has settled, so no two overlapping callers can
   * read the same snapshot. The chain continues past a failure — a rejected write
   * must not wedge every later one — and the failure still reaches its own caller.
   *
   * **Deliberately not merged into one verb per field pair.** A combined
   * `setDocSpecModeAndFileName` would fix the reported symptom while leaving the
   * hazard for the next pair of fields, which is why the queue is here instead.
   * @param domain - the open domain.
   * @param patch - the fields to merge into the stored global.
   * @returns when this write has landed.
   */
  private async setGlobal(
    domain: Domain<typeof projectDomainSpec>,
    patch: Partial<GlobalRecord>,
  ): Promise<void> {
    const write = this.globalWriteChain.then(() =>
      domain.global.set({ ...domain.global.get(), ...patch }))
    // Keep the chain alive after a rejection while letting this caller observe it.
    this.globalWriteChain = write.then(() => undefined, () => undefined)
    return write
  }

  private projectValue(projectId: string, record: ProjectRecord): ProjectValue {
    return {
      projectId,
      title: record.title,
      // Copied, not aliased: the projection crosses the Remote boundary, and the
      // record's own array must not become reachable to a client that could
      // mutate it in place.
      directories: [...record.directories],
      docPath: record.docPath,
      // Spread rather than assigned as `undefined`: these are optional on the
      // wire, and an explicit `undefined` key would survive JSON round-tripping
      // as `null` — a value neither side treats as "inherits".
      ...record.docSpec !== undefined ? { docSpec: record.docSpec } : {},
      ...record.docSpecUsed !== undefined ? { docSpecUsed: record.docSpecUsed } : {},
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  /**
   * Register this plugin's runtime-context contribution for the lifetime of the
   * injected scope.
   *
   * Scoped to the child fiber `ctx.inject` created, so it is disposed with the
   * plugin and needs no separate effect: a disabled plugin contributes nothing,
   * which is what "switching it off restores the official chain" means
   * mechanically — there is nothing left to clean up.
   * @param scope - the context whose scope owns the contribution.
   */
  private installInjection(scope: Context): void {
    const prompt = scope.get('systemPrompt') as SystemPromptFace | undefined
    // A composition without the prompt registry gets no contribution. Not an
    // error: none of this plugin's own verbs depends on a prompt.
    if (prompt === undefined) return
    prompt.context({
      name: INJECTION_CONTEXT_NAME,
      order: INJECTION_CONTEXT_ORDER,
      text: (context) => this.injectionText(context),
    })
  }

  /**
   * Render this plugin's contribution for one assembly.
   *
   * Synchronous because `PromptContext.text` is: the registry renders during
   * request preparation and cannot await. Every read below is therefore an
   * in-memory domain read, which is what `Domain` provides — tables and the
   * global singleton are synchronous, only opening and writing are not.
   *
   * The provider is evaluated for every prepared request, but the registry
   * commits a message only when the composed text differs from the one it
   * retained (`agent-loop/src/runtime-context.ts`), so an unchanged project costs
   * nothing in history. That is also why an edit becomes visible on the next
   * request: the text is re-derived rather than cached here.
   * @param context - the assembly's context; `agent` is absent on bare assemblies.
   * @returns the contribution, or `''` to contribute nothing.
   */
  private injectionText(context: PromptAssemblyContext): string {
    const sessionId = context.agent?.session?.id
    // No agent means a diagnostic or bare assembly, with no Session to describe.
    if (sessionId === undefined) return ''

    const domain = this.domain
    if (domain === undefined) {
      // The domain opens lazily on first use, and this provider can run before any
      // Remote call has. Start the open now — it is idempotent — and contribute
      // nothing for this one request rather than rendering a half-known state.
      void this.ready().catch((error: unknown) => {
        this.ctx.logger.warn('project-groups: the project domain could not be opened for injection: %o', error)
      })
      return ''
    }

    // The base switch is the master: with it off this plugin contributes nothing
    // at all, and the settings card disables the document switch to say so.
    if (!domain.global.get().injectProjectInfo) return ''

    const projectId = this.projectOfSession(domain, sessionId)
    const project = projectId === undefined ? undefined : domain.table('projects').get(projectId)
    // The document lines need a project to hang from: its record supplies the
    // `docSpecUsed` the drift check compares, and an unfiled Session has none.
    const document = projectId === undefined || project === undefined || !domain.global.get().injectProjectDoc
      ? undefined
      : this.documentInjection(domain, projectId, project)
    return renderProjectInjection({ project, document })
  }

  /**
   * Assemble the document half of the contribution for one filed project.
   *
   * ## Why the hashing happens here and not in the renderer
   *
   * `renderProjectInjection` is pure and covered by tests that pass plain
   * objects. Reading the spec file is I/O, so it stays on this side and the
   * renderer receives a finished value. This is also the only place that knows
   * the configured locale, which the drift question needs.
   *
   * ## Why a missing `docSpecUsed` never reports drift
   *
   * That field is absent exactly when the document has never been written, and a
   * document that does not exist has nothing to migrate. Asking about it would
   * send the user a question whose first option ("rewrite the existing document")
   * has nothing to act on.
   * @param domain - the open domain.
   * @param projectId - the owning project id.
   * @param project - its record.
   * @returns the document lines, including the drift prompt when it applies.
   */
  private documentInjection(
    domain: Domain<typeof projectDomainSpec>,
    projectId: string,
    project: ProjectRecord,
  ): DocumentInjection {
    const global = domain.global.get()
    const spec = specIdentity(this.ctx, global, project)
    const docPath = documentPath(this.ctx, projectId)

    // The drift decision lives in `shouldAskSpecDrift` (pure, and covered directly
    // by `verify-project-injection.mjs`) because its effect is an ABSENCE — no
    // drift text appears — which the rendered-text assertions cannot see. Its
    // doc comment carries the reasoning, including why 无 never asks: migration
    // needs a target spec, and 无 means "no format update".
    //
    // The stored `docSpecUsed` is deliberately left ALONE, which is what makes the
    // round trip work: returning to the same spec later compares equal and stays
    // silent, while switching to a genuinely different one still reports.
    const drift = shouldAskSpecDrift({
      usedSha1: project.docSpecUsed,
      ignoredSha1: project.docSpecIgnored,
      currentSha1: spec.sha1,
    })
      ? { locale: this.injectionLocale(), rewriteFlowPath: REWRITE_FLOW_PATH }
      : undefined

    return { docPath, specMode: spec.mode, specPath: spec.path, drift }
  }

  /**
   * The locale for user-facing injection text.
   *
   * Read from the launcher's settings document, where the `locale` entry keeps
   * its `preference`. The Host cannot see the operating-system language — the
   * Desktop preload hands that straight to the browser — so an absent preference
   * means "follow the system", and Chinese is the honest default for this
   * deployment while an explicit choice is what makes the answer exact.
   * @returns the locale to render the drift question in.
   */
  private injectionLocale(): InjectionLocale {
    try {
      const settings = this.ctx.get('settings') as { describe?: () => readonly SettingsDescriptorLike[] } | undefined
      const locale = settings?.describe?.().find(entry => entry.ns === 'locale')
      const value = locale?.value as { readonly preference?: unknown } | undefined
      return value?.preference === 'en' ? 'en' : 'zh'
    } catch {
      // A diagnostic read must never break an assembly; falling back is correct.
      return 'zh'
    }
  }

  /**
   * Resolve the project owning one Session, following subagent lineage.
   *
   * ## Why this walk exists
   *
   * A subagent's session never reaches `assignments`: only `session.create` with a
   * `workspaceId` attaches anything, and a delegated child is created through the
   * Agent registry instead. Without this, every delegated child would report itself
   * ungrouped even though it is working inside its parent's project.
   *
   * ## Mirrored from the official walk
   *
   * The shape copies `underArchivedSession`
   * (`packages/api/session-controller/src/archived-session-gate.ts`):
   * the same synchronous store hop, the same `origin === 'subagent'` gate on the
   * edge, and the same visited set against a corrupt lineage. That function is the
   * one to copy rather than `forkWorkspace`, which answers the same question with
   * an async `sessionQuery.traceSession()` and is therefore only usable from an
   * occasional caller — this runs for every prepared request.
   *
   * ## A closed ancestor is still readable
   *
   * The parent's **project** is available even after that parent Session has
   * closed: `assignments` is this plugin's own durable table keyed by session id,
   * and the id survives in `header.parentSession`. Only climbing *past* the
   * ancestor needs the live store. The official walk reads its set the same way —
   * `archived.includes(parentId)` when the parent Session is absent.
   * @param domain - the open domain.
   * @param sessionId - the Session whose owning project is required.
   * @returns the owning project id, or undefined when the Session is unfiled.
   */
  private projectOfSession(
    domain: Domain<typeof projectDomainSpec>,
    sessionId: SessionId,
  ): string | undefined {
    const assignments = domain.table('assignments')

    // The Session itself: the common case, and the only case for an ordinary one.
    const direct = assignments.get(String(sessionId))?.projectId
    if (direct !== undefined) return direct

    const sessions = this.ctx.get('sessions') as SessionsFace | undefined
    if (sessions === undefined) return undefined

    let header = sessions.get(sessionId)?.header
    if (header === undefined) return undefined
    // Only a subagent's parent is a candidate ancestor. A fork of a filed Session
    // is an independent conversation — the judgement the official walk documents
    // on its own `origin` check.
    if (header.origin !== 'subagent') return undefined

    const visited = new Set<SessionId>([sessionId])
    while (header.parentSession !== undefined) {
      const parentId = header.parentSession
      if (visited.has(parentId)) return undefined // cycle in a corrupt lineage
      visited.add(parentId)
      const filed = assignments.get(String(parentId))?.projectId
      if (filed !== undefined) return filed
      const parent = sessions.get(parentId)
      // A closed ancestor cannot be inspected further: the store holds live
      // Sessions only, and the next parent id rides on a header we cannot read.
      // Stopping is the honest answer; continuing would mean guessing.
      if (parent === undefined) return undefined
      header = parent.header
      if (header.origin !== 'subagent') return undefined
    }
    return undefined
  }

  /**
   * The complete Client projection: projects in display order, the order itself,
   * and every assignment.
   *
   * Derived from the order alone, the way the official registry derives its list
   * from `workspaceIds` (`workspace/src/index.ts`). A record whose id has not
   * reached the order is **not** part of the projection, and that is what makes a
   * create one visible transition: the interval between the record write and the
   * order write is indistinguishable from the state before it, so the client's
   * value-equality guard drops that frame and only the completed write renders.
   * Listing such a record instead — appended below the ordered rows — showed the
   * new row at the bottom and then moved it to the top, which read as a slide.
   *
   * Nothing is lost by not rendering it: a record can only be order-less while a
   * mutation is in flight, and `recoverPendingMutation` removes whatever an
   * interruption left, so the state cannot persist across a start.
   * @returns the baseline a following generation opens with.
   */
  @Remote('baseline')
  async baseline(): Promise<ProjectBaseline> {
    const domain = await this.ready()
    const projects = domain.table('projects')
    const assignments = domain.table('assignments')
    const ordered = this.order().filter(id => projects.get(id) !== undefined)
    return {
      projects: ordered.map(id => this.projectValue(id, projects.get(id) as ProjectRecord)),
      projectIds: ordered,
      assignments: Object.fromEntries(
        [...assignments.entries()].map(([sessionId, record]) => [sessionId, record.projectId]),
      ),
      // Only recorded rows appear: an absent entry means "never touched", which
      // the browser needs to distinguish from an explicit `false`.
      expansions: Object.fromEntries(
        [...domain.table('expansions').entries()].map(([projectId, record]) => [projectId, record.expanded]),
      ),
      // Likewise only recorded rows: an absent project has no manual order, so
      // the browser derives member position from recency.
      orders: Object.fromEntries(
        [...domain.table('orders').entries()].map(([projectId, record]) => [projectId, [...record.sessionIds]]),
      ),
      // The stored global is parsed through the spec's schema on open, so a unit
      // written before this field existed already reads back as its default.
      newSessionTarget: domain.global.get().newSessionTarget,
      baseWorkspace: domain.global.get().baseWorkspace,
      createOpensSession: domain.global.get().createOpensSession,
      injectProjectInfo: domain.global.get().injectProjectInfo,
      injectProjectDoc: domain.global.get().injectProjectDoc,
      docSpecMode: domain.global.get().docSpecMode,
      docSpecFileName: domain.global.get().docSpecFileName,
      perProjectDocSpec: domain.global.get().perProjectDocSpec,
      // Read here rather than kept in memory: the directory is the source of
      // truth for what has been uploaded, and a spec dropped in by hand should
      // appear on the next reconnect without a restart.
      specs: await listUploadedSpecs(this.ctx),
    }
  }

  /**
   * Create a project, at the **front** of the display order.
   *
   * Prepend rather than append, matching the Host's own Workspace registry
   * (`packages/workspace/workspace/src/index.ts`: `workspaceIds: [id,
   * ...state.workspaceIds]`). A new row appears where the user is looking instead
   * of below however many rows already exist, which is what makes a long list
   * workable.
   *
   * Three writes, in the official registry's order — marker, record, order — and
   * the sequence carries two separate guarantees:
   *
   * - **The order is written last**, so an interruption always leaves the id
   *   absent from `projectIds` and the record as the only thing recovery has to
   *   name. Writing it earlier would strand the id there, where the marker
   *   cannot reach it.
   * - **The marker is its own write**, even though it shares the global with the
   *   order. Folding the two together would publish the id in the order while
   *   the record does not yet exist, which is the same stranding with extra
   *   steps.
   *
   * Only the last write changes the projection, so the sidebar renders one
   * insert. The first two produce frames that are value-equal to the one before
   * them, and the client drops those (`src/client/projects.ts` compares by
   * value before publishing). Without that, the record-only frame would show the
   * new row appended below the ordered ones and then move it to the top, which
   * reads as a slide.
   * @param request - display title; surrounding whitespace is trimmed.
   * @returns the created project.
   */
  @Remote('create')
  async create(request: ProjectCreateRequest): Promise<ProjectValueResult> {
    const title = request.title.trim()
    if (title === '') throw new Error('a project title is required')
    // Copied out of the request before any write: a caller that reuses or mutates
    // the array afterwards must not be able to reach stored state.
    const directories = [...(request.directories ?? [])]
    // Validated by the same guard `setProjectDocSpec` uses. Before this, `create`
    // stored whatever arrived while the edit path refused values it did not know —
    // so a value was storable or not depending on which dialog was open.
    assertUsableDocSpec(request.docSpec)
    const domain = await this.ready()
    return await this.operate(domain, async () => {
      this.assertTitleFree(domain, title)
      const projectId = newProjectId()
      const now = new Date().toISOString()
      const record: ProjectRecord = {
        title,
        directories,
        docPath: '',
        // Spread rather than assigned as `undefined`: the schema's `optional`
        // means "inherit the global choice" must leave the key absent, and a
        // present-but-undefined field would survive a JSON round trip as null.
        ...request.docSpec !== undefined && request.docSpec !== null ? { docSpec: request.docSpec } : {},
        createdAt: now,
        updatedAt: now,
      }
      await this.setGlobal(domain, { pendingMutation: { operation: 'create', projectId } })
      await domain.table('projects').put(projectId, record)
      await this.setGlobal(domain, {
        projectIds: [projectId, ...this.order()],
        pendingMutation: undefined,
      })
      return { project: this.projectValue(projectId, record) }
    })
  }

  /**
   * Replace one project's title and directories in a single write.
   *
   * ## Why one verb and one write
   *
   * The edit dialog commits both fields with one button. A title write followed
   * by a directory write would leave the row retitled while its directories were
   * still the old ones — a state the user never asked for and can observe — and a
   * failure between the two calls would leave exactly that state durably. A table
   * `put` replaces the whole record, so doing both here costs nothing over one.
   *
   * These two fields are also the whole of what a project is to its owner: its
   * name and where it lives. Separate verbs would make "edit a project" a
   * caller-side protocol rather than a domain operation.
   *
   * ## What it preserves
   *
   * Every field it does not name, `docPath` included: the record is spread and
   * re-put rather than rebuilt, so a field added later cannot be dropped here.
   *
   * ## Validation
   *
   * The title is trimmed, must be non-blank, and must be free — the same rule the
   * former `rename` enforced and which `create` shares, excluded by id so
   * re-submitting a project's own name is not a conflict with itself. Directories
   * are **not** validated: they are user-declared associations, not proofs (see
   * {@link setDirectories}).
   * @param request - target project, its complete title and directory list.
   * @returns the project as stored.
   */
  @Remote('update')
  async update(request: ProjectUpdateRequest): Promise<ProjectUpdateValue> {
    const title = request.title.trim()
    if (title === '') throw new Error('a project title is required')
    const domain = await this.ready()
    const record = domain.table('projects').get(request.projectId)
    if (record === undefined) throw new Error(`unknown project: ${request.projectId}`)
    this.assertTitleFree(domain, title, request.projectId)
    const next: ProjectRecord = {
      ...record,
      title,
      directories: [...request.directories],
      updatedAt: new Date().toISOString(),
    }
    await domain.table('projects').put(request.projectId, next)
    return { project: this.projectValue(request.projectId, next) }
  }

  /**
   * Remove one project, every assignment onto it, and its presentation records.
   *
   * Sessions are not touched: an assignment is this plugin's own record, and a
   * Session without one is simply Ungrouped. The expansion and order go with the
   * project because both are keyed by project id and would otherwise be
   * unreachable state.
   *
   * The order is written **first** here, the mirror of create and the official
   * registry's shape (`workspace/src/index.ts`). The row leaves the display
   * before its records are dropped, so an interruption leaves the id absent from
   * `projectIds` — which is what lets recovery treat a half-finished delete
   * exactly like a half-finished create: delete the record set, clear the
   * marker. Writing the order last would leave the id in it with nothing to
   * name, and the marker could not repair that.
   *
   * It also makes the row disappear on the first write rather than after four
   * table sweeps, which is what the user is watching.
   * @param request - target project.
   */
  @Remote('delete')
  async remove(request: ProjectDeleteRequest): Promise<void> {
    const domain = await this.ready()
    await this.operate(domain, async () => {
      await this.setGlobal(domain, {
        projectIds: this.order().filter(id => id !== request.projectId),
        pendingMutation: { operation: 'delete', projectId: request.projectId },
      })
      for (const [sessionId, record] of [...domain.table('assignments').entries()]) {
        if (record.projectId === request.projectId) await domain.table('assignments').delete(sessionId)
      }
      await domain.table('projects').delete(request.projectId)
      await domain.table('expansions').delete(request.projectId)
      await domain.table('orders').delete(request.projectId)
      await this.setGlobal(domain, { pendingMutation: undefined })
    })
  }

  /**
   * Move one project in display order.
   * @param request - project to move and the project it should precede.
   * @returns the new order.
   */
  @Remote('reorder')
  async reorder(request: ProjectReorderRequest): Promise<ProjectOrderValue> {
    const domain = await this.ready()
    const current = [...this.order()]
    if (!current.includes(request.projectId)) throw new Error(`unknown project: ${request.projectId}`)
    const rest = current.filter(id => id !== request.projectId)
    const index = request.beforeId === undefined ? rest.length : rest.indexOf(request.beforeId)
    if (index === -1) throw new Error(`unknown project: ${String(request.beforeId)}`)
    const projectIds = [...rest.slice(0, index), request.projectId, ...rest.slice(index)]
    await this.setGlobal(domain, { projectIds })
    return { projectIds }
  }

  /**
   * File one Session under one project, replacing any previous assignment.
   * @param request - Session and target project.
   * @returns the landed assignment.
   */
  @Remote('assign')
  async assign(request: ProjectAssignRequest): Promise<ProjectAssignmentValue> {
    const domain = await this.ready()
    if (domain.table('projects').get(request.projectId) === undefined) {
      throw new Error(`unknown project: ${request.projectId}`)
    }
    await domain.table('assignments').put(request.sessionId, {
      projectId: request.projectId,
      assignedAt: new Date().toISOString(),
    })
    return { sessionId: request.sessionId, projectId: request.projectId }
  }

  /**
   * Return one Session to Ungrouped.
   * @param request - Session to unassign.
   * @returns whether an assignment was removed.
   */
  @Remote('unassign')
  async unassign(request: ProjectUnassignRequest): Promise<ProjectUnassignValue> {
    const domain = await this.ready()
    const removed = await domain.table('assignments').delete(request.sessionId)
    return { sessionId: request.sessionId, removed }
  }

  /**
   * Record one project row's open/closed state.
   *
   * Stored here rather than in the browser's view store because that store is
   * shared with the official plugin, whose mount prunes every key that is not a
   * Workspace id — so a project's expansion kept there is lost the first time the
   * official sidebar mounts, which is precisely what switching this plugin off
   * does.
   *
   * A write is always recorded, `false` included: "folded deliberately" and
   * "never touched" must stay distinguishable, since only the latter lets the
   * browser open the group holding the current Session.
   * @param request - target project and its new state.
   * @returns the recorded state.
   */
  @Remote('setExpanded')
  async setExpanded(request: ProjectSetExpandedRequest): Promise<ProjectExpansionValue> {
    const domain = await this.ready()
    if (domain.table('projects').get(request.projectId) === undefined) {
      throw new Error(`unknown project: ${request.projectId}`)
    }
    await domain.table('expansions').put(request.projectId, { expanded: request.expanded })
    return { projectId: request.projectId, expanded: request.expanded }
  }

  /**
   * Replace the manual order of every project.
   *
   * Whole-map, because the callers need exactly that: a drop rewrites the target
   * project and freezes the rest, switching to manual freezes all of them, and
   * switching to recency discards them all. A project absent from the request has
   * its record **deleted** — that is what makes recency mode mean "no manual
   * order" rather than "a stale one".
   *
   * Writes are diffed against what is stored. Every landed write makes the
   * follower re-project, so skipping unchanged projects keeps a frame's cost
   * proportional to the real change rather than to the number of projects.
   *
   * Unknown project ids are dropped, not refused: they can only come from a race
   * with a delete, and refusing would turn that race into a lost drag.
   * @param request - the complete order map to store.
   * @returns the map the Host actually holds.
   */
  @Remote('setOrders')
  async setOrders(request: ProjectSetOrdersRequest): Promise<ProjectOrdersValue> {
    const domain = await this.ready()
    const projects = domain.table('projects')
    const orders = domain.table('orders')
    const next = Object.fromEntries(
      Object.entries(request.orders)
        .filter(([projectId]) => projects.get(projectId) !== undefined)
        .map(([projectId, sessionIds]) => [projectId, [...sessionIds]]),
    )
    for (const projectId of [...orders.keys()]) {
      if (next[projectId] === undefined) await orders.delete(projectId)
    }
    for (const [projectId, sessionIds] of Object.entries(next)) {
      const stored = orders.get(projectId)?.sessionIds
      const unchanged = stored !== undefined && stored.length === sessionIds.length
        && stored.every((id, index) => id === sessionIds[index])
      if (!unchanged) await orders.put(projectId, { sessionIds })
    }
    return { orders: next }
  }

  /**
   * Choose where a New Session with no stated destination lands.
   *
   * The stored global is spread before the write because `Domain.global.set`
   * replaces the whole singleton rather than merging into it: sending only the
   * target would drop `projectIds` and make every project disappear from the
   * sidebar.
   * @param request - the chosen destination.
   * @returns the stored choice.
   */
  @Remote('setNewSessionTarget')
  async setNewSessionTarget(
    request: ProjectSetNewSessionTargetRequest,
  ): Promise<ProjectNewSessionTargetValue> {
    const domain = await this.ready()
    await this.setGlobal(domain, { newSessionTarget: request.target })
    return { target: request.target }
  }

  /**
   * Choose whether creating a project also opens a Session inside it.
   *
   * The stored global is spread before the write because `Domain.global.set`
   * replaces the whole singleton rather than merging into it: sending only this
   * value would drop `projectIds` and make every project disappear from the
   * sidebar.
   * @param request - the chosen behaviour.
   * @returns the stored value.
   */
  @Remote('setCreateOpensSession')
  async setCreateOpensSession(
    request: ProjectSetCreateOpensSessionRequest,
  ): Promise<ProjectCreateOpensSessionValue> {
    const domain = await this.ready()
    await this.setGlobal(domain, { createOpensSession: request.value })
    return { value: request.value }
  }

  /**
   * Replace one project's associated directories.
   *
   * **Whole-list**, matching {@link setOrders}: the caller is the edit dialog,
   * which already holds the complete list it wants stored, so a partial add/remove
   * protocol would only force the Host to reconstruct intent it was never given.
   *
   * The record is spread and re-put rather than field-updated, because a table
   * `put` replaces the whole value — writing only `directories` would silently
   * drop the title and the document binding.
   *
   * `updatedAt` is stamped, exactly as {@link rename} stamps it: the list is part
   * of what a project *is*, so a change to it is a real mutation rather than a
   * presentation-only write.
   *
   * Directories are **not** validated. They are user-declared associations, not
   * filesystem proofs: a directory may be planned, temporarily offline, or on a
   * drive that is not mounted right now, and refusing the write would make the
   * setting unusable in precisely those cases. Nothing in this plugin resolves
   * them, so an unresolvable entry costs nothing until something tries to read it.
   * @param request - target project and its complete directory list.
   * @returns the list as stored.
   */
  @Remote('setDirectories')
  async setDirectories(request: ProjectSetDirectoriesRequest): Promise<ProjectDirectoriesValue> {
    const domain = await this.ready()
    const record = domain.table('projects').get(request.projectId)
    if (record === undefined) throw new Error(`unknown project: ${request.projectId}`)
    // Copied both ways: out of the request (the caller may reuse the array) and
    // into the response, so the stored value is never aliased across the boundary.
    const directories = [...request.directories]
    await domain.table('projects').put(request.projectId, {
      ...record,
      directories,
      updatedAt: new Date().toISOString(),
    })
    return { projectId: request.projectId, directories: [...directories] }
  }

  /**
   * Choose whether a Session's project info is injected.
   *
   * Written through {@link setGlobal}, which spreads the stored singleton: a whole
   * write would drop `projectIds` and empty the sidebar.
   * @param request - the chosen behaviour.
   * @returns the stored value.
   */
  @Remote('setInjectProjectInfo')
  async setInjectProjectInfo(
    request: ProjectSetInjectProjectInfoRequest,
  ): Promise<ProjectInjectProjectInfoValue> {
    const domain = await this.ready()
    await this.setGlobal(domain, { injectProjectInfo: request.value })
    return { value: request.value }
  }

  /**
   * Choose whether the work-document line is injected alongside the base info.
   *
   * Independent of {@link setInjectProjectInfo} on purpose: the document is the
   * extra feature, so its switch governs one line rather than riding the base
   * switch. The injection itself reads both flags — the document line is emitted
   * only when **this** is on, and the base block only when the other is.
   * @param request - the chosen behaviour.
   * @returns the stored value.
   */
  @Remote('setInjectProjectDoc')
  async setInjectProjectDoc(
    request: ProjectSetInjectProjectDocRequest,
  ): Promise<ProjectInjectProjectDocValue> {
    const domain = await this.ready()
    await this.setGlobal(domain, { injectProjectDoc: request.value })
    return { value: request.value }
  }

  /**
   * Choose which spec source applies before any per-project override.
   *
   * Switching modes keeps `docSpecFileName`: it records which file the user last
   * uploaded, so returning to `'custom'` restores that choice rather than
   * forcing another upload. Readers branch on the mode, so a retained name
   * cannot be mistaken for an active one.
   * @param request - the chosen mode.
   * @returns the stored mode.
   */
  @Remote('setDocSpecMode')
  async setDocSpecMode(request: ProjectSetDocSpecModeRequest): Promise<ProjectDocSpecModeValue> {
    const domain = await this.ready()
    await this.setGlobal(domain, { docSpecMode: request.mode })
    return { mode: request.mode }
  }

  /**
   * Name the uploaded spec that `'custom'` mode refers to.
   *
   * An empty name is accepted and stored: it is the state the card renders as
   * "selected but not chosen yet", and refusing it would make switching to
   * `'custom'` before picking a file impossible.
   * @param request - the bare `*.md` file name, or `''`.
   * @returns the stored name.
   */
  @Remote('setDocSpecFileName')
  async setDocSpecFileName(request: ProjectSetDocSpecFileNameRequest): Promise<ProjectDocSpecFileNameValue> {
    const name = request.name.trim()
    // A non-empty name must be one this plugin could actually resolve, or the
    // setting would name a file that can never be read.
    if (name !== '' && !isSafeSpecName(name)) {
      throw new Error(`not a usable spec file name: ${JSON.stringify(request.name)}`)
    }
    const domain = await this.ready()
    await this.setGlobal(domain, { docSpecFileName: name })
    return { name }
  }

  /**
   * Choose whether the project dialogs expose a per-project spec row.
   * @param request - the chosen behaviour.
   * @returns the stored value.
   */
  @Remote('setPerProjectDocSpec')
  async setPerProjectDocSpec(
    request: ProjectSetPerProjectDocSpecRequest,
  ): Promise<ProjectPerProjectDocSpecValue> {
    const domain = await this.ready()
    await this.setGlobal(domain, { perProjectDocSpec: request.value })
    return { value: request.value }
  }

  /**
   * Set or clear one project's spec override.
   *
   * `null` clears the field rather than storing a sentinel, because absence is
   * what "inherit the global choice" means; `'none'` is a deliberate "no spec"
   * and must stay distinguishable from it.
   * @param request - the project and its override, or `null` to inherit.
   * @returns the override as stored.
   */
  @Remote('setProjectDocSpec')
  async setProjectDocSpec(
    request: ProjectSetProjectDocSpecRequest,
  ): Promise<ProjectProjectDocSpecValue> {
    const domain = await this.ready()
    const record = domain.table('projects').get(request.projectId)
    if (record === undefined) throw new Error(`no such project: ${request.projectId}`)
    // The shared guard. It is what lets `'none'` and `'default'` through: they are
    // semantic values, not file names, so `isSafeSpecName`'s `.md` requirement must
    // not apply — and `'default'` being refused here meant the dropdown's 默认 row
    // silently kept the previous value (measured: `not a usable spec file name`).
    assertUsableDocSpec(request.spec)
    const now = new Date().toISOString()
    // Spread and drop: the schema's `optional` means the key must be absent, not
    // present-and-undefined, for "inherit" to survive a JSON round trip.
    const { docSpec: _cleared, ...rest } = record
    const next: ProjectRecord = request.spec === null
      ? { ...rest, updatedAt: now }
      : { ...rest, docSpec: request.spec, updatedAt: now }
    await domain.table('projects').put(request.projectId, next)
    return { projectId: request.projectId, spec: request.spec }
  }

  /**
   * Store one uploaded spec.
   *
   * Refusing a taken name rather than replacing it is the surface's rule: the
   * file may have been hand-edited since it was uploaded, and destroying it
   * silently is worse than making the user rename. The reply carries the current
   * list so the caller refreshes in the same round trip.
   * @param request - the file name and its text.
   * @returns whether the write landed, plus the names now present.
   */
  @Remote('uploadSpec')
  async uploadSpec(request: ProjectUploadSpecRequest): Promise<ProjectUploadSpecValue> {
    const written = await writeUploadedSpec(this.ctx, request.name.trim(), request.content)
    return { written, specs: await listUploadedSpecs(this.ctx) }
  }

  /**
   * Delete one uploaded spec.
   *
   * The confirmation is the caller's: only the surface can tell the user which
   * projects reference the file, and this method deliberately does not check —
   * a project whose override points at a deleted file falls back to the global
   * choice, which `resolveSpec` already handles.
   * @param request - the file to remove.
   * @returns whether a file was removed, plus the remaining names.
   */
  @Remote('deleteSpec')
  async deleteSpec(request: ProjectDeleteSpecRequest): Promise<ProjectDeleteSpecValue> {
    const removed = await deleteUploadedSpec(this.ctx, request.name.trim())
    return { removed, specs: await listUploadedSpecs(this.ctx) }
  }

  /**
   * List the projects that would stop using the named spec if it were deleted.
   *
   * Read before the confirmation, while the file still exists, so the dialog can
   * say "N projects use this". A project counts when its **effective** spec is
   * that file, which includes projects inheriting it from the global choice.
   * @param request - the spec file name.
   * @returns the titles of the affected projects, sorted.
   */
  @Remote('specsUsedBy')
  async specsUsedBy(request: ProjectSpecsUsedByRequest): Promise<ProjectSpecsUsedByValue> {
    const domain = await this.ready()
    const global = domain.global.get()
    const titles: string[] = []
    for (const id of this.order()) {
      const record = domain.table('projects').get(id)
      if (record === undefined) continue
      const spec = resolveSpec(this.ctx, global, record)
      if (spec.mode === 'custom' && spec.fileName === request.name) titles.push(record.title)
    }
    return { titles: titles.sort((a, b) => a.localeCompare(b)) }
  }

  /**
   * Read one uploaded spec's text, for the surface's preview.
   * @param request - the spec file name.
   * @returns the text, or `null` when the file is absent.
   */
  @Remote('readSpec')
  async readSpec(request: ProjectReadSpecRequest): Promise<ProjectReadSpecValue> {
    return { content: await readUploadedSpec(this.ctx, request.name.trim()) ?? null }
  }

  /**
   * Choose the Workspace every New Session this plugin opens lands in.
   *
   * ## `path`/`name` are a **memory**, not part of the mode
   *
   * Switching to `'default'` **keeps** the stored `path` and `name`. They record which
   * Workspace the user last picked, so switching 默认 → 指定 restores that choice instead
   * of forcing them to pick again. Clearing them — which this did at first — made the
   * setting look like it could not be remembered at all, which is exactly how it was
   * reported.
   *
   * Every reader gates on `mode`, so a retained path cannot be mistaken for an active
   * one: the card's "已不存在" note only fires in `'specified'`, and the resolver branches
   * on `mode` too.
   *
   * A `'specified'` write without a path is still refused: it would be a setting that can
   * never resolve, which is the very failure this feature reports.
   *
   * The write goes through {@link setGlobal}, which spreads the stored singleton —
   * writing it whole would drop `projectIds` and empty the sidebar.
   * @param request - the chosen mode and, for `'specified'`, the Workspace.
   * @returns the setting as stored, including the retained memory for `'default'`.
   */
  @Remote('setBaseWorkspace')
  async setBaseWorkspace(request: ProjectSetBaseWorkspaceRequest): Promise<ProjectBaseWorkspaceValue> {
    const domain = await this.ready()
    if (request.mode === 'specified' && (request.path ?? '') === '') {
      throw new Error('a specified base workspace needs a path')
    }
    // The `'default'` arm routes through the shared helper so this half cannot drift from
    // the Client's optimistic write, which applies the same rule before the round trip.
    // The `'specified'` arm stays inline: it is genuinely asymmetric (an absent `name` is
    // cleared here, where `'default'` retains one).
    //
    // `request` is passed as the requested memory: the 更换… chooser replaces the
    // remembered Workspace WITHOUT switching the mode, so it sends the current mode plus
    // the newly picked path. Without this the helper would keep the OLD path and the
    // replacement would be silently discarded.
    const next: BaseWorkspaceSetting = request.mode === 'default'
      ? withDefaultMode(domain.global.get().baseWorkspace, request)
      : { mode: 'specified', path: request.path, name: request.name ?? '' }
    await this.setGlobal(domain, { baseWorkspace: next })
    return next
  }

  /**
   * Re-create the base Workspace: make its directory, then register it.
   *
   * Ordered, because registration requires the directory to exist — the registry resolves the path
   * with `realpathNormalize` and rejects a non-directory (measured: `workspace/invalid-path` when
   * the directory is absent, and also when only its parent exists).
   *
   * ## Why `mkdir -p`
   *
   * The realistic rebuild case is a path whose parents may be gone too. `recursive: true` is
   * idempotent for a directory that already exists, so it costs nothing in the common case and is
   * the difference between working and not in the other.
   *
   * ## Why the registry is read with `ctx.get` at call time
   *
   * The service is provided by `dsh-workspace`, which arrives about a second after this plugin's
   * `apply` runs (measured: absent at 0 ms and 250 ms, present at 1000 ms). Declaring it in `inject`
   * would hold this whole plugin inactive until then, and would make every project verb depend on a
   * service that has nothing to do with them. The ungated read also means a composition without it
   * degrades to a refused rebuild rather than a dead plugin.
   *
   * ## Why `'default'` mode is adopted rather than pointed at
   *
   * `initializeDefault` returns `entities.get(defaultWorkspaceId)` as soon as that field is set and
   * never falls through to creation, so after a deletion a re-registered path is an id the pointer
   * does not adopt and the dialog would reappear on the next click. Rewriting that pointer would
   * mean editing another plugin's durable state behind its invariants; instead this plugin records
   * the rebuilt path as **its own** `'specified'` setting, which its resolver does read. `mode` in
   * the result reports that, because it changes what the settings card shows.
   * @returns the Workspace now at the base path, and the setting's mode afterwards.
   */
  @Remote('rebuildBaseWorkspace')
  async rebuildBaseWorkspace(): Promise<ProjectRebuildBaseWorkspaceValue> {
    const domain = await this.ready()
    const stored = domain.global.get().baseWorkspace
    // The Host reads its own setting rather than accepting a path from the caller: one source of
    // truth, so the dialog cannot rebuild something other than what it displayed.
    const usesStoredPath = stored.mode === 'specified'
    const path = usesStoredPath
      ? (stored.path ?? '')
      // `'default'` mode names no path of its own; this is the same derivation the dialog showed.
      : (await deriveDefaultWorkspacePath() ?? '')
    if (path === '') throw new Error('there is no base workspace path to rebuild')
    // The stored name is only meaningful for the path it was captured with. In `'default'` mode the
    // memory belongs to some *other* Workspace (it survives a switch to 默认 by design), so passing
    // it here would title the default Workspace with an unrelated name. Omitted, the registry
    // derives one from the directory, which is the honest answer for a path the user never named.
    const title = usesStoredPath ? stored.name : undefined

    const registry = this.ctx.get('workspaceRegistry') as
      | { create(path: string, title?: string): Promise<{ id: unknown; path?: string; title?: string }> }
      | undefined
    if (registry === undefined) {
      throw new Error('the Workspace registry is unavailable, so the directory cannot be re-registered')
    }

    await mkdir(path, { recursive: true })
    // A title rides along only when the path is the one the name was captured with:
    // `workspace/create` cannot carry one at all, so going through the registry is what keeps a
    // rebuilt row named the way the user chose — and what keeps it from borrowing a name that
    // belongs to a different directory.
    const entity = await registry.create(path, title)

    const mode = stored.mode
    if (mode === 'default') {
      await this.setGlobal(domain, {
        baseWorkspace: { mode: 'specified', path: entity.path ?? path, name: entity.title },
      })
    }
    return {
      // The registry answers with the canonical path; write back what it resolved rather than the
      // request, so a symlink or a case difference cannot leave the setting disagreeing with the row.
      path: entity.path ?? path,
      workspaceId: String(entity.id),
      title: entity.title ?? '',
      mode: mode === 'default' ? 'specified' : mode,
    }
  }

  /**
   * Report where the official default Workspace would live.
   *
   * The missing-底层工作区 dialog names the path that is gone, and no Client-side
   * caller can produce it: the derivation starts at the OS Documents folder, which
   * only this half can query (`src/default-workspace.ts` explains why the official
   * helper is reimplemented rather than imported).
   *
   * A pure read — nothing is created or registered — and `path: null` when the
   * Documents folder is unreadable, so the dialog can say "unknown" instead of
   * showing a path it did not verify.
   * @returns the derived path, or `null`.
   */
  @Remote('defaultWorkspacePath')
  async defaultWorkspacePath(): Promise<ProjectDefaultWorkspacePathValue> {
    return { path: await deriveDefaultWorkspacePath() }
  }

  /**
   * Stream the projection: a baseline first, then a fresh baseline per landed
   * write.
   *
   * Every frame is a complete projection rather than a diff. That is what makes
   * reconnection trivial (a new generation opens with a baseline and the Client
   * replaces its state) and what keeps the two sides from having to agree on
   * increment semantics. The writes here are user gestures, not a hot path, so
   * re-projecting costs nothing that matters.
   * @param signal - caller lifetime; the follower leaves with it.
   * @returns the frame stream.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<ProjectFollowFrame> {
    // Baseline before subscribing: attaching a listener first could let a
    // concurrent write land between the two, and its frame would then arrive
    // before the baseline that already contains it.
    const frames: ProjectFollowFrame[] = []
    let wake: (() => void) | undefined
    const push = (): void => {
      const pending = wake
      wake = undefined
      pending?.()
    }
    const refresh = async (): Promise<void> => {
      frames.push({ type: 'baseline', value: await this.baseline() })
      push()
    }
    yield { type: 'baseline', value: await this.baseline() }

    await this.ready()
    const onChanged = (): void => { void refresh() }
    this.followers.add(onChanged)
    const leave = (): void => { this.followers.delete(onChanged) }
    signal.addEventListener('abort', leave, { once: true })
    try {
      while (!signal.aborted) {
        const next = frames.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      leave()
      signal.removeEventListener('abort', leave)
    }
  }
}

/**
 * A fresh project id.
 *
 * `randomUUID` is present on every supported Node line; the fallback keeps an
 * exotic runtime working rather than throwing during a create.
 * @returns a unique id.
 */
function newProjectId(): string {
  const random = globalThis.crypto?.randomUUID?.()
  if (random !== undefined) return random
  return `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Mount the Host half.
 * @param ctx - Host context.
 */
export function apply(ctx: Context): void {
  new ProjectController(ctx)
}

/** Re-exported so the Client contribution and Host agree on one declaration. */
export type { DomainChanged }
