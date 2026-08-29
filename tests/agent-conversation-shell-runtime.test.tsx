import type {
  AgentConversationShellBinding,
  AgentConversationShellPage,
  AgentConversationShellSnapshot,
  AgentConversationShellSource,
} from '@cordisx/protocol/agent-conversation-shell/v1'
import { Context } from '@deepseek-ai/cordis'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CordisXCommandContext, CordisXPageMountContext } from '../packages/cli/src/contracts.js'
import {
  AgentConversationShellRegistry,
  CordisXAgentConversationShellService,
} from '../packages/cli/src/renderer/agent-conversation-shell.js'
import { CommandRegistry, CordisXCommandService } from '../packages/cli/src/renderer/commands.js'
import { CordisXI18nService } from '../packages/cli/src/renderer/i18n.js'
import { CORDISX_PLUGIN_GENERATION, CORDISX_PLUGIN_ID } from '../packages/cli/src/renderer/ownership.js'

class PageStream implements AsyncIterableIterator<AgentConversationShellPage> {
  private readonly pages: AgentConversationShellPage[] = []
  private readonly waiting: Array<(value: IteratorResult<AgentConversationShellPage>) => void> = []
  private closed = false

  ;[Symbol.asyncIterator](): AsyncIterableIterator<AgentConversationShellPage> { return this }

  next(): Promise<IteratorResult<AgentConversationShellPage>> {
    const page = this.pages.shift()
    if (page !== undefined) return Promise.resolve({ done: false, value: page })
    if (this.closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise(resolve => this.waiting.push(resolve))
  }

  push(page: AgentConversationShellPage): void {
    const waiter = this.waiting.shift()
    if (waiter === undefined) this.pages.push(page)
    else waiter({ done: false, value: page })
  }

  close(): void {
    this.closed = true
    for (const waiter of this.waiting.splice(0)) waiter({ done: true, value: undefined })
  }
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
      availability: 'unavailable',
      placeholder: message('composer.placeholder', 'Write a message…'),
      disabled: { value: true, reason: message('composer.unavailable', 'Messaging is unavailable.') },
      submit: { id: 'send' },
    },
    headerActions: [{
      id: 'new-room',
      label: message('action.new-room', 'New room'),
      icon: 'host:open',
      command: { id: 'create' },
      disabled: { value: false },
    }],
  }
}

function room(binding: AgentConversationShellBinding): AgentConversationShellSnapshot {
  const participant = {
    participantId: 'agent-one',
    role: 'agent' as const,
    displayName: message('participant.agent-one', 'Agent One'),
  }
  return {
    binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
    generation: 'snapshot-1',
    snapshotSequence: 1,
    selection: {
      kind: 'room',
      roomId: 'room-one',
      title: message('room.title', 'Release review'),
      secondary: message('room.secondary', '1 participant'),
      multiParticipant: false,
      participantPresentation: 'none',
      participants: [participant],
    },
    items: [{
      kind: 'message',
      itemId: 'item-one',
      messageId: 'message-one',
      sequence: 1,
      author: participant,
      body: [{ kind: 'text', text: message('message.one', 'Review is ready.') }],
      timestamp: '2026-08-29T12:00:00.000Z',
      deliveryState: 'delivered',
      runState: 'stopped',
      ariaLive: 'off',
      actions: [],
    }],
    composer: {
      availability: 'unavailable',
      placeholder: message('composer.placeholder', 'Write a message…'),
      disabled: { value: true, reason: message('composer.unavailable', 'Messaging is unavailable.') },
      submit: { id: 'send' },
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
    executeConversationFor: (owner, reference, invocationKey, context) => registry.execute(
      owner,
      reference,
      invocationKey,
      undefined,
      undefined,
      context,
    ),
  } as unknown as CordisXCommandService
}

const globals = new Map<string, unknown>()

function installDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body><main id="page"></main></body></html>', { url: 'https://host.invalid/' })
  for (const [key, value] of Object.entries({
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
  })) {
    globals.set(key, Reflect.get(globalThis, key))
    Reflect.set(globalThis, key, value)
  }
  return dom
}

function mountContext(dom: JSDOM, params: Record<string, string> = {}): CordisXPageMountContext {
  return {
    container: dom.window.document.getElementById('page')!,
    document: dom.window.document,
    signal: new AbortController().signal,
    routeId: 'chatroom:room',
    outlet: 'main',
    params,
    navigation: { navigate: async () => {}, back: async () => {}, close: async () => {} },
    controls: { select: () => { throw new Error('not used') }, dispose() {} },
    localeNamespace: 'chatroom',
    t: key => String(key),
    localization: {} as CordisXPageMountContext['localization'],
  }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 10))
}

afterEach(() => {
  for (const [key, value] of globals) Reflect.set(globalThis, key, value)
  globals.clear()
  vi.restoreAllMocks()
})

