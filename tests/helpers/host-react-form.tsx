import { act } from 'react'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, vi } from 'vitest'
import type { Root } from 'react-dom/client'
import type { CordisXConfigFieldSnapshot } from '../../packages/cli/src/contracts.js'
import type { ManagerModel, ManagerPluginSnapshot } from '../../packages/cli/src/renderer/manager.js'

export let dom: JSDOM
export let root: Root
export let HostForm: typeof import('../../packages/cli/src/renderer/host-ui/HostForm.js').HostForm
let restore: () => void

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', {
    url: 'https://host.invalid/',
    pretendToBeVisual: true,
  })
  const replacements = {
    document: dom.window.document,
    window: dom.window,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    HTMLInputElement: dom.window.HTMLInputElement,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.fromEntries(
    Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  )
  Object.assign(globalThis, replacements)
  restore = () => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
  Object.defineProperty(dom.window, 'matchMedia', {
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  })
  ;({ HostForm } = await import('../../packages/cli/src/renderer/host-ui/HostForm.js'))
  const { createRoot } = await import('react-dom/client')
  root = createRoot(dom.window.document.getElementById('root')!)
})

afterEach(async () => {
  await act(async () => root.unmount())
  dom.window.close()
  restore()
})

export function field(path: string, overrides: Partial<CordisXConfigFieldSnapshot> = {}): CordisXConfigFieldSnapshot {
  return { path: [path], type: 'string', value: 'initial', label: path, required: false, disabled: false, ...overrides }
}

export function input(path: string): HTMLInputElement {
  return dom.window.document.querySelector<HTMLInputElement>(`[data-config-path="${path}"] input`)!
}

export async function edit(path: string, value: string): Promise<void> {
  const control = input(path)
  await act(async () => {
    control.focus()
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(control, value)
    control.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    control.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
}

export async function submit(): Promise<void> {
  await act(async () =>
    dom.window.document.querySelector('form')!.dispatchEvent(
      new dom.window.Event('submit', { bubbles: true, cancelable: true }),
    )
  )
}

export function plugin(
  fields: readonly CordisXConfigFieldSnapshot[],
  revision = 1,
  writable = true,
): ManagerPluginSnapshot {
  return { id: 'fixture', configuration: { fields, revision, writable } } as ManagerPluginSnapshot
}

export function model(updatePluginConfig = vi.fn(async () => undefined)): ManagerModel {
  return { snapshot: () => ({ localization: { locale: 'en' } }), updatePluginConfig } as unknown as ManagerModel
}
