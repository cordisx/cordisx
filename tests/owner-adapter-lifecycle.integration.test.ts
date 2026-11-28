import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import { OwnerAdapterAdmission } from '../packages/cli/src/cli/owner-adapter-admission.js'
import { managerRendererGatewayPaths } from '../packages/cli/src/cli/manager-renderer-gateway.js'
import { createProductionManagedServiceLifecycle } from '../packages/cli/src/cli/production-managed-services.js'
import { openProductionPluginManagementComposition } from '../packages/cli/src/cli/production-plugin-management.js'
import { startSupervisorControlServer } from '../packages/cli/src/cli/supervisor-control.js'
import {
  effectiveConfigFingerprint,
  processStartIdentity,
  type SupervisorState,
  writeSupervisorState,
} from '../packages/cli/src/cli/supervisor-state.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { createManagerRendererLifecycleClient } from '../packages/cli/src/independent-manager/lifecycle-client.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../packages/cli/src/launcher/management-rpc.js'
import { PluginActivationStore } from '../packages/cli/src/launcher/plugin-activation.js'
import { loadPluginComposition } from '../packages/cli/src/launcher/plugin-composition.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { removeStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import { attachmentHomeDigest } from '../packages/cli/src/launcher/renderer-lifecycle-peer.js'
import { ServiceRendererLifecycle } from '../packages/cli/src/launcher/service-renderer-lifecycle.js'
import type { RendererPluginMutation } from '../packages/cli/src/renderer/runtime-shared.js'
import { decision, FormalRuntime, localPackage, request } from './suites/plugin-lifecycle.fixtures.js'

const secret = () => randomBytes(32).toString('hex')

