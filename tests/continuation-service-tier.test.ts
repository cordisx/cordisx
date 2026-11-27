import { describe, expect, it, vi } from 'vitest'
import { continuationStartMatches } from '../packages/cli/src/launcher/channel-continuation-config.js'
import { createLogicalNativeDestination } from '../packages/cli/src/launcher/logical-continuation-native-create.js'
import type {
  LogicalContinuationEvidence,
  LogicalContinuationRequest,
} from '../packages/cli/src/launcher/logical-continuation-control.js'

const request: LogicalContinuationRequest = {
  contract: 'cordisx.conversation-continuation-request/v1',
  operationId: 'operation',
  logicalConversationId: 'logical',
  source: { hostId: 'local', appId: 'codex', profileId: 'test', sessionId: 'source' },
  expectedRevision: 0,
  target: { providerId: 'target', model: 'model' },
  mode: 'fork',
  historyConsent: 'inherit',
}
const evidence: LogicalContinuationEvidence = {
  sourceHistoryVersion: 'version',
  handoff: 'none',
  sourceConfiguration: {
    providerId: 'source',
    model: 'old',
    cwd: '/workspace',
    serviceTier: null,
    approvalsReviewer: 'user',
    execution: { workMode: 'default', execution: 'read-only', approval: 'on-request', effort: 'medium' },
    sandbox: { type: 'readOnly' },
    permissionProfile: null,
  },
}
const receipt = {
  thread: { id: 'target-thread', forkedFromId: 'source', ephemeral: false, status: { type: 'idle' } },
  modelProvider: 'target',
  model: 'model',
  cwd: '/workspace',
  serviceTier: 'default',
  approvalsReviewer: 'user',
  approvalPolicy: 'on-request',
  reasoningEffort: 'medium',
  sandbox: { type: 'readOnly' },
  activePermissionProfile: null,
}

describe('native continuation service-tier readback', () => {
  it('accepts native fork and resume responses that normalize null to default', async () => {
    const native = { nativeRequest: vi.fn(async () => receipt) }
    const result = await createLogicalNativeDestination(
      native,
      request,
      evidence,
      (_id, params) => params,
      undefined,
      true,
    )
    expect(result).toMatchObject({ state: 'created', confirmed: true, destination: { sessionId: 'target-thread' } })
    expect(native.nativeRequest).toHaveBeenCalledOnce()
    expect(native.nativeRequest).toHaveBeenCalledWith('thread/fork', expect.objectContaining({ serviceTier: null }))
    expect(continuationStartMatches(receipt, { ...evidence.sourceConfiguration, ...request.target })).toBe(true)
  })

  it.each([undefined, 'priority', 'unrecognized'])('rejects an unconfirmed or different tier: %s', async tier => {
    const native = { nativeRequest: vi.fn(async () => ({ ...receipt, serviceTier: tier })) }
    expect(await createLogicalNativeDestination(native, request, evidence, (_id, params) => params, undefined, true))
      .toMatchObject({ state: 'created', confirmed: false })
    expect(native.nativeRequest).toHaveBeenCalledOnce()
  })
})
