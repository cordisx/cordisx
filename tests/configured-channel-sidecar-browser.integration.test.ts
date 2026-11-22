import { accessSync, constants } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ChildProcess } from 'node:child_process'
import { expect, it } from 'vitest'
import { managerRendererGatewayPaths } from '../packages/cli/src/cli/manager-renderer-gateway.js'
import { startSupervisorControlServer } from '../packages/cli/src/cli/supervisor-control.js'
import { openProductionPluginManagementComposition } from '../packages/cli/src/cli/production-plugin-management.js'
import { createConfiguredChannelOwner } from '../packages/cli/src/cli/configured-channel-owner.js'
import { ManagerPermissionProofAuthority } from '../packages/cli/src/cli/manager-permission-proof-authority.js'
import type { ServiceRendererPermissionConsumerFence } from '../packages/cli/src/cli/service-renderer-permission-handoff.js'
import { loadHomeConfig } from '../packages/cli/src/config/home-config.js'
import {
  effectiveConfigFingerprint,
  processStartIdentity,
  writeSupervisorState,
} from '../packages/cli/src/cli/supervisor-state.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../packages/cli/src/launcher/management-rpc.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'
import { CdpClient, stopChrome, trustedClick } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'

const archive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE
const managerPackage = process.env.CORDISX_MANAGER_PACKAGE_FIXTURE
const secret = () => randomBytes(32).toString('hex')
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

