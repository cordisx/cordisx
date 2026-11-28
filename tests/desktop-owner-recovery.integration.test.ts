import { mkdtemp, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import { DesktopOwnerRendererLifecycle } from '../packages/cli/src/cli/desktop-owner-renderer-lifecycle.js'
import { createProductionManagedServiceLifecycle } from '../packages/cli/src/cli/production-managed-services.js'
import { recoveredActivation } from '../packages/cli/src/cli/run-support.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { CdpPluginLifecycleRuntime } from '../packages/cli/src/launcher/cdp-plugin-lifecycle-runtime.js'
import { PluginActivationStore } from '../packages/cli/src/launcher/plugin-activation.js'
import { loadPluginComposition } from '../packages/cli/src/launcher/plugin-composition.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { PlatformProviderPluginLifecycleRuntime } from '../packages/cli/src/launcher/platform-provider-plugin-lifecycle.js'
import { startPluginGenerationArtifactServer } from '../packages/cli/src/launcher/plugin-generation-artifact-server.js'
import { removeStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import { attachmentHomeDigest } from '../packages/cli/src/launcher/renderer-lifecycle-peer.js'
import { decision, FormalRuntime, localPackage, request } from './suites/plugin-lifecycle.fixtures.js'

it('withholds Manager admission until the real Desktop owner completes durable startup recovery', async () => {
  const root = await mkdtemp('/tmp/cx-desktop-recovery-')
  const homeDir = path.join(root, 'home')
  const generation = 'runtime-1'
  const interrupted = new FormalRuntime()
  interrupted.failComplete = true
  interrupted.failRollback = true
  const first = new PluginLifecycleCoordinator({
    homeDir,
    profileId: 'work',
    runtimeGeneration: generation,
    permissionPolicies: [],
    runtime: interrupted,
  })
  const sourceDirectory = await localPackage({ root, id: 'interrupted' })
  const plan = await first.handle(request({ kind: 'inspect-local', sourceDirectory }))
  expect(
    await first.handle(
      request({
        kind: 'install',
        candidateId: plan.candidateId!,
        authorizationDecision: decision(plan.authorizationPlan!),
      }),
    ),
  ).toMatchObject({ outcome: 'rollback-failed' })
  const server = await startPluginGenerationArtifactServer()
  const cdp = new CdpPluginLifecycleRuntime()
  const store = new PluginActivationStore(homeDir, 'work', generation)
  const owner = new DesktopOwnerRendererLifecycle({
    scope: { homeDigest: attachmentHomeDigest(homeDir), ownerAppId: 'codex', profileId: 'work', generation },
    cdp,
    artifactServer: server,
    projectManagerMutation: () => undefined,
  })
  const managed = createProductionManagedServiceLifecycle({
    runtime: new PlatformProviderPluginLifecycleRuntime(owner),
    homeDir,
    profileId: 'work',
    generation,
    environment: { PATH: process.env.PATH, HOME: root },
    store,
    dryRun: false,
    requireOwnedProcess: true,
  })
  const coordinator = new PluginLifecycleCoordinator({
    homeDir,
    profileId: 'work',
    runtimeGeneration: generation,
    permissionPolicies: [],
    runtime: managed,
  })
  let dom: JSDOM | undefined
  let unregister: (() => void) | undefined
  try {
    const recovery = await coordinator.prepareRecovery()
    expect(recovery).toHaveLength(1)
    const initial = recoveredActivation(recovery[0]!, generation)
    owner.initialize(initial, true)
    await (await managed.initialize(initial)).coreReady
    expect(() => owner.snapshot()).toThrow('unavailable')
    await expect(coordinator.recover()).rejects.toThrow('Plugin lifecycle participant rollback failed')
    expect(() => owner.snapshot()).toThrow('unavailable')
    const plugins = await loadPluginComposition(store, initial)
    const bundle = await buildRendererBundle({
      version: 1,
      rootDir: process.cwd(),
      codex: { debugPort: 9229 },
      providers: [],
      plugins,
    }, {
      profileId: 'work',
      generation,
      pluginActivation: initial,
      initialRegistryEpoch: recovery[0]!.rollbackRegistryEpoch,
    })
    dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'dangerously',
      url: 'https://desktop.invalid/',
    })
    Object.defineProperty(dom.window, 'structuredClone', { configurable: true, value: structuredClone })
    Object.assign(dom.window, { TextEncoder, TextDecoder })
    dom.window.eval(bundle)
    await vi.waitFor(() => expect(dom!.window.document.documentElement.dataset.cordisxReady).toBe('true'), {
      timeout: 10_000,
    })
    const session = {
      async send(_method: string, params: Record<string, unknown>) {
        try {
          const value = await dom!.window.eval(String(params.expression ?? ''))
          return { result: { value: JSON.parse(JSON.stringify(value)) } }
        } catch (error) {
          return { exceptionDetails: { text: error instanceof Error ? error.message : String(error) } }
        }
      },
    }
    const joining = cdp.beginJoin(session as never)
    expect(await coordinator.recover()).toHaveLength(1)
    expect(() => owner.snapshot()).toThrow('unavailable')
    await cdp.synchronizeRecoveredActivation(session as never)
    unregister = joining.commit(await cdp.synchronizeDevelopmentStatus(session as never))
    expect(unregister).toBeTypeOf('function')
    const snapshot = owner.snapshot()
    expect(snapshot.active).toEqual(await store.loadActive())
    expect(snapshot.registryEpoch).toBe(recovery[0]!.rollbackRegistryEpoch)
    unregister!()
    unregister = undefined
    expect(() => owner.snapshot()).toThrow('unavailable')
    await owner.close()
    expect(() => owner.snapshot()).toThrow('unavailable')
  } finally {
    unregister?.()
    await owner.close()
    await managed.dispose()
    const runtime = (dom?.window as any)?.__cordisxRuntime
    await runtime?.dispose()
    dom?.window.close()
    await server.close()
    const digests = await readdir(path.join(homeDir, 'packages', 'sha256')).catch(() => [])
    await Promise.all(digests.map(async digest => await removeStagedPluginPackage(homeDir, `sha256:${digest}`)))
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
