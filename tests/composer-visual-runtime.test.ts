import * as React from 'react'
import { defineReactVisual } from '../packages/cli/src/react.js'
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
  let render = false, pointer = false, drag = false
  const listeners = new Set<() => void>()
  const authority: ComposerVisualAuthority = {
    render: () => render,
    observePointer: () => pointer,
    drag: () => drag,
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
    grant(r: boolean, p = false, d = false) {
      render = r
      pointer = p
      drag = d
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
      'data-pointer-y': state.pointer?.y ?? 'none',
      'data-height': state.bounds.height,
      'data-dictation': state.schemaVersion === 2 ? state.dictation : 'v1',
      'data-motion': state.reducedMotion,
      'data-theme': state.theme,
    },
    React.createElement('circle', { r: 5, cx: 10, cy: 10 }),
  )
}
const loadVisual = async () => ({ kind: 'react-svg-v1' as const, component: Visual })

describe('controlled Composer visual lifecycle', () => {
  it('mounts an explicitly declared DOM visual inertly and disposes its effects on revoke', async () => {
    const f = setup()
    const button = f.document.querySelector('button')!
    button.style.setProperty('background-color', 'red', 'important')
    const disposed = vi.fn()
    function DomVisual() {
      React.useEffect(() => disposed, [])
      return React.createElement('div', { 'data-real-avatar': true }, React.createElement('span', null, 'face'))
    }
    expect(defineReactVisual(Visual).kind).toBe('react-svg-v1')
    const visual = defineReactVisual(DomVisual, { kind: 'react-dom-v1' })
    f.runtime.register(
      'dom',
      { id: 'avatar', pointId: 'composer.primary-action.visual' },
      async () => visual,
      f.authority,
    )
    f.grant(true)
    await vi.waitFor(() => expect(f.document.querySelector('[data-real-avatar]')).not.toBeNull())
    const root = f.document.querySelector<HTMLElement>('[data-cordisx-composer-visual]')!
    expect(button.style.backgroundColor).toBe('transparent')
    expect(root.hasAttribute('inert')).toBe(true)
    expect(root.style.pointerEvents).toBe('none')
    expect(root.style.overflow).toBe('hidden')
    f.grant(false)
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce())
    expect(f.document.querySelector('[data-real-avatar]')).toBeNull()
    expect(button.style.backgroundColor).toBe('red')
    expect(button.style.getPropertyPriority('background-color')).toBe('important')
    expect(f.document.querySelector<SVGElement>('button > svg')!.style.visibility).toBe('')
  })

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
    f.document.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 50, clientY: -64 }))
    await vi.waitFor(() => expect(f.document.querySelector('[data-pointer]')?.getAttribute('data-pointer')).toBe('0.5'))
    const overlay = f.document.querySelector<HTMLElement>('[data-cordisx-composer-visual]')!
    expect(overlay.style.bottom).toBe('100%')
    expect(overlay.style.height).toBe('128px')
    expect(overlay.style.overflow).toBe('hidden')
    expect(overlay.style.pointerEvents).toBe('none')
    expect(overlay.querySelector('[data-height]')?.getAttribute('data-height')).toBe('128')
    expect(overlay.querySelector('[data-pointer-y]')?.getAttribute('data-pointer-y')).toBe('0.5')
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

it('adds dictation only for renderers that opt into v2', async () => {
  const f = setup()
  const microphone = f.document.createElement('button')
  microphone.setAttribute('aria-label', 'Stop dictation')
  f.document.querySelector('[data-composer-footer-responsive]')!.append(microphone)
  f.grant(true)
  f.runtime.register('legacy', { id: 'legacy', pointId: 'composer.primary-action.visual' }, loadVisual, f.authority)
  f.runtime.register('v2', { id: 'v2', pointId: 'composer.frame.overlay', snapshotVersion: 2 }, loadVisual, f.authority)
  await vi.waitFor(() => expect(f.document.querySelector('[data-dictation="recording"]')).not.toBeNull())
  expect(
    f.document.querySelector('[data-cordisx-composer-visual="composer.primary-action.visual"] [data-dictation]')
      ?.getAttribute('data-dictation'),
  ).toBe('v1')
  microphone.setAttribute('aria-busy', 'true')
  await vi.waitFor(() => expect(f.document.querySelector('[data-dictation="transcribing"]')).not.toBeNull())
})

