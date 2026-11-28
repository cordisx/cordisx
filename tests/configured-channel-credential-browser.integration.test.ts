import { type ChildProcess, execFile } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { readServiceConfigState } from '../packages/cli/src/config/service-config.js'
import { dispatchManagerRendererOperation } from '../packages/cli/src/cli/manager-renderer-rpc.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'
import { CdpClient, stopChrome } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'

const archive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE
const managerPackage = process.env.CORDISX_MANAGER_PACKAGE_FIXTURE
const exec = promisify(execFile)
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

it.skipIf(!archive || !managerPackage || !chrome || process.platform !== 'darwin' && process.platform !== 'linux').each(
  [
    'local',
    'https',
  ] as const,
)(
  'saves a private credential through the actual Manager form and owner handoff over %s',
  async mode => {
    if (!path.isAbsolute(managerPackage!)) throw new Error('fixture package must be absolute')
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
    let ingress:
      | Awaited<
        ReturnType<typeof import('../packages/cli/src/cli/manager-public-ingress.js')['startManagerPublicIngress']>
      >
      | undefined
    try {
      expect(await f.sessions.close(f.invocation)).toBe(true)
      const manager = await import(
        pathToFileURL(path.join(managerPackage!, 'dist/src/cli/manager-web.js')).href
      ) as typeof import('../packages/cli/src/cli/manager-web.js')
      let publicOrigin: string | undefined
      let listener: { host: string; port: number; tls: { certificate: Buffer; privateKey: Buffer } } | undefined
      const browserArguments: string[] = []
      if (mode === 'https') {
        const certificateFile = path.join(f.root, 'certificate.pem')
        const privateKeyFile = path.join(f.root, 'key.pem')
        await exec('openssl', [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '1',
          '-subj',
          '/CN=127.0.0.1',
          '-keyout',
          privateKeyFile,
          '-out',
          certificateFile,
        ], { timeout: 15_000 })
        const certificate = await readFile(certificateFile)
        const privateKey = await readFile(privateKeyFile)
        const publicKey = new X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' })
        browserArguments.push(
          '--ignore-certificate-errors-spki-list=' + createHash('sha256').update(publicKey).digest('base64'),
        )
        const reservation = createServer()
        await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
        const address = reservation.address()
        if (!address || typeof address === 'string') throw new Error('fixture port unavailable')
        const port = address.port
        await new Promise<void>(resolve => reservation.close(() => resolve()))
        publicOrigin = 'https://127.0.0.1:' + port
        listener = { host: '127.0.0.1', port, tls: { certificate, privateKey } }
      }
      web = await manager.startManagerWeb({
        appId: 'codex',
        profileId: f.profileId,
        generation: f.generation,
        isCurrent: async () => true,
        request: async operation =>
          operation.kind === 'manager-renderer'
            ? await dispatchManagerRendererOperation(f.sessions, operation)
            : { status: 'unavailable' },
      }, { rendererGateway: f.gateway, ...(publicOrigin === undefined ? {} : { publicOrigin }) })
      if (listener && publicOrigin) {
        const network = await import(
          pathToFileURL(path.join(managerPackage!, 'dist/src/cli/manager-public-ingress.js')).href
        ) as typeof import('../packages/cli/src/cli/manager-public-ingress.js')
        ingress = await network.startManagerPublicIngress({
          manager: { publicOrigin, localOrigin: web.localOrigin },
          listeners: [listener],
        })
      }
      const url = new URL(web.url)
      url.searchParams.set('host', '1')
      const launched = launchChrome(chrome!, path.join(f.root, 'browser'), browserArguments)
      browser = launched.browser
      page = await CdpClient.connect(await waitForChromeTarget(path.join(f.root, 'browser'), browser, launched.stderr))
      await page.send('Runtime.enable')
      await page.send('Page.enable')
      await page.send('Page.navigate', { url: url.href })
      const active = page
      const openConnection = async () => {
        await expect.poll(() => active.evaluate('document.documentElement.dataset.cordisxReady'), { timeout: 60_000 })
          .toBe('true')
        await expect.poll(() => active.evaluate('document.documentElement.dataset.cordisxManagerReady'), {
          timeout: 60_000,
        }).toBe('true')
        await expect.poll(() =>
          active.evaluate(
            'Boolean(document.querySelector("[data-settings-navigation-item^=channel]"))',
          ), { timeout: 15_000 }).toBe(true)
        await active.evaluate('document.querySelector("[data-settings-navigation-item^=channel]").click()')
        await expect.poll(() =>
          active.evaluate(`(() => {
          const row = [...document.querySelectorAll('[data-manager-collection-item]')].find(item =>
            ['Feishu', '飞书', 'cli_fixture'].some(label => item.textContent.includes(label)))
          const button = row?.querySelector('.cxr-manager-collection-open')
          if (!button) return false
          button.click()
          return true
        })()`), { timeout: 15_000 }).toBe(true)
        await expect.poll(
          () => active.evaluate('Boolean(document.querySelector("#channel-credential-secret input"))'),
          { timeout: 15_000 },
        ).toBe(true)
      }
      await openConnection()
      await active.evaluate(`(() => {
        const set = (selector, value) => {
          const input = document.querySelector(selector)
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new Event('change', { bubbles: true }))
        }
        set('#channel-credential-secret input', 'synthetic-fixture-value')
        set('#channel-connection-displayName input', 'Updated fixture')
      })()`)
      await expect.poll(() =>
        active.evaluate(`(() => {
        const button = [...document.querySelectorAll('[data-channel-connection-form] button')].find(item =>
          ['Save', '保存'].includes(item.textContent.trim()))
        if (!button || button.disabled) return false
        button.click()
        return true
      })()`)
      ).toBe(true)
      await expect.poll(async () => {
        const state = await readServiceConfigState({
          profileId: f.profileId,
          pluginId: 'channel',
          serviceId: 'runtime',
          initialConfig: {},
        }, f.configPath)
        return state.revision
      }, { timeout: 30_000 }).toBe(2)
      await expect.poll(() => active.evaluate('document.querySelector("#channel-credential-secret input")?.value'), {
        timeout: 15_000,
      }).toBe('')
      expect([...f.credentialValues.values()].some(value => value === 'synthetic-fixture-value')).toBe(true)
      expect(
        await active.evaluate(`(() => {
        const text = document.body.textContent + JSON.stringify(localStorage) + JSON.stringify(sessionStorage)
        return text.includes('synthetic-fixture-value') || text.includes('fixture-private-reference')
      })()`),
      ).toBe(false)
      await active.send('Page.reload')
      await openConnection()
      expect(await active.evaluate('document.querySelector("#channel-credential-secret input").value')).toBe('')
      expect(await active.evaluate('document.querySelector("#channel-connection-displayName input").value'))
        .toBe('Updated fixture')
      f.setCredentialCommitUnknown(true)
      await active.evaluate(`(() => {
        const input = document.querySelector('#channel-credential-secret input')
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'synthetic-second-value')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })()`)
      await expect.poll(() =>
        active.evaluate(`(() => {
        const button = [...document.querySelectorAll('[data-channel-connection-form] button')].find(item =>
          ['Save', '保存'].includes(item.textContent.trim()))
        if (!button || button.disabled) return false
        button.click()
        return true
      })()`)
      ).toBe(true)
      await expect.poll(() => active.evaluate('document.querySelector("p[role=status]")?.textContent'), {
        timeout: 30_000,
      }).toContain('操作结果未确认')
      const uncertain = await readServiceConfigState({
        profileId: f.profileId,
        pluginId: 'channel',
        serviceId: 'runtime',
        initialConfig: {},
      }, f.configPath)
      expect(uncertain).toMatchObject({ revision: 3, lastGoodRevision: 3 })
      expect([...f.credentialValues.values()].some(value => value === 'synthetic-second-value')).toBe(true)
    } finally {
      const failures: unknown[] = []
      const cleanup = async (action: () => Promise<void>) => {
        try {
          await action()
        } catch (error) {
          failures.push(error)
        }
      }
      await cleanup(async () => await page?.close())
      await cleanup(async () => {
        if (browser) await stopChrome(browser)
      })
      await cleanup(async () => await ingress?.close())
      await cleanup(async () => await web?.close())
      await cleanup(async () => await f.close({ preserveRoot: failures.length > 0 }))
      if (failures.length) throw new AggregateError(failures, 'Channel browser fixture cleanup failed')
    }
  },
  120_000,
)
