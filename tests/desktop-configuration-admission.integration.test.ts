import { expect, it } from 'vitest'
import { CdpPluginLifecycleRuntime } from '../packages/cli/src/launcher/cdp-plugin-lifecycle-runtime.js'
import { DesktopRendererLifecycle } from '../packages/cli/src/launcher/desktop-renderer-lifecycle.js'
import type { AttachedRendererPeer } from '../packages/cli/src/launcher/renderer-lifecycle-peer.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'

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

function peer(id: string): AttachedRendererPeer {
  let closed = false
  const listeners = new Set<() => void>()
  return {
    scope,
    identity: {
      appId: 'manager',
      adapterId: 'independent-manager',
      rendererId: id,
      pid: process.pid,
      processStartedAt: 'fixture',
    },
    sessionId: 'b'.repeat(64),
    get closed() {
      return closed
    },
    request: async (_method, value) => value,
    onDisconnect(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      if (closed) return
      closed = true
      for (const listener of listeners) listener()
      listeners.clear()
    },
  }
}

function fixture() {
  const cdp = new CdpPluginLifecycleRuntime()
  const session = {
    async send(_method: string, params: Record<string, unknown>) {
      const expression = String(params.expression ?? '')
      const result = expression.includes('const request = JSON.parse')
        ? { status: 'ok', configuration: { revision: 1 } }
        : { active, registryEpoch: 0 }
      return { result: { value: { ok: true, result } } }
    },
  } as never
  const unregister = cdp.register(session)
  const lifecycle = new DesktopRendererLifecycle({
    scope,
    cdp,
    active,
    registryEpoch: 0,
    projectManagerMutation: async () => undefined,
  })
  return { cdp, session, unregister, lifecycle }
}

it('reserves the exact Manager and Desktop seat until a confirmed write releases them', async () => {
  const f = fixture()
  const manager = peer('manager-1')
  try {
    await f.lifecycle.attach(manager)
    const reservation = await f.lifecycle.reserveExternalMutation([manager])
    expect(reservation.desktopConfiguration.seat).toBe(f.session)
    expect(f.lifecycle.snapshot()).toEqual({ active, registryEpoch: 0 })
    expect(() => f.cdp.register({} as never)).toThrow('cannot register')
    await expect(f.lifecycle.attach(peer('manager-2'))).rejects.toThrow('attachment is unavailable')
    expect(await f.lifecycle.pluginConfiguration({ kind: 'plugin-configuration', action: 'list' }))
      .toMatchObject({ status: 'unavailable', reason: 'renderer-busy' })
    expect(
      await reservation.desktopConfiguration.update({
        kind: 'plugin-configuration',
        action: 'update',
        pluginId: 'demo',
        expectedRevision: 0,
        operations: [{ op: 'set', path: ['label'], value: 'new' }],
      }),
    ).toMatchObject({ status: 'ok' })
    expect(reservation.desktopConfiguration.confirm()).toBe(true)
    expect(reservation.release()).toBe(true)
    const another = f.cdp.register({} as never)
    another()
  } finally {
    manager.close()
    f.lifecycle.close()
    f.unregister()
  }
})

it('refuses a reservation with multiple native seats or a different Manager', async () => {
  const f = fixture()
  const manager = peer('manager-1')
  try {
    await f.lifecycle.attach(manager)
    await expect(f.lifecycle.reserveExternalMutation([peer('other')])).rejects.toThrow('reservation is unavailable')
    const another = f.cdp.register({} as never)
    await expect(f.lifecycle.reserveExternalMutation([manager])).rejects.toThrow('reservation is unavailable')
    another()
    expect(manager.closed).toBe(false)
  } finally {
    manager.close()
    f.lifecycle.close()
    f.unregister()
  }
})
