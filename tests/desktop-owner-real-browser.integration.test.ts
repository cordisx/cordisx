import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { SIMULATOR_CHANNEL_SERVICE_CONFIG } from '../packages/channel-runtime/src/simulator.js'
import { createDesktopManagerOwnerIfEligible } from '../packages/cli/src/cli/desktop-manager-owner.js'
import { managerRendererGatewayPaths } from '../packages/cli/src/cli/manager-renderer-gateway.js'
import { openManagerOwner } from '../packages/cli/src/cli/manager-owner.js'
import { createProductionManagedServiceLifecycle } from '../packages/cli/src/cli/production-managed-services.js'
import { openProductionPluginManagementComposition } from '../packages/cli/src/cli/production-plugin-management.js'
import { createRendererChannelComposition } from '../packages/cli/src/cli/renderer-channel-composition.js'
import { startSupervisorControlServer } from '../packages/cli/src/cli/supervisor-control.js'
import {
  effectiveConfigFingerprint,
  processStartIdentity,
  type SupervisorState,
  writeSupervisorState,
} from '../packages/cli/src/cli/supervisor-state.js'
import { createDefaultHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { CdpPluginLifecycleRuntime } from '../packages/cli/src/launcher/cdp-plugin-lifecycle-runtime.js'
import { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'
import {
  CONFIG_BINDING,
  configBridgeError,
  createConfigBridgeHandler,
  parseConfigBindingRequest,
} from '../packages/cli/src/launcher/config-rpc.js'
import { sendConfigBindingResponse } from '../packages/cli/src/launcher/cdp-installation-support.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../packages/cli/src/launcher/management-rpc.js'
import { dispatchCodexSettings } from '../packages/cli/src/launcher/codex-settings-dispatch.js'
import { nativeCodexSettings } from '../packages/cli/src/launcher/native-codex-settings-composition.js'
import { PluginActivationStore } from '../packages/cli/src/launcher/plugin-activation.js'
import { loadPluginComposition } from '../packages/cli/src/launcher/plugin-composition.js'
import { PackagePluginConfigStore } from '../packages/cli/src/launcher/package-plugin-config.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { persistPermissionPolicies } from '../packages/cli/src/launcher/permission-rpc.js'
import { PlatformProviderPluginLifecycleRuntime } from '../packages/cli/src/launcher/platform-provider-plugin-lifecycle.js'
import { startPluginGenerationArtifactServer } from '../packages/cli/src/launcher/plugin-generation-artifact-server.js'
import { removeStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import { CdpClient, stopChrome, trustedClick } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'
import { decision, FakeRuntime, localPackage, request } from './suites/plugin-lifecycle.fixtures.js'
import {
  draftDesktopConfig,
  editDesktopConfig,
  expectDesktopConfigApplied,
  expectDesktopConfigConflict,
  holdDesktopConfigReply,
  openConfiguredChannel,
  openDesktopConfig,
  releaseHeldConfigReplyAfterAdoption,
  submitDesktopConfig,
  waitForHeldConfigReply,
} from './suites/desktop-package-config-browser.js'

const chrome = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ...(process.env.PATH ?? '').split(path.delimiter).flatMap(directory =>
    ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'].map(name => path.join(directory, name))
  ),
].find(candidate => {
  if (!candidate || !path.isAbsolute(candidate)) return false
  try {
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
})

async function exerciseDesktopOwner(archive?: string, review = false, configFixture = false, writeFixture = false) {
  if (archive !== undefined && !path.isAbsolute(archive)) throw new Error('fixture archive must be absolute')
  const root = await mkdtemp('/tmp/cx-desktop-real-browser-')
  const homeDir = path.join(root, 'home')
  const configPath = path.join(homeDir, 'config.json')
  const chromeProfile = path.join(root, 'chrome-profile')
  await mkdir(homeDir, { mode: 0o700 })
  const profileId = 'default'
  const generation = 'desktop-owner-browser-fixture'
  const initialConfig = {
    ...createDefaultHomeConfig(),
    ...(archive === undefined ? {} : {
      plugins: [{
        id: 'channel',
        entry: archive,
        services: {
          runtime: {
            profiles: {
              [profileId]: { revision: 1, lastGoodRevision: 1, config: SIMULATOR_CHANNEL_SERVICE_CONFIG },
            },
          },
        },
      }],
    }),
  }
  await writeFile(configPath, JSON.stringify(initialConfig), { mode: 0o600 })
  const configured = await loadConfig(configPath, { profileId, projectRoot: homeDir })
  const configuredPlugin = configured.plugins[0]
  const policies = archive === undefined || review || !configuredPlugin?.source
    ? []
    : exactDomPermissionPolicies(profileId, [{
      id: 'channel',
      entry: configuredPlugin.entry,
      pointIds: ['manager.settings.navigation-items', 'manager.content'],
    }]).map(policy => ({
      ...policy,
      key: { ...policy.key, identity: { ...policy.key.identity, source: configuredPlugin.source! } },
    }))
  if (archive !== undefined && !review) {
    expect(configuredPlugin?.source).toBeDefined()
    await persistPermissionPolicies({ configPath }, policies)
  }
  const processStartedAt = (await processStartIdentity(process.pid))!
  const paths = managerRendererGatewayPaths(homeDir, profileId)
  const state: SupervisorState = {
    schemaVersion: 1,
    appId: 'manager',
    profileId,
    phase: 'ready',
    pid: process.pid,
    processStartedAt,
    instanceToken: randomBytes(32).toString('hex'),
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
  if (archive !== undefined && !review) {
    // This fixture supplies CDP documents; native launch graph promotion is a separate boundary.
    cdp.markBrowserGraphTransportReady()
    cdp.setBrowserGraphBootstrapRefresh(async () => {})
  }
  const store = new PluginActivationStore(homeDir, profileId, generation)
  const fixtureSecret = 'synthetic-desktop-config-secret'
  const fixtureLabel = 'synthetic-desktop-config-label'
  const configStore = new PackagePluginConfigStore(homeDir, profileId, generation)
  if (configFixture) {
    const sourceDirectory = await localPackage({
      root,
      id: 'desktop-config-fixture',
      code: [
        "const descriptor = { type: 'object', dict: { label: { type: 'string' },",
        "  token: { type: 'string', meta: { role: 'secret' } } } }",
        "export const Config = { ...descriptor, '~standard': { version: 1, vendor: 'schemastery',",
        '  validate: value => ({ value }) }, toJSON: () => descriptor }',
        "export const configApplies = 'live'",
        "export const inject = ['settings']",
        'export function apply(ctx, config) { globalThis.__desktopConfigValue = config;',
        '  ctx.settings.watch(value => { globalThis.__desktopConfigValue = value }) }',
      ].join('\n'),
    })
    const seed = new PluginLifecycleCoordinator({
      homeDir,
      profileId,
      runtimeGeneration: generation,
      permissionPolicies: [],
      runtime: new FakeRuntime(),
    })
    await seed.store.bindRuntimeGeneration()
    const planned = await seed.handle({
      ...request({ kind: 'inspect-local', sourceDirectory }, 0, generation),
      profileId,
    })
    if (planned.outcome !== 'planned' || !planned.candidateId || !planned.authorizationPlan) {
      throw new Error('configuration fixture package could not be planned')
    }
    const installed = await seed.handle({
      ...request(
        {
          kind: 'install',
          candidateId: planned.candidateId,
          authorizationDecision: decision(planned.authorizationPlan),
        },
        0,
        generation,
      ),
      profileId,
    })
    if (installed.outcome !== 'applied') throw new Error('configuration fixture package could not be installed')
    const candidate = await configStore.stage(
      'desktop-config-fixture',
      0,
      writeFixture ? { label: fixtureLabel } : { label: fixtureLabel, token: fixtureSecret },
      'fixture-owner',
    )
    await configStore.commit('desktop-config-fixture', candidate.candidateRevision, 'fixture-owner')
  }
  const settings = nativeCodexSettings({
    configPath,
    options: { nativeDiscoveryEnvironment: {} },
    control: {
      nativeRequest: async () => {
        throw new Error('unexpected native request')
      },
    },
  })
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
    configuredPlugins: configured.plugins,
    codex: async (operation, request) => await dispatchCodexSettings(settings, operation, request),
  })
  if (!owner) throw new Error('fixture Desktop owner is unavailable')
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
    pluginGenerationArtifactServer: artifactServer,
  })
  let composition: Awaited<ReturnType<typeof openProductionPluginManagementComposition>> | undefined
  let web: { url: string; issueUrl(): string; close(): Promise<void> } | undefined
  let browser: ChildProcess | undefined
  let desktop: CdpClient | undefined
  let nativeConfigSession: CdpSession | undefined
  const nativeConfigEvents: string[] = []
  let pausedConfigStage: { started(): void; released: Promise<void> } | undefined
  let releaseConfigStage = () => {}
  let first: CdpClient | undefined
  let second: CdpClient | undefined
  let unregister: (() => void) | undefined
  let channel: Awaited<ReturnType<typeof createRendererChannelComposition>> | undefined
  const desktopServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><html lang="en"><body></body></html>')
  })
  let desktopServerListening = false
  try {
    await new Promise<void>((resolve, reject) => {
      desktopServer.once('error', reject)
      desktopServer.listen(0, '127.0.0.1', resolve)
    })
    desktopServerListening = true
    const desktopAddress = desktopServer.address()
    if (!desktopAddress || typeof desktopAddress === 'string') throw new Error('Desktop fixture server is unavailable')
    const desktopOrigin = `http://127.0.0.1:${desktopAddress.port}`
    await writeSupervisorState(paths, state)
    expect(await coordinator.prepareRecovery()).toHaveLength(0)
    const active = await store.bindRuntimeGeneration()
    owner.initialize(active, false)
    await (await managed.initialize(active)).coreReady
    if (writeFixture) expect(owner.enablePackageConfigWrites(generation)).toBe(true)
    const nativePlugins = configFixture ? await loadPluginComposition(store, active) : []
    if (archive !== undefined) {
      channel = await createRendererChannelComposition({
        composition: configured,
        profileId,
        appId: 'codex',
        configPath,
        homeDir,
        generation,
        environment: { PATH: process.env.PATH, HOME: root },
      }, { runtimeGeneration: generation, profileOwnerVerified: true })
      if (!channel.plugin || !channel.service) throw new Error('fixture Channel service is unavailable')
      expect(owner.bindConfiguredChannel(
        { ...channel.plugin, source: 'https://example.test/different-source' },
        channel.service,
      )).toBe(false)
      expect(owner.bindConfiguredChannel(channel.plugin, channel.service)).toBe(true)
      expect(owner.bindConfiguredChannel(channel.plugin, channel.service)).toBe(false)
    }
    composition = await openProductionPluginManagementComposition({
      homeDir,
      configPath,
      appId: 'codex',
      profileId,
      runtimeGeneration: generation,
      token: randomBytes(32).toString('hex'),
      coordinator,
      ...owner.managementOptions,
      processStartedAt,
    })
    const launched = launchChrome(chrome!, chromeProfile)
    browser = launched.browser
    const desktopSocket = await waitForChromeTarget(chromeProfile, browser, launched.stderr)
    desktop = await CdpClient.connect(desktopSocket)
    await desktop.send('Runtime.enable')
    await desktop.send('Page.enable')
    await desktop.send('Page.navigate', { url: desktopOrigin + '/' })
    await vi.waitFor(async () => {
      expect(await desktop!.evaluate('location.origin')).toBe(desktopOrigin)
      expect(await desktop!.evaluate('document.readyState')).toBe('complete')
    }, { timeout: 10_000 })
    const configToken = randomBytes(32).toString('hex')
    if (writeFixture) {
      nativeConfigSession = await CdpSession.connect(desktopSocket)
      await nativeConfigSession.send('Runtime.enable')
      await nativeConfigSession.send('Runtime.addBinding', { name: CONFIG_BINDING })
      const session = nativeConfigSession
      const handler = createConfigBridgeHandler({
        token: configToken,
        profileId,
        generation,
        configPath,
        composition: { ...configured, plugins: [...configured.plugins, ...nativePlugins] },
        packagePlugins: {
          homeDir,
          runtimeGeneration: generation,
          mutate: async (request, seat, action) => {
            try {
              if (request.operation === 'stage' && pausedConfigStage) {
                const pause = pausedConfigStage
                pausedConfigStage = undefined
                pause.started()
                await pause.released
              }
              const value = await owner.packageConfigWrites.handle(request, seat, action)
              nativeConfigEvents.push(request.operation + ':ok')
              return value
            } catch (error) {
              nativeConfigEvents.push(request.operation + ':' + (error instanceof Error ? error.message : 'failed'))
              throw error
            }
          },
        },
      })
      session.onEvent('Runtime.bindingCalled', params => {
        if (params.name !== CONFIG_BINDING || typeof params.payload !== 'string') return
        void (async () => {
          let requestId = 'invalid'
          try {
            const request = parseConfigBindingRequest(
              JSON.parse(params.payload as string),
              configToken,
              profileId,
              generation,
            )
            requestId = request.requestId
            const value = await handler.handle(request, session)
            await sendConfigBindingResponse(session, { requestId, ok: true, value })
          } catch (error) {
            await sendConfigBindingResponse(session, { requestId, ok: false, ...configBridgeError(error) })
          }
        })()
      })
    }
    const bundle = await buildRendererBundle({ ...configured, plugins: [...configured.plugins, ...nativePlugins] }, {
      profileId,
      generation,
      pluginActivation: active,
      ...(writeFixture ? { configBridgeToken: configToken } : {}),
      ...(archive === undefined ? {} : {
        permission: { profileId, policies },
        ...(channel?.manager === undefined ? {} : { channelManager: channel.manager }),
        ...(channel?.serviceCapabilityOwners === undefined
          ? {}
          : { serviceCapabilityOwners: channel.serviceCapabilityOwners }),
      }),
    })
    const injected = await desktop.send('Runtime.evaluate', { expression: bundle, awaitPromise: true }, 60_000) as {
      exceptionDetails?: unknown
    }
    expect(injected.exceptionDetails).toBeUndefined()
    try {
      await vi.waitFor(async () => {
        expect(await desktop!.evaluate('document.documentElement.dataset.cordisxReady')).toBe('true')
      }, { timeout: 15_000 })
    } catch (error) {
      const diagnostics = desktop.diagnostics.map(item => {
        const value = item as { method?: string; params?: { args?: Array<{ value?: unknown; description?: string }> } }
        return {
          method: value.method,
          messages: value.params?.args?.map(arg =>
            String(arg.value ?? arg.description ?? '')
              .replace(/(?:https?|file):\/\/[^\s)]+/gu, '[url]')
              .replace(/\/(?:[^\s/]+\/)+[^\s)]*/gu, '[path]')
              .replace(/[a-f0-9]{32,}/giu, '[id]')
              .slice(0, 250)
          ),
        }
      })
      throw new Error('Desktop fixture did not start: ' + JSON.stringify(diagnostics), { cause: error })
    }
    unregister = cdp.register((nativeConfigSession ?? desktop) as never)
    const configProof = vi.spyOn(cdp, 'managerConfigProof')
    const managerOwner = await openManagerOwner(profileId, { CORDISX_HOME: homeDir })
    // Built assets are used by the same sidecar module shipped in the package.
    const fixturePackage = process.env.CORDISX_MANAGER_PACKAGE_FIXTURE
    const sidecar = await import(
      fixturePackage === undefined
        ? '../packages/cli/dist/src/cli/manager-web.js'
        : pathToFileURL(path.join(fixturePackage, 'dist/src/cli/manager-web.js')).href
    )
    web = await sidecar.startManagerWeb(managerOwner, { rendererGateway: gateway })
    const url = (value: string) => {
      const result = new URL(value)
      result.searchParams.set('host', '1')
      return result.href
    }
    const firstTarget = await desktop.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string }
    const port = Number((await readFile(path.join(chromeProfile, 'DevToolsActivePort'), 'utf8')).split('\n')[0])
    const connect = async (targetId: string): Promise<CdpClient> => {
      let socket = ''
      await vi.waitFor(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`)
        const targets = await response.json() as Array<{ id: string; webSocketDebuggerUrl?: string }>
        socket = targets.find(item => item.id === targetId)?.webSocketDebuggerUrl ?? ''
        expect(socket).not.toBe('')
      }, { timeout: 10_000 })
      const client = await CdpClient.connect(socket)
      await client.send('Runtime.enable')
      await client.send('Page.enable')
      await client.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `globalThis.__fixtureStyleViolations = [];
          document.addEventListener('securitypolicyviolation', event => {
            if (event.effectiveDirective.startsWith('style-src')) {
              globalThis.__fixtureStyleViolations.push({
                directive: event.effectiveDirective,
                blocked: event.blockedURI === 'inline' ? 'inline' : 'resource',
              });
            }
          });`,
      })
      return client
    }
    const ready = async (page: CdpClient) => {
      try {
        const deadline = Date.now() + 45_000
        while (Date.now() < deadline) {
          const state = await page.evaluate<{ ready: boolean; status: string }>(`({
          ready: document.documentElement?.dataset.cordisxReady === 'true' && !!globalThis.__cordisxRuntime
            && document.querySelector('p[role=status]')?.hidden === true,
          status: document.querySelector('p[role=status]')?.textContent ?? ''
        })`)
          if (state.ready) return
          if (state.status.includes('连接不可用')) throw new Error(state.status)
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        throw new Error('Manager readiness timed out')
      } catch (error) {
        const resources = await page.evaluate(`performance.getEntriesByType('resource')
            .filter(item => new URL(item.name).pathname.startsWith('/api/'))
            .map(item => ({ path: new URL(item.name).pathname.replace(/[a-f0-9]{32,}/giu, '[id]'),
              status: item.responseStatus, duration: item.duration }))`)
        throw new Error('Manager did not start: ' + JSON.stringify(resources), { cause: error })
      }
    }
    first = await connect(firstTarget.targetId)
    await first.send('Page.navigate', { url: url(web.url) })
    await ready(first)
    if (writeFixture) {
      expect(
        await first.evaluate(`globalThis.__cordisxRuntime.snapshot().plugins
        .find(item => item.id === 'desktop-config-fixture')?.configuration.writable`),
      ).toBe(true)
      await first.evaluate("globalThis.__desktopConfigDocumentMarker = 'same-document'")
      await openDesktopConfig(first)
      await editDesktopConfig(first, 'first update')
      try {
        await expectDesktopConfigApplied(first, desktop, configStore, 2, 'first update')
      } catch (error) {
        const status = await first.evaluate(`({
          text: document.querySelector('p[role=status]')?.textContent,
          hidden: document.querySelector('p[role=status]')?.hidden,
          runtime: Boolean(globalThis.__cordisxRuntime),
          form: document.querySelector('[data-plugin-config-form=desktop-config-fixture]')?.dataset.state,
        })`).catch(() => undefined)
        const stored = await configStore.loadStable('desktop-config-fixture').then(value => value.revision).catch(() =>
          'pending'
        )
        throw new Error(
          'Desktop config browser diagnostics: ' + JSON.stringify({
            status,
            stored,
            nativeConfigEvents,
          }),
          { cause: error },
        )
      }
    }
    const secondTarget = await desktop.send('Target.createTarget', { url: 'about:blank' }) as {
      targetId: string
    }
    second = await connect(secondTarget.targetId)
    await second.send('Page.navigate', { url: url(web.issueUrl()) })
    await ready(second)
    if (writeFixture) {
      expect(await second.evaluate('globalThis.__desktopConfigValue')).toEqual({ label: 'first update' })
      await second.evaluate("globalThis.__desktopConfigDocumentMarker = 'same-document'")
      await openDesktopConfig(second)
      await draftDesktopConfig(second, 'retained draft')
      await holdDesktopConfigReply(second)
      let stageStarted = false
      pausedConfigStage = {
        started: () => stageStarted = true,
        released: new Promise<void>(resolve => releaseConfigStage = resolve),
      }
      await editDesktopConfig(first, 'updated from first page')
      await vi.waitFor(() => expect(stageStarted).toBe(true), { timeout: 15_000 })
      await submitDesktopConfig(second)
      await waitForHeldConfigReply(second)
      releaseConfigStage()
      await releaseHeldConfigReplyAfterAdoption(second)
      await expectDesktopConfigApplied(first, desktop, configStore, 3, 'updated from first page')
      await expectDesktopConfigConflict(second, 'retained draft', 'updated from first page')
      await second.evaluate(
        "document.querySelector('[data-plugin-config-form=desktop-config-fixture] .cxf-alert button').click()",
      )
      await vi.waitFor(async () => {
        expect(
          await second!.evaluate(
            "!document.querySelector('[data-plugin-config-form=desktop-config-fixture] button[type=submit]').disabled",
          ),
        ).toBe(true)
      }, { timeout: 10_000 })
      await submitDesktopConfig(second)
      await expectDesktopConfigApplied(second, desktop, configStore, 4, 'retained draft')
      await vi.waitFor(async () => {
        expect(await first.evaluate('globalThis.__desktopConfigValue')).toEqual({ label: 'retained draft' })
        expect(await first.evaluate('globalThis.__desktopConfigDocumentMarker')).toBe('same-document')
      }, { timeout: 15_000 })
      await desktop.send('Target.closeTarget', { targetId: secondTarget.targetId })
      await second.close().catch(() => {})
      second = undefined
      const reopened = await desktop.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string }
      second = await connect(reopened.targetId)
      await second.send('Page.navigate', { url: url(web.issueUrl()) })
      await ready(second)
      expect(await second.evaluate('globalThis.__desktopConfigValue')).toEqual({ label: 'retained draft' })
      if (archive !== undefined) await openConfiguredChannel(first)
      return
    }
    const snapshot = async (page: CdpClient) =>
      await page.evaluate(`({
        active: globalThis.__cordisxRuntime.activePluginGeneration(),
        registryEpoch: globalThis.__cordisxRuntime.pluginRegistryEpoch()
      })`)
    expect(await snapshot(first)).toEqual(await snapshot(second))
    expect(await snapshot(first)).toEqual(await snapshot(desktop))
    if (configFixture) {
      for (const page of [first, second]) {
        const projection = await page.evaluate<any>([
          '(() => {',
          '  const plugin = globalThis.__cordisxRuntime.snapshot().plugins',
          "    .find(item => item.id === 'desktop-config-fixture')",
          '  return { value: plugin?.configuration.value, writable: plugin?.configuration.writable,',
          '    body: document.body.textContent, pluginConfig: globalThis.__desktopConfigValue }',
          '})()',
        ].join('\n'))
        expect(projection.value).toEqual({ label: fixtureLabel })
        expect(projection.pluginConfig).toEqual({ label: fixtureLabel })
        expect(projection.writable).toBe(false)
        expect(JSON.stringify(projection)).not.toContain(fixtureSecret)
      }
      expect(configProof).toHaveBeenCalledOnce()
      await expect(configStore.stage('desktop-config-fixture', 1, { label: 'other' }, 'other-owner'))
        .rejects.toThrow('plugin configuration is in use')
      await first.evaluate('globalThis.__configFixtureBeforeReload = true')
      await first.send('Page.reload')
      await vi.waitFor(async () => {
        expect(await first!.evaluate('globalThis.__configFixtureBeforeReload === undefined')).toBe(true)
      }, { timeout: 15_000 })
      await ready(first)
      expect(await first.evaluate('globalThis.__desktopConfigValue')).toEqual({ label: fixtureLabel })
      expect(configProof).toHaveBeenCalledOnce()
      // Adding and removing a second seat must not let either page retain a
      // projection proved by the previous single-seat membership.
      const removeTransientSeat = cdp.register({ send: async () => ({}) } as never)
      removeTransientSeat()
      for (const page of [first, second]) {
        await vi.waitFor(async () => {
          const status = await page.evaluate<{ hidden: boolean; text: string }>(`({
            hidden: document.querySelector('p[role=status]')?.hidden,
            text: document.querySelector('p[role=status]')?.textContent ?? ''
          })`)
          expect(status.hidden).toBe(false)
          expect(status.text).toContain('连接不可用')
        }, { timeout: 15_000 })
      }
      await vi.waitFor(async () => {
        expect(await owner.lifecycle.pluginConfiguration({ kind: 'plugin-configuration', action: 'list' }))
          .toMatchObject({ status: 'ok' })
      }, { timeout: 15_000 })
      await desktop.send('Target.closeTarget', { targetId: firstTarget.targetId })
      await first.close().catch(() => {})
      const reopened = await desktop.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string }
      first = await connect(reopened.targetId)
      await first.send('Page.navigate', { url: url(web.issueUrl()) })
      await ready(first)
      expect(await first.evaluate('globalThis.__desktopConfigValue')).toEqual({ label: fixtureLabel })
      expect(configProof).toHaveBeenCalledTimes(2)
      return
    }
    if (archive !== undefined && review) {
      for (const page of [first, second]) {
        await vi.waitFor(async () => {
          expect(
            await page.evaluate(
              'document.querySelector("[data-settings-navigation-item^=channel]")?.dataset.permissionReview',
            ),
          )
            .toBe('pending')
        }, { timeout: 20_000 })
      }
      await first.evaluate('document.querySelector("[data-settings-navigation-item^=channel]").click()')
      await vi.waitFor(async () => {
        expect(
          await first!.evaluate(
            'Boolean(document.querySelector("[data-standalone-dom-review] button:not(:disabled)"))',
          ),
        )
          .toBe(true)
      }, { timeout: 15_000 })
      await trustedClick(first, '[data-standalone-dom-review] button')
      await vi.waitFor(async () => {
        expect(await first!.evaluate('Boolean(document.querySelector("[data-permission-authorization]"))')).toBe(true)
      }, { timeout: 15_000 })
      await trustedClick(first, '[data-permission-decision=allow-once]')
      await trustedClick(first, '[data-permission-action=confirm]')
      await vi.waitFor(async () => {
        expect(
          await first!.evaluate('document.querySelector("[data-standalone-dom-review] [role=status]")?.textContent'),
        )
          .toMatch(/已在此标签页允许|Allowed in this tab/u)
      }, { timeout: 15_000 })
      expect(
        await second.evaluate(
          'document.querySelector("[data-settings-navigation-item^=channel]")?.dataset.permissionReview',
        ),
      )
        .toBe('pending')
      const saved = JSON.parse(await readFile(configPath, 'utf8')) as { permissions: unknown[] }
      expect(saved.permissions).toEqual([])
      return
    }
    if (archive !== undefined) {
      for (const page of [first, second]) {
        await vi.waitFor(async () => {
          expect(await page.evaluate('Boolean(document.querySelector("[data-settings-navigation-item^=channel]"))'))
            .toBe(true)
        }, { timeout: 20_000 })
        await page.evaluate('document.querySelector("[data-settings-navigation-item^=channel]").click()')
        await vi.waitFor(async () => {
          expect(await page.evaluate('Boolean(document.querySelector("[data-manager-collection-item]"))')).toBe(true)
          expect(
            await page.evaluate(
              'document.body.textContent.includes("Simulator") || document.body.textContent.includes("模拟器")',
            ),
          ).toBe(true)
        }, { timeout: 20_000 })
        await page.evaluate(
          'document.querySelector("[data-manager-collection-item] .cxr-manager-collection-open").click()',
        )
        await vi.waitFor(async () => {
          expect(await page.evaluate('Boolean(document.querySelector("[data-channel-manager]"))')).toBe(true)
        }, { timeout: 15_000 })
        const channelStyle = await page.evaluate(`(() => {
          const shell = document.querySelector('[data-channel-manager]');
          return {
            display: shell ? getComputedStyle(shell).display : null,
            blockedInlineStyles: shell ? [...shell.children].filter(element =>
              element.tagName === 'STYLE' && !element.sheet).length : -1,
          };
        })()`)
        const violations = await page.evaluate('globalThis.__fixtureStyleViolations')
        expect(channelStyle, `style policy violations: ${JSON.stringify(violations)}`).toEqual({
          display: 'flex',
          blockedInlineStyles: 0,
        })
      }
      await expect(persistPermissionPolicies(
        { configPath },
        policies.map(policy => ({
          ...policy,
          policy: 'deny-persistent' as const,
        })),
      )).rejects.toThrow('permission policy is in use')
      await expect(updateHomeConfigAtomic(current => ({
        ...current,
        plugins: current.plugins.map(plugin =>
          plugin.id === 'channel' ? { ...plugin, config: { changed: true } } : plugin
        ),
      }), configPath)).rejects.toThrow('plugin configuration is in use')

      const readChannel = async (page: CdpClient) =>
        await page.evaluate(`new Promise((resolve, reject) => {
        const requestId = 'fixture-snapshot-' + crypto.randomUUID();
        const previous = globalThis.__cordisxChannelActionsReceiveV1;
        const timer = setTimeout(() => { globalThis.__cordisxChannelActionsReceiveV1 = previous; reject(new Error('snapshot timeout')); }, 8000);
        globalThis.__cordisxChannelActionsReceiveV1 = payload => {
          const value = JSON.parse(payload);
          if (value.requestId !== requestId) return previous?.(payload);
          clearTimeout(timer);
          globalThis.__cordisxChannelActionsReceiveV1 = previous;
          resolve(value);
        };
        globalThis.__cordisxChannelActionsRequestV1(JSON.stringify({
          version: 1, token: 'renderer-binding-placeholder', requestId, action: 'snapshot'
        }));
      })`)
      for (const page of [first, second]) {
        expect(await readChannel(page)).toMatchObject({ ok: true, value: { status: 'applied' } })
        expect(
          await page.evaluate(
            'Boolean(globalThis.__fixtureChannelShell = document.querySelector("[data-channel-manager]"))',
          ),
        ).toBe(true)
      }
      const sourceDirectory = await localPackage({
        root,
        id: 'channel-neighbor-fixture',
        code: 'export function apply() { globalThis.__channel_neighbor_fixture = true }',
      })
      const rpcPaths = pluginManagementRpcPaths(homeDir, 'codex', profileId)
      const endpoint = (await readPluginManagementRpcEndpoint(rpcPaths))!
      const planned = await requestPluginManagementRpc(rpcPaths, endpoint, {
        kind: 'plan',
        request: { kind: 'plugin-plan-local', sourceDirectory },
      }) as any
      const installed = await requestPluginManagementRpc(rpcPaths, endpoint, {
        kind: 'execute',
        request: planned.executionRequest,
        expectedRevision: planned.snapshot.revision,
      }) as any
      expect(installed.status).toBe('applied')
      for (const page of [desktop, first, second]) {
        expect(await page.evaluate('globalThis.__channel_neighbor_fixture === true')).toBe(true)
      }
      for (const page of [first, second]) {
        expect(await readChannel(page)).toMatchObject({ ok: true, value: { status: 'applied' } })
        expect(
          await page.evaluate(
            'document.querySelector("[data-channel-manager]") === globalThis.__fixtureChannelShell',
          ),
        ).toBe(true)
      }
    }
    for (const page of [first, second]) {
      await page.evaluate(`(() => {
          const button = [...document.querySelectorAll('button')].find(item =>
            ['Model services', '模型服务'].includes(item.textContent.trim()))
          if (!button) throw new Error('Model services navigation is unavailable')
          button.click()
        })()`)
      await vi.waitFor(async () => {
        expect(await page.evaluate('Boolean(document.querySelector(".cxms-shared-header"))')).toBe(true)
        expect(await page.evaluate('getComputedStyle(document.querySelector(".cxms-shared-header")).display'))
          .toBe('flex')
      }, { timeout: 15_000 })
    }
    await first.evaluate(`(() => {
        const add = [...document.querySelectorAll('.cxms-shared-header button')].find(button =>
          ['Add shared service', '添加跨应用服务'].includes(button.textContent.trim()))
        if (!add) throw new Error('Model service add action is unavailable')
        add.click()
      })()`)
    await vi.waitFor(async () => {
      expect(await first!.evaluate('Boolean(document.querySelector(".cxmc-editor [data-config-path=id] input"))'))
        .toBe(true)
      expect(await first!.evaluate('getComputedStyle(document.querySelector(".cxmc-editor-actions")).display'))
        .toBe('flex')
    }, { timeout: 10_000 })
    for (
      const [field, value] of [
        ['id', 'desktop-fixture'],
        ['displayName', 'Desktop fixture'],
        ['baseUrl', 'https://example.test'],
        ['codexModels', 'fixture-model'],
        ['apiKey', 'desktop-fixture-secret'],
      ]
    ) {
      await first.evaluate(`(() => {
          const input = document.querySelector(${JSON.stringify(`.cxmc-editor [data-config-path="${field}"] input`)})
          if (!input) throw new Error('Model service field is unavailable')
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new Event('change', { bubbles: true }))
        })()`)
    }
    await vi.waitFor(async () => {
      expect(await first!.evaluate('!document.querySelector(".cxmc-editor-actions button:last-child").disabled'))
        .toBe(true)
    }, { timeout: 10_000 })
    await first.evaluate('document.querySelector(".cxmc-editor-actions button:last-child").click()')
    for (const page of [first, second]) {
      await vi.waitFor(async () => {
        expect(await page.evaluate('Boolean(document.querySelector("[data-shared-model-service=desktop-fixture]"))'))
          .toBe(true)
      }, { timeout: 20_000 })
      expect(await page.evaluate('document.body.textContent.includes("desktop-fixture-secret")')).toBe(false)
    }
    const stored = JSON.parse(await readFile(configPath, 'utf8')) as { providers: Array<{ id: string }> }
    expect(stored.providers.some(provider => provider.id === 'desktop-fixture')).toBe(true)
    await first.evaluate('globalThis.__desktopBeforeReload = true')
    await first.send('Page.reload')
    await vi.waitFor(async () => {
      expect(await first!.evaluate('globalThis.__desktopBeforeReload === undefined')).toBe(true)
    }, { timeout: 15_000 })
    await ready(first)
    await vi.waitFor(async () => {
      expect(await first!.evaluate('Boolean(document.querySelector("[data-shared-model-service=desktop-fixture]"))'))
        .toBe(true)
    }, { timeout: 15_000 })
    const list = { kind: 'plugin-configuration' as const, action: 'list' as const }
    expect(await owner.lifecycle.pluginConfiguration(list)).toEqual({
      status: 'unavailable',
      reason: 'renderer-busy',
    })
    await desktop.send('Target.closeTarget', { targetId: firstTarget.targetId })
    await first.close().catch(() => {})
    first = undefined
    await ready(second)
    expect(await owner.lifecycle.pluginConfiguration(list)).toEqual({
      status: 'unavailable',
      reason: 'renderer-busy',
    })
    // This is the same owner callback used when the last CDP seat disconnects.
    unregister()
    unregister = undefined
    await vi.waitFor(async () => {
      const status = await second!.evaluate<{ hidden: boolean; text: string }>(`({
          hidden: document.querySelector('p[role=status]')?.hidden,
          text: document.querySelector('p[role=status]')?.textContent ?? ''
        })`)
      expect(status.hidden).toBe(false)
      expect(status.text).toContain('连接不可用')
    }, { timeout: 15_000 })
    expect(() => owner.lifecycle.snapshot()).toThrow('unavailable')
    await desktop.send('Target.closeTarget', { targetId: secondTarget.targetId })
    await second.close().catch(() => {})
    second = undefined
    // A new Desktop seat permits a new Manager session; the old one stays revoked.
    unregister = cdp.register(desktop as never)
    const thirdTarget = await desktop.send('Target.createTarget', { url: 'about:blank' }) as {
      targetId: string
    }
    second = await connect(thirdTarget.targetId)
    await second.send('Page.navigate', { url: url(web.issueUrl()) })
    await ready(second)
    expect(await owner.lifecycle.pluginConfiguration(list)).toEqual({
      status: 'unavailable',
      reason: 'renderer-busy',
    })
    if (archive !== undefined && channel?.service) {
      const oldGeneration = channel.service.generation()
      const restarted = await channel.service.restart(SIMULATOR_CHANNEL_SERVICE_CONFIG, oldGeneration)
      await restarted.finalize()
      expect(restarted.generation).not.toBe(oldGeneration)
      await vi.waitFor(async () => {
        const status = await second!.evaluate<{ hidden: boolean; text: string }>(`({
          hidden: document.querySelector('p[role=status]')?.hidden,
          text: document.querySelector('p[role=status]')?.textContent ?? ''
        })`)
        expect(status.hidden).toBe(false)
        expect(status.text).toContain('连接不可用')
      }, { timeout: 25_000 })
      await desktop.send('Target.closeTarget', { targetId: thirdTarget.targetId })
      await second.close().catch(() => {})
      second = undefined
      await vi.waitFor(async () => {
        expect(await owner.lifecycle.pluginConfiguration(list)).toMatchObject({ status: 'ok' })
      }, { timeout: 15_000 })
      const recoveredTarget = await desktop.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string }
      second = await connect(recoveredTarget.targetId)
      await second.send('Page.navigate', { url: url(web.issueUrl()) })
      await ready(second)
      await vi.waitFor(async () => {
        expect(await second!.evaluate('Boolean(document.querySelector("[data-settings-navigation-item^=channel]"))'))
          .toBe(true)
      }, { timeout: 20_000 })
      await second.evaluate('document.querySelector("[data-settings-navigation-item^=channel]").click()')
      await vi.waitFor(async () => {
        expect(await second!.evaluate('Boolean(document.querySelector("[data-manager-collection-item]"))')).toBe(true)
      }, { timeout: 20_000 })
      await second.evaluate(
        'document.querySelector("[data-manager-collection-item] .cxr-manager-collection-open").click()',
      )
      await vi.waitFor(async () => {
        expect(await second!.evaluate('Boolean(document.querySelector("[data-channel-manager]"))')).toBe(true)
      }, { timeout: 15_000 })
      expect(
        await second.evaluate(`(() => {
        const shell = document.querySelector('[data-channel-manager]');
        return shell ? getComputedStyle(shell).display : null;
      })()`),
      ).toBe('flex')
      await desktop.send('Target.closeTarget', { targetId: recoveredTarget.targetId })
    } else {
      await desktop.send('Target.closeTarget', { targetId: thirdTarget.targetId })
    }
    await second.close().catch(() => {})
    second = undefined
    await vi.waitFor(async () => {
      expect(await owner.lifecycle.pluginConfiguration(list)).toMatchObject(
        archive === undefined ? { status: 'ok', plugins: [] } : { status: 'ok' },
      )
    }, { timeout: 15_000 })
  } finally {
    releaseConfigStage()
    await second?.evaluate('globalThis.__releaseConfigReply?.()').catch(() => {})
    await first?.close().catch(() => {})
    await second?.close().catch(() => {})
    await web?.close().catch(() => {})
    await composition?.close().catch(() => {})
    await owner.close()
    unregister?.()
    nativeConfigSession?.close()
    await desktop?.close().catch(() => {})
    if (browser) await stopChrome(browser)
    await managed.dispose()
    await channel?.service?.dispose()
    await artifactServer.close()
    await control.close()
    if (desktopServerListening) await new Promise<void>(resolve => desktopServer.close(() => resolve()))
    const digests = await readdir(path.join(homeDir, 'packages', 'sha256')).catch(() => [])
    await Promise.all(
      digests.filter(digest => /^[a-f0-9]{64}$/u.test(digest)).map(async digest =>
        await removeStagedPluginPackage(homeDir, `sha256:${digest}`)
      ),
    )
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

it.skipIf(chrome === undefined)(
  'shares one Desktop owner between a real CDP document and two standalone Manager pages',
  async () => await exerciseDesktopOwner(),
  120_000,
)

it.skipIf(chrome === undefined || process.platform !== 'darwin' && process.platform !== 'linux')(
  'projects a redacted Desktop plugin configuration into two Manager pages',
  async () => await exerciseDesktopOwner(undefined, false, true),
  120_000,
)

it.skipIf(chrome === undefined || process.platform !== 'darwin' && process.platform !== 'linux')(
  'synchronizes a proven Desktop package field while preserving another Manager draft',
  async () => await exerciseDesktopOwner(undefined, false, true, true),
  120_000,
)

const channelArchive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE
it.skipIf(
  chrome === undefined || channelArchive === undefined || process.platform !== 'darwin' && process.platform !== 'linux',
)(
  'projects a configured Channel from the Desktop owner into two Manager pages',
  async () => await exerciseDesktopOwner(channelArchive),
  180_000,
)

it.skipIf(
  chrome === undefined || channelArchive === undefined || process.platform !== 'darwin' && process.platform !== 'linux',
)(
  'keeps a Desktop owner Channel review local to the selected Manager page',
  async () => await exerciseDesktopOwner(channelArchive, true),
  180_000,
)

it.skipIf(
  chrome === undefined || channelArchive === undefined || process.platform !== 'darwin' && process.platform !== 'linux',
)(
  'keeps the configured Channel available through a multi-Manager Desktop configuration handoff',
  async () => await exerciseDesktopOwner(channelArchive, false, true, true),
  180_000,
)
