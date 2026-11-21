import { accessSync, constants } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { expect, it } from 'vitest'
import { startManagerResourceFixture } from './fixtures/manager-resource-auth-browser.js'
import { CdpClient, stopChrome } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'

function chromeExecutable(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ...(process.env.PATH ?? '').split(path.delimiter).flatMap(directory =>
      ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'].map(name => path.join(directory, name))
    ),
  ]
  return candidates.find(candidate => {
    if (candidate === undefined || !path.isAbsolute(candidate)) return false
    try {
      accessSync(candidate, constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

const chrome = chromeExecutable()

it.skipIf(chrome === undefined)(
  'authorizes native module graphs per tab, fences revocation and fails closed across worker restart',
  async () => {
    const fixture = await startManagerResourceFixture()
    const profile = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-resource-browser-'))
    let browser: ChildProcess | undefined
    const clients: CdpClient[] = []
    try {
      const launched = launchChrome(chrome!, profile)
      browser = launched.browser
      const socketUrl = await waitForChromeTarget(profile, browser, launched.stderr)
      const first = await CdpClient.connect(socketUrl)
      clients.push(first)
      await first.send('Page.enable')
      await first.send('Page.navigate', { url: fixture.origin })
      await expect.poll(() => first.evaluate('typeof window.fixture === "object"')).toBe(true)
      expect(await first.evaluate("window.fixture.bind('a'.repeat(64))")).toBe(true)
      expect(await first.evaluate('window.fixture.isBound()')).toBe(true)
      const result = await first.evaluate(`window.fixture.render(${JSON.stringify(fixture.graphA.baseUrl)})`)
      expect(result).toEqual({ module: 'module:nested', css: true, image: true })
      await expect.poll(() => fixture.events.some(event => event.path.endsWith('/font.woff2') && event.accepted))
        .toBe(true)
      expect(await first.evaluate('window.fixture.bundle()')).toBe('bundle:A')
      expect(await first.evaluate("window.fixture.read('/api/renderer/bundle.js?unexpected=1')"))
        .toMatchObject({ status: 403 })
      const malformed = JSON.stringify(fixture.graphA.baseUrl + '%2e%2e%2fmodule.js')
      expect(await first.evaluate(`window.fixture.read(${malformed})`)).toMatchObject({ status: 403 })
      expect(await first.evaluate("window.fixture.read('/outside')")).toMatchObject({ status: 200, text: 'outside' })
      expect(fixture.events.find(event => event.path === '/outside')).toMatchObject({ label: '', accepted: false })

      const debugOrigin = `http://${new URL(socketUrl).host}`
      const createTab = async () => {
        const response = await fetch(`${debugOrigin}/json/new?${encodeURIComponent(fixture.origin)}`, { method: 'PUT' })
        if (!response.ok) throw new Error('isolated Chrome could not open its test tab')
        const item = await response.json() as { webSocketDebuggerUrl: string }
        const tab = await CdpClient.connect(item.webSocketDebuggerUrl)
        clients.push(tab)
        await expect.poll(() => tab.evaluate('typeof window.fixture === "object"')).toBe(true)
        return tab
      }
      const second = await createTab()
      const graphAEntry = JSON.stringify(fixture.graphA.entryUrl)
      const graphBEntry = JSON.stringify(fixture.graphB.entryUrl)
      expect(await second.evaluate(`window.fixture.read(${graphAEntry})`)).toMatchObject({ status: 403 })
      expect(await second.evaluate("window.fixture.bind('b'.repeat(64))")).toBe(true)
      expect(await second.evaluate(`window.fixture.read(${graphAEntry})`)).toMatchObject({ status: 404 })
      expect(await second.evaluate(`window.fixture.read(${graphBEntry})`)).toMatchObject({ status: 200 })
      expect(await second.evaluate('window.fixture.bundle()')).toBe('bundle:B')
      expect((await fetch(fixture.graphA.entryUrl)).status).toBe(401)

      const third = await createTab()
      const race = await third.evaluate<{ first: { ok: boolean }; revoked: { ok: boolean }; late: { ok: boolean } }>(
        `(async () => {
          const bind = { version: 1, kind: 'bind', token: 'b'.repeat(64), sequence: 10 };
          const first = await window.fixture.rawMessage(bind);
          const revoked = await window.fixture.rawMessage({ version: 1, kind: 'unbind', sequence: 11 });
          const late = await window.fixture.rawMessage(bind);
          return { first, revoked, late };
        })()`,
      )
      expect(race).toEqual({
        first: { version: 1, ok: true },
        revoked: { version: 1, ok: true },
        late: { version: 1, ok: false },
      })
      expect(await third.evaluate(`window.fixture.read(${graphBEntry})`)).toMatchObject({ status: 403 })

      await first.send('ServiceWorker.enable')
      await first.send('ServiceWorker.stopAllWorkers')
      expect(await second.evaluate('window.fixture.isBound()')).toBe(false)
      expect(await second.evaluate(`window.fixture.read(${graphBEntry})`)).toMatchObject({ status: 403 })
      expect(await second.evaluate('window.fixture.recover()')).toBe(true)
      expect(await second.evaluate('window.fixture.isBound()')).toBe(true)
      expect(await second.evaluate(`window.fixture.read(${graphBEntry})`)).toMatchObject({ status: 200 })
      expect(await first.evaluate('window.fixture.recover()')).toBe(true)

      fixture.slow()
      const slowUrl = JSON.stringify(new URL('chunk.js', fixture.graphB.baseUrl).href)
      const count = fixture.events.length
      await second.evaluate(`(window.slowResult = window.fixture.read(${slowUrl}), true)`)
      await expect.poll(() =>
        fixture.events.slice(count).some(event => event.label === 'B' && event.path.endsWith('/chunk.js'))
      )
        .toBe(true)
      expect(await second.evaluate('window.fixture.isBound()')).toBe(true)
      expect(await second.evaluate('window.slowResult')).toMatchObject({ status: 200 })
      const nextCount = fixture.events.length
      await second.evaluate(`(window.slowResult = window.fixture.read(${slowUrl}), true)`)
      await expect.poll(() =>
        fixture.events.slice(nextCount).some(event => event.label === 'B' && event.path.endsWith('/chunk.js'))
      )
        .toBe(true)
      expect(await second.evaluate('window.fixture.revoke()')).toBe(true)
      expect(await second.evaluate('window.slowResult')).toEqual({ status: 403, text: '' })
      fixture.revoke('A')
      const graphAChunk = JSON.stringify(new URL('chunk.js', fixture.graphA.baseUrl).href)
      expect(await first.evaluate(`window.fixture.read(${graphAChunk})`)).toMatchObject({ status: 401 })
      expect(await first.evaluate('window.fixture.recover()')).toBe(false)
      // Revocation prevents new fetches; it cannot erase JavaScript already executed in the tab.
      expect(await first.evaluate(`import(${graphAEntry}).then(value => value.result)`)).toBe('module:nested')
    } finally {
      await Promise.allSettled(clients.map(async client => await client.close()))
      if (browser !== undefined) await stopChrome(browser)
      await fixture.close()
      await rm(profile, { recursive: true, force: true })
    }
  },
  45_000,
)
