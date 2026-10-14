/**
 * Why does the Client's `$mount` fail?
 *
 * The Host side is proven: `projectGroups/baseline` answers over `/api`. So the
 * failure is in the Client's own contribution validation or install. Driving the
 * real `ClientRemoteService` machinery is impractical outside a browser, so
 * instead it replays the *validation* rules against our own contribution — the
 * checks the Gateway runs before it installs anything:
 *
 *   - `validateContribution` -> `requireStrictInputs` (every parameter needs a
 *     strict codec);
 *   - `RemoteNamespaceService.assertMethodAvailable` (the method name must not
 *     collide with the namespace service's own surface);
 *   - the namespace registration (the namespace must not collide with a service
 *     already on the Context).
 *
 * Whatever it reports is a real reason `$mount` would reject this contribution.
 */
// The module is loaded through the TypeScript loader the same way the suite's other probes are.
// A resolve/loader failure here would otherwise escape as an unhandled top-level rejection: the
// `failures` list and the exit code below would never run, and the failure would read as a raw
// stack trace rather than as the single honest statement "the contribution could not be loaded".
let projectGroupsRemote
try {
  ({ projectGroupsRemote } = await import('../src/client/remote.ts'))
} catch (error) {
  console.error(`FAIL  cannot load ../src/client/remote.ts: ${error.message}`)
  console.error('      (nothing below can run without the contribution, so this IS the result)')
  process.exit(1)
}

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/**
 * Mirror of the Gateway's `requireStrictInputs`.
 *
 * Hand-mirrored on purpose: the Gateway lives inside the DSH install, not in this checkout, so
 * there is no importable source of truth. The coupling is the point of the probe — if the real
 * rule changes, this copy silently keeps passing while `$mount` starts failing, so whoever edits
 * the Gateway rule must update this function in the same change.
 */
function requireStrictInputs(descriptor) {
  const problems = []
  for (const parameter of descriptor.parameters) {
    if (parameter.codec?.mode !== 'strict') {
      problems.push(`parameter ${JSON.stringify(parameter.wire)} has no strict codec`)
    }
  }
  if (descriptor.invocation.kind === 'context' && descriptor.invocation.codec?.mode !== 'strict') {
    problems.push('context codec is not strict')
  }
  return problems
}

/** Mirror of `RemoteNamespaceService.assertMethodAvailable`. Hand-mirrored for the same reason as
 * {@link requireStrictInputs} — see that note. */
const RESERVED = new Set(['ctx', 'empty', 'invokeRemote', 'methods', 'name', 'namespace'])
const PROTO = new Set(['assertMethodAvailable', 'installDirect', 'installScoped', 'remove', 'constructor'])

console.log(`contribution package: ${projectGroupsRemote.package}`)
console.log(`descriptors         : ${projectGroupsRemote.descriptors.length}`)
console.log('')

for (const descriptor of projectGroupsRemote.descriptors) {
  const endpoint = `${descriptor.namespace}/${descriptor.method}`
  // Computed once: the check and its detail message must come from the same
  // evaluation, and a second call is wasted work if the validator ever stops
  // being pure.
  const inputProblems = requireStrictInputs(descriptor)
  check(`${endpoint} has strict inputs`, inputProblems.length === 0, inputProblems.join('; '))
  check(`${endpoint} method name is free`, !RESERVED.has(descriptor.method) && !PROTO.has(descriptor.method),
    descriptor.method)
  check(`${endpoint} declares a namespace`, typeof descriptor.namespace === 'string' && descriptor.namespace !== '')
  check(`${endpoint} declares a service`, typeof descriptor.service === 'string' && descriptor.service !== '')
}

// Namespace-level checks: every descriptor must agree on one namespace, and the
// namespaces must not collide with each other.
const namespaces = new Set(projectGroupsRemote.descriptors.map(d => d.namespace))
check('all descriptors share one namespace', namespaces.size === 1, [...namespaces].join(','))

// The Client registers a service per namespace under `remote.<name>`. That key
// must not already be a service on the Context; the collision this suite can
// catch without a Context is the naming shape itself.
for (const namespace of namespaces) {
  check(`namespace ${JSON.stringify(namespace)} yields a valid service key`,
    /^[A-Za-z_$][\w$.-]*$/.test(`remote.${namespace}`), `remote.${namespace}`)
}

// Stream descriptors: `mode: 'stream'` must also carry the cancellation shape the
// probe claims to reproduce. `cancellation === undefined` used to count as a pass,
// so a stream that silently dropped its `signal` parameter would have been reported
// as conforming — the weakest possible form of the check this file exists to make.
for (const descriptor of projectGroupsRemote.descriptors) {
  if (descriptor.mode === 'stream') {
    check(`stream ${descriptor.method} declares cancellation shape`,
      descriptor.cancellation?.parameter === 'signal',
      JSON.stringify(descriptor.cancellation))
  }
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
// `process.exitCode`, **not** `process.exit()`.
//
// This file registers the TypeScript module loader (`node:module` `register`), whose async hooks can
// still hold libuv handles when the last statement runs. `process.exit()` forces teardown while one
// is closing, which can abort the process *after* every assertion has already passed — the suite
// then reports success and exits non-zero, failing `pnpm check`. Setting the code and letting Node
// drain its handles gives the same exit status without that race.
process.exitCode = failures.length === 0 ? 0 : 1
