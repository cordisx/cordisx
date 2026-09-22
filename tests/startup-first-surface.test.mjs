import { test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'
import { buildCoverSource } from '../packages/cli/native/startup-cover.cjs'
import {
  NATIVE_STARTUP_MARK_SELECTOR,
  NATIVE_STARTUP_SURFACE,
} from '../packages/cli/src/renderer/adapter/startup-presentation.js'
import { readNativeStartupReadiness } from '../packages/cli/src/renderer/adapter/startup-readiness.js'
import { releaseReadyStartup } from '../packages/cli/src/shortcuts/startup-release.js'

const css = await readFile(new URL('../packages/cli/native/startup-cover.css', import.meta.url), 'utf8')
const source = buildCoverSource({
  generation: 'first-surface',
  url: 'app://-/index.html',
  css,
  nativeMarkSelector: NATIVE_STARTUP_MARK_SELECTOR,
  nativeSurface: NATIVE_STARTUP_SURFACE,
})
const shell =
  '<main><header data-app-shell-application-menu-bar></header><section data-app-shell-focus-area="main"><div data-vscode-context><button>Native action</button></div></section></main>'
const ready = receipt => ({ receipt, hostUsable: true, cordisxReady: true, workspaceUsable: true })
async function fixture() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'app://-/index.html',
    runScripts: 'outside-only',
  })
  const w = dom.window
  await new Promise(resolve => w.addEventListener('load', resolve))
  w.HTMLDialogElement.prototype.showModal = function() {
    this.open = true
  }
  w.HTMLDialogElement.prototype.show = function() {
    this.open = true
  }
  w.HTMLDialogElement.prototype.close = function() {
    this.open = false
  }
  w.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 800, height: 600 })
  const frames = new Map()
  let frameId = 0
  w.requestAnimationFrame = callback => {
    frames.set(++frameId, callback)
    return frameId
  }
  w.cancelAnimationFrame = id => frames.delete(id)
  let shadow
  const attach = w.HTMLElement.prototype.attachShadow
  w.HTMLElement.prototype.attachShadow = function(options) {
    shadow = attach.call(this, options)
    return shadow
  }
  w.eval(source)
  return { dom, w, frames, shadow, api: w.__cordisxStartupDocument, root: w.document.getElementById('root') }
}
const flush = async () => {
  for (let turn = 0; turn < 5; turn++) await Promise.resolve()
}

test('first native shell removes the cover and input barrier before editor, model or boot readiness', async () => {
  const { w, api, root, frames } = await fixture()
  try {
    assert.equal(api.snapshot().modal, true)
    root.innerHTML = shell
    await flush()
    assert.equal(api.snapshot().phase, 'presented')
    assert.equal(api.snapshot().mounted, false)
    assert.equal(api.snapshot().modal, false)
    assert.ok(Number.isFinite(api.snapshot().presentationReleasedAt))
    assert.equal(w.document.querySelector('dialog'), null)
    assert.equal(frames.size, 0)
    let clicks = 0
    root.querySelector('button').addEventListener('click', () => clicks++)
    root.querySelector('button').click()
    assert.equal(clicks, 1)
    const result = await w.eval(`(${readNativeStartupReadiness.toString()})(undefined)`)
    assert.equal(result.ready, false)
    assert.equal(result.reason, 'native-controls-pending')
    assert.equal(api.release(api.snapshot().receipt, { receipt: api.snapshot().receipt, hostUsable: true }), false)
  } finally {
    w.close()
  }
})

test('static splash, React fallback, arbitrary main, and shell chrome alone do not authorize presentation', async () => {
  const { w, api, root } = await fixture()
  try {
    for (
      const markup of [
        '<div class="startup-loader" aria-hidden="true"><div class="startup-loader__logo"></div></div>',
        '<div role="presentation" class="relative size-full bg-transparent"><div class="flex flex-col items-center gap-2"><div class="_Root_yklzu_11 size-14" aria-hidden="true"></div></div></div>',
        '<main><h1>Loading</h1><button>Retry</button></main>',
        '<header data-app-shell-application-menu-bar></header>',
        '<section data-app-shell-focus-area="main"></section>',
        '<main><header data-app-shell-application-menu-bar></header><section data-app-shell-focus-area="main"></section></main>',
        '<main><header data-app-shell-application-menu-bar></header></main><main><section data-app-shell-focus-area="main"><div data-vscode-context></div></section></main>',
      ]
    ) {
      root.innerHTML = markup
      await flush()
      assert.equal(api.snapshot().phase, 'covered')
      assert.equal(api.snapshot().modal, true)
    }
  } finally {
    w.close()
  }
})

