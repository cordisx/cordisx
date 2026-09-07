import type { NativeSessionRecoveryStore } from '../packages/cli/src/renderer/native-agent-session-recovery.js'
import * as agentTools from '../packages/cli/src/renderer/plugin-agent-tools.js'
import type { AgentToolSetup } from '../packages/cli/src/plugin-agent-tool-contracts.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSetup } from '@cordisx/protocol/agents/v1'
import { CordisXAgentSessionRuntime } from '../packages/cli/src/renderer/agent-session-runtime.js'
import type { UserMessage } from '@cordisx/protocol/sessions/v1'
import {
  CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PIN,
  CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PINS,
  CodexDesktopAgentSessionTransport,
} from '../packages/cli/src/renderer/codex-desktop-agent-session-transport.js'

class TestWindow extends EventTarget {
  readonly location = { href: 'app://-/index.html' }
  message(data: unknown): Event {
    const event = new Event('message', { cancelable: true }) as Event & { data: unknown; source: unknown }
    Object.defineProperties(event, {
      data: { value: data },
      source: { value: this },
    })
    this.dispatchEvent(event)
    return event
  }
}

const nativeOwner = { pluginId: 'context-test', generation: 1 }
const emptyRecovery = (): NativeSessionRecoveryStore => ({
  saveBinding: async () => {},
  resolveBinding: async () => undefined,
})

const originals = new Map<string, PropertyDescriptor | undefined>()
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

const user = (id: string, value: string): UserMessage => ({
  id,
  role: 'user',
  content: [{ type: 'text', text: value }],
  source: { kind: 'user' },
})
const settle = async (): Promise<void> => {
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
  await Promise.resolve()
}

