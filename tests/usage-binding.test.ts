import { afterEach, describe, expect, it } from 'vitest'
import { BindingAgentHistoryAdapter } from '../packages/cli/src/renderer/agent-history-binding.js'
import { parseAgentHistoryBindingRequest } from '../packages/cli/src/launcher/agent-history-rpc.js'
const caller = { ownerKey: 'pet', generation: 'generation' }
afterEach(() => {
  globalThis.__cordisxAgentHistoryRequestV1 = undefined
  globalThis.__cordisxAgentHistoryReceiveV1 = undefined
})
describe('private Host usage bridge', () => {
  it('requires Host token and caller, accepts no source/profile/path input', () => {
    const valid = { requestId: 'usage-1', operation: 'usage', token: 'secret', caller, input: {} }
    expect(parseAgentHistoryBindingRequest(valid, 'secret')).toMatchObject({ operation: 'usage', caller, input: {} })
    expect(() => parseAgentHistoryBindingRequest(valid, 'other')).toThrow()
    for (const input of [{ path: '/private' }, { profile: 'other' }, { sessionId: 'other' }]) {
      expect(() => parseAgentHistoryBindingRequest({ ...valid, input }, 'secret')).toThrow()
    }
    expect(() => parseAgentHistoryBindingRequest({ ...valid, caller: undefined }, 'secret')).toThrow()
  })
  it('round trips unavailable semantics and disposes pending bridge calls', async () => {
    const status = { mode: 'unavailable' }
    globalThis.__cordisxAgentHistoryRequestV1 = payload => {
      const request = JSON.parse(payload)
      if (request.operation === 'status') {
        queueMicrotask(() =>
          globalThis.__cordisxAgentHistoryReceiveV1?.(
            JSON.stringify({ requestId: request.requestId, ok: true, value: status }),
          )
        )
      } else {queueMicrotask(() =>
          globalThis.__cordisxAgentHistoryReceiveV1?.(
            JSON.stringify({
              requestId: request.requestId,
              ok: true,
              value: { schemaVersion: 1, status: 'unavailable', reason: 'source-unavailable', diagnostics: [] },
            }),
          )
        )}
    }
    const adapter = await BindingAgentHistoryAdapter.connect('secret')
    expect(await adapter.readUsage(caller)).toEqual({
      schemaVersion: 1,
      status: 'unavailable',
      reason: 'source-unavailable',
      diagnostics: [],
    })
    globalThis.__cordisxAgentHistoryRequestV1 = () => {}
    adapter.dispose()
    expect(await adapter.readUsage(caller)).toMatchObject({ status: 'unavailable', reason: 'host-unavailable' })
  })
})