test.each(['hidden', 'opacity', 'aria-hidden', 'inert', 'offscreen', 'ambiguous'])(
  'waits for actual native surface visibility: %s',
  async kind => {
    const { w, api, root } = await fixture()
    try {
      root.innerHTML = shell
      const main = root.querySelector('section')
      if (kind === 'hidden') main.hidden = true
      if (kind === 'opacity') main.style.opacity = '0'
      if (kind === 'aria-hidden') main.setAttribute('aria-hidden', 'true')
      if (kind === 'inert') main.setAttribute('inert', '')
      if (kind === 'offscreen') {
        main.getBoundingClientRect = () => ({ width: 800, height: 600, left: 2000, top: 0, right: 2800, bottom: 600 })
      }
      if (kind === 'ambiguous') main.parentElement.append(main.cloneNode(true))
      await flush()
      assert.equal(api.snapshot().phase, 'covered')
      if (kind === 'offscreen') delete main.getBoundingClientRect
      main.hidden = false
      main.style.opacity = '1'
      main.removeAttribute('aria-hidden')
      main.removeAttribute('inert')
      if (kind === 'ambiguous') main.nextElementSibling.remove()
      await flush()
      assert.equal(api.snapshot().phase, 'presented')
    } finally {
      w.close()
    }
  },
)

test('full runtime readiness remains independent and releases the same presented receipt', async () => {
  const { w, api, root } = await fixture()
  try {
    root.innerHTML = shell
    await flush()
    const receipt = api.snapshot().receipt
    root.querySelector('[data-vscode-context]').innerHTML =
      '<textarea></textarea><button data-cordisx-model-ready="true">Model</button>'
    w.__cordisxRuntime = {}
    w.__cordisxBoot = Promise.resolve()
    assert.equal(api.release({ ...receipt, nonce: 'stale' }, ready(receipt)), false)
    const result = await w.eval(
      `(${releaseReadyStartup.toString()})(${readNativeStartupReadiness.toString()},undefined)`,
    )
    assert.equal(result.released, true)
    assert.equal(result.surface, 'workspace-ready')
    assert.equal(result.observations.authenticated, undefined)
    assert.equal(api.snapshot().phase, 'released')
  } finally {
    w.close()
  }
})

test.each(['before', 'after'])(
  'failure %s first presentation remains actionable without remounting a modal over the shell',
  async timing => {
    const { w, api, root, shadow } = await fixture()
    try {
      if (timing === 'before') assert.equal(api.fail(api.snapshot().receipt), true)
      root.innerHTML = shell
      await flush()
      if (timing === 'after') assert.equal(api.fail(api.snapshot().receipt), true)
      assert.equal(api.snapshot().phase, 'failed')
      assert.equal(api.snapshot().mounted, true)
      assert.equal(api.snapshot().modal, false)
      const recovery = w.document.querySelector('dialog')
      assert.equal(recovery.style.height, 'auto')
      assert.equal(recovery.style.width, '360px')
      let clicks = 0
      root.querySelector('button').addEventListener('click', () => clicks++)
      root.querySelector('button').click()
      assert.equal(clicks, 1)
      shadow.querySelector('button').click()
      assert.equal(api.snapshot().requestedAction, 'retry')
      shadow.querySelectorAll('button')[1].click()
      assert.equal(api.snapshot().requestedAction, 'close')
      assert.equal(api.retire(api.snapshot().receipt), true)
      assert.equal(w.document.querySelector('dialog'), null)
    } finally {
      w.close()
    }
  },
)

test('presentation disconnects observers and geometry checks; later body changes cannot restore the cover', async () => {
  const { w, api, root, frames } = await fixture()
  try {
    const disconnect = vi.spyOn(w.MutationObserver.prototype, 'disconnect')
    root.innerHTML = shell
    await flush()
    assert.equal(disconnect.mock.calls.length, 1)
    assert.equal(frames.size, 0)
    w.document.body.innerHTML = '<div id="root">next native content</div>'
    w.dispatchEvent(new w.Event('resize'))
    await flush()
    assert.equal(api.snapshot().phase, 'presented')
    assert.equal(w.document.querySelector('dialog'), null)
    assert.equal(frames.size, 0)
    w.dispatchEvent(new w.Event('pagehide'))
    assert.equal(api.snapshot().phase, 'retired')
  } finally {
    w.close()
  }
})

test('retired documents cannot present or release replacement navigation, which has its own nonce', async () => {
  const first = await fixture()
  const next = await fixture()
  try {
    const old = first.api.snapshot().receipt
    first.w.dispatchEvent(new first.w.Event('pagehide'))
    first.root.innerHTML = shell
    await flush()
    assert.equal(first.api.snapshot().phase, 'retired')
    assert.equal(first.frames.size, 0)
    next.root.innerHTML = shell
    await flush()
    assert.notEqual(next.api.snapshot().receipt.nonce, old.nonce)
    assert.equal(next.api.release(old, ready(old)), false)
    assert.equal(next.api.snapshot().phase, 'presented')
  } finally {
    first.w.close()
    next.w.close()
  }
})
