import { build } from 'esbuild'
import { type ChildProcess, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'
import { waitForChromeDebugPort } from './fixtures/chrome-debug-port.js'

const executable = process.env.CHROME_PATH ?? process.env.RESTRICTED_CHROME_EXECUTABLE
it.skipIf(!executable)(
  'keeps an actual iframe document and draft loaded once through Manager split recapture and sidebar folding',
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'manager-iframe-continuity-'))
    const bundle = await build({
      entryPoints: ['tests/fixtures/manager-iframe-continuity.tsx'],
      bundle: true,
      format: 'iife',
      globalName: 'Fixture',
      write: false,
      platform: 'browser',
      jsx: 'automatic',
      jsxImportSource: 'react',
      alias: { 'cordisx/react/jsx-runtime': 'react/jsx-runtime' },
      minify: true,
      define: { 'process.env.NODE_ENV': '"production"' },
      loader: { '.svg': 'text', '.png': 'dataurl', '.css': 'text' },
    })
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html')
      response.end(
        request.url === '/embedded'
          ? '<html><body><input value="initial draft"></body></html>'
          : `<html><body><div id="root"></div><script>${bundle.outputFiles[0]!.text}</script></body></html>`,
      )
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    let chrome: ChildProcess | undefined
    let cdp: CdpSession | undefined
    try {
      chrome = spawn(executable!, [
        '--headless=new',
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        `--user-data-dir=${profile}`,
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        'about:blank',
      ], { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      chrome.stderr?.on('data', data => {
        stderr = (stderr + String(data)).slice(-4096)
      })
      const port = await waitForChromeDebugPort(
        chrome,
        () => readFile(join(profile, 'DevToolsActivePort'), 'utf8'),
        () => stderr,
        10_000,
      )
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as {
        type: string
        webSocketDebuggerUrl: string
      }[]
      cdp = await CdpSession.connect(targets.find(target => target.type === 'page')!.webSocketDebuggerUrl)
      await cdp.send('Page.enable')
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` })
      const evaluate = async (expression: string) => {
        const result = await cdp!.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        expect(result.exceptionDetails, JSON.stringify(result.exceptionDetails)).toBeUndefined()
        return (result.result as { value?: unknown }).value
      }
      await expect.poll(() => evaluate('typeof Fixture')).toBe('object')
      await evaluate('Fixture.start()')
      for (
        const operation of ['Fixture.replaceRightTab()', 'Fixture.toggleSidebar(false)', 'Fixture.toggleSidebar(true)']
      ) {
        await evaluate(`(async()=>{${operation};await Fixture.settle()})()`)
        const state = await evaluate('Fixture.state()') as {
          open: boolean
          loads: number
          sameDocument: boolean
          draft: string
          sidebarHidden: boolean
          sidebarDisplay: string
        }
        expect(state.open, operation).toBe(true)
        expect(state.loads, operation).toBe(1)
        expect(state.sameDocument, operation).toBe(true)
        expect(state.draft, operation).toBe('retained iframe draft')
        expect(state.sidebarHidden, operation).toBe(operation.includes('(false)'))
        expect(state.sidebarDisplay === 'none', operation).toBe(operation.includes('(false)'))
      }
      await evaluate('Fixture.stop()')
    } finally {
      cdp?.close()
      if (chrome !== undefined && chrome.exitCode === null && chrome.signalCode === null) {
        const exit = once(chrome, 'exit')
        chrome.kill('SIGTERM')
        await exit
      }
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(profile, { recursive: true, force: true })
    }
  },
)
