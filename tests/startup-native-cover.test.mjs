import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'
import { buildCoverSource } from '../packages/cli/native/startup-cover.cjs'
import { readNativeStartupReadiness } from '../packages/cli/src/renderer/adapter/startup-readiness.js'
import { releaseReadyStartup } from '../packages/cli/src/shortcuts/startup-release.js'
import { NATIVE_STARTUP_MARK_SELECTOR } from '../packages/cli/src/renderer/adapter/startup-presentation.js'

const css = await readFile(new URL('../packages/cli/native/startup-cover.css', import.meta.url), 'utf8')
const source = buildCoverSource({ generation: 'offline-run', url: 'app://-/index.html', css })
async function documentFixture(url = 'app://-/index.html') {
  const dom = new JSDOM('<!doctype html><html><body><main id="app"><input id="composer"></main></body></html>', {
    url,
    runScripts: 'outside-only',
  })
  // JSDOM has no modal/top-layer layout. This shim tests the lifecycle only.
  dom.window.HTMLDialogElement.prototype.showModal = function() {
    this.open = true
  }
  dom.window.HTMLDialogElement.prototype.close = function() {
    this.open = false
  }
  await new Promise(resolve => dom.window.addEventListener('load', resolve))
  dom.window.eval(source)
  return dom
}
const ready = receipt => ({ receipt, hostUsable: true, cordisxReady: true, authenticated: true })

test('production workspace proof removes the modal and restores input without reading an account', async () => {
  const dom = await documentFixture()
  const w = dom.window
  try {
    w.document.body.innerHTML = '<textarea></textarea><button data-cordisx-model-ready="true">Model</button>'
    for (const element of w.document.querySelectorAll('textarea,button')) {
      element.getBoundingClientRect = () => ({ width: 10, height: 10 })
    }
    w.__cordisxRuntime = {}
    w.__cordisxCompositionBoot = Promise.resolve()
    w.__cordisxProductionInstallId = 'production-install'
    w.__cordisxProductionBootstrapState = { installId: 'production-install', status: 'evaluated' }
    const api = w.__cordisxStartupDocument
    const dialog = w.document.querySelector('dialog')
    assert.equal(api.ownsDialog(dialog, api.snapshot().receipt), true)
    assert.equal(api.ownsDialog(w.document.createElement('dialog'), api.snapshot().receipt), false)
    let clicks = 0
    w.document.querySelector('button').addEventListener('click', () => clicks++)
    w.document.querySelector('button').click()
    assert.equal(clicks, 0)
    const proof = await w.eval(`(${readNativeStartupReadiness.toString()})(undefined)`)
    assert.equal(proof.ready, true)
    assert.equal(proof.surface, 'workspace-ready')
    assert.equal(Object.hasOwn(proof.observations, 'authenticated'), false)
    assert.equal(api.release({ ...proof.receipt, nonce: 'wrong-document' }, proof.observations), false)
    assert.equal(api.release(proof.receipt, { ...proof.observations, cordisxReady: false }), false)
    assert.equal(api.release(proof.receipt, { ...proof.observations, receipt: { nonce: 'wrong-document' } }), false)
    const released = await w.eval(
      `(${releaseReadyStartup.toString()})(${readNativeStartupReadiness.toString()},undefined)`,
    )
    assert.equal(released.released, true)
    assert.ok(released.releasedAt >= w.performance.timeOrigin)
    assert.equal(api.snapshot().phase, 'released')
    assert.equal(api.snapshot().mounted, false)
    assert.equal(api.snapshot().modal, false)
    w.document.querySelector('button').click()
    assert.equal(clicks, 1)
    assert.equal(w.document.querySelector('dialog'), null)
  } finally {
    w.close()
  }
})

