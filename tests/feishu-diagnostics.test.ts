import { describe, expect, it } from 'vitest'
import { LoggerLevel, LoggerProxy } from '@larksuiteoapi/node-sdk'
import { type DiagnosticEvent, withDiagnostics } from '../packages/cli/src/diagnostics/context.js'
import { projectDiagnostic } from '../packages/cli/src/diagnostics/journal.js'
import { createFeishuDiagnostics } from '../packages/cli/src/launcher/feishu-diagnostics.js'

describe('safe bounded Feishu observation', () => {
  it('binds to its owning journal, preserves numeric failures, and never emits SDK payloads', () => {
    const events: DiagnosticEvent[] = []
    const observation = withDiagnostics(
      { emit: event => events.push(event) },
      () => createFeishuDiagnostics('cli_private'),
    )
    const sdk = new LoggerProxy(LoggerLevel.debug, observation.logger)
    sdk.debug(
      '[ws]',
      'receive message, message_type: event; message_id: abc-123; trace_id: private; data: {secret-body}',
    )
    sdk.debug('safety: drop stale message om_private')
    observation.logger.info({ authorization: 'secret-token' })
    observation.reject('om_private', 'no_mention')
    observation.failure('inbound-failed', {
      response: { status: 403, data: { code: 99991672, message: 'secret-error' }, headers: 'secret-header' },
    })
    const projected = events.map(projectDiagnostic)
    expect(projected.map(event => event.phase)).toEqual(['ws-receive', 'sdk-drop', 'sdk-reject', 'inbound-failed'])
    expect(projected.at(-1)).toMatchObject({ statusCode: 403, errorCode: '99991672' })
    expect(JSON.stringify(projected)).not.toMatch(/private|secret/)
    observation.dispose()
    observation.logger.error(new Error('secret-after-dispose'))
    expect(events).toHaveLength(4)
  })
  it('caps SDK observations without controlling the message pipeline', () => {
    const events: DiagnosticEvent[] = []
    const observation = withDiagnostics({ emit: event => events.push(event) }, () => createFeishuDiagnostics('fixture'))
    for (let index = 0; index < 1000; index++) observation.event('normalized')
    expect(events).toHaveLength(513)
    expect(events.at(-1)).toMatchObject({ phase: 'observation-limit', count: 512 })
  })
})