describe('Codex Desktop Agent/Session transport', () => {
  it('uses the existing bridge for commands, notifications, approvals, queueing, and first-terminal delivery', async () => {
    const view = new TestWindow()
    const sent: Record<string, unknown>[] = []
    let turnStarts = 0
    const bridge = {
      getSentryInitOptions: async () => ({ ...CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PIN }),
      sendMessageFromView: async (value: unknown) => {
        const envelope = structuredClone(value) as Record<string, unknown>
        sent.push(envelope)
        if (envelope.type !== 'mcp-request') return
        const request = envelope.request as Record<string, unknown>
        const method = request.method as string
        const result = method === 'thread/start'
          ? { thread: { id: 'native-thread-1' } }
          : method === 'turn/start'
          ? { turn: { id: `native-turn-${++turnStarts}` } }
          : {}
        queueMicrotask(() =>
          view.message({
            type: 'mcp-response',
            hostId: 'local',
            message: { id: request.id, result },
          })
        )
      },
    }
    install('window', view)
    install('location', view.location)
    install('codexWindowType', 'electron')
    install('electronBridge', bridge)

    const transport = await CodexDesktopAgentSessionTransport.connect(emptyRecovery())
    expect(transport).toBeDefined()
    if (transport === undefined) throw new Error('transport did not connect')
    const events: string[] = []
    const statuses: string[] = []
    const claims: string[] = []
    transport.onSessionEvent(event => events.push(event.type))
    transport.onAgentStatus(event => statuses.push(event.status))
    transport.onMessageClaimed(event => claims.push(event.messageId))
    transport.onApprovalRequest(async request => request.callId === 'tool-approval' ? 'allowed-once' : 'unavailable')

    expect(await transport.create({ owner: nativeOwner, sessionId: 'session-1', options: { model: 'gpt-test' } }))
      .toMatchObject({
        status: 'accepted',
        detail: { kind: 'host', ref: 'codex-thread:native-thread-1' },
      })
    expect(
      await transport.submit({
        sessionId: 'session-1',
        message: user('m-1', 'first'),
        target: 'next-turn',
        wakeup: true,
      }),
    ).toBe('accepted')
    view.message({
      type: 'mcp-notification',
      hostId: 'local',
      message: {
        method: 'turn/started',
        params: { threadId: 'native-thread-1', turn: { id: 'native-turn-1', status: 'inProgress' } },
      },
    })
    expect(
      await transport.submit({
        sessionId: 'session-1',
        message: user('m-2', 'queued'),
        target: 'next-turn',
        wakeup: true,
      }),
    ).toBe('accepted')
    expect(turnStarts).toBe(1)
    expect(
      await transport.submit({
        sessionId: 'session-1',
        message: user('m-3', 'steer'),
        target: 'next-step',
        wakeup: true,
      }),
    ).toBe('accepted')
    expect(
      await transport.submit({
        sessionId: 'session-1',
        message: user('m-4', 'inject'),
        target: 'next-step',
        wakeup: false,
      }),
    ).toBe('accepted')
    expect(sent.filter(item => (item.request as Record<string, unknown> | undefined)?.method === 'turn/steer'))
      .toHaveLength(1)
    expect(sent.filter(item => (item.request as Record<string, unknown> | undefined)?.method === 'thread/inject_items'))
      .toHaveLength(1)

    view.message({
      type: 'mcp-notification',
      hostId: 'local',
      message: {
        method: 'item/agentMessage/delta',
        params: { threadId: 'native-thread-1', turnId: 'native-turn-1', itemId: 'assistant-1', delta: 'hello' },
      },
    })
    view.message({
      type: 'mcp-notification',
      hostId: 'local',
      message: {
        method: 'item/completed',
        params: {
          threadId: 'native-thread-1',
          turnId: 'native-turn-1',
          item: { type: 'agentMessage', id: 'assistant-1', text: 'hello' },
        },
      },
    })
    view.message({
      type: 'mcp-notification',
      hostId: 'local',
      message: {
        method: 'item/started',
        params: {
          threadId: 'native-thread-1',
          turnId: 'native-turn-1',
          item: { type: 'commandExecution', id: 'tool-1', command: 'pwd', status: 'inProgress' },
        },
      },
    })
    view.message({
      type: 'mcp-notification',
      hostId: 'local',
      message: {
        method: 'item/completed',
        params: {
          threadId: 'native-thread-1',
          turnId: 'native-turn-1',
          item: {
            type: 'commandExecution',
            id: 'tool-1',
            command: 'pwd',
            status: 'completed',
            aggregatedOutput: '/tmp',
          },
        },
      },
    })

    const approvalEvent = view.message({
      type: 'mcp-request',
      hostId: 'local',
      request: {
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'native-thread-1', turnId: 'native-turn-1', itemId: 'tool-approval' },
      },
    })
    const responseCountBeforeUnknown = sent.filter(item => item.type === 'mcp-response').length
    view.message({
      type: 'mcp-request',
      hostId: 'local',
      request: {
        id: 'foreign-approval',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'foreign-thread', itemId: 'foreign-tool' },
      },
    })
    await settle()
    expect(approvalEvent.defaultPrevented).toBe(true)
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'mcp-response',
      response: { id: 'approval-1', result: { decision: 'accept' } },
    }))
    expect(sent.filter(item => item.type === 'mcp-response')).toHaveLength(responseCountBeforeUnknown + 1)

    const completed = {
      type: 'mcp-notification',
      hostId: 'local',
      message: {
        method: 'turn/completed',
        params: { threadId: 'native-thread-1', turn: { id: 'native-turn-1', status: 'completed' } },
      },
    }
    view.message(completed)
    view.message(completed)
    await settle()
    expect(turnStarts).toBe(2)
    view.message({
      type: 'mcp-notification',
      hostId: 'local',
      message: {
        method: 'turn/started',
        params: { threadId: 'native-thread-1', turn: { id: 'native-turn-2', status: 'inProgress' } },
      },
    })
    view.message({
      type: 'mcp-notification',
      hostId: 'local',
      message: {
        method: 'turn/completed',
        params: { threadId: 'native-thread-1', turn: { id: 'native-turn-2', status: 'completed' } },
      },
    })
    await settle()

    expect(events).toEqual([
      'turn/start',
      'step/start',
      'assistant/chunk',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'turn/end',
      'turn/start',
      'step/start',
      'step/end',
      'turn/end',
    ])
    expect(statuses).toEqual(['running', 'idle'])
    expect(new Set(claims)).toEqual(new Set(['m-1', 'm-2', 'm-3', 'm-4']))

    let replacements = 0
    transport.onReplacement(() => {
      replacements += 1
    })
    view.message({ type: 'codex-app-server-connection-changed', hostId: 'local', state: 'connected' })
    expect(replacements).toBe(0)
    view.message({ type: 'codex-app-server-initialized', hostId: 'local' })
    expect(replacements).toBe(0)
    view.message({ type: 'codex-app-server-connection-changed', hostId: 'local', state: 'connected' })
    expect(replacements).toBe(1)
    transport.dispose()
  })

  it('fails closed outside the exact audited Desktop build', async () => {
    const view = new TestWindow()
    install('window', view)
    install('location', view.location)
    install('codexWindowType', 'electron')
    install('electronBridge', {
      getSentryInitOptions: async () => ({ ...CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PIN, buildNumber: 'other' }),
      sendMessageFromView: async () => {},
    })
    expect(await CodexDesktopAgentSessionTransport.connect(emptyRecovery())).toBeUndefined()
  })

  it('accepts the separately audited 7982 bridge revision without widening the pin fence', async () => {
    const view = new TestWindow()
    install('window', view)
    install('location', view.location)
    install('codexWindowType', 'electron')
    install('electronBridge', {
      getSentryInitOptions: async () => ({ ...CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PINS[1] }),
      sendMessageFromView: async () => {},
    })
    expect(await CodexDesktopAgentSessionTransport.connect(emptyRecovery())).toBeDefined()
  })
})

