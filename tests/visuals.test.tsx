import { Context } from '@deepseek-ai/cordis'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CordisXVisualData, CordisXVisualRenderer, CordisXVisuals } from '../packages/cli/src/contracts.js'
import type { CordisXPluginActivationRecordV1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { GenerationVisibilityCoordinator } from '../packages/cli/src/renderer/generation-visibility.js'
import { CORDISX_PLUGIN_GENERATION, CORDISX_PLUGIN_ID } from '../packages/cli/src/renderer/ownership.js'
import {
  cloneVisualData,
  CordisXVisualService,
  HostVisual,
  VisualRegistry,
} from '../packages/cli/src/renderer/visuals.js'

function installDom(): JSDOM {
  const dom = new JSDOM(
    '<!doctype html><html><body><main data-cordisx-app-theme="light"><div id="root"></div></main></body></html>',
    {
      pretendToBeVisual: true,
      url: 'https://host.invalid/',
    },
  )
  const browser = dom.window
  for (
    const [name, value] of [
      ['window', browser],
      ['document', browser.document],
      ['HTMLElement', browser.HTMLElement],
      ['Element', browser.Element],
      ['Node', browser.Node],
      ['MutationObserver', browser.MutationObserver],
      ['getComputedStyle', browser.getComputedStyle.bind(browser)],
      ['IS_REACT_ACT_ENVIRONMENT', true],
    ] as const
  ) vi.stubGlobal(name, value)
  return dom
}

async function unmount(root: Root | undefined, dom: JSDOM): Promise<void> {
  if (root !== undefined) await act(async () => root.unmount())
  dom.window.close()
}

afterEach(() => vi.unstubAllGlobals())

function activation(revision: number, generation: string): CordisXPluginActivationRecordV1 {
  return {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: revision === 1 ? 'active' : 'candidate',
    ...(revision === 1 ? {} : { transactionId: 'visual-update' }),
    profileId: 'default',
    revision,
    lastGoodRevision: 1,
    runtimeGeneration: 'runtime-1',
    plugins: [{
      id: 'metrics.plugin',
      version: '1.0.0',
      digest: `sha256:${(revision === 1 ? 'a' : 'b').repeat(64)}`,
      moduleGeneration: generation,
      enabled: true,
      dependencies: [],
    }],
  }
}

describe('visual data', () => {
  it('exports the public authoring types through cordisx/contracts', () => {
    const sample = { label: 'Ready', points: [1, 1, 2, 3] } as const satisfies CordisXVisualData
    const renderer: CordisXVisualRenderer<typeof sample> = ({ data }) => <i>{data.label}</i>
    const register: CordisXVisuals['register'] = (_id, _renderer) => () => undefined
    expect(renderer).toBeTypeOf('function')
    expect(register('status-indicator', renderer)).toBeTypeOf('function')
  })

  it('detaches and deeply freezes opaque JSON-compatible values', () => {
    const input = { label: 'Operational', series: [2, 3, 5], detail: { rising: true } }
    const output = cloneVisualData(input)
    expect(output).toEqual(input)
    expect(output).not.toBe(input)
    expect(Object.isFrozen(output)).toBe(true)
    expect(Object.isFrozen((output as typeof input).series)).toBe(true)
    expect(Object.isFrozen((output as typeof input).detail)).toBe(true)
    expect(Object.isFrozen(input.detail)).toBe(false)
  })

  it('rejects values that cannot cross the opaque JSON boundary exactly', () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 })
    expect(() => cloneVisualData(Number.NaN)).toThrow(/finite/)
    expect(() => cloneVisualData({ value: undefined })).toThrow(/JSON-compatible/)
    expect(() => cloneVisualData(new Date())).toThrow(/plain or null prototype/)
    expect(() => cloneVisualData(cyclic)).toThrow(/cycles/)
    expect(() => cloneVisualData(accessor)).toThrow(/data properties/)
    expect(() => cloneVisualData(Array(1))).toThrow(/dense/)
  })
})

