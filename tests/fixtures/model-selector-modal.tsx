import React, { useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { installModelProviderSelector } from '../../packages/cli/src/renderer/install-model-provider-selector.js'
import { ModelProviderRegistry } from '../../packages/cli/src/renderer/model-providers.js'
import { CodexDesktopNativeModelProviderTransport } from '../../packages/cli/src/renderer/native-model-provider-transport.js'

let openModal: (value: boolean) => void
let replaceAnchor: () => void
let calls = 0
let modelCount = 1
let catalogReads = 0
let focusReturns = 0
let snapshotReads = 0
let labelPreview = false
let reasoningDelay = 0
let fastDelay = 0
const fastBusyHistory: boolean[] = []
const snapshotListeners = new Set<() => void>()
let state = Object.freeze({
  available: true,
  busy: false,
  modelProvider: 'fixture',
  model: 'model',
  modelLabel: 'Fixture Model',
  reasoningEffort: 'high',
  reasoningEfforts: ['low', 'high'],
})
const registry = new ModelProviderRegistry(async () => {
  catalogReads++
  if (labelPreview) {
    return [
      {
        providerId: 'modelhub',
        title: 'ModelHub (Native Direct)',
        pluginId: 'fixture',
        models: [{ id: 'modelhub-model', label: 'ModelHub Model' }],
      },
      {
        providerId: 'openrouter',
        title: 'OpenRouter (Native Responses)',
        pluginId: 'fixture',
        selectorBrand: { brand: 'openrouter', source: 'override' },
        models: [{ id: 'openrouter-model', label: 'OpenRouter Model' }],
      },
      {
        providerId: 'custom',
        title: 'Custom Provider (Team-owned configuration with a deliberately long label)',
        pluginId: 'fixture',
        models: [{ id: 'custom-model', label: 'Custom Model' }],
      },
      {
        providerId: 'empty-adapter',
        title: 'Empty adapter',
        pluginId: 'fixture',
        models: [],
      },
      {
        providerId: 'gateway',
        title: 'Gateway',
        pluginId: 'fixture',
        models: [{ id: 'gateway-model', label: 'Gateway Model' }],
      },
    ]
  }
  return [{
    providerId: 'fixture',
    title: 'Fixture',
    pluginId: 'fixture',
    selectorBrand: { brand: 'openrouter', source: 'override' },
    models: Array.from({ length: modelCount }, (_, index) => ({
      id: index === 0 ? 'model' : `openrouter/model-${index}`,
      label: index === 0 ? 'Fixture Model' : `OpenRouter Model ${index}`,
    })),
  }]
})
registry.connectSource(() => () => {})

function Modal({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    document.getElementById('app')!.setAttribute('aria-hidden', 'true')
    dialog.current!.showModal()
    return () => {
      dialog.current?.close()
      document.getElementById('app')!.removeAttribute('aria-hidden')
      document.getElementById('permissions')!.focus()
    }
  }, [])
  return createPortal(
    <dialog
      ref={dialog}
      onCancel={event => {
        event.preventDefault()
        close()
      }}
      onKeyDown={event => {
        if (event.key !== 'Tab') return
        const buttons = [...event.currentTarget.querySelectorAll('button')]
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        event.preventDefault()
        buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]!.focus()
      }}
    >
      <p>Permission confirmation</p>
      <button id="cancel" onClick={close}>Cancel</button>
      <button id="keep-open">Review</button>
    </dialog>,
    document.body,
  )
}

function Host() {
  const [modal, setModal] = useState(false)
  const [version, setVersion] = useState(0)
  openModal = setModal
  replaceAnchor = () => setVersion(value => value + 1)
  return (
    <>
      <button id="permissions" onClick={() => setModal(true)}>Permissions</button>
      <main data-codex-composer-root data-composer-placement="home">
        <textarea aria-label="Draft" />
        <footer data-composer-footer-responsive>
          <span id="usage">2%</span>
          <span key={version} id="native-group">
            <span aria-haspopup="menu">
              <button data-codex-intelligence-trigger="true" aria-haspopup="menu">Native</button>
            </span>
          </span>
          <button id="voice">Voice</button>
        </footer>
      </main>
      {modal && <Modal close={() => setModal(false)} />}
    </>
  )
}

