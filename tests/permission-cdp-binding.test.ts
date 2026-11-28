import { expect, it, vi } from 'vitest'
import { installPermissionCdpBinding } from '../packages/cli/src/launcher/permission-cdp-binding.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'

it('accepts only the document-registered native key and retires an uncertain write', async () => {
  const listeners = new Map<string, (params: Record<string, unknown>) => void>()
  const session = {
    onEvent: (name: string, listener: (params: Record<string, unknown>) => void) => {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    send: vi.fn(async () => ({})),
  }
  const remote = {
    register: vi.fn(async () => true),
    write: vi.fn(async () => {
      throw new Error('lost')
    }),
    once: vi.fn(async () => true),
    uncertain: vi.fn(),
  }
  const token = 'a'.repeat(64)
  const keyId = 'b'.repeat(64)
  const remove = installPermissionCdpBinding(
    session as never,
    {
      configPath: '/unused',
      profileId: 'default',
      token,
      identities: [],
      identityAllowed: () => true,
      remote,
    },
    {} as never,
    new AbortController(),
  )
  const call = (payload: unknown, executionContextId = 4) =>
    listeners.get('Runtime.bindingCalled')!({
      name: '__cordisxPermissionPolicyRequestV1',
      payload: JSON.stringify(payload),
      executionContextId,
    })
  try {
    call({ kind: 'register', requestId: 'register-1', token, keyId, key: {} })
    await vi.waitFor(() => expect(remote.register).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(session.send).toHaveBeenCalledOnce())
    const [record] = exactDomPermissionPolicies('default', [{
      id: 'demo',
      entry: '/demo.js',
      pointIds: ['manager.content'],
    }])
    call({ requestId: 'bad', token, records: [record], proof: { keyId: 'c'.repeat(64), proof: {} } })
    await vi.waitFor(() => expect(session.send).toHaveBeenCalledTimes(2))
    expect(remote.write).not.toHaveBeenCalled()
    listeners.get('Runtime.bindingCalled')!({
      name: '__cordisxPermissionOnceRequestV1',
      executionContextId: 4,
      payload: JSON.stringify({
        requestId: 'once',
        token,
        record,
        decision: 'allow-once',
        proof: { keyId, proof: {} },
      }),
    })
    await vi.waitFor(() => expect(remote.once).toHaveBeenCalledOnce())
    call({ requestId: 'good', token, records: [record], proof: { keyId, proof: {} } })
    await vi.waitFor(() => expect(remote.uncertain).toHaveBeenCalledOnce())
    expect(remote.write).toHaveBeenCalledOnce()
    expect(session.send.mock.calls.at(-1)?.[1]).toMatchObject({ contextId: 4 })
  } finally {
    remove()
  }
})
