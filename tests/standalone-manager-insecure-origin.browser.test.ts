import type { ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import path from 'node:path'
import { expect, it } from 'vitest'
import { startManagerWeb } from '../packages/cli/src/cli/manager-web.js'
import { CdpClient, stopChrome } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'

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

it.skipIf(chrome === undefined)(
  'explains insecure HTTP without consuming the one-time entry in a real browser',
  async () => {
    const publicOrigin = 'http://manager.example.test:28471'
    let web: Awaited<ReturnType<typeof startManagerWeb>> | undefined
    let profile: string | undefined
    let browser: ChildProcess | undefined
    let page: CdpClient | undefined
    try {
      web = await startManagerWeb({
        appId: 'codex',
        profileId: 'work',
        generation: 'owner-1',
        isCurrent: async () => true,
        request: async () => ({ status: 'unavailable' }),
      }, { publicOrigin })
      profile = await mkdtemp('/tmp/cx-insecure-manager-')
      const localPort = new URL(web.localOrigin).port
      const launched = launchChrome(chrome!, profile, [
        '--no-proxy-server',
        '--host-resolver-rules=MAP manager.example.test:28471 127.0.0.1:' + localPort,
      ])
      browser = launched.browser
      page = await CdpClient.connect(await waitForChromeTarget(profile, browser, launched.stderr))
      await page.send('Page.enable')
      const entry = new URL(web.url)
      entry.search = '?host=1'
      await page.send('Page.navigate', { url: entry.href })
      await expect.poll(
        () => page!.evaluate('document.querySelector("[data-cordisx-manager-startup] [role=status]")?.textContent'),
        { timeout: 15_000 },
      ).toContain('HTTPS')
      expect(await page.evaluate('isSecureContext')).toBe(false)
      expect(await page.evaluate('Boolean(navigator.serviceWorker)')).toBe(false)
      expect(await page.evaluate('location.hash')).toBe(entry.hash)
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const outgoing = request(web!.localOrigin + '/api/session', {
          method: 'POST',
          headers: { host: entry.host, origin: publicOrigin, 'content-type': 'application/json' },
        }, response => {
          response.resume()
          response.on('end', () => resolve(response.statusCode))
          response.on('error', reject)
        })
        outgoing.on('error', reject).end(JSON.stringify({ token: entry.hash.slice(1) }))
      })
      expect(status).toBe(200)
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
      await cleanup(async () => await web?.close())
      await cleanup(async () => {
        if (profile) await rm(profile, { recursive: true, force: true })
      })
      if (failures.length) throw new AggregateError(failures, 'browser test cleanup failed')
    }
  },
  45_000,
)
