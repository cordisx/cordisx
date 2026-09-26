import { build } from 'esbuild'
import { type ChildProcess, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'

const executable = process.env.CHROME_PATH ?? process.env.RESTRICTED_CHROME_EXECUTABLE
it.skipIf(!executable)(
  'uses production Manager navigation and SchemaForm for connection creation across themes',
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'manager-connection-browser-'))
    const bundle = await build({
      entryPoints: ['tests/fixtures/manager-connection.tsx'],
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
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html')
      response.end(`<html data-theme="light"><head><style>body{margin:0;font:13px system-ui}*{box-sizing:border-box}
      .catalog-fixture-shell{height:100vh;display:grid;grid-template-rows:60px minmax(0,1fr);background:var(--cx-surface);color:var(--cx-text)}
      .catalog-fixture-shell>header{padding:14px 24px;border-bottom:1px solid var(--cx-border)}h1{margin:0;font-size:18px;letter-spacing:0}
      </style></head><body><div id="manager"></div><script>${bundle.outputFiles[0]!.text}</script></body></html>`)
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
      ], { stdio: 'ignore' })
      let port = 0
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0])
          break
        } catch {
          await new Promise(resolve => setTimeout(resolve, 50))
        }
      }
      expect(port).toBeGreaterThan(0)
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as {
        type: string
        webSocketDebuggerUrl: string
      }[]
      cdp = await CdpSession.connect(targets.find(target => target.type === 'page')!.webSocketDebuggerUrl)
      await cdp.send('Page.enable')
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` })
      const evaluate = async (expression: string) => {
        const result = await cdp!.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        expect(result.exceptionDetails).toBeUndefined()
        return (result.result as { value?: unknown }).value
      }
      const run = (code: string) => evaluate(`(async()=>{${code}})()`)
      await expect.poll(() => evaluate('typeof Fixture')).toBe('object')
      await run('window.disposeFixture=await Fixture.start()')
      const click = (selector: string) =>
        run(`document.querySelector(${JSON.stringify(selector)}).click();await Fixture.settle()`)
      const exists = (selector: string) => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)
      await click('[aria-label="添加模型连接"]')
      expect(await exists('[data-model-connection-create]')).toBe(true)
      expect(await exists('.cxmp-toolbar')).toBe(false)
      expect(await exists('[data-schema-form]')).toBe(true)
      expect(await exists('[data-config-path="protocol"]')).toBe(false)
      expect(await evaluate('document.querySelector(".cxr-heading").textContent')).toContain('添加模型连接')
      await click('.cxr-header [aria-label="返回"]')
      expect(await exists('.cxmp-toolbar')).toBe(true)
      await click('[aria-label="添加模型连接"]')
      await click('.cxmc-editor-actions button:first-child')
      expect(await exists('.cxmp-toolbar')).toBe(true)
      await click('[aria-label="添加模型连接"]')
      const disabled = () => evaluate('document.querySelector(".cxmc-editor-actions button:last-child").disabled')
      expect(await disabled()).toBe(true)
      await run(
        `await Fixture.type('title','Temporary connection browser fixture');await Fixture.type('endpoint','http://fixture.invalid')`,
      )
      expect(await disabled()).toBe(true)
      expect(await evaluate('document.querySelector("[role=status]").textContent')).toBeTruthy()
      await run(`await Fixture.type('endpoint','https://fixture.invalid/v1')`)
      expect(await disabled()).toBe(true)
      await click('[data-config-path="emptyConfirmed"] input')
      expect(await disabled()).toBe(false)
      await run(`await Fixture.addModel('Model-A','Alpha');await Fixture.addModel('Model-A','Duplicate')`)
      expect(await disabled()).toBe(true)
      await run(`await Fixture.deleteLastModel();await Fixture.addModel('model-a','Beta')`)
      expect(await disabled()).toBe(false)
      await run(`await Fixture.choose('source','仅自动结果')`)
      expect(await exists('[data-config-path="models"]')).toBe(false)
      expect(await exists('[data-config-path="discoveryEnabled"]')).toBe(true)
      await click('[data-config-path="discoveryEnabled"] [role=switch]')
      await run(`await Fixture.choose('source','自动结果与用户补充')`)
      expect(await exists('[data-config-path="discoveryEnabled"]')).toBe(true)
      await run(`await Fixture.choose('source','手动接管')`)
      expect(await exists('[data-config-path="models"]')).toBe(true)
      expect(await exists('[data-config-path="discoveryEnabled"]')).toBe(false)
      for (const [width, height] of [[1440, 1000], [800, 800], [390, 844]]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
        for (const theme of ['light', 'dark']) {
          await run(
            `document.documentElement.dataset.theme='${theme}';await Fixture.settle();await new Promise(resolve=>setTimeout(resolve,350))`,
          )
          expect(await evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true)
          expect(await evaluate('document.querySelector(".cxmc-editor-actions button:first-child").disabled')).toBe(
            false,
          )
          expect(await disabled()).toBe(false)
          if (process.env.CATALOG_SCREENSHOT_DIR) {
            const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
            await writeFile(
              join(process.env.CATALOG_SCREENSHOT_DIR, `connection-${width}-${theme}.png`),
              Buffer.from(shot.data as string, 'base64'),
            )
          }
        }
      }
      await click('.cxmc-editor-actions button:last-child')
      expect(await exists('.cxmp-toolbar')).toBe(true)
      const commands = await evaluate('Fixture.commands()') as {
        settings: {
          protocol: string
          strategy: { ids: string[] }
          models: { id: string; label: string }[]
          discoveryEnabled: boolean
        }
      }[]
      expect(commands).toHaveLength(1)
      expect(commands[0]!.settings.protocol).toBe('responses')
      expect(commands[0]!.settings.strategy.ids).toEqual(['Model-A', 'model-a'])
      expect(commands[0]!.settings.models).toEqual([{ id: 'Model-A', label: 'Alpha' }, {
        id: 'model-a',
        label: 'Beta',
      }])
      expect(commands[0]!.settings.discoveryEnabled).toBe(true)
      await run('await Fixture.showReadback()')
      expect(await evaluate('document.querySelector(".cxmp-results").textContent')).toContain(
        'Temporary connection browser fixture',
      )
      await run('disposeFixture()')
    } finally {
      cdp?.close()
      if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
        const exited = once(chrome, 'exit')
        chrome.kill('SIGTERM')
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))])
        if (chrome.exitCode === null && chrome.signalCode === null) {
          chrome.kill('SIGKILL')
          await exited
        }
      }
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  60_000,
)
