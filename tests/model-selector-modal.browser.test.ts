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
  'keeps the Composer visible but inert through modal portals and attribute-only transitions',
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'model-selector-modal-'))
    const bundle = await build({
      entryPoints: ['tests/fixtures/model-selector-modal.tsx'],
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
      response.end(`<html><head><style>
      body { font:14px system-ui; background:#fff; color:#222; margin:24px }
      main { margin-top:240px; border:1px solid #aaa; padding:12px }
      textarea { width:95%; height:60px } footer { display:flex; align-items:center; gap:8px }
      dialog { border:1px solid #888; padding:24px } dialog::backdrop { background:#0003 }
    </style></head><body><div id="app"></div><script>${bundle.outputFiles[0]!.text}</script></body></html>`)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
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
        '--window-size=1000,800',
        'about:blank',
      ], { stdio: 'ignore' })
      let debuggingPort = 0
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          debuggingPort = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0])
          break
        } catch {
          await new Promise(resolve => setTimeout(resolve, 50))
        }
      }
      expect(debuggingPort).toBeGreaterThan(0)
      const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json() as {
        type: string
        webSocketDebuggerUrl: string
      }[]
      cdp = await CdpSession.connect(targets.find(target => target.type === 'page')!.webSocketDebuggerUrl)
      await cdp.send('Page.enable')
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` })
      async function evaluate(expression: string) {
        const result = await cdp!.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        expect(result.exceptionDetails).toBeUndefined()
        return (result.result as { value?: unknown })?.value
      }
      const run = (statements: string) => evaluate(`(async () => { ${statements} })()`)
      await expect.poll(() => evaluate('typeof Fixture')).toBe('object')
      await run(
        'window.disposeFixture = await Fixture.start(); window.seat = document.querySelector("[data-cordisx-model-provider-selector]")',
      )
      const projection = `(() => {
      const root=document.querySelector('[data-cordisx-model-provider-selector]');
      const buttons=[...root.querySelectorAll('button')];
      return {same:root===seat,count:document.querySelectorAll('[data-cordisx-model-provider-selector]').length,
        disabled:buttons.every(b=>b.disabled),visible:buttons.every(b=>b.getBoundingClientRect().width>0 && getComputedStyle(b).visibility!=='hidden'),
        nativeHidden:document.querySelector('[data-codex-intelligence-trigger]').hidden,
        menu:!!document.querySelector('.cxmp-menu')};
    })()`
      for (const attribute of ['aria-hidden', 'inert']) {
        await run(`document.getElementById('app').setAttribute('${attribute}','true'); await Fixture.settle()`)
        expect(await evaluate(projection)).toEqual({
          same: true,
          count: 1,
          disabled: true,
          visible: true,
          nativeHidden: true,
          menu: false,
        })
        await run(
          `for(const b of seat.querySelectorAll('button')){b.click();b.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))} await Fixture.settle()`,
        )
        expect(await evaluate('Fixture.actionCount()')).toBe(0)
        expect(await evaluate('!!document.querySelector(".cxmp-menu")')).toBe(false)
        await run(`document.getElementById('app').removeAttribute('${attribute}'); await Fixture.settle()`)
        expect(await evaluate('seat.querySelector(".cxmp-model-trigger").disabled')).toBe(false)
      }
      await run(
        'window.nonmodal = document.createElement("dialog"); nonmodal.textContent="Nonmodal"; document.body.append(nonmodal); nonmodal.show(); await Fixture.settle()',
      )
      expect(await evaluate('seat.querySelector(".cxmp-model-trigger").disabled')).toBe(false)
      await run('nonmodal.close(); nonmodal.showModal(); await Fixture.settle()')
      expect(await evaluate('seat.querySelector(".cxmp-model-trigger").disabled')).toBe(true)
      await run('nonmodal.close(); nonmodal.remove(); await Fixture.settle()')
      expect(await evaluate('seat.querySelector(".cxmp-model-trigger").disabled')).toBe(false)
      await run('seat.querySelector(".cxmp-model-trigger").click(); await Fixture.settle()')
      expect(await evaluate('!!document.querySelector(".cxmp-menu")')).toBe(true)
      await run('await Fixture.modal(true)')
      expect(await evaluate(projection)).toEqual({
        same: true,
        count: 1,
        disabled: true,
        visible: true,
        nativeHidden: true,
        menu: false,
      })
      await run('await Fixture.refresh(); seat.remove(); await Fixture.settle()')
      expect(await evaluate('document.querySelector("[data-cordisx-model-provider-selector]")===seat')).toBe(true)
      for (let i = 0; i < 8; i++) {
        const modifiers = i < 4 ? 0 : 8
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Tab',
          code: 'Tab',
          windowsVirtualKeyCode: 9,
          modifiers,
        })
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Tab',
          code: 'Tab',
          windowsVirtualKeyCode: 9,
          modifiers,
        })
        expect(await evaluate('document.querySelector("dialog").contains(document.activeElement)')).toBe(true)
      }
      await evaluate('seat.querySelector("button").focus()')
      expect(await evaluate('document.querySelector("dialog").contains(document.activeElement)')).toBe(true)
      await run('await Fixture.replace(); await Fixture.refresh()')
      expect(await evaluate('document.querySelectorAll("[data-cordisx-model-provider-selector]").length')).toBe(1)
      expect(await evaluate('document.querySelector("dialog").contains(document.activeElement)')).toBe(true)
      await run('document.getElementById("cancel").click(); await Fixture.settle()')
      expect(await evaluate('document.activeElement.id')).toBe('permissions')
      expect(await evaluate('[...document.querySelector("footer").children].map(e=>e.id || "selector")')).toEqual([
        'usage',
        'selector',
        'native-group',
        'voice',
      ])
      expect(await evaluate('document.querySelector(".cxmp-model-trigger").disabled')).toBe(false)
      await run(`window.stopFocusReturn=Fixture.simulateHostFocusReturn();
      document.querySelector('.cxmp-provider-trigger').click();await Fixture.settle()`)
      expect(await evaluate('Fixture.focusReturnCount()')).toBe(1)
      expect(await evaluate('document.activeElement.getAttribute("aria-label")')).toBe('Draft')
      await run(
        `document.querySelector('.cxmp-provider-trigger').click();window.stopFocusReturn();await Fixture.settle()`,
      )
      await run(`window.outlet=document.createElement('section');
      outlet.dataset.cordisxPageOutlet='app';document.body.append(outlet);await Fixture.settle();
      Fixture.resetSnapshotReads();
      for(let i=0;i<200;i++) outlet.style.inset=i%2?'auto':'0px';await Fixture.settle()`)
      expect(await evaluate('Fixture.snapshotReadCount()')).toBe(0)
      await run(`document.querySelector('.cxmp-provider-trigger').click();await Fixture.settle();
      Fixture.resetSnapshotReads();window.outletTimer=false;setTimeout(()=>{window.outletTimer=true},0);
      for(let i=0;i<200;i++) outlet.style.inset=i%2?'auto':'0px';
      await new Promise(resolve=>setTimeout(resolve,0));await Fixture.settle()`)
      expect(await evaluate('Fixture.snapshotReadCount()')).toBe(0)
      expect(await evaluate('window.outletTimer')).toBe(true)
      expect(await evaluate('!!document.querySelector(".cxmp-menu")')).toBe(true)
      await run(`document.querySelector('.cxmp-provider-trigger').click();await Fixture.settle()`)
      expect(await evaluate('!!document.querySelector(".cxmp-menu")')).toBe(false)
      const catalogMeasurements = []
      for (const count of [1, 10, 286, 500]) {
        await run(`await Fixture.catalog(${count});window.measurement=await (async()=>{
        const measure=async selector=>{let timer=false;const reads=Fixture.catalogReadCount();
          const started=performance.now();setTimeout(()=>{timer=true},0);document.querySelector(selector).click();
          await new Promise(resolve=>setTimeout(resolve,0));const menu=document.querySelector('.cxmp-menu');
          const result={elapsed:performance.now()-started,timer,reads:Fixture.catalogReadCount()-reads,
            nodes:menu.querySelectorAll('*').length,models:menu.querySelectorAll('.cxmp-model-choice').length};
          document.querySelector(selector).click();await Fixture.settle();return result};
        return {count:${count},provider:await measure('.cxmp-provider-trigger'),model:await measure('.cxmp-model-trigger')}})()`)
        catalogMeasurements.push(await evaluate('window.measurement'))
      }
      for (
        const measurement of catalogMeasurements as {
          count: number
          provider: { elapsed: number; timer: boolean; reads: number; nodes: number; models: number }
          model: { elapsed: number; timer: boolean; reads: number; nodes: number; models: number }
        }[]
      ) {
        expect(measurement.provider).toMatchObject({ timer: true, reads: 0, nodes: 14, models: 0 })
        expect(measurement.model.timer).toBe(true)
        expect(measurement.model.reads).toBe(0)
        expect(measurement.model.models).toBe(measurement.count)
        expect(measurement.provider.elapsed).toBeLessThan(250)
        expect(measurement.model.elapsed).toBeLessThan(1000)
      }
      if (process.env.MODEL_SELECTOR_MEASUREMENTS) console.info(JSON.stringify(catalogMeasurements))
      expect(catalogMeasurements.map(measurement => measurement.provider.nodes)).toEqual([14, 14, 14, 14])
      await run(`await Fixture.catalog(500);
      document.querySelector('.cxmp-model-trigger').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
      await Fixture.settle();document.querySelector('.cxmp-model-disclosure').click();await Fixture.settle()`)
      expect(await evaluate('document.querySelectorAll(".cxmp-model-choice").length')).toBe(500)
      await run(`const search=document.querySelector('input[type=search]');search.value='Model 499';
      search.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'9'}));await Fixture.settle()`)
      expect(await evaluate('document.querySelectorAll(".cxmp-model-choice").length')).toBe(1)
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 420,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await run(
        `document.querySelector('.cxmp-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      await Fixture.catalog(96);document.querySelector('.cxmp-model-trigger').click();await Fixture.settle();
      window.menuGeometry=()=>{const menu=document.querySelector('.cxmp-menu').getBoundingClientRect();
        const anchor=document.querySelector('.cxmp-selector').getBoundingClientRect();
        return {top:menu.top,bottom:menu.bottom,height:menu.height,gap:anchor.top-menu.bottom,viewport:innerHeight}};
      document.querySelector('.cxmp-model-disclosure').click();await new Promise(resolve=>setTimeout(resolve,80));`,
      )
      expect(await evaluate('window.menuGeometry().viewport')).toBe(420)
      expect(await evaluate('Math.abs(window.menuGeometry().gap-6)<=1')).toBe(true)
      expect(await evaluate('window.menuGeometry().top>=7&&window.menuGeometry().bottom<=413')).toBe(true)
      expect(
        await evaluate(`(() => {const fast=document.querySelector('.cxmp-fast-toggle');
        const model=document.querySelector('.cxmp-model-disclosure > :first-child');
        const f=fast.getBoundingClientRect(),m=model.getBoundingClientRect(),s=getComputedStyle(fast);
        return {aligned:Math.abs((f.left+f.width/2)-(m.left+m.width/2))<=.5,width:f.width,height:f.height,
          background:s.backgroundColor,border:s.borderTopWidth,pressed:fast.getAttribute('aria-pressed'),
          label:fast.getAttribute('aria-label'),disabled:fast.disabled}})()`),
      ).toEqual({
        aligned: true,
        width: 28,
        height: 28,
        background: 'rgba(0, 0, 0, 0)',
        border: '0px',
        pressed: 'false',
        label: 'Enable Fast mode',
        disabled: true,
      })
      await run('await new Promise(resolve=>setTimeout(resolve,160))')
      expect(
        await evaluate(`(() => {const menu=document.querySelector('.cxmp-menu').getBoundingClientRect();
        const disclosure=document.querySelector('.cxmp-model-disclosure').getBoundingClientRect();
        const reasoning=document.querySelector('.cxmp-model-controls').getBoundingClientRect();
        const search=document.querySelector('[aria-label="Search models"]').closest('.cxmp-search').getBoundingClientRect();
        const list=document.querySelector('.cxmp-model-options .cxmp-menu-scroll');
        return {searchVisible:search.top>=menu.top&&search.bottom<=menu.bottom,
          headerVisible:disclosure.top>=menu.top&&reasoning.bottom<=menu.bottom,
          listScrollable:list.scrollHeight>list.clientHeight}})()`),
      ).toEqual({ searchVisible: true, headerVisible: true, listScrollable: true })
      const manyHeight = await evaluate('window.menuGeometry().height') as number
      await run(`const search=document.querySelector('[aria-label="Search models"]');search.value='Model 95';
      search.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'5'}));
      await new Promise(resolve=>setTimeout(resolve,40))`)
      expect(await evaluate('document.querySelectorAll(".cxmp-model-choice").length')).toBe(1)
      expect(await evaluate('window.menuGeometry().height')).toBeLessThan(manyHeight)
      expect(await evaluate('Math.abs(window.menuGeometry().gap-6)<=1')).toBe(true)
      await run(
        `document.querySelector('[aria-label="Clear search"]').click();await new Promise(resolve=>setTimeout(resolve,40))`,
      )
      expect(await evaluate('window.menuGeometry().height')).toBeGreaterThan(manyHeight - 2)
      expect(await evaluate('Math.abs(window.menuGeometry().gap-6)<=1')).toBe(true)
      await run(
        `document.querySelector('.cxmp-model-disclosure').click();await new Promise(resolve=>setTimeout(resolve,60));
      document.querySelector('.cxmp-model-disclosure').click();await new Promise(resolve=>setTimeout(resolve,60))`,
      )
      expect(await evaluate('Math.abs(window.menuGeometry().gap-6)<=1')).toBe(true)
      expect(await evaluate('window.menuGeometry().top>=7&&window.menuGeometry().bottom<=413')).toBe(true)
      await run(`const search=document.querySelector('[aria-label="Search models"]');search.focus();
      search.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}));await Fixture.settle()`)
      expect(
        await evaluate(`(() => {const active=document.activeElement;const list=active.closest('.cxmp-menu-scroll');
        const row=active.getBoundingClientRect();const viewport=list.getBoundingClientRect();
        return {label:active.textContent,visible:row.top>=viewport.top-1&&row.bottom<=viewport.bottom+1}})()`),
      ).toEqual({ label: 'OpenRouter Model 95', visible: true })
      await run(
        `document.querySelector('.cxmp-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      await Fixture.settle()`,
      )
      expect(await evaluate('document.activeElement.classList.contains("cxmp-model-trigger")')).toBe(true)
      await run('document.querySelector(".cxmp-model-trigger").click(); await Fixture.settle()')
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      })
      await run('await Fixture.settle()')
      expect(await evaluate('document.activeElement.classList.contains("cxmp-model-trigger")')).toBe(true)
      await run(`document.querySelector('.cxmp-model-trigger').click(); await Fixture.settle();
      document.querySelector('.cxmp-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      document.getElementById('app').setAttribute('aria-hidden','true');
      window.raceDialog=document.createElement('div'); raceDialog.setAttribute('role','dialog'); raceDialog.setAttribute('aria-modal','true');
      raceDialog.innerHTML='<button id="race-focus">Confirm</button>';document.body.append(raceDialog); document.getElementById('race-focus').focus();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))); await Fixture.settle()`)
      expect(await evaluate('document.activeElement.id')).toBe('race-focus')
      await run(
        'raceDialog.remove(); document.getElementById("app").removeAttribute("aria-hidden"); await Fixture.settle()',
      )
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await run('await Fixture.modal(true)')
      expect(await evaluate('document.querySelector(".cxmp-model-trigger").disabled')).toBe(true)
      expect(
        await evaluate(
          `(() => {const r=document.querySelector('.cxmp-selector').getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth})()`,
        ),
      ).toBe(true)
      await run('await Fixture.modal(false)')
      expect(await evaluate('document.querySelector(".cxmp-model-trigger").disabled')).toBe(false)
      if (process.env.MODEL_SELECTOR_SCREENSHOT) {
        const screenshotPath = process.env.MODEL_SELECTOR_SCREENSHOT
        const capture = async (suffix: string) => {
          const rect = await evaluate(
            `(() => {const r=document.querySelector('.cxmp-menu').getBoundingClientRect();
          return {x:Math.max(0,r.x-12),y:Math.max(0,r.y-12),width:r.width+24,height:r.height+24}})()`,
          ) as { x: number; y: number; width: number; height: number }
          const screenshot = await cdp!.send('Page.captureScreenshot', {
            format: 'png',
            clip: { ...rect, scale: 2 },
          })
          await writeFile(`${screenshotPath}-${suffix}.png`, Buffer.from(screenshot.data as string, 'base64'))
        }
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: 1000,
          height: 800,
          deviceScaleFactor: 1,
          mobile: false,
        })
        await run(
          `document.documentElement.dataset.theme='light';document.body.style.background='#f7f7f7';document.body.style.color='#20242b';
        document.documentElement.style.cssText='--cx-surface:#fff;--cx-surface-raised:#fff;--cx-text:#20242b;--cx-muted:#667085;--cx-border:#d8dde6;--cx-hover:#f0f2f5;--cx-pressed:#e7eaf0;--cx-primary:#344054;--cx-focus:#667085;--cx-disabled:.5;--cx-danger:#b42318;--color-surface-elevated-secondary:#fff;--color-text-primary:#20242b;--color-text-tertiary:#667085;--color-border:#d8dde6;--color-background-primary-ghost-hover:#f0f2f5;--color-background-primary-soft-active:#e7eaf0';
        await Fixture.labels();document.querySelector('.cxmp-provider-trigger').click();await Fixture.settle()`,
        )
        expect(
          await evaluate(`[...document.querySelectorAll('.cxmp-provider-label')].map(label=>({
          text:label.textContent,singleLine:label.getBoundingClientRect().height<=label.closest('button').getBoundingClientRect().height,
          rowHeight:label.closest('button').getBoundingClientRect().height
        }))`),
        ).toEqual([
          { text: 'Empty adapter', singleLine: true, rowHeight: 30 },
          { text: 'ModelHub', singleLine: true, rowHeight: 30 },
          { text: 'OpenRouter', singleLine: true, rowHeight: 30 },
          {
            text: 'Custom Provider (Team-owned configuration with a deliberately long label)',
            singleLine: true,
            rowHeight: 30,
          },
          { text: 'Gateway', singleLine: true, rowHeight: 30 },
        ])
        expect(await evaluate(`document.querySelector('[aria-label="Search model services"]')!==null`)).toBe(true)
        expect(
          await evaluate(
            `document.querySelector('[aria-label="Search model services"]').closest('.cxmp-menu').lastElementChild
            ===document.querySelector('[aria-label="Search model services"]').closest('.cxmp-search')`,
          ),
        ).toBe(true)
        await capture('provider-light')
        const longLabelRect = await evaluate(
          `(() => {const r=document.querySelector('[data-provider-id="custom"] .cxmp-provider-label').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        ) as { x: number; y: number }
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: longLabelRect.x, y: longLabelRect.y })
        await run('await new Promise(resolve=>setTimeout(resolve,500))')
        expect(
          await evaluate(`document.querySelector('[data-provider-id="custom"] .cxmp-provider-label').dataset.overflow`),
        )
          .toBe('true')
        expect(
          await evaluate(
            `getComputedStyle(document.querySelector('[data-provider-id="custom"] .cxmp-provider-label-text')).transform`,
          ),
        )
          .not.toBe('none')
        await capture('provider-hover-light')
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
        await run('await new Promise(resolve=>setTimeout(resolve,500))')
        expect(
          await evaluate(
            `getComputedStyle(document.querySelector('[data-provider-id="custom"] .cxmp-provider-label-text')).transform`,
          ),
        )
          .toBe('none')
        await cdp.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        })
        expect(
          await evaluate(`getComputedStyle(document.querySelector('.cxmp-provider-label-text')).transitionDuration`),
        )
          .toBe('0s')
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: longLabelRect.x, y: longLabelRect.y })
        expect(
          await evaluate(
            `getComputedStyle(document.querySelector('[data-provider-id="custom"] .cxmp-provider-label-text')).transform`,
          ),
        )
          .toBe('none')
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
        await cdp.send('Emulation.setEmulatedMedia', { features: [] })
        await run('await new Promise(resolve=>setTimeout(resolve,500))')

        await run(
          `document.querySelector('.cxmp-provider-trigger').click();await Fixture.catalog(9);await Fixture.busy(false);
        document.querySelector('.cxmp-model-trigger').click();await Fixture.settle();window.modelMenuHeight=document.querySelector('.cxmp-menu').getBoundingClientRect().height;
        await Fixture.busy(true)`,
        )
        expect(await evaluate(`document.querySelector('.cxmp-menu').getBoundingClientRect().height`))
          .toBe(await evaluate('window.modelMenuHeight'))
        expect(
          await evaluate(`document.querySelector('.cxmp-menu').textContent.includes('Wait for the current response')`),
        )
          .toBe(false)
        expect(await evaluate(`document.querySelector('.cxmp-menu').querySelector('.cxmp-menu-heading')===null`)).toBe(
          true,
        )
        expect(await evaluate(`document.querySelector('.cxmp-model-choice').disabled`)).toBe(true)
        expect(await evaluate(`document.querySelector('input[type="search"]')!==null`)).toBe(true)
        expect(await evaluate(`document.querySelector('.cxmp-model-disclosure').getAttribute('aria-expanded')`))
          .toBe('false')
        await capture('model-compact-busy-light')
        await run(
          `document.querySelector('.cxmp-model-disclosure').click();await new Promise(resolve=>setTimeout(resolve,220));`,
        )
        expect(await evaluate(`document.querySelector('.cxmp-model-disclosure').getAttribute('aria-expanded')`))
          .toBe('true')
        expect(
          await evaluate(
            `(() => {const disclosure=document.querySelector('.cxmp-model-disclosure').getBoundingClientRect();
          const reasoning=document.querySelector('.cxmp-model-controls').getBoundingClientRect();
          const choice=document.querySelector('.cxmp-model-choice').getBoundingClientRect();
          const search=document.querySelector('[aria-label="Search models"]').closest('.cxmp-search').getBoundingClientRect();
          return reasoning.bottom<=disclosure.top&&disclosure.bottom<=choice.top&&choice.bottom<=search.top})()`,
          ),
        ).toBe(true)
        await capture('model-expanded-busy-light')
        await cdp.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        })
        expect(await evaluate(`getComputedStyle(document.querySelector('.cxmp-model-options')).transitionDuration`))
          .toBe('0s')
        expect(
          await evaluate(
            `getComputedStyle(document.querySelector('.cxmp-model-disclosure-chevron')).transitionDuration`,
          ),
        ).toBe('0s')
        await cdp.send('Emulation.setEmulatedMedia', { features: [] })

        await run(
          `document.querySelector('.cxmp-model-trigger').click();await Fixture.busy(false);document.documentElement.dataset.theme='dark';document.body.style.background='#111318';document.body.style.color='#edf0f4';
        document.documentElement.style.cssText='--cx-surface:#17191d;--cx-surface-raised:#20242b;--cx-text:#edf0f4;--cx-muted:#9ca5b5;--cx-border:#353a42;--cx-hover:#292e36;--cx-pressed:#323842;--cx-primary:#8aa4ff;--cx-focus:#8aa4ff;--cx-disabled:.5;--cx-danger:#ff8d85;--color-surface-elevated-secondary:#20242b;--color-text-primary:#edf0f4;--color-text-tertiary:#9ca5b5;--color-border:#353a42;--color-background-primary-ghost-hover:#292e36;--color-background-primary-soft-active:#323842';
        await Fixture.labels();document.querySelector('.cxmp-provider-trigger').click();await Fixture.settle()`,
        )
        await capture('provider-dark')

        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: 390,
          height: 844,
          deviceScaleFactor: 1,
          mobile: false,
        })
        await run(
          `document.querySelector('.cxmp-provider-trigger').click();await Fixture.catalog(9);await Fixture.busy(true);
        document.querySelector('.cxmp-model-trigger').click();await Fixture.settle();
        document.querySelector('.cxmp-model-disclosure').click();await new Promise(resolve=>setTimeout(resolve,220));`,
        )
        expect(
          await evaluate(
            `(() => {const r=document.querySelector('.cxmp-menu').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()`,
          ),
        )
          .toBe(true)
        expect(await evaluate(`document.querySelector('.cxmp-menu').querySelector('.cxmp-menu-heading')===null`)).toBe(
          true,
        )
        await capture('model-busy-narrow-dark')
      }
      await evaluate('disposeFixture()')
      expect(await evaluate('document.querySelectorAll(".cxmp-menu,[data-cordisx-model-provider-selector]").length'))
        .toBe(0)
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
  30_000,
)
