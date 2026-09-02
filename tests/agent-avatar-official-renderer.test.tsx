import { JSDOM } from 'jsdom'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { HostAgentAvatar } from '../packages/cli/src/renderer/host-ui/conversation/AgentAvatar.js'
import {
  HOST_ONEWORKS_ARCTIC_FOX_AVATAR_ASSET_REF,
  HOST_ONEWORKS_ARCTIC_FOX_AVATAR_ASSET_REVISION,
  HOST_ONEWORKS_ASIAN_SMALL_CLAWED_OTTER_AVATAR_ASSET_REF,
  HOST_ONEWORKS_ASIAN_SMALL_CLAWED_OTTER_AVATAR_ASSET_REVISION,
  HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REF,
  HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REVISION,
  HOST_ONEWORKS_SYRIAN_HAMSTER_AVATAR_ASSET_REF,
  HOST_ONEWORKS_SYRIAN_HAMSTER_AVATAR_ASSET_REVISION,
  HOST_ONEWORKS_YELLOW_DUCKLING_AVATAR_ASSET_REF,
  HOST_ONEWORKS_YELLOW_DUCKLING_AVATAR_ASSET_REVISION,
} from '../packages/cli/src/renderer/host-ui/conversation/OfficialOneWorksAvatarAssets.js'

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
  it('renders all five exact animal exports with the official RC.8 canvas', async () => {
    const dom = installDom()
    const root = createRoot(dom.window.document.getElementById('root')!)
    const assets = [
      [HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REF, HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REVISION, 'fox'],
      [HOST_ONEWORKS_ARCTIC_FOX_AVATAR_ASSET_REF, HOST_ONEWORKS_ARCTIC_FOX_AVATAR_ASSET_REVISION, 'fox'],
      [HOST_ONEWORKS_SYRIAN_HAMSTER_AVATAR_ASSET_REF, HOST_ONEWORKS_SYRIAN_HAMSTER_AVATAR_ASSET_REVISION, 'hamster'],
      [HOST_ONEWORKS_ASIAN_SMALL_CLAWED_OTTER_AVATAR_ASSET_REF, HOST_ONEWORKS_ASIAN_SMALL_CLAWED_OTTER_AVATAR_ASSET_REVISION, 'otter'],
      [HOST_ONEWORKS_YELLOW_DUCKLING_AVATAR_ASSET_REF, HOST_ONEWORKS_YELLOW_DUCKLING_AVATAR_ASSET_REVISION, 'duck'],
    ] as const
    await act(async () => root.render(
      <div data-cordisx-app-theme="light">
        {assets.map(([ref, revision], index) => <HostAgentAvatar key={ref} participant={{
          id: `agent-${index}`, role: 'agent', name: `Agent ${index}`,
          avatar: {
            kind: 'asset',
            ref,
            revision,
          },
        }} />)}
      </div>,
    ))
    await act(async () => await new Promise(resolve => setTimeout(resolve, 0)))
    const wrappers = [...dom.window.document.querySelectorAll<HTMLElement>('.cxa-avatar')]
    expect(wrappers).toHaveLength(5)
    expect(wrappers.map(wrapper => wrapper.dataset.avatarState)).toEqual(Array(5).fill('resolved'))
    expect(wrappers.map(wrapper => wrapper
      .querySelector<HTMLElement>('.interactive-avatar__canvas [data-avatar-entity-preset]')
      ?.dataset.avatarEntityPreset)).toEqual(assets.map(([, , preset]) => preset))
    expect(wrappers.every(wrapper => wrapper.querySelector('.interactive-avatar__canvas') !== null)).toBe(true)
    expect(wrappers.every(wrapper => wrapper.querySelector('.cxa-avatar-initials') === null)).toBe(true)
    await act(async () => root.unmount())
    dom.window.close()
  })
})