export async function start() {
  // Only the transport is a fixture; React, portals, installer and DOM probes are production code.
  CodexDesktopNativeModelProviderTransport.connect = async () =>
    ({
      getSnapshot: () => {
        snapshotReads++
        return state
      },
      subscribe: listener => {
        snapshotListeners.add(listener)
        return () => snapshotListeners.delete(listener)
      },
      hasActiveSubmission: () => false,
      select: async () => {
        calls++
        return 'accepted'
      },
      selectReasoningEffort: async (reasoningEffort: string) => {
        if (reasoningDelay > 0) {
          const delay = reasoningDelay
          reasoningDelay = 0
          state = Object.freeze({ ...state, busy: true })
          for (const listener of snapshotListeners) listener()
          await new Promise(resolve => setTimeout(resolve, delay))
        }
        state = Object.freeze({ ...state, busy: false, reasoningEffort })
        for (const listener of snapshotListeners) listener()
        return 'accepted'
      },
      selectFastMode: async (enabled: boolean) => {
        fastBusyHistory.push(state.busy)
        if (state.busy) return 'busy'
        if (fastDelay > 0) {
          const delay = fastDelay
          fastDelay = 0
          await new Promise(resolve => setTimeout(resolve, delay))
        }
        state = Object.freeze({ ...state, serviceTier: enabled ? 'priority' as const : null })
        for (const listener of snapshotListeners) listener()
        return 'accepted'
      },
      dispose: () => {},
    }) as unknown as CodexDesktopNativeModelProviderTransport
  const native = createRoot(document.getElementById('app')!)
  native.render(<Host />)
  await settle()
  const dispose = await installModelProviderSelector(document, registry, () => 'en', true)
  await settle()
  return () => {
    dispose()
    registry.dispose()
    native.unmount()
  }
}

export async function settle() {
  await new Promise(resolve => setTimeout(resolve, 30))
}
export async function modal(value: boolean) {
  openModal(value)
  await settle()
}
export async function replace() {
  replaceAnchor()
  await settle()
}
export function actionCount() {
  return calls
}
export function catalogReadCount() {
  return catalogReads
}
export function simulateHostFocusReturn() {
  const composer = document.querySelector<HTMLElement>('[data-codex-composer-root]')!
  const draft = document.querySelector<HTMLTextAreaElement>('textarea')!
  const returnFocus = (event: FocusEvent) => {
    if (!(event.target instanceof Element) || event.target.closest('.cxmp-menu') === null) return
    focusReturns++
    composer.dataset.state = String(focusReturns)
    draft.focus()
  }
  document.addEventListener('focusin', returnFocus)
  return () => document.removeEventListener('focusin', returnFocus)
}
export function focusReturnCount() {
  return focusReturns
}
export function resetSnapshotReads() {
  snapshotReads = 0
}
export function snapshotReadCount() {
  return snapshotReads
}
export async function refresh() {
  await registry.refresh()
  await settle()
}
export async function catalog(count: number) {
  labelPreview = false
  modelCount = count
  await registry.refresh()
  await settle()
}
export async function labels() {
  labelPreview = true
  await registry.refresh()
  await settle()
}
export async function busy(value: boolean) {
  state = Object.freeze({ ...state, busy: value })
  for (const listener of snapshotListeners) listener()
  await settle()
}

export async function fastAvailable() {
  state = Object.freeze({
    ...state,
    nativeModels: [{ id: 'model', label: 'Fixture Model', disabled: false, supportsFastMode: true }],
  })
  for (const listener of snapshotListeners) listener()
  await settle()
}

export async function reasoning(value: string, efforts: readonly string[]) {
  state = Object.freeze({ ...state, reasoningEffort: value, reasoningEfforts: [...efforts] })
  for (const listener of snapshotListeners) listener()
  await settle()
}

export function delayReasoning(ms: number) {
  reasoningDelay = ms
}
export function fastCallsWhileBusy() {
  return fastBusyHistory.filter(Boolean).length
}

export function fastCallCount() {
  return fastBusyHistory.length
}
export async function switchThread(threadId: string) {
  state = Object.freeze({ ...state, threadId, busy: false })
  for (const listener of snapshotListeners) listener()
  await settle()
}

export function delayFast(ms: number) {
  fastDelay = ms
}
