import { randomBytes } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { coordinateManagerPermissionReview } from '../packages/cli/src/cli/manager-permission-review-fence.js'
import { ManagerRendererSessions } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { ServiceRendererParticipants } from '../packages/cli/src/cli/service-renderer-participant.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'
import type { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import type { PermissionReviewOperation } from '../packages/cli/src/launcher/permission-review-management.js'
import { ServiceRendererLifecycle } from '../packages/cli/src/launcher/service-renderer-lifecycle.js'

const secret = () => randomBytes(32).toString('hex')
const gateway = { pid: 42, processStartedAt: 'fixture', instanceToken: secret() }

it('protects open drafts and fences admissions until an owner review is confirmed', async () => {
  const scope = { homeDigest: 'a'.repeat(64), ownerAppId: 'codex', profileId: 'work', generation: 'owner-1' }
  const lifecycle = new ServiceRendererLifecycle({ scope })
  const active: CordisXPluginActivationRecordV1 = {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: 'active',
    profileId: scope.profileId,
    runtimeGeneration: scope.generation,
    revision: 0,
    lastGoodRevision: 0,
    plugins: [],
  }
  lifecycle.initialize(active)
  const participants = new ServiceRendererParticipants(scope)
  participants.bind(lifecycle)
  const sessions = new ManagerRendererSessions({
    profileId: scope.profileId,
    ownerGeneration: scope.generation,
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    participant: participants.participant,
  })
  let resume!: () => void
  let entered!: () => void
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  const paused = new Promise<void>(resolve => {
    resume = resolve
  })
  const apply = vi.fn(async () => {
    lifecycle.prepare('owner-review')
    entered()
    await paused
    await lifecycle.abort('owner-review')
    return { outcome: 'applied' }
  })
  const coordinator = {
    store: { loadActive: async () => active },
    applyPermissionReviewV7: apply,
  } as unknown as PluginLifecycleCoordinator
  const review = coordinateManagerPermissionReview({
    sessions,
    participants,
    lifecycle,
    coordinator,
    profileId: scope.profileId,
    generation: scope.generation,
  })
  const operation = {
    kind: 'permission-review-apply',
    userConfirmed: true,
    expectedRevision: 0,
    decision: { schemaVersion: 7, profileId: scope.profileId, binding: { runtimeGeneration: scope.generation } },
  } as unknown as PermissionReviewOperation
  try {
    const browserSessionId = secret()
    const handle = (await sessions.open(gateway, browserSessionId))!
    expect(await review(operation)).toEqual({ status: 'unavailable', reason: 'profile-coordination-unavailable' })
    expect(sessions.hasLiveRenderers()).toBe(true)
    expect(apply).not.toHaveBeenCalled()
    expect(await sessions.close({ gateway, browserSessionId, handle })).toBe(true)

    const pending = review(operation)
    await started
    expect(await sessions.open(gateway, secret())).toBeUndefined()
    expect(() => lifecycle.prepare('other')).toThrow('service renderer fence is active')
    expect(await review(operation)).toEqual({ status: 'rejected', reason: 'review-busy' })
    resume()
    expect(await pending).toEqual({ status: 'ok', result: { outcome: 'applied' } })
    const nextId = secret()
    const next = (await sessions.open(gateway, nextId))!
    expect(next).toBeDefined()
    expect(await sessions.close({ gateway, browserSessionId: nextId, handle: next })).toBe(true)

    apply.mockRejectedValueOnce(new Error('uncertain review'))
    expect(await review(operation)).toEqual({ status: 'unknown', reason: 'review-not-confirmed' })
    expect(await sessions.open(gateway, secret())).toBeUndefined()
    expect(() => lifecycle.snapshot()).toThrow('service renderer lifecycle is unavailable')
  } finally {
    resume()
    sessions.dispose()
    participants.close()
    await lifecycle.close()
  }
})