test('a retired document cannot release after an outstanding renderer proof settles', async () => {
  const dom = await documentFixture()
  const w = dom.window
  try {
    const api = w.__cordisxStartupDocument
    const receipt = api.snapshot().receipt
    let resolve
    w.pendingProof = new Promise(done => {
      resolve = done
    })
    const completion = w.eval(`(${releaseReadyStartup.toString()})(() => globalThis.pendingProof,undefined)`)
    api.retire(receipt)
    resolve({ ready: true, receipt, observations: ready(receipt) })
    const result = await completion
    assert.equal(result.released, false)
    assert.equal(result.releasedAt, undefined)
    assert.equal(api.snapshot().phase, 'retired')
  } finally {
    w.close()
  }
})

test('explicit login usability releases input without claiming authentication', async () => {
  const dom = await documentFixture()
  const w = dom.window
  try {
    const api = dom.window.__cordisxStartupDocument
    const receipt = api.snapshot().receipt
    const dialog = w.document.querySelector('dialog')
    const backdrop = [...w.document.querySelectorAll('style')].find(style => style.textContent.includes('::backdrop'))
    assert.equal(dialog.style.background, 'transparent')
    assert.ok(backdrop.textContent.includes(`#${dialog.id}::backdrop { background: transparent; }`))
    assert.equal(api.release(receipt, { receipt, hostUsable: true, authenticated: false }), false)
    assert.equal(api.release(receipt, { receipt, hostUsable: true, loginUsable: true }), false)
    const observations = { receipt, hostUsable: true, cordisxReady: true, loginUsable: true }
    assert.equal(api.release(receipt, observations), true)
    assert.equal(Object.hasOwn(observations, 'authenticated'), false)
    assert.equal(backdrop.isConnected, false)
  } finally {
    dom.window.close()
  }
})

test('explicit signed-out login usability remains accepted', async () => {
  const dom = await documentFixture()
  const w = dom.window
  try {
    const api = dom.window.__cordisxStartupDocument
    const receipt = api.snapshot().receipt
    assert.equal(api.release(receipt, { receipt, hostUsable: true, authenticated: false, loginUsable: true }), true)
    assert.equal(api.snapshot().phase, 'released')
    assert.equal(dom.window.document.querySelector('dialog'), null)
  } finally {
    dom.window.close()
  }
})

test.each(
  ['release', 'retire', 'fail'].flatMap(outcome =>
    ['relative size-full', 'absolute inset-0'].map(layout => [outcome, layout])
  ),
)('restores only the native splash marks on %s (%s)', async (outcome, layout) => {
  const dom = await documentFixture('about:blank')
  const w = dom.window
  try {
    w.document.body.innerHTML =
      '<div id="root"><div class="startup-loader" aria-hidden="true"><div class="startup-loader__logo">Native splash</div></div><div class="startup-loader__logo" id="ordinary">Application logo</div></div>'
    w.eval(
      buildCoverSource({
        generation: 'splash-scope',
        url: 'about:blank',
        css,
        nativeMarkSelector: NATIVE_STARTUP_MARK_SELECTOR,
      }),
    )
    let mark = w.document.querySelector(NATIVE_STARTUP_MARK_SELECTOR)
    const ordinary = w.document.querySelector('#ordinary')
    assert.equal(w.getComputedStyle(mark).visibility, 'hidden')
    assert.equal(w.getComputedStyle(ordinary).visibility, 'visible')
    w.document.querySelector('.startup-loader').outerHTML =
      `<div role="presentation" class="${layout} bg-transparent"><div class="flex flex-col items-center gap-2"><div aria-hidden="true" class="_Root_yklzu_11 size-14">React fallback</div></div></div>`
    await Promise.resolve()
    mark = w.document.querySelector(NATIVE_STARTUP_MARK_SELECTOR)
    assert.equal(w.getComputedStyle(mark).visibility, 'hidden')
    const api = w.__cordisxStartupDocument, receipt = api.snapshot().receipt
    assert.equal(outcome === 'release' ? api.release(receipt, ready(receipt)) : api[outcome](receipt), true)
    await Promise.resolve()
    assert.equal(w.getComputedStyle(mark).visibility, 'visible')
    assert.equal(mark.hasAttribute('data-cordisx-startup-mark'), false)
    assert.equal(w.getComputedStyle(ordinary).visibility, 'visible')
  } finally {
    w.close()
  }
})

