import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { createDesktopManagerOwnerIfEligible } from '../packages/cli/src/cli/desktop-manager-owner.js'
import { managerRendererGatewayPaths } from '../packages/cli/src/cli/manager-renderer-gateway.js'
import { openManagerOwner } from '../packages/cli/src/cli/manager-owner.js'
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
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { CdpPluginLifecycleRuntime } from '../packages/cli/src/launcher/cdp-plugin-lifecycle-runtime.js'
import { PluginActivationStore } from '../packages/cli/src/launcher/plugin-activation.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { PlatformProviderPluginLifecycleRuntime } from '../packages/cli/src/launcher/platform-provider-plugin-lifecycle.js'
import { startPluginGenerationArtifactServer } from '../packages/cli/src/launcher/plugin-generation-artifact-server.js'
import { CdpClient, stopChrome } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'

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

it.skipIf(chrome === undefined)(
  'shares one Desktop owner between a real CDP document and two standalone Manager pages',
  async () => {
    const root = await mkdtemp('/tmp/cx-desktop-real-browser-')
    const homeDir = path.join(root, 'home')
    const configPath = path.join(homeDir, 'config.json')
    const chromeProfile = path.join(root, 'chrome-profile')
    await mkdir(homeDir)
    await writeFile(configPath, JSON.stringify(createDefaultHomeConfig()))
    const profileId = 'default'
    const generation = 'desktop-owner-browser-fixture'
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
      configuredPluginCount: 0,
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
      permissionPolicies: [],
      runtime: managed,
    })
    let composition: Awaited<ReturnType<typeof openProductionPluginManagementComposition>> | undefined
    let web: { url: string; issueUrl(): string; close(): Promise<void> } | undefined
    let browser: ChildProcess | undefined
    let desktop: CdpClient | undefined
    let first: CdpClient | undefined
    let second: CdpClient | undefined
    let unregister: (() => void) | undefined
    try {
      await writeSupervisorState(paths, state)
      expect(await coordinator.prepareRecovery()).toHaveLength(0)
      const active = await store.bindRuntimeGeneration()
      owner.initialize(active, false)
      await (await managed.initialize(active)).coreReady
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
      desktop = await CdpClient.connect(await waitForChromeTarget(chromeProfile, browser, launched.stderr))
      await desktop.send('Runtime.enable')
      const bundle = await buildRendererBundle({
        version: 1,
        rootDir: process.cwd(),
        codex: { debugPort: 9229 },
        providers: [],
        plugins: [],
      }, { profileId, generation, pluginActivation: active })
      const injected = await desktop.send('Runtime.evaluate', { expression: bundle, awaitPromise: true }, 60_000) as {
        exceptionDetails?: unknown
      }
      expect(injected.exceptionDetails).toBeUndefined()
      await vi.waitFor(async () => {
        expect(await desktop!.evaluate('document.documentElement.dataset.cordisxReady')).toBe('true')
      }, { timeout: 15_000 })
      unregister = cdp.register(desktop as never)
      const managerOwner = await openManagerOwner(profileId, { CORDISX_HOME: homeDir })
      // Built assets are used by the same sidecar module shipped in the package.
      const sidecar = await import('../packages/cli/dist/src/cli/manager-web.js')
      web = await sidecar.startManagerWeb(managerOwner, { rendererGateway: gateway })
      const url = (value: string) => {
        const result = new URL(value)
        result.searchParams.set('host', '1')
        return result.href
      }
      const firstTarget = await desktop.send('Target.createTarget', { url: url(web.url) }) as { targetId: string }
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
        return client
      }
      const ready = async (page: CdpClient) =>
        await vi.waitFor(async () => {
          const state = await page.evaluate<{ ready: boolean; status: string }>(`({
          ready: document.documentElement.dataset.cordisxReady === 'true' && !!globalThis.__cordisxRuntime
            && document.querySelector('p[role=status]')?.hidden === true,
          status: document.querySelector('p[role=status]')?.textContent ?? ''
        })`)
          expect(state.ready, state.status).toBe(true)
        }, { timeout: 45_000 })
      first = await connect(firstTarget.targetId)
      await ready(first)
      const secondTarget = await desktop.send('Target.createTarget', { url: url(web.issueUrl()) }) as {
        targetId: string
      }
      second = await connect(secondTarget.targetId)
      await ready(second)
      const snapshot = async (page: CdpClient) =>
        await page.evaluate(`({
        active: globalThis.__cordisxRuntime.activePluginGeneration(),
        registryEpoch: globalThis.__cordisxRuntime.pluginRegistryEpoch()
      })`)
      expect(await snapshot(first)).toEqual(await snapshot(second))
      expect(await snapshot(first)).toEqual(await snapshot(desktop))
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
      const thirdTarget = await desktop.send('Target.createTarget', { url: url(web.issueUrl()) }) as {
        targetId: string
      }
      second = await connect(thirdTarget.targetId)
      await ready(second)
      expect(await owner.lifecycle.pluginConfiguration(list)).toEqual({
        status: 'unavailable',
        reason: 'renderer-busy',
      })
      await desktop.send('Target.closeTarget', { targetId: thirdTarget.targetId })
      await second.close().catch(() => {})
      second = undefined
      await vi.waitFor(async () => {
        expect(await owner.lifecycle.pluginConfiguration(list)).toMatchObject({ status: 'ok', plugins: [] })
      }, { timeout: 15_000 })
    } finally {
      await first?.close().catch(() => {})
      await second?.close().catch(() => {})
      await web?.close().catch(() => {})
      await composition?.close().catch(() => {})
      owner.close()
      unregister?.()
      await desktop?.close().catch(() => {})
      if (browser) await stopChrome(browser)
      await managed.dispose()
      await artifactServer.close()
      await control.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000,
)
