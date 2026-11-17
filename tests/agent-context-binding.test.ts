import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserAgentContextBridge } from '../packages/cli/src/renderer/agent-context-binding.js'

afterEach(() => {
  globalThis.__cordisxAgentContextRequestV1 = undefined
  globalThis.__cordisxAgentContextReceiveV1 = undefined
})
describe('private Agent context transport', () => {
  it('sends authenticated methods and routes a long-poll response by request id', async () => {
    const requests: Record<string, unknown>[] = []
    globalThis.__cordisxAgentContextRequestV1 = payload => {
      requests.push(JSON.parse(payload))
    }
    const bridge = BrowserAgentContextBridge.connect('launch-token')
    const read = bridge.read({ sessionId: 's1' }), next = bridge.next({ handle: 'opaque', cursor: 2 })
    expect(requests).toMatchObject([{ version: 1, token: 'launch-token', method: 'read', sessionId: 's1' }, {
      version: 1,
      token: 'launch-token',
      method: 'next',
      handle: 'opaque',
      cursor: 2,
    }])
    globalThis.__cordisxAgentContextReceiveV1!(
      JSON.stringify({
        requestId: requests[1]!.requestId,
        ok: true,
        value: { status: 'events', events: [], cursor: 2 },
      }),
    )
    globalThis.__cordisxAgentContextReceiveV1!(
      JSON.stringify({ requestId: requests[0]!.requestId, ok: true, value: { status: 'unavailable', code: 'stale' } }),
    )
    await expect(read).resolves.toEqual({ status: 'unavailable', code: 'stale' })
    await expect(next).resolves.toEqual({ status: 'events', events: [], cursor: 2 })
    bridge.dispose()
  })
  it('rejects outstanding operations on document disposal and ignores late replies', async () => {
    globalThis.__cordisxAgentContextRequestV1 = vi.fn()
    const bridge = BrowserAgentContextBridge.connect('token'), pending = bridge.next({ handle: 'h', cursor: 0 })
    bridge.dispose()
    await expect(pending).rejects.toThrow('agent-context-unavailable')
    expect(globalThis.__cordisxAgentContextReceiveV1).toBeUndefined()
  })
})
