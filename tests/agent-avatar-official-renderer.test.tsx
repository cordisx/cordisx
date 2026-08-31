import { JSDOM } from 'jsdom'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REF,
  HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REVISION,
  HostAgentAvatar,
} from '../packages/cli/src/renderer/host-ui/conversation/AgentAvatar.js'

const previousGlobals = new Map<string, unknown>()

function installDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  })
  Object.defineProperty(dom.window, 'matchMedia', {
    value: () => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  })
  Object.defineProperty(dom.window, 'requestAnimationFrame', { value: () => 0 })
  Object.defineProperty(dom.window, 'cancelAnimationFrame', { value: () => undefined })
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previousGlobals.set(key, Reflect.get(globalThis, key))
    Reflect.set(globalThis, key, value)
  }
  return dom
}

afterEach(() => {
  for (const [key, value] of previousGlobals) Reflect.set(globalThis, key, value)
  previousGlobals.clear()
})

describe('Host Agent avatar official renderer', () => {
  it('renders the exact exported Red Fox definition with the official RC.8 canvas', async () => {
    const dom = installDom()
    const root = createRoot(dom.window.document.getElementById('root')!)
    await act(async () => root.render(
      <div data-cordisx-app-theme="light">
        <HostAgentAvatar participant={{
          id: 'lead', role: 'agent', name: 'Lead',
          avatar: {
            kind: 'asset',
            ref: HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REF,
            revision: HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REVISION,
          },
        }} />
      </div>,
    ))
    await act(async () => await new Promise(resolve => setTimeout(resolve, 0)))
    const wrapper = dom.window.document.querySelector<HTMLElement>('.cxa-avatar')!
    expect(wrapper.dataset.avatarState).toBe('resolved')
    const canvas = wrapper.querySelector<HTMLElement>('.interactive-avatar__canvas')
    expect(canvas).not.toBeNull()
    expect(canvas?.querySelector<HTMLElement>('[data-avatar-entity-preset]')?.dataset.avatarEntityPreset).toBe('fox')
    expect(wrapper.textContent).not.toContain('L')
    await act(async () => root.unmount())
    dom.window.close()
  })
})
