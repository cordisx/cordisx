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
  'uses production Manager navigation and SchemaForm for Marketplace source creation across themes',
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'manager-connection-browser-'))
    const bundle = await build({
      entryPoints: ['tests/fixtures/manager-marketplace-source.tsx'],
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
      await click('[aria-label="管理来源"]')
      await click('[aria-label="添加来源"]')
      expect(await exists('[data-marketplace-source-editor]')).toBe(true)
      expect(await exists('dialog[open],.t-dialog')).toBe(false)
      expect(await evaluate('document.querySelector(".cxr-heading").textContent')).toContain('插件来源')
      const disabled = () => evaluate('document.querySelector(".cxf-form-action-buttons button:last-child").disabled')
      expect(await disabled()).toBe(true)
      await run(
        "await Fixture.type('url','https://fixture.example/marketplace.json');await Fixture.type('name','Fixture source');await Fixture.type('description','Local description')",
      )
      expect(await disabled()).toBe(false)
      for (const theme of ['light', 'dark']) {
        await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)};await Fixture.settle()`)
        for (const width of [1200, 700]) {
          await cdp.send('Emulation.setDeviceMetricsOverride', {
            width,
            height: 650,
            deviceScaleFactor: 1,
            mobile: false,
          })
          await run('await Fixture.settle()')
          expect(
            await evaluate(
              `(()=>{const footer=document.querySelector('.cxf-form-action-buttons').getBoundingClientRect();const content=document.querySelector('.cxr-content').getBoundingClientRect();return footer.bottom<=content.bottom&&content.bottom-footer.bottom<45})()`,
            ),
          ).toBe(true)
        }
      }
      if (process.env.SOURCE_SCREENSHOT_DIR) {
        const capture = await cdp.send('Page.captureScreenshot', { format: 'png' })
        await writeFile(
          join(process.env.SOURCE_SCREENSHOT_DIR, 'marketplace-source-page.png'),
          Buffer.from(capture.data as string, 'base64'),
        )
      }
      await click('.cxf-form-action-buttons button:last-child')
      expect(await evaluate('document.querySelector("[data-marketplace-source-error]").textContent')).toContain(
        'Fixture save failed',
      )
      expect(await evaluate('document.querySelector("[data-config-path=url] input").value')).toBe(
        'https://fixture.example/marketplace.json',
      )
      await click('.cxf-form-action-buttons button:last-child')
      expect(await exists('[data-marketplace-source-list]')).toBe(true)
      expect(await evaluate('document.querySelector("[data-marketplace-source-list]").textContent')).toContain(
        'Fixture source',
      )
      expect(await evaluate('Fixture.mutations()[1]')).toEqual({
        kind: 'source-add',
        source: {
          url: 'https://fixture.example/marketplace.json',
          enabled: true,
          trusted: true,
          local: { name: 'Fixture source', description: 'Local description' },
        },
      })
      await click('[aria-haspopup="menu"]')
      await run(
        `Array.from(document.querySelectorAll('.t-dropdown__item')).find(item=>item.textContent.includes('编辑来源')).click();await Fixture.settle()`,
      )
      expect(await evaluate('document.querySelector("[data-config-path=name] input").value')).toBe('Fixture source')
      await run(
        "await Fixture.type('url','http://fixture.example/feed.json?q=1');await Fixture.type('name','  Edited source  ')",
      )
      await click('[data-config-path=trusted] .t-switch')
      expect(await disabled()).toBe(false)
      await click('.cxf-form-action-buttons button:last-child')
      expect(await evaluate('Fixture.mutations()[2]')).toEqual({
        kind: 'source-edit',
        url: 'https://fixture.example/marketplace.json',
        source: {
          url: 'http://fixture.example/feed.json?q=1',
          enabled: true,
          trusted: false,
          local: { name: 'Edited source', description: 'Local description' },
        },
      })
      expect(await evaluate('document.querySelector("[data-marketplace-source-list]").textContent')).toContain(
        'Edited source',
      )
      await click('[aria-label="添加来源"]')
      await run("await Fixture.type('url','https://cancel.example/feed.json')")
      await click('.cxf-form-action-buttons button:first-child')
      expect(await evaluate('Fixture.mutations().length')).toBe(3)
      await click('[aria-label="添加来源"]')
      expect(await evaluate('document.querySelector("[data-config-path=url] input").value')).toBe('')
      await click('.cxr-header [aria-label="返回"]')
      expect(await exists('[data-marketplace-source-list]')).toBe(true)
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
  90_000,
)
