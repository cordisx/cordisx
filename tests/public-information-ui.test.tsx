import React, { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostDialog } from '../packages/cli/src/renderer/host-ui/HostDialog.js'
import {
  Disclosure,
  FieldList,
  PUBLIC_INFORMATION_STYLES,
  StatusBadge,
} from '../packages/cli/src/renderer/host-ui/PublicInformation.js'

const globals = Object.fromEntries(
  ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'IS_REACT_ACT_ENVIRONMENT']
    .map(key => [key, Reflect.get(globalThis, key)]),
)
let root: Root | undefined
let dom: JSDOM | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  dom?.window.close()
  root = undefined
  dom = undefined
  Object.assign(globalThis, globals)
})

async function render(element: React.ReactNode) {
  dom = new JSDOM('<html><body><button id="return">Return</button><div id="root"></div></body></html>', {
    url: 'https://example.test',
  })
  Object.assign(
    globalThis,
    Object.fromEntries(['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver']
      .map(key => [key, key === 'window' ? dom!.window : Reflect.get(dom!.window, key)])),
    { IS_REACT_ACT_ENVIRONMENT: true },
  )
  root = createRoot(document.getElementById('root')!)
  await act(async () => root!.render(element))
}

describe('public information UI', () => {
  it('uses projected semantic status colors instead of fixed theme-specific text colors', () => {
    expect(PUBLIC_INFORMATION_STYLES).toContain('color:var(--cx-success,var(--cx-primary))')
    expect(PUBLIC_INFORMATION_STYLES).toContain('color:var(--cx-warning,var(--cx-primary))')
    expect(PUBLIC_INFORMATION_STYLES).not.toContain('color:#22865e')
    expect(PUBLIC_INFORMATION_STYLES).not.toContain('color:#9b6812')
  })

  it('renders semantic statuses and bounded field rows for long content', async () => {
    await render(
      <FieldList
        aria-label="Runtime fields"
        columns={2}
        density="compact"
        items={[{
          id: 'long',
          label: 'A very long field label that must wrap in a narrow container',
          value: (
            <StatusBadge tone="warning">A very long status value that must remain inside its container</StatusBadge>
          ),
          description: 'A detailed value explanation that also wraps without changing the semantic definition list.',
        }]}
      />,
    )
    const list = document.querySelector('dl')!
    expect(list.getAttribute('data-columns')).toBe('2')
    expect(list.getAttribute('data-density')).toBe('compact')
    expect(list.querySelector('dt')?.textContent).toContain('very long field label')
    expect(list.querySelector('dd')?.textContent).toContain('very long status value')
    expect(list.querySelector('[data-tone="warning"]')).not.toBeNull()
  })

  it('supports uncontrolled and controlled disclosure semantics', async () => {
    const toggles = vi.fn()
    function Fixture() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <Disclosure summary="Uncontrolled" defaultOpen onToggle={toggles}>Details</Disclosure>
          <Disclosure
            summary="Controlled"
            open={open}
            onToggle={next => {
              toggles(next)
              setOpen(next)
            }}
          >
            Controlled details
          </Disclosure>
        </>
      )
    }
    await render(<Fixture />)
    const details = [...document.querySelectorAll('details')]
    expect(details[0]?.open).toBe(true)
    await act(async () => details[1]?.querySelector('summary')?.click())
    expect(details[1]?.open).toBe(true)
    expect(toggles).toHaveBeenCalledWith(true)
  })

  it('restores a rejected controlled disclosure toggle even when the prop does not change', async () => {
    const toggles = vi.fn()
    function Fixture() {
      const [, rerender] = useState(0)
      return (
        <>
          <Disclosure summary="Controlled" open={false} onToggle={toggles}>Details</Disclosure>
          <button onClick={() => rerender(value => value + 1)}>Rerender</button>
        </>
      )
    }
    await render(<Fixture />)
    const details = document.querySelector('details')!
    await act(async () => {
      details.querySelector('summary')?.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(toggles).toHaveBeenCalledTimes(1)
    expect(toggles).toHaveBeenCalledWith(true)
    expect(details.open).toBe(false)
    await act(async () => document.querySelector<HTMLButtonElement>('button')?.click())
    expect(details.open).toBe(false)
  })

  it('centers a modal surface, traps focus, dismisses with Escape and restores focus', async () => {
    const close = vi.fn()
    function Fixture() {
      const [open, setOpen] = useState(true)
      const initial = useRef<HTMLButtonElement>(null)
      const returnFocus = useRef<HTMLButtonElement>(null)
      return (
        <>
          <button ref={returnFocus}>Open</button>
          <HostDialog
            open={open}
            title="Confirm"
            description="Review"
            initialFocusRef={initial}
            returnFocusRef={returnFocus}
            onClose={reason => {
              close(reason)
              setOpen(false)
            }}
            actions={
              <>
                <button ref={initial}>Cancel</button>
                <button>Confirm</button>
              </>
            }
          />
        </>
      )
    }
    await render(<Fixture />)
    await act(async () => Promise.resolve())
    expect(document.activeElement?.textContent).toBe('Cancel')
    await act(async () => {
      document.querySelector('[role="dialog"]')?.dispatchEvent(
        new dom!.window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
        }),
      )
    })
    await act(async () => Promise.resolve())
    expect(close).toHaveBeenCalledWith('escape')
    expect(document.activeElement?.textContent).toBe('Open')
  })

  it('skips hidden focus targets and cancels autofocus after the dialog closes', async () => {
    const queued: (() => void)[] = []
    const originalQueueMicrotask = globalThis.queueMicrotask
    globalThis.queueMicrotask = callback => queued.push(callback)
    try {
      const hidden = React.createRef<HTMLButtonElement>()
      await render(
        <HostDialog
          open
          title="Confirm"
          initialFocusRef={hidden}
          onClose={() => {}}
          actions={
            <>
              <span aria-hidden="true">
                <button ref={hidden}>Hidden</button>
              </span>
              <button>Visible</button>
            </>
          }
        />,
      )
      expect(queued.length).toBeGreaterThan(0)
      while (queued.length > 0) queued.shift()?.()
      expect(document.activeElement?.textContent).toBe('Visible')

      document.getElementById('return')?.focus()
      await act(async () =>
        root!.render(
          <HostDialog open={false} title="Closed" initialFocusRef={hidden} onClose={() => {}} />,
        )
      )
      while (queued.length > 0) queued.shift()?.()
      await act(async () =>
        root!.render(
          <HostDialog
            open
            title="Closing"
            initialFocusRef={hidden}
            onClose={() => {}}
            actions={<button>Action</button>}
          />,
        )
      )
      expect(queued.length).toBeGreaterThan(0)
      await act(async () =>
        root!.render(
          <HostDialog
            open={false}
            title="Closing"
            initialFocusRef={hidden}
            onClose={() => {}}
            actions={<button>Action</button>}
          />,
        )
      )
      while (queued.length > 0) queued.shift()?.()
      expect(document.activeElement?.textContent).not.toBe('Action')
    } finally {
      globalThis.queueMicrotask = originalQueueMicrotask
    }
  })
})