describe('native Agent definition context', () => {
  const definition = (agentId: string, text: string): AgentSetup['definitions'][number] => ({
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json',
    contract: 'cordisx.agent-definition/v1',
    schemaVersion: 1,
    identity: { agentId, revision: 'r1' },
    name: agentId,
    promptSections: [{ sectionId: agentId, kind: 'introduction', text }],
    rules: [`${agentId} rule`],
    skills: [`${agentId} skill`],
    inherit: {
      promptSections: 'append',
      rules: 'merge',
      skills: 'merge',
      tools: 'merge',
      mcpServers: 'merge',
      runtimeDefaults: 'merge',
    },
  })
  const base = definition('base', 'Base context')
  const lead = { ...definition('lead', 'Lead context'), extends: [base.identity] }
  const setup: AgentSetup = { definition: lead.identity, definitions: [base, lead] }

  async function harness(recovery: NativeSessionRecoveryStore = emptyRecovery()) {
    const view = new TestWindow()
    const requests: { method: string; params: Record<string, unknown> }[] = []
    install('window', view)
    install('location', view.location)
    install('codexWindowType', 'electron')
    install('electronBridge', {
      getSentryInitOptions: async () => ({ ...CODEX_DESKTOP_AGENT_SESSION_TRANSPORT_PINS[1] }),
      sendMessageFromView: async (
        envelope: { type: string; request: { id: string; method: string; params: Record<string, unknown> } },
      ) => {
        if (envelope.type !== 'mcp-request') return
        const request = envelope.request
        requests.push(structuredClone(request))
        const result = request.method.startsWith('thread/')
          ? { thread: { id: 'native-context-thread' } }
          : { turn: { id: `turn-${requests.length}` } }
        queueMicrotask(() =>
          view.message({ type: 'mcp-response', hostId: 'local', message: { id: request.id, result } })
        )
      },
    })
    const transport = await CodexDesktopAgentSessionTransport.connect(recovery)
    if (transport === undefined) throw new Error('transport unavailable')
    return { view, requests, transport, recovery }
  }

  it('passes inherited setup through the real runtime on create and implicit resume, preserving user input', async () => {
    const { requests, transport } = await harness()
    const runtime = new CordisXAgentSessionRuntime({ driver: transport, authorize: async () => true })
    const owner = nativeOwner
    try {
      const created = await runtime.create(owner, {
        sessionId: 'context-session',
        options: { model: 'gpt-test' },
        setup,
      })
      expect(created.status).toBe('accepted')
      if (created.status !== 'accepted') throw new Error('create unavailable')
      const start = requests.find(request => request.method === 'thread/start')!.params
      expect(start.developerInstructions).toContain('"agentId":"lead"')
      for (const text of ['Base context', 'Lead context', 'base rule', 'lead rule', 'base skill', 'lead skill']) {
        expect(start.developerInstructions).toContain(text)
      }
      expect(start).not.toHaveProperty('baseInstructions')
      await created.handle.dispose()
      const resumed = await runtime.resume(owner, { sessionId: 'context-session' })
      expect(resumed.status).toBe('accepted')
      const resume = requests.find(request => request.method === 'thread/resume')!.params
      expect(resume).toEqual({ threadId: 'native-context-thread', developerInstructions: start.developerInstructions })
      await transport.submit({
        sessionId: 'context-session',
        message: user('input-1', 'Original user request'),
        target: 'next-turn',
        wakeup: true,
      })
      const turn = requests.find(request => request.method === 'turn/start')!.params
      expect(turn.input).toEqual([{ type: 'text', text: 'Original user request', text_elements: [] }])
      expect(turn).not.toHaveProperty('developerInstructions')
    } finally {
      await runtime.dispose()
    }
  })

  it('replaces explicit resume setup and refuses invalid definitions before a native request', async () => {
    const { requests, transport } = await harness()
    try {
      await transport.create({
        owner: nativeOwner,
        sessionId: 'context-session',
        options: { model: 'gpt-test' },
        setup,
      })
      const replacement = definition('reviewer', 'Review context')
      expect(
        await transport.resume({
          owner: nativeOwner,
          sessionId: 'context-session',
          setup: { definition: replacement.identity, definitions: [replacement] },
        }),
      ).toMatchObject({ status: 'accepted' })
      const resume = requests.at(-1)!.params
      expect(resume.developerInstructions).toContain('Review context')
      expect(resume.developerInstructions).not.toContain('Lead context')
      const count = requests.length
      const invalid = { ...setup, definition: { agentId: 'missing', revision: 'r1' } }
      expect(
        await transport.create({
          owner: nativeOwner,
          sessionId: 'invalid',
          options: { model: 'gpt-test' },
          setup: invalid,
        }),
      ).toEqual({
        status: 'unavailable',
        code: 'unsupported',
      })
      expect(await transport.resume({ owner: nativeOwner, sessionId: 'context-session', setup: invalid })).toEqual({
        status: 'unavailable',
        code: 'unsupported',
      })
      expect(requests).toHaveLength(count)
    } finally {
      transport.dispose()
    }
  })

  const toolSetup = (run: string): AgentToolSetup => ({
    skills: [{ id: 'collaboration', path: `/host/${run}/SKILL.md`, content: `Use the real CLI for ${run}.` }],
    commands: [{
      id: 'report',
      argv: ['/host/node', `/host/${run}/cli.mjs`, '--binding', `/host/${run}/binding.json`],
      bindingPath: `/host/${run}/binding.json`,
      expiresAt: '2099-01-01T00:00:00Z',
    }],
  })

  it('does not interpret an unknown Host SessionId or caller-spelled native reference as a thread binding', async () => {
    const { requests, transport } = await harness()
    try {
      for (const sessionId of ['cx-session.unknown', 'codex-thread:unknown', 'unknown-native-id']) {
        expect(await transport.resume({ owner: nativeOwner, sessionId })).toEqual({
          status: 'unavailable',
          code: 'unsupported',
        })
      }
      expect(requests).toHaveLength(0)
    } finally {
      transport.dispose()
    }
  })

  it('gets fresh tool context at actual dequeue, steer and inject, with Skill content separate from user text', async () => {
    const { requests, transport, view } = await harness()
    let current: AgentToolSetup = { skills: [], commands: [] }
    const getSetup = vi.spyOn(agentTools, 'getAgentToolSetup').mockImplementation(async () => current)
    try {
      await transport.create({ owner: nativeOwner, sessionId: 'tools-session', options: { model: 'gpt-test' }, setup })
      expect(getSetup).toHaveBeenLastCalledWith('tools-session')
      current = toolSetup('run-one')
      await transport.submit({
        sessionId: 'tools-session',
        message: user('m1', 'first user text'),
        target: 'next-turn',
        wakeup: true,
      })
      const first = requests.at(-1)!.params.input as Record<string, unknown>[]
      expect(first[0]).toEqual({ type: 'skill', name: 'collaboration', path: '/host/run-one/SKILL.md' })
      expect(first[1]!.text).toContain('Use the real CLI for run-one.')
      expect(first[1]!.text).toContain(JSON.stringify(current.commands[0]!.argv))
      expect(first.at(-1)).toEqual({ type: 'text', text: 'first user text', text_elements: [] })
      const lookups = getSetup.mock.calls.length
      await transport.submit({
        sessionId: 'tools-session',
        message: user('m2', 'queued user text'),
        target: 'next-turn',
        wakeup: true,
      })
      expect(getSetup).toHaveBeenCalledTimes(lookups)
      current = toolSetup('run-two')
      view.message({
        type: 'mcp-notification',
        hostId: 'local',
        message: {
          method: 'turn/completed',
          params: { threadId: 'native-context-thread', turn: { id: 'turn-2', status: 'completed' } },
        },
      })
      await settle()
      const queued = requests.at(-1)!.params.input
      expect(JSON.stringify(queued)).toContain('run-two')
      expect(JSON.stringify(queued)).not.toContain('run-one')
      expect(JSON.stringify(queued)).toContain('queued user text')
      current = toolSetup('run-three')
      await transport.submit({
        sessionId: 'tools-session',
        message: user('m3', 'steer text'),
        target: 'next-step',
        wakeup: true,
      })
      expect(requests.at(-1)!.method).toBe('turn/steer')
      expect(JSON.stringify(requests.at(-1)!.params.input)).toContain('run-three')
      current = toolSetup('run-four')
      await transport.submit({
        sessionId: 'tools-session',
        message: user('m4', 'injected text'),
        target: 'next-step',
        wakeup: false,
      })
      expect(requests.at(-1)!.method).toBe('thread/inject_items')
      const items = requests.at(-1)!.params.items as Record<string, unknown>[]
      expect(items[0]!.role).toBe('user')
      expect(JSON.stringify(items[0])).toContain('Use the real CLI for run-four.')
      expect(items[1]).toEqual({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'injected text' }],
      })
    } finally {
      transport.dispose()
    }
  })

  it('refuses revoked context on resume, create, dequeue and later inputs without a native fallback', async () => {
    const { requests, transport, view } = await harness()
    const getSetup = vi.spyOn(agentTools, 'getAgentToolSetup').mockResolvedValue(toolSetup('active-run'))
    try {
      await transport.create({ owner: nativeOwner, sessionId: 'revoked-session', options: { model: 'gpt-test' } })
      await transport.submit({
        sessionId: 'revoked-session',
        message: user('m1', 'first'),
        target: 'next-turn',
        wakeup: true,
      })
      await transport.submit({
        sessionId: 'revoked-session',
        message: user('m2', 'queued'),
        target: 'next-turn',
        wakeup: true,
      })
      getSetup.mockRejectedValue(new Error('agent tool setup unavailable; rebind required'))
      const count = requests.length
      for (const wakeup of [true, false]) {
        expect(
          await transport.submit({
            sessionId: 'revoked-session',
            message: user('late', 'late'),
            target: 'next-step',
            wakeup,
          }),
        ).toBe('unavailable')
      }
      expect(await transport.resume({ owner: nativeOwner, sessionId: 'revoked-session' })).toMatchObject({
        status: 'unavailable',
      })
      expect(await transport.create({ owner: nativeOwner, sessionId: 'another', options: { model: 'gpt-test' } }))
        .toMatchObject({
          status: 'unavailable',
        })
      view.message({
        type: 'mcp-notification',
        hostId: 'local',
        message: {
          method: 'turn/completed',
          params: { threadId: 'native-context-thread', turn: { id: 'turn-2', status: 'completed' } },
        },
      })
      await settle()
      expect(
        await transport.submit({
          sessionId: 'revoked-session',
          message: user('late-2', 'late'),
          target: 'next-turn',
          wakeup: true,
        }),
      ).toBe('unavailable')
      expect(requests).toHaveLength(count)
    } finally {
      transport.dispose()
    }
  })

  it('restores only an authorized missing Session, retains its turn watermark, and waits for a new tool binding', async () => {
    const recovery = emptyRecovery()
    const resolve = vi.spyOn(recovery, 'resolveBinding').mockResolvedValue({
      threadId: 'native-context-thread',
      completedTurns: 1,
      setupDigest: 'verified-by-host',
    })
    const save = vi.spyOn(recovery, 'saveBinding')
    const { requests, transport, view } = await harness(recovery)
    const getSetup = vi.spyOn(agentTools, 'getAgentToolSetup').mockRejectedValue(new Error('rebind required'))
    const runtime = new CordisXAgentSessionRuntime({ driver: transport, authorize: async () => true })
    try {
      expect(
        await runtime.resumeEntity(nativeOwner, {
          sessionId: 'original-session',
          definitionSource: 'session-persisted',
        }),
      ).toMatchObject({ status: 'unavailable', code: 'session-unavailable' })
      const result = await runtime.resume(nativeOwner, {
        sessionId: 'original-session',
        setup,
        mutationId: 'recover-original',
      })
      expect(result.status).toBe('accepted')
      expect(resolve).toHaveBeenCalledWith(nativeOwner, { sessionId: 'original-session', setup })
      expect(getSetup).not.toHaveBeenCalled()
      expect(requests.map(request => request.method)).toEqual(['thread/resume'])
      expect(requests[0]!.params.threadId).toBe('native-context-thread')
      const projection = runtime.playgroundProjection().find(session => session.sessionId === 'original-session')!
      expect(projection.header.isSeeded).toBe(true)
      expect(projection.events).toEqual([])
      expect(
        await runtime.resumeEntity(nativeOwner, {
          sessionId: 'original-session',
          definitionSource: 'session-persisted',
        }),
      ).toMatchObject({ status: 'unavailable', code: 'unsupported' })
      expect(
        await transport.submit({
          sessionId: 'original-session',
          message: user('not-bound', 'wait'),
          target: 'next-turn',
          wakeup: true,
        }),
      ).toBe('unavailable')
      expect(requests).toHaveLength(1)
      getSetup.mockResolvedValue(toolSetup('rebound-run'))
      expect(
        await transport.submit({
          sessionId: 'original-session',
          message: user('bound', 'continue'),
          target: 'next-turn',
          wakeup: true,
        }),
      ).toBe('accepted')
      expect(requests.at(-1)!.method).toBe('turn/start')
      view.message({
        type: 'mcp-notification',
        hostId: 'local',
        message: {
          method: 'turn/completed',
          params: { threadId: 'native-context-thread', turn: { id: 'turn-2', status: 'completed' } },
        },
      })
      await settle()
      expect(save).toHaveBeenLastCalledWith(
        nativeOwner,
        expect.objectContaining({
          sessionId: 'original-session',
          threadId: 'native-context-thread',
          completedTurns: 2,
        }),
      )
    } finally {
      await runtime.dispose()
    }
  })

  it('does not create a recovery ledger or issue native requests when binding authorization refuses', async () => {
    const recovery = emptyRecovery()
    const resolve = vi.spyOn(recovery, 'resolveBinding').mockRejectedValue(new Error('owner or setup mismatch'))
    const { requests, transport } = await harness(recovery)
    const runtime = new CordisXAgentSessionRuntime({ driver: transport, authorize: async () => true })
    try {
      expect(await runtime.resume(nativeOwner, { sessionId: 'original-session', setup })).toMatchObject({
        status: 'unavailable',
      })
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(runtime.playgroundProjection()).toEqual([])
      expect(requests).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  it('persists creation before acceptance and prevents a queued turn overtaking its terminal checkpoint', async () => {
    const recovery = emptyRecovery()
    const save = vi.spyOn(recovery, 'saveBinding')
    const { requests, transport, view } = await harness(recovery)
    try {
      expect(
        await transport.create({
          owner: nativeOwner,
          sessionId: 'checkpointed',
          options: { model: 'gpt-test' },
          setup,
        }),
      ).toMatchObject({ status: 'accepted' })
      expect(save).toHaveBeenCalledWith(nativeOwner, {
        sessionId: 'checkpointed',
        threadId: 'native-context-thread',
        setup,
        completedTurns: 0,
      })
      await transport.submit({
        sessionId: 'checkpointed',
        message: user('first', 'first'),
        target: 'next-turn',
        wakeup: true,
      })
      let rejectCheckpoint!: (error: Error) => void
      save.mockImplementationOnce(() =>
        new Promise((_resolve, reject) => {
          rejectCheckpoint = reject
        })
      )
      view.message({
        type: 'mcp-notification',
        hostId: 'local',
        message: {
          method: 'turn/completed',
          params: { threadId: 'native-context-thread', turn: { id: 'turn-2', status: 'completed' } },
        },
      })
      expect(
        await transport.submit({
          sessionId: 'checkpointed',
          message: user('next', 'next'),
          target: 'next-turn',
          wakeup: true,
        }),
      ).toBe('accepted')
      expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(1)
      rejectCheckpoint(new Error('persistence unavailable'))
      await settle()
      expect(
        await transport.submit({
          sessionId: 'checkpointed',
          message: user('blocked', 'blocked'),
          target: 'next-turn',
          wakeup: true,
        }),
      ).toBe('unavailable')
      expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(1)
    } finally {
      transport.dispose()
    }
  })
})