it('keeps both visuals across the native waveform dictation footer replacement', async () => {
  const f = setup()
  f.grant(true)
  f.runtime.register('primary', { id: 'primary', pointId: 'composer.primary-action.visual' }, loadVisual, f.authority)
  f.runtime.register(
    'orb',
    { id: 'orb', pointId: 'composer.frame.overlay', snapshotVersion: 2 },
    loadVisual,
    f.authority,
  )
  await vi.waitFor(() => expect(f.runtime.inspect().roots).toBe(2))
  const editor = f.document.querySelector<HTMLElement>('[contenteditable]')!
  editor.setAttribute('contenteditable', 'false')
  editor.style.visibility = 'hidden'
  const footer = f.document.querySelector('[data-composer-footer-responsive]')!
  const inputFooter = f.document.createElement('div')
  inputFooter.setAttribute('data-composer-footer-responsive', '')
  footer.before(inputFooter)
  footer.innerHTML =
    '<canvas></canvas><button aria-label="停止听写" aria-busy="false"><svg></svg></button><button class="size-token-button-composer" aria-label="转录并发送" aria-busy="false"><svg></svg></button>'
  await vi.waitFor(() => expect(f.document.querySelector('[data-dictation="recording"]')).not.toBeNull())
  expect(f.runtime.inspect().roots).toBe(2)
  const stop = footer.querySelector<HTMLButtonElement>('button')!
  const send = footer.querySelector<HTMLButtonElement>('button.size-token-button-composer')!
  stop.setAttribute('aria-busy', 'true')
  stop.disabled = true
  send.disabled = true
  await vi.waitFor(() => expect(f.document.querySelector('[data-dictation="transcribing"]')).not.toBeNull())
  expect(f.runtime.inspect().roots).toBe(2)
  expect(footer.querySelector('button')).toBe(stop)
})

it('gates the drag sibling independently, expands its band, and retires the old handle on revoke', async () => {
  const f = setup()
  const frame = f.document.querySelector<HTMLElement>('[data-codex-composer-root]')!
  frame.getBoundingClientRect = () => ({
    left: 0,
    top: 400,
    right: 300,
    bottom: 500,
    x: 0,
    y: 400,
    width: 300,
    height: 100,
    toJSON() {},
  })
  let handle: CordisXReactVisualProps['drag']
  function DragVisual({ state, drag }: CordisXReactVisualProps) {
    handle = drag
    React.useEffect(() => {
      drag?.setRegion({ x: 20, y: state.bounds.height - 80, width: 60, height: 80, label: 'Move cat' })
      return () => drag?.setRegion(null)
    }, [drag, state.bounds.height])
    return React.createElement('span', {
      'data-drag-available': Boolean(drag),
      'data-band-height': state.bounds.height,
    })
  }
  f.runtime.register(
    'drag',
    { id: 'cat', pointId: 'composer.frame.overlay', events: ['drag'] },
    async () => ({ kind: 'react-dom-v1', component: DragVisual }),
    f.authority,
  )
  f.grant(true)
  await vi.waitFor(() => expect(f.document.querySelector('[data-band-height="128"]')).not.toBeNull())
  expect(f.document.querySelector('[data-cordisx-composer-drag]')).toBeNull()
  f.grant(true, false, true)
  await vi.waitFor(() => expect(f.document.querySelector('[data-band-height="400"]')).not.toBeNull())
  const target = f.document.querySelector('[data-cordisx-composer-drag]')!
  expect(target.parentElement).toBe(frame)
  expect(target.closest('[inert]')).toBeNull()
  const old = handle!
  f.grant(true)
  expect(f.document.querySelector('[data-cordisx-composer-drag]')).toBeNull()
  old.setRegion({ x: 0, y: 0, width: 100, height: 100, label: 'stale' })
  expect(f.document.querySelector('[data-cordisx-composer-drag]')).toBeNull()
  await vi.waitFor(() => expect(f.document.querySelector('[data-band-height="128"]')).not.toBeNull())
  expect(handle).toBeUndefined()
  expect(() =>
    f.runtime.register(
      'invalid',
      { id: 'invalid', pointId: 'composer.primary-action.visual', events: ['drag'] },
      loadVisual,
      f.authority,
    )
  ).toThrow('unavailable')
})
