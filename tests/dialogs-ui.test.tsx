import React, { act, createContext, useContext, useState } from 'react'
import { JSDOM, VirtualConsole } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Root } from 'react-dom/client'
import type { DialogBinding } from '../packages/cli/src/renderer/dialogs/model.js'
let dom: JSDOM
let root: Root
let binding: DialogBinding
let dispose: () => void
let shadows: ShadowRoot[]
let Dialog: typeof import('../packages/cli/src/renderer/dialogs/react.js').Dialog
let DialogProvider: typeof import('../packages/cli/src/renderer/dialogs/react.js').DialogProvider
let defineDialog: typeof import('../packages/cli/src/renderer/dialogs/react.js').defineDialog
const report = vi.fn()
beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html lang="en"><body><button id="opener">Open</button><main></main></body></html>', {
    url: 'https://dialogs.invalid',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  })
  for (
    const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      Element: dom.window.Element,
      Node: dom.window.Node,
      HTMLInputElement: dom.window.HTMLInputElement,
      MutationObserver: dom.window.MutationObserver,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
      cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
      IS_REACT_ACT_ENVIRONMENT: true,
    })
  ) vi.stubGlobal(key, value)
  Object.defineProperty(dom.window, 'matchMedia', {
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  })
  dom.window.HTMLDialogElement.prototype.showModal = function() {
    this.setAttribute('open', '')
    this.focus()
  }
  dom.window.HTMLDialogElement.prototype.close = function() {
    this.removeAttribute('open')
  }
  shadows = []
  const attach = dom.window.HTMLElement.prototype.attachShadow
  vi.spyOn(dom.window.HTMLElement.prototype, 'attachShadow').mockImplementation(function(this: HTMLElement, options) {
    const shadow = attach.call(this, options)
    shadows.push(shadow)
    return shadow
  })
  const host = await import('../packages/cli/src/renderer/dialogs/host.js')
  dispose = host.installDialogHost(dom.window.document)
  binding = host.dialogCenterForDocument(dom.window.document)!.bind({
    key: 'plugin/a',
    name: () => 'Room Plugin',
    active: () => true,
    report,
  })
  ;({ Dialog, DialogProvider, defineDialog } = await import('../packages/cli/src/renderer/dialogs/react.js'))
  const { createRoot } = await import('react-dom/client')
  root = createRoot(dom.window.document.querySelector('main')!)
})
afterEach(async () => {
  await act(async () => {
    root.unmount()
    dispose()
  })
  dom.window.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  report.mockClear()
})
const shell = () => shadows.at(-1)!
const click = async (selector: string) => act(async () => shell().querySelector<HTMLButtonElement>(selector)!.click())

