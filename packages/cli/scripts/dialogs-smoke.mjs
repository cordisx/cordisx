import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { connectLiveSmokeCdp } from './live-smoke/cdp-client.mjs'
const value = name => process.argv[process.argv.indexOf(name) + 1]
const cdp = await connectLiveSmokeCdp(Number(value('--port')))
const checks = []
const evaluate = async expression => {
  const reply = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (reply.exceptionDetails) {
    throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text)
  }
  return reply.result.value
}
const wait = async expression => {
  for (let index = 0; index < 150; index++) {
    if (await evaluate(expression)) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`Timed out: ${expression}; ${await evaluate('document.body.innerText.slice(-3000)')}`)
}
const click = async expression => {
  const rect = await evaluate(
    `(() => { const e = ${expression}; if (!e) throw Error('Missing control'); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height} })()`,
  )
  assert.ok(rect.width && rect.height)
  await cdp.pointerClick(rect)
}
// CDP inspection of a closed shadow root is maintainer-only test instrumentation.
const selectShell = async () => {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
  const nodes = []
  const visit = node => {
    if (node.localName === 'dialog' && (node.attributes ?? []).includes('data-size')) nodes.push(node)
    for (const child of [...node.children ?? [], ...node.shadowRoots ?? []]) visit(child)
  }
  visit(root)
  assert.ok(nodes.length)
  const { object } = await cdp.send('DOM.resolveNode', { nodeId: nodes.at(-1).nodeId })
  await cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: 'function(){ globalThis.__dialogSmokeShell = this.getRootNode(); }',
  })
  await cdp.send('Runtime.releaseObject', { objectId: object.objectId })
}
try {
  await wait('!!globalThis.__cordisxRuntime')
  await evaluate(
    `(async () => { const p=__cordisxRuntime.snapshot().plugins.find(p=>p.id==='dialogs-demo'); if (!p) throw Error('Dialog plugin unavailable'); for (const point of ['app','sidebar.navigation.items']) await __cordisxRuntime.setExtensionPointPolicy(p.source,p.id,point,'allow'); })()`,
  )
  await evaluate(`__cordisxRuntime.navigate('dialogs-demo',{id:'main'})`)
  await wait(`!!document.querySelector('[data-dialog-demo=jsx]')`)
  await click(`document.querySelector('[data-dialog-demo=jsx]')`)
  await wait(`!!document.querySelector('[data-dialog-context=room-context]')`)
  await selectShell()
  assert.equal(
    await evaluate(`__dialogSmokeShell.querySelector('.header-actions').lastElementChild.dataset.dialogClose`),
    'true',
  )
  assert.equal(await evaluate(`getComputedStyle(__dialogSmokeShell.querySelector('dialog')).position`), 'fixed')
  await click(`document.querySelector('[data-dialog-counter]')`)
  await wait(`document.querySelector('[data-dialog-context]').textContent.includes('3/4')`)
  checks.push('production injection, JSX context/state, fixed rightmost Host close')
  await evaluate(`document.documentElement.setAttribute('data-theme','dark')`)
  await wait(`document.querySelector('[data-cordisx-dialog]').dataset.cordisxAppTheme === 'dark'`)
  await writeFile('/tmp/dialogs-dark.png', Buffer.from((await cdp.send('Page.captureScreenshot')).data, 'base64'))
  await click(`__dialogSmokeShell.querySelector('[data-action=join]')`)
  await wait(`!!document.querySelector('[data-cordisx-dialog] .cxn-card')`)
  checks.push('operation error uses the existing notification viewport inside native modal')
  await click(`document.querySelector('[data-dialog-child]')`)
  await wait(`document.querySelectorAll('[data-cordisx-dialog]').length === 2`)
  await selectShell()
  await click(`__dialogSmokeShell.querySelector('[data-action=confirm]')`)
  await wait(`document.querySelectorAll('[data-cordisx-dialog]').length === 1`)
  await wait(`document.querySelector('[data-dialog-context]').textContent.includes('2/4')`)
  checks.push('child confirmation returns to parent with live React state')
  await selectShell()
  await evaluate(`document.documentElement.setAttribute('data-theme','light')`)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 740, deviceScaleFactor: 1, mobile: false })
  await wait(`document.querySelector('[data-cordisx-dialog]').dataset.cordisxAppTheme === 'light'`)
  const bounds = await evaluate(
    `(() => { const r=__dialogSmokeShell.querySelector('dialog').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight} })()`,
  )
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.top >= 0 && bounds.bottom <= bounds.height)
  await writeFile(
    '/tmp/dialogs-light-mobile.png',
    Buffer.from((await cdp.send('Page.captureScreenshot')).data, 'base64'),
  )
  const original = await evaluate(`getComputedStyle(__dialogSmokeShell.querySelector('[data-dialog-close]')).width`)
  await evaluate(
    `(() => {const style=document.createElement('style'); style.textContent='header button { width: 500px !important; background: red !important; }'; style.id='dialog-css-probe';document.head.append(style)})()`,
  )
  assert.equal(
    await evaluate(`getComputedStyle(__dialogSmokeShell.querySelector('[data-dialog-close]')).width`),
    original,
  )
  await evaluate(`document.querySelector('#dialog-css-probe').remove()`)
  checks.push('light/narrow bounds and chrome resistance to plugin header-button CSS')
  await cdp.pressKey('Escape', 'Escape', 27)
  await wait(`document.querySelectorAll('[data-cordisx-dialog]').length === 0`)
  await wait(`document.activeElement?.getAttribute('data-dialog-demo') === 'jsx'`)
  checks.push('native Escape and focus restoration')
  await click(`document.querySelector('[data-dialog-demo=registered]')`)
  await wait(`!!document.querySelector('textarea[aria-label=Notes]')`)
  await evaluate('__cordisxRuntime.dispose()')
  assert.equal(await evaluate(`document.querySelectorAll('[data-cordisx-dialog]').length`), 0)
  checks.push('registered React view and renderer disposal cleanup')
  await writeFile(value('--report'), JSON.stringify({ status: 'passed', checks }, null, 2))
} catch (error) {
  await writeFile(value('--report'), JSON.stringify({ status: 'failed', checks, error: String(error) }, null, 2))
  throw error
} finally {
  cdp.socket.close()
}
