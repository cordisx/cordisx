import type { ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { readServiceConfigState } from '../packages/cli/src/config/service-config.js'
import { dispatchManagerRendererOperation } from '../packages/cli/src/cli/manager-renderer-rpc.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'
import { CdpClient, stopChrome, trustedClick } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'

// Use the real owner and browser with a synthetic adapter that cannot send.
vi.mock('../packages/cli/src/launcher/feishu-adapter.js', async importOriginal => {
  const original = await importOriginal<typeof import('../packages/cli/src/launcher/feishu-adapter.js')>()
  return {
    ...original,
    feishuDefinitionsForConfig: (
      configuration: Parameters<typeof original.feishuDefinitionsForConfig>[0],
      input: Parameters<typeof original.feishuDefinitionsForConfig>[1],
    ) =>
      configuration.connections
        .filter(connection => connection.enabled && ['feishu', 'lark'].includes(connection.adapterKind))
        .map(connection => ({
          descriptor: {
            ref: connection.ref,
            kind: connection.adapterKind,
            implementationStatus: 'implemented' as const,
            configurationRevision: input.configurationRevision,
            secretState: 'ready' as const,
          },
          start: async () => ({
            send: async () => {
              throw new Error('synthetic transport cannot send')
            },
            stop: async () => {},
          }),
        })),
  }
})

const archive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE
const managerPackage = process.env.CORDISX_MANAGER_PACKAGE_FIXTURE
const chrome = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find(candidate => {
  if (!candidate || !path.isAbsolute(candidate)) return false
  try {
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
})

interface BrowserNode {
  readonly backendNodeId: number
  readonly nodeName: string
  readonly attributes?: string[]
  readonly children?: BrowserNode[]
  readonly shadowRoots?: BrowserNode[]
}

// The Host dialog intentionally uses a closed shadow root; the browser can still
// deliver a real user click to its footer through the DevTools DOM protocol.
async function findDialogAction(page: CdpClient, action: string): Promise<BrowserNode | undefined> {
  const tree = await page.send('DOM.getDocument', { depth: -1, pierce: true }) as { root: BrowserNode }
  const visit = (node: BrowserNode): BrowserNode | undefined => {
    const attributes = node.attributes ?? []
    const index = attributes.indexOf('data-action')
    if (node.nodeName === 'BUTTON' && index >= 0 && attributes[index + 1] === action) return node
    for (const child of [...node.children ?? [], ...node.shadowRoots ?? []]) {
      const found = visit(child)
      if (found) return found
    }
    return undefined
  }
  return visit(tree.root)
}

async function clickDialogAction(page: CdpClient, node: BrowserNode): Promise<void> {
  await page.send('Page.bringToFront')
  await page.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendNodeId })
  const result = await page.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }) as {
    model: { content: number[] }
  }
  const quad = result.model.content
  const point = { x: (quad[0]! + quad[2]!) / 2, y: (quad[1]! + quad[5]!) / 2 }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', {
      type,
      ...point,
      ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }),
    })
  }
}

