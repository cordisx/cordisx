import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
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
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../packages/cli/src/launcher/management-rpc.js'
import { removeStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import { PluginActivationStore } from '../packages/cli/src/launcher/plugin-activation.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { PlatformProviderPluginLifecycleRuntime } from '../packages/cli/src/launcher/platform-provider-plugin-lifecycle.js'
import { startPluginGenerationArtifactServer } from '../packages/cli/src/launcher/plugin-generation-artifact-server.js'
import { CdpClient, stopChrome } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'
import { localPackage } from './suites/plugin-lifecycle.fixtures.js'

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
  'synchronizes dependency mutations across two real CDP documents and two Manager pages',
  async () => {
    const root = await mkdtemp('/tmp/cx-shared-fleet-browser-')
    const homeDir = path.join(root, 'home')
    const configPath = path.join(homeDir, 'config.json')
    const chromeProfile = path.join(root, 'chrome-profile')
    await mkdir(homeDir, { mode: 0o700 })
    await writeFile(configPath, JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
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
    const desktopServer = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!doctype html><html><body></body></html>')
    })
    await new Promise<void>(resolve => desktopServer.listen(0, '127.0.0.1', resolve))
    const desktopAddress = desktopServer.address()
    if (!desktopAddress || typeof desktopAddress === 'string') throw new Error('desktop fixture unavailable')
    const desktopUrl = `http://127.0.0.1:${desktopAddress.port}/`
    const artifactServer = await startPluginGenerationArtifactServer()
    const cdp = new CdpPluginLifecycleRuntime()
    const stageErrors: string[] = []
    const redact = (value: unknown) =>
      String(value)
        .replace(/https?:\/\/[^\s'")]+/gu, '<url>')
        .replace(/\b[a-f0-9]{32,}\b/gu, '<token>')
        .slice(0, 512)
    let blockStage = false
    let releaseStage = () => {}
    let stageEntered = () => {}
    const stageBlocked = new Promise<void>(resolve => stageEntered = resolve)
    const stageRelease = new Promise<void>(resolve => releaseStage = resolve)
    const managerPeers: Array<{ readonly closed: boolean; readonly identity: { readonly rendererId: string } }> = []
    const cdpStage = cdp.stage.bind(cdp)
    vi.spyOn(cdp, 'stage').mockImplementation(async (mutation, token) => {
      try {
        return await cdpStage(mutation, token)
      } catch (error) {
        stageErrors.push(`cdp stage: ${redact(error)}`)
        throw error
      }
    })
    const store = new PluginActivationStore(homeDir, profileId, generation)
    const active = await store.bindRuntimeGeneration()
    let composition: Awaited<ReturnType<typeof openProductionPluginManagementComposition>> | undefined
    const productionOwner = await createDesktopManagerOwnerIfEligible({
      homeDir,
      configPath,
      appId: 'codex',
      profileId,
      generation,
      cdp,
      artifactServer,
      store,
      management: () => composition,
      ownerVerified: true,
      attach: false,
      configuredPlugins: [],
    })
    if (!productionOwner) throw new Error('Desktop owner is unavailable')
    productionOwner.initialize(active, false)
    const lifecycle = productionOwner.lifecycle
    const originalParticipant = productionOwner.managementOptions.rendererParticipant
    const createParticipant = originalParticipant.create
    vi.spyOn(originalParticipant, 'create').mockImplementation(
      (input: Parameters<typeof originalParticipant.create>[0]) => {
        const peer = createParticipant(input)
        managerPeers.push(peer)
        const request = peer.request.bind(peer)
        vi.spyOn(peer, 'request').mockImplementation(async (method, payload) => {
          try {
            if (blockStage && method === 'stage' && managerPeers[0] === peer) {
              stageEntered()
              await stageRelease
            }
            return await request(method, payload)
          } catch (error) {
            stageErrors.push(`manager ${method}: ${redact(error)}`)
            throw error
          }
        })
        return peer
      },
    )
    const owner = productionOwner
    // No launcher page-replacement transport exists in this browser fixture.
    // Existing documents use real CDP; future-document refresh is a substitute.
    cdp.markBrowserGraphTransportReady()
    cdp.setBrowserGraphBootstrapRefresh(async () => {})
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
    expect(owner.bindManagedServiceRuntime(managed)).toBe(true)
    const coordinator = new PluginLifecycleCoordinator({
      homeDir,
      profileId,
      runtimeGeneration: generation,
      permissionPolicies: [],
      runtime: owner.coordinateLifecycle(managed),
      pluginGenerationArtifactServer: artifactServer,
    })
    let web: { url: string; issueUrl(): string; close(): Promise<void> } | undefined
    let browser: ChildProcess | undefined
    let desktop: CdpClient | undefined
    let secondDesktop: CdpClient | undefined
    let first: CdpClient | undefined
    let second: CdpClient | undefined
    let third: CdpClient | undefined
    let unregister: (() => void) | undefined
    let unregisterSecond: (() => void) | undefined
    let checkpoint = 'start'
    try {
      await writeSupervisorState(paths, state)
      expect(await coordinator.prepareRecovery()).toHaveLength(0)
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
      await desktop.send('Page.enable')
      await desktop.send('Page.navigate', { url: desktopUrl })
      await vi.waitFor(async () => expect(await desktop!.evaluate('location.href')).toBe(desktopUrl), {
        timeout: 10_000,
      })
      const desktopSend = desktop.send.bind(desktop)
      vi.spyOn(desktop, 'send').mockImplementation(async (method, params, timeout) => {
        const result = await desktopSend(method, params, timeout) as {
          exceptionDetails?: { exception?: { description?: string }; text?: string }
        }
        if (result.exceptionDetails) {
          stageErrors.push(
            `desktop evaluation: ${
              redact(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
            }`,
          )
        }
        return result
      })
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
      const secondDesktopTarget = await desktop.send('Target.createTarget', { url: desktopUrl }) as {
        targetId: string
      }
      secondDesktop = await connect(secondDesktopTarget.targetId)
      await vi.waitFor(async () => expect(await secondDesktop!.evaluate('location.href')).toBe(desktopUrl), {
        timeout: 10_000,
      })
      const secondInjection = await secondDesktop.send(
        'Runtime.evaluate',
        { expression: bundle, awaitPromise: true },
        60_000,
      ) as {
        exceptionDetails?: unknown
      }
      expect(secondInjection.exceptionDetails).toBeUndefined()
      await vi.waitFor(async () => {
        expect(await secondDesktop!.evaluate('document.documentElement.dataset.cordisxReady')).toBe('true')
      }, { timeout: 15_000 })
      unregisterSecond = cdp.register(secondDesktop as never)
      const firstTarget = await desktop.send('Target.createTarget', { url: url(web.url) }) as { targetId: string }
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
      expect(managerPeers).toHaveLength(2)
      for (const page of [first, second]) {
        await page.evaluate(`(() => {
          globalThis.__fixtureDialogRoots = []
          const attach = Element.prototype.attachShadow
          Element.prototype.attachShadow = function(options) {
            const root = attach.call(this, options)
            globalThis.__fixtureDialogRoots.push(root)
            return root
          }
          globalThis.__fixtureExecutions = []
          globalThis.__fixtureManagementTrace = []
          const forward = window.fetch.bind(window)
          window.fetch = async (url, options) => {
            let operation
            if (url === '/api/renderer/binding' && typeof options?.body === 'string') {
              try { operation = JSON.parse(JSON.parse(options.body).payload).operation.kind } catch {}
            }
            const response = await forward(url, options)
            if (['plan', 'execute', 'query'].includes(operation)) {
              const reply = await response.clone().json().catch(() => undefined)
              const result = { operation, http: response.status, ok: reply?.ok, status: reply?.value?.status,
                code: reply?.value?.error?.code, error: reply?.error }
              globalThis.__fixtureManagementTrace.push(result)
              if (operation === 'execute') globalThis.__fixtureExecutions.push(result)
            }
            return response
          }
        })()`)
      }
      const snapshot = async (page: CdpClient) =>
        await page.evaluate(`({
        active: globalThis.__cordisxRuntime.activePluginGeneration(),
        registryEpoch: globalThis.__cordisxRuntime.pluginRegistryEpoch()
      })`)
      expect(await snapshot(first)).toEqual(await snapshot(second))
      expect(await snapshot(first)).toEqual(await snapshot(desktop))
      expect(await snapshot(first)).toEqual(await snapshot(secondDesktop))
      const rpcPaths = pluginManagementRpcPaths(homeDir, 'codex', profileId)
      const endpoint = (await readPluginManagementRpcEndpoint(rpcPaths))!
      const install = async (id: string, dependencies: readonly { id: string; version: string }[] = []) => {
        const sourceDirectory = await localPackage({
          root,
          id,
          dependencies,
          code: `export function apply() { globalThis.__${id.replaceAll('-', '_')} = true }`,
        })
        const planned = await requestPluginManagementRpc(rpcPaths, endpoint, {
          kind: 'plan',
          request: { kind: 'plugin-plan-local', sourceDirectory },
        }) as any
        expect(planned.status).toBe('planned')
        const result = await requestPluginManagementRpc(rpcPaths, endpoint, {
          kind: 'execute',
          request: planned.executionRequest,
          expectedRevision: planned.snapshot.revision,
        }) as any
        expect(result.status, JSON.stringify({ error: result.error ?? result.lifecycle?.error ?? {}, stageErrors }))
          .toBe('applied')
      }
      const change = async (kind: 'plugin-disable' | 'plugin-enable', pluginId: string) => {
        const planned = await requestPluginManagementRpc(rpcPaths, endpoint, {
          kind: 'plan',
          request: { kind, pluginId },
        }) as any
        expect(planned.status).toBe('planned')
        const result = await requestPluginManagementRpc(rpcPaths, endpoint, {
          kind: 'execute',
          request: planned.executionRequest,
          expectedRevision: planned.snapshot.revision,
        }) as any
        expect(result.status, JSON.stringify({ error: result.error ?? result.lifecycle?.error ?? {}, stageErrors }))
          .toBe('applied')
      }
      const verifyAll = async (enabled: boolean[]) => {
        const expected = await snapshot(desktop!) as { active: { plugins: Array<{ enabled: boolean }> } }
        expect(expected.active.plugins.map(item => item.enabled)).toEqual(enabled)
        for (const page of [secondDesktop!, first!, second!]) expect(await snapshot(page)).toEqual(expected)
      }
      const openDetail = async (page: CdpClient, id: string) => {
        const item = JSON.stringify(`[data-plugin-id="${id}"]`)
        const detail = JSON.stringify(`[data-plugin-detail="${id}"]`)
        await expect.poll(() => page.evaluate(`Boolean(document.querySelector(${item}))`), { timeout: 20_000 })
          .toBe(true)
        await page.evaluate(`document.querySelector(${item}).click()`)
        await expect.poll(() => page.evaluate(`Boolean(document.querySelector(${detail}))`), { timeout: 20_000 })
          .toBe(true)
      }
      const clickLifecycle = async (page: CdpClient, action: 'enable' | 'disable') => {
        const selector = JSON.stringify(`[data-plugin-lifecycle-action="${action}"]`)
        const previous = await page.evaluate<number>('globalThis.__fixtureExecutions.length')
        await expect.poll(() =>
          page.evaluate(`(() => {
          const button = document.querySelector(${selector})
          if (!button || button.disabled || button.hasAttribute('disabled')
            || button.classList.contains('t-is-disabled') || button.getAttribute('aria-disabled') === 'true') return false
          button.click()
          return true
        })()`), { timeout: 20_000 }).toBe(true)
        if (action === 'disable') {
          try {
            await expect.poll(() =>
              page.evaluate(`globalThis.__fixtureDialogRoots.some(root =>
              root.querySelector('dialog[open] [data-action=confirm]'))`), { timeout: 20_000 }).toBe(true)
          } catch (cause) {
            const details = await page.evaluate(`({
              button: document.querySelector(${selector})?.outerHTML.slice(0, 500),
              roots: globalThis.__fixtureDialogRoots.length,
              alerts: [...document.querySelectorAll('[role=alert]')].map(item => item.textContent),
              trace: globalThis.__fixtureManagementTrace.slice(-12),
              lifecycle: globalThis.__cordisxRuntime.snapshot().pluginLifecycle
            })`)
            throw new Error(`Manager lifecycle confirmation unavailable: ${JSON.stringify(details)}`, { cause })
          }
          await page.evaluate(`globalThis.__fixtureDialogRoots.find(root =>
            root.querySelector('dialog[open] [data-action=confirm]'))
            .querySelector('dialog[open] [data-action=confirm]').click()`)
        }
        await expect.poll(() =>
          page.evaluate(`globalThis.__fixtureExecutions.slice(${previous})
          .some(item => item.ok === true && item.status === 'applied')`), { timeout: 45_000 }).toBe(true)
      }
      checkpoint = 'install base'
      await install('base-fixture')
      await verifyAll([true])
      for (const page of [desktop, secondDesktop, first, second]) {
        expect(await page!.evaluate('globalThis.__base_fixture === true')).toBe(true)
      }
      checkpoint = 'install dependent'
      await install('dependent-fixture', [{ id: 'base-fixture', version: '1.0.0' }])
      await verifyAll([true, true])
      for (const page of [desktop, secondDesktop, first, second]) {
        expect(await page!.evaluate('globalThis.__dependent_fixture === true')).toBe(true)
      }
      await openDetail(first, 'base-fixture')
      await openDetail(second, 'base-fixture')
      checkpoint = 'disable dependency closure through first Manager'
      await clickLifecycle(first, 'disable')
      await verifyAll([false, false])
      checkpoint = 'enable base through second Manager'
      await clickLifecycle(second, 'enable')
      await verifyAll([true, false])
      checkpoint = 'enable dependent'
      await change('plugin-enable', 'dependent-fixture')
      await verifyAll([true, true])
      // A Manager joining after packages are active must bootstrap the same
      // owner-selected graphs, not an empty or independently rebuilt registry.
      checkpoint = 'admit third Manager'
      const thirdTarget = await desktop.send('Target.createTarget', { url: url(web.issueUrl()) }) as {
        targetId: string
      }
      third = await connect(thirdTarget.targetId)
      await ready(third)
      expect(await snapshot(third)).toEqual(await snapshot(desktop))
      expect(await third.evaluate('globalThis.__base_fixture === true && globalThis.__dependent_fixture === true'))
        .toBe(true)
      await desktop.send('Target.closeTarget', { targetId: thirdTarget.targetId })
      await third.close().catch(() => {})
      third = undefined
      await vi.waitFor(() => expect(managerPeers[2]?.closed).toBe(true), { timeout: 10_000 })
      expect(await productionOwner.managementOptions.rendererRetirement(managerPeers[2]!.identity.rendererId)).toBe(
        true,
      )
      // Disconnect one real Manager after the participants are frozen and
      // another participant can have received the stage command.
      checkpoint = 'interrupt staged change'
      const planned = await requestPluginManagementRpc(rpcPaths, endpoint, {
        kind: 'plan',
        request: { kind: 'plugin-disable', pluginId: 'base-fixture' },
      }) as any
      expect(planned.status).toBe('planned')
      blockStage = true
      const pending = requestPluginManagementRpc(rpcPaths, endpoint, {
        kind: 'execute',
        request: planned.executionRequest,
        expectedRevision: planned.snapshot.revision,
      }) as Promise<any>
      await Promise.race([
        stageBlocked,
        pending.then(() => {
          throw new Error('stage was not dispatched')
        }),
      ])
      await desktop.send('Target.closeTarget', { targetId: firstTarget.targetId })
      await first.close().catch(() => {})
      first = undefined
      await vi.waitFor(() => expect(managerPeers[0]?.closed).toBe(true), { timeout: 10_000 })
      releaseStage()
      const interrupted = await pending
      expect(interrupted.status).toBe('rejected')
      expect(interrupted.error?.code ?? interrupted.lifecycle?.error?.code).toBe('rollback-failed')
      expect(() => lifecycle.snapshot()).toThrow()
      await vi.waitFor(async () => {
        const status = await second!.evaluate<{ hidden: boolean; text: string }>(`({
          hidden: document.querySelector('p[role=status]')?.hidden,
          text: document.querySelector('p[role=status]')?.textContent ?? ''
        })`)
        expect(status.hidden).toBe(false)
        expect(status.text).toContain('连接不可用')
      }, { timeout: 10_000 })
    } catch (cause) {
      throw new Error(`Desktop fleet failed at ${checkpoint}: ${JSON.stringify(stageErrors)}`, { cause })
    } finally {
      releaseStage()
      await first?.close().catch(() => {})
      await second?.close().catch(() => {})
      await third?.close().catch(() => {})
      await web?.close().catch(() => {})
      await composition?.close().catch(() => {})
      await owner.close()
      unregister?.()
      unregisterSecond?.()
      await secondDesktop?.close().catch(() => {})
      await desktop?.close().catch(() => {})
      if (browser) await stopChrome(browser)
      await managed.dispose()
      await artifactServer.close()
      await control.close()
      await new Promise<void>((resolve, reject) => desktopServer.close(error => error ? reject(error) : resolve()))
      const digests = await readdir(path.join(homeDir, 'packages', 'sha256')).catch(() => [])
      await Promise.all(digests.map(async digest => await removeStagedPluginPackage(homeDir, `sha256:${digest}`)))
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },
  180_000,
)
