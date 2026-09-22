import React, { useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { installModelProviderSelector } from '../../packages/cli/src/renderer/install-model-provider-selector.js'
import { ModelProviderRegistry } from '../../packages/cli/src/renderer/model-providers.js'
import { CodexDesktopNativeModelProviderTransport } from '../../packages/cli/src/renderer/native-model-provider-transport.js'

let openModal: (value: boolean) => void
let replaceAnchor: () => void
let calls = 0
const state = Object.freeze({
  available: true,
  busy: false,
  modelProvider: 'fixture',
  model: 'model',
  modelLabel: 'Fixture Model',
  reasoningEffort: 'high',
})
const registry = new ModelProviderRegistry(async () => [{
  providerId: 'fixture',
  title: 'Fixture',
  pluginId: 'fixture',
  models: [{ id: 'model', label: 'Fixture Model' }],
}])

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
      getSnapshot: () => state,
      subscribe: () => () => {},
      hasActiveSubmission: () => false,
      select: async () => {
        calls++
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
export async function refresh() {
  await registry.refresh()
  await settle()
}
