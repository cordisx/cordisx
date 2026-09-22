import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installModelProviderSelector } from '../packages/cli/src/renderer/install-model-provider-selector.js'
import { ModelProviderRegistry } from '../packages/cli/src/renderer/model-providers.js'
import { CodexDesktopNativeModelProviderTransport } from '../packages/cli/src/renderer/native-model-provider-transport.js'

const originals = new Map<string, PropertyDescriptor | undefined>()
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete (globalThis as Record<string, unknown>)[name]
  }
  originals.clear()
})

function NativeComposer({ usage, thread = 'draft' }: { usage: boolean; thread?: string }) {
  return (
    <main data-codex-composer-root data-composer-placement={thread === 'draft' ? 'home' : 'thread'}>
      <footer data-composer-footer-responsive>
        <div id="controls">
          {usage && (
            <span id="usage">
              <span role="img" aria-label="Context usage: 2%" />
            </span>
          )}
          <span id="native-group" key={thread}>
            <span aria-haspopup="menu">
              <button data-codex-intelligence-trigger="true" aria-haspopup="menu">Model</button>
            </span>
          </span>
          <button id="microphone">Dictate</button>
          <button id="voice">Voice</button>
        </div>
      </footer>
    </main>
  )
}

async function fixture(usage: boolean) {
  const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>', { url: 'app://-/index.html' })
  for (
    const [name, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      location: dom.window.location,
      HTMLElement: dom.window.HTMLElement,
      Element: dom.window.Element,
      Node: dom.window.Node,
      MutationObserver: dom.window.MutationObserver,
      IS_REACT_ACT_ENVIRONMENT: true,
    })
  ) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  Object.assign(dom.window.HTMLElement.prototype, {
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 20, bottom: 20, width: 20, height: 20 }),
  })
  const listeners = new Set<() => void>()
  const state = Object.freeze({ available: false, busy: false })
  vi.spyOn(CodexDesktopNativeModelProviderTransport, 'connect').mockResolvedValue({
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    hasActiveSubmission: () => false,
    dispose: vi.fn(),
  } as never)
  const registry = new ModelProviderRegistry(async () => [{
    providerId: 'fixture',
    pluginId: 'fixture',
    models: [{ id: 'model', label: 'Model' }],
  }])
  const document = dom.window.document
  const nativeRoot: Root = createRoot(document.getElementById('app')!)
  let dispose = () => {}
  const render = async (nextUsage: boolean, thread = 'draft') => {
    await act(async () => nativeRoot.render(<NativeComposer usage={nextUsage} thread={thread} />))
  }
  await render(usage)
  await act(async () => {
    dispose = await installModelProviderSelector(document, registry, () => 'en', true)
  })
  cleanups.push(async () => {
    await act(async () => dispose())
    registry.dispose()
    await act(async () => nativeRoot.unmount())
    dom.window.close()
  })
  const selector = () => document.querySelector<HTMLElement>('[data-cordisx-model-provider-selector]')!
  const order = () =>
    [...document.querySelector('#controls')!.children]
      .map(node => (node as HTMLElement).dataset.cordisxModelProviderSelector ? 'selector' : node.id)
  return { dom, document, registry, listeners, render, selector, order }
}

describe('native Composer selector order', () => {
  it.each([false, true])(
    'preserves native order when usage initially mounted=%s and React toggles it',
    async initial => {
      const { document, render, selector, order, registry, listeners } = await fixture(initial)
      const root = selector()
      const focused = root.querySelector<HTMLButtonElement>('.cxmp-model-trigger')!
      focused.focus()
      const trigger = document.querySelector('[data-codex-intelligence-trigger]')
      const microphone = document.getElementById('microphone')!
      const voice = document.getElementById('voice')!
      const onNativeClick = vi.fn()
      microphone.addEventListener('click', onNativeClick)
      voice.addEventListener('click', onNativeClick)
      for (const usage of [true, false, true, true]) {
        await render(usage)
        expect(order()).toEqual([...(usage ? ['usage'] : []), 'selector', 'native-group', 'microphone', 'voice'])
        expect(selector()).toBe(root)
        expect(document.activeElement).toBe(focused)
        expect(document.querySelector('[data-codex-intelligence-trigger]')).toBe(trigger)
      }
      await act(async () => {
        await registry.refresh()
        for (const listener of listeners) listener()
      })
      expect(order()).toEqual(['usage', 'selector', 'native-group', 'microphone', 'voice'])
      microphone.click()
      voice.click()
      expect(onNativeClick).toHaveBeenCalledTimes(2)
      expect(document.querySelectorAll('[data-cordisx-model-provider-selector]')).toHaveLength(1)
      await render(true, 'next-thread')
      expect(document.querySelector('[data-codex-intelligence-trigger]')).not.toBe(trigger)
      expect(order()).toEqual(['usage', 'selector', 'native-group', 'microphone', 'voice'])
      expect(document.querySelectorAll('[data-cordisx-model-provider-selector]')).toHaveLength(1)
    },
  )

  it('reattaches a detached owned root and follows the same trigger into a new parent without remounting', async () => {
    const { document, selector } = await fixture(true)
    const root = selector()
    const group = document.getElementById('native-group')!
    await act(async () => root.remove())
    expect(selector()).toBe(root)
    expect(root.nextSibling).toBe(group)
    const parent = document.createElement('div')
    await act(async () => {
      document.querySelector('footer')!.append(parent)
      parent.append(group)
    })
    expect(root.parentElement).toBe(parent)
    expect(root.nextSibling).toBe(group)
    // Restore native React-owned nodes before its own unmount.
    await act(async () =>
      document.getElementById('controls')!.insertBefore(group, document.getElementById('microphone'))
    )
  })

  it('tracks replacement wrappers around the same trigger and restores both old and new native groups', async () => {
    const { document, selector } = await fixture(true)
    const group = document.getElementById('native-group')!
    const inner = group.firstElementChild!
    const replacement = document.createElement('span')
    await act(async () => {
      group.replaceWith(replacement)
      replacement.append(inner)
    })
    expect(group.hidden).toBe(false)
    expect(replacement.hidden).toBe(true)
    expect(selector().nextSibling).toBe(replacement)
    await act(async () => {
      replacement.replaceWith(group)
      group.append(inner)
    })
    expect(replacement.hidden).toBe(false)
    expect(group.hidden).toBe(true)
    expect(selector().nextSibling).toBe(group)
  })

  it('settles after its own placement mutation instead of repeatedly moving the root', async () => {
    const { dom, document, render, selector } = await fixture(false)
    const root = selector()
    let placements = 0
    const observer = new dom.window.MutationObserver(records => {
      placements += records.filter(record => [...record.addedNodes].includes(root)).length
    })
    observer.observe(document.getElementById('controls')!, { childList: true })
    try {
      await render(true)
      await act(async () => new Promise(resolve => setTimeout(resolve, 30)))
      expect(placements).toBe(1)
    } finally {
      observer.disconnect()
    }
  })
})