it.skipIf(!archive || !managerPackage || !chrome || process.platform !== 'darwin' && process.platform !== 'linux').each(
  [
    false,
    true,
  ],
)(
  'connects two Manager pages to Channel through the sidecar (signed review: %s)',
  async signedReview => {
    let live = true
    let f!: Awaited<ReturnType<typeof fixture>>
    const proof = signedReview
      ? new ManagerPermissionProofAuthority({
        profileId: 'default',
        generation: 'fixture-owner',
        isCurrent: context => live && f.participants.peer(context.rendererId) !== undefined,
      })
      : undefined
    f = await fixture({
      channelArchive: archive!,
      channelUiGrant: !signedReview,
      protectProfileInputs: true,
      ...(proof === undefined ? {} : { permissionProof: proof }),
    })
    const events: Array<{ action: string; channel?: string; step?: string; status?: string }> = []
    const profile = await mkdtemp(path.join(os.tmpdir(), 'cx-channel-sidecar-browser-'))
    let browser: ChildProcess | undefined
    let supervisor: Awaited<ReturnType<typeof startSupervisorControlServer>> | undefined
    let composition: Awaited<ReturnType<typeof openProductionPluginManagementComposition>> | undefined
    let closeWeb: (() => Promise<void>) | undefined
    const pages: CdpClient[] = []
    const entry = (value: string) => {
      const url = new URL(value)
      url.searchParams.set('host', '1')
      return url.href
    }
    const readyPage = async (page: CdpClient) => {
      try {
        // The production bootstrap itself allows 60 seconds for its bundle; a
        // cold browser must not be declared failed before that deadline.
        await expect.poll(() => page.evaluate('document.documentElement.dataset.cordisxReady'), { timeout: 70_000 })
          .toBe('true')
      } catch {
        const state = await page.evaluate(`({
          text: document.body.innerText.slice(0, 300),
          path: location.pathname,
          readyState: document.readyState,
          controlled: Boolean(navigator.serviceWorker?.controller),
          resources: performance.getEntriesByType('resource').slice(-12).map(item => ({
            path: new URL(item.name).pathname, duration: Math.round(item.duration),
          })),
        })`)
        throw new Error(
          'Manager did not start: '
            + JSON.stringify({
              state,
              events: events.slice(-30),
              diagnostics: page.diagnostics.map(item => (item as { method?: string }).method),
            }),
        )
      }
      await expect.poll(() =>
        page.evaluate('Boolean(document.querySelector("[data-settings-navigation-item^=channel]"))')
      )
        .toBe(true)
    }
    const openPage = async (page: CdpClient) => {
      await readyPage(page)
      await page.evaluate('document.querySelector("[data-settings-navigation-item^=channel]").click()')
      await expect.poll(() => page.evaluate('Boolean(document.querySelector("[data-manager-collection-item]"))'))
        .toBe(true)
      await expect.poll(() =>
        page.evaluate(
          'document.body.textContent.includes("Simulator") || document.body.textContent.includes("模拟器")',
        )
      ).toBe(true)
      expect(await page.evaluate('document.body.textContent.includes("fixture-private-reference")')).toBe(false)
    }
    try {
      expect(await f.sessions.close(f.invocation)).toBe(true)
      const startedAt = await processStartIdentity(process.pid)
      if (!startedAt) throw new Error('test process identity unavailable')
      const gateway = { pid: process.pid, processStartedAt: startedAt, instanceToken: secret() }
      const gatewayPaths = managerRendererGatewayPaths(f.homeDir, f.profileId)
      await mkdir(path.dirname(gatewayPaths.socket), { recursive: true, mode: 0o700 })
      await writeSupervisorState(gatewayPaths, {
        schemaVersion: 1,
        appId: 'manager',
        profileId: f.profileId,
        phase: 'ready',
        ...gateway,
        createdAt: new Date().toISOString(),
        version: 'fixture',
        effectiveConfig: effectiveConfigFingerprint({ appId: 'codex', generation: f.generation }),
      })
      supervisor = await startSupervisorControlServer({
        socketPath: gatewayPaths.socket,
        token: gateway.instanceToken,
        stop: () => {},
      })
      const configuredOwner = signedReview
        ? createConfiguredChannelOwner({
          homeDir: f.homeDir,
          configPath: f.configPath,
          profileId: f.profileId,
          plugin: f.configuredChannel!.plugin,
          service: f.configuredChannel!.service,
          ownerCurrent: () => live,
        })
        : undefined
      if (signedReview && !configuredOwner) throw new Error('test Channel authority unavailable')
      composition = await openProductionPluginManagementComposition({
        homeDir: f.homeDir,
        configPath: f.configPath,
        appId: 'codex',
        profileId: f.profileId,
        runtimeGeneration: f.generation,
        token: secret(),
        coordinator: f.coordinator,
        rendererParticipant: f.participants.participant,
        rendererParticipants: f.participants,
        rendererLifecycle: f.lifecycle,
        rendererBootstrap: f.bootstrap.channel(),
        rendererRetirement: rendererId => f.bootstrap.waitForRetirement(rendererId),
        rendererWriteLifetimes: f.bootstrap.writeLifetimes,
        rendererReadLifetimes: f.bootstrap.readLifetimes,
        rendererReadonlyChannel: f.channelBridge!.channel,
        rendererManagedServiceUI: f.managedUI.channel,
        ...(proof === undefined || configuredOwner === undefined ? {} : {
          rendererConfiguredChannelService: {
            bootstrap: f.bootstrap,
            plugin: f.configuredChannel!.plugin,
            service: f.configuredChannel!.service,
            authority: configuredOwner,
          },
          rendererPermissionPolicy: {
            bootstrap: f.bootstrap,
            proof,
            // This test models non-Manager consumers; it does not enable the production gate.
            reserveOtherConsumers: async () => {
              let current = true
              return {
                isCurrent: () => current && live,
                adopt: async (input: Parameters<ServiceRendererPermissionConsumerFence['adopt']>[0]) => ({
                  profileId: input.profileId,
                  ownerGeneration: input.ownerGeneration,
                  requestId: input.requestId,
                  adopted: current && live,
                  candidate: input.candidate,
                }),
                release: () => {
                  if (!current || !live) return false
                  current = false
                  return true
                },
                fence: () => {
                  current = false
                },
              }
            },
          },
        }),
        mode: 'service',
        processStartedAt: startedAt,
      })
      const rpcPaths = pluginManagementRpcPaths(f.homeDir, 'codex', f.profileId)
      const endpoint = await readPluginManagementRpcEndpoint(rpcPaths)
      if (!endpoint) throw new Error('test owner endpoint unavailable')
      const moduleUrl = pathToFileURL(path.join(managerPackage!, 'dist/src/cli/manager-web.js')).href
      const { startManagerWeb } = await import(moduleUrl) as typeof import('../packages/cli/src/cli/manager-web.js')
      const web = await startManagerWeb({
        appId: 'codex',
        profileId: f.profileId,
        generation: f.generation,
        isCurrent: async () => {
          const current = await readPluginManagementRpcEndpoint(rpcPaths)
          return live && current?.generation === endpoint.generation && current.token === endpoint.token
        },
        request: async (operation, options) => {
          const result = await requestPluginManagementRpc(rpcPaths, endpoint, operation, options)
          if (operation.kind === 'manager-renderer') {
            const step = operation.action === 'call' && operation.payload && typeof operation.payload === 'object'
              ? (operation.payload as { action?: unknown }).action
              : undefined
            events.push({
              action: operation.action,
              ...(operation.action === 'call' ? { channel: operation.channel } : {}),
              ...(typeof step === 'string' ? { step } : {}),
              status: (result as { status?: string }).status,
            })
          }
          return result
        },
      }, { rendererGateway: gateway })
      closeWeb = async () => await web.close()
      const launched = launchChrome(chrome!, profile)
      browser = launched.browser
      const socketUrl = await waitForChromeTarget(profile, browser, launched.stderr)
      const first = await CdpClient.connect(socketUrl)
      pages.push(first)
      await first.send('Page.enable')
      await first.send('Runtime.enable')
      await first.send('Network.enable')
      await first.send('Page.navigate', { url: entry(web.url) })
      await readyPage(first)
      const debugOrigin = 'http://' + new URL(socketUrl).host
      const secondUrl = entry(web.issueUrl())
      const response = await fetch(debugOrigin + '/json/new?' + encodeURIComponent(secondUrl), { method: 'PUT' })
      const target = await response.json() as { webSocketDebuggerUrl: string }
      const second = await CdpClient.connect(target.webSocketDebuggerUrl)
      pages.push(second)
      await second.send('Runtime.enable')
      await second.send('Network.enable')
      await readyPage(second)
      if (signedReview) {
        for (const page of [first, second]) {
          await expect.poll(() =>
            page.evaluate(
              'document.querySelector("[data-settings-navigation-item^=channel]")?.dataset.permissionReview',
            )
          ).toBe('pending')
        }
        const reviewed = new Set<string>()
        for (let index = 0; index < 2; index++) {
          await first.evaluate('document.querySelector("[data-settings-navigation-item^=channel]").click()')
          try {
            await expect.poll(
              () =>
                first.evaluate('document.querySelector("[data-standalone-dom-review]")?.dataset.standaloneDomReview'),
              { timeout: 15_000 },
            ).toBeTruthy()
          } catch (error) {
            const state = await first.evaluate(
              '({ text: document.body.innerText.slice(0, 350),'
                + ' nav: document.querySelector("[data-settings-navigation-item^=channel]")?.getAttribute("data-permission-review"),'
                + ' connected: !document.body.textContent.includes("CordisX 连接不可用") })',
            )
            throw new Error(
              'Signed review unavailable: '
                + JSON.stringify({ index, reviewed: [...reviewed], state, events: events.slice(-15) }),
              { cause: error },
            )
          }
          const point = await first.evaluate<string>(
            'document.querySelector("[data-standalone-dom-review]").dataset.standaloneDomReview',
          )
          expect(reviewed.has(point)).toBe(false)
          reviewed.add(point)
          await expect.poll(
            () =>
              first.evaluate('Boolean(document.querySelector("[data-standalone-dom-review] button:not(:disabled)"))'),
            { timeout: 15_000 },
          ).toBe(true)
          await first.evaluate('document.querySelector("[data-standalone-dom-review] button").click()')
          expect(await first.evaluate('Boolean(document.querySelector("[data-permission-authorization]"))')).toBe(false)
          await trustedClick(first, '[data-standalone-dom-review] button')
          await expect.poll(
            () => first.evaluate('Boolean(document.querySelector("[data-permission-decision=allow-persistent]"))'),
            { timeout: 15_000 },
          ).toBe(true)
          await first.evaluate('document.querySelector("[data-permission-decision=allow-persistent]").click()')
          expect(
            await first.evaluate(
              'document.querySelector("[data-permission-decision=allow-persistent]")?.getAttribute("aria-checked")',
            ),
          ).toBe('false')
          await trustedClick(first, '[data-permission-decision=allow-persistent]')
          await expect.poll(() =>
            first.evaluate(
              'document.querySelector("[data-permission-decision=allow-persistent]")?.getAttribute("aria-checked")',
            )
          ).toBe('true')
          await trustedClick(first, '[data-permission-action=confirm]')
          await expect.poll(
            async () =>
              (await loadHomeConfig(f.configPath)).permissions.filter(policy =>
                policy.key.identity.pluginId === 'channel'
              ).length,
            { timeout: 60_000 },
          ).toBe(index + 1)
          await expect.poll(
            () =>
              events.filter(event =>
                event.action === 'call' && event.channel === 'permission-policy' && event.status === 'ok'
              ).length,
            { timeout: 60_000 },
          ).toBe(index + 1)
        }
        expect([...reviewed].sort()).toEqual(['manager.content', 'manager.settings.navigation-items'])
        await expect.poll(() =>
          second.evaluate(
            'document.querySelector("[data-settings-navigation-item^=channel]")?.getAttribute("data-permission-review")',
          )
        ).toBe(null)
        await expect.poll(
          () => first.evaluate('document.querySelector("[data-standalone-dom-reset]")?.dataset.standaloneDomReset'),
          { timeout: 15_000 },
        ).toBeTruthy()
        const resetPoint = await first.evaluate<string>(
          'document.querySelector("[data-standalone-dom-reset]").dataset.standaloneDomReset',
        )
        const policy = async () =>
          (await loadHomeConfig(f.configPath)).permissions.find(item =>
            item.key.identity.pluginId === 'channel' && 'extensionPoints' in item.key.scope
            && item.key.scope.extensionPoints?.includes(resetPoint)
          )?.policy
        const writes = () =>
          events.filter(event =>
            event.action === 'call' && event.channel === 'permission-policy' && event.status === 'ok'
          ).length
        await expect.poll(
          () => first.evaluate('Boolean(document.querySelector("[data-standalone-dom-reset]:not(:disabled)"))'),
          { timeout: 15_000 },
        ).toBe(true)
        await first.evaluate('document.querySelector("[data-standalone-dom-reset]").click()')
        expect(await policy()).toBe('allow-persistent')
        expect(writes()).toBe(2)
        await trustedClick(first, '[data-standalone-dom-reset]')
        try {
          await expect.poll(policy, { timeout: 15_000 }).toBe('ask')
        } catch (error) {
          const state = await first.evaluate(`({
            text: document.querySelector('[data-standalone-dom-policy]')?.innerText,
            connected: !document.body.textContent.includes('CordisX 连接不可用'),
          })`)
          throw new Error('Reset did not reach the owner: ' + JSON.stringify({ state, events: events.slice(-20) }), {
            cause: error,
          })
        }
        await expect.poll(writes, { timeout: 60_000 }).toBe(3)
        await expect.poll(() =>
          second.evaluate(
            'document.querySelector("[data-settings-navigation-item^=channel]")?.getAttribute("data-permission-review")',
          )
        ).toBe('pending')
        const reviewAs = async (decision: 'allow-persistent' | 'deny-persistent') => {
          await expect.poll(
            () => first.evaluate('document.querySelector("[data-standalone-dom-review]")?.dataset.standaloneDomReview'),
            { timeout: 15_000 },
          ).toBe(resetPoint)
          await expect.poll(
            () =>
              first.evaluate('Boolean(document.querySelector("[data-standalone-dom-review] button:not(:disabled)"))'),
            { timeout: 15_000 },
          ).toBe(true)
          await trustedClick(first, '[data-standalone-dom-review] button')
          const selector = `[data-permission-decision=${decision}]`
          await expect.poll(
            () => first.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),
            { timeout: 15_000 },
          ).toBe(true)
          await trustedClick(first, selector)
          await expect.poll(() =>
            first.evaluate(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-checked')`)
          ).toBe('true')
          await trustedClick(first, '[data-permission-action=confirm]')
        }
        await reviewAs('deny-persistent')
        await expect.poll(policy, { timeout: 60_000 }).toBe('deny-persistent')
        await expect.poll(writes, { timeout: 60_000 }).toBe(4)
        await expect.poll(
          () => first.evaluate('Boolean(document.querySelector("[data-standalone-dom-reset]:not(:disabled)"))'),
          { timeout: 15_000 },
        ).toBe(true)
        await trustedClick(first, '[data-standalone-dom-reset]')
        await expect.poll(policy, { timeout: 60_000 }).toBe('ask')
        await expect.poll(writes, { timeout: 60_000 }).toBe(5)
        await reviewAs('allow-persistent')
        await expect.poll(policy, { timeout: 60_000 }).toBe('allow-persistent')
        await expect.poll(writes, { timeout: 60_000 }).toBe(6)
      }
      await openPage(first)
      await openPage(second)
      await first.evaluate('globalThis.__fixtureBeforeReload = true')
      await first.send('Page.reload')
      await expect.poll(
        async () => await first.evaluate('globalThis.__fixtureBeforeReload === undefined').catch(() => false),
        { timeout: 15_000 },
      ).toBe(true)
      await openPage(first)
      const service = f.configuredChannel!.service
      const restart = await service.restart(f.configuredChannel!.configuration, service.generation())
      await restart.finalize()
      for (const page of [first, second]) {
        await expect.poll(() => page.evaluate('document.body.textContent.includes("CordisX 连接不可用")'), {
          timeout: 25_000,
        }).toBe(true)
      }
      await expect.poll(async () => {
        const browserSessionId = secret()
        const opened = await requestPluginManagementRpc(rpcPaths, endpoint, {
          kind: 'manager-renderer',
          action: 'open',
          gateway,
          browserSessionId,
        }) as { status?: string }
        if (opened.status !== 'ok') return false
        const closed = await requestPluginManagementRpc(rpcPaths, endpoint, {
          kind: 'manager-renderer',
          action: 'revoke',
          gateway,
          browserSessionId,
        }) as { status?: string }
        return closed.status === 'ok'
      }, { timeout: 10_000 }).toBe(true)
      const renewedUrl = entry(web.issueUrl())
      const renewedResponse = await fetch(debugOrigin + '/json/new?' + encodeURIComponent(renewedUrl), {
        method: 'PUT',
      })
      const renewedTarget = await renewedResponse.json() as { webSocketDebuggerUrl: string }
      const renewed = await CdpClient.connect(renewedTarget.webSocketDebuggerUrl)
      pages.push(renewed)
      await renewed.send('Runtime.enable')
      await renewed.send('Network.enable')
      await openPage(renewed)
    } finally {
      live = false
      for (const page of pages) await page.close().catch(() => undefined)
      if (browser) await stopChrome(browser)
      await closeWeb?.()
      await composition?.close()
      proof?.close()
      await supervisor?.close()
      await f.close()
      await rm(profile, { recursive: true, force: true })
    }
  },
  240_000,
)
