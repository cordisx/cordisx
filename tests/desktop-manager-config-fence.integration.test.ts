import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import { DesktopOwnerRendererLifecycle } from '../packages/cli/src/cli/desktop-owner-renderer-lifecycle.js'
import { fenceManagerOrigin } from '../packages/cli/src/cli/manager-origin-fence.js'
import { ServiceRendererParticipants } from '../packages/cli/src/cli/service-renderer-participant.js'
import { ManagerRendererSessions } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { CdpPluginLifecycleRuntime } from '../packages/cli/src/launcher/cdp-plugin-lifecycle-runtime.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'

const secret = () => randomBytes(32).toString('hex')
const scope = { homeDigest: 'a'.repeat(64), ownerAppId: 'codex', profileId: 'work', generation: 'g' }
const active = {
  $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  schemaVersion: 1 as const,
  recordKind: 'active' as const,
  profileId: 'work',
  revision: 0,
  lastGoodRevision: 0,
  runtimeGeneration: 'g',
  plugins: [],
}
const operation = {
  kind: 'plugin-configuration' as const,
  action: 'update' as const,
  pluginId: 'demo',
  expectedRevision: 0,
  operations: [{ op: 'set' as const, path: ['label'], value: 'new' }],
}

async function fixture(onUpdate: () => Promise<void> = async () => {}) {
  const cdp = new CdpPluginLifecycleRuntime()
  const nativeSeat = {
    async send(_method: string, params: Record<string, unknown>) {
      const expression = String(params.expression ?? '')
      if (expression.includes('const request = JSON.parse')) {
        await onUpdate()
        return { result: { value: { ok: true, result: { status: 'ok', configuration: { revision: 1 } } } } }
      }
      return { result: { value: { ok: true, result: { active, registryEpoch: 0 } } } }
    },
  } as never
  const unregister = cdp.register(nativeSeat)
  const lifecycle = new DesktopOwnerRendererLifecycle({
    scope,
    cdp,
    artifactServer: {} as never,
    projectManagerMutation: async () => undefined,
  })
  lifecycle.initialize(active, false)
  const participants = new ServiceRendererParticipants(scope)
  participants.bind(lifecycle)
  const gateway = { pid: process.pid, processStartedAt: 'fixture', instanceToken: secret() }
  let sessions!: ManagerRendererSessions
  sessions = new ManagerRendererSessions({
    profileId: 'work',
    ownerGeneration: 'g',
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    participant: participants.participant,
    channels: new Map([['fixture-write', {
      prepare: () => ({
        mode: 'write' as const,
        dispatch: async () => {
          const origin = await fenceManagerOrigin({ sessions, participants, lifecycle })
          try {
            expect(origin.desktopConfiguration?.seat).toBe(nativeSeat)
            expect(await sessions.open(gateway, secret())).toBeUndefined()
            expect(() => cdp.register({} as never)).toThrow('cannot register')
            const result = await origin.desktopConfiguration!.update(operation)
            if (result.status !== 'ok' || !origin.desktopConfiguration!.confirm() || !origin.release()) {
              throw new Error('configuration result is uncertain')
            }
            return result
          } catch (error) {
            origin.fence()
            throw error
          }
        },
      }),
    }]]),
  })
  const browserSessionId = secret()
  const handle = (await sessions.open(gateway, browserSessionId))!
  const invocation = { gateway, browserSessionId, handle }
  participants.confirmBootstrap(handle.rendererId, lifecycle.snapshot())
  const pump = (async () => {
    while (participants.peer(handle.rendererId)) {
      const result = await sessions.poll(invocation, 100)
      const command = result.status === 'ok' ? (result.value as { command?: any }).command : undefined
      if (command) {
        await sessions.acknowledge(invocation, {
          id: command.id,
          sequence: command.sequence,
          ok: true,
          value: command.payload,
        })
      }
    }
  })()
  expect(await sessions.admit(invocation)).toMatchObject({ status: 'ok' })
  return {
    cdp,
    lifecycle,
    participants,
    sessions,
    gateway,
    invocation,
    handle,
    close: async () => {
      sessions.dispose()
      participants.close()
      lifecycle.close()
      unregister()
      await pump
    },
  }
}

it('holds the authenticated Manager origin through a native configuration receipt', async () => {
  const f = await fixture()
  try {
    expect(await f.sessions.call(f.invocation, 'fixture-write', {})).toMatchObject({
      status: 'ok',
      value: { status: 'ok', configuration: { revision: 1 } },
    })
    expect(await f.sessions.open(f.gateway, secret())).toBeDefined()
  } finally {
    await f.close()
  }
})

it('fences a dispatched native write when its Manager disconnects before the receipt', async () => {
  let entered!: () => void
  let finish!: () => void
  const started = new Promise<void>(resolve => entered = resolve)
  const release = new Promise<void>(resolve => finish = resolve)
  const f = await fixture(async () => {
    entered()
    await release
  })
  try {
    const writing = f.sessions.call(f.invocation, 'fixture-write', {})
    await started
    f.participants.peer(f.handle.rendererId)!.close()
    finish()
    expect(await writing).toEqual({ status: 'unknown' })
    expect(await f.sessions.open(f.gateway, secret())).toBeUndefined()
  } finally {
    finish()
    await f.close()
  }
})
