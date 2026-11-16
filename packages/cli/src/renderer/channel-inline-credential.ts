import type { ChannelManagerFormOutcomeV1 } from '@cordisx/protocol/channel-manager/v7'
import type { ChannelManagerRequestV2, ChannelManagerTargetRequestV1 } from '@cordisx/protocol/channel-manager/v2'
import type {
  ChannelCredentialAuthorizer,
  ChannelCredentialConfigurationWrite,
  ChannelCredentialWorkflow,
} from './channel-credential-workflow.js'
import type { PublicChannelManagerController } from './channel-manager-public.js'

/** Inline Host input still follows the same one-shot capture and exact-connection commit lineage. */
interface InlineChannelCredentialInput {
  readonly controller: PublicChannelManagerController
  readonly credentials: ChannelCredentialWorkflow
  readonly owner: string
  readonly connectionToken: string
  readonly signal: AbortSignal
  readonly live: () => boolean
  readonly authorize: ChannelCredentialAuthorizer
  readonly secret: string
  readonly expectedRevision?: number
  readonly configuration?: ChannelCredentialConfigurationWrite
}

export async function applyInlineChannelCredential(
  input: InlineChannelCredentialInput,
): Promise<ChannelManagerFormOutcomeV1> {
  try {
    return await applyCredential(input)
  } finally {
    // Retire only this form operation's private captures, including a rejected commit.
    input.credentials.retireOwner(input.owner)
  }
}

async function applyCredential(input: InlineChannelCredentialInput): Promise<ChannelManagerFormOutcomeV1> {
  const { controller, credentials, owner, connectionToken, signal, live, authorize } = input
  const snapshot = controller.snapshot()
  const target = { kind: 'connection' as const, connectionToken }
  const request = () => ({
    profileId: snapshot.profileId,
    hostGeneration: snapshot.hostGeneration,
    expectedRevision: controller.currentRevision(),
    requestId: crypto.randomUUID(),
  })
  const outcome = (result: { status: string; code?: string }): ChannelManagerFormOutcomeV1 => ({
    status: result.status === 'applied'
      ? 'applied'
      : result.status === 'conflict'
      ? 'conflict'
      : result.status === 'rejected'
      ? 'rejected'
      : 'unavailable',
    code: result.code ?? 'CREDENTIAL_CONFIGURATION_FAILED',
  })
  if (!live() || signal.aborted) return { status: 'unavailable', code: 'STALE_GENERATION' }
  if (input.expectedRevision !== undefined && input.expectedRevision !== controller.currentRevision()) {
    return { status: 'conflict', code: 'REVISION_CONFLICT' }
  }
  const issued = await controller.issue(
    {
      ...request(),
      contract: 'cordisx.channel-manager-target-request/v1',
      schemaVersion: 1,
      operation: 'target.credential.capture.rotate',
      purpose: 'rotate',
      target,
    } as ChannelManagerTargetRequestV1,
    owner,
  )
  if (issued.status !== 'applied' || issued.target.kind !== 'credential-capture') return outcome(issued)
  let failureCode: string | undefined
  const captured = await credentials.execute(
    {
      ...request(),
      contract: 'cordisx.channel-manager-request/v2',
      schemaVersion: 2,
      operation: 'credential.capture',
      target: issued.target,
    } as ChannelManagerRequestV2,
    owner,
    live,
    authorize,
    signal,
    async capture => {
      if (!capture.account || capture.signal.aborted || !live()) return false
      return capture.submit(capture.account, input.secret, capture.signal, code => {
        failureCode = code
      })
    },
    input.configuration,
  )
  if (
    captured.status !== 'applied' || !('credentialDraftToken' in captured)
    || typeof captured.credentialDraftToken !== 'string'
  ) {
    return {
      ...outcome({ status: captured.status ?? 'unavailable', code: captured.code ?? 'CAPTURE_FAILED' }),
      ...(failureCode ? { code: failureCode } : {}),
      ...(failureCode === 'REVISION_CONFLICT' ? { status: 'conflict' as const } : {}),
    }
  }
  return outcome(
    await controller.execute(
      {
        ...request(),
        contract: 'cordisx.channel-manager-request/v2',
        schemaVersion: 2,
        operation: 'connection.rotate-credential',
        target,
        draft: { credentialDraftToken: captured.credentialDraftToken },
      },
      owner,
      live,
      signal,
      authorize,
      undefined,
      input.configuration,
    ),
  )
}
