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
try {
  await cdp.send('Runtime.enable')
  await wait(`Array.from(document.querySelectorAll('button,a')).some(e=>e.textContent.includes('Notification demo'))`)
  await evaluate(
    `Array.from(document.querySelectorAll('button,a')).find(e=>e.textContent.includes('Notification demo')).click()`,
  )
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
  await wait(`document.querySelector('.cxn-card')?.textContent.match(/重试失败|操作未完成|Action failed|重试/)`)
  checks.push('details expansion and retry failure remains')
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await writeFile('/tmp/notifications-dark.png', Buffer.from((await cdp.send('Page.captureScreenshot')).data, 'base64'))
  await click('.cxn-header button[aria-haspopup="menu"]')
  await wait(`document.querySelectorAll('.cxn-card [role="menuitem"]').length === 5`)
  await click('.cxn-card [role="menuitem"]')
  await wait(`document.querySelectorAll('.cxn-card').length === 0`)
  await click('[data-notification-demo="error"]')
  assert.equal(await evaluate(`document.querySelectorAll('.cxn-card').length`), 0)
  await evaluate(
    `Array.from(document.querySelectorAll('.cxn-viewport button')).find(e=>/撤销|Undo/.test(e.textContent)).click()`,
  )
  await click('[data-notification-demo="error"]')
  await wait(`document.querySelectorAll('.cxn-card').length === 1`)
  checks.push('mute clears card and suppresses future; undo restores')
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 740, deviceScaleFactor: 1, mobile: false })
  await writeFile(
    '/tmp/notifications-light-mobile.png',
    Buffer.from((await cdp.send('Page.captureScreenshot')).data, 'base64'),
  )
  const bounds = await evaluate(
    `(() => {const r=document.querySelector('.cxn-card').getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight}})()`,
  )
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height)
  checks.push('narrow viewport card bounds')
  await writeFile(value('--report'), JSON.stringify({ status: 'passed', checks }, null, 2))
} catch (error) {
  await writeFile(value('--report'), JSON.stringify({ status: 'failed', checks, error: String(error) }, null, 2))
  throw error
} finally {
  cdp.socket.close()
}
