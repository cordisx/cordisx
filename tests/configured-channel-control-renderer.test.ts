import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { CordisXChannelManagerPresentationService } from '../packages/cli/src/renderer/channel-manager-presentation.js'
import { registerChannelServiceFacade, stateFor } from '../packages/cli/src/renderer/channel-manager-state.js'
import {
  CORDISX_PLUGIN_GENERATION,
  CORDISX_PLUGIN_ID,
  CORDISX_PLUGIN_SOURCE,
} from '../packages/cli/src/renderer/ownership.js'

const ref = { adapterId: 'simulator', accountId: 'local', tenantId: 'test' }
const connection = {
  ref,
  adapterKind: 'simulator',
  enabled: true,
  transportMode: 'simulator',
  secretState: 'ready' as const,
}
const initial = {
  contract: 'cordisx.channel-manager-projection/v1' as const,
  schemaVersion: 1 as const,
  status: 'verified' as const,
  service: {
    configurationKind: 'host' as const,
    configApplies: 'service-restart' as const,
    revision: 7,
    lastGoodRevision: 7,
    writable: true,
    connectionControl: 'enable-disable' as const,
  },
  connections: [connection],
  routes: [],
  bindings: [],
  diagnostics: [],
  accounts: [{
    ...connection,
    implementationStatus: 'verified' as const,
    connectionState: 'ready' as const,
    generation: 1,
    inbound: { pending: 0, retrying: 0, deadLetter: 0 },
    outbound: { pending: 0, retrying: 0, deadLetter: 0 },
  }],
}
const disabled = {
  ...initial,
  service: { ...initial.service, revision: 8, lastGoodRevision: 8 },
  connections: [{ ...connection, enabled: false }],
  accounts: [{ ...initial.accounts[0]!, enabled: false, connectionState: 'disabled' as const }],
}

function setup(run: (action: string, input: Record<string, unknown>) => Promise<any>) {
  const ctx = new Context().extend({
    [CORDISX_PLUGIN_ID]: 'channel',
    [CORDISX_PLUGIN_SOURCE]: 'https://example.test/channel',
    [CORDISX_PLUGIN_GENERATION]: 'plugin-generation',
  })
  const manager = new CordisXChannelManagerPresentationService(ctx, {
    presentationMode: 'configuration-only',
    profileId: 'test',
    hostGeneration: 'owner-generation',
    projection: initial,
    broker: { authorizeServiceOwner: () => true } as never,
    serviceConfig: {} as never,
    actions: { snapshotOnly: true, connectionControl: 'enable-disable', run },
  })
  const signal = new AbortController().signal
  const facade = Object.create(manager) as CordisXChannelManagerPresentationService
  const old = Object.create(manager) as CordisXChannelManagerPresentationService
  const owner = { moduleGeneration: 'plugin-generation' } as never
  registerChannelServiceFacade(facade, owner, signal, 'configuration')
  registerChannelServiceFacade(old, owner, signal, 'snapshot')
  return { manager, facade, old }
}

function request(facade: CordisXChannelManagerPresentationService, operation: 'connection.disable') {
  const snapshot = facade.snapshot()
  return {
    contract: 'cordisx.channel-manager-request/v2' as const,
    schemaVersion: 2 as const,
    requestId: 'toggle',
    profileId: snapshot.profileId,
    hostGeneration: snapshot.hostGeneration,
    expectedRevision: snapshot.revision,
    operation,
    target: { kind: 'connection' as const, connectionToken: snapshot.accounts[0]!.connectionToken },
  }
}

it('uses the owner revision and adopts the confirmed connection state without widening the old facade', async () => {
  const run = vi.fn(async () => ({ status: 'applied' as const, channelProjection: disabled }))
  const { manager, facade, old } = setup(run)
  facade.snapshot()
  stateFor(manager).publicController!.invalidate()
  expect(facade.configurationPresentationCapabilities().connectionControl).toBe('enable-disable')
  expect(facade.snapshot().accounts[0]!.availableOperations).toEqual(['connection.disable', 'connection.update'])
  expect(old.snapshot().accounts[0]!.availableOperations).toEqual([])
  const operation = request(facade, 'connection.disable')
  expect(operation.expectedRevision).not.toBe(initial.service.revision)
  expect(await old.execute(operation)).toMatchObject({ status: 'rejected', code: 'OPERATION_UNAVAILABLE' })
  expect(await facade.execute(operation)).toMatchObject({ status: 'applied' })
  expect(run).toHaveBeenCalledWith('disable', { ref, expectedRevision: 7 })
  expect(facade.snapshot().accounts[0]).toMatchObject({
    connectionState: 'disabled',
    availableOperations: ['connection.enable', 'connection.update'],
  })
  expect(stateFor(manager).projection.service.revision).toBe(8)
})

it.each(['lost', 'bad-readback'] as const)(
  'fences further controls after %s instead of reporting success',
  async failure => {
    const run = vi.fn(async () => {
      if (failure === 'lost') throw new Error('connection lost')
      return { status: 'applied' as const, channelProjection: initial }
    })
    const { facade } = setup(run)
    const operation = request(facade, 'connection.disable')
    if (failure === 'lost') await expect(facade.execute(operation)).rejects.toThrow('connection lost')
    else expect(await facade.execute(operation)).toMatchObject({ status: 'unavailable' })
    expect(facade.configurationPresentationCapabilities()).not.toHaveProperty('connectionControl')
    expect(facade.snapshot().accounts[0]!.availableOperations).not.toContain('connection.disable')
    expect(await facade.execute(request(facade, 'connection.disable')))
      .toMatchObject({ status: 'rejected', code: 'OPERATION_UNAVAILABLE' })
    expect(run).toHaveBeenCalledOnce()
  },
)
