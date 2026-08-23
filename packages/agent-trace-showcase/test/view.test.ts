import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import type { CordisXPageMountContext } from 'cordisx/contracts'
import { FixtureTraceShowcaseStore, UnavailableTraceShowcaseStore } from '../src/providers.js'
import { mountTraceShowcase } from '../src/view.js'

function contextFor(dom: JSDOM, abort: AbortController): CordisXPageMountContext {
  const container = dom.window.document.getElementById('root')!
  return {
    container,
    document: dom.window.document,
    signal: abort.signal,
    routeId: 'agent-trace-showcase:session.timeline',
    outlet: 'session.content',
    params: { sessionId: 'session-a' },
    navigation: {
      navigate: async () => {}, back: async () => {}, close: async () => {},
    },
    localeNamespace: 'agent-trace-showcase',
    t: key => key,
    localization: {
      namespace: 'agent-trace-showcase', t: key => key,
      message: key => ({ key }),
      getSnapshot: () => ({ locale: 'en', direction: 'ltr', version: 1 }),
      subscribe: () => () => {}, effect: setup => setup({ locale: 'en', direction: 'ltr', version: 1 }),
      bindText: () => () => {}, bindAttribute: () => () => {},
    },
  } as CordisXPageMountContext
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('Agent Trace Timeline page', () => {
  it('renders the DSH-inspired overview, four lanes, grouped ledger, filters, detail, and explicit demos', async () => {
    const dom = new JSDOM('<body><div id="root"></div></body>', { url: 'https://codex.local/native' })
    const abort = new AbortController()
    const store = new FixtureTraceShowcaseStore({ sessionId: 'session-a' })
    const dispose = mountTraceShowcase(contextFor(dom, abort), store)
    const document = dom.window.document

    expect(document.querySelector('[data-agent-trace-showcase]')).not.toBeNull()
    expect(document.querySelector('.cxt-overview-title')?.textContent).toBe('Overview')
    expect([...document.querySelectorAll('.cxt-lane-labels span')].map(item => item.textContent)).toEqual([
      'Input', 'Model', 'Tools', 'Inject',
    ])
    expect(document.querySelectorAll('.cxt-overview-span').length).toBe(16)
    expect([...document.querySelectorAll('.cxt-group[data-kind="turn"]')].map(item => item.textContent)).toEqual(['Turn 7', 'Turn 8'])
    expect(document.querySelectorAll('.cxt-row').length).toBe(16)
    expect(document.querySelector('.cxt-integrity')?.textContent).toContain('fixture')
    expect(document.querySelector('.cxt-integrity')?.textContent).toContain('cordisx.agent-events/v2')

    const selected = document.querySelector<HTMLTableRowElement>('[data-event-id="fixture-session-a-20"]')!
    selected.click()
    expect(document.querySelector('.cxt-detail-title')?.textContent).toContain('Steer requested')
    expect(document.querySelector('.cxt-detail-scroll')?.textContent).toContain('agent-trace-showcase@0.1.0')
    expect(document.querySelector('.cxt-detail-scroll')?.textContent).toContain('not-applicable')
    document.querySelector<HTMLTableRowElement>('[data-event-id="fixture-session-a-17"]')!.click()
    expect(document.querySelector('.cxt-detail-scroll')?.textContent).toContain('unproved')

    const phase = document.querySelector<HTMLSelectElement>('select[aria-label="Filter by lifecycle phase"]')!
    phase.value = 'failed'
    phase.dispatchEvent(new dom.window.Event('change'))
    expect(document.querySelectorAll('.cxt-row')).toHaveLength(2)
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
    search.value = 'not queued'
    search.dispatchEvent(new dom.window.Event('input'))
    expect(document.querySelectorAll('.cxt-row')).toHaveLength(1)

    phase.value = 'all'
    phase.dispatchEvent(new dom.window.Event('change'))
    search.value = ''
    search.dispatchEvent(new dom.window.Event('input'))
    document.querySelector<HTMLButtonElement>('[data-demo-kind="followup"]')!.click()
    await settle()
    expect(store.getSnapshot().range.totalAvailable).toBe(27)
    expect([...document.querySelectorAll('.cxt-row')].at(-1)?.textContent).toContain('queued')

    abort.abort()
    expect(document.querySelector('[data-agent-trace-showcase]')).toBeNull()
    dispose()
  })

  it('renders an honest unavailable state with disabled mutation controls', () => {
    const dom = new JSDOM('<body><div id="root"></div></body>')
    const abort = new AbortController()
    const store = new UnavailableTraceShowcaseStore('session-a')
    mountTraceShowcase(contextFor(dom, abort), store)
    expect(dom.window.document.querySelector('.cxt-empty')?.textContent).toContain('unavailable')
    expect([...dom.window.document.querySelectorAll<HTMLButtonElement>('[data-demo-kind]')].every(button => button.disabled)).toBe(true)
    expect(dom.window.document.querySelector('.cxt-integrity')?.textContent).toContain('unavailable')
    abort.abort()
  })

  it('enforces the explicit 500-row render boundary under fixture volume', async () => {
    const dom = new JSDOM('<body><div id="root"></div></body>')
    const abort = new AbortController()
    const store = new FixtureTraceShowcaseStore({ sessionId: 'session-a' })
    await Promise.all(Array.from({ length: 170 }, async () => {
      await store.requestDemo({ kind: 'inject' })
    }))
    mountTraceShowcase(contextFor(dom, abort), store)
    expect(store.getSnapshot().range.loaded).toBeGreaterThan(500)
    expect(dom.window.document.querySelectorAll('.cxt-row')).toHaveLength(500)
    expect(dom.window.document.querySelector('.cxt-count')?.textContent).toContain('limit 500')
    abort.abort()
  })
})
