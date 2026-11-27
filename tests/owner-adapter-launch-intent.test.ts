import { expect, it, vi } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { launchFingerprint } from '../packages/cli/src/cli/launch-fingerprint.js'
import { OwnerAdapterLaunchIntent } from '../packages/cli/src/cli/owner-adapter-launch-intent.js'
import { parseCordisXCli } from '../packages/cli/src/cli/parse.js'
import type { OwnerPolicyTransition } from '../packages/cli/src/owner-policy-handoff.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'

const invocation = parseCordisXCli(['start', 'codex', '--executable', '/test/codex'])
if (invocation.action !== 'start') throw new Error('expected start command')
const launch = { options: invocation.options, hostArgs: [], dataMode: 'shared', cwd: '/test' }
const [allow] = exactDomPermissionPolicies('default', [{
  id: 'pet',
  entry: '/test/pet.js',
  pointIds: ['manager.content'],
}])
const policy = allow!
const initial = createDefaultHomeConfig()
const initialSource = JSON.stringify(initial)
const original = launchFingerprint({ ...launch, source: initialSource })
const transition = (expected: readonly unknown[], update: typeof policy): OwnerPolicyTransition => ({
  profileId: 'default',
  ownerGeneration: 'owner',
  rendererId: 'a'.repeat(64),
  handoffId: 'b'.repeat(64),
  requestId: 'request-1',
  origin: false,
  identity: { id: 'pet', source: policy.key.identity.source },
  moduleGeneration: 'module-1',
  expected,
  updates: [update],
  candidate: [update],
})

it('records only the exact adopted policy and defers publication until the client is ready', async () => {
  let source = JSON.stringify({ ...initial, permissions: [policy] })
  const publish = vi.fn(async () => true)
  const tracker = new OwnerAdapterLaunchIntent({
    initialSource,
    initialFingerprint: original,
    launch,
    readSource: async () => source,
    publish,
  })
  await tracker.adopted(transition([], policy))
  expect(publish).not.toHaveBeenCalled()
  await tracker.markReady()
  const first = launchFingerprint({ ...launch, source })
  expect(publish).toHaveBeenCalledExactlyOnceWith(original, first)
  const reset = { ...policy, policy: 'ask' as const }
  source = JSON.stringify({ ...initial, permissions: [reset] })
  await tracker.adopted(transition([policy], reset))
  expect(publish).toHaveBeenLastCalledWith(first, launchFingerprint({ ...launch, source }))
  expect(publish).toHaveBeenCalledTimes(2)
})

it.each(['other-config', 'other-policy', 'stale-expected'] as const)(
  'does not absorb a concurrent %s change into the running client',
  async change => {
    const extra = exactDomPermissionPolicies('default', [{
      id: 'other',
      entry: '/test/other.js',
      pointIds: ['manager.content'],
    }])[0]!
    const source = JSON.stringify({
      ...initial,
      ...(change === 'other-config'
        ? {
          apps: {
            codex: {
              ...initial.apps.codex!,
              profiles: { default: { displayName: 'Changed', dataMode: 'shared' } },
            },
          },
        }
        : {}),
      permissions: change === 'other-policy' ? [policy, extra] : [policy],
    })
    const publish = vi.fn(async () => true)
    const tracker = new OwnerAdapterLaunchIntent({
      initialSource,
      initialFingerprint: original,
      launch,
      readSource: async () => source,
      publish,
    })
    await tracker.markReady()
    await tracker.adopted(transition(change === 'stale-expected' ? [policy] : [], policy))
    expect(publish).not.toHaveBeenCalled()
  },
)

it('does not overwrite a supervisor whose recorded launch intent has changed', async () => {
  const source = JSON.stringify({ ...initial, permissions: [policy] })
  const publish = vi.fn(async () => false)
  const tracker = new OwnerAdapterLaunchIntent({
    initialSource,
    initialFingerprint: original,
    launch,
    readSource: async () => source,
    publish,
  })
  await tracker.markReady()
  await tracker.adopted(transition([], policy))
  await tracker.adopted(transition([], policy))
  expect(publish).toHaveBeenCalledOnce()
})
