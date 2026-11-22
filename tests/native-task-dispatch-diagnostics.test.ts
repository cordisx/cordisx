import { harness } from './fixtures/native-intermediary-harness.js'
import { type DiagnosticEvent, withDiagnostics } from '../packages/cli/src/diagnostics/context.js'
import { describe, expect, it, vi } from 'vitest'

describe('native task dispatch diagnostics', () => {
  it('forwards bounded native task dispatch diagnostics over the authenticated channel', async () => {
    const events: DiagnosticEvent[] = []
    await withDiagnostics({ emit: event => events.push(event) }, async () => {
      const h = await harness()
      try {
        h.send({ id: 'ready-task-diagnostic', method: 'echo/bytes', params: {} })
        await h.read()
        await h.server.invokeTask({
          callId: 'private-call-id',
          sourceThreadId: 'private-source',
          sourceTurnId: 'private-turn',
          arguments: { prompt: 'PRIVATE_PROMPT', target: { type: 'projectless' } },
        })
        await vi.waitFor(() =>
          expect(events).toContainEqual(expect.objectContaining({
            event: 'model-native-task-dispatch',
            phase: 'native-response',
          }))
        )
        expect(events).toContainEqual(expect.objectContaining({
          event: 'model-native-task-dispatch',
          phase: 'native-request',
          requestRef: expect.stringMatching(/^[a-f0-9]{20}$/u),
        }))
        expect(JSON.stringify(events)).not.toMatch(/private-call-id|private-source|private-turn|PRIVATE_PROMPT/u)
      } finally {
        await h.close()
      }
    })
  })
})
