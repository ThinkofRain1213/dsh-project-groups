/**
 * The Client's contribution for this plugin's own Remote namespace.
 *
 * ## Why hand-written
 *
 * The harness's Remote owners ship a generated `typert.remote-client.js`. That
 * artifact exists because a *generated* descriptor needs zod schemas inferred
 * from the Host's TypeScript types, and the Client's Remote assembly is a fixed
 * list (`packages/api/remotes/src/client/index.ts`) that does not include this
 * package — so this plugin mounts its own.
 *
 * The generator is monorepo-only (see `src/index.ts`), but it is also
 * unnecessary here. What the Client actually requires of a descriptor is narrow:
 *
 *  - `requireStrictInputs` rejects any parameter whose codec is not
 *    `mode: 'strict'` — it does not inspect what the codec returns
 *    (`packages/api/gateway/src/client/index.ts`);
 *  - `TypertSchema` is structural: `{ parse(value): Output }`, not a zod type
 *    (`packages/typert/protocol/src/types.ts`).
 *
 * So the pass-through codec below satisfies the contract exactly. That is
 * honest rather than a shortcut: every payload in `src/protocol.ts` is flat
 * JSON — strings and arrays of strings — so there is nothing to coerce and a
 * schema would only restate the interface next to it. A payload that grows a
 * non-JSON field is the point at which this needs a real codec.
 *
 * The Host side needs no counterpart artifact: the Gateway derives its
 * descriptor at runtime from the service's `@Remote` markers.
 */
import type { InvocationDescriptor, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { PROJECT_NAMESPACE, PROJECT_SERVICE_KEY } from '../protocol.ts'

/**
 * Pass-through codec: the wire value is already the payload.
 *
 * `parse` is identity because the boundary it guards is JSON-only by
 * construction; see the module doc for when that stops being true.
 */
const PASSTHROUGH = { parse: (value: unknown): unknown => value }

/**
 * One strict codec.
 * @param typeSymbol - names the value on the wire, for diagnostics.
 * @returns the codec the Client accepts.
 */
function codec(typeSymbol: string): InvocationDescriptor['result'] {
  return { mode: 'strict', typeSymbol, create: () => PASSTHROUGH }
}

/**
 * One JSON business parameter.
 * @param name - the Host method's parameter name, which the Gateway also uses
 * as the wire field for a signature-derived descriptor.
 * @returns the parameter descriptor.
 */
function json(name: string): InvocationDescriptor['parameters'][number] {
  return { name, wire: name, source: 'json', codec: codec(`dsh-project-groups#${name}`) }
}

/**
 * One unary method.
 * @param method - the `@Remote` export name on the Host.
 * @param parameters - business parameter names, in order.
 * @param result - result type symbol, for diagnostics.
 * @returns the descriptor.
 */
function unary(method: string, parameters: readonly string[], result: string): InvocationDescriptor {
  return {
    id: `dsh-project-groups#${PROJECT_NAMESPACE}/${method}`,
    // Must name the Cordis service key: the Gateway resolves the endpoint against
    // it, and a mismatch fails the call rather than the mount.
    service: PROJECT_SERVICE_KEY,
    namespace: PROJECT_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: parameters.map(json),
    result: codec(`dsh-project-groups#${result}`),
  }
}

/**
 * The contribution mounted with `ctx.remote.$mount`.
 *
 * `follow` carries `mode: 'stream'` so the installer treats it as a stream
 * handle rather than a unary call, and an `AbortSignal` parameter so the
 * Gateway's signature check supplies cancellation.
 */
export const projectGroupsRemote: TypertRemoteContribution = {
  package: 'dsh-project-groups',
  descriptors: [
    unary('baseline', [], 'ProjectBaseline'),
    unary('create', ['request'], 'ProjectValueResult'),
    unary('rename', ['request'], 'ProjectRenameValue'),
    unary('delete', ['request'], 'ProjectDeleteValue'),
    unary('reorder', ['request'], 'ProjectOrderValue'),
    unary('assign', ['request'], 'ProjectAssignmentValue'),
    unary('unassign', ['request'], 'ProjectUnassignValue'),
    unary('setExpanded', ['request'], 'ProjectExpansionValue'),
    unary('setOrders', ['request'], 'ProjectOrdersValue'),
    unary('setNewSessionTarget', ['request'], 'ProjectNewSessionTargetValue'),
    {
      id: `dsh-project-groups#${PROJECT_NAMESPACE}/follow`,
      service: PROJECT_SERVICE_KEY,
      namespace: PROJECT_NAMESPACE,
      method: 'follow',
      mode: 'stream',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec('dsh-project-groups#ProjectFollowFrame'),
      // Cancellation is the Host's trailing `signal` parameter; declaring it lets
      // the caller pass an AbortSignal as the one extra argument.
      cancellation: { parameter: 'signal' },
    },
  ],
}
