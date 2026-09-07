import type {
  AgentConversationShellBinding,
  AgentConversationShellSnapshot,
  AgentConversationShellSource,
} from '@cordisx/protocol/agent-conversation-shell/v1'
import { Context } from '@deepseek-ai/cordis'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CordisXPageMountContext } from '../packages/cli/src/contracts.js'
import { AgentConversationShellRegistry } from '../packages/cli/src/renderer/agent-conversation-shell.js'
import { isAgentConversationPageMount } from '../packages/cli/src/renderer/agent-conversation-page.js'
import { CommandRegistry, CordisXCommandService } from '../packages/cli/src/renderer/commands.js'
import { CordisXI18nService } from '../packages/cli/src/renderer/i18n.js'
import { CORDISX_PLUGIN_GENERATION, CORDISX_PLUGIN_ID } from '../packages/cli/src/renderer/ownership.js'
import { installSharedReactRuntime } from '../packages/cli/src/renderer/react-runtime.js'

const globals = new Map<string, unknown>()

function installDom(): JSDOM {
  const dom = new JSDOM(
    '<!doctype html><html><body><main id="page" class="cxr-react-root" data-cordisx-page-chrome-policy="agent-conversation"></main></body></html>',
    { url: 'https://host.invalid/' },
  )
  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  })
  Object.defineProperty(dom.window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => dom.window.setTimeout(() => callback(Date.now()), 0),
  })
  Object.defineProperty(dom.window, 'cancelAnimationFrame', {
    configurable: true,
    value: (handle: number) => dom.window.clearTimeout(handle),
  })
  for (
    const [key, value] of Object.entries({
      document: dom.window.document,
      window: dom.window,
      HTMLElement: dom.window.HTMLElement,
      HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
      Element: dom.window.Element,
      Node: dom.window.Node,
      MutationObserver: dom.window.MutationObserver,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      requestAnimationFrame: (callback: FrameRequestCallback) => dom.window.setTimeout(() => callback(Date.now()), 0),
      cancelAnimationFrame: (handle: number) => dom.window.clearTimeout(handle),
      IS_REACT_ACT_ENVIRONMENT: true,
    })
  ) {
    globals.set(key, Reflect.get(globalThis, key))
    Reflect.set(globalThis, key, value)
  }
  return dom
}

function message(key: string, fallback: string) {
  return { namespace: 'chatroom', key, fallback }
}

function noRoom(binding: AgentConversationShellBinding): AgentConversationShellSnapshot {
  return {
    binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
    generation: 'snapshot-1',
    snapshotSequence: 0,
    selection: { kind: 'no-room' },
    items: [],
    composer: {
      availability: 'available',
      placeholder: message('composer.placeholder', 'Write a message…'),
      disabled: { value: false },
      submit: { id: 'create-with-message' },
    },
    headerActions: [],
  }
}

function fakeI18n(): CordisXI18nService {
  return {
    resolveFor: (_owner: string, value: { key: string; fallback?: string }) => ({
      text: value.fallback ?? value.key,
      namespace: 'chatroom',
      key: value.key,
    }),
    clearDiagnosticSite() {},
    getSnapshot: () => ({ locale: 'en', direction: 'ltr', version: 1 }),
    subscribeInternal: () => () => {},
  } as unknown as CordisXI18nService
}

function commandService(registry: CommandRegistry): CordisXCommandService {
  return {
    executeConversationFor: (owner, reference, invocationKey, context) =>
      registry.execute(owner, reference, invocationKey, undefined, undefined, context),
  } as unknown as CordisXCommandService
}

function mountContext(dom: JSDOM): CordisXPageMountContext {
  return {
    container: dom.window.document.getElementById('page')!,
    document: dom.window.document,
    signal: new AbortController().signal,
    routeId: 'chatroom:room',
    outlet: 'main',
    params: {},
    navigation: { navigate: async () => {}, back: async () => {}, close: async () => {} },
    controls: {
      select: () => {
        throw new Error('not used')
      },
      dispose() {},
    },
    localeNamespace: 'chatroom',
    t: key => String(key),
    localization: {} as CordisXPageMountContext['localization'],
  }
}

afterEach(() => {
  for (const [key, value] of globals) Reflect.set(globalThis, key, value)
  globals.clear()
  vi.restoreAllMocks()
})

describe('Host conversation shell mount regression', () => {
  it('mounts the Host shell path edge-to-edge without falling back to the legacy Chatroom page', async () => {
    const dom = installDom()
    const sharedReact = installSharedReactRuntime(dom.window.document)
    const commands = new CommandRegistry()
    const shell = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'shell-regression-generation',
    })
    const registration = shell.register(plugin, binding => {
      const source: AgentConversationShellSource = {
        snapshot: async () => noRoom(binding),
        subscribe: async () => ({
          result: { type: 'subscribe', status: 'unavailable', code: 'owner-unavailable' },
        }),
        dispose() {},
      }
      return source
    })

    expect(isAgentConversationPageMount(registration.mount)).toBe(true)
    let unmount: ReturnType<typeof registration.mount>
    await act(async () => {
      unmount = registration.mount(mountContext(dom))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    await vi.waitFor(() => {
      expect(dom.window.document.querySelector('.cxa-root[data-agent-conversation-runtime-state]')).not.toBeNull()
    })

    const seat = dom.window.document.getElementById('page')!
    expect(seat.firstElementChild?.classList.contains('cxa-root')).toBe(true)
    expect(seat.querySelector('.cx-chatroom-page')).toBeNull()
    expect(dom.window.getComputedStyle(seat).paddingTop).toBe('0px')
    expect(dom.window.getComputedStyle(seat).paddingRight).toBe('0px')
    expect(dom.window.getComputedStyle(seat).paddingBottom).toBe('0px')
    expect(dom.window.getComputedStyle(seat).paddingLeft).toBe('0px')

    await act(async () => {
      if (typeof unmount === 'function') await unmount()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    registration.dispose()
    shell.dispose()
    commands.dispose()
    sharedReact.dispose()
    dom.window.close()
  })
})
