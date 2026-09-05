import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { SessionEvent, SessionEventDataMap, SessionEventType } from '@cordisx/protocol/sessions/v1'
import { describe, expect, it } from 'vitest'
import type { CordisXAgentSessionProjection } from '../packages/cli/src/renderer/agent-session-runtime.js'
import { projectPlaygroundAgentSessions } from '../packages/cli/src/renderer/playground-agent-session-projection.js'
import type { PlaygroundMockTaskTrace } from '../packages/cli/src/renderer/playground-mock-agent-loop.js'
import { PlaygroundScenarioLabController } from '../packages/cli/src/playground/scenario-lab.js'

const sessionId = 'cx-session.timeline'

function event<Type extends SessionEventType>(
  seq: number,
  type: Type,
  data: SessionEventDataMap[Type],
): SessionEvent<Type> {
  return {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event.v1.schema.json',
    contract: 'cordisx.session-event/v1',
    schemaVersion: 1,
    sessionId,
    seq,
    time: 1_780_000_000_000 + seq,
    type,
    data,
  } as SessionEvent<Type>
}

function taskFor(events: readonly SessionEvent[]): PlaygroundMockTaskTrace {
  const session: CordisXAgentSessionProjection = {
    sessionId,
    sessionGeneration: 1,
    header: { id: sessionId, formatVersion: 1, createdAt: 1_780_000_000_000, isSeeded: false },
    events,
  }
  const task = projectPlaygroundAgentSessions([session])?.tasks[0]
  if (task === undefined) throw new Error('Timeline fixture did not project a task')
  return task
}

function plainAssistantEvents(): readonly SessionEvent[] {
  return [
    event(0, 'user/message', {
      id: 'cx-message.user.1',
      role: 'user',
      content: [{ type: 'text', text: 'Explain the current state.' }],
      source: { kind: 'user' },
    }),
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'step/start', { turn: 1, step: 1 }),
    event(3, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }),
    event(4, 'assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'Everything is ready.' },
    }),
    event(5, 'assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'Everything is ready.' } },
    }),
    event(6, 'assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'cx-message.assistant.1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Everything is ready.' }],
        source: { kind: 'model', provider: 'fixture', model: 'fixture-v1' },
      },
    }),
    event(7, 'step/end', { turn: 1, step: 1 }),
    event(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
}

function toolEvents(error = false): readonly SessionEvent[] {
  const callId = 'cx-tool-call.read-state.1'
  return [
    event(0, 'user/message', {
      id: 'cx-message.user.tool',
      role: 'user',
      content: [{ type: 'text', text: 'Read the state.' }],
      source: { kind: 'user' },
    }),
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'step/start', { turn: 1, step: 1 }),
    event(3, 'tool/call', { turn: 1, step: 1, callId, name: 'workspace.read_state', arguments: '{"scope":"current"}' }),
    event(4, 'tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'cx-message.tool-result.1',
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          content: [{ type: 'text', text: error ? 'read failed' : 'state is ready' }],
          ...(error ? { isError: true } : {}),
        }],
        source: { kind: 'tool', callId },
      },
      ...(error ? { error: { name: 'ReadError', code: 'STATE_UNAVAILABLE' } } : {}),
    }),
    ...plainAssistantEvents().slice(3).map((
      item,
      index,
    ) => ({ ...item, seq: index + 5, time: item.time + 2 } as SessionEvent)),
  ]
}

describe('Playground Session timeline information architecture', () => {
  it('attributes only user/message to Chatroom and folds stream chunks into one Agent response', () => {
    const events = plainAssistantEvents()
    const controller = new PlaygroundScenarioLabController(taskFor(events))
    const trace = controller.getSnapshot().trace

    expect(trace.filter(entry => entry.direction === 'chatroom-to-agent-host')).toHaveLength(1)
    expect(trace.find(entry => entry.direction === 'chatroom-to-agent-host')).toMatchObject({
      presentation: 'user-input',
    })
    expect(trace.filter(entry => entry.presentation === 'tool-use' || entry.presentation === 'tool-result'))
      .toHaveLength(0)
    expect(trace.filter(entry => entry.presentation === 'assistant-response')).toHaveLength(1)
    const response = trace.find(entry => entry.presentation === 'assistant-response')
    expect(response).toMatchObject({ direction: 'agent-host-to-chatroom', summary: 'Everything is ready.' })
    expect(response?.rawSessionEvents?.map(item => item.type)).toEqual([
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/message',
    ])
    expect(
      trace.some(entry => entry.type === 'session.event' && entry.rawSessionEvents?.[0]?.type === 'assistant/chunk'),
    ).toBe(false)
    expect(
      trace.filter(entry => entry.presentation === 'agent-execution').every(entry =>
        entry.direction === 'agent-execution'
      ),
    ).toBe(true)
    expect(trace.flatMap(entry => entry.rawSessionEvents ?? []).map(item => item.seq)).toEqual(
      events.map(item => item.seq),
    )
    controller.dispose()
  })

  it('renders real tool calls and results with exact tool and call identity, including errors', () => {
    const task = taskFor(toolEvents())
    expect(task.events.find(item => item.type === 'tool.call')).toMatchObject({
      detail: expect.stringContaining(
        'Tool use · workspace.read_state · cx-tool-call.read-state.1 · {"scope":"current"}',
      ),
    })
    expect(task.events.find(item => item.type === 'tool.result')).toMatchObject({
      detail: expect.stringContaining(
        'Tool result · workspace.read_state · cx-tool-call.read-state.1 · state is ready',
      ),
    })
    const controller = new PlaygroundScenarioLabController(task)
    expect(controller.getSnapshot().trace.filter(entry => entry.presentation === 'tool-use')).toMatchObject([{
      direction: 'agent-to-tool',
      correlations: { operationId: 'cx-tool-call.read-state.1' },
    }])
    expect(controller.getSnapshot().trace.filter(entry => entry.presentation === 'tool-result')).toMatchObject([{
      direction: 'tool-to-agent',
      correlations: { operationId: 'cx-tool-call.read-state.1' },
    }])
    controller.dispose()

    expect(taskFor(toolEvents(true)).events.find(item => item.type === 'tool.result')?.detail)
      .toContain(
        'Tool error · workspace.read_state · cx-tool-call.read-state.1 · ReadError/STATE_UNAVAILABLE · read failed',
      )
  })

  it('keeps raw facts keyboard-expandable and tokenized for both Host themes', async () => {
    const [component, styles] = await Promise.all([
      readFile(path.resolve('packages/cli/src/playground/client/components/ScenarioLabPage.tsx'), 'utf8'),
      readFile(path.resolve('packages/cli/src/playground/client/styles.css'), 'utf8'),
    ])
    expect(component).toContain('<details className="pg-event-raw-details">')
    expect(component).toMatch(/<summary>\s*\{en/u)
    expect(component).toContain('rawSessionEvents.length} SessionEvent')
    expect(component).toContain('data-event-fact={factKind}')
    expect(styles).toContain('.pg-event-raw-details > summary:focus-visible { outline: 2px solid var(--pg-accent);')
    expect(styles).toContain('.pg-event-timeline-item[data-trace-presentation="tool-use"] .pg-event-bubble')
    expect(styles).toContain('.pg-event-timeline-item[data-trace-presentation="tool-result"] .pg-event-bubble')
    expect(styles).toContain('html[data-theme="light"]')
    expect(styles).toContain('--pg-panel-raised: #252525;')
    expect(styles).toContain('--pg-panel-raised: #fff;')
  })
})
