import { JSDOM } from 'jsdom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { CordisXReactPageProps } from 'cordisx/contracts'
import { FixtureTraceShowcaseStore, UnavailableTraceShowcaseStore } from '../src/providers.js'
import { createTraceReactPage } from '../src/react-view.js'
import type { TraceShowcaseStore } from '../src/types.js'

vi.mock('cordisx/ui', async () => {
  const React = await import('react')
  return {
    Button: (
      { children, variant: _variant, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string },
    ) => React.createElement('button', props, children),
  }
})

function propsFor(): CordisXReactPageProps {
  return {
    routeId: 'agent-trace-showcase:session.timeline',
    outlet: 'session.content',
    params: { sessionId: 'session-a' },
    navigation: {
      navigate: async () => {},
      back: async () => {},
      close: async () => {},
    },
    localeNamespace: 'agent-trace-showcase',
    t: key => key,
    localization: {
      namespace: 'agent-trace-showcase',
      t: key => key,
      message: key => ({ key }),
      getSnapshot: () => ({ locale: 'en', direction: 'ltr', version: 1 }),
      subscribe: () => () => {},
      effect: setup => setup({ locale: 'en', direction: 'ltr', version: 1 }),
      bindText: () => () => {},
      bindAttribute: () => () => {},
    },
  } as CordisXReactPageProps
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 20))
}

async function mountReact(dom: JSDOM, store: TraceShowcaseStore): Promise<Root> {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document })
  const Page = createTraceReactPage(() => store)
  const root = createRoot(dom.window.document.getElementById('root')!)
  root.render(createElement(Page, propsFor()))
  await settle()
  return root
}

function change(dom: JSDOM, control: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype = control instanceof dom.window.HTMLInputElement
    ? dom.window.HTMLInputElement.prototype
    : dom.window.HTMLSelectElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value)
  control.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  control.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
}

describe('Agent Trace Timeline page', () => {
  it('renders the DSH-inspired overview, four lanes, grouped ledger, filters, detail, and explicit demos', async () => {
    const dom = new JSDOM('<body><div id="root"></div></body>', { url: 'https://codex.local/native' })
    const store = new FixtureTraceShowcaseStore({ sessionId: 'session-a' })
    const root = await mountReact(dom, store)
    const document = dom.window.document

    expect(document.querySelector('[data-agent-trace-showcase]')).not.toBeNull()
    expect(document.querySelector('.cxt-overview-title')?.textContent).toBe('Overview')
    expect([...document.querySelectorAll('.cxt-lane-labels span')].map(item => item.textContent)).toEqual([
      'Input',
      'Model',
      'Tools',
      'Inject',
    ])
    expect(document.querySelectorAll('.cxt-overview-span').length).toBe(16)
    expect([...document.querySelectorAll('.cxt-group[data-kind="turn"]')].map(item => item.textContent)).toEqual([
      'Turn 7',
      'Turn 8',
    ])
    expect(document.querySelectorAll('.cxt-row').length).toBe(16)
    expect(document.querySelector('.cxt-integrity')?.textContent).toContain('fixture')
    expect(document.querySelector('.cxt-integrity')?.textContent).toContain('cordisx.agent-events/v2')

    const selected = document.querySelector<HTMLTableRowElement>('[data-event-id="fixture-session-a-20"]')!
    selected.click()
    await settle()
    expect(document.querySelector('.cxt-detail-title')?.textContent).toContain('Steer requested')
    expect(document.querySelector('.cxt-detail-scroll')?.textContent).toContain('agent-trace-showcase@0.1.0')
    expect(document.querySelector('.cxt-detail-scroll')?.textContent).toContain('not-applicable')
    expect(document.querySelector('.cxt-detail-scroll')?.textContent).toContain('Originfixture')
    document.querySelector<HTMLTableRowElement>('[data-event-id="fixture-session-a-17"]')!.click()
    await settle()
    expect(document.querySelector('.cxt-detail-scroll')?.textContent).toContain('unproved')

    const phase = document.querySelector<HTMLSelectElement>('select[aria-label="Filter by lifecycle phase"]')!
    change(dom, phase, 'failed')
    await settle()
    expect(document.querySelectorAll('.cxt-row')).toHaveLength(2)
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
    expect(search.getAttribute('aria-label')).toBe('Search loaded events')

    change(dom, phase, 'all')
    change(dom, search, '')
    await settle()
    document.querySelector<HTMLButtonElement>('[data-demo-kind="followup"]')!.click()
    await settle()
    expect(store.getSnapshot().range.totalAvailable).toBe(27)
    expect([...document.querySelectorAll('.cxt-row')].at(-1)?.textContent).toContain('queued')

    root.unmount()
    expect(document.querySelector('[data-agent-trace-showcase]')).toBeNull()
  })

  it('renders an honest unavailable state with disabled mutation controls', async () => {
    const dom = new JSDOM('<body><div id="root"></div></body>')
    const store = new UnavailableTraceShowcaseStore('session-a')
    const root = await mountReact(dom, store)
    expect(dom.window.document.querySelector('.cxt-empty')?.textContent).toContain('unavailable')
    expect(
      [...dom.window.document.querySelectorAll<HTMLButtonElement>('[data-demo-kind]')].every(button => button.disabled),
    ).toBe(true)
    expect(dom.window.document.querySelector('.cxt-integrity')?.textContent).toContain('unavailable')
    root.unmount()
  })

  it('enforces the explicit 500-row render boundary under fixture volume', async () => {
    const dom = new JSDOM('<body><div id="root"></div></body>')
    const store = new FixtureTraceShowcaseStore({ sessionId: 'session-a' })
    await Promise.all(Array.from({ length: 170 }, async () => {
      await store.requestDemo({ kind: 'inject' })
    }))
    const root = await mountReact(dom, store)
    expect(store.getSnapshot().range.loaded).toBeGreaterThan(500)
    expect(dom.window.document.querySelectorAll('.cxt-row')).toHaveLength(500)
    expect(dom.window.document.querySelector('.cxt-count')?.textContent).toContain('limit 500')
    root.unmount()
  })
})
