import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { transform } from 'esbuild'
import { expect, it, vi } from 'vitest'
import { createDesktopManagerOwnerIfEligible } from '../packages/cli/src/cli/desktop-manager-owner.js'
import { decodeManagerRendererBundle } from '../packages/cli/src/cli/manager-renderer-bundle-codec.js'
import { managerRendererGatewayPaths } from '../packages/cli/src/cli/manager-renderer-gateway.js'
import { openProductionPluginManagementComposition } from '../packages/cli/src/cli/production-plugin-management.js'
import { createProductionManagedServiceLifecycle } from '../packages/cli/src/cli/production-managed-services.js'
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
import { CdpPluginLifecycleRuntime } from '../packages/cli/src/launcher/cdp-plugin-lifecycle-runtime.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../packages/cli/src/launcher/management-rpc.js'
import { PluginActivationStore } from '../packages/cli/src/launcher/plugin-activation.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { PlatformProviderPluginLifecycleRuntime } from '../packages/cli/src/launcher/platform-provider-plugin-lifecycle.js'
import { startPluginGenerationArtifactServer } from '../packages/cli/src/launcher/plugin-generation-artifact-server.js'
import { removeStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import { decision, localPackage, request } from './suites/plugin-lifecycle.fixtures.js'

const secret = () => randomBytes(32).toString('hex')

it('attaches the real management composition to one existing Desktop owner and rejects zero CDP seats', async () => {
  const homeDir = await mkdtemp('/tmp/cx-desktop-manager-owner-')
  const configPath = path.join(homeDir, 'config.json')
  await writeFile(configPath, JSON.stringify(createDefaultHomeConfig()))
  const profileId = 'default'
  const generation = 'desktop-owner-fixture'
  const scope = { homeDir, configPath, appId: 'codex', profileId, generation }
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
  const artifactServer = await startPluginGenerationArtifactServer()
  const cdp = new CdpPluginLifecycleRuntime()
  const store = new PluginActivationStore(homeDir, profileId, generation)
  const eligibility = {
    ...scope,
    cdp,
    artifactServer,
    store,
    ownerVerified: true,
    attach: false,
    configuredPluginCount: 0,
  }
  expect(await createDesktopManagerOwnerIfEligible({ ...eligibility, ownerVerified: false })).toBeUndefined()
  expect(await createDesktopManagerOwnerIfEligible({ ...eligibility, attach: true })).toBeUndefined()
  expect(await createDesktopManagerOwnerIfEligible({ ...eligibility, configuredPluginCount: 1 })).toBeUndefined()
  const before = await store.loadActive()
  const loadActive = vi.spyOn(store, 'loadActive').mockResolvedValueOnce({ ...before, plugins: [{} as never] })
  expect(await createDesktopManagerOwnerIfEligible(eligibility)).toBeUndefined()
  loadActive.mockRestore()
  const owner = await createDesktopManagerOwnerIfEligible(eligibility)
  if (!owner) throw new Error('empty owned Desktop profile was unexpectedly refused')
  const managed = createProductionManagedServiceLifecycle({
    runtime: new PlatformProviderPluginLifecycleRuntime(owner.lifecycle),
    homeDir,
    profileId,
    generation,
    environment: { PATH: process.env.PATH, HOME: homeDir },
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
  })
  let composition: Awaited<ReturnType<typeof openProductionPluginManagementComposition>> | undefined
  let dom: JSDOM | undefined
  let managerDom: JSDOM | undefined
  let unregister: (() => void) | undefined
  try {
    await writeSupervisorState(paths, state)
    const recovered = await coordinator.prepareRecovery()
    expect(recovered).toHaveLength(0)
    const active = await store.bindRuntimeGeneration()
    owner.initialize(active, false)
    await (await managed.initialize(active)).coreReady
    composition = await openProductionPluginManagementComposition({
      homeDir,
      configPath,
      appId: 'codex',
      profileId,
      runtimeGeneration: generation,
      token: secret(),
      coordinator,
      ...owner.managementOptions,
      processStartedAt,
    })
    const rpcPaths = pluginManagementRpcPaths(homeDir, 'codex', profileId)
    const endpoint = (await readPluginManagementRpcEndpoint(rpcPaths))!
    const open = async (browserSessionId: string) =>
      await requestPluginManagementRpc(rpcPaths, endpoint, {
        kind: 'manager-renderer',
        action: 'open',
        gateway,
        browserSessionId,
      }) as any
    expect(await open(secret())).toEqual({ status: 'unavailable' })
    const bundle = await buildRendererBundle({
      version: 1,
      rootDir: process.cwd(),
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [],
    }, { profileId, generation, pluginActivation: active })
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
    unregister = cdp.register(session as never)
    const browserSessionId = secret()
    const opened = await open(browserSessionId)
    expect(opened).toMatchObject({ status: 'ok', commands: true, channels: ['plugin-management'] })
    const common = { kind: 'manager-renderer' as const, gateway, browserSessionId, handle: opened.handle }
    const call = async (payload: unknown) =>
      await requestPluginManagementRpc(rpcPaths, endpoint, {
        ...common,
        action: 'call',
        channel: 'manager-bootstrap',
        payload,
      }) as any
    expect(await call({ action: 'status' })).toEqual({ status: 'ok', value: { status: 'ok', current: true } })
    expect(owner.lifecycle.snapshot()).toEqual({ active, registryEpoch: 0 })
    const prepared = await call({ action: 'prepare' })
    expect(prepared).toMatchObject({ status: 'ok', value: { status: 'ok', privateGraphs: [] } })
    const completed = await call({ action: 'complete', managerOrigin: 'http://127.0.0.1:43123', graphs: [] })
    expect(completed.status).toBe('ok')
    const bytes = await decodeManagerRendererBundle(completed.value.bundle)
    managerDom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'dangerously',
      url: 'http://127.0.0.1:43123/',
    })
    Object.defineProperty(managerDom.window, 'structuredClone', { configurable: true, value: structuredClone })
    Object.assign(managerDom.window, { TextEncoder, TextDecoder })
    const source = await transform(bytes.toString('utf8'), { format: 'iife', globalName: '__testOwnerModule' })
    bytes.fill(0)
    managerDom.window.eval(source.code)
    const managerRuntime = await (managerDom.window as any).__testOwnerModule.startStandaloneManagerComposition(
      new AbortController().signal,
    )
    const client = createManagerRendererLifecycleClient({
      runtime: managerRuntime,
      scope: { profileId, generation, rendererId: opened.handle.rendererId },
    })
    const poll = requestPluginManagementRpc(rpcPaths, endpoint, { ...common, action: 'poll', timeoutMs: 3000 })
    const admit = requestPluginManagementRpc(rpcPaths, endpoint, { ...common, action: 'admit' })
    const command = await poll as any
    expect(command).toMatchObject({ status: 'ok', value: { command: { method: 'synchronize' } } })
    const receipt = await client.handle(command.value.command)
    expect(receipt.ok).toBe(true)
    expect(await requestPluginManagementRpc(rpcPaths, endpoint, { ...common, action: 'acknowledge', receipt })).toEqual(
      { status: 'ok', value: { accepted: true } },
    )
    expect(await admit).toEqual({ status: 'ok', value: { admitted: true } })
    const sourceDirectory = await localPackage({ root: homeDir, id: 'unsupported-live-install' })
    const planned = await coordinator.handle({
      ...request({ kind: 'inspect-local', sourceDirectory }, 0, generation),
      profileId,
    })
    const denied = await coordinator.handle({
      ...request(
        {
          kind: 'install',
          candidateId: planned.candidateId!,
          authorizationDecision: decision(planned.authorizationPlan!),
        },
        0,
        generation,
      ),
      profileId,
    })
    expect(denied).toMatchObject({ outcome: 'rejected', error: { code: 'operation-unavailable' } })
    expect((await store.loadActive()).revision).toBe(0)
    unregister()
    unregister = undefined
    expect(await call({ action: 'status' })).toEqual({ status: 'unavailable' })
    expect(await requestPluginManagementRpc(rpcPaths, endpoint, { ...common, action: 'poll', timeoutMs: 100 }))
      .toEqual({ status: 'unavailable' })
    expect(await open(secret())).toEqual({ status: 'unavailable' })
    unregister = cdp.register(session as never)
    expect(await open(secret())).toMatchObject({ status: 'ok', commands: true })
    await composition.close()
    composition = undefined
    await client.close()
    expect(() => owner.lifecycle.snapshot()).not.toThrow()
    unregister()
    unregister = undefined
    expect(() => owner.lifecycle.snapshot()).toThrow('unavailable')
    owner.close()
    expect(() => owner.lifecycle.snapshot()).toThrow('unavailable')
  } finally {
    await composition?.close().catch(() => undefined)
    unregister?.()
    owner.close()
    await managed.dispose()
    await (dom?.window as any)?.__cordisxRuntime?.dispose()
    managerDom?.window.close()
    dom?.window.close()
    await artifactServer.close()
    await control.close()
    const digests = await readdir(path.join(homeDir, 'packages', 'sha256')).catch(() => [])
    await Promise.all(digests.map(async digest => await removeStagedPluginPackage(homeDir, `sha256:${digest}`)))
    await rm(homeDir, { recursive: true, force: true })
  }
}, 90_000)
