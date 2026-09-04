import path from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildLocalDevelopmentPlugin } from '../packages/cli/src/launcher/development.js'
import { SurfaceRegistry } from '../packages/cli/src/renderer/surfaces.js'
import { HostContextStore } from '../packages/cli/src/renderer/validation.js'
import { TransientCanvasCoordinator, type TransientCanvasStart } from '../packages/cli/src/renderer/transient-canvas.js'

const entry = path.resolve('tests/fixtures/send-confetti-plugin/src/send-confetti.ts')

function setup(reducedMotion = false) {
  const dom = new JSDOM('<!doctype html><html><body><form><button type="submit">Send</button></form></body></html>', {
    url: 'https://codex.local/',
    pretendToBeVisual: true,
  })
  const transferred = { kind: 'offscreen' } as unknown as OffscreenCanvas
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
    configurable: true,
    value: () => transferred,
  })
  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: reducedMotion }),
  })
  const contexts = new HostContextStore()
  const surfaces = new SurfaceRegistry(contexts)
  surfaces.setCurrentContext([{ surface: 'composer.submit.effects', state: 'active' }])
  const coordinator = new TransientCanvasCoordinator(dom.window.document, surfaces)
  const starts: TransientCanvasStart[] = []
  const stops: string[] = []
  const bound = coordinator.bind({
    owner: 'canvas-plugin',
    source: 'https://plugins.example/canvas-plugin',
    moduleGeneration: 'generation-1',
    generation: { pluginId: 'canvas-plugin', moduleGeneration: 'generation-1' },
    sink: { start: input => starts.push(input), stop: id => stops.push(id) },
  })
  const button = dom.window.document.querySelector<HTMLButtonElement>('button')!
  coordinator.updateSubmitButton(button)
  const dispose = (): void => {
    bound.dispose()
    coordinator.dispose()
    surfaces.dispose()
    contexts.dispose()
    dom.window.close()
  }
  return { dom, transferred, surfaces, coordinator, bound, button, starts, stops, dispose }
}

describe('isolated transient canvas extension', () => {
  afterEach(() => vi.useRealTimers())

  it('builds the maintained example with a v7 isolated-worker manifest and no DOM capability', async () => {
    const build = await buildLocalDevelopmentPlugin(entry)
    expect(build).toMatchObject({
      id: 'send-confetti',
      manifest: {
        schemaVersion: 7,
        capabilities: [],
        execution: { realm: 'isolated-worker', interfaces: ['ui.transient-canvas/v1'] },
      },
    })
    expect(build.moduleFactorySource).toContain('composer.submit.effects')
    expect(build.moduleFactorySource).not.toMatch(/\bdocument\b|\bwindow\b|querySelector/u)
  })

  it('hands an OffscreenCanvas to the selected worker after semantic form submit', async () => {
    vi.useFakeTimers()
    const runtime = setup()
    try {
      await runtime.bound.register({
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/transient-canvas-registration.v1.schema.json',
        schemaVersion: 1,
        id: 'sparkles',
        pointId: 'composer.submit.effects',
        durationMs: 800,
        reducedMotion: 'static',
      })
      const event = new runtime.dom.window.SubmitEvent('submit', {
        bubbles: true,
        cancelable: true,
        submitter: runtime.button,
      })
      runtime.button.form!.dispatchEvent(event)
      await Promise.resolve()

      expect(runtime.starts).toHaveLength(1)
      expect(runtime.starts[0]).toMatchObject({
        registrationId: 'sparkles',
        canvas: runtime.transferred,
        reducedMotion: false,
      })
      const canvas = runtime.dom.window.document.querySelector<HTMLCanvasElement>('[data-cordisx-transient-canvas="sparkles"]')
      expect(canvas?.style.pointerEvents).toBe('none')
      expect(canvas?.getAttribute('aria-hidden')).toBe('true')
      expect(runtime.starts[0]).not.toHaveProperty('document')
      expect(runtime.starts[0]).not.toHaveProperty('window')

      runtime.dom.window.dispatchEvent(new runtime.dom.window.Event('resize'))
      expect(runtime.dom.window.document.querySelector('[data-cordisx-transient-canvas]')).toBeNull()
      expect(runtime.stops).toEqual([runtime.starts[0]!.sessionId])

      runtime.button.form!.dispatchEvent(new runtime.dom.window.SubmitEvent('submit', {
        bubbles: true,
        cancelable: true,
        submitter: runtime.button,
      }))
      await Promise.resolve()
      expect(runtime.starts).toHaveLength(2)
      vi.advanceTimersByTime(800)
      expect(runtime.dom.window.document.querySelector('[data-cordisx-transient-canvas]')).toBeNull()
      expect(runtime.stops).toEqual([runtime.starts[0]!.sessionId, runtime.starts[1]!.sessionId])
    } finally {
      runtime.dispose()
    }
  })

  it('fails closed for invalid declarations and honors reduced-motion skip', async () => {
    const runtime = setup(true)
    try {
      await expect(runtime.bound.register({
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/transient-canvas-registration.v1.schema.json',
        schemaVersion: 1,
        id: 'too-long',
        pointId: 'composer.submit.effects',
        durationMs: 5001,
        reducedMotion: 'skip',
      })).rejects.toThrow(/durationMs/u)
      await runtime.bound.register({
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/transient-canvas-registration.v1.schema.json',
        schemaVersion: 1,
        id: 'quiet',
        pointId: 'composer.submit.effects',
        durationMs: 500,
        reducedMotion: 'skip',
      })
      runtime.button.form!.dispatchEvent(new runtime.dom.window.SubmitEvent('submit', {
        bubbles: true,
        cancelable: true,
        submitter: runtime.button,
      }))
      await Promise.resolve()
      expect(runtime.starts).toEqual([])
      expect(runtime.dom.window.document.querySelector('[data-cordisx-transient-canvas]')).toBeNull()
    } finally {
      runtime.dispose()
    }
  })
})
