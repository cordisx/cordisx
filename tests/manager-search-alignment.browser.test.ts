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
              if (route.kind === 'primary') {
                const starts = await evaluate(`(() => {
                  const title=document.querySelector('.cxr-heading h2');
                  const range=document.createRange();
                  range.selectNodeContents(title);
                  const input=document.querySelector('.cxr-content input[type="search"]');
                  const style=getComputedStyle(input);
                  return {title:range.getBoundingClientRect().left,
                    search:input.getBoundingClientRect().left+parseFloat(style.borderLeftWidth)+parseFloat(style.paddingLeft)};
                })()`) as { title: number; search: number }
                expect(
                  Math.abs(starts.title - starts.search),
                  `${route.page} title/search text ${theme}/${width}/${query}: ${JSON.stringify(starts)}`,
                ).toBeLessThanOrEqual(1)
              }
              // Shared statuses must inherit the list's left baseline and wrap on narrow pages.
              const emptyStates = await evaluate(`(() => [...document.querySelectorAll('.cxh-empty-state')].map(e=>{
                const style=getComputedStyle(e),icon=e.querySelector('.cordisx-host-icon'),body=e.parentElement;
                return {left:e.getBoundingClientRect().left,owner:body.getBoundingClientRect().left,
                  icon:icon.getBoundingClientRect().left,overflow:e.scrollWidth-e.clientWidth,
                  border:style.borderTopWidth,color:style.color,muted:getComputedStyle(icon).color,
                  align:style.textAlign};
              }))()`) as {
                left: number
                owner: number
                icon: number
                overflow: number
                border: string
                color: string
                muted: string
                align: string
              }[]
              for (const state of emptyStates) {
                expect(Math.abs(state.left - state.owner)).toBeLessThanOrEqual(1)
                expect(Math.abs(state.icon - state.left)).toBeLessThanOrEqual(1)
                expect(state.overflow).toBeLessThanOrEqual(1)
                expect(state.border).toBe('0px')
                expect(state.align).toBe('start')
                expect(state.color).not.toBe(state.muted)
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
            const focusChrome = await evaluate(`(() => {
              const toolbar=document.querySelector('.cxh-search-toolbar'),field=toolbar.querySelector('.cxh-search-field');
              const t=getComputedStyle(toolbar),f=getComputedStyle(field);
              return {outline:t.outlineStyle,background:t.backgroundColor,border:t.borderTopWidth,
                fieldOutline:f.outlineStyle,fieldBorder:f.borderTopColor,fieldBackground:f.backgroundColor};
            })()`) as Record<string, string>
            expect(focusChrome.outline).toBe('none')
            expect(focusChrome.border).toBe('0px')
            expect(focusChrome.background).toBe('rgba(0, 0, 0, 0)')
            expect(focusChrome.fieldOutline).toBe('none')
            expect(focusChrome.fieldBorder).not.toBe('rgba(0, 0, 0, 0)')
            expect(focusChrome.fieldBackground).not.toBe('rgba(0, 0, 0, 0)')
            const action = await evaluate(
              `!!document.querySelector('.cxh-search-toolbar-actions button:not(:disabled)')`,
            )
            if (action) {
              await run(
                `document.querySelector('.cxh-search-toolbar-actions button:not(:disabled)').focus();await Fixture.settle()`,
              )
              expect(await evaluate(`getComputedStyle(document.querySelector('.cxh-search-field')).backgroundColor`))
                .toBe('rgba(0, 0, 0, 0)')
              await run(`document.querySelector('.cxr-content input').focus()`)
            }
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
      await run('window.disposeFixture=await Fixture.start(false,true)')
      const nativeGeometry = () =>
        evaluate(`(() => {
        const header=document.querySelector('.cxr-titlebar-root .cxr-header');
        const title=header.querySelector('.cxr-heading h2,.cxr-heading button');
        const range=document.createRange();range.selectNodeContents(title);
        const input=document.querySelector('.cxr-content input[type="search"]');
        const inputStyle=getComputedStyle(input);
        const toolbar=input.closest('.cxh-search-toolbar') ?? input.closest('.cxh-search-field');
        const chrome=toolbar.closest('.cxm-console-controls') ?? toolbar;
        const content=document.querySelector('.cxr-content');
        const icon=header.querySelector('.cxr-header-seat svg');
        return {titleIcon:icon?.getBoundingClientRect().left,titleText:range.getBoundingClientRect().left,
          searchIcon:toolbar.querySelector('.cxh-search-icon svg').getBoundingClientRect().left,
          searchText:input.getBoundingClientRect().left+parseFloat(inputStyle.borderLeftWidth)+parseFloat(inputStyle.paddingLeft),
          bodyStart:content.getBoundingClientRect().left+parseFloat(getComputedStyle(content).paddingLeft),
          bodyInset:parseFloat(getComputedStyle(content).paddingLeft),
          bodyBlocks:[...content.querySelectorAll('.cxr-page > .cxr-list,.cxr-page > .cxr-marketplace-grid,.cxmp-results,.cxm-console-workspace,.cxc-grid')].filter(el=>el.getClientRects().length).map(el=>el.getBoundingClientRect().left),
          leftGutter:chrome.getBoundingClientRect().left-content.getBoundingClientRect().left,
          rightGutter:content.clientWidth-(chrome.getBoundingClientRect().right-content.getBoundingClientRect().left),
          overflow:content.scrollWidth-content.clientWidth,
          titleRightGutter:parseFloat(getComputedStyle(header).paddingRight),
          seatWidth:header.querySelector('.cxr-header-seat').getBoundingClientRect().width,
          back:header.querySelector('.cxr-header-back')!==null};
      })()`) as Promise<Record<string, number | boolean | number[]>>
      const nativeRoutes = [...routes, { kind: 'plugin', pluginId: 'form-page-fixture', page: 'logs' }]
      for (const width of [1200, 700, 580]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width,
          height: 650,
          deviceScaleFactor: 1,
          mobile: false,
        })
        for (const theme of ['light', 'dark']) {
          await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)};await Fixture.settle()`)
          for (const route of nativeRoutes) {
            await run(`await Fixture.openSearchRoute(${JSON.stringify(route)})`)
            const actual = await nativeGeometry()
            const label = `${JSON.stringify(route)} native ${theme}/${width}`
            expect(Math.abs(Number(actual.titleIcon) - Number(actual.searchIcon)), `${label} icon`).toBeLessThanOrEqual(
              1,
            )
            expect(Math.abs(Number(actual.titleText) - Number(actual.searchText)), `${label} text`).toBeLessThanOrEqual(
              1,
            )
            expect(Math.abs(Number(actual.bodyStart) - Number(actual.titleIcon)), `${label} body origin`)
              .toBeLessThanOrEqual(1)
            for (const left of actual.bodyBlocks as number[]) {
              expect(Math.abs(left - Number(actual.titleIcon)), `${label} list/body left`).toBeLessThanOrEqual(1)
            }
            expect(actual.overflow, `${label} horizontal overflow`).toBe(0)
            expect(actual.leftGutter, `${label} left gutter`).toBe(12)
            expect(actual.rightGutter, `${label} right gutter`).toBe(12)
            expect(actual.titleRightGutter, `${label} title right gutter`).toBe(12)
            expect(actual.seatWidth, `${label} native click seat`).toBe(28)
            if (route.kind === 'plugin') expect(actual.back, `${label} back control`).toBe(true)
            await run(`document.querySelector('.cxr-content input[type="search"]').focus()`)
            const fieldChrome = await evaluate(`(() => {
              const f=getComputedStyle(document.querySelector('.cxr-content input[type="search"]').closest('.cxh-search-field'));
              return {outline:f.outlineStyle,border:f.borderTopColor,background:f.backgroundColor};
            })()`) as Record<string, string>
            expect(fieldChrome.outline, `${label} field outline`).toBe('none')
            expect(fieldChrome.border, `${label} field border`).not.toBe('rgba(0, 0, 0, 0)')
            expect(fieldChrome.background, `${label} field background`).not.toBe('rgba(0, 0, 0, 0)')
            const sharedStates = await evaluate(`(() => [...document.querySelectorAll('.cxh-empty-state')].map(e=>({
              left:e.getBoundingClientRect().left,icon:e.querySelector('.cordisx-host-icon').getBoundingClientRect().left,
              overflow:e.scrollWidth-e.clientWidth,border:getComputedStyle(e).borderTopWidth,
            })))()`) as { left: number; icon: number; overflow: number; border: string }[]
            for (const state of sharedStates) {
              expect(Math.abs(state.left - Number(actual.bodyStart)), `${label} status baseline`).toBeLessThanOrEqual(1)
              expect(Math.abs(state.icon - state.left), `${label} status icon`).toBeLessThanOrEqual(1)
              expect(state.overflow, `${label} status overflow`).toBeLessThanOrEqual(1)
              expect(state.border).toBe('0px')
            }
            if (process.env.CORDISX_EMPTY_STATE_ARTIFACTS && route.page === 'model-services' && width === 580) {
              const shot = await cdp!.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
              await writeFile(
                join(process.env.CORDISX_EMPTY_STATE_ARTIFACTS, `empty-browser-${theme}-narrow.png`),
                Buffer.from(shot.data as string, 'base64'),
              )
            }
            if (route.page === 'logs') {
              const gap = await evaluate(`(() => {
                const controls=document.querySelector('.cxm-console-controls');
                const search=controls.querySelector('.cxh-search-field').getBoundingClientRect();
                return Math.min(...[...controls.children].slice(1).map(el=>el.getBoundingClientRect()).filter(box=>box.top<search.bottom && box.bottom>search.top).map(box=>box.left-search.right));
              })()`) as number
              expect(gap, `${label} search/button separation`).toBeGreaterThanOrEqual(6)
            }
          }
          for (const extra of ['openMarketplacePermissionSearch', 'openCollectionSearch']) {
            await run(`window.disposeExtra=await Fixture[${JSON.stringify(extra)}]()`)
            const actual = await nativeGeometry()
            expect(actual.bodyInset, `${extra} native body inset ${theme}/${width}`).toBe(21)
            expect(
              Math.abs(Number(actual.searchIcon) - Number(actual.bodyStart)),
              `${extra} native icon ${theme}/${width}`,
            ).toBeLessThanOrEqual(1)
            expect(
              Math.abs(Number(actual.searchText) - Number(actual.titleText)),
              `${extra} native text ${theme}/${width}`,
            ).toBeLessThanOrEqual(1)
            expect(actual.leftGutter, `${extra} native left gutter`).toBe(12)
            expect(actual.rightGutter, `${extra} native right gutter`).toBe(12)
            expect(actual.overflow, `${extra} native overflow`).toBe(0)
            const clipped = await evaluate(`(() => {
              const toolbar=document.querySelector('.cxr-content input[type="search"]').closest('.cxh-search-toolbar');
              const box=toolbar.getBoundingClientRect();
              for(let parent=toolbar.parentElement;parent;parent=parent.parentElement) {
                if(['auto','scroll','hidden','clip'].includes(getComputedStyle(parent).overflowX)) {
                  const clip=parent.getBoundingClientRect();
                  if(box.left<clip.left || box.right>clip.right) return true;
                }
              }
              return false;
            })()`)
            expect(clipped, `${extra} native search chrome clipped`).toBe(false)
            await run('window.disposeExtra?.()')
          }
          // The former native override must fail the absolute icon-coordinate gate.
          await run(`await Fixture.openSearchRoute(${JSON.stringify(routes[0])});
            const header=document.querySelector('.cxr-titlebar-root .cxr-header');
            header.style.paddingLeft='12px';header.style.columnGap='6px'`)
          const displaced = await nativeGeometry()
          expect(Math.abs(Number(displaced.titleIcon) - Number(displaced.searchIcon))).toBeGreaterThan(1)
          await run(`document.querySelector('.cxr-titlebar-root .cxr-header').removeAttribute('style')`)
        }
      }

      // Real wheel input on production browse pages in the native-pane composition.
      // This catches the former outer-content scroll owner; assigning scrollTop
      // alone could pass even when a user's wheel still moves the search away.
      await run('await Fixture.prepareBrowseRecords()')
      const browseRoutes = [...routes.slice(0, 4), { kind: 'marketplace-sources' }]
      const scrollGeometry = () =>
        evaluate(`(() => {
        const results=document.querySelector('.cxr-browse-results');
        const toolbar=document.querySelector('.cxr-content .cxh-search-toolbar');
        const content=document.querySelector('.cxr-content'),root=document.querySelector('#manager');
        const r=results.getBoundingClientRect(),t=toolbar.getBoundingClientRect();
        return {top:t.top,bottom:t.bottom,resultTop:r.top,resultBottom:r.bottom,x:r.left+r.width/2,
          y:r.top+Math.min(r.height/2,40),list:results.scrollTop,content:content.scrollTop,
          root:root.scrollTop,window:window.scrollY,height:results.clientHeight,
          overflow:results.scrollHeight-results.clientHeight,rows:[...results.children].filter(e=>e.tagName!=='STYLE').length,
          actions:[...toolbar.querySelectorAll('button')].map(e=>e.getBoundingClientRect().top)};
      })()`) as Promise<{
          top: number
          bottom: number
          resultTop: number
          resultBottom: number
          x: number
          y: number
          list: number
          content: number
          root: number
          window: number
          height: number
          overflow: number
          rows: number
          actions: number[]
        }>
      const scrollEvidence: unknown[] = []
      for (const width of [1200, 580]) {
        for (const height of [650, 280]) {
          await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
          for (const theme of ['light', 'dark']) {
            await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
            for (const route of browseRoutes) {
              await run(`await Fixture.openSearchRoute(${JSON.stringify(route)});await Fixture.search('')`)
              await expect.poll(async () => (await scrollGeometry()).rows, {
                timeout: 5000,
                message: JSON.stringify(route),
              }).toBe(81)
              const before = await scrollGeometry()
              expect(before.rows, JSON.stringify(route)).toBe(81)
              expect(before.height).toBeGreaterThan(30)
              expect(before.overflow).toBeGreaterThan(120)
              expect(before.top).toBeGreaterThanOrEqual(44)
              expect(before.bottom).toBeLessThanOrEqual(before.resultTop)
              await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseWheel',
                x: before.x,
                y: before.y,
                deltaX: 0,
                deltaY: 240,
              })
              await expect.poll(async () => (await scrollGeometry()).list).toBeGreaterThan(0)
              const down = await scrollGeometry()
              expect(down.top).toBe(before.top)
              expect(down.actions).toEqual(before.actions)
              expect([down.content, down.root, down.window]).toEqual([0, 0, 0])
              await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseWheel',
                x: before.x,
                y: before.y,
                deltaX: 0,
                deltaY: -240,
              })
              await expect.poll(async () => (await scrollGeometry()).list).toBeLessThan(down.list)
              const up = await scrollGeometry()
              expect(up.top).toBe(before.top)
              expect([up.content, up.root, up.window]).toEqual([0, 0, 0])
              const singleQuery = route.kind === 'marketplace-sources'
                ? 'Scroll source 80'
                : route.page === 'marketplace'
                ? 'search-permissions-80'
                : route.page === 'plugins'
                ? 'Scroll plugin 80'
                : route.page === 'routes'
                ? 'Scroll route 80'
                : 'Scroll point 80'
              await run(`await Fixture.search(${JSON.stringify(singleQuery)})`)
              const single = await scrollGeometry()
              expect(single.rows).toBe(1)
              expect(single.height).toBe(before.height)
              expect(single.top).toBe(before.top)
              await run(`await Fixture.search('missing-scroll-regression')`)
              const empty = await scrollGeometry()
              expect(empty.top).toBe(before.top)
              expect(empty.height).toBe(before.height)
              expect(empty.resultBottom).toBe(before.resultBottom)
              expect(empty.rows).toBe(1)
              scrollEvidence.push({ route, width, height, theme, before, down, up, single, empty })
            }
          }
        }
      }
      await run('window.restoreBrowseLoading=await Fixture.openBrowseLoading()')
      const loading = await scrollGeometry()
      expect(loading.height).toBeGreaterThan(30)
      expect(loading.top).toBeGreaterThanOrEqual(44)
      expect([loading.content, loading.root, loading.window]).toEqual([0, 0, 0])
      expect(await evaluate('document.querySelector(".cxr-browse-results [data-empty-state]").dataset.emptyState'))
        .toBe('loading')
      await run('await window.restoreBrowseLoading()')
      scrollEvidence.push({ loading })
      if (process.env.CORDISX_BROWSE_SCROLL_ARTIFACTS) {
        await writeFile(
          join(process.env.CORDISX_BROWSE_SCROLL_ARTIFACTS, 'wheel-geometry.json'),
          JSON.stringify(scrollEvidence, null, 2),
        )
      }

      // Approved model-service hero uses the production page and the same native-pane fixture.
      await run('Fixture.prepareModelEmptyState()')
      for (const width of [1200, 580]) {
        for (const height of [650, 280]) {
          await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
          for (const theme of ['light', 'dark']) {
            await run(
              `document.documentElement.dataset.theme=${
                JSON.stringify(theme)
              };await Fixture.openSearchRoute({kind:'primary',page:'model-services'})`,
            )
            // The visible client viewport excludes a classic scrollbar and borders.
            const hero = await evaluate(`(() => {
              const e=document.querySelector('[data-empty-presentation="hero"]'),r=document.querySelector('.cxmp-results'),svg=e.querySelector('svg');
              const a=e.getBoundingClientRect(),b=r.getBoundingClientRect(),scene=svg.getBoundingClientRect();
              return {width:scene.width,height:scene.height,centerX:(a.left+a.right)/2-(b.left+r.clientLeft+r.clientWidth/2),
                centerY:(a.top+a.bottom-b.top-b.bottom)/2,overflow:e.scrollWidth-e.clientWidth,
                scroll:r.scrollHeight>r.clientHeight,toolbar:document.querySelector('.cxh-search-toolbar').getBoundingClientRect().top};
            })()`) as Record<string, number | boolean>
            expect(hero.width).toBeLessThanOrEqual(310)
            expect(Math.abs(Number(hero.height) - Number(hero.width) * 9 / 16)).toBeLessThan(1)
            expect(Math.abs(Number(hero.centerX))).toBeLessThan(1)
            expect(hero.overflow).toBe(0)
            if (height === 650) expect(Math.abs(Number(hero.centerY))).toBeLessThan(1)
            else {
              expect(hero.scroll).toBe(true)
              await run(`document.querySelector('.cxmp-results').scrollTop=100;await Fixture.settle()`)
              expect(await evaluate(`document.querySelector('.cxh-search-toolbar').getBoundingClientRect().top`)).toBe(
                hero.toolbar,
              )
            }
            const endpoints = await evaluate(`(() => {
              const scene=document.querySelector('.cxms-illustration svg');
              return [0,3000,7000,11000].flatMap(time=>{
                scene.getAnimations({subtree:true}).forEach(a=>{a.pause();a.currentTime=time});
                return ['one','two','three'].map(name=>{
                  const o=scene.querySelector('[data-output="'+name+'"]'),i=scene.querySelector('[data-input="'+name+'"]');
                  const p=o.getPointAtLength(o.getTotalLength()).matrixTransform(o.getCTM()),box=i.getBBox();
                  const q=new DOMPoint(box.x,box.y+box.height/2).matrixTransform(i.getCTM());
                  return Math.hypot(p.x-q.x,p.y-q.y);
                });
              });
            })()`) as number[]
            expect(Math.max(...endpoints)).toBeLessThan(0.01)
            await cdp.send('Emulation.setEmulatedMedia', {
              features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
            })
            await run('await Fixture.settle()')
            expect(
              await evaluate(`document.querySelector('.cxms-illustration svg').getAnimations({subtree:true}).length`),
            ).toBe(0)
            await cdp.send('Emulation.setEmulatedMedia', { features: [] })
            if (process.env.CORDISX_EMPTY_STATE_ARTIFACTS && width === 580 && height === 280) {
              const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
              await writeFile(
                join(process.env.CORDISX_EMPTY_STATE_ARTIFACTS, `hero-${theme}-narrow-short.png`),
                Buffer.from(shot.data as string, 'base64'),
              )
            }
          }
        }
      }
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
