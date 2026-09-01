import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CORDISX_COMPOSER_SUBMIT_CELEBRATION_PROFILE_V1,
} from '../packages/cli/src/contracts.js'
import {
  CORDISX_CODEX_CONTROL_CATALOG,
  ComposerSubmitCelebrationControlBinding,
} from '../packages/cli/src/renderer/adapter.js'
import {
  ControlledSurfaceCoordinator,
  ControlledSurfacePolicyBroker,
  MemoryControlledSurfacePolicyStore,
  normalizeControlledSurfaceDeclaration,
} from '../packages/cli/src/renderer/controlled-surfaces.js'
import { buildLocalDevelopmentPlugin } from '../packages/cli/src/launcher/development.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import type { CordisXConfig } from '../packages/cli/src/launcher/config.js'

const pluginId = 'celebration'
const source = 'https://plugins.example/celebration'
const principalHandle = 'principal:celebration'

function setup(authorized = true) {
  const dom = new JSDOM('<!doctype html><html><body><button id="submit">Send</button></body></html>', {
    url: 'https://codex.local/',
    pretendToBeVisual: true,
  })
  const button = dom.window.document.querySelector<HTMLButtonElement>('#submit')!
  const generation = {
    principalHandle,
    principalOrigin: 'explicit' as const,
    source,
    pluginId,
    moduleGeneration: 'celebration-v1',
  }
  const policies = new ControlledSurfacePolicyBroker(new MemoryControlledSurfacePolicyStore({
    schemaVersion: 1,
    principals: [{ handle: principalHandle, source, pluginId, origin: 'explicit' }],
    authorizations: [],
    choices: [],
  }))
  const celebration = new ComposerSubmitCelebrationControlBinding(dom.window.document)
  const visibleGenerations = new Set(['celebration-v1'])
  const coordinator = new ControlledSurfaceCoordinator(CORDISX_CODEX_CONTROL_CATALOG, {
    'composer.reasoning-intensity': {
      currentState: () => ({ state: 'not-mounted', reason: 'point.not-mounted' }),
      readProperty: () => null,
      dispatch: () => undefined,
    },
    'composer.toolbar.items': celebration,
  }, 'host-celebration', policies, candidate => visibleGenerations.has(candidate.moduleGeneration ?? ''))
  celebration.connect(coordinator)
  celebration.update(button)
  const declaration = normalizeControlledSurfaceDeclaration({
    principalHandle,
    source,
    pluginId,
    pointId: 'composer.toolbar.items',
    contributionId: 'submit-celebration',
    control: {
      claimId: 'submit-celebration',
      mode: 'proxy',
      priority: 100,
      requestedBindings: {
        properties: ['celebrationProfile'],
        commands: ['presentCelebration', 'dismissCelebration'],
        events: ['submitActivated'],
      },
    },
  })
  const registration = coordinator.register({
    declaration,
    generation,
    presenter: {},
    hostAccess: () => authorized ? { authorized: true } : { authorized: false, reason: 'authorization.denied' },
  })
  const lease = coordinator.createLease(declaration, generation)
  const dispose = (): void => {
    lease.dispose()
    registration.dispose()
    celebration.dispose()
    coordinator.dispose()
    policies.dispose()
    dom.window.close()
  }
  return { dom, button, celebration, coordinator, declaration, generation, registration, lease, visibleGenerations, dispose }
}

async function activate(input: ReturnType<typeof setup>): Promise<string> {
  input.button.click()
  await Promise.resolve()
  const event = input.lease.snapshot().events.find(item => item.id === 'submitActivated')
  expect(event?.payload.activationId).toEqual(expect.stringMatching(/^activation:/u))
  return String(event!.payload.activationId)
}

