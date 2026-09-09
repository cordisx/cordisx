import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { connectLiveSmokeCdp } from './live-smoke/cdp-client.mjs'
const value = name => process.argv[process.argv.indexOf(name) + 1]
const cdp = await connectLiveSmokeCdp(Number(value('--port')))
const checks = []
const evaluate = async expression => {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  }
  return result.result.value
}
const wait = async expression => {
  for (let i = 0; i < 150; i++) {
    if (await evaluate(expression)) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`Timed out: ${expression}; body=${await evaluate('document.body.innerText.slice(-6000)')}`)
}
const click = async selector => {
  const rect = await evaluate(
    `(() => { const e = document.querySelector(${
      JSON.stringify(selector)
    }); if (!e) throw Error('Missing control'); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height} })()`,
  )
  assert.ok(rect.width && rect.height)
  await cdp.pointerClick(rect)
}
const captureCard = async file => {
  await wait(`getComputedStyle(document.querySelector('.cxn-card')).opacity === '1'`)
  const clip = await evaluate(
    `(() => { const r=document.querySelector('.cxn-card').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1} })()`,
  )
  await writeFile(file, Buffer.from((await cdp.send('Page.captureScreenshot', { clip })).data, 'base64'))
}
try {
  await cdp.send('Runtime.enable')
  await wait(`!!globalThis.__cordisxRuntime`)
  await evaluate(
    `(async () => { const plugin=__cordisxRuntime.snapshot().plugins.find(p=>p.id==='notifications-demo'); for (const point of ['app','sidebar.navigation.items']) await __cordisxRuntime.setExtensionPointPolicy(plugin.source,plugin.id,point,'allow') })()`,
  )
  await evaluate(`__cordisxRuntime.navigate('notifications-demo', {id:'main'})`)
  await wait(`!!document.querySelector('[data-notification-demo="error"]')`)
  await click('[data-notification-demo="error"]')
  await wait(`document.querySelector('.cxn-card')?.textContent.includes('无法连接来源')`)
  assert.equal(await evaluate(`!!document.querySelector('.cxn-source img')`), true)
  await click('button.cxn-source')
  assert.equal(await evaluate(`document.querySelectorAll('.cxn-card').length`), 1)
  checks.push('owner icon, clickable source and retained card')
  await evaluate(
    `Array.from(document.querySelectorAll('.cxn-card button')).find(e=>/详情|details/i.test(e.textContent)).click()`,
  )
  await wait(`!!document.querySelector('.cxn-card pre')`)
  await evaluate(`Array.from(document.querySelectorAll('.cxn-card button')).find(e=>e.textContent==='重试').click()`)
  await wait(`document.querySelector('.cxn-error')?.textContent.match(/操作未完成|Action failed/)`)
  checks.push('details expansion and retry failure remains')
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await captureCard('/tmp/notifications-dark.png')
  await click('.cxn-header button[aria-haspopup="menu"]')
  await wait(`document.querySelectorAll('.cxn-card [role="menuitem"]').length === 5`)
  await click('.cxn-card [role="menuitem"]')
  await wait(`document.querySelectorAll('.cxn-card').length === 0`)
  await click('[data-notification-demo="error"]')
  assert.equal(await evaluate(`document.querySelectorAll('.cxn-card').length`), 0)
  await evaluate(
    `Array.from(document.querySelectorAll('.cxn-undo button')).find(e=>/撤销|Undo/.test(e.textContent)).click()`,
  )
  await click('[data-notification-demo="error"]')
  await wait(`document.querySelectorAll('.cxn-card').length === 1`)
  checks.push('mute clears card and suppresses future; undo restores')
  await evaluate(`document.documentElement.setAttribute('data-theme','light')`)
  await wait(`document.querySelector('.cxn-root')?.dataset.cordisxAppTheme === 'light'`)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 740, deviceScaleFactor: 1, mobile: false })
  await captureCard('/tmp/notifications-light-mobile.png')
  const bounds = await evaluate(
    `(() => {const r=document.querySelector('.cxn-card').getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight}})()`,
  )
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height)
  checks.push('narrow viewport card bounds')
  await click('.cxn-header button[aria-haspopup="menu"]')
  await click('.cxn-card [role="menuitem"]')
  await evaluate(
    `Array.from(document.querySelectorAll('.cxn-undo button')).find(e=>/管理|Manage/.test(e.textContent)).click()`,
  )
  await wait(`document.querySelector('.cxn-rules')?.open`)
  assert.equal(await evaluate(`document.querySelectorAll('.cxn-rule').length`), 1)
  const saved = await evaluate(
    `Object.keys(localStorage).filter(k=>k.startsWith('cordisx:notifications:v1:')).map(k=>JSON.parse(localStorage.getItem(k)))`,
  )
  assert.ok(saved.some(rules => rules.some(rule => rule.kind === 'connection.failed')))
  await click('.cxn-rule button')
  await wait(`document.querySelectorAll('.cxn-rule').length === 0`)
  await click('.cxn-rules header button')
  checks.push('persistent rule management and restore')
  await click('[data-notification-demo="queue"]')
  await wait(`document.querySelectorAll('.cxn-card').length === 3`)
  assert.ok(await evaluate(`document.querySelector('.cxn-pending')?.textContent.includes('2')`))
  await click('.cxn-header button[aria-haspopup="menu"]')
  const menuBounds = await evaluate(
    `(() => { const m=document.querySelector('.cxn-menu'); m.scrollIntoView({block:'nearest'}); const r=m.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:innerHeight} })()`,
  )
  assert.ok(menuBounds.top >= 0 && menuBounds.bottom <= menuBounds.height)
  await cdp.pressKey('Escape', 'Escape', 27)
  await wait(`!document.querySelector('.cxn-menu')`)
  checks.push('short cards retain all menu items, Escape, and bounded queue')
  await evaluate(`__cordisxRuntime.dispose()`)
  assert.equal(await evaluate(`document.querySelectorAll('.cxn-root').length`), 0)
  checks.push('renderer disposal removes notification root')

  await writeFile(value('--report'), JSON.stringify({ status: 'passed', checks }, null, 2))
} catch (error) {
  await writeFile(value('--report'), JSON.stringify({ status: 'failed', checks, error: String(error) }, null, 2))
  throw error
} finally {
  cdp.socket.close()
}