it.skipIf(!archive || !managerPackage || !chrome || process.platform !== 'darwin' && process.platform !== 'linux')(
  'creates a credentialed Channel through the existing Manager page and Host form',
  async () => {
    const f = await fixture({
      channelArchive: archive,
      channelUiGrant: true,
      protectProfileInputs: true,
      channelServiceConfig: true,
      channelCredentials: true,
      browserManagement: true,
    })
    let browser: ChildProcess | undefined
    let page: CdpClient | undefined
    let web: Awaited<ReturnType<typeof import('../packages/cli/src/cli/manager-web.js')['startManagerWeb']>> | undefined
    try {
      expect(await f.sessions.close(f.invocation)).toBe(true)
      const manager = await import(
        pathToFileURL(path.join(managerPackage!, 'dist/src/cli/manager-web.js')).href
      ) as typeof import('../packages/cli/src/cli/manager-web.js')
      web = await manager.startManagerWeb({
        appId: 'codex',
        profileId: f.profileId,
        generation: f.generation,
        isCurrent: async () => true,
        request: async operation =>
          operation.kind === 'manager-renderer'
            ? await dispatchManagerRendererOperation(f.sessions, operation)
            : { status: 'unavailable' },
      }, { rendererGateway: f.gateway })
      const url = new URL(web.url)
      url.searchParams.set('host', '1')
      const launched = launchChrome(chrome!, path.join(f.root, 'browser'))
      browser = launched.browser
      page = await CdpClient.connect(await waitForChromeTarget(path.join(f.root, 'browser'), browser, launched.stderr))
      await page.send('Runtime.enable')
      await page.send('Page.enable')
      await page.send('Page.navigate', { url: url.href })
      const active = page
      const exists = (selector: string) =>
        active.evaluate<boolean>(
          'Boolean(document.querySelector(' + JSON.stringify(selector) + '))',
        )
      const enabled = (selector: string) =>
        active.evaluate<boolean>(
          'Boolean(document.querySelector(' + JSON.stringify(selector) + ') && !document.querySelector('
            + JSON.stringify(selector) + ').disabled)',
        )
      const set = (selector: string, value: string) =>
        active.evaluate(
          '(() => { const input = document.querySelector(' + JSON.stringify(selector) + ');'
            + ' Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, '
            + JSON.stringify(value) + '); input.dispatchEvent(new Event("input", { bubbles: true }));'
            + ' input.dispatchEvent(new Event("change", { bubbles: true })); })()',
        )
      await expect.poll(() => active.evaluate('document.documentElement.dataset.cordisxReady'), { timeout: 60_000 })
        .toBe('true')
      await expect.poll(() =>
        active.evaluate(
          'document.querySelector("[data-cordisx-react-manager]")?.hidden === false',
        ), { timeout: 60_000 }).toBe(true)
      await expect.poll(() => exists('[data-settings-navigation-item^=channel]'), { timeout: 15_000 }).toBe(true)
      await active.evaluate('document.querySelector("[data-settings-navigation-item^=channel]").click()')
      await expect.poll(() =>
        active.evaluate(
          'document.body.innerText.includes("Simulator") || document.body.innerText.includes("模拟器")',
        ), { timeout: 15_000 }).toBe(true)
      const createButton = '[data-cordisx-page-header-action="create"]'
      await expect.poll(() =>
        active.evaluate(
          '(() => { const button = document.querySelector(' + JSON.stringify(createButton) + ');'
            + ' const rect = button?.getBoundingClientRect(); return Boolean(button && !button.disabled && rect.width > 0 && rect.height > 0); })()',
        ), { timeout: 15_000 }).toBe(true)
      const before = await active.evaluate(`({
        route: sessionStorage.getItem('cordisx.standalone.manager.route.v1'),
        button: document.querySelector('[data-cordisx-page-header-action="create"]')?.outerHTML,
        visible: document.body.innerText.slice(0, 500),
      })`)
      await trustedClick(active, createButton)
      try {
        await expect.poll(() => exists('[data-channel-page=create]'), { timeout: 15_000 }).toBe(true)
      } catch {
        const visible = await active.evaluate('document.body.innerText.slice(0, 500)')
        const state = await active.evaluate(`(() => {
          const snapshot = globalThis.__cordisxRuntime?.snapshot()
          return {
            navigation: snapshot?.settingsNavigationItems?.map(item => ({ id: item.id, owner: item.owner })),
            plugins: snapshot?.plugins?.map(item => ({ id: item.id, status: item.status })),
          }
        })()`)
        const diagnostics = active.diagnostics.map(item => {
          const event = item as { method?: string; params?: { exceptionDetails?: { text?: string } } }
          const value = item as { params?: { args?: Array<{ value?: unknown; description?: string }> } }
          return {
            method: event.method,
            text: event.params?.exceptionDetails?.text,
            args: value.params?.args?.map(arg => String(arg.value ?? arg.description ?? '').slice(0, 200)),
          }
        })
        const route = await active.evaluate('sessionStorage.getItem("cordisx.standalone.manager.route.v1")')
        throw new Error(
          'Creation page did not mount: ' + JSON.stringify({ before, visible, state, route, diagnostics }),
        )
      }
      await set('[data-channel-page=create] input[type=text]', 'Created fixture')
      const submit = '[data-channel-page=create] button[type=submit]'
      await expect.poll(() => enabled(submit)).toBe(true)
      await trustedClick(active, submit)
      await expect.poll(() => exists('#channel-credential-appId input')).toBe(true)
      await set('#channel-credential-appId input', 'cli_created_fixture')
      await set('#channel-credential-tenantId input', 'fixture-tenant')
      await set('#channel-credential-secret input', 'synthetic-create-secret')
      await expect.poll(async () => {
        const action = await findDialogAction(active, 'capture')
        return !!action && !action.attributes?.includes('disabled')
      }, { timeout: 15_000 }).toBe(true)
      const capture = await findDialogAction(active, 'capture')
      if (!capture) throw new Error('Credential action disappeared')
      await clickDialogAction(active, capture)
      await expect.poll(async () => {
        const state = await readServiceConfigState({
          profileId: f.profileId,
          pluginId: 'channel',
          serviceId: 'runtime',
          initialConfig: {},
        }, f.configPath)
        return state.revision
      }, { timeout: 30_000 }).toBe(2)
      await expect.poll(() => active.evaluate('document.body.textContent.includes("Created fixture")'), {
        timeout: 20_000,
      }).toBe(true)
      expect(
        await active.evaluate(
          '(document.body.textContent + JSON.stringify(localStorage) + JSON.stringify(sessionStorage))'
            + '.includes("synthetic-create-secret")',
        ),
      ).toBe(false)
      await active.send('Page.reload')
      await expect.poll(() => active.evaluate('document.documentElement.dataset.cordisxReady'), { timeout: 60_000 })
        .toBe('true')
      await expect.poll(() => exists('[data-settings-navigation-item^=channel]'), { timeout: 15_000 }).toBe(true)
      await active.evaluate('document.querySelector("[data-settings-navigation-item^=channel]").click()')
      await expect.poll(() => active.evaluate('document.body.textContent.includes("Created fixture")'), {
        timeout: 20_000,
      }).toBe(true)
    } finally {
      await page?.close().catch(() => {})
      if (browser) await stopChrome(browser)
      await web?.close()
      await f.close()
    }
  },
  120_000,
)
