import type {
  AgentConversationShellBinding,
  AgentConversationShellPage,
  AgentConversationShellSnapshot,
  AgentConversationShellSource,
} from '@cordisx/protocol/agent-conversation-shell/v1'
import type {
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV4,
  AgentConversationShellSubscriptionClosed as AgentConversationShellSubscriptionClosedV4,
} from '@cordisx/protocol/agent-conversation-shell/v4'
import type {
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV5,
  AgentConversationShellSubscriptionClosed as AgentConversationShellSubscriptionClosedV5,
} from '@cordisx/protocol/agent-conversation-shell/v5'
import type {
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV6,
  AgentConversationShellSubscriptionClosed as AgentConversationShellSubscriptionClosedV6,
} from '@cordisx/protocol/agent-conversation-shell/v6'
import type {
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV7,
  AgentConversationShellSubscriptionClosed as AgentConversationShellSubscriptionClosedV7,
} from '@cordisx/protocol/agent-conversation-shell/v7'
import type { AgentCommandOrigin } from '@cordisx/protocol/agent-admission/v2'
import { Context } from '@deepseek-ai/cordis'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createGeneratedAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import { afterEach, describe, expect, it, vi } from 'vitest'

// See the renderer suite: this test installs JSDOM after module evaluation,
// while TDesign's textarea records useInsertionEffect at evaluation time.
vi.mock('tdesign-react', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('tdesign-react')
  const react = await import('react')
  return {
    ...actual,
    Button: (
      { children, disabled, onClick, loading: _loading, theme: _theme, variant: _variant, ...props }:
        & Record<string, unknown>
        & { readonly children?: unknown; readonly disabled?: boolean; readonly onClick?: () => void },
    ) =>
      react.createElement('button', {
        ...props,
        type: 'button',
        disabled,
        onClick,
      }, children),
    Input: ({ onChange, ...props }: Record<string, unknown> & { readonly onChange?: (value: string) => void }) =>
      react.createElement('input', {
        ...props,
        onChange: (event: { readonly currentTarget: { readonly value: string } }) =>
          onChange?.(event.currentTarget.value),
        onInput: (event: { readonly currentTarget: { readonly value: string } }) =>
          onChange?.(event.currentTarget.value),
      }),
    Textarea: (
      { onChange, autosize: _autosize, ...props }: Record<string, unknown> & {
        readonly onChange?: (value: string) => void
      },
    ) =>
      react.createElement('textarea', {
        ...props,
        onChange: (event: { readonly currentTarget: { readonly value: string } }) =>
          onChange?.(event.currentTarget.value),
        onInput: (event: { readonly currentTarget: { readonly value: string } }) =>
          onChange?.(event.currentTarget.value),
      }),
  }
})
import {
  CORDISX_PAGE_SCHEMA_V3,
  type CordisXCommandContext,
  type CordisXPageMountContext,
} from '../packages/cli/src/contracts.js'
import {
  AgentConversationShellRegistry,
  CordisXAgentConversationShellService,
  projectAgentConversationShellSnapshotV4,
} from '../packages/cli/src/renderer/agent-conversation-shell.js'
import {
  type PlaygroundScenarioConversationOrigin,
  type PlaygroundScenarioConversationSourceAuthority,
  PlaygroundScenarioSessionScopeAuthority,
} from '../packages/cli/src/renderer/playground-scenario-session-scope.js'
import { CommandRegistry, CordisXCommandService } from '../packages/cli/src/renderer/commands.js'
import { HostAgentTaskDetailsNavigator } from '../packages/cli/src/renderer/host-ui/AgentTaskDetailsNavigator.js'
import { CordisXI18nService } from '../packages/cli/src/renderer/i18n.js'
import { CordisXPageService } from '../packages/cli/src/renderer/navigation.js'
import type { AgentRuntimeRouteScope } from '../packages/cli/src/renderer/platform.js'
import { CORDISX_PLUGIN_GENERATION, CORDISX_PLUGIN_ID } from '../packages/cli/src/renderer/ownership.js'
import {
  CordisXAgentSessionRuntime,
  type CordisXPrivateAgentDriver,
} from '../packages/cli/src/renderer/agent-session-runtime.js'