describe('Agent conversation shell public runtime', () => {
  it('exposes the agentConversationShell injection and owns registration on the plugin fiber', async () => {
    const dom = installDom()
    const root = new Context()
    const commands = root.plugin(CordisXCommandService)
    const i18n = root.plugin(CordisXI18nService)
    await commands
    await i18n
    const shell = root.plugin(CordisXAgentConversationShellService)
    await shell
    let registration: ReturnType<Context['agentConversationShell']['registerSource']> | undefined
    const pluginContext = root.extend({ [CORDISX_PLUGIN_ID]: 'chatroom', [CORDISX_PLUGIN_GENERATION]: 'generation-1' })
    const plugin = pluginContext.plugin({
      inject: ['agentConversationShell'],
      apply(ctx: Context) {
        registration = ctx.agentConversationShell.registerSource(binding => ({
          snapshot: async () => noRoom(binding),
          subscribe: async () => ({ result: { type: 'subscribe', status: 'unavailable', code: 'owner-unavailable' } }),
          dispose() {},
        }))
      },
    })
    await plugin
    expect(registration?.mount).toBeTypeOf('function')
    await plugin.dispose()
    expect(() => registration!.mount(mountContext(dom))).toThrow(/generation is unavailable/)
    await shell.dispose()
    await i18n.dispose()
    await commands.dispose()
    await settle()
    dom.window.close()
  })

  it('Host-binds a formal source, projects ordered updates, and delivers immutable command context', async () => {
    const dom = installDom()
    const commands = new CommandRegistry()
    let commandContext: CordisXCommandContext | undefined
    commands.register('chatroom', { id: 'create', title: { key: 'create', fallback: 'Create' } }, context => {
      commandContext = context
    })
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'chatroom-generation-1',
    })
    const stream = new PageStream()
    let issuedBinding: AgentConversationShellBinding | undefined
    let disposed = 0
    let unsubscribed = 0
    const registration = runtime.register(plugin, binding => {
      issuedBinding = binding
      const source: AgentConversationShellSource = {
        snapshot: async () => noRoom(binding),
        subscribe: async afterSequence => ({
          result: {
            type: 'subscribe', status: 'accepted', code: 'allowed',
            subscription: {
              subscriptionId: 'subscription-one',
              binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
              generation: 'snapshot-1',
              afterSequence,
              snapshotSequence: afterSequence,
            },
          },
          handle: {
            subscription: {
              subscriptionId: 'subscription-one',
              binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
              generation: 'snapshot-1',
              afterSequence,
              snapshotSequence: afterSequence,
            },
            pages: stream,
            unsubscribe: () => { unsubscribed += 1; stream.close() },
          },
        }),
        dispose: () => { disposed += 1 },
      }
      return source
    })

    const unmount = registration.mount(mountContext(dom, { roomId: 'room-one' }))
    await settle()
    expect(issuedBinding).toBeDefined()
    expect(Object.isFrozen(issuedBinding)).toBe(true)
    expect(issuedBinding?.routeSelection).toEqual({ scope: 'room-or-new', selectedRoomParam: 'room-one' })
    expect(dom.window.document.querySelector('[data-agent-conversation-renderer="production"]')).not.toBeNull()
    expect(dom.window.document.querySelectorAll('.cxa-chrome')).toHaveLength(1)
    expect(dom.window.document.querySelector('[data-agent-conversation-view="new-room"]')).not.toBeNull()

    dom.window.document.querySelector<HTMLButtonElement>('.cxa-empty button')!.click()
    await settle()
    expect(commandContext?.hostContext).toMatchObject({
      binding: { bindingId: issuedBinding!.bindingId, ownerGeneration: issuedBinding!.ownerGeneration },
      generation: 'snapshot-1',
      scope: 'header',
      command: { id: 'create' },
    })
    expect(Object.isFrozen(commandContext?.hostContext)).toBe(true)
    expect(Object.isFrozen((commandContext?.hostContext as { binding: object }).binding)).toBe(true)

    stream.push({
      subscription: {
        subscriptionId: 'subscription-one',
        binding: { bindingId: issuedBinding!.bindingId, ownerGeneration: issuedBinding!.ownerGeneration },
        generation: 'snapshot-1', afterSequence: 0, snapshotSequence: 0,
      },
      afterSequence: 0,
      phase: 'live',
      updates: [{ kind: 'snapshot-replaced', sequence: 1, snapshot: room(issuedBinding!) }],
      nextAfterSequence: 1,
      hasMore: false,
    })
    await settle()
    expect(dom.window.document.querySelector('.cxa-title')?.textContent).toBe('Release review')
    expect(dom.window.document.querySelector('.cxa-participants')?.textContent).toBe('1 participant')
    expect(dom.window.document.querySelectorAll('[data-agent-conversation-scroll-owner="timeline"]')).toHaveLength(1)
    expect(dom.window.document.querySelector('.cxa-avatar')).toBeNull()
    expect(dom.window.document.querySelector<HTMLTextAreaElement>('.cxa-draft')?.disabled).toBe(true)

    stream.push({
      subscription: {
        subscriptionId: 'subscription-one',
        binding: { bindingId: issuedBinding!.bindingId, ownerGeneration: issuedBinding!.ownerGeneration },
        generation: 'snapshot-1', afterSequence: 0, snapshotSequence: 0,
      },
      afterSequence: 1,
      phase: 'live',
      updates: [{ kind: 'disposed', sequence: 2, reason: 'owner-disposed' }],
      nextAfterSequence: 2,
      hasMore: false,
    })
    await settle()
    expect(dom.window.document.querySelector('[data-agent-conversation-runtime-state="unavailable"]')).not.toBeNull()
    expect(dom.window.document.querySelector('.cxa-composer')).toBeNull()

    if (typeof unmount === 'function') unmount()
    registration.dispose()
    expect(unsubscribed).toBe(1)
    expect(disposed).toBe(1)
    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })

  it('fails closed on cross-binding pages and disposes the source on unregistration', async () => {
    const dom = installDom()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const commands = new CommandRegistry()
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({ [CORDISX_PLUGIN_ID]: 'chatroom', [CORDISX_PLUGIN_GENERATION]: 'generation-1' })
    const stream = new PageStream()
    let disposed = false
    const registration = runtime.register(plugin, binding => ({
      snapshot: async () => noRoom(binding),
      subscribe: async afterSequence => {
        const subscription = {
          subscriptionId: 'subscription-one',
          binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
          generation: 'snapshot-1', afterSequence, snapshotSequence: afterSequence,
        }
        return { result: { type: 'subscribe', status: 'accepted', code: 'allowed', subscription }, handle: { subscription, pages: stream, unsubscribe: () => stream.close() } }
      },
      dispose: () => { disposed = true },
    }))
    registration.mount(mountContext(dom))
    await settle()
    stream.push({
      subscription: {
        subscriptionId: 'subscription-one',
        binding: { bindingId: 'cross-binding', ownerGeneration: 'g-cross' },
        generation: 'snapshot-1', afterSequence: 0, snapshotSequence: 0,
      },
      afterSequence: 0, phase: 'live', updates: [], nextAfterSequence: 0, hasMore: false,
    })
    await settle()
    expect(dom.window.document.querySelector('[data-agent-conversation-runtime-state="error"]')).not.toBeNull()
    expect(error).toHaveBeenCalledWith('[cordisx] Agent conversation source failed', expect.any(Error))
    registration.dispose()
    expect(disposed).toBe(true)
    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })

  it('rejects no-room snapshots without exactly one executable new-room action', async () => {
    const dom = installDom()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const commands = new CommandRegistry()
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({ [CORDISX_PLUGIN_ID]: 'chatroom', [CORDISX_PLUGIN_GENERATION]: 'generation-1' })
    const registration = runtime.register(plugin, binding => ({
      snapshot: async () => ({ ...noRoom(binding), headerActions: [] }),
      subscribe: async () => ({ result: { type: 'subscribe', status: 'unavailable', code: 'owner-unavailable' } }),
      dispose() {},
    }))
    registration.mount(mountContext(dom))
    await settle()
    expect(dom.window.document.querySelector('[data-agent-conversation-runtime-state="error"]')).not.toBeNull()
    expect(dom.window.document.querySelector('.cxa-composer')).toBeNull()
    registration.dispose()
    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })

  it('rejects premature live replay and non-monotonic update sequences', async () => {
    const dom = installDom()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const commands = new CommandRegistry()
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({ [CORDISX_PLUGIN_ID]: 'chatroom', [CORDISX_PLUGIN_GENERATION]: 'generation-1' })
    for (const candidate of ['premature-live', 'sequence-gap'] as const) {
      const stream = new PageStream()
      let binding: AgentConversationShellBinding | undefined
      const watermark = candidate === 'premature-live' ? 2 : 0
      const registration = runtime.register(plugin, currentBinding => {
        binding = currentBinding
        const subscription = {
          subscriptionId: `subscription-${candidate}`,
          binding: { bindingId: currentBinding.bindingId, ownerGeneration: currentBinding.ownerGeneration },
          generation: 'snapshot-1', afterSequence: 0, snapshotSequence: watermark,
        }
        return {
          snapshot: async () => noRoom(currentBinding),
          subscribe: async () => ({
            result: { type: 'subscribe' as const, status: 'accepted' as const, code: 'allowed' as const, subscription },
            handle: { subscription, pages: stream, unsubscribe: () => stream.close() },
          }),
          dispose() {},
        }
      })
      registration.mount(mountContext(dom))
      await settle()
      const subscription = {
        subscriptionId: `subscription-${candidate}`,
        binding: { bindingId: binding!.bindingId, ownerGeneration: binding!.ownerGeneration },
        generation: 'snapshot-1', afterSequence: 0, snapshotSequence: watermark,
      }
      stream.push(candidate === 'premature-live' ? {
        subscription, afterSequence: 0, phase: 'live', updates: [], nextAfterSequence: 0, hasMore: false,
      } : {
        subscription, afterSequence: 0, phase: 'live',
        updates: [{ kind: 'disposed', sequence: 2, reason: 'explicit' }],
        nextAfterSequence: 2, hasMore: false,
      })
      await settle()
      expect(dom.window.document.querySelector('[data-agent-conversation-runtime-state="error"]')).not.toBeNull()
      registration.dispose()
      await settle()
      dom.window.document.getElementById('page')!.replaceChildren()
    }
    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })
})
