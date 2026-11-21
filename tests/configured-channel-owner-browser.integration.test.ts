import { accessSync, constants } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { expect, it } from 'vitest'
import { createManagerRendererGraphSession } from '../packages/cli/src/cli/manager-renderer-graph-session.js'
import { decodeManagerRendererBundle } from '../packages/cli/src/cli/manager-renderer-bundle-codec.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'
import { CdpClient, stopChrome } from './fixtures/native-browser-cdp.js'
import { launchChrome, waitForChromeTarget } from './fixtures/native-browser-launch.js'

const archive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE
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

it.skipIf(!archive || !chrome || process.platform !== 'darwin' && process.platform !== 'linux').each([
  'none',
  'other-source',
  'owner',
])(
  'renders the owner-selected Channel with %s UI authorization in an isolated browser',
  async grant => {
    const f = await fixture({
      channelArchive: archive!,
      channelUiGrant: grant !== 'none',
      channelGrantOtherSource: grant === 'other-source',
      protectProfileInputs: true,
    })
    const profile = await mkdtemp(path.join(os.tmpdir(), 'cx-configured-channel-browser-'))
    let graphSession: ReturnType<typeof createManagerRendererGraphSession> | undefined
    let bundle: Buffer | undefined
    let live = true
    let snapshots = 0
    const server = createServer((request, response) => {
      void (async () => {
        const target = request.url ?? ''
        if (target === '/host') {
          response.setHeader('content-type', 'text/html')
          response.setHeader(
            'content-security-policy',
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
          )
          return response.end(
            '<!doctype html><html lang="en"><body><script type="module" src="/host-entry.js"></script></body></html>',
          )
        }
        if (target === '/host.js') {
          response.setHeader('content-type', 'text/javascript')
          return response.end(bundle)
        }
        if (target === '/host-entry.js') {
          response.setHeader('content-type', 'text/javascript')
          return response.end([
            "import { startStandaloneManagerComposition } from '/host.js';",
            'globalThis.__cordisxChannelActionsRequestV1 = value => {',
            "  void fetch('/channel-actions', { method: 'POST', body: value }).then(response => response.json())",
            '    .then(result => globalThis.__cordisxChannelActionsReceiveV1(JSON.stringify(result)));',
            '};',
            'await startStandaloneManagerComposition(new AbortController().signal);',
          ].join('\n'))
        }
        if (target === '/manager-host.css') {
          response.setHeader('content-type', 'text/css')
          return response.end('')
        }
        if (target === '/channel-actions' && request.method === 'POST') {
          let payload = ''
          for await (const chunk of request) payload += String(chunk)
          snapshots++
          const result = await f.sessions.call(f.invocation, 'channel-actions', payload)
          response.setHeader('content-type', 'application/json')
          const requestId = (JSON.parse(payload) as { requestId: string }).requestId
          return response.end(JSON.stringify(
            result.status === 'ok'
              ? result.value
              : { requestId, ok: false, code: 'CHANNEL_OWNER_UNAVAILABLE' },
          ))
        }
        if (target.startsWith('/api/renderer/graphs/')) {
          const result = await graphSession!.resolve({ method: request.method ?? '', target })
          response.writeHead(result.status, result.headers)
          return response.end(result.body)
        }
        response.statusCode = 404
        response.end()
      })().catch(() => response.destroy())
    })
    let browser: ChildProcess | undefined
    let cdp: CdpClient | undefined
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
      const prepared = await f.call({ action: 'prepare' }) as any
      expect(prepared).toMatchObject({ status: 'ok', value: { status: 'ok' } })
      graphSession = createManagerRendererGraphSession({
        managerOrigin: origin,
        profileId: f.profileId,
        generation: f.generation,
        rendererId: f.handle.rendererId,
        isCurrent: () => live,
        forbiddenSecrets: [f.gateway.instanceToken, f.invocation.browserSessionId, f.handle.grant],
      })
      const graphs = graphSession.projectInitial(prepared.value.privateGraphs)
      const completed = await f.call({ action: 'complete', managerOrigin: origin, graphs }) as any
      expect(completed).toMatchObject({ status: 'ok', value: { status: 'ok' } })
      bundle = await decodeManagerRendererBundle(completed.value.bundle)
      expect(bundle.includes(Buffer.from('fixture-private-reference'))).toBe(false)
      expect(bundle.includes(Buffer.from(f.configuredChannel!.plugin.source!))).toBe(false)
      // This fixture acknowledges the owner command directly; the production
      // sidecar handshake is exercised separately by the real-browser suite.
      const polling = f.sessions.poll(f.invocation, 3000)
      const admitting = f.sessions.admit(f.invocation)
      const command = (await polling as any).value.command
      expect(command.method).toBe('synchronize')
      expect(
        await f.sessions.acknowledge(f.invocation, {
          id: command.id,
          sequence: command.sequence,
          ok: true,
          value: { active: command.payload.active, registryEpoch: command.payload.registryEpoch },
        }),
      ).toEqual({ status: 'ok', value: { accepted: true } })
      expect(await admitting).toEqual({ status: 'ok', value: { admitted: true } })
      const launched = launchChrome(chrome!, profile)
      browser = launched.browser
      cdp = await CdpClient.connect(await waitForChromeTarget(profile, browser, launched.stderr))
      await cdp.send('Page.enable')
      await cdp.send('Page.navigate', { url: origin + '/host' })
      await expect.poll(() => cdp!.evaluate('document.documentElement.dataset.cordisxReady'), { timeout: 20_000 })
        .toBe('true')
      await expect.poll(() =>
        cdp!.evaluate(
          'Boolean(document.querySelector("[data-settings-navigation-item^=channel]"))',
        )
      ).toBe(true)
      await cdp.evaluate('document.querySelector("[data-settings-navigation-item^=channel]").click()')
      if (grant !== 'owner') {
        await expect.poll(() => cdp!.evaluate('document.body.textContent.includes("Review permissions")')).toBe(true)
        expect(await cdp.evaluate('Boolean(document.querySelector("[data-manager-collection-item]"))')).toBe(false)
        await expect.poll(() =>
          cdp!.evaluate(
            'document.querySelector(".t-select input")?.disabled === true',
          )
        ).toBe(true)
        expect(await cdp.evaluate('document.body.textContent.includes("Permissions are read-only here.")'))
          .toBe(true)
      } else {
        await expect.poll(() => cdp!.evaluate('Boolean(document.querySelector("[data-manager-collection-item]"))'))
          .toBe(true)
        expect(await cdp.evaluate('document.body.textContent.includes("Simulator")')).toBe(true)
        expect(await cdp.evaluate('document.body.textContent.includes("fixture-private-reference")')).toBe(false)
        expect(await cdp.evaluate('document.querySelectorAll("[data-manager-page-header-actions] button").length'))
          .toBe(0)
        await expect.poll(() => snapshots).toBeGreaterThan(0)
        await cdp.evaluate(
          'document.querySelector("[data-manager-collection-item] .cxr-manager-collection-open").click()',
        )
        await expect.poll(() => cdp!.evaluate('Boolean(document.querySelector("[data-channel-page=detail]"))'))
          .toBe(true)
        expect(await cdp.evaluate('document.body.textContent.includes("Connected")')).toBe(true)
        expect(await cdp.evaluate('document.querySelectorAll("[data-manager-content-tab]").length')).toBe(1)
      }
    } finally {
      live = false
      await cdp?.close()
      if (browser) await stopChrome(browser)
      graphSession?.close()
      bundle?.fill(0)
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await f.close()
      await rm(profile, { recursive: true, force: true })
    }
  },
  90_000,
)
