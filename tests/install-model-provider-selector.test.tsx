import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder, TextEncoder } from 'node:util'
import { act } from 'react'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PINS } from '../packages/cli/src/renderer/codex-desktop-agent-session-transport.js'
import { installModelProviderSelector } from '../packages/cli/src/renderer/install-model-provider-selector.js'
import { ModelProviderRegistry } from '../packages/cli/src/renderer/model-providers.js'
import { CodexDesktopNativeModelProviderTransport } from '../packages/cli/src/renderer/native-model-provider-transport.js'
import type { NativeProviderSelectionCommandChannel } from '../packages/cli/src/renderer/native-provider-selection-client.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import type { CordisXConfig } from '../packages/cli/src/launcher/config.js'

const originals = new Map<string, PropertyDescriptor | undefined>()
const rendererOwner = { targetId: 'native-target', rendererGeneration: 'native-generation' }
function nativeProviderChannel(): NativeProviderSelectionCommandChannel {
  return {
    selectionRead: vi.fn(async ({ effective }) => ({
      available: true,
      revision: 1,
      effective: effective ?? { providerId: 'provider-a', model: 'model-a' },
    })),
    selectionSelect: vi.fn(async input => ({
      status: 'accepted',
      revision: 2,
      effective: { providerId: 'provider-a', model: 'model-a' },
      pending: { providerId: input.providerId, model: input.model, generation: 1 },
    })),
    submissionPrepare: vi.fn(async () => ({ status: 'pass-through' })),
    submissionConfirm: vi.fn(async () => ({ status: 'allow-original', operationToken: 'native-operation-token' })),
    submissionCancel: vi.fn(async () => undefined),
  }
}

function install(name: string, value: unknown): void {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const [name, descriptor] of originals) {
    if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name]
    else Object.defineProperty(globalThis, name, descriptor)
  }
  originals.clear()
})

