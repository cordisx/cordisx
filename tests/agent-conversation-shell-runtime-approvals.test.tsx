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
  it('keeps every other v7 timeline item when a pending approval is rejected', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const dom = installDom()
    const commands = new CommandRegistry()
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'generation-v7',
    })
    const stream = new PageStream()
    let unsubscribed = 0
    let binding: AgentConversationShellBinding | undefined
    let initialSnapshot: AgentConversationShellSnapshotV7 | undefined
    const reviewer = { agentId: 'reviewer', revision: 'reviewer-v7' }
    const lead = { agentId: 'lead', revision: 'lead-v7' }
    const pending = (itemId: string, approvalId: string, sequence: number) => ({
      kind: 'approval' as const,
      itemId,
      sequence,
      participantId: 'agent-reviewer',
      memberId: 'member-reviewer',
      runId: 'run-reviewer',
      sessionId: 'cx-session.reviewer-v7',
      agentGeneration: 7,
      approvalId,
      approvalKind: 'external-action' as const,
      requester: reviewer,
      authority: { participantId: 'agent-lead', memberId: 'member-lead', identity: lead },
      reason: { kind: 'plain-text' as const, text: `Reason for ${approvalId}` },
      authorityBinding: {
        agentId: 'cx-session.lead-v7',
        sessionId: 'cx-session.lead-v7',
        agentGeneration: 9,
        definition: lead,
      },
      state: 'pending' as const,
      actions: [
        { decision: 'approve' as const, command: { id: 'approval.answer' } },
        { decision: 'reject' as const, command: { id: 'approval.answer' } },
      ] as const,
    })
    const registration = runtime.register(
      plugin,
      currentBinding => {
        binding = currentBinding
        const participants = [
          {
            participantId: 'agent-reviewer',
            role: 'agent' as const,
            displayName: message('reviewer', 'Reviewer'),
            agentIdentity: reviewer,
          },
          {
            participantId: 'agent-lead',
            role: 'agent' as const,
            displayName: message('lead', 'Lead'),
            agentIdentity: lead,
          },
        ]
        const text = {
          kind: 'message' as const,
          itemId: 'message-before-approval',
          messageId: 'message-v7',
          sequence: 1,
          source: { kind: 'session-event' as const, sessionId: 'cx-session.reviewer-v7', eventSeq: 1 },
          author: participants[0]!,
          semantic: { purpose: 'conversation' as const },
          body: [{ kind: 'text' as const, text: message('message', 'Keep this message') }],
          reactions: [],
          timestamp: '2026-09-04T04:00:00.000Z',
          deliveryState: 'delivered' as const,
          runState: 'idle' as const,
          ariaLive: 'off' as const,
          actions: [],
        }
        const snapshot: AgentConversationShellSnapshotV7 = {
          binding: { bindingId: currentBinding.bindingId, ownerGeneration: currentBinding.ownerGeneration },
          generation: 'snapshot-v7',
          snapshotSequence: 3,
          selection: {
            kind: 'room',
            roomId: 'room-v7',
            title: message('room.v7', 'V7 room'),
            multiParticipant: true,
            participantPresentation: 'host-initials',
            participants,
            activeRuns: [
              {
                participantId: 'agent-reviewer',
                memberId: 'member-reviewer',
                runId: 'run-reviewer',
                sessionId: 'cx-session.reviewer-v7',
                lifecycle: { phase: 'attention' },
              },
              {
                participantId: 'agent-lead',
                memberId: 'member-lead',
                runId: 'run-lead',
                sessionId: 'cx-session.lead-v7',
                lifecycle: { phase: 'active' },
              },
            ],
          },
          items: [
            text,
            pending('approval-v7-a', 'cx-approval.v7-a', 2),
            pending('approval-v7-b', 'cx-approval.v7-b', 3),
          ],
          composer: {
            availability: 'available',
            placeholder: message('composer', 'Message'),
            disabled: { value: false },
            shortcutPolicy: 'enter',
            submit: { id: 'send' },
          },
          headerActions: [],
        }
        initialSnapshot = snapshot
        const subscription = {
          subscriptionId: 'subscription-v7',
          binding: snapshot.binding,
          generation: snapshot.generation,
          afterSequence: 3,
          snapshotSequence: 3,
        }
        const close = (
          code: AgentConversationShellSubscriptionClosedV7['code'],
        ): AgentConversationShellSubscriptionClosedV7 => ({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-conversation-shell-subscription-close.v7.schema.json',
          contract: 'cordisx.agent-conversation-shell-subscription-close/v7',
          schemaVersion: 7,
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
      7,
    )
    registration.mount(mountContext(dom))
    await vi.waitFor(() => expect(dom.window.document.querySelectorAll('[data-entry-id]')).toHaveLength(3))
    const subscription = {
      subscriptionId: 'subscription-v7',
      binding: { bindingId: binding!.bindingId, ownerGeneration: binding!.ownerGeneration },
      generation: 'snapshot-v7',
      afterSequence: 3,
      snapshotSequence: 3,
    }
    const pendingA = pending('approval-v7-a', 'cx-approval.v7-a', 2)
    const rejectedControl = dom.window.document.querySelector<HTMLButtonElement>(
      '[data-entry-id="approval-v7-a"] [data-decision="reject"]',
    )
    rejectedControl?.focus()
    expect(dom.window.document.activeElement).toBe(rejectedControl)
    const { authorityBinding: _authorityBindingA, agentGeneration: _agentGenerationA, ...durableA } = pendingA
    const terminalA = { ...durableA, state: 'denied' as const, actions: [] as const }
    const terminalReplacement: AgentConversationShellSnapshotV7 = {
      ...initialSnapshot!,
      snapshotSequence: 4,
      items: [initialSnapshot!.items[0]!, terminalA, initialSnapshot!.items[2]!],
    }
    stream.push(
      {
        subscription,
        afterSequence: 3,
        phase: 'live',
        updates: [{ kind: 'snapshot-replaced', sequence: 4, snapshot: terminalReplacement }],
        nextAfterSequence: 4,
        hasMore: false,
      } as never,
    )
    await vi.waitFor(() =>
      expect(dom.window.document.querySelector('[data-entry-id="approval-v7-a"]')?.getAttribute('data-state')).toBe(
        'denied',
      )
    )
    expect(dom.window.document.querySelector('[data-entry-id="approval-v7-a"] .cxa-approval-action')).toBeNull()
    expect(dom.window.document.querySelector('[data-entry-id="message-before-approval"]')?.textContent).toContain(
      'Keep this message',
    )
    expect(dom.window.document.querySelector('[data-entry-id="approval-v7-b"]')).not.toBeNull()

    const pendingB = pending('approval-v7-b', 'cx-approval.v7-b', 3)
    const { authorityBinding: _authorityBindingB, agentGeneration: _agentGenerationB, ...durableB } = pendingB
    const terminalB = { ...durableB, state: 'approved' as const, actions: [] as const }
    const incomplete: AgentConversationShellSnapshotV7 = {
      ...terminalReplacement,
      snapshotSequence: 5,
      // B transitions on its exact id, but the replacement drops the older
      // Room message. A terminal transition must retain every old timeline id.
      items: [terminalA, terminalB],
    }
    stream.push(
      {
        subscription,
        afterSequence: 4,
        phase: 'live',
        updates: [{ kind: 'snapshot-replaced', sequence: 5, snapshot: incomplete }],
        nextAfterSequence: 5,
        hasMore: false,
      } as never,
    )
    await waitForRuntimeState(dom, 'error')
    expect(unsubscribed).toBe(1)
    registration.dispose()
    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })

  it('fails closed when a v7 replacement drops the established timeline after terminal approval', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const dom = installDom()
    const commands = new CommandRegistry()
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'generation-v7-missing-pending',
    })
    const stream = new PageStream()
    let binding: AgentConversationShellBinding | undefined
    let unsubscribed = 0
    let initialSnapshot: AgentConversationShellSnapshotV7 | undefined
    const reviewer = { agentId: 'reviewer', revision: 'reviewer-v7-missing-pending' }
    const lead = { agentId: 'lead', revision: 'lead-v7-missing-pending' }
    const registration = runtime.register(
      plugin,
      currentBinding => {
        binding = currentBinding
        const participants = [
          {
            participantId: 'agent-reviewer',
            role: 'agent' as const,
            displayName: message('reviewer', 'Reviewer'),
            agentIdentity: reviewer,
          },
          {
            participantId: 'agent-lead',
            role: 'agent' as const,
            displayName: message('lead', 'Lead'),
            agentIdentity: lead,
          },
        ]
        const oldDelegation = {
          kind: 'message' as const,
          itemId: 'old-delegation',
          messageId: 'old-delegation',
          sequence: 1,
          source: { kind: 'chatroom-acknowledgement' as const },
          author: participants[0]!,
          semantic: { purpose: 'chatroom-acknowledgement' as const },
          body: [{ kind: 'text' as const, text: message('old-delegation', 'Old delegation') }],
          reactions: [],
          timestamp: '2026-09-05T00:00:00.000Z',
          deliveryState: 'delivered' as const,
          runState: 'idle' as const,
          ariaLive: 'off' as const,
          actions: [],
        }
        const pending = {
          kind: 'approval' as const,
          itemId: 'pending-approval',
          sequence: 2,
          participantId: 'agent-reviewer',
          memberId: 'member-reviewer',
          runId: 'run-reviewer',
          sessionId: 'cx-session.reviewer-v7-missing-pending',
          agentGeneration: 7,
          approvalId: 'cx-approval.v7-missing-pending',
          approvalKind: 'external-action' as const,
          requester: reviewer,
          authority: { participantId: 'agent-lead', memberId: 'member-lead', identity: lead },
          reason: { kind: 'plain-text' as const, text: 'Pending approval must not disappear.' },
          authorityBinding: {
            agentId: 'cx-session.lead-v7-missing-pending',
            sessionId: 'cx-session.lead-v7-missing-pending',
            agentGeneration: 9,
            definition: lead,
          },
          state: 'pending' as const,
          actions: [
            { decision: 'approve' as const, command: { id: 'approval.answer' } },
            { decision: 'reject' as const, command: { id: 'approval.answer' } },
          ] as const,
        }
        const appendedB = {
          kind: 'message' as const,
          itemId: 'appended-b',
          messageId: 'appended-b',
          sequence: 3,
          source: { kind: 'chatroom-acknowledgement' as const },
          author: participants[0]!,
          semantic: { purpose: 'chatroom-acknowledgement' as const },
          body: [{ kind: 'text' as const, text: message('appended-b', 'B must remain visible') }],
          reactions: [],
          timestamp: '2026-09-05T00:00:01.000Z',
          deliveryState: 'delivered' as const,
          runState: 'idle' as const,
          ariaLive: 'off' as const,
          actions: [],
        }
        const snapshot: AgentConversationShellSnapshotV7 = {
          binding: { bindingId: currentBinding.bindingId, ownerGeneration: currentBinding.ownerGeneration },
          generation: 'snapshot-v7-missing-pending',
          snapshotSequence: 3,
          selection: {
            kind: 'room',
            roomId: 'room-v7-missing-pending',
            title: message('room.v7', 'V7 room'),
            multiParticipant: true,
            participantPresentation: 'host-initials',
            participants,
            activeRuns: [
              {
                participantId: 'agent-reviewer',
                memberId: 'member-reviewer',
                runId: 'run-reviewer',
                sessionId: pending.sessionId,
                lifecycle: { phase: 'attention' },
              },
              {
                participantId: 'agent-lead',
                memberId: 'member-lead',
                runId: 'run-lead',
                sessionId: 'cx-session.lead-v7-missing-pending',
                lifecycle: { phase: 'active' },
              },
            ],
          },
          items: [oldDelegation, pending, appendedB],
          composer: {
            availability: 'available',
            placeholder: message('composer', 'Message'),
            disabled: { value: false },
            shortcutPolicy: 'enter',
            submit: { id: 'send' },
          },
          headerActions: [],
        }
        initialSnapshot = snapshot
        const subscription = {
          subscriptionId: 'subscription-v7-missing-pending',
          binding: snapshot.binding,
          generation: snapshot.generation,
          afterSequence: 3,
          snapshotSequence: 3,
        }
        const close = (
          code: AgentConversationShellSubscriptionClosedV7['code'],
        ): AgentConversationShellSubscriptionClosedV7 => ({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-conversation-shell-subscription-close.v7.schema.json',
          contract: 'cordisx.agent-conversation-shell-subscription-close/v7',
          schemaVersion: 7,
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
      7,
    )
    registration.mount(mountContext(dom))
    await vi.waitFor(() => expect(dom.window.document.querySelectorAll('[data-entry-id]')).toHaveLength(3))
    const subscription = {
      subscriptionId: 'subscription-v7-missing-pending',
      binding: { bindingId: binding!.bindingId, ownerGeneration: binding!.ownerGeneration },
      generation: 'snapshot-v7-missing-pending',
      afterSequence: 3,
      snapshotSequence: 3,
    }
    const pending = initialSnapshot!.items.find(item => item.itemId === 'pending-approval')!
    if (pending.kind !== 'approval') throw new Error('pending approval fixture is invalid')
    const { authorityBinding: _authorityBinding, agentGeneration: _agentGeneration, ...terminalBase } = pending
    const terminal = { ...terminalBase, state: 'denied' as const, actions: [] as const }
    const terminalReplacement: AgentConversationShellSnapshotV7 = {
      ...initialSnapshot!,
      snapshotSequence: 4,
      items: [initialSnapshot!.items[0]!, terminal, initialSnapshot!.items[2]!],
    }
    stream.push(
      {
        subscription,
        afterSequence: 3,
        phase: 'live',
        updates: [{ kind: 'snapshot-replaced', sequence: 4, snapshot: terminalReplacement }],
        nextAfterSequence: 4,
        hasMore: false,
      } as never,
    )
    await vi.waitFor(() =>
      expect(dom.window.document.querySelector('[data-entry-id="pending-approval"]')?.getAttribute('data-state')).toBe(
        'denied',
      )
    )
    expect(dom.window.document.querySelector('[data-entry-id="pending-approval"] .cxa-approval-action')).toBeNull()
    const rejectionReply = {
      ...initialSnapshot!.items[2]!,
      kind: 'message' as const,
      itemId: 'rejection-reply',
      messageId: 'rejection-reply',
      sequence: 4,
      source: { kind: 'session-event' as const, sessionId: pending.sessionId, eventSeq: 32 },
      semantic: { purpose: 'conversation' as const },
      body: [{ kind: 'text' as const, text: message('rejection-reply', 'Lead rejected the request.') }],
      timestamp: '2026-09-05T00:00:02.000Z',
    }
    const fullTerminalTimeline: AgentConversationShellSnapshotV7 = {
      ...terminalReplacement,
      snapshotSequence: 5,
      items: [...terminalReplacement.items, rejectionReply],
    }
    stream.push(
      {
        subscription,
        afterSequence: 4,
        phase: 'live',
        updates: [{ kind: 'snapshot-replaced', sequence: 5, snapshot: fullTerminalTimeline }],
        nextAfterSequence: 5,
        hasMore: false,
      } as never,
    )
    await vi.waitFor(() => expect(dom.window.document.querySelectorAll('[data-entry-id]')).toHaveLength(4))
    const collapsed: AgentConversationShellSnapshotV7 = {
      ...fullTerminalTimeline,
      snapshotSequence: 6,
      // Reproduces C694's 553-to-554 post-terminal collapse: only an old
      // delegation remains after the terminal fact and its rejection reply.
      items: [fullTerminalTimeline.items[0]!],
    }
    stream.push(
      {
        subscription,
        afterSequence: 5,
        phase: 'live',
        updates: [{ kind: 'snapshot-replaced', sequence: 6, snapshot: collapsed }],
        nextAfterSequence: 6,
        hasMore: false,
      } as never,
    )
    await waitForRuntimeState(dom, 'error')
    expect(unsubscribed).toBe(1)
    registration.dispose()
    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })

  it.each([1, 2, 3])('issues one immutable Shell v8 command origin for N=%i exact Room deliveries', async count => {
    const dom = installDom()
    const commands = new CommandRegistry()
    let commandContext: CordisXCommandContext | undefined
    commands.register('chatroom', { id: 'send-v8', title: { key: 'send-v8', fallback: 'Send' } }, context => {
      commandContext = context
    })
    const runtime = new AgentConversationShellRegistry(commandService(commands), fakeI18n())
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'generation-v8',
    })
    const stream = new PageStream()
    let binding: AgentConversationShellBinding | undefined
    const registration = runtime.register(
      plugin,
      currentBinding => {
        binding = currentBinding
        const snapshot: AgentConversationShellSnapshotV7 = {
          binding: { bindingId: currentBinding.bindingId, ownerGeneration: currentBinding.ownerGeneration },
          generation: 'snapshot-v8',
          snapshotSequence: 0,
          selection: {
            kind: 'room',
            roomId: 'room-v8',
            title: message('room.v8', 'V8 room'),
            multiParticipant: false,
            participantPresentation: 'none',
            participants: Array.from(
              { length: count },
              (_, index) => ({
                participantId: ['lead', 'reviewer', 'integrator'][index]!,
                role: 'agent' as const,
                displayName: message(`participant-${index}`, `Participant ${index + 1}`),
              }),
            ),
            activeRuns: Array.from({ length: count }, (_, index) => ({
              participantId: ['lead', 'reviewer', 'integrator'][index]!,
              memberId: `member-${index + 1}`,
              runId: `run-${index + 1}`,
              sessionId: `cx-session.${index + 1}`,
              lifecycle: { phase: 'active' as const },
            })),
          },
          items: [],
          composer: {
            availability: 'available',
            placeholder: message('composer', 'Message'),
            disabled: { value: false },
            shortcutPolicy: 'enter',
            submit: { id: 'send-v8' },
          },
          headerActions: [],
        }
        const subscription = {
          subscriptionId: 'subscription-v8',
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
              pages: stream,
              closed: new Promise<never>(() => {}),
              unsubscribe: async () => {
                stream.close()
              },
            },
          }),
          dispose() {},
        }
      },
      undefined,
      8,
    )
    registration.mount(mountContext(dom, { roomId: 'room-v8' }))
    await vi.waitFor(() => expect(dom.window.document.querySelector<HTMLTextAreaElement>('.cxa-draft')).not.toBeNull())
    const draft = dom.window.document.querySelector<HTMLTextAreaElement>('.cxa-draft')!
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(draft, 'single-target reservation')
    draft.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    const send = dom.window.document.querySelector<HTMLButtonElement>('.cxa-send')!
    await vi.waitFor(() => expect(send.disabled).toBe(false))
    send.click()
    await vi.waitFor(() =>
      expect(commandContext?.hostContext).toMatchObject({
        scope: 'composer-submit',
        origin: {
          binding: { bindingId: binding!.bindingId, ownerGeneration: binding!.ownerGeneration },
          generation: binding!.ownerGeneration,
          commandId: 'send-v8',
          room: { roomId: 'room-v8', participantId: 'lead', memberId: 'member-1', runId: 'run-1' },
        },
      })
    )
    const origin = (commandContext?.hostContext as { readonly origin?: object }).origin
    expect(Object.isFrozen(origin)).toBe(true)
    expect(Object.isFrozen((origin as { readonly binding: object }).binding)).toBe(true)
    registration.dispose()
    runtime.dispose()
    commands.dispose()
    await settle()
    dom.window.close()
  })
})