test('cancellation retires the observer, modal and input listeners without ready observations', async () => {
  const dom = await documentFixture()
  const w = dom.window
  try {
    const api = w.__cordisxStartupDocument
    assert.equal(api.retire({ ...api.snapshot().receipt, nonce: 'stale' }), false)
    assert.equal(api.retire(api.snapshot().receipt), true)
    w.document.body.innerHTML = '<button>Native control</button>'
    await Promise.resolve()
    let clicks = 0
    w.document.querySelector('button').addEventListener('click', () => clicks++)
    w.document.querySelector('button').click()
    assert.equal(clicks, 1)
    assert.equal(api.snapshot().phase, 'retired')
    assert.equal(w.document.querySelector('dialog'), null)
    assert.equal(w.document.querySelector('style'), null)
  } finally {
    w.close()
  }
})

test('body replacement stays covered; unready or stale receipts cannot release; cleanup restores input', async () => {
  const dom = await documentFixture()
  const { window: w } = dom
  try {
    const api = w.__cordisxStartupDocument
    const receipt = api.snapshot().receipt
    let input = 0
    w.document.addEventListener('keydown', () => input++)
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    assert.equal(input, 0)
    w.document.body.innerHTML = '<main>replaced application</main>'
    await Promise.resolve()
    assert.equal(api.snapshot().mounted, true)
    assert.equal(api.release(receipt, { ...ready(receipt), authenticated: false }), false)
    assert.equal(api.release({ ...receipt, nonce: 'previous-document' }, ready(receipt)), false)
    assert.equal(api.release(receipt, ready(receipt)), true)
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    assert.equal(input, 1)
    assert.equal(w.document.querySelector('dialog'), null)
  } finally {
    w.close()
  }
})

test('reload creates a new nonce and installs cover again; prior document cannot release it', async () => {
  const first = await documentFixture()
  const second = await documentFixture()
  try {
    const old = first.window.__cordisxStartupDocument.snapshot().receipt
    const next = second.window.__cordisxStartupDocument
    assert.notEqual(next.snapshot().receipt.nonce, old.nonce)
    assert.equal(next.snapshot().modal, true)
    assert.equal(next.release(next.snapshot().receipt, ready(old)), false)
    assert.equal(next.release(old, ready(old)), false)
    assert.equal(next.fail(next.snapshot().receipt), true)
    assert.equal(next.release(next.snapshot().receipt, ready(next.snapshot().receipt)), false)
  } finally {
    first.window.close()
    second.window.close()
  }
})

test('unrelated and auxiliary routes do not receive startup UI', async () => {
  for (const url of ['https://example.com', 'app://-/index.html?initialRoute=avatar-overlay']) {
    const dom = await documentFixture(url)
    assert.equal(dom.window.__cordisxStartupDocument, undefined)
    dom.window.close()
  }
})

test('installation before documentElement mounts when parser supplies the root', async () => {
  const dom = await documentFixture('about:blank')
  const w = dom.window
  try {
    w.document.documentElement.remove()
    w.eval(buildCoverSource({ generation: 'before-parser', url: 'about:blank', css }))
    const api = w.__cordisxStartupDocument
    assert.equal(api.snapshot().mounted, false)
    const html = w.document.createElement('html')
    html.append(w.document.createElement('body'))
    w.document.append(html)
    await Promise.resolve()
    assert.equal(api.snapshot().mounted, true)
    w.dispatchEvent(new w.Event('pagehide'))
    assert.equal(api.snapshot().phase, 'retired')
    assert.equal(api.release(api.snapshot().receipt, ready(api.snapshot().receipt)), false)
  } finally {
    w.close()
  }
})