describe('native model provider selector installation', () => {
  it('restores the full enhanced selector from provider catalog data while native state is temporarily unavailable', async () => {
    const dom = new JSDOM(
      `<!doctype html><body>
      <main data-codex-composer-root data-composer-placement="home">
        <footer data-composer-footer-responsive>
          <span id="native-group"><span aria-haspopup="menu"><button data-codex-intelligence-trigger="true" aria-haspopup="menu">Model</button></span></span>
        </footer>
      </main>
    </body>`,
      { url: 'app://-/index.html' },
    )
    install('window', dom.window)
    install('document', dom.window.document)
    install('location', dom.window.location)
    install('HTMLElement', dom.window.HTMLElement)
    install('Element', dom.window.Element)
    install('Node', dom.window.Node)
    install('MutationObserver', dom.window.MutationObserver)
    install('IS_REACT_ACT_ENVIRONMENT', true)
    install('codexWindowType', 'electron')
    Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} })
    for (const element of dom.window.document.querySelectorAll<HTMLElement>('*')) {
      element.getBoundingClientRect = () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 20,
        bottom: 20,
        width: 20,
        height: 20,
        toJSON: () => ({}),
      })
    }

    const listeners = new Set<() => void>()
    const unavailableSnapshot = Object.freeze({ available: false, busy: false })
    vi.spyOn(CodexDesktopNativeModelProviderTransport, 'connect').mockResolvedValue({
      getSnapshot: () => unavailableSnapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      hasActiveSubmission: () => false,
      dispose: vi.fn(),
    } as never)
    const registry = new ModelProviderRegistry(async () => [{
      providerId: 'provider-a',
      pluginId: 'provider-plugin',
      models: [{ id: 'model-a', label: 'Model A' }],
    }])

    let dispose = () => {}
    await act(async () => {
      dispose = await installModelProviderSelector(
        dom.window.document,
        registry,
        () => 'en',
        true,
        rendererOwner,
        nativeProviderChannel(),
      )
    })

    const trigger = dom.window.document.querySelector<HTMLElement>('[data-codex-intelligence-trigger]')!
    expect(trigger.hidden).toBe(true)
    expect(dom.window.document.querySelector('[data-cordisx-model-provider-selector]')).not.toBeNull()
    expect(dom.window.document.querySelector('.cxmp-provider-trigger')).not.toBeNull()
    expect(dom.window.document.querySelector('.cxmp-model-trigger')).not.toBeNull()

    await act(async () => dispose())
    registry.dispose()
    dom.window.close()
  })

  it.each(['models', 'login-only', 'empty'])(
    'owns one seat for a %s catalog and restores the native trigger only on disposal',
    async catalogKind => {
      const dom = new JSDOM(
        `<!doctype html><body>
      <main data-codex-composer-root data-composer-placement="home">
        <footer data-composer-footer-responsive>
          <span id="native-group"><span aria-haspopup="menu" aria-expanded="false"><button data-codex-intelligence-trigger="true" aria-haspopup="menu">Model</button></span></span>
        </footer>
      </main>
    </body>`,
        { url: 'app://-/index.html' },
      )
      install('window', dom.window)
      install('document', dom.window.document)
      install('location', dom.window.location)
      install('HTMLElement', dom.window.HTMLElement)
      install('Element', dom.window.Element)
      install('Node', dom.window.Node)
      install('MutationObserver', dom.window.MutationObserver)
      install('IS_REACT_ACT_ENVIRONMENT', true)
      install('codexWindowType', 'electron')
      Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} })

      for (const element of dom.window.document.querySelectorAll<HTMLElement>('*')) {
        element.getBoundingClientRect = () => ({
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 20,
          bottom: 20,
          width: 20,
          height: 20,
          toJSON: () => ({}),
        })
      }
      const trigger = dom.window.document.querySelector<HTMLElement>('[data-codex-intelligence-trigger]')!
      const group = dom.window.document.getElementById('native-group')!
      const nativeClick = vi.fn()
      group.addEventListener('click', nativeClick)
      group.addEventListener('pointerdown', nativeClick)
      trigger.style.setProperty('display', 'flex', 'important')
      Object.defineProperty(trigger, '__reactFiber$test', {
        configurable: true,
        value: {
          memoizedProps: {},
          return: {
            memoizedProps: {
              model: 'model-a',
              reasoningEffort: 'high',
              models: [{
                model: 'model-a',
                displayName: 'Model A',
                supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
              }],
              modelOptions: [{ model: { model: 'model-a' }, disabledReason: null }],
              powerSelections: [
                { model: 'model-a', reasoningEffort: 'low' },
                { model: 'model-a', reasoningEffort: 'high' },
              ],
              menuView: 'simple',
              open: false,
              showReasoningEffortControls: true,
              onSelectModelOption: () => {},
              onToggleMenuView: () => {},
              onSelectModel: async () => {},
              onSelectReasoningEffort: async () => {},
            },
          },
        },
      })
      install('electronBridge', {
        getSentryInitOptions: async () => ({ ...CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PINS[1] }),
        sendMessageFromView: async (envelope: { request?: { id?: string; method?: string } }) => {
          if (envelope.request?.method !== 'config/read') return
          queueMicrotask(() => {
            dom.window.dispatchEvent(
              new dom.window.MessageEvent('message', {
                data: {
                  type: 'mcp-response',
                  hostId: 'local',
                  message: {
                    id: envelope.request!.id,
                    result: {
                      config: {
                        model_provider: 'provider-a',
                        model: 'model-a',
                        model_reasoning_effort: 'high',
                      },
                    },
                  },
                },
                source: dom.window,
              }),
            )
          })
        },
      })
      const load = vi.fn(async () =>
        catalogKind === 'models'
          ? [{
            providerId: 'provider-a',
            pluginId: 'provider-plugin',
            models: [{ id: 'model-a', label: 'Model A' }],
          }]
          : []
      )
      const registry = new ModelProviderRegistry(load)
      const binding = registry.bind('provider-plugin', 'one', () => true)
      if (catalogKind === 'login-only') {
        binding.facade.insert({
          id: 'login',
          label: 'Provider A',
          icon: 'host:key',
          action: { label: 'Log in', icon: 'host:key', run: async () => {} },
        })
      }

      let dispose = () => {}
      await act(async () => {
        dispose = await installModelProviderSelector(
          dom.window.document,
          registry,
          () => 'en',
          true,
          rendererOwner,
          nativeProviderChannel(),
        )
      })
      expect(trigger.hidden).toBe(true)
      expect(trigger.dataset.cordisxModelProviderHidden).toBe('true')
      expect(dom.window.getComputedStyle(trigger).display).toBe('none')
      expect(dom.window.document.querySelectorAll('[data-cordisx-model-provider-selector]')).toHaveLength(1)
      expect(dom.window.document.querySelector('.cxmp-model-label')?.textContent).toBe('Model A')
      expect(dom.window.document.querySelector('.cxmp-effort-label')?.textContent).toBe('High')
      const seat = dom.window.document.querySelector<HTMLElement>('[data-cordisx-model-provider-selector]')!
      expect(seat.parentElement).toBe(group.parentElement)
      expect(group.contains(seat)).toBe(false)
      expect(group.hidden).toBe(true)
      expect(dom.window.getComputedStyle(group).display).toBe('none')
      expect(dom.window.getComputedStyle(group).visibility).toBe('hidden')
      expect(dom.window.getComputedStyle(group).pointerEvents).toBe('none')
      for (const button of seat.querySelectorAll<HTMLButtonElement>('button')) {
        await act(async () => {
          button.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))
          button.click()
        })
      }
      expect(nativeClick).not.toHaveBeenCalled()
      expect(group.firstElementChild?.getAttribute('aria-expanded')).toBe('false')

      await act(async () => {
        binding.dispose()
        load.mockRejectedValueOnce(new Error('catalog offline'))
        await registry.refresh()
      })
      expect(dom.window.document.querySelectorAll('.cxmp-trigger')).toHaveLength(2)
      expect(dom.window.getComputedStyle(trigger).display).toBe('none')

      await act(async () => dispose())
      expect(trigger.hidden).toBe(false)
      expect(group.hidden).toBe(false)
      expect(group.getAttribute('aria-hidden')).toBeNull()
      expect(group.style.pointerEvents).toBe('')
      expect(trigger.dataset.cordisxModelProviderHidden).toBeUndefined()
      expect(trigger.style.getPropertyValue('display')).toBe('flex')
      expect(trigger.style.getPropertyPriority('display')).toBe('important')
      expect(dom.window.document.querySelectorAll('[data-cordisx-model-provider-selector]')).toHaveLength(0)

      registry.dispose()
      dom.window.close()
    },
  )

  it('keeps the native trigger when managed routing metadata is absent', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const config: CordisXConfig = {
      version: 1,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [],
    }
    const bundle = await buildRendererBundle(config, {
      profileId: 'cleanup-test',
      generation: 'cleanup-test-generation',
      managedServiceUICapabilities: [{
        pluginId: 'provider-plugin',
        pluginGeneration: 'provider-generation',
        token: 'provider-token',
      }],
    })
    const dom = new JSDOM(
      `<!doctype html><html><body>
      <div class="sidebar-header"><button aria-haspopup="menu">Codex</button></div>
      <main data-codex-composer-root data-composer-placement="home">
        <footer data-composer-footer-responsive>
          <span><button data-codex-intelligence-trigger="true" aria-haspopup="menu">Model</button></span>
        </footer>
      </main>
    </body></html>`,
      { runScripts: 'dangerously', url: 'app://-/index.html' },
    )
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
      value: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 20,
        bottom: 20,
        width: 20,
        height: 20,
        toJSON: () => ({}),
      }),
    })
    Object.defineProperty(dom.window, 'structuredClone', { value: globalThis.structuredClone })
    Object.defineProperty(dom.window, 'TextEncoder', { value: TextEncoder })
    Object.defineProperty(dom.window, 'TextDecoder', { value: TextDecoder })
    Object.defineProperty(dom.window, 'codexWindowType', { configurable: true, value: 'electron' })
    const trigger = dom.window.document.querySelector<HTMLElement>('[data-codex-intelligence-trigger]')!
    Object.defineProperty(trigger, '__reactFiber$test', {
      configurable: true,
      value: {
        memoizedProps: {},
        return: {
          memoizedProps: {
            model: 'model-a',
            reasoningEffort: 'high',
            models: [{
              model: 'model-a',
              supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
            }],
            modelOptions: [{ model: { model: 'model-a' }, disabledReason: null }],
            powerSelections: [
              { model: 'model-a', reasoningEffort: 'low' },
              { model: 'model-a', reasoningEffort: 'high' },
            ],
            menuView: 'simple',
            open: false,
            showReasoningEffortControls: true,
            onSelectModelOption: () => {},
            onToggleMenuView: () => {},
            onSelectModel: async () => {},
            onSelectReasoningEffort: async () => {},
          },
        },
      },
    })
    Object.defineProperty(dom.window, 'electronBridge', {
      configurable: true,
      value: {
        getSentryInitOptions: async () => ({ ...CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PINS[1] }),
        sendMessageFromView: async (envelope: { request?: { id?: string; method?: string } }) => {
          if (envelope.request?.method !== 'config/read') return
          queueMicrotask(() => {
            dom.window.dispatchEvent(
              new dom.window.MessageEvent('message', {
                data: {
                  type: 'mcp-response',
                  hostId: 'local',
                  message: {
                    id: envelope.request!.id,
                    result: {
                      config: {
                        model_provider: 'provider-a',
                        model: 'model-a',
                        model_reasoning_effort: 'high',
                      },
                    },
                  },
                },
                source: dom.window,
              }),
            )
          })
        },
      },
    })
    Object.defineProperty(dom.window, '__cordisxManagedServiceUIRequestV1', {
      configurable: true,
      value: (payload: string) => {
        const request = JSON.parse(payload) as { requestId: string; operation: string }
        if (request.operation !== 'nativeProviders') return
        queueMicrotask(() => {
          dom.window.__cordisxManagedServiceUIReceiveV1?.(JSON.stringify({
            requestId: request.requestId,
            ok: true,
            value: [{
              providerId: 'provider-a',
              pluginId: 'provider-plugin',
              models: [{ id: 'model-a', label: 'Model A' }],
            }],
          }))
        })
      },
    })

    dom.window.eval(bundle)
    await (dom.window as unknown as { __cordisxBoot?: Promise<unknown> }).__cordisxBoot
    expect(trigger.hidden).toBe(false)
    expect(trigger.dataset.cordisxModelProviderHidden).toBeUndefined()
    expect(dom.window.document.querySelectorAll('[data-cordisx-model-provider-selector]')).toHaveLength(0)

    await (dom.window as unknown as { __cordisxRuntime?: { dispose(): Promise<void> } }).__cordisxRuntime?.dispose()
    expect(trigger.hidden).toBe(false)
    expect(trigger.dataset.cordisxModelProviderHidden).toBeUndefined()
    expect(dom.window.document.querySelectorAll('[data-cordisx-model-provider-selector]')).toHaveLength(0)
    dom.window.close()
  }, 10_000)

  it('does not mount plugin selector actions when managed routing is unavailable', async () => {
    const dom = new JSDOM(
      `<!doctype html><body>
      <main data-codex-composer-root data-composer-placement="home">
        <footer data-composer-footer-responsive>
          <span><button data-codex-intelligence-trigger="true" aria-haspopup="menu">Model</button></span>
        </footer>
      </main>
    </body>`,
      { url: 'app://-/index.html' },
    )
    install('window', dom.window)
    install('document', dom.window.document)
    install('location', dom.window.location)
    install('HTMLElement', dom.window.HTMLElement)
    install('Element', dom.window.Element)
    install('Node', dom.window.Node)
    install('MutationObserver', dom.window.MutationObserver)
    install('codexWindowType', 'electron')
    const sendMessageFromView = vi.fn(async () => {})
    install('electronBridge', {
      getSentryInitOptions: async () => ({ ...CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PINS[1] }),
      sendMessageFromView,
    })
    const registry = new ModelProviderRegistry(async () => [])
    const binding = registry.bind('provider-plugin', 'generation-one', () => true)
    binding.facade.insert({
      id: 'account',
      label: 'Account',
      icon: 'host:settings',
      action: { label: 'Open account', icon: 'host:settings', run: async () => {} },
    })

    const dispose = await installModelProviderSelector(dom.window.document, registry, () => 'en', false)
    const trigger = dom.window.document.querySelector<HTMLElement>('[data-codex-intelligence-trigger]')!
    expect(trigger.hidden).toBe(false)
    expect(trigger.dataset.cordisxModelProviderHidden).toBeUndefined()
    expect(dom.window.document.querySelectorAll('[data-cordisx-model-provider-selector]')).toHaveLength(0)
    expect(sendMessageFromView).not.toHaveBeenCalled()

    dispose()
    binding.dispose()
    registry.dispose()
    dom.window.close()
  })
})
