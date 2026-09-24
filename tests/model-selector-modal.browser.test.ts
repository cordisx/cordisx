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
        expect(measurement.provider).toMatchObject({ timer: true, reads: 0, nodes: 13, models: 0 })
        expect(measurement.model.timer).toBe(true)
        expect(measurement.model.reads).toBe(0)
        expect(measurement.model.models).toBe(measurement.count)
        expect(measurement.provider.elapsed).toBeLessThan(250)
        expect(measurement.model.elapsed).toBeLessThan(1000)
      }
      if (process.env.MODEL_SELECTOR_MEASUREMENTS) console.info(JSON.stringify(catalogMeasurements))
      expect(catalogMeasurements.map(measurement => measurement.provider.nodes)).toEqual([13, 13, 13, 13])
      await run(`await Fixture.catalog(500);
      document.querySelector('.cxmp-model-trigger').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
      await Fixture.settle()`)
      expect(await evaluate('document.querySelectorAll(".cxmp-model-choice").length')).toBe(500)
      await run(`const search=document.querySelector('input[type=search]');search.value='Model 499';
      search.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'9'}));await Fixture.settle()`)
      expect(await evaluate('document.querySelectorAll(".cxmp-model-choice").length')).toBe(1)
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
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: 1000,
          height: 800,
          deviceScaleFactor: 1,
          mobile: false,
        })
        await run('await Fixture.modal(true)')
        const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' })
        await writeFile(process.env.MODEL_SELECTOR_SCREENSHOT, Buffer.from(screenshot.data as string, 'base64'))
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