describe('shared modal chrome and JSX', () => {
  it('preserves React context and state while the Host owns header, footer and close', async () => {
    const Context = createContext('missing')
    function Body() {
      const text = useContext(Context)
      const [count, setCount] = useState(0)
      return <button id="body-counter" onClick={() => setCount(count + 1)}>{text}:{count}</button>
    }
    function Page() {
      const [open, setOpen] = useState(true)
      return (
        <Context.Provider value="inherited">
          <DialogProvider service={binding.api}>
            <Dialog
              open={open}
              onOpenChange={setOpen}
              title="Room"
              headerActions={Array.from(
                { length: 4 },
                (_, index) => ({
                  id: `header-${index}`,
                  label: `Action ${index}`,
                  icon: 'share' as const,
                  onAction: () => {},
                }),
              )}
              footer={{ status: '2 players', primaryAction: { id: 'join', label: 'Join', onAction: () => {} } }}
            >
              <Body />
            </Dialog>
          </DialogProvider>
        </Context.Provider>
      )
    }
    await act(async () => root.render(<Page />))
    expect(dom.window.document.querySelector('#body-counter')?.textContent).toBe('inherited:0')
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('#body-counter')!.click())
    expect(dom.window.document.querySelector('#body-counter')?.textContent).toBe('inherited:1')
    expect(shell().querySelector('.header-actions')?.lastElementChild?.getAttribute('data-dialog-close')).toBe('true')
    expect(shell().querySelectorAll('.header-actions > button')).toHaveLength(3)
    expect(shell().querySelectorAll('.menu button')).toHaveLength(2)
    expect(shell().querySelector('footer')?.textContent).toContain('2 players')
    expect(dom.window.document.querySelector('[data-cordisx-dialog]')!.shadowRoot).toBeNull()
    await click('[data-dialog-close]')
    expect(dom.window.document.querySelector('[data-cordisx-dialog]')).toBeNull()
  })
  it('keeps close available when an action fails and suppresses repeated submissions', async () => {
    let finish!: () => void
    const run = vi.fn(() =>
      new Promise<void>(resolve => {
        finish = resolve
      })
    )
    let result!: Promise<unknown>
    await act(async () => {
      result = binding.api.confirm({ kind: 'save', title: 'Save?', confirmLabel: 'Save', run })
    })
    await click('[data-action=confirm]')
    expect(shell().querySelector<HTMLButtonElement>('[data-action=confirm]')!.disabled).toBe(true)
    expect(shell().querySelector<HTMLButtonElement>('[data-dialog-close]')!.disabled).toBe(false)
    await click('[data-action=confirm]')
    expect(run).toHaveBeenCalledTimes(1)
    await click('[data-dialog-close]')
    expect(await result).toEqual({ status: 'closed', reason: 'close-button' })
    await act(async () => finish())
    expect(dom.window.document.querySelector('[data-cordisx-dialog]')).toBeNull()
  })
  it('supports registered React bodies and unload cleanup through the same shell', async () => {
    const unregister = binding.api.register(
      'view',
      defineDialog(({ props }) => <input aria-label="room" defaultValue={String(props.room)} />),
    )
    let handle!: ReturnType<typeof binding.api.open>
    await act(async () => {
      handle = binding.api.open({ kind: 'room', title: 'Room', content: { id: 'view', props: { room: '42' } } })
    })
    expect(dom.window.document.querySelector<HTMLInputElement>('input')!.value).toBe('42')
    await act(async () => unregister())
    expect(await handle.result).toEqual({ status: 'disposed' })
    expect(dom.window.document.querySelector('[data-cordisx-dialog]')).toBeNull()
  })
  it('validates a Host-rendered form before submitting the draft', async () => {
    const submit = vi.fn(async () => {})
    await act(async () => {
      void binding.api.form({
        kind: 'name',
        title: 'Name',
        submitLabel: 'Save',
        fields: [{ id: 'name', label: 'Name', type: 'string', required: true }],
        submit,
      })
    })
    expect(dom.window.document.querySelector('.cxf-form-grid')).not.toBeNull()
    await click('[data-action=submit]')
    expect(submit).not.toHaveBeenCalled()
    expect(dom.window.document.querySelector('[aria-invalid=true]')).not.toBeNull()
  })
  it('removes the shell and settles results even if a plugin cleanup throws', async () => {
    binding.api.register('broken-cleanup', () => () => {
      throw new Error('Plugin cleanup failed')
    })
    let handle!: ReturnType<typeof binding.api.open>
    await act(async () => {
      handle = binding.api.open({ kind: 'cleanup', title: 'Cleanup', content: { id: 'broken-cleanup' } })
    })
    await act(async () => {
      await handle.close()
    })
    expect((await handle.result).status).toBe('closed')
    expect(dom.window.document.querySelector('[data-cordisx-dialog]')).toBeNull()
    expect(report).toHaveBeenCalledWith('cleanup')
  })
  it('adopts the same chrome for existing Host editor bodies', async () => {
    const { HostEditorDialog } = await import('../packages/cli/src/renderer/dialogs/internal.js')
    const confirm = vi.fn()
    await act(async () =>
      root.render(
        <HostEditorDialog
          visible
          header="Edit item"
          confirmBtn="Save"
          cancelBtn="Cancel"
          onClose={() => {}}
          onConfirm={confirm}
        >
          <input aria-label="Item" />
        </HostEditorDialog>,
      )
    )
    expect(shell().querySelector('h2')?.textContent).toBe('Edit item')
    await click('[data-action=confirm]')
    expect(confirm).toHaveBeenCalledTimes(1)
  })
})