describe('visual provider runtime', () => {
  it('isolates exact owners, projects theme, and cleans up with the registering fiber', async () => {
    const dom = installDom()
    const registry = new VisualRegistry(dom.window.document)
    const rootContext = new Context()
    const serviceFiber = rootContext.plugin(CordisXVisualService, registry)
    await serviceFiber
    const cleanup = vi.fn()
    const projections: unknown[] = []
    const pluginContext = rootContext.extend({ [CORDISX_PLUGIN_ID]: 'status.plugin' })
    const pluginFiber = pluginContext.plugin({
      inject: ['visuals'],
      apply(ctx: Context) {
        ctx.visuals.register('health-badge', ({ data, theme }) => {
          React.useEffect(() => cleanup, [])
          projections.push(data)
          return <span data-health-theme={theme}>{(data as { label: string }).label}</span>
        })
      },
    })
    await pluginFiber
    const unrelated = new Context().extend({ [CORDISX_PLUGIN_ID]: 'other.plugin' })
    const removeOther = registry.register(
      unrelated,
      'health-badge',
      ({ theme }) => <span data-other-theme={theme}>Independent</span>,
    )
    let root: Root | undefined
    try {
      root = createRoot(dom.window.document.getElementById('root')!)
      const input = { label: 'Operational', detail: { code: 200 } }
      await act(async () =>
        root!.render(
          <>
            <HostVisual owner="status.plugin" id="health-badge" data={input} />
            <HostVisual owner="other.plugin" id="health-badge" data={input} />
          </>,
        )
      )
      expect(dom.window.document.querySelectorAll('[data-health-theme]')).toHaveLength(1)
      expect(dom.window.document.querySelectorAll('[data-other-theme]')).toHaveLength(1)
      expect(dom.window.document.querySelector('[data-health-theme]')?.textContent).toBe('Operational')
      expect(dom.window.document.querySelector('[data-other-theme]')?.textContent).toBe('Independent')
      expect(projections[0]).not.toBe(input)
      expect(Object.isFrozen(projections[0])).toBe(true)
      expect(Object.isFrozen((projections[0] as typeof input).detail)).toBe(true)

      await act(async () => {
        dom.window.document.documentElement.dataset.theme = 'dark'
      })
      expect(dom.window.document.querySelector('[data-health-theme]')?.getAttribute('data-health-theme')).toBe('dark')

      let removeChart = () => undefined
      await act(async () => {
        removeChart = registry.register(unrelated, 'trend-chart', () => <i />)
      })
      expect(cleanup).not.toHaveBeenCalled()
      await act(async () => pluginFiber.dispose())
      expect(cleanup).toHaveBeenCalledOnce()
      expect(dom.window.document.querySelector('[data-health-theme]')).toBeNull()
      expect(dom.window.document.querySelector('[data-other-theme]')?.textContent).toBe('Independent')
      expect(dom.window.document.querySelectorAll('[data-cordisx-visual]')).toHaveLength(2)
      await act(async () => removeChart())
    } finally {
      if (root === undefined) removeOther()
      else await act(async () => removeOther())
      await unmount(root, dom)
      await serviceFiber.dispose()
    }
  })

  it('keeps candidates hidden, publishes once, and restores the last-good generation on rollback', () => {
    const dom = installDom()
    const before = activation(1, 'generation-old')
    const after = activation(2, 'generation-new')
    const visibility = new GenerationVisibilityCoordinator(before)
    const registry = new VisualRegistry(dom.window.document, visibility)
    const previous = () => <i>previous</i>
    const candidate = () => <i>candidate</i>
    const oldContext = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'metrics.plugin',
      [CORDISX_PLUGIN_GENERATION]: 'generation-old',
    })
    const removePrevious = registry.register(oldContext, 'sparkline', previous)
    expect(() => registry.register(oldContext, 'sparkline', previous)).toThrow(/already registered/)
    let notifications = 0
    const unsubscribe = registry.subscribe(() => {
      notifications += 1
    })
    const handle = visibility.begin('visual-update', before, after)
    const nextContext = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'metrics.plugin',
      [CORDISX_PLUGIN_GENERATION]: 'generation-new',
      ...visibility.context(handle, 'metrics.plugin'),
    })
    const removeCandidate = registry.register(nextContext, 'sparkline', candidate)
    expect(registry.registration('metrics.plugin', 'sparkline')?.renderer).toBe(previous)
    expect(notifications).toBe(0)

    const publication = visibility.publish(visibility.preparePublish(handle, visibility.confirmReadiness(handle)))
    expect(registry.registration('metrics.plugin', 'sparkline')?.renderer).toBe(candidate)
    expect(notifications).toBe(1)
    visibility.rollback(publication)
    expect(registry.registration('metrics.plugin', 'sparkline')?.renderer).toBe(previous)
    expect(notifications).toBe(2)

    removeCandidate()
    expect(notifications).toBe(2)
    removePrevious()
    removePrevious()
    expect(notifications).toBe(3)
    expect(registry.registration('metrics.plugin', 'sparkline')).toBeUndefined()
    unsubscribe()
    registry.dispose()
    dom.window.close()
  })

  it('contains provider failures and leaves invalid or missing projections blank', async () => {
    const dom = installDom()
    const registry = new VisualRegistry(dom.window.document)
    const owner = new Context().extend({ [CORDISX_PLUGIN_ID]: 'badge.plugin' })
    registry.register(owner, 'broken-badge', ({ data }) => {
      if ((data as { fail?: boolean }).fail === true) throw new Error('render failed')
      return <b>Recovered</b>
    })
    expect(() => registry.register(new Context(), 'broken-badge', () => null)).toThrow(/plugin owner/)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let root: Root | undefined
    try {
      root = createRoot(dom.window.document.getElementById('root')!)
      await act(async () =>
        root!.render(
          <>
            <HostVisual owner="badge.plugin" id="broken-badge" data={{ fail: true }} />
            <HostVisual owner="badge.plugin" id="missing-badge" data={{ value: 1 }} />
            <HostVisual owner="badge.plugin" id="broken-badge" data={{ value: undefined }} />
            <button type="button">Host action</button>
          </>,
        )
      )
      expect(dom.window.document.querySelectorAll('[data-cordisx-visual]')).toHaveLength(3)
      expect([...dom.window.document.querySelectorAll('[data-cordisx-visual]')].every(item => item.textContent === ''))
        .toBe(true)
      expect(dom.window.document.querySelector('button')?.textContent).toBe('Host action')
      await act(async () =>
        root!.render(
          <>
            <HostVisual owner="badge.plugin" id="broken-badge" data={{ fail: false }} />
            <button type="button">Host action</button>
          </>,
        )
      )
      expect(dom.window.document.querySelector('[data-cordisx-visual]')?.textContent).toBe('Recovered')
      expect(dom.window.document.querySelector('button')?.textContent).toBe('Host action')
    } finally {
      errors.mockRestore()
      await unmount(root, dom)
      registry.dispose()
    }
  })
})
