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
      expect(await exists('.cxmp-management > [role=search]')).toBe(false)
      expect(await exists('[data-schema-form]')).toBe(true)
      expect(await exists('[data-config-path="protocol"]')).toBe(false)
      expect(await evaluate('document.querySelector(".cxr-heading").textContent')).toContain('添加模型连接')
      await click('.cxr-header [aria-label="返回"]')
      expect(await exists('.cxmp-management > [role=search]')).toBe(true)
      await click('[aria-label="添加模型连接"]')
      await click('.cxmc-editor-actions button:first-child')
      expect(await exists('.cxmp-management > [role=search]')).toBe(true)
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
          await click('[data-config-path="models"] [aria-label="编辑条目"]')
          expect(await evaluate('document.querySelector(".cxmc-editor-actions").closest("[hidden]")!==null')).toBe(true)
          expect(
            await evaluate(
              'document.querySelector(".cxf-form-subpage .cxf-form-page-footer").getBoundingClientRect().bottom<=innerHeight',
            ),
          ).toBe(true)
          expect(
            await evaluate(
              'Math.abs(document.querySelector(".cxr-header-seat").getBoundingClientRect().x-document.querySelector(".cxf-form-subpage-header-seat").getBoundingClientRect().x)<1',
            ),
          ).toBe(true)
          if (process.env.CATALOG_SCREENSHOT_DIR) {
            const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
            await writeFile(
              join(process.env.CATALOG_SCREENSHOT_DIR, `connection-item-${width}-${theme}.png`),
              Buffer.from(shot.data as string, 'base64'),
            )
          }
          await click('.cxf-form-subpage .cxf-form-action-buttons button:first-child')
        }
      }
      await click('.cxmc-editor-actions button:last-child')
      expect(await exists('.cxmp-management > [role=search]')).toBe(true)
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
      await click('[aria-label^="更多目录操作"]')
      await run(
        `const edit=[...document.querySelectorAll('.t-dropdown__item')].find(item=>item.textContent.includes('编辑连接'));edit.click();await Fixture.settle()`,
      )
      expect(await exists('.cxmc-editor [data-schema-form]')).toBe(true)
      await click('.cxmc-editor [data-config-path="models"] [aria-label="编辑条目"]')
      expect(await evaluate('document.querySelector(".cxmc-editor-actions").closest("[hidden]")!==null')).toBe(true)
      await click('.cxf-form-subpage .cxf-form-action-buttons button:first-child')
      await click('.cxmc-editor-actions button:first-child')
      expect(await exists('.cxmc-editor')).toBe(false)
      const checkFooter = async () => {
        const geometry = await run(`
          const layer=document.querySelector('.cxf-form-page-layer:not([hidden])')??document.querySelector('.cxf-form-page-root:not([hidden])');
          const page=layer.querySelector('.cxf-form-page'),body=page.querySelector('.cxf-form-page-scroll'),footer=page.querySelector('.cxf-form-page-footer');
          const before=footer.getBoundingClientRect();body.scrollTop=body.scrollHeight;await Fixture.settle();const after=footer.getBoundingClientRect();
          return {before:before.y,after:after.y,bottom:after.bottom,bodyBottom:body.getBoundingClientRect().bottom,height:innerHeight,scroll:body.scrollTop,overflow:getComputedStyle(body).overflowY,outerScroll:document.querySelector('.cxr-content').scrollTop};
        `) as {
          before: number
          after: number
          bottom: number
          bodyBottom: number
          height: number
          scroll: number
          overflow: string
          outerScroll: number
        }
        expect(geometry.after).toBe(geometry.before)
        expect(geometry.bottom).toBeLessThanOrEqual(geometry.height)
        expect(geometry.bodyBottom).toBeLessThanOrEqual(geometry.after + 1)
        expect(geometry.scroll).toBeGreaterThan(0)
        expect(geometry.overflow).toBe('auto')
        expect(geometry.outerScroll).toBe(0)
      }
      await run('await Fixture.showPluginForm();await Fixture.type("name","Root page draft")')
      for (const [width, height] of [[1440, 1000], [800, 800], [390, 844]]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
        for (const theme of ['light', 'dark']) {
          await run(
            `document.documentElement.dataset.theme='${theme}';await Fixture.settle();await new Promise(resolve=>setTimeout(resolve,350))`,
          )
          await checkFooter()
          for (let depth = 1; depth <= 3; depth++) {
            await run(`await Fixture.openFormItem();await Fixture.typeItemName('Level ${depth} draft')`)
            await checkFooter()
            expect(
              await evaluate(
                `Math.abs(document.querySelector('.cxr-header-seat').getBoundingClientRect().x-document.querySelector('.cxf-form-page-layer:not([hidden]) .cxf-form-subpage-header-seat').getBoundingClientRect().x)<1`,
              ),
            ).toBe(true)
            expect(
              await evaluate(
                `document.querySelector('.cxf-form-page-layer:not([hidden]) input').closest('form')===null`,
              ),
            ).toBe(true)
            await cdp.send('Input.dispatchKeyEvent', {
              type: 'keyDown',
              key: 'Enter',
              code: 'Enter',
              windowsVirtualKeyCode: 13,
            })
            await cdp.send('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: 'Enter',
              code: 'Enter',
              windowsVirtualKeyCode: 13,
            })
            await run(
              `document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await Fixture.settle()`,
            )
            expect(await evaluate('Fixture.pluginWrites().length')).toBe(0)
            expect(await evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true)
            if (process.env.CATALOG_SCREENSHOT_DIR) {
              const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
              await writeFile(
                join(process.env.CATALOG_SCREENSHOT_DIR, `form-page-${depth}-${width}-${theme}.png`),
                Buffer.from(shot.data as string, 'base64'),
              )
            }
          }
          await run('await Fixture.finishFormItem(false)')
          expect(
            await evaluate(
              `document.querySelector('.cxf-form-page-layer:not([hidden]) [data-config-path$=".name"] input').value`,
            ),
          ).toBe('Level 2 draft')
          await run('await Fixture.finishFormItem(true);await Fixture.finishFormItem(true)')
          expect(await evaluate(`document.querySelector('[data-config-path="name"] input').value`)).toBe(
            'Root page draft',
          )
        }
      }
      await run('await Fixture.showPluginForm()')
      const measureControls = () =>
        run(`
        await document.fonts.ready;
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const root=document.querySelector('[data-plugin-config-form]');
        const center=r=>r.top+r.height/2;
        return [
          ['geometryCheckbox','.t-checkbox__input'],['geometrySwitch','.t-switch'],
          ['geometryInput','.t-input'],['geometrySelect','.t-input'],['items','[data-array-action="add"]']
        ].map(([path,selector])=>{
          const row=root.querySelector('[data-config-path="'+path+'"]');
          const label=row.querySelector('.cxf-label-row').getBoundingClientRect();
          const control=row.querySelector(selector).getBoundingClientRect();
          const help=row.querySelector('.cxf-help')?.getBoundingClientRect();
          const full=row.dataset.fullWidth==='true';
          const labelCenter=innerWidth>760&&!full&&help?(label.top+help.bottom)/2:center(label);
          return {path,delta:Math.abs(labelCenter-center(control)),top:control.top,labelBottom:label.bottom,
            helpTop:help?.top,helpBottom:help?.bottom,left:control.left,right:control.right,width:control.width,
            full};
        });
      `) as Promise<
          {
            path: string
            delta: number
            top: number
            labelBottom: number
            helpTop?: number
            helpBottom?: number
            left: number
            right: number
            width: number
            full: boolean
          }[]
        >
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 844,
        deviceScaleFactor: 1,
        mobile: false,
      })
      // Inject the previous layout only into this disposable fixture to prove the regression is detectable.
      await run(`window.oldGeometryStyle=document.createElement('style');oldGeometryStyle.textContent=
        '[data-plugin-config-form] :is(.cxf-control-seat,.cxf-control-fallback){display:block!important}'+
        '[data-plugin-config-form] .cxf-array-editor-toolbar{top:10px!important;height:auto!important}'+
        '[data-plugin-config-form] .cxf-item[data-has-description="true"]:not([data-full-width="true"]){grid-template-areas:"label control" "help ." "error error"!important}';
        document.head.append(oldGeometryStyle)`)
      try {
        const old = await measureControls()
        expect(old.find(control => control.path === 'items')!.delta).toBeGreaterThan(1)
        expect(old.find(control => control.path === 'geometrySwitch')!.delta).toBeGreaterThan(1)
        expect(old.find(control => control.path === 'geometryInput')!.delta).toBeGreaterThan(1)
      } finally {
        await run('oldGeometryStyle.remove()')
      }
      for (const width of [1440, 800, 390]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width,
          height: 844,
          deviceScaleFactor: 1,
          mobile: false,
        })
        await run(
          `const root=document.querySelector('[data-plugin-config-form]');while(root.querySelector('[data-config-path="items"] .cxf-array-delete')){root.querySelector('[data-config-path="items"] .cxf-array-delete').click();await Fixture.settle()}`,
        )
        for (const populated of [false, true]) {
          if (populated) {
            await run(
              'await Fixture.openFormItem();await Fixture.typeItemName("Geometry model");await Fixture.finishFormItem(true)',
            )
          }
          if (width === 1440 && !populated) {
            await run(
              `const root=document.querySelector('[data-plugin-config-form] .cxf-react-form');root.style.setProperty('--cxf-field-padding-block','18px');root.style.setProperty('--cxf-field-title-line-height','28px')`,
            )
            try {
              expect(
                await evaluate(
                  `getComputedStyle(document.querySelector('[data-config-path="geometryCheckbox"]')).paddingTop`,
                ),
              ).toBe('18px')
              expect(
                await evaluate(
                  `getComputedStyle(document.querySelector('[data-config-path="geometryCheckbox"] .cxf-field-label')).lineHeight`,
                ),
              ).toBe('28px')
              for (const control of await measureControls()) {
                expect(control.delta, control.path + ' resized tokens').toBeLessThanOrEqual(1)
              }
            } finally {
              await run(
                `const root=document.querySelector('[data-plugin-config-form] .cxf-react-form');root.style.removeProperty('--cxf-field-padding-block');root.style.removeProperty('--cxf-field-title-line-height')`,
              )
            }
          }
          expect(
            await evaluate(
              `getComputedStyle(document.querySelector('[data-config-path="geometryCheckbox"]')).paddingTop`,
            ),
          ).toBe('14px')
          expect(
            await evaluate(
              `getComputedStyle(document.querySelector('[data-config-path="geometryCheckbox"] .cxf-field-label')).lineHeight`,
            ),
          ).toBe('24px')
          expect(
            await evaluate(
              `document.querySelector('[data-plugin-config-form] [data-config-path="items"] .cxf-array-row')!==null`,
            ),
          ).toBe(populated)
          expect(
            await evaluate(
              `document.querySelector('[data-plugin-config-form] [data-config-path="items"] .cxf-array-editor').dataset.empty`,
            ),
          ).toBe(String(!populated))
          const controls = await measureControls()
          for (const control of controls) {
            expect(control.width, control.path).toBeGreaterThan(0)
            expect(control.left, control.path).toBeGreaterThanOrEqual(0)
            expect(control.right, control.path).toBeLessThanOrEqual(width)
            if (control.path === 'items' || width > 760 && !control.full) {
              expect(control.delta, control.path).toBeLessThanOrEqual(1)
            } else {
              expect(control.top, control.path).toBeGreaterThanOrEqual(control.labelBottom - 1)
              if (control.helpBottom !== undefined) {
                expect(control.top, control.path).toBeGreaterThanOrEqual(control.helpBottom - 1)
              }
            }
            if (control.helpTop !== undefined) {
              expect(control.helpTop, control.path).toBeGreaterThanOrEqual(control.labelBottom - 1)
            }
          }
        }
      }
      await run(
        'disposeFixture();window.disposeStandalone=await Fixture.startStandalone();await Fixture.openFormItem()',
      )
      const colors = []
      for (const theme of ['light', 'dark']) {
        await run(
          `document.documentElement.dataset.theme='${theme}';await Fixture.settle();await new Promise(resolve=>setTimeout(resolve,350))`,
        )
        expect(await evaluate(`document.querySelector('[data-schema-form="standalone"]').dataset.cordisxAppTheme`))
          .toBe(theme)
        expect(
          await evaluate(`document.querySelector('.cxf-form-subpage').closest('.cxh-tdesign-root').dataset.schemaForm`),
        ).toBe('standalone')
        await run(
          `const select=document.querySelector('.cxf-form-subpage [data-config-path$=".choice"] .t-input');select.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));select.click();await Fixture.settle()`,
        )
        expect(await exists('[data-schema-form="standalone"] .t-popup .t-select-option')).toBe(true)
        colors.push(await evaluate(`getComputedStyle(document.querySelector('.cxf-form-subpage .t-button')).color`))
        await run(
          `document.querySelector('[data-schema-form="standalone"] .t-select-option').click();await Fixture.settle()`,
        )
      }
      expect(colors[0]).not.toBe(colors[1])
      await run('disposeStandalone();window.disposeEmbedded=await Fixture.startEmbedded()')
      expect(
        await evaluate(
          `document.querySelector('[data-schema-form="embedded"]').getBoundingClientRect().height>innerHeight`,
        ),
      ).toBe(true)
      expect(
        await evaluate(
          `getComputedStyle(document.querySelector('[data-schema-form="embedded"] .cxf-form-page-scroll')).overflowY`,
        ),
      ).toBe('visible')
      await run('disposeEmbedded()')
      await run('window.disposeBinding=await Fixture.startConfigBinding()')
      expect(
        await evaluate(
          `document.querySelector('[data-manager-content-config-host]').getBoundingClientRect().height>innerHeight`,
        ),
      ).toBe(true)
      expect(
        await evaluate(
          `document.querySelector('[data-manager-content-config-host] .cxf-form-page-scroll').scrollHeight===document.querySelector('[data-manager-content-config-host] .cxf-form-page-scroll').clientHeight`,
        ),
      ).toBe(true)
      await run(
        'await Fixture.openFormItem();await Fixture.typeItemName("Binding child draft");await Fixture.finishFormItem(false)',
      )
      expect(
        await evaluate(
          `document.querySelector('[data-manager-content-config-host] [data-config-path="name"] input').value`,
        ),
      ).toBe('initial')
      await run('disposeBinding()')
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
