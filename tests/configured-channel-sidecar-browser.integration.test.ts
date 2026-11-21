import { accessSync, constants } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ChildProcess } from 'node:child_process'
import { expect, it } from 'vitest'
import { dispatchManagerRendererOperation } from '../packages/cli/src/cli/manager-renderer-rpc.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'
import { CdpClient, stopChrome } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'

const archive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE
const managerPackage = process.env.CORDISX_MANAGER_PACKAGE_FIXTURE
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

it.skipIf(!archive || !managerPackage || !chrome || process.platform !== 'darwin' && process.platform !== 'linux')(
  'connects two real Manager pages to the owner-selected read-only Channel through the sidecar',
  async () => {
    const f = await fixture({
      channelArchive: archive!,
      channelUiGrant: true,
      protectProfileInputs: true,
      includePluginManagement: true,
    })
    expect(await f.sessions.close(f.invocation)).toBe(true)
    let live = true
    const events: Array<{ action: string; channel?: string; step?: string; status?: string }> = []
    const moduleUrl = pathToFileURL(path.join(managerPackage!, 'dist/src/cli/manager-web.js')).href
    const { startManagerWeb } = await import(moduleUrl) as typeof import('../packages/cli/src/cli/manager-web.js')
    const web = await startManagerWeb({
      appId: 'codex',
      profileId: f.profileId,
      generation: f.generation,
      isCurrent: async () => live,
      request: async operation => {
        if (operation.kind !== 'manager-renderer') return { status: 'unavailable' }
        const result = await dispatchManagerRendererOperation(f.sessions, operation)
        const step = operation.action === 'call' && operation.payload && typeof operation.payload === 'object'
          ? (operation.payload as { action?: unknown }).action
          : undefined
        events.push({
          action: operation.action,
          ...(operation.action === 'call' ? { channel: operation.channel } : {}),
          ...(typeof step === 'string' ? { step } : {}),
          status: (result as { status?: string }).status,
        })
        return result
      },
    }, { rendererGateway: f.gateway })
    const profile = await mkdtemp(path.join(os.tmpdir(), 'cx-channel-sidecar-browser-'))
    let browser: ChildProcess | undefined
    const pages: CdpClient[] = []
    const entry = (value: string) => {
      const url = new URL(value)
      url.searchParams.set('host', '1')
      return url.href
    }
    const openPage = async (page: CdpClient) => {
      try {
        await expect.poll(() => page.evaluate('document.documentElement.dataset.cordisxReady'), { timeout: 25_000 })
          .toBe('true')
      } catch {
        const state = await page.evaluate('({ text: document.body.innerText.slice(0, 300), path: location.pathname })')
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
      const launched = launchChrome(chrome!, profile)
      browser = launched.browser
      const socketUrl = await waitForChromeTarget(profile, browser, launched.stderr)
      const first = await CdpClient.connect(socketUrl)
      pages.push(first)
      await first.send('Page.enable')
      await first.send('Page.navigate', { url: entry(web.url) })
      await openPage(first)
      const debugOrigin = 'http://' + new URL(socketUrl).host
      const secondUrl = entry(web.issueUrl())
      const response = await fetch(debugOrigin + '/json/new?' + encodeURIComponent(secondUrl), { method: 'PUT' })
      const target = await response.json() as { webSocketDebuggerUrl: string }
      const second = await CdpClient.connect(target.webSocketDebuggerUrl)
      pages.push(second)
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
      await expect.poll(() => f.sessions.hasLiveRenderers(), { timeout: 10_000 }).toBe(false)
      const renewedUrl = entry(web.issueUrl())
      const renewedResponse = await fetch(debugOrigin + '/json/new?' + encodeURIComponent(renewedUrl), {
        method: 'PUT',
      })
      const renewedTarget = await renewedResponse.json() as { webSocketDebuggerUrl: string }
      const renewed = await CdpClient.connect(renewedTarget.webSocketDebuggerUrl)
      pages.push(renewed)
      await openPage(renewed)
    } finally {
      live = false
      for (const page of pages) await page.close().catch(() => undefined)
      if (browser) await stopChrome(browser)
      await web.close()
      await f.close()
      await rm(profile, { recursive: true, force: true })
    }
  },
  120_000,
)
