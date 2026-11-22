import { randomBytes } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createManagerRendererGraphSession } from '../packages/cli/src/cli/manager-renderer-graph-session.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'

const secret = () => randomBytes(32).toString('hex')
const origin = 'http://127.0.0.1:43123'
const channelArchive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE
const scenarios = [
  'commit',
  'rollback',
  'disconnect',
  'observation',
  'observation-rollback',
  'observation-disconnect',
  'management',
]
it.each(channelArchive ? [...scenarios, 'channel'] : scenarios)(
  'coordinates a capability-free plugin install and %s with two projected managed-plugin Managers',
  async outcome => {
    const f = await fixture({
      managedUiVersion: outcome.startsWith('observation') || outcome === 'channel' || outcome === 'management'
        ? 15
        : 14,
      managedUiGrant: true,
      protectProfileInputs: true,
      browserManagement: true,
      coordinateLifecycle: true,
      ...(outcome === 'channel' ? { channelArchive, channelUiGrant: true, channelServiceConfig: true } : {}),
    })
    const secondId = secret()
    const secondHandle = (await f.sessions.open(f.gateway, secondId))!
    const second = { gateway: f.gateway, browserSessionId: secondId, handle: secondHandle }
    const peers = [f.invocation, second]
    const graphSessions = new Map<string, ReturnType<typeof createManagerRendererGraphSession>>()
    const projectedCapabilities = vi.spyOn(f.managedUI, 'projectInitial')
    const query = () =>
      JSON.stringify({
        version: 1,
        requestId: secret(),
        token: 'renderer-binding-placeholder',
        profileId: f.profileId,
        operation: { kind: 'query' },
      })
    try {
      for (const invocation of peers) {
        const prepared = await f.sessions.call(invocation, 'manager-bootstrap', { action: 'prepare' }) as any
        expect(prepared.status).toBe('ok')
        const graphSession = createManagerRendererGraphSession({
          managerOrigin: origin,
          profileId: f.profileId,
          generation: f.generation,
          rendererId: invocation.handle.rendererId,
          isCurrent: () => f.participants.peer(invocation.handle.rendererId) !== undefined,
          forbiddenSecrets: [],
        })
        graphSessions.set(invocation.handle.rendererId, graphSession)
        const completed = await f.sessions.call(invocation, 'manager-bootstrap', {
          action: 'complete',
          managerOrigin: origin,
          graphs: graphSession.projectInitial(prepared.value.privateGraphs),
        }) as any
        expect(completed.status).toBe('ok')
        const polling = f.sessions.poll(invocation, 5_000)
        const admission = f.sessions.admit(invocation)
        const command = graphSession.projectCommand((await polling as any).value.command) as any
        expect(command.method).toBe('synchronize')
        const receipt = { id: command.id, sequence: command.sequence, ok: true, value: command.payload }
        expect((await f.sessions.acknowledge(invocation, receipt)).status).toBe('ok')
        graphSession.acknowledge(receipt)
        expect(await admission).toEqual({ status: 'ok', value: { admitted: true } })
      }
      const capabilities = peers.map(peer => {
        const index = projectedCapabilities.mock.calls.findIndex(([context]) =>
          context.rendererId === peer.handle.rendererId
        )
        return projectedCapabilities.mock.results[index]?.value?.[0]
      })
      expect(capabilities.every(Boolean)).toBe(true)
      const readManagedService = async (index: number) => {
        const capability = capabilities[index]!
        const request = JSON.stringify({
          version: 1,
          token: capability.token,
          requestId: 'get-' + secret(),
          operation: 'get',
          scope: {
            profileId: f.profileId,
            runtimeGeneration: f.generation,
            pluginGeneration: capability.pluginGeneration,
          },
          serviceId: 'gateway',
        })
        const result = await f.sessions.call(peers[index]!, 'managed-service-ui', request) as any
        expect({
          status: result.status,
          ok: result.value?.ok,
          code: result.value?.code,
          service: result.value?.value?.status,
        }).toEqual({ status: 'ok', ok: true, code: undefined, service: 'available' })
      }
      for (const index of peers.keys()) await readManagedService(index)
      const beforeViews = await Promise.all(
        peers.map(async peer => await f.sessions.call(peer, 'plugin-management', query())),
      ) as any[]
      const originalAliases = beforeViews.map(value => value.value.value.plugins[0].canonicalSource)
      expect(originalAliases[0]).not.toBe(originalAliases[1])
      const before = f.lifecycle.snapshot().active
      let pendingObservation: Promise<any> | undefined
      let observationSettled = false
      if (outcome.startsWith('observation')) {
        const capability = capabilities[0]!
        expect(capability.startup).toBe(true)
        const observe = (operation: string) =>
          f.sessions.call(
            peers[0]!,
            'managed-service-ui',
            JSON.stringify({
              version: 1,
              token: capability.token,
              requestId: 'startup-' + secret(),
              operation,
              scope: {
                profileId: f.profileId,
                runtimeGeneration: f.generation,
                pluginGeneration: capability.pluginGeneration,
              },
              subscriptionId: 'fixture-startup-stream',
            }),
          )
        expect(await observe('startupSubscribe')).toMatchObject({ status: 'ok', value: { ok: true } })
        for (let attempt = 0; attempt < 10; attempt++) {
          const next = observe('startupNext')
          const settled = await Promise.race([
            next.then(() => true),
            new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100)),
          ])
          if (!settled) {
            pendingObservation = next
            void next.then(() => observationSettled = true)
            break
          }
        }
        expect(pendingObservation).toBeDefined()
      }
      if (outcome === 'rollback' || outcome === 'observation-rollback') {
        vi.spyOn(f.managed, 'complete').mockRejectedValueOnce(new Error('fixture cleanup failure'))
      }
      const installing = outcome === 'management' || outcome === 'channel'
        ? f.installThroughManagement('other-plugin').then(result => ({ outcome: result.status }))
        : f.install('other-plugin', before.revision)
      const stages = new Map<string, any>()
      const delivered = async (method: string, response: (command: any, rendererId: string) => unknown) => {
        const polling = Promise.all(peers.map(async peer => await f.sessions.poll(peer, 20_000)))
        const values = await Promise.race([
          polling,
          installing.then(result => {
            throw new Error('lifecycle ended before ' + method + ': ' + result.outcome)
          }),
        ]) as any[]
        for (const [index, value] of values.entries()) {
          const peer = peers[index]!
          const graphSession = graphSessions.get(peer.handle.rendererId)!
          const command = graphSession.projectCommand(value.value.command) as any
          expect(command?.method).toBe(method)
          const receipt = {
            id: command.id,
            sequence: command.sequence,
            ok: true,
            value: response(command, peer.handle.rendererId),
          }
          expect((await f.sessions.acknowledge(peer, receipt)).status).toBe('ok')
          graphSession.acknowledge(receipt)
        }
      }
      await delivered('prepare', command => command.payload)
      for (const peer of peers) {
        expect(await f.sessions.call(peer, 'manager-bootstrap', { action: 'status' }))
          .toEqual({ status: 'ok', value: { status: 'ok', current: true } })
      }
      const stagedReceipt = (command: any, rendererId: string) => {
        const payload = command.payload
        stages.set(rendererId, payload)
        const { graphs: _graphs, ...visible } = payload
        void _graphs
        expect(JSON.stringify(visible).includes('https://example.test/fixtures')).toBe(false)
        expect(JSON.stringify(visible).includes('file:///cordisx-store/')).toBe(false)
        return {
          transactionId: payload.transactionId,
          transactionEpoch: payload.transactionEpoch,
          expectedRegistryEpoch: payload.expectedRegistryEpoch,
          afterRegistryEpoch: payload.afterRegistryEpoch,
          affectedPluginIds: payload.affectedPluginIds,
          observation: payload.candidate,
        }
      }
      if (outcome === 'disconnect' || outcome === 'observation-disconnect') {
        const polled = await Promise.all(peers.map(async peer => await f.sessions.poll(peer, 20_000))) as any[]
        const graphSession = graphSessions.get(peers[0]!.handle.rendererId)!
        const command = graphSession.projectCommand(polled[0]!.value.command) as any
        expect(command.method).toBe('stage')
        expect(graphSessions.get(second.handle.rendererId)!.projectCommand(polled[1]!.value.command))
          .toMatchObject({ method: 'stage' })
        const receipt = {
          id: command.id,
          sequence: command.sequence,
          ok: true,
          value: stagedReceipt(command, peers[0]!.handle.rendererId),
        }
        expect(await f.sessions.acknowledge(peers[0]!, receipt))
          .toEqual({ status: 'ok', value: { accepted: true } })
        graphSession.acknowledge(receipt)
        await f.sessions.close(second)
        expect((await installing).outcome).not.toBe('applied')
        expect(await f.sessions.call(peers[0]!, 'manager-bootstrap', { action: 'status' }))
          .toEqual({ status: 'unavailable' })
        expect(await f.sessions.call(second, 'manager-bootstrap', { action: 'status' }))
          .toEqual({ status: 'unavailable' })
        if (pendingObservation) expect(await pendingObservation).toEqual({ status: 'unavailable' })
        return
      }
      await delivered('stage', stagedReceipt)
      const firstStage = stages.get(peers[0]!.handle.rendererId)
      const secondStage = stages.get(peers[1]!.handle.rendererId)
      expect(firstStage.package.identitySource).not.toBe(secondStage.package.identitySource)
      await delivered('publish', (_command, rendererId) => {
        const stage = stages.get(rendererId)
        return {
          transactionId: stage.transactionId,
          transactionEpoch: stage.transactionEpoch,
          registryEpoch: stage.afterRegistryEpoch,
          active: stage.candidate,
          retiring: stage.previous,
          notificationErrors: [],
        }
      })
      if (pendingObservation) {
        await new Promise(resolve => setImmediate(resolve))
        expect(observationSettled).toBe(false)
      }
      if (outcome !== 'rollback' && outcome !== 'observation-rollback') {
        await delivered('complete', (_command, rendererId) => {
          const stage = stages.get(rendererId)
          return {
            transactionId: stage.transactionId,
            transactionEpoch: stage.transactionEpoch,
            registryEpoch: stage.afterRegistryEpoch,
            active: stage.candidate,
            disposedAfter: stage.previous,
          }
        })
        await delivered('finalize', command => command.payload)
        expect((await installing).outcome).toBe('applied')
      } else {
        await delivered('rollback', command => command.payload.expected)
        await delivered('synchronize', command => command.payload)
        expect(await installing).toMatchObject({ outcome: 'rolled-back' })
      }
      const afterViews = await Promise.all(
        peers.map(async peer => await f.sessions.call(peer, 'plugin-management', query())),
      ) as any[]
      for (const [index, view] of afterViews.entries()) {
        expect(view.status).toBe('ok')
        expect(view.value.value.plugins).toHaveLength(
          outcome === 'rollback' || outcome === 'observation-rollback' ? 1 : 2,
        )
        const managed = view.value.value.plugins.find((plugin: any) => plugin.id === 'fixture-service')
        const installed = view.value.value.plugins.find((plugin: any) => plugin.id === 'other-plugin')
        expect(managed.canonicalSource).toBe(originalAliases[index])
        expect(managed.availableOperations).toEqual([])
        if (outcome === 'rollback' || outcome === 'observation-rollback') {
          expect(installed).toBeUndefined()
        } else {
          expect(installed.availableOperations).toEqual(['disable', 'uninstall'])
        }
        expect(await f.sessions.call(peers[index]!, 'manager-bootstrap', { action: 'status' }))
          .toEqual({ status: 'ok', value: { status: 'ok', current: true } })
      }
      for (const index of peers.keys()) await readManagedService(index)
      if (pendingObservation) {
        f.managed.startup.selectOwners(
          f.lifecycle.snapshot().active.plugins.map(plugin => ({
            pluginId: plugin.id,
            pluginGeneration: plugin.moduleGeneration,
          })),
        )
        expect(
          await Promise.race([
            pendingObservation,
            new Promise((_, reject) => setTimeout(() => reject(new Error('startup observation stalled')), 5_000)),
          ]),
        ).toMatchObject({ status: 'ok', value: { ok: true } })
      }
    } finally {
      for (const graphSession of graphSessions.values()) graphSession.close()
      await f.sessions.close(second).catch(() => undefined)
      await f.close()
    }
  },
  120_000,
)
