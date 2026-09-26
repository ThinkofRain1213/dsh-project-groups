/**
 * Why does the Client's `$mount` fail?
 *
 * The Host side is proven: `projectGroups/baseline` answers over `/api`. So the
 * failure is in the Client's own contribution validation or install. This drives
 * the real `ClientRemoteService` machinery is impractical outside a browser, so
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
const { projectGroupsRemote } = await import('../src/client/remote.ts')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** Mirror of the Gateway's `requireStrictInputs`. */
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

/** Mirror of `RemoteNamespaceService.assertMethodAvailable`. */
const RESERVED = new Set(['ctx', 'empty', 'invokeRemote', 'methods', 'name', 'namespace'])
const PROTO = new Set(['assertMethodAvailable', 'installDirect', 'installScoped', 'remove', 'constructor'])

console.log(`contribution package: ${projectGroupsRemote.package}`)
console.log(`descriptors         : ${projectGroupsRemote.descriptors.length}`)
console.log('')

for (const descriptor of projectGroupsRemote.descriptors) {
  const endpoint = `${descriptor.namespace}/${descriptor.method}`
  check(`${endpoint} has strict inputs`, requireStrictInputs(descriptor).length === 0,
    requireStrictInputs(descriptor).join('; '))
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

// Stream descriptors: `mode: 'stream'` must not also be installed as direct.
for (const descriptor of projectGroupsRemote.descriptors) {
  if (descriptor.mode === 'stream') {
    check(`stream ${descriptor.method} declares cancellation shape`,
      descriptor.cancellation === undefined || descriptor.cancellation.parameter === 'signal',
      JSON.stringify(descriptor.cancellation))
  }
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
