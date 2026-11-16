import { describe, expect, it, vi } from 'vitest'
import { type DiagnosticEvent, withDiagnostics } from '../packages/cli/src/diagnostics/context.js'
import { projectDiagnostic } from '../packages/cli/src/diagnostics/journal.js'
import { updateFeishuCard } from '../packages/cli/src/launcher/feishu-card-update.js'

describe('Feishu approval card business acknowledgement', () => {
  it('updates the exact SDK-issued message and accepts only business success', async () => {
    const patch = vi.fn(async () => ({ code: 0 }))
    const uncheckedUpdate = vi.fn(async () => undefined)
    const channel = { rawClient: { im: { v1: { message: { patch } } } }, updateCard: uncheckedUpdate }
    const events: DiagnosticEvent[] = []
    await withDiagnostics(
      { emit: event => events.push(event) },
      () => updateFeishuCard(channel as never, 'cli_private', 'om_exact', { elements: [] }),
    )
    expect(patch).toHaveBeenCalledExactlyOnceWith({
      path: { message_id: 'om_exact' },
      data: { content: '{"elements":[]}' },
    })
    expect(uncheckedUpdate).not.toHaveBeenCalled()
    expect(events.map(projectDiagnostic)).toEqual([expect.objectContaining({ phase: 'card-updated' })])
    expect(JSON.stringify(events)).not.toMatch(/cli_private|om_exact/)
  })

  it.each([230099, undefined])('rejects an HTTP-success response with business code %s', async code => {
    const patch = vi.fn(async () => ({ code, msg: 'private-response', data: { token: 'private-token' } }))
    const channel = { rawClient: { im: { v1: { message: { patch } } } } }
    const events: DiagnosticEvent[] = []
    await expect(
      withDiagnostics({
        emit: event => events.push(event),
      }, () => updateFeishuCard(channel as never, 'cli_private', 'om_exact', {})),
    )
      .rejects.toMatchObject({ message: 'CHANNEL_APPROVAL_CARD_UPDATE_FAILED', code })
    expect(patch).toHaveBeenCalledTimes(1)
    expect(events.map(projectDiagnostic).at(-1)).toMatchObject({
      phase: 'card-update-failed',
      ...(code === undefined ? {} : { errorCode: String(code) }),
    })
    expect(JSON.stringify(events)).not.toMatch(/private/)
  })

  it('retains only numeric HTTP and business metadata when transport rejects', async () => {
    const patch = vi.fn(async () => {
      throw Object.assign(new Error('private-error'), {
        response: { status: 403, data: { code: 99991672, msg: 'private-body' } },
        config: { headers: { Authorization: 'private-token' } },
      })
    })
    const events: DiagnosticEvent[] = []
    await expect(
      withDiagnostics({
        emit: event => events.push(event),
      }, () =>
        updateFeishuCard(
          { rawClient: { im: { v1: { message: { patch } } } } } as never,
          'cli_private',
          'om_exact',
          {},
        )),
    )
      .rejects.toMatchObject({ message: 'CHANNEL_APPROVAL_CARD_UPDATE_FAILED', code: 99991672 })
    expect(events.map(projectDiagnostic).at(-1)).toMatchObject({
      phase: 'card-update-failed',
      statusCode: 403,
      errorCode: '99991672',
    })
    expect(JSON.stringify(events)).not.toMatch(/private/)
  })
})
