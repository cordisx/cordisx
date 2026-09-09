import { build } from 'esbuild'
import { type ChildProcess, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'

const executable = process.env.RESTRICTED_CHROME_EXECUTABLE

/** Opt-in isolated browser evidence. Never connects to or changes an existing browser/App. */
it.skipIf(!executable)(
  'real Chromium: literal-only rendering, numeric actions, rejection retry, no sink requests, disposal',
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'restricted-scene-chrome-'))
    const seen: string[] = []
    const bundle = await build({
      entryPoints: ['packages/cli/src/renderer/restricted-content/index.ts'],
      bundle: true,
      format: 'iife',
      globalName: 'RestrictedContent',
      write: false,
      platform: 'browser',
    })
    const server = createServer((request, response) => {
      seen.push(request.url ?? '')
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(
        `<html><head><title>Restricted scene browser evidence</title><style>body{font:16px system-ui;margin:24px;background:#fafafa;color:#242424}main{max-width:900px}</style></head><body><main></main><script>${
          bundle.outputFiles[0]!.text
        }</script></body></html>`,
      )
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    let chrome: ChildProcess | undefined
    let cdp: CdpSession | undefined
    try {
      chrome = spawn(executable!, [
        '--headless=new',
        // Match the other isolated browser fixture on Linux CI runners.
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        `--user-data-dir=${profile}`,
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--window-size=1000,1000',
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
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/fixture` })
      async function evaluate(expression: string): Promise<unknown> {
        const result = await cdp!.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        expect(result.exceptionDetails).toBeUndefined()
        return (result.result as { value?: unknown })?.value
      }
      for (let i = 0; i < 100; i++) {
        if (await evaluate('typeof RestrictedContent === "object"')) break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      const malicious =
        `<img src="http://localhost:${port}/leak/seat-secret" onerror="window.compromised=true"><script>fetch('http://127.0.0.1:${port}/leak/seat-secret');location='http://localhost:${port}/leak/navigation'</script>`
      expect(
        await evaluate(`(() => {
      window.compromised = false;
      window.actions = [];
      window.outcome = 'rejected';
      window.current = true;
      window.controller = new AbortController();
      window.seat = RestrictedContent.mountRestrictedScene({element:document.querySelector('main'),isCurrent:()=>window.current,signal:controller.signal,onAction:async action=>{actions.push(action);return {status:outcome}}});
      const scene = {version:1,root:{type:'stack',children:[
        {type:'text',text:${JSON.stringify(malicious)}},
        {type:'grid',columns:19,children:Array.from({length:361},(_,i)=>({type:'button',label:i===0?'●':'·',ariaLabel:'Cell '+i,action:{x:i%19,y:Math.floor(i/19)}}))},
        {type:'number-action',label:'Raise to',min:10,max:100,step:5,value:20,action:{type:'raise'},valueKey:'to'}
      ]}};
      window.scene = scene;
      return seat.publish({sequence:1,scene});
    })()`),
      ).toEqual({ status: 'accepted' })

      interface BrowserNode {
        nodeId: number
        backendNodeId: number
        nodeName: string
        attributes?: string[]
        children?: BrowserNode[]
        shadowRoots?: BrowserNode[]
      }
      async function findNode(predicate: (node: BrowserNode) => boolean): Promise<BrowserNode> {
        const tree = await cdp!.send('DOM.getDocument', { depth: -1, pierce: true })
        const visit = (node: BrowserNode): BrowserNode | undefined => {
          if (predicate(node)) return node
          for (const child of [...node.children ?? [], ...node.shadowRoots ?? []]) {
            const found = visit(child)
            if (found) return found
          }
          return undefined
        }
        const found = visit(tree.root as BrowserNode)
        expect(found).toBeTruthy()
        return found!
      }
      async function click(node: BrowserNode): Promise<void> {
        await cdp!.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendNodeId })
        const result = await cdp!.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId })
        const quad = (result.model as { content: number[] }).content
        const x = (quad[0]! + quad[2]!) / 2
        const y = (quad[1]! + quad[5]!) / 2
        await cdp!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
        await cdp!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      }
      const numeric = await findNode(node => node.nodeName === 'INPUT')
      const resolved = await cdp.send('DOM.resolveNode', { backendNodeId: numeric.backendNodeId })
      await cdp.send('Runtime.callFunctionOn', {
        objectId: (resolved.object as { objectId: string }).objectId,
        functionDeclaration: 'function(){this.value="35";this.dispatchEvent(new Event("input",{bubbles:true}))}',
      })
      const submit = await findNode(node => node.nodeName === 'BUTTON' && !node.attributes?.includes('aria-label'))
      await click(submit)
      expect(await evaluate('actions')).toEqual([{ sequence: 1, payload: { type: 'raise', to: 35 } }])
      await click(submit)
      expect(await evaluate('actions.length')).toBe(2)
      await evaluate('outcome="accepted"')
      await click(await findNode(node => node.nodeName === 'BUTTON' && node.attributes?.includes('Cell 17') === true))
      expect(await evaluate('actions[2]')).toEqual({ sequence: 1, payload: { x: 17, y: 0 } })
      await click(submit)
      expect(await evaluate('actions.length')).toBe(3)

      for (
        const root of [
          { type: 'image', src: `http://127.0.0.1:${port}/leak/image` },
          { type: 'html', html: malicious },
          { type: 'text', text: 'leak', style: `background:url(http://localhost:${port}/leak/style)` },
        ]
      ) {
        expect(
          await evaluate(
            `(() => {try {RestrictedContent.validateRestrictedScene(${
              JSON.stringify({ version: 1, root })
            });return false}catch{return true}})()`,
          ),
        ).toBe(true)
      }
      expect(await evaluate('compromised')).toBe(false)
      const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      const evidencePath = process.env.RESTRICTED_SCENE_SCREENSHOT ?? join(tmpdir(), 'restricted-scene-browser.png')
      await writeFile(evidencePath, Buffer.from(screenshot.data as string, 'base64'))
      await evaluate('controller.abort()')
      expect(await evaluate('document.querySelector("main").children.length')).toBe(0)
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(seen.filter(url => url.startsWith('/leak'))).toEqual([])
      const version = await cdp.send('Browser.getVersion')
      console.log(
        JSON.stringify({
          browser: version.product,
          sceneNodes: 364,
          requests: seen,
          sinkRequests: 0,
          actions: 3,
          screenshot: evidencePath,
        }),
      )
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
      // Chrome descendants can briefly finish writing after the parent exits.
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  30_000,
)
