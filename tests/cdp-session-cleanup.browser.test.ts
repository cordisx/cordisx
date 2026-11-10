import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { install } from '../packages/cli/src/launcher/cdp-installation.js'
import { uninstall } from '../packages/cli/src/launcher/cdp-installation-support.js'
import { CdpSession, type CdpTarget } from '../packages/cli/src/launcher/cdp-session.js'
import { createNativeSubmissionCdpAuthority } from '../packages/cli/src/launcher/native-submission-cdp-channel.js'
import { waitForChromeDebugPort } from './fixtures/chrome-debug-port.js'
import { stopChrome } from './fixtures/native-browser-cdp.js'

const executable = process.env.CHROME_PATH ?? process.env.RESTRICTED_CHROME_EXECUTABLE

// Real Chromium drops future scripts when their CDP session closes; a WebSocket mock cannot prove this.
it.skipIf(!executable)('cleans a disconnected channel when Chromium already removed its future scripts', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'cordisx-disconnected-cleanup-'))
  const server = createServer((_request, response) => response.end('<title>Codex</title>'))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const chrome = spawn(executable!, [
    '--headless=new',
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
  ], { stdio: 'ignore' })
  let session: CdpSession | undefined
  let replacement: CdpSession | undefined
  try {
    const port = await waitForChromeDebugPort(
      chrome,
      () => readFile(join(profile, 'DevToolsActivePort'), 'utf8'),
      () => 'isolated headless Chrome',
    )
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as CdpTarget[]
    const target = targets.find(target => target.type === 'page')!
    const installed = await install(target, 'globalThis.__cordisxFixture=true')
    session = installed.session
    const authority = createNativeSubmissionCdpAuthority({
      submissionAvailable: false,
      catalog: async () => [],
      isThreadIdle: async () => true,
    })
    const nativeTarget = { ...target, url: 'app://-/index.html' }
    const nativeChannel = await authority.install(session, nativeTarget)
    session.close()
    await expect(uninstall({ ...installed, nativeChannel, loopbackModules: true })).resolves.toBeUndefined()
    replacement = await session.reconnectForCleanup(target.id)
    const disposed = await replacement.send('Runtime.evaluate', {
      expression: 'typeof globalThis.__cordisxNativeProviderCommandChannel',
      returnByValue: true,
    })
    expect(disposed.result).toMatchObject({ value: 'undefined' })
    const newChannel = await authority.install(replacement, nativeTarget)
    const restored = await replacement.send('Runtime.evaluate', {
      expression: 'globalThis.__cordisxNativeProviderCommandChannel.catalogSnapshotRead()',
      awaitPromise: true,
      returnByValue: true,
    })
    expect(restored.exceptionDetails).toBeUndefined()
    expect(restored.result).toMatchObject({ value: { providers: [] } })
    await newChannel.dispose()
  } finally {
    session?.close()
    replacement?.close()
    await stopChrome(chrome)
    server.close()
    await once(server, 'close')
    await rm(profile, { recursive: true, force: true })
  }
})
