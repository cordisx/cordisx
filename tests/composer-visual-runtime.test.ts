import * as React from 'react'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComposerVisualRuntime } from '../packages/cli/src/renderer/composer-visual-runtime.js'
import type { ComposerVisualAuthority } from '../packages/cli/src/renderer/composer-visual-runtime.js'
import type { CordisXReactVisualProps } from '../packages/cli/src/extension-point-visual-contracts.js'

const cleanup: (() => void)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
  await new Promise(resolve => setTimeout(resolve, 30))
  vi.unstubAllGlobals()
})
function setup() {
  const dom = new JSDOM(
    '<div data-codex-composer-root data-composer-placement="home" style="position:relative"><div contenteditable="true" role="textbox"></div><div data-composer-footer-responsive><button class="size-token-button-composer" aria-label="Send" aria-busy="false" style="position:relative"><svg></svg></button></div></div>',
    { pretendToBeVisual: true },
  )
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  dom.window.Element.prototype.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    toJSON() {},
  })
  let reducedMotion = false
  const motionListeners = new Set<() => void>()
  Object.defineProperty(dom.window, 'matchMedia', {
    value: (query: string) => ({
      get matches() {
        return query.includes('reduced-motion') && reducedMotion
      },
      addEventListener: (_event: string, listener: () => void) => motionListeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => motionListeners.delete(listener),
    }),
  })
  const runtime = new ComposerVisualRuntime(dom.window.document)
  cleanup.push(() => dom.window.close(), () => runtime.dispose())
  let render = false, pointer = false
  const listeners = new Set<() => void>()
  const authority: ComposerVisualAuthority = {
    render: () => render,
    observePointer: () => pointer,
    subscribe: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return {
    runtime,
    document: dom.window.document,
    authority,
    grant(r: boolean, p = false) {
      render = r
      pointer = p
      for (const listener of listeners) listener()
    },
    listeners,
    motion(value: boolean) {
      reducedMotion = value
      for (const listener of motionListeners) listener()
    },
  }
}
function Visual({ state }: CordisXReactVisualProps) {
  return React.createElement(
    'svg',
    {
      'data-action': state.action,
      'data-pointer': state.pointer?.x ?? 'none',
      'data-motion': state.reducedMotion,
      'data-theme': state.theme,
    },
    React.createElement('circle', { r: 5, cx: 10, cy: 10 }),
  )
}
const loadVisual = async () => ({ kind: 'react-svg-v1' as const, component: Visual })

describe('controlled Composer visual lifecycle', () => {
  it('loads only after authority and availability, preserves the native button and immediately restores on deny', async () => {
    const f = setup()
    const load = vi.fn(loadVisual)
    const button = f.document.querySelector('button')!
    const nativeSvg = button.querySelector('svg')!
    const click = vi.fn()
    button.addEventListener('click', click)
    const unregister = f.runtime.register(
      'owner:generation:animal',
      { id: 'animal', pointId: 'composer.primary-action.visual' },
      load,
      f.authority,
    )
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(load).not.toHaveBeenCalled()
    f.grant(true)
    await vi.waitFor(() => expect(f.runtime.inspect().roots).toBe(1))
    expect(load).toHaveBeenCalledTimes(1)
    expect(f.document.querySelector('button')).toBe(button)
    expect(nativeSvg.style.visibility).toBe('hidden')
    button.click()
    expect(click).toHaveBeenCalledTimes(1)
    f.grant(false)
    expect(f.runtime.inspect().roots).toBe(0)
    expect(nativeSvg.style.visibility).toBe('')
    unregister()
    expect(f.listeners.size).toBe(0)
  })
  it('drops stale asynchronous loads after revocation and generation disposal', async () => {
    const f = setup()
    let resolve!: (v: Awaited<ReturnType<typeof loadVisual>>) => void
    const load = vi.fn(() =>
      new Promise<Awaited<ReturnType<typeof loadVisual>>>(r => {
        resolve = r
      })
    )
    f.grant(true)
    const unregister = f.runtime.register(
      'old',
      { id: 'animal', pointId: 'composer.primary-action.visual' },
      load,
      f.authority,
    )
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    unregister()
    resolve(await loadVisual())
    await new Promise(r => setTimeout(r, 40))
    expect(f.runtime.inspect().roots).toBe(0)
    f.runtime.register('new', { id: 'animal', pointId: 'composer.primary-action.visual' }, loadVisual, f.authority)
    await vi.waitFor(() => expect(f.runtime.inspect().roots).toBe(1))
    expect(f.document.querySelectorAll('[data-cordisx-composer-visual]').length).toBe(1)
  })
  it('remounts a replaced native anchor and clears separately denied pointer state', async () => {
    const f = setup()
    f.grant(true, true)
    f.runtime.register(
      'overlay',
      { id: 'animal', pointId: 'composer.frame.overlay', events: ['pointer.observe'] },
      loadVisual,
      f.authority,
    )
    await vi.waitFor(() => expect(f.runtime.inspect().roots).toBe(1))
    f.document.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 50, clientY: 50 }))
    await vi.waitFor(() => expect(f.document.querySelector('[data-pointer]')?.getAttribute('data-pointer')).toBe('0.5'))
    f.grant(true, false)
    await vi.waitFor(() =>
      expect(f.document.querySelector('[data-pointer]')?.getAttribute('data-pointer')).toBe('none')
    )
    const old = f.document.querySelector('button')!
    const replacement = old.cloneNode(true) as HTMLButtonElement
    replacement.setAttribute('aria-label', 'Stop')
    old.replaceWith(replacement)
    await vi.waitFor(() => expect(f.document.querySelector('[data-action]')?.getAttribute('data-action')).toBe('stop'))
    expect(f.runtime.inspect().roots).toBe(1)
    f.runtime.dispose()
    expect(f.document.querySelectorAll('[data-cordisx-composer-visual]').length).toBe(0)
    expect(f.listeners.size).toBe(0)
  })
})

it('updates theme and reduced-motion semantic props without remounting the native button', async () => {
  const f = setup()
  const button = f.document.querySelector('button')!
  f.grant(true)
  f.runtime.register('theme-owner', { id: 'theme', pointId: 'composer.primary-action.visual' }, loadVisual, f.authority)
  await vi.waitFor(() => expect(f.document.querySelector('[data-motion="false"]')).not.toBeNull())
  f.document.documentElement.classList.add('dark')
  f.motion(true)
  await vi.waitFor(() => expect(f.document.querySelector('[data-motion="true"][data-theme="dark"]')).not.toBeNull())
  expect(f.document.querySelector('button')).toBe(button)
  expect(f.runtime.inspect().roots).toBe(1)
})