class IdentitySessionDriver implements CordisXPrivateAgentDriver {
  private readonly replacements = new Set<() => void>()
  async create(input: { readonly sessionId: string }) {
    return {
      status: 'accepted' as const,
      detail: { kind: 'host' as const, ref: `deterministic-agent-session:${input.sessionId}` },
    }
  }
  async resume(input: { readonly sessionId: string }) {
    return {
      status: 'accepted' as const,
      detail: { kind: 'host' as const, ref: `deterministic-agent-session:${input.sessionId}` },
    }
  }
  async submit() {
    return 'accepted' as const
  }
  async discard() {
    return 'accepted' as const
  }
  async cancel() {
    return 'accepted' as const
  }
  onReplacement(listener: () => void): () => void {
    this.replacements.add(listener)
    return () => this.replacements.delete(listener)
  }
  replace(): void {
    for (const listener of this.replacements) listener()
  }
  dispose(): void {
    this.replacements.clear()
  }
}

class PageStream implements AsyncIterableIterator<AgentConversationShellPage> {
  private readonly pages: AgentConversationShellPage[] = []
  private readonly waiting: Array<(value: IteratorResult<AgentConversationShellPage>) => void> = []
  private closed = false;
  [Symbol.asyncIterator](): AsyncIterableIterator<AgentConversationShellPage> {
    return this
  }

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
      availability: 'available',
      placeholder: message('composer.placeholder', 'Write a message…'),
      disabled: { value: false },
      submit: { id: 'create-with-message' },
    },
    headerActions: [],
  }
}

function room(binding: AgentConversationShellBinding): AgentConversationShellSnapshot {
  const participant = {
    participantId: 'agent-one',
    role: 'agent' as const,
    displayName: message('participant.agent-one', 'Agent One'),
    avatar: createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'agent-one' }),
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
      source: 'chatroom-acknowledgement',
      semantic: { purpose: 'chatroom-acknowledgement' },
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
    executeConversationFor: (owner, reference, invocationKey, context) =>
      registry.execute(
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
  const dom = new JSDOM('<!doctype html><html><body><main id="page"></main></body></html>', {
    url: 'https://host.invalid/',
  })
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
    })
  ) {
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

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 10))
}

async function waitForRuntimeState(dom: JSDOM, state: 'loading' | 'unavailable' | 'error'): Promise<void> {
  await vi.waitFor(() => {
    expect(dom.window.document.querySelector(`[data-agent-conversation-runtime-state="${state}"]`)).not.toBeNull()
  }, { timeout: 1_000, interval: 10 })
}

afterEach(() => {
  for (const [key, value] of globals) Reflect.set(globalThis, key, value)
  globals.clear()
  vi.restoreAllMocks()
})

