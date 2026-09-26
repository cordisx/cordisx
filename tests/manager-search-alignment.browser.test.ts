import { build } from 'esbuild'
import { type ChildProcess, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'

const executable = process.env.CHROME_PATH ?? process.env.RESTRICTED_CHROME_EXECUTABLE
it.skipIf(!executable)(
  'aligns production Manager searches with Marketplace across themes, widths, empty states and actions',
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
      await run('Fixture.prepareSearchRecords();window.disposeFixture=await Fixture.start()')
      const routes = [
        { kind: 'primary', page: 'marketplace' },
        { kind: 'primary', page: 'plugins' },
        { kind: 'primary', page: 'extension-points' },
        { kind: 'primary', page: 'routes' },
        { kind: 'primary', page: 'model-services' },
        { kind: 'marketplace-sources' },
        { kind: 'plugin', pluginId: 'form-page-fixture', page: 'extension-points' },
        { kind: 'plugin', pluginId: 'form-page-fixture', page: 'routes' },
        { kind: 'plugin-bundle', bundleId: 'search-bundle', page: 'members' },
      ]
      const geometry = () =>
        evaluate(`(() => {
        const input = document.querySelector('.cxr-content input[type="search"],.cxr-content input');
        const shell = input.closest('.cxh-search-toolbar,.cxr-marketplace-tools,.cxr-plugins-toolbar,.cxr-search');
        const icon = shell.querySelector('.cxh-search-icon svg,.t-input__prefix svg');
        const box = shell.getBoundingClientRect();
        const text = input.getBoundingClientRect();
        return {left:box.left,right:box.right,height:box.height,textInset:text.left-box.left,
          iconInset:icon.getBoundingClientRect().left-box.left,
          fontSize:parseFloat(getComputedStyle(input).fontSize),iconWidth:icon.getBoundingClientRect().width};
      })()`)
      for (const width of [1200, 700]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width,
          height: 650,
          deviceScaleFactor: 1,
          mobile: false,
        })
        for (const theme of ['light', 'dark']) {
          await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)};await Fixture.settle()`)
          await run(`await Fixture.openSearchRoute(${JSON.stringify(routes[0])})`)
          const baseline = await geometry() as Record<string, number>
          // Recorded native Marketplace acceptance baseline, independent of CSS.
          expect(baseline.height).toBe(36)
          expect(baseline.fontSize).toBe(14)
          expect(baseline.iconWidth).toBe(16)
          for (const route of routes) {
            await run(`await Fixture.openSearchRoute(${JSON.stringify(route)})`)
            for (const query of ['', 'missing-regression-target']) {
              await run(`await Fixture.search(${JSON.stringify(query)})`)
              const actual = await geometry() as Record<string, number>
              for (const key of ['left', 'right', 'height', 'textInset', 'iconInset', 'fontSize', 'iconWidth']) {
                expect(
                  Math.abs(actual[key]! - baseline[key]!),
                  `${JSON.stringify(route)} ${theme}/${width}/${query}: ${key}`,
                ).toBeLessThanOrEqual(1)
              }
              expect(actual.left).toBeGreaterThanOrEqual(0)
              expect(actual.right).toBeLessThanOrEqual(width)
              expect(await evaluate('document.querySelector(".cxr-content input").getAttribute("aria-label")'))
                .toBeTruthy()
              expect(
                await evaluate('document.querySelector(".cxr-content input").closest(".cxh-search-toolbar") !== null'),
              ).toBe(true)
            }
            await run(`document.querySelector('.cxr-content .cxh-search-clear').click();await Fixture.settle()`)
            expect(await evaluate('document.querySelector(".cxr-content input").value')).toBe('')
            expect(await evaluate('document.activeElement===document.querySelector(".cxr-content input")')).toBe(true)
            await run(`await Fixture.search('escape-target');document.querySelector('.cxr-content input').focus()`)
            expect(await evaluate('getComputedStyle(document.querySelector(".cxh-search-toolbar")).outlineStyle')).not
              .toBe('none')
            await cdp.send('Input.dispatchKeyEvent', {
              type: 'keyDown',
              key: 'Escape',
              code: 'Escape',
              windowsVirtualKeyCode: 27,
            })
            await cdp.send('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: 'Escape',
              code: 'Escape',
              windowsVirtualKeyCode: 27,
            })
            await run('await Fixture.settle()')
            expect(await evaluate('document.querySelector(".cxr-content input").value')).toBe('')
          }
          await run('window.disposeCollection=await Fixture.openCollectionSearch()')
          const collection = await geometry() as Record<string, number>
          for (const key of ['left', 'right', 'height', 'textInset', 'iconInset', 'fontSize', 'iconWidth']) {
            expect(Math.abs(collection[key]! - baseline[key]!), `collection ${width}/${theme}: ${key}`)
              .toBeLessThanOrEqual(1)
          }
          await run('disposeCollection()')
          await run('await Fixture.openMarketplacePermissionSearch()')
          const permissions = await geometry() as Record<string, number>
          for (const key of ['left', 'right', 'height', 'textInset', 'iconInset', 'fontSize', 'iconWidth']) {
            expect(Math.abs(permissions[key]! - baseline[key]!), `Marketplace permissions ${width}/${theme}: ${key}`)
              .toBeLessThanOrEqual(1)
          }
          await run(`await Fixture.openSearchRoute({kind:'plugin',pluginId:'form-page-fixture',page:'logs'})`)
          const logGeometry = await evaluate(`(() => {
            const shell=document.querySelector('.cxm-console-controls > .cxh-search-field');
            const box=shell.getBoundingClientRect();
            const text=shell.querySelector('input').getBoundingClientRect();
            const icon=shell.querySelector('.cxh-search-icon svg').getBoundingClientRect();
            return {height:box.height,left:box.left,textInset:text.left-box.left,iconInset:icon.left-box.left};
          })()`) as Record<string, number>
          for (const key of ['height', 'left', 'textInset', 'iconInset']) {
            expect(Math.abs(logGeometry[key]! - baseline[key]!), `logs ${width}/${theme}: ${key}`).toBeLessThanOrEqual(
              1,
            )
          }
          // Reintroduce the former inset drift in the real DOM. The same
          // measurement and tolerance must detect it without weakening the gate.
          await run(
            `await Fixture.openSearchRoute(${
              JSON.stringify(routes[0])
            });document.querySelector('.cxr-content input').style.transform='translateX(4px)'`,
          )
          const displaced = await geometry() as Record<string, number>
          expect(Math.abs(displaced.textInset! - baseline.textInset!)).toBeGreaterThan(1)
          await run(`document.querySelector('.cxr-content input').style.transform=''`)
        }
      }
      await run(
        `await Fixture.openSearchRoute({kind:'primary',page:'plugins'});await Fixture.search('missing-regression-target')`,
      )
      expect(await evaluate('document.querySelectorAll("[data-plugin-result-type=plugin]").length')).toBe(0)
      await run(`await Fixture.search('Form pages')`)
      expect(await evaluate('document.querySelector(".cxr-content").textContent')).toContain('Form pages fixture')
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
  90_000,
)
