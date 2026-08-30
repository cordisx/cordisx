import { describe, expect, it } from 'vitest'
import { parseProviderBindingRequest } from '../packages/cli/src/launcher/provider-rpc.js'

describe('provider CDP RPC boundary', () => {
  it('requires the launcher token and accepts only normalized public Platform operations', () => {
    expect(parseProviderBindingRequest({
      requestId: 'request-1', token: 'fixed-token', operation: 'tasks.read',
      input: { session: { providerId: 'alpha', remoteSessionId: 'same-id' } },
    }, 'fixed-token')).toMatchObject({ operation: 'tasks.read' })
    expect(parseProviderBindingRequest({
      requestId: 'request-2', token: 'fixed-token', operation: 'availability', input: {},
    }, 'fixed-token')).toMatchObject({ operation: 'availability' })
    expect(parseProviderBindingRequest({
      requestId: 'request-3', token: 'fixed-token', operation: 'agent-loop.create',
      input: { model: { providerId: 'alpha', modelId: 'same-model' }, cwd: '/workspace', developerInstructions: 'Agent definition', effort: 'high' },
    }, 'fixed-token')).toMatchObject({ operation: 'agent-loop.create' })
    expect(parseProviderBindingRequest({
      requestId: 'request-4', token: 'fixed-token', operation: 'agent-loop.lifecycle.read',
      input: { session: { providerId: 'alpha', remoteSessionId: 'same-id' }, afterSequence: 0 },
    }, 'fixed-token')).toMatchObject({ operation: 'agent-loop.lifecycle.read' })
    expect(() => parseProviderBindingRequest({
      requestId: 'request-1', token: 'wrong', operation: 'tasks.read',
      input: { session: { providerId: 'alpha', remoteSessionId: 'same-id' } },
    }, 'fixed-token')).toThrow('not authorized')
    expect(() => parseProviderBindingRequest({
      requestId: 'request-1', token: 'fixed-token', operation: 'app-server/raw', input: {},
    }, 'fixed-token')).toThrow('operation is invalid')
    expect(() => parseProviderBindingRequest({
      requestId: 'request-1', token: 'fixed-token', operation: 'tasks.read', input: { session: { remoteSessionId: 'same-id' } },
    }, 'fixed-token')).toThrow('session.providerId')
    expect(() => parseProviderBindingRequest({
      requestId: 'request-5', token: 'fixed-token', operation: 'agent-loop.create',
      input: { model: { providerId: 'alpha', modelId: 'same-model' }, cwd: '/workspace', imagePath: '/private/raw.png' },
    }, 'fixed-token')).toThrow('unknown field imagePath')
  })
})