describe('Agent conversation shell public runtime', () => {
  it('accepts a Shell v4 message author whose exact participant fields use a different property order', () => {
    const displayName = message('participant.agent-one', 'Agent One')
    const avatar = createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'agent-one' })
    const agentIdentity = { agentId: 'agent-one', revision: 'revision-one' }
    const participant = { participantId: 'agent-one', role: 'agent' as const, displayName, avatar, agentIdentity }
    const author = { agentIdentity, avatar, displayName, role: 'agent' as const, participantId: 'agent-one' }
    const snapshot: AgentConversationShellSnapshotV4 = {
      binding: { bindingId: 'binding-v4', ownerGeneration: 'owner-v4' },
      generation: 'snapshot-v4',
      snapshotSequence: 1,
      selection: {
        kind: 'room',
        roomId: 'room-v4',
        title: message('room.v4', 'Room'),
        multiParticipant: false,
        participantPresentation: 'none',
        participants: [participant],
      },
      items: [{
        kind: 'message',
        itemId: 'item-v4',
        messageId: 'message-v4',
        sequence: 1,
        author,
        source: { kind: 'session-event', sessionId: 'session-v4', eventSeq: 1 },
        semantic: { purpose: 'conversation' },
        body: [{ kind: 'text', text: message('message.v4', 'Ready.') }],
        reactions: [],
        timestamp: '2026-09-03T00:00:00.000Z',
        deliveryState: 'delivered',
        runState: 'idle',
        ariaLive: 'off',
        actions: [],
      }],
      composer: {
        availability: 'unavailable',
        placeholder: message('composer.v4', 'Message'),
        disabled: { value: true },
        submit: { id: 'send' },
      },
      headerActions: [],
    }

    expect(
      projectAgentConversationShellSnapshotV4('chatroom', snapshot, {
        resolve: value => value.fallback,
      }).entries,
    ).toMatchObject([{ kind: 'message', authorId: 'agent-one' }])
  })

  it('captures the exact Shell v4 Room run while its composer command is accepted', async () => {
    const dom = installDom()
    const commands = new CommandRegistry()
    let observed: unknown
    let bindingId: string | undefined
    const fences: string[] = []
    const sourceAuthority = {
      execute: async <Value,>(origin: unknown, operation: () => Promise<Value>) => {
        observed = origin
        return await operation()
      },
      fenceBinding: (value: string) => {
        fences.push(value)
      },
      claimBootstrapRoute: () => {},
    }
    commands.register('chatroom', { id: 'send', title: { key: 'send', fallback: 'Send' } }, () => {
      expect((observed as { active(): boolean }).active()).toBe(true)
    })
    const runtime = new AgentConversationShellRegistry(
      commandService(commands),
      fakeI18n(),
      undefined,
      undefined,
      undefined,
      sourceAuthority,
      owner =>
        owner === 'chatroom'
          ? { pluginId: 'file:///plugins/chatroom.ts:chatroom', generation: 1 }
          : undefined,
    )
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'generation-v4-capture',
    })
    const participant = {
      participantId: 'participant-lead',
      role: 'agent' as const,
      displayName: message('participant.lead', 'Lead'),
      agentIdentity: { agentId: 'lead', revision: 'revision-one' },
    }
    const registration = runtime.register(
      plugin,
      binding => {
        bindingId = binding.bindingId
        const snapshot: AgentConversationShellSnapshotV4 = {
          binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
          generation: 'snapshot-v4-capture',
          snapshotSequence: 0,
          selection: {
            kind: 'room',
            roomId: 'room-one',
            title: message('room.one', 'Room One'),
            multiParticipant: false,
            participantPresentation: 'none',
            participants: [participant],
            activeRuns: [{
              participantId: participant.participantId,
              memberId: 'member-lead',
              runId: 'room-run-lead',
              sessionId: 'cx-session.lead',
              lifecycle: { phase: 'running' },
              details: { kind: 'host', ref: 'deterministic-agent-session:cx-session.lead' },
            }],
          },
          items: [],
          composer: {
            availability: 'available',
            placeholder: message('composer', 'Message'),
            disabled: { value: false },
            submit: { id: 'send' },
          },
          headerActions: [],
        }
        const subscription = {
          subscriptionId: 'subscription-v4-capture',
          binding: snapshot.binding,
          generation: snapshot.generation,
          afterSequence: 0,
          snapshotSequence: 0,
        }
        return {
          snapshot: async () => snapshot,
          subscribe: async () => ({
            result: { type: 'subscribe' as const, status: 'accepted' as const, code: 'allowed' as const, subscription },
            handle: {
              subscription,
              pages: {
                async *[Symbol.asyncIterator]() {
                  await new Promise<void>(() => {})
                },
              },
              closed: new Promise<never>(() => {}),
              unsubscribe: async () => ({
                $schema:
                  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-conversation-shell-subscription-close.v4.schema.json' as const,
                contract: 'cordisx.agent-conversation-shell-subscription-close/v4' as const,
                schemaVersion: 4 as const,
                subscriptionId: subscription.subscriptionId,
                binding: subscription.binding,
                generation: subscription.generation,
                status: 'closed' as const,
                code: 'unsubscribed' as const,
              }),
            },
          }),
          dispose() {},
        }
      },
      undefined,
      4,
    )
    const unmount = registration.mount(mountContext(dom, { roomId: 'room-one' }))
    await vi.waitFor(() => expect(dom.window.document.querySelector<HTMLTextAreaElement>('.cxa-draft')).not.toBeNull())
    const draft = dom.window.document.querySelector<HTMLTextAreaElement>('.cxa-draft')!
    const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set
    valueSetter?.call(draft, '3')
    draft.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await vi.waitFor(() =>
      expect(dom.window.document.querySelector<HTMLButtonElement>('.cxa-send')?.disabled).toBe(false)
    )
    dom.window.document.querySelector<HTMLButtonElement>('.cxa-send')!.click()
    await vi.waitFor(() =>
      expect(observed).toMatchObject({
        owner: { pluginId: 'file:///plugins/chatroom.ts:chatroom', generation: 1 },
        bindingId,
        snapshotGeneration: 'snapshot-v4-capture',
        roomId: 'room-one',
        routeId: 'chatroom:room',
        runs: [{ runId: 'room-run-lead', sessionId: 'cx-session.lead' }],
      })
    )
    if (typeof unmount === 'function') unmount()
    expect(fences).toEqual([bindingId])
    registration.dispose()
    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })

  it('settles a Shell v4 close once and releases its source with an idempotent async unsubscribe', async () => {
    const dom = installDom()
    const commands = new CommandRegistry()
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'generation-v4',
    })
    let resolveClosed: ((value: AgentConversationShellSubscriptionClosedV4) => void) | undefined
    const closed = new Promise<AgentConversationShellSubscriptionClosedV4>(resolve => {
      resolveClosed = resolve
    })
    let connectionClose: AgentConversationShellSubscriptionClosedV4 | undefined
    let subscribed = false
    let unsubscribed = 0
    let disposed = 0
    const registration = runtime.register(
      plugin,
      binding => {
        const snapshot: AgentConversationShellSnapshotV4 = {
          binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
          generation: 'session-generation-v4',
          snapshotSequence: 0,
          selection: { kind: 'no-room' },
          items: [],
          composer: {
            availability: 'available',
            placeholder: { key: 'composer', fallback: 'Message' },
            disabled: { value: false },
            submit: { id: 'send' },
          },
          headerActions: [],
        }
        const subscription = {
          subscriptionId: 'subscription-v4',
          binding: snapshot.binding,
          generation: snapshot.generation,
          afterSequence: 0,
          snapshotSequence: 0,
        }
        const close = (
          code: AgentConversationShellSubscriptionClosedV4['code'],
        ): AgentConversationShellSubscriptionClosedV4 => ({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-conversation-shell-subscription-close.v4.schema.json',
          contract: 'cordisx.agent-conversation-shell-subscription-close/v4',
          schemaVersion: 4,
          subscriptionId: subscription.subscriptionId,
          binding: subscription.binding,
          generation: subscription.generation,
          status: 'closed',
          code,
        })
        connectionClose = close('connection-replaced')
        return {
          snapshot: async () => snapshot,
          subscribe: async () => {
            subscribed = true
            return {
              result: { type: 'subscribe', status: 'accepted', code: 'allowed', subscription },
              handle: {
                subscription,
                pages: {
                  async *[Symbol.asyncIterator]() {
                    await new Promise<void>(() => {})
                  },
                },
                closed,
                unsubscribe: async () => {
                  unsubscribed += 1
                  return close('unsubscribed')
                },
              },
            }
          },
          updateRoomSettings: async request => ({
            type: 'update-room-settings',
            requestId: request.requestId,
            binding: request.binding,
            generation: request.generation,
            roomId: request.roomId,
            expectedSnapshotSequence: request.expectedSnapshotSequence,
            status: 'unavailable',
            code: 'settings-unavailable',
          }),
          dispose: () => {
            disposed += 1
          },
        }
      },
      undefined,
      4,
    )
    registration.mount(mountContext(dom))
    await vi.waitFor(() => expect(subscribed).toBe(true))
    resolveClosed!(connectionClose!)
    await waitForRuntimeState(dom, 'unavailable')
    expect(unsubscribed).toBe(1)
    expect(disposed).toBe(1)
    registration.dispose()
    runtime.dispose()
    expect(unsubscribed).toBe(1)
    expect(disposed).toBe(1)
    commands.dispose()
    await settle()
    dom.window.close()
  })

  it('accepts Shell v5 and fails closed when its terminal schema identity is not exactly v5', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const dom = installDom()
    const commands = new CommandRegistry()
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'generation-v5',
    })
    let resolveClosed: ((value: AgentConversationShellSubscriptionClosedV5) => void) | undefined
    const closed = new Promise<AgentConversationShellSubscriptionClosedV5>(resolve => {
      resolveClosed = resolve
    })
    let connectionClose: AgentConversationShellSubscriptionClosedV5 | undefined
    let unsubscribed = 0
    const registration = runtime.register(
      plugin,
      binding => {
        const snapshot: AgentConversationShellSnapshotV5 = {
          binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
          generation: 'session-generation-v5',
          snapshotSequence: 0,
          selection: { kind: 'no-room' },
          items: [],
          composer: {
            availability: 'available',
            placeholder: message('composer.v5', 'Message'),
            disabled: { value: false },
            shortcutPolicy: 'mod-enter',
            submit: { id: 'send' },
          },
          headerActions: [],
        }
        const subscription = {
          subscriptionId: 'subscription-v5',
          binding: snapshot.binding,
          generation: snapshot.generation,
          afterSequence: 0,
          snapshotSequence: 0,
        }
        const close = (
          code: AgentConversationShellSubscriptionClosedV5['code'],
        ): AgentConversationShellSubscriptionClosedV5 => ({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-conversation-shell-subscription-close.v5.schema.json',
          contract: 'cordisx.agent-conversation-shell-subscription-close/v5',
          schemaVersion: 5,
          subscriptionId: subscription.subscriptionId,
          binding: subscription.binding,
          generation: subscription.generation,
          status: 'closed',
          code,
        })
        connectionClose = close('connection-replaced')
        return {
          snapshot: async () => snapshot,
          subscribe: async () => ({
            result: { type: 'subscribe', status: 'accepted', code: 'allowed', subscription },
            handle: {
              subscription,
              pages: {
                async *[Symbol.asyncIterator]() {
                  await new Promise<void>(() => {})
                },
              },
              closed,
              unsubscribe: async () => {
                unsubscribed += 1
                return close('unsubscribed')
              },
            },
          }),
          updateRoomSettings: async request => ({
            type: 'update-room-settings',
            requestId: request.requestId,
            binding: request.binding,
            generation: request.generation,
            roomId: request.roomId,
            expectedSnapshotSequence: request.expectedSnapshotSequence,
            status: 'unavailable',
            code: 'settings-unavailable',
          }),
          dispose() {},
        }
      },
      undefined,
      5,
    )
    registration.mount(mountContext(dom))
    await vi.waitFor(() =>
      expect(dom.window.document.querySelector('[data-agent-conversation-renderer="production"]')).not.toBeNull()
    )
    resolveClosed!({
      ...connectionClose!,
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-conversation-shell-subscription-close.v4.schema.json',
      contract: 'cordisx.agent-conversation-shell-subscription-close/v4',
      schemaVersion: 4,
    } as unknown as AgentConversationShellSubscriptionClosedV5)
    await waitForRuntimeState(dom, 'error')
    expect(unsubscribed).toBe(1)
    registration.dispose()
    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })

  it('accepts a v6 pending-to-actionless-terminal page and rejects a later terminal rewrite', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const dom = installDom()
    const commands = new CommandRegistry()
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'generation-v6',
    })
    const stream = new PageStream()
    let unsubscribed = 0
    let binding: AgentConversationShellBinding | undefined
    const registration = runtime.register(
      plugin,
      currentBinding => {
        binding = currentBinding
        const participant = {
          participantId: 'agent-reviewer',
          role: 'agent' as const,
          displayName: message('reviewer', 'Reviewer'),
        }
        const pending = {
          kind: 'approval' as const,
          itemId: 'approval-v6',
          sequence: 1,
          participantId: participant.participantId,
          memberId: 'member-reviewer',
          runId: 'run-reviewer',
          sessionId: 'cx-session.v6-reviewer',
          agentGeneration: 9,
          approvalId: 'cx-approval.v6-review',
          approvalKind: 'command' as const,
          state: 'pending' as const,
          actions: [{ decision: 'approve' as const, command: { id: 'approval.answer' } }] as const,
        }
        const snapshot: AgentConversationShellSnapshotV6 = {
          binding: { bindingId: currentBinding.bindingId, ownerGeneration: currentBinding.ownerGeneration },
          generation: 'snapshot-v6',
          snapshotSequence: 1,
          selection: {
            kind: 'room',
            roomId: 'room-v6',
            title: message('room.v6', 'V6 room'),
            multiParticipant: false,
            participantPresentation: 'none',
            participants: [participant],
            activeRuns: [{
              participantId: participant.participantId,
              memberId: pending.memberId,
              runId: pending.runId,
              sessionId: pending.sessionId,
              lifecycle: { phase: 'attention' },
            }],
          },
          items: [pending],
          composer: {
            availability: 'unavailable',
            placeholder: message('composer.v6', 'Message'),
            disabled: { value: true },
            shortcutPolicy: 'enter',
            submit: { id: 'send' },
          },
          headerActions: [],
        }
        const subscription = {
          subscriptionId: 'subscription-v6',
          binding: snapshot.binding,
          generation: snapshot.generation,
          afterSequence: 1,
          snapshotSequence: 1,
        }
        const close = (
          code: AgentConversationShellSubscriptionClosedV6['code'],
        ): AgentConversationShellSubscriptionClosedV6 => ({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-conversation-shell-subscription-close.v6.schema.json',
          contract: 'cordisx.agent-conversation-shell-subscription-close/v6',
          schemaVersion: 6,
          subscriptionId: subscription.subscriptionId,
          binding: subscription.binding,
          generation: subscription.generation,
          status: 'closed',
          code,
        })
        return {
          snapshot: async () => snapshot,
          subscribe: async () => ({
            result: { type: 'subscribe' as const, status: 'accepted' as const, code: 'allowed' as const, subscription },
            handle: {
              subscription,
              pages: stream,
              closed: new Promise<never>(() => {}),
              unsubscribe: async () => {
                unsubscribed += 1
                stream.close()
                return close('unsubscribed')
              },
            },
          }),
          updateRoomSettings: async request => ({
            type: 'update-room-settings' as const,
            requestId: request.requestId,
            binding: request.binding,
            generation: request.generation,
            roomId: request.roomId,
            expectedSnapshotSequence: request.expectedSnapshotSequence,
            status: 'unavailable' as const,
            code: 'settings-unavailable' as const,
          }),
          dispose() {},
        }
      },
      undefined,
      6,
    )
    registration.mount(mountContext(dom))
    await vi.waitFor(() => expect(dom.window.document.querySelectorAll('.cxa-approval-actions button')).toHaveLength(1))
    const subscription = {
      subscriptionId: 'subscription-v6',
      binding: { bindingId: binding!.bindingId, ownerGeneration: binding!.ownerGeneration },
      generation: 'snapshot-v6',
      afterSequence: 1,
      snapshotSequence: 1,
    }
    const terminal = {
      kind: 'approval' as const,
      itemId: 'approval-v6',
      sequence: 1,
      participantId: 'agent-reviewer',
      memberId: 'member-reviewer',
      runId: 'run-reviewer',
      sessionId: 'cx-session.v6-reviewer',
      approvalId: 'cx-approval.v6-review',
      approvalKind: 'command' as const,
      state: 'approved' as const,
      actions: [] as const,
    }
    stream.push({
      subscription,
      afterSequence: 1,
      phase: 'live',
      updates: [{ kind: 'item-updated', sequence: 2, item: terminal }],
      nextAfterSequence: 2,
      hasMore: false,
    } as never)
    await vi.waitFor(() =>
      expect(dom.window.document.querySelector('.cxa-approval')?.getAttribute('data-state')).toBe('approved')
    )
    expect(dom.window.document.querySelector('.cxa-approval-actions')).toBeNull()
    stream.push({
      subscription,
      afterSequence: 2,
      phase: 'live',
      updates: [{ kind: 'item-updated', sequence: 3, item: { ...terminal, state: 'denied' } }],
      nextAfterSequence: 3,
      hasMore: false,
    } as never)
    await waitForRuntimeState(dom, 'error')
    expect(unsubscribed).toBe(1)
    registration.dispose()
    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })
})
