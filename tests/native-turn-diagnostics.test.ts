import { expect, it } from 'vitest'
import { NativeTurnDiagnostics } from '../packages/cli/assets/launcher/native-turn-diagnostics.mjs'
it('correlates native queue, dispatch, first event and completion without retaining chat or errors', () => {
  const events: Record<string, unknown>[] = []
  let now = 0
  const tracker = new NativeTurnDiagnostics((event: Record<string, unknown>) => events.push(event), () => now)
  tracker.received({
    result: { thread: { id: 'thread-private' }, modelProvider: 'provider-test', model: 'model-test' },
  })
  const request = {
    id: 4,
    method: 'turn/start',
    params: { threadId: 'thread-private', input: [{ text: 'SECRET_CHAT' }], config: { api_key: 'SECRET_KEY' } },
  }
  tracker.queued(request)
  now = 10
  tracker.issued(request)
  tracker.received({ id: 4, result: { turn: { id: 'turn-private' } } })
  now = 20
  tracker.received({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-private', turnId: 'turn-private', delta: 'SECRET_REPLY' },
  })
  now = 30
  tracker.received({
    method: 'turn/completed',
    params: { turn: { id: 'turn-private', status: 'failed', error: { message: 'SECRET_ERROR' } } },
  })
  expect(events.map(event => event.event)).toEqual([
    'model-queued',
    'model-issued',
    'model-accepted',
    'model-first-event',
    'model-failed',
  ])
  expect(new Set(events.map(event => event.requestRef)).size).toBe(1)
  expect(events.at(-1)).toMatchObject({ elapsedMs: 30, provider: 'provider-test', model: 'model-test' })
  expect(JSON.stringify(events)).not.toMatch(/SECRET|thread-private|turn-private/u)
  expect(tracker.turns.size).toBe(0)
})
it('records cancellation and bounded correlation loss without affecting native pass-through', () => {
  const events: Record<string, unknown>[] = []
  const tracker = new NativeTurnDiagnostics((event: Record<string, unknown>) => events.push(event))
  for (let id = 0; id < 520; id++) tracker.queued({ id, method: 'turn/start', params: { threadId: 'same' } })
  expect(tracker.requests.size).toBe(512)
  expect(events.some(event => event.event === 'model-evidence-gap')).toBe(true)
  tracker.close()
  expect(events.at(-1)?.event).toBe('model-cancelled')
})