describe('composer submit celebration profile', () => {
  afterEach(() => vi.useRealTimers())

  it('builds the maintained agent-authored entry as the exact managed plugin id', async () => {
    const build = await buildLocalDevelopmentPlugin('tests/fixtures/natural-language.ts')
    expect(build).toMatchObject({ id: 'natural-language', version: expect.any(String) })
    expect(build.moduleFactorySource).toContain('submitActivated')
    expect(build.moduleFactorySource).toContain(CORDISX_COMPOSER_SUBMIT_CELEBRATION_PROFILE_V1)
  })

  it('boots the maintained plugin with only its exact natural-language claim grant', async () => {
    const entry = path.resolve('tests/fixtures/natural-language.ts')
    const source = 'file:///cordisx-local-dev/fixture/natural-language.js'
    const config: CordisXConfig = {
      version: 1,
      rootDir: path.resolve('.'),
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{ id: 'natural-language', entry, source, enabled: true, config: {} }],
    }
    const bundle = await buildRendererBundle(config, {
      playground: true,
      profileId: 'development',
      generation: 'natural-language-celebration-test',
      naturalLanguageControlGrant: {
        profile: CORDISX_COMPOSER_SUBMIT_CELEBRATION_PROFILE_V1,
        identity: { source, id: 'natural-language' },
        pointId: 'composer.toolbar.items',
        contributionId: 'submit-celebration',
        claimId: 'submit-celebration',
        mode: 'proxy',
        priority: 100,
        requestedBindings: {
          properties: ['celebrationProfile'],
          commands: ['presentCelebration', 'dismissCelebration'],
          events: ['submitActivated'],
        },
      },
    })
    expect(pathToFileURL(entry).href).not.toBe(source)
    const dom = new JSDOM(`<!doctype html><html><body>
      <main data-cordisx-playground-session-id="fixture-session">
        <div data-cordisx-playground-surface="composer.toolbar.items">
          <button data-cordisx-playground-template="composer.toolbar">Send</button>
        </div>
      </main>
      <main data-cordisx-playground-seat="app"></main>
      <main data-cordisx-playground-seat="main"></main>
      <main data-cordisx-playground-seat="session.content"></main>
    </body></html>`, { runScripts: 'dangerously', url: 'http://127.0.0.1/' })
    try {
      Object.defineProperty(dom.window, 'structuredClone', { configurable: true, value: structuredClone })
      dom.window.eval(bundle)
      for (let attempt = 0; attempt < 100 && dom.window.document.documentElement.dataset.cordisxReady !== 'true'; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      const runtime = dom.window as unknown as {
        __cordisxRuntime?: {
          snapshot(): { registrations: readonly { owner: string; surface: string; authorized: boolean; control?: { state: string } }[] }
          dispose(): Promise<void>
        }
      }
      expect(runtime.__cordisxRuntime?.snapshot().registrations).toContainEqual(expect.objectContaining({
        owner: 'natural-language', surface: 'composer.toolbar.items', authorized: true,
      }))
      dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-playground-template="composer.toolbar"]')!.click()
      await Promise.resolve()
      await Promise.resolve()
      const effect = dom.window.document.querySelector<HTMLElement>('[data-cordisx-effect="confetti"]')
      expect(effect?.style.pointerEvents).toBe('none')
      expect(effect?.querySelectorAll('.cordisx-confetti-piece')).toHaveLength(96)
      await runtime.__cordisxRuntime?.dispose()
      expect(dom.window.document.querySelector('[data-cordisx-effect="confetti"]')).toBeNull()
    } finally {
      await (dom.window as unknown as { __cordisxRuntime?: { dispose(): Promise<void> } }).__cordisxRuntime?.dispose()
      dom.window.close()
    }
  }, 30_000)

  it('advertises the exact profile and presents one pointer-inert Host effect after native submit', async () => {
    vi.useFakeTimers()
    const runtime = setup()
    try {
      expect(runtime.lease.snapshot()).toMatchObject({
        state: 'selected',
        properties: { celebrationProfile: CORDISX_COMPOSER_SUBMIT_CELEBRATION_PROFILE_V1 },
        commands: [{ id: 'presentCelebration', available: true }, { id: 'dismissCelebration', available: true }],
        events: [],
      })
      expect(runtime.coordinator.snapshot().points.find(item => item.id === 'composer.toolbar.items')?.candidates[0]?.bindings)
        .toMatchObject({ events: [{ id: 'submitActivated', available: true }] })
      const activationId = await activate(runtime)
      await expect(runtime.lease.invoke('presentCelebration', {
        requestId: 'request:first', activationId, effect: 'confetti', durationMs: 2400,
      })).resolves.toMatchObject({ outcome: 'accepted', reason: 'command.accepted' })
      const effect = runtime.dom.window.document.querySelector<HTMLElement>('[data-cordisx-effect="confetti"]')
      expect(effect).not.toBeNull()
      expect(effect?.style.pointerEvents).toBe('none')
      expect(effect?.querySelectorAll('.cordisx-confetti-piece')).toHaveLength(96)

      vi.advanceTimersByTime(2399)
      expect(runtime.dom.window.document.querySelector('[data-cordisx-effect="confetti"]')).not.toBeNull()
      vi.advanceTimersByTime(1)
      expect(runtime.dom.window.document.querySelector('[data-cordisx-effect="confetti"]')).toBeNull()

      await expect(runtime.lease.invoke('presentCelebration', {
        requestId: 'request:first', activationId, effect: 'confetti', durationMs: 2400,
      })).resolves.toMatchObject({ outcome: 'accepted' })
      expect(runtime.dom.window.document.querySelector('[data-cordisx-effect="confetti"]')).toBeNull()
    } finally {
      runtime.dispose()
    }
  })

  it('rejects stale activation, conflicting request reuse, and an out-of-range duration', async () => {
    vi.useFakeTimers()
    const runtime = setup()
    try {
      const activationId = await activate(runtime)
      await expect(runtime.lease.invoke('presentCelebration', {
        requestId: 'request:valid', activationId, effect: 'confetti', durationMs: 100,
      })).resolves.toMatchObject({ outcome: 'rejected', reason: 'argument.out-of-range' })
      await expect(runtime.lease.invoke('presentCelebration', {
        requestId: 'request:valid', activationId, effect: 'confetti', durationMs: 1200,
      })).resolves.toMatchObject({ outcome: 'accepted' })
      await expect(runtime.lease.invoke('presentCelebration', {
        requestId: 'request:valid', activationId, effect: 'confetti', durationMs: 1400,
      })).resolves.toMatchObject({ outcome: 'rejected', reason: 'request.conflict' })
      await expect(runtime.lease.invoke('presentCelebration', {
        requestId: 'request:replay', activationId, effect: 'confetti', durationMs: 1200,
      })).resolves.toMatchObject({ outcome: 'rejected', reason: 'activation.stale' })
    } finally {
      runtime.dispose()
    }
  })

  it('removes active presentation on claim unload and reports point loss or denial explicitly', async () => {
    vi.useFakeTimers()
    const runtime = setup()
    try {
      const activationId = await activate(runtime)
      await runtime.lease.invoke('presentCelebration', {
        requestId: 'request:unload', activationId, effect: 'confetti', durationMs: 5000,
      })
      expect(runtime.dom.window.document.querySelector('[data-cordisx-effect="confetti"]')).not.toBeNull()
      runtime.registration.dispose()
      expect(runtime.dom.window.document.querySelector('[data-cordisx-effect="confetti"]')).toBeNull()
    } finally {
      runtime.dispose()
    }

    const unmounted = setup()
    try {
      unmounted.celebration.update(undefined)
      await expect(unmounted.lease.invoke('presentCelebration', {
        requestId: 'request:missing', activationId: 'activation:missing', effect: 'confetti', durationMs: 1000,
      })).resolves.toMatchObject({ outcome: 'rejected', reason: 'point.not-mounted' })
    } finally {
      unmounted.dispose()
    }

    const denied = setup(false)
    try {
      await expect(denied.lease.invoke('presentCelebration', {
        requestId: 'request:denied', activationId: 'activation:denied', effect: 'confetti', durationMs: 1000,
      })).resolves.toMatchObject({ outcome: 'rejected', reason: 'authorization.denied' })
      expect(denied.dom.window.document.querySelector('[data-cordisx-effect="confetti"]')).toBeNull()
    } finally {
      denied.dispose()
    }
  })

  it('keeps staged generations inert and removes rather than replays an effect across publish and rollback', async () => {
    vi.useFakeTimers()
    const runtime = setup()
    let replacement: ReturnType<typeof runtime.coordinator.register> | undefined
    try {
      const activationId = await activate(runtime)
      await runtime.lease.invoke('presentCelebration', {
        requestId: 'request:generation', activationId, effect: 'confetti', durationMs: 5000,
      })
      replacement = runtime.coordinator.register({
        declaration: runtime.declaration,
        generation: { ...runtime.generation, moduleGeneration: 'celebration-v2' },
        presenter: {},
        hostAccess: () => ({ authorized: true }),
      })
      expect(runtime.dom.window.document.querySelector('[data-cordisx-effect="confetti"]')).not.toBeNull()

      runtime.visibleGenerations.delete('celebration-v1')
      runtime.visibleGenerations.add('celebration-v2')
      runtime.coordinator.invalidate()
      expect(runtime.dom.window.document.querySelector('[data-cordisx-effect="confetti"]')).toBeNull()

      runtime.visibleGenerations.delete('celebration-v2')
      runtime.visibleGenerations.add('celebration-v1')
      runtime.coordinator.invalidate()
      expect(runtime.dom.window.document.querySelector('[data-cordisx-effect="confetti"]')).toBeNull()
    } finally {
      replacement?.dispose()
      runtime.dispose()
    }
  })
})
