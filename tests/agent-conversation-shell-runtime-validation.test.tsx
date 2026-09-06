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
  it('rejects Shell v3 message, reaction, and approval association drift plus terminal approval rewrites', async () => {
    const dom = installDom()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const commands = new CommandRegistry()
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'generation-v3-associations',
    })
    const participant = {
      participantId: 'agent-one',
      role: 'agent' as const,
      displayName: message('participant.agent-one', 'Agent One'),
      agentIdentity: { agentId: 'agent-one', revision: 'revision-one' },
    }
    for (
      const candidate of [
        'message-association',
        'reaction-identity',
        'reaction-disappears',
        'reaction-position',
        'reaction-duplicate-actor-value',
        'reaction-value-extra',
        'reaction-semantic-noncanonical',
        'reaction-emoji-noncanonical',
        'reaction-terminal-append',
        'approval-association',
        'approval-terminal',
      ] as const
    ) {
      const stream = new PageStream()
      let binding: AgentConversationShellBinding | undefined
      const initialMessage = {
        kind: 'message' as const,
        itemId: 'message-one',
        messageId: 'message-one',
        sequence: 1,
        source: 'agent-loop' as const,
        author: participant,
        semantic: {
          purpose: 'member-self-introduction' as const,
          causation: { operationId: 'intro:one' },
          participantId: 'agent-one',
          memberId: 'member-one',
          runId: 'run-one',
          binding: { bindingId: 'loop:binding:one', generation: 1 },
          turn: 'turn:intro',
        },
        body: [{ kind: 'text' as const, text: message('message.intro', 'I help review changes.') }],
        reactions: [
          {
            reactionId: 'reaction-one',
            actorParticipantId: 'agent-one',
            value: { kind: 'semantic' as const, token: 'acknowledged' },
            state: 'pending' as const,
          },
          {
            reactionId: 'reaction-two',
            actorParticipantId: 'agent-one',
            value: { kind: 'emoji' as const, emoji: '👍' },
            state: 'pending' as const,
          },
        ],
        timestamp: '2026-08-31T00:00:00.000Z',
        deliveryState: 'delivered' as const,
        runState: 'idle' as const,
        ariaLive: 'polite' as const,
        actions: [],
      }
      const initialApproval = {
        kind: 'approval' as const,
        itemId: 'approval-one',
        sequence: 2,
        participantId: 'agent-one',
        memberId: 'member-one',
        runId: 'run-one',
        binding: { bindingId: 'loop:binding:one', generation: 1 },
        turn: 'turn:approval',
        approvalId: 'approval:one',
        approvalKind: 'command' as const,
        rationale: message('approval.rationale', 'Run checks'),
        state: 'pending' as const,
        actions: [{ decision: 'approve' as const, command: { id: 'approve' } }],
      }
      const registration = runtime.register(plugin, current => {
        binding = current
        const subscription = {
          subscriptionId: `subscription-${candidate}`,
          binding: { bindingId: current.bindingId, ownerGeneration: current.ownerGeneration },
          generation: 'snapshot-v3',
          afterSequence: 2,
          snapshotSequence: 2,
        }
        return {
          snapshot: async () =>
            ({
              binding: { bindingId: current.bindingId, ownerGeneration: current.ownerGeneration },
              generation: 'snapshot-v3',
              snapshotSequence: 2,
              selection: {
                kind: 'room',
                roomId: 'room-one',
                title: message('room.title', 'Review'),
                multiParticipant: false,
                participantPresentation: 'none',
                participants: [participant],
                activeRuns: [{
                  participantId: 'agent-one',
                  memberId: 'member-one',
                  runId: 'run-one',
                  lifecycle: { phase: 'active' },
                  detailsUrl: { url: 'app://-/tasks/one', target: 'host' },
                }],
              },
              items: [initialMessage, initialApproval],
              composer: {
                availability: 'unavailable',
                placeholder: message('composer.placeholder', 'Message'),
                disabled: { value: true },
                submit: { id: 'send' },
              },
              headerActions: [],
            }) as never,
          subscribe: async () => ({
            result: { type: 'subscribe' as const, status: 'accepted' as const, code: 'allowed' as const, subscription },
            handle: { subscription, pages: stream, unsubscribe: () => stream.close() },
          }),
          dispose() {},
        }
      })
      registration.mount(mountContext(dom, { roomId: 'room-one' }))
      await vi.waitFor(
        () =>
          expect(dom.window.document.querySelector('[data-agent-conversation-renderer="production"]')).not.toBeNull(),
        { timeout: 1_000, interval: 10 },
      )
      const subscription = {
        subscriptionId: `subscription-${candidate}`,
        binding: { bindingId: binding!.bindingId, ownerGeneration: binding!.ownerGeneration },
        generation: 'snapshot-v3',
        afterSequence: 2,
        snapshotSequence: 2,
      }
      const page = (afterSequence: number, sequence: number, item: unknown) => ({
        subscription,
        afterSequence,
        phase: 'live' as const,
        updates: [{ kind: 'item-updated' as const, sequence, item }],
        nextAfterSequence: sequence,
        hasMore: false,
      })
      if (candidate === 'approval-terminal') {
        stream.push(page(2, 3, { ...initialApproval, state: 'approved', actions: [] }) as never)
        await settle()
        stream.push(page(3, 4, { ...initialApproval, state: 'denied', actions: [] }) as never)
      } else if (candidate === 'message-association') {
        stream.push(
          page(2, 3, { ...initialMessage, semantic: { ...initialMessage.semantic, turn: 'turn-forged' } }) as never,
        )
      } else if (candidate === 'reaction-identity') {
        stream.push(
          page(2, 3, {
            ...initialMessage,
            reactions: [{ ...initialMessage.reactions[0], actorParticipantId: 'forged-actor' }],
          }) as never,
        )
      } else if (candidate === 'reaction-disappears') {
        stream.push(page(2, 3, { ...initialMessage, reactions: [initialMessage.reactions[0]] }) as never)
      } else if (candidate === 'reaction-position') {
        stream.push(
          page(2, 3, {
            ...initialMessage,
            reactions: [initialMessage.reactions[1], initialMessage.reactions[0]],
          }) as never,
        )
      } else if (candidate === 'reaction-duplicate-actor-value') {
        stream.push(
          page(2, 3, {
            ...initialMessage,
            reactions: [...initialMessage.reactions, { ...initialMessage.reactions[0], reactionId: 'reaction-three' }],
          }) as never,
        )
      } else if (candidate === 'reaction-value-extra') {
        stream.push(
          page(2, 3, {
            ...initialMessage,
            reactions: [{
              ...initialMessage.reactions[0],
              value: { ...initialMessage.reactions[0].value, html: '<b>unsafe</b>' },
            }, initialMessage.reactions[1]],
          }) as never,
        )
      } else if (candidate === 'reaction-semantic-noncanonical') {
        stream.push(
          page(2, 3, {
            ...initialMessage,
            reactions: [initialMessage.reactions[0], {
              ...initialMessage.reactions[1],
              value: { kind: 'semantic', token: 'Acknowledged!' },
            }],
          }) as never,
        )
      } else if (candidate === 'reaction-emoji-noncanonical') {
        stream.push(
          page(2, 3, {
            ...initialMessage,
            reactions: [initialMessage.reactions[0], {
              ...initialMessage.reactions[1],
              value: { kind: 'emoji', emoji: 'not-an-emoji' },
            }],
          }) as never,
        )
      } else if (candidate === 'reaction-terminal-append') {
        stream.push(
          page(2, 3, {
            ...initialMessage,
            reactions: [...initialMessage.reactions, {
              reactionId: 'reaction-three',
              actorParticipantId: 'agent-one',
              value: { kind: 'semantic', token: 'done' },
              state: 'completed',
            }],
          }) as never,
        )
      } else {
        stream.push(
          page(2, 3, { ...initialApproval, approvalKind: 'file-change', state: 'approved', actions: [] }) as never,
        )
      }
      await waitForRuntimeState(dom, 'error')
      registration.dispose()
      await settle()
      dom.window.document.getElementById('page')!.replaceChildren()
    }
    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })

  it('rejects invalid initial Shell v3 author, self-introduction, approval identity, and action associations', async () => {
    const dom = installDom()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const commands = new CommandRegistry()
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const agentOne = {
      participantId: 'agent-one',
      role: 'agent' as const,
      displayName: message('agent.one', 'Agent One'),
      agentIdentity: { agentId: 'agent-one', revision: 'one' },
    }
    const agentTwo = {
      participantId: 'agent-two',
      role: 'agent' as const,
      displayName: message('agent.two', 'Agent Two'),
      agentIdentity: { agentId: 'agent-two', revision: 'one' },
    }
    const human = { participantId: 'human-one', role: 'human' as const, displayName: message('human.one', 'Human One') }
    const messageItem = {
      kind: 'message' as const,
      itemId: 'message-one',
      messageId: 'message-one',
      sequence: 1,
      source: 'agent-loop' as const,
      author: agentOne,
      semantic: {
        purpose: 'member-self-introduction' as const,
        causation: { operationId: 'intro-one' },
        participantId: 'agent-one',
        memberId: 'member-one',
        runId: 'run-one',
        binding: { bindingId: 'binding-one', generation: 1 },
        turn: 'turn-one',
      },
      body: [{ kind: 'text' as const, text: message('intro.one', 'I review changes.') }],
      reactions: [],
      timestamp: '2026-08-31T00:00:00.000Z',
      deliveryState: 'delivered' as const,
      runState: 'idle' as const,
      ariaLive: 'polite' as const,
      actions: [],
    }
    const approval = (
      itemId: string,
      participantId: string,
      memberId: string,
      runId: string,
      actions = [{ decision: 'approve' as const, command: { id: `approve-${itemId}` } }],
    ) => ({
      kind: 'approval' as const,
      itemId,
      sequence: itemId === 'approval-one' ? 1 : 2,
      participantId,
      memberId,
      runId,
      binding: { bindingId: 'binding-one', generation: 1 },
      turn: 'turn-approval',
      approvalId: 'approval-shared',
      approvalKind: 'command' as const,
      state: 'pending' as const,
      actions,
    })
    const candidates = [
      [{ ...messageItem, author: { ...agentOne, displayName: message('forged', 'Forged') } }],
      [{
        ...messageItem,
        author: human,
        semantic: { ...messageItem.semantic, participantId: 'human-one', memberId: 'human-member', runId: 'human-run' },
      }],
      [{
        ...messageItem,
        semantic: { ...messageItem.semantic, participantId: 'agent-two', memberId: 'member-two', runId: 'run-two' },
      }],
      [{ ...messageItem, itemId: 'message:one' }],
      [{ ...messageItem, semantic: { ...messageItem.semantic, causation: { operationId: '' } } }],
      [{ ...messageItem, semantic: { ...messageItem.semantic, causation: { operationId: 'x'.repeat(513) } } }],
      [
        approval('approval-one', 'agent-one', 'member-one', 'run-one'),
        approval('approval-two', 'agent-two', 'member-two', 'run-two'),
      ],
      [approval('approval-one', 'agent-one', 'member-one', 'run-one', [
        { decision: 'approve' as const, command: { id: 'approve-one' } },
        { decision: 'approve' as const, command: { id: 'approve-two' } },
      ])],
    ]
    for (const [index, items] of candidates.entries()) {
      const plugin = new Context().extend({
        [CORDISX_PLUGIN_ID]: `chatroom-${index}`,
        [CORDISX_PLUGIN_GENERATION]: `generation-invalid-${index}`,
      })
      const registration = runtime.register(plugin, binding => ({
        snapshot: async () =>
          ({
            binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
            generation: 'snapshot-invalid',
            snapshotSequence: 2,
            selection: {
              kind: 'room',
              roomId: 'room-one',
              title: message('room.one', 'Room'),
              multiParticipant: true,
              participantPresentation: 'compact',
              participants: [agentOne, agentTwo, human],
              activeRuns: [
                {
                  participantId: 'agent-one',
                  memberId: 'member-one',
                  runId: 'run-one',
                  lifecycle: { phase: 'active' },
                  detailsUrl: { url: 'app://-/tasks/one', target: 'host' },
                },
                {
                  participantId: 'agent-two',
                  memberId: 'member-two',
                  runId: 'run-two',
                  lifecycle: { phase: 'active' },
                  detailsUrl: { url: 'app://-/tasks/two', target: 'host' },
                },
                {
                  participantId: 'human-one',
                  memberId: 'human-member',
                  runId: 'human-run',
                  lifecycle: { phase: 'active' },
                  detailsUrl: { url: 'app://-/tasks/human', target: 'host' },
                },
              ],
            },
            items,
            composer: {
              availability: 'unavailable',
              placeholder: message('composer', 'Message'),
              disabled: { value: true },
              submit: { id: 'send' },
            },
            headerActions: [],
          }) as never,
        subscribe: async () =>
          ({ result: { type: 'subscribe', status: 'unavailable', code: 'owner-unavailable' } }) as never,
        dispose() {},
      }))
      registration.mount(mountContext(dom, { roomId: 'room-one' }))
      await waitForRuntimeState(dom, 'error')
      registration.dispose()
      dom.window.document.getElementById('page')!.replaceChildren()
    }
    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })

  it('strictly discriminates unavailable subscriptions and releases every non-accepted source', async () => {
    const dom = installDom()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const commands = new CommandRegistry()
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'generation-1',
    })

    let disposed = 0
    const unavailable = runtime.register(plugin, binding => ({
      snapshot: async () => noRoom(binding),
      subscribe: async () => ({ result: { type: 'subscribe', status: 'unavailable', code: 'owner-unavailable' } }),
      dispose: () => {
        disposed += 1
      },
    }))
    unavailable.mount(mountContext(dom))
    await waitForRuntimeState(dom, 'unavailable')
    expect(disposed).toBe(1)
    unavailable.dispose()
    expect(disposed).toBe(1)

    dom.window.document.getElementById('page')!.replaceChildren()
    let rejectedHandleUnsubscribed = 0
    const malformed = runtime.register(plugin, binding => ({
      snapshot: async () => noRoom(binding),
      subscribe: async () =>
        ({
          result: { type: 'subscribe', status: 'denied', code: 'policy-denied' },
          handle: {
            unsubscribe: () => {
              rejectedHandleUnsubscribed += 1
            },
          },
        }) as never,
      dispose: () => {
        disposed += 1
      },
    }))
    malformed.mount(mountContext(dom))
    await waitForRuntimeState(dom, 'error')
    expect(rejectedHandleUnsubscribed).toBe(1)
    expect(disposed).toBe(2)
    malformed.dispose()
    expect(disposed).toBe(2)

    for (const [index, status] of ['bogus', 42, undefined].entries()) {
      dom.window.document.getElementById('page')!.replaceChildren()
      const unknownStatus = runtime.register(plugin, binding => ({
        snapshot: async () => noRoom(binding),
        subscribe: async () =>
          ({
            result: {
              type: 'subscribe',
              ...(status === undefined ? {} : { status }),
              code: 'policy-denied',
            },
          }) as never,
        dispose: () => {
          disposed += 1
        },
      }))
      unknownStatus.mount(mountContext(dom))
      await waitForRuntimeState(dom, 'error')
      expect(disposed).toBe(3 + index)
      unknownStatus.dispose()
      expect(disposed).toBe(3 + index)
    }

    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })
})
