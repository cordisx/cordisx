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
    const scope = { profileId: 'work', compositionGeneration: 'composition-1', ownerKey: 'plugin-owner' }
    const command = { type: 'approval-decision', commandId: 'operation-1' }
    const binding = { bindingId: 'binding-1', generation: 1 }
    const definition = { agentId: 'agent-1', revision: 'revision-1' }
    expect(parseProviderBindingRequest({
      requestId: 'request-v4-approval', token: 'fixed-token', operation: 'agent-loop.v4.approval.decide',
      input: { scope, command, operationId: 'operation-1', task: 'task-1', binding, definition, turn: 'turn-1', approvalId: 'approval-1', decision: 'approved' },
    }, 'fixed-token')).toMatchObject({ operation: 'agent-loop.v4.approval.decide' })
    expect(parseProviderBindingRequest({
      requestId: 'request-v4-intro', token: 'fixed-token', operation: 'agent-loop.v4.introduction.request',
      input: { scope, command: { type: 'request-member-self-introduction', commandId: 'operation-2' }, operationId: 'operation-2', task: 'task-1', binding, definition, participantId: 'agent-1', memberId: 'member-1', runId: 'run-1' },
    }, 'fixed-token')).toMatchObject({ operation: 'agent-loop.v4.introduction.request' })
    expect(parseProviderBindingRequest({
      requestId: 'request-v4-cancel', token: 'fixed-token', operation: 'agent-loop.v4.introduction.cancel',
      input: { scope, command: { type: 'cancel-member-self-introduction', commandId: 'operation-3' }, operationId: 'operation-3', task: 'task-1', binding, definition, requestOperationId: 'operation-2', participantId: 'agent-1', memberId: 'member-1', runId: 'run-1' },
    }, 'fixed-token')).toMatchObject({ operation: 'agent-loop.v4.introduction.cancel' })
    expect(parseProviderBindingRequest({
      requestId: 'request-v4-lifecycle', token: 'fixed-token', operation: 'agent-loop.v4.lifecycle.read',
      input: { scope, task: 'task-1', binding, definition, afterSequence: 0 },
    }, 'fixed-token')).toMatchObject({ operation: 'agent-loop.v4.lifecycle.read' })
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
    expect(() => parseProviderBindingRequest({
      requestId: 'request-v4-bad-decision', token: 'fixed-token', operation: 'agent-loop.v4.approval.decide',
      input: { scope, command, operationId: 'operation-1', task: 'task-1', binding, definition, turn: 'turn-1', approvalId: 'approval-1', decision: 'allow-once' },
    }, 'fixed-token')).toThrow('approval decision is invalid')
    expect(() => parseProviderBindingRequest({
      requestId: 'request-v4-private', token: 'fixed-token', operation: 'agent-loop.v4.introduction.request',
      input: { scope, command, operationId: 'operation-2', task: 'task-1', binding, definition, participantId: 'agent-1', memberId: 'member-1', runId: 'run-1', prompt: 'private' },
    }, 'fixed-token')).toThrow('unknown field prompt')
  })
})
