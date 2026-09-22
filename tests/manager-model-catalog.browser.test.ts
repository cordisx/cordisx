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
  'keeps catalog controls usable, scoped, focused and bounded across themes and viewports',
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'catalog-manager-browser-'))
    const bundle = await build({
      entryPoints: ['tests/fixtures/catalog-manager.tsx'],
      bundle: true,
      format: 'iife',
      globalName: 'Fixture',
      write: false,
      platform: 'browser',
      jsx: 'automatic',
      jsxImportSource: 'react',
      alias: { 'cordisx/react/jsx-runtime': 'react/jsx-runtime' },
      loader: { '.svg': 'dataurl', '.png': 'dataurl', '.css': 'text' },
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
      for (const [width, height] of [[1440, 900], [800, 600], [390, 844]]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
        for (const theme of ['light', 'dark']) {
          await run(`await Fixture.setTheme('${theme}')`)
          const geometry = await evaluate(
            `(() => {const nodes=[...document.querySelectorAll('.cxmp-toolbar,.cxmc-binding-header,.cxmc-models,.cxmc-row-actions')];return nodes.map(n=>{const r=n.getBoundingClientRect();return {width:r.width,left:r.left,right:r.right}})})()`,
          )
          for (const box of geometry as { width: number; left: number; right: number }[]) {
            expect(box.width).toBeGreaterThan(0)
            expect(box.left).toBeGreaterThanOrEqual(0)
            expect(box.right).toBeLessThanOrEqual(width! + 1)
          }
          expect(await evaluate('document.querySelectorAll("select").length')).toBe(0)
          if (process.env.CATALOG_SCREENSHOT_DIR) {
            const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' })
            await writeFile(
              join(process.env.CATALOG_SCREENSHOT_DIR, `catalog-${width}-${theme}.png`),
              Buffer.from(screenshot.data as string, 'base64'),
            )
          }
        }
      }
      await run(
        `window.pin=document.querySelector('[aria-label="Pin model: Model-A"]');pin.focus();await Fixture.refreshState('error')`,
      )
      expect(await evaluate('document.activeElement===pin')).toBe(true)
      await run(`document.querySelector('[aria-label="Block model: Model-A"]').click();await Fixture.settle()`)
      expect(await evaluate('Fixture.commands()[0]')).toMatchObject({
        operation: 'setOverlay',
        modelId: 'Model-A',
        bindingRef: 'binding-a',
      })
      await run(
        `await Fixture.refreshState('slow');document.querySelector('[data-binding-ref="binding-b"] [aria-label^="Pin model"]').click();await Fixture.settle()`,
      )
      expect(await evaluate('Fixture.commands()[1].bindingRef')).toBe('binding-b')
      await run(
        `await Fixture.refreshState('restore');document.querySelector('[aria-label="More catalog actions: Provider A"]').click();await Fixture.settle();[...document.querySelectorAll('.t-dropdown__item')].find(n=>n.textContent==='Configure model script').click();await Fixture.settle()`,
      )
      for (const [width, height] of [[1440, 900], [390, 844]]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
        await run(
          `document.querySelector('[aria-label="Add argument"]').click();document.querySelector('[aria-label="Add environment variable"]').click();await Fixture.settle()`,
        )
        const geometry = await evaluate(
          `Array.from(document.querySelectorAll('.cxmc-editor input,.cxmc-editor button,.cxmc-environment')).map(n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width}})`,
        )
        for (const box of geometry as { left: number; right: number; width: number }[]) {
          expect(box.width).toBeGreaterThan(0)
          expect(box.left).toBeGreaterThanOrEqual(0)
          expect(box.right).toBeLessThanOrEqual(width! + 1)
        }
        if (process.env.CATALOG_SCREENSHOT_DIR) {
          const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' })
          await writeFile(
            join(process.env.CATALOG_SCREENSHOT_DIR, `catalog-script-${width}.png`),
            Buffer.from(screenshot.data as string, 'base64'),
          )
        }
      }
      await run(`document.querySelector('.cxmc-editor-actions button').click();await Fixture.settle()`)
      await run(`await Fixture.refreshState('empty')`)
      expect(await evaluate('!!document.querySelector(".cxmp-toolbar input")')).toBe(true)
      expect(await evaluate('document.querySelectorAll("[data-present=false]").length')).toBe(2)
      await run(`await Fixture.setLocale('zh-CN')`)
      expect(await evaluate('document.querySelector("h1").textContent')).toBe('模型服务')
      await run('disposeFixture()')
      expect(await evaluate('document.querySelectorAll("[data-binding-ref]").length')).toBe(0)
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
