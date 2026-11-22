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
import { createDefaultHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
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
import { persistPermissionPolicies } from '../packages/cli/src/launcher/permission-rpc.js'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'
import { decision, FormalRuntime, localPackage, request } from './suites/plugin-lifecycle.fixtures.js'
import { stageServiceModePlugin } from './fixtures/service-mode-plugin.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'

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
    configuredPlugins: [],
  }
  expect(await createDesktopManagerOwnerIfEligible({ ...eligibility, ownerVerified: false })).toBeUndefined()
  expect(await createDesktopManagerOwnerIfEligible({ ...eligibility, attach: true })).toBeUndefined()
  expect(
    await createDesktopManagerOwnerIfEligible({
      ...eligibility,
      configuredPlugins: [{ id: 'other', entry: '/fixture/other.js', enabled: true, config: {} }],
    }),
  ).toBeUndefined()
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
    owner.initialize(active, false, managed)
    await (await managed.initialize(active)).coreReady
    expect(owner.bindManagedServiceRuntime(managed)).toBe(false)
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
    expect(opened).toMatchObject({
      status: 'ok',
      commands: true,
      channels: process.platform === 'darwin' || process.platform === 'linux'
        ? ['plugin-management', 'managed-service-ui']
        : ['plugin-management'],
    })
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
    const updatePlugins = async () =>
      await updateHomeConfigAtomic(current => ({
        ...current,
        plugins: [{ id: 'fixture-config', entry: '/fixture/plugin.js' }],
      }), configPath)
    const policy = createPermissionPolicyRecord({
      profileId,
      identity: { source: 'https://example.test/fixture', id: 'fixture' },
      capability: 'models.read',
      scope: { providers: ['codex'] },
      policy: 'deny',
    })
    if (process.platform === 'darwin' || process.platform === 'linux') {
      await expect(updatePlugins()).rejects.toThrow('plugin configuration is in use')
      await expect(persistPermissionPolicies({ configPath }, [policy])).rejects.toThrow('permission policy is in use')
      await persistPermissionPolicies({ configPath }, [{ ...policy, key: { ...policy.key, profileId: 'other' } }])
      const secondId = secret()
      const second = await open(secondId)
      expect(second).toMatchObject({ status: 'ok' })
      expect(
        await requestPluginManagementRpc(rpcPaths, endpoint, {
          kind: 'manager-renderer',
          action: 'call',
          gateway,
          browserSessionId: secondId,
          handle: second.handle,
          channel: 'manager-bootstrap',
          payload: { action: 'prepare' },
        }),
      ).toMatchObject({ status: 'ok', value: { status: 'ok' } })
      expect(
        await requestPluginManagementRpc(rpcPaths, endpoint, {
          kind: 'manager-renderer',
          action: 'revoke',
          gateway,
          browserSessionId: secondId,
        }),
      ).toEqual({ status: 'ok' })
      await expect(updatePlugins()).rejects.toThrow('plugin configuration is in use')
    }
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
    const sourceDirectory = await localPackage({
      root: homeDir,
      id: 'unsupported-live-install',
      requiredCapability: true,
    })
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
    expect(
      await requestPluginManagementRpc(rpcPaths, endpoint, {
        kind: 'manager-renderer',
        action: 'revoke',
        gateway,
        browserSessionId,
      }),
    ).toEqual({ status: 'ok' })
    if (process.platform === 'darwin' || process.platform === 'linux') {
      await updatePlugins()
      await persistPermissionPolicies({ configPath }, [policy])
    }
    unregister = cdp.register(session as never)
    expect(await open(secret())).toMatchObject({ status: 'ok', commands: true })
    await composition.close()
    composition = undefined
    await client.close()
    expect(() => owner.lifecycle.snapshot()).not.toThrow()
    unregister()
    unregister = undefined
    expect(() => owner.lifecycle.snapshot()).toThrow('unavailable')
    await owner.close()
    expect(() => owner.lifecycle.snapshot()).toThrow('unavailable')
  } finally {
    await composition?.close().catch(() => undefined)
    unregister?.()
    await owner.close()
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

it.each([false, true])(
  'admits an existing Desktop package only when its browser graph is supported: capability %s',
  async requiredCapability => {
    const root = await mkdtemp('/tmp/cx-desktop-owner-package-')
    const homeDir = path.join(root, 'home')
    const configPath = path.join(homeDir, 'config.json')
    const profileId = 'work'
    const generation = 'runtime-1'
    await mkdir(homeDir, { mode: 0o700 })
    await writeFile(configPath, JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
    const seed = new PluginLifecycleCoordinator({
      homeDir,
      profileId,
      runtimeGeneration: generation,
      permissionPolicies: [],
      runtime: new FormalRuntime(),
      headless: true,
    })
    const artifactServer = await startPluginGenerationArtifactServer()
    let owner: Awaited<ReturnType<typeof createDesktopManagerOwnerIfEligible>>
    try {
      const sourceDirectory = await localPackage({ root, id: 'installed-fixture', requiredCapability })
      const planned = await seed.handle(request({ kind: 'inspect-local', sourceDirectory }, 0, generation))
      const installed = await seed.handle(request(
        {
          kind: 'install',
          candidateId: planned.candidateId!,
          authorizationDecision: decision(planned.authorizationPlan!),
        },
        0,
        generation,
      ))
      expect(installed).toMatchObject({ outcome: 'applied' })
      const store = new PluginActivationStore(homeDir, profileId, generation)
      owner = await createDesktopManagerOwnerIfEligible({
        homeDir,
        configPath,
        appId: 'codex',
        profileId,
        generation,
        cdp: new CdpPluginLifecycleRuntime(),
        artifactServer,
        store,
        ownerVerified: true,
        attach: false,
        configuredPlugins: [],
      })
      expect(Boolean(owner)).toBe(!requiredCapability)
    } finally {
      await owner?.close()
      await artifactServer.close()
      const digests = await readdir(path.join(homeDir, 'packages', 'sha256')).catch(() => [])
      await Promise.all(digests.map(async digest => await removeStagedPluginPackage(homeDir, `sha256:${digest}`)))
      await rm(root, { recursive: true, force: true })
    }
  },
  90_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'binds the running Desktop managed-service authority to an admitted Manager',
  async () => {
    const root = await mkdtemp('/tmp/cx-desktop-managed-owner-')
    const homeDir = path.join(root, 'home')
    const configPath = path.join(homeDir, 'config.json')
    const profileId = 'default'
    const generation = 'desktop-managed-fixture'
    const source = 'https://example.test/fixtures'
    await mkdir(homeDir, { mode: 0o700 })
    await writeFile(configPath, JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
    await stageServiceModePlugin(root, homeDir, profileId, true, source, 'export function apply() {}', {
      version: 15,
      uiPoints: ['manager.content', 'manager.settings.navigation-items'],
    })
    const policies = exactDomPermissionPolicies(profileId, [{
      id: 'fixture-service',
      entry: '/fixture/entry.js',
      pointIds: ['manager.content', 'manager.settings.navigation-items'],
    }]).map(policy => ({ ...policy, key: { ...policy.key, identity: { ...policy.key.identity, source } } }))
    await persistPermissionPolicies({ configPath }, policies)
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
    const owner = await createDesktopManagerOwnerIfEligible({
      homeDir,
      configPath,
      appId: 'codex',
      profileId,
      generation,
      cdp,
      artifactServer,
      store,
      ownerVerified: true,
      attach: false,
      configuredPlugins: [],
    })
    if (!owner) throw new Error('managed Desktop profile was unexpectedly refused')
    const managed = createProductionManagedServiceLifecycle({
      runtime: new PlatformProviderPluginLifecycleRuntime(owner.lifecycle),
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
      permissionPolicies: policies,
      runtime: managed,
    })
    let composition: Awaited<ReturnType<typeof openProductionPluginManagementComposition>> | undefined
    let unregister: (() => void) | undefined
    try {
      await writeSupervisorState(paths, state)
      expect(await coordinator.prepareRecovery()).toHaveLength(0)
      const active = await store.bindRuntimeGeneration()
      owner.initialize(active, false)
      const startup = await managed.initialize(active)
      await Promise.all([startup.coreReady, startup.adopted])
      await vi.waitFor(() => expect(managed.readManagedServiceUIFence()).toEqual(expect.any(Number)))
      expect(owner.bindManagedServiceRuntime(managed)).toBe(true)
      // The native CDP seat is represented by a fixture responding with its
      // authoritative activation; real app injection is a separate gate.
      unregister = cdp.register({
        async send() {
          return { result: { value: { ok: true, result: { active, registryEpoch: 0 } } } }
        },
      } as never)
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
      const browserSessionId = secret()
      const opened = await requestPluginManagementRpc(rpcPaths, endpoint, {
        kind: 'manager-renderer',
        action: 'open',
        gateway,
        browserSessionId,
      }) as any
      expect(opened).toMatchObject({ status: 'ok', channels: ['plugin-management', 'managed-service-ui'] })
      const common = { kind: 'manager-renderer' as const, gateway, browserSessionId, handle: opened.handle }
      const call = async (channel: string, payload: unknown) =>
        await requestPluginManagementRpc(rpcPaths, endpoint, {
          ...common,
          action: 'call',
          channel,
          payload,
        }) as any
      const prepared = await call('manager-bootstrap', { action: 'prepare' })
      expect(prepared.status).toBe('ok')
      const graph = prepared.value.privateGraphs[0]
      const baseUrl = `http://127.0.0.1:43123/api/renderer/graphs/${secret()}/`
      const projected = {
        leaseId: secret(),
        pluginId: graph.pluginId,
        moduleGeneration: graph.moduleGeneration,
        baseUrl,
        entryUrl: baseUrl + graph.entryUrl.slice(graph.baseUrl.length),
        initialStyleUrls: graph.initialStyleUrls.map((url: string) => baseUrl + url.slice(graph.baseUrl.length)),
      }
      const completed = await call('manager-bootstrap', {
        action: 'complete',
        managerOrigin: 'http://127.0.0.1:43123',
        graphs: [projected],
      })
      expect(completed.status).toBe('ok')
      const bytes = await decodeManagerRendererBundle(completed.value.bundle)
      let token = ''
      try {
        const text = bytes.toString('utf8')
        expect(text).not.toContain(source)
        expect(text).not.toContain(managed.capabilities()[0]!.token)
        const capabilityText = /["']?managedServiceCapabilities["']?\s*:\s*(\[[^\]]+\])/u.exec(text)?.[1] ?? ''
        token = /["']?token["']?\s*:\s*["']([a-f0-9]{64})["']/u.exec(capabilityText)?.[1] ?? ''
        expect(token).toMatch(/^[a-f0-9]{64}$/u)
      } finally {
        bytes.fill(0)
      }
      const poll = requestPluginManagementRpc(rpcPaths, endpoint, { ...common, action: 'poll', timeoutMs: 3000 })
      const admit = requestPluginManagementRpc(rpcPaths, endpoint, { ...common, action: 'admit' })
      const command = (await poll as any).value.command
      expect(command.method).toBe('synchronize')
      expect(command.payload.active.plugins[0].canonicalSource).not.toBe(source)
      expect(
        await requestPluginManagementRpc(rpcPaths, endpoint, {
          ...common,
          action: 'acknowledge',
          receipt: { id: command.id, sequence: command.sequence, ok: true, value: command.payload },
        }),
      ).toEqual({ status: 'ok', value: { accepted: true } })
      expect(await admit).toEqual({ status: 'ok', value: { admitted: true } })
      const response = await call(
        'managed-service-ui',
        JSON.stringify({
          version: 1,
          token,
          requestId: 'desktop-get',
          operation: 'get',
          scope: { profileId, runtimeGeneration: generation, pluginGeneration: active.plugins[0]!.moduleGeneration },
          serviceId: 'gateway',
        }),
      )
      expect(response).toMatchObject({ status: 'ok', value: { ok: true, value: { status: 'available' } } })
      unregister()
      unregister = undefined
      expect(await call('manager-bootstrap', { action: 'status' })).toEqual({ status: 'unavailable' })
    } finally {
      await composition?.close().catch(() => undefined)
      unregister?.()
      await owner.close()
      await managed.dispose()
      await artifactServer.close()
      await control.close()
      const digests = await readdir(path.join(homeDir, 'packages', 'sha256')).catch(() => [])
      await Promise.all(digests.map(async value => await removeStagedPluginPackage(homeDir, `sha256:${value}`)))
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000,
)
