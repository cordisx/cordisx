import { describe, expect, it, vi } from 'vitest'
import { createNativeChatControl } from '../packages/cli/assets/launcher/native-chat-control.mjs'
const params = { threadId: 'chat', turnId: 'turn', itemId: 'item', reason: 'Needs approval' }
function fixture() {
  const events: Record<string, unknown>[] = [], writes: unknown[] = []
  const controlCall = vi.fn(async (_method, input) => ({ fields: input.params, captureId: 'capture' }))
  const control = createNativeChatControl({
    controlCall,
    readNative: async () => ({ thread: { id: 'chat', model: 'model', cwd: '/tmp' } }),
    writeNative: async value => {
      writes.push(value)
    },
    emit: async event => {
      events.push(event)
    },
    closed: () => false,
  })
  return { control, controlCall, events, writes }
}
describe('exact native approval and execution bridge', () => {
  it('matches every native identity, suppresses desktop duplicates, and resolves only on native confirmation', async () => {
    const f = fixture()
    f.control.received({ id: 7, method: 'item/commandExecution/requestApproval', params })
    const reference = f.events[0]!.reference
    expect(await f.control.respond({ requestId: 7, reference, ...params, itemId: 'other', decision: 'accept' }))
      .toEqual({ status: 'expired' })
    expect(await f.control.respond({ requestId: 7, reference, ...params, decision: 'accept' })).toEqual({
      status: 'submitted',
    })
    expect(f.writes).toEqual([{ id: 7, result: { decision: 'accept' } }])
    expect(f.control.desktopResponse({ id: 7, result: { decision: 'accept' } })).toBe(true)
    f.control.received({ method: 'serverRequest/resolved', params: { threadId: 'other', requestId: 7 } })
    expect(f.events.at(-1)!.event).toBe('answered')
    f.control.received({ method: 'serverRequest/resolved', params: { threadId: 'chat', requestId: 7 } })
    expect(f.events.at(-1)!.event).toBe('resolved')
    expect(await f.control.respond({ requestId: 7, reference, ...params, decision: 'accept' })).toEqual({
      status: 'expired',
    })
    f.control.dispose()
  })
  it('cancels pending requests and sanitizes execution observations without credentials', async () => {
    const f = fixture()
    f.control.received({ id: 'id', method: 'item/fileChange/requestApproval', params })
    f.control.received({ method: 'turn/completed', params: { threadId: 'chat', turn: { id: 'turn' } } })
    expect(f.events.at(-1)!.event).toBe('cancelled')
    f.control.received({
      method: 'thread/settings/updated',
      params: {
        threadId: 'chat',
        threadSettings: { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' }, authToken: 'not-forwarded' },
      },
    })
    expect(f.events.at(-1)).toEqual({
      type: 'execution-observed',
      threadId: 'chat',
      settings: { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } },
    })
    const prepared = await f.control.prepare('turn/start', { threadId: 'chat', input: [{ text: 'private prompt' }] })
    expect(prepared.params.input).toEqual([{ text: 'private prompt' }])
    expect(f.controlCall.mock.calls[0]?.[1]).not.toHaveProperty('context')
    expect(JSON.stringify(f.controlCall.mock.calls)).not.toContain('private prompt')
    f.control.dispose()
  })
  it('reads context only when a selected mode needs it and preserves accepted native effects after persistence failure', async () => {
    const f = fixture()
    f.controlCall.mockImplementationOnce(async () => ({ contextRequired: true }))
    await f.control.prepare('turn/start', { threadId: 'chat' })
    expect(f.controlCall.mock.calls[1]?.[1]).toMatchObject({ context: { model: 'model', cwd: '/tmp' } })
    f.controlCall.mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(f.control.complete('capture', true, { turn: { id: 'turn' } })).resolves.toBeUndefined()
    expect(f.events.at(-1)).toMatchObject({ type: 'execution-persistence-failed', accepted: true })
    f.control.dispose()
  })
  it('keeps a failed approval write unknown and never writes the same native response twice', async () => {
    const events: Record<string, unknown>[] = []
    const writeNative = vi.fn(async () => {
      throw new Error('transport closed')
    })
    const control = createNativeChatControl({
      controlCall: async () => ({}),
      writeNative,
      emit: async event => {
        events.push(event)
      },
      closed: () => false,
    })
    control.received({ id: 7, method: 'item/commandExecution/requestApproval', params })
    const response = { requestId: 7, reference: events[0]!.reference, ...params, decision: 'accept' }
    await expect(control.respond(response)).rejects.toThrow('transport closed')
    expect(events.at(-1)).toMatchObject({ type: 'native-approval-event', event: 'unknown' })
    expect(await control.respond(response)).toEqual({ status: 'expired' })
    expect(writeNative).toHaveBeenCalledOnce()
    control.received({ method: 'serverRequest/resolved', params: { threadId: 'chat', requestId: 7 } })
    expect(events.at(-1)!.event).toBe('resolved')
    control.dispose()
  })
})