it.each([false, true])(
  'issues two fixture adapter identities through one real owner and fences disconnect: %s',
  async disconnectDuringStage => {
    const root = await mkdtemp('/tmp/cx-owner-adapter-')
    const homeDir = path.join(root, 'home')
    const configPath = path.join(homeDir, 'config.json')
    const profileId = 'default'
    const generation = 'fixture-owner'
    const scopedRequest = (...args: Parameters<typeof request>) => ({ ...request(...args), profileId })
    await mkdir(homeDir)
    await writeFile(configPath, JSON.stringify(createDefaultHomeConfig()))
    const seed = new PluginLifecycleCoordinator({
      homeDir,
      profileId,
      runtimeGeneration: generation,
      permissionPolicies: [],
      runtime: new FormalRuntime(),
      headless: true,
    })
    for (const [revision, id] of ['fixture-one', 'fixture-two'].entries()) {
      const sourceDirectory = await localPackage({ root, id })
      const planned = await seed.handle(scopedRequest({ kind: 'inspect-local', sourceDirectory }, revision, generation))
      const installed = await seed.handle(scopedRequest(
        {
          kind: 'install',
          candidateId: planned.candidateId!,
          authorizationDecision: decision(planned.authorizationPlan!),
        },
        revision,
        generation,
      ))
      expect(installed).toMatchObject({ outcome: 'applied', revision: revision + 1 })
    }
    const store = new PluginActivationStore(homeDir, profileId, generation)
    const active = await store.bindRuntimeGeneration()
    const scope = { homeDigest: attachmentHomeDigest(homeDir), ownerAppId: 'codex', profileId, generation }
    const lifecycle = new ServiceRendererLifecycle({
      scope,
      projectMutation: (mutation, identity) => ({
        rendererId: identity.rendererId,
        transactionId: mutation.transactionId,
        transactionEpoch: mutation.transactionEpoch,
        expectedRegistryEpoch: mutation.expectedRegistryEpoch,
        afterRegistryEpoch: mutation.afterRegistryEpoch,
        operation: mutation.operation,
        previous: mutation.previous,
        candidate: mutation.candidate,
        targetId: mutation.targetId,
        affectedPluginIds: mutation.affectedPluginIds,
        graphs: [],
      }),
    })
    lifecycle.initialize(active)
    const admission = new OwnerAdapterAdmission({ scope, attach: async peer => await lifecycle.attach(peer) })
    const identities: unknown[] = []
    const participant = {
      create: (input: Parameters<typeof admission.participant.create>[0]) => {
        const peer = admission.participant.create(input)
        identities.push({ identity: peer.identity, scope: peer.scope })
        return peer
      },
      attach: admission.participant.attach,
    }
    const managed = createProductionManagedServiceLifecycle({
      runtime: lifecycle,
      homeDir,
      profileId,
      generation,
      environment: { PATH: process.env.PATH, HOME: root },
      store,
      dryRun: false,
      requireOwnedProcess: true,
    })
    const coordinator = new PluginLifecycleCoordinator({
      homeDir,
      profileId,
      runtimeGeneration: generation,
      permissionPolicies: [],
      runtime: managed,
      headless: true,
    })
    const processStartedAt = (await processStartIdentity(process.pid))!
    const paths = managerRendererGatewayPaths(homeDir, profileId)
    const state: SupervisorState = {
      schemaVersion: 1,
      appId: 'manager',
      profileId,
      phase: 'ready',
      pid: process.pid,
      processStartedAt,
      instanceToken: secret(),
      createdAt: new Date().toISOString(),
      version: 'fixture',
      effectiveConfig: effectiveConfigFingerprint({ appId: 'codex', generation }),
    }
    const gateway = { pid: state.pid, processStartedAt, instanceToken: state.instanceToken }
    await mkdir(path.dirname(paths.socket), { recursive: true, mode: 0o700 })
    const control = await startSupervisorControlServer({
      socketPath: paths.socket,
      token: state.instanceToken,
      stop: () => {},
    })
    const doms: JSDOM[] = []
    const clients: Array<{ close(): Promise<void> }> = []
    const loops: Promise<void>[] = []
    const loopErrors: string[] = []
    let shuttingDown = false
    let composition: Awaited<ReturnType<typeof openProductionPluginManagementComposition>> | undefined
    try {
      await writeSupervisorState(paths, state)
      await (await managed.initialize(active)).coreReady
      composition = await openProductionPluginManagementComposition({
        homeDir,
        configPath,
        appId: 'codex',
        profileId,
        runtimeGeneration: generation,
        token: secret(),
        coordinator,
        rendererParticipant: participant,
        processStartedAt,
      })
      const rpcPaths = pluginManagementRpcPaths(homeDir, 'codex', profileId)
      const endpoint = (await readPluginManagementRpcEndpoint(rpcPaths))!
      const send = async (value: unknown) => await requestPluginManagementRpc(rpcPaths, endpoint, value as never) as any
      const open = async (browserSessionId: string) =>
        await send({ kind: 'manager-renderer', action: 'open', gateway, browserSessionId })
      expect(await open(secret())).toEqual({ status: 'unavailable' })
      const bundle = await buildRendererBundle({
        version: 1,
        rootDir: process.cwd(),
        codex: { debugPort: 9229 },
        providers: [],
        plugins: await loadPluginComposition(store, active),
      }, { profileId, generation, pluginActivation: active })
      const adapters = []
      for (const [index, name] of ['fixture-a', 'fixture-b'].entries()) {
        const browserSessionId = admission.issue({ appId: `${name}-app`, adapterId: `${name}-adapter` }, gateway)
        const opened = await open(browserSessionId)
        expect(opened).toMatchObject({ status: 'ok', commands: true })
        const dom = new JSDOM('<!doctype html><html><body></body></html>', {
          runScripts: 'dangerously',
          url: `https://${name}.invalid/`,
        })
        doms.push(dom)
        Object.defineProperty(dom.window, 'structuredClone', { configurable: true, value: structuredClone })
        Object.assign(dom.window, { TextEncoder, TextDecoder })
        dom.window.eval(bundle)
        await vi.waitFor(() => expect(dom.window.document.documentElement.dataset.cordisxReady).toBe('true'), {
          timeout: 10_000,
        })
        const runtime = (dom.window as any).__cordisxRuntime
        const client = createManagerRendererLifecycleClient({
          runtime,
          scope: { profileId, generation, rendererId: opened.handle.rendererId },
          loader: {
            async load(projection) {
              const { rendererId: _renderer, graphs: _graphs, ...mutation } = projection
              void _renderer
              void _graphs
              return { mutation: mutation as unknown as RendererPluginMutation, publish() {}, commit() {}, retire() {} }
            },
            dispose() {},
          },
        })
        clients.push(client)
        const common = { kind: 'manager-renderer' as const, gateway, browserSessionId, handle: opened.handle }
        const methods: string[] = []
        const loop = (async () => {
          while (!client.closed) {
            const response = await send({ ...common, action: 'poll', timeoutMs: 1000 })
            if (response.status !== 'ok') break
            const command = response.value.command
            if (!command) continue
            methods.push(command.method)
            if (disconnectDuringStage && index === 1 && command.method === 'stage') {
              await send({ kind: 'manager-renderer', action: 'revoke', gateway, browserSessionId })
              break
            }
            const receipt = await client.handle(command)
            const acknowledged = await send({ ...common, action: 'acknowledge', receipt })
            if (acknowledged.status !== 'ok' || !receipt.ok) break
          }
          await client.close()
        })().catch(error => {
          if (!shuttingDown) loopErrors.push(String(error))
        })
        loops.push(loop)
        expect(await send({ ...common, action: 'admit' })).toEqual({ status: 'ok', value: { admitted: true } })
        adapters.push({ name, browserSessionId, runtime, methods })
      }
      expect(identities).toEqual(adapters.map(item => ({
        identity: {
          appId: `${item.name}-app`,
          adapterId: `${item.name}-adapter`,
          rendererId: expect.any(String),
          pid: process.pid,
          processStartedAt,
        },
        scope,
      })))
      const reservation = admission.reserve()
      expect(reservation.peers.map(peer => peer.identity.adapterId)).toEqual([
        'fixture-a-adapter',
        'fixture-b-adapter',
      ])
      expect(() => admission.issue({ appId: 'third-app', adapterId: 'third-adapter' }, gateway))
        .toThrow('adapter-admission-unavailable')
      expect(reservation.release()).toBe(true)
      const disable = async (id: string) => {
        const revision = (await store.loadActive()).revision
        const planned = await coordinator.handle(
          scopedRequest({ kind: 'disable', pluginId: id, impactToken: 'probe' }, revision, generation),
        )
        expect(planned).toMatchObject({ outcome: 'planned' })
        return await coordinator.handle(scopedRequest(
          {
            kind: 'disable',
            pluginId: id,
            impactToken: planned.impactToken!,
          },
          revision,
          generation,
        ))
      }
      const result = await disable('fixture-one')
      if (disconnectDuringStage) {
        expect(result).toMatchObject({ outcome: 'rollback-failed' })
        expect(lifecycle.requiresReconciliation).toBe(true)
        expect(adapters[1]!.methods).toContain('stage')
      } else {
        expect(result).toMatchObject({ outcome: 'applied', revision: 3 })
        for (const adapter of adapters) {
          expect(adapter.runtime.activePluginGeneration().plugins.map((item: { enabled: boolean }) => item.enabled))
            .toEqual([false, true])
          expect(adapter.methods).toEqual(['synchronize', 'prepare', 'stage', 'publish', 'complete', 'finalize'])
        }
        expect(
          await send({
            kind: 'manager-renderer',
            action: 'revoke',
            gateway,
            browserSessionId: adapters[1]!.browserSessionId,
          }),
        )
          .toEqual({ status: 'ok' })
        expect(await disable('fixture-two')).toMatchObject({ outcome: 'applied', revision: 4 })
        expect(adapters[0]!.runtime.activePluginGeneration().plugins.map((item: { enabled: boolean }) => item.enabled))
          .toEqual([false, false])
        expect(lifecycle.requiresReconciliation).toBe(false)
      }
      expect(loopErrors).toEqual([])
    } finally {
      shuttingDown = true
      await composition?.close().catch(() => {})
      admission.close()
      await Promise.allSettled(loops)
      await Promise.allSettled(clients.map(client => client.close()))
      for (const dom of doms) dom.window.close()
      await managed.dispose()
      await lifecycle.close()
      await control.close()
      const digests = await readdir(path.join(homeDir, 'packages', 'sha256')).catch(() => [])
      await Promise.all(digests.map(async digest => await removeStagedPluginPackage(homeDir, `sha256:${digest}`)))
      await rm(root, { recursive: true, force: true })
    }
  },
  90_000,
)
