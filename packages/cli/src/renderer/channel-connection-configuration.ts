import type { ChannelManagerFormOutcomeV1 } from '@cordisx/protocol/channel-manager/v7'
import type { ChannelCredentialRef } from '../launcher/channel-credential-drafts.js'
import type {
  HostServiceConfigDescriptor,
  HostServiceConfigMutation,
  HostServiceConfigMutationResult,
} from '../launcher/service-config.js'

/** Connection patch and optional read revision always use the normal service CAS. */
export async function mutateChannelConnectionConfiguration(input: {
  readonly descriptor: HostServiceConfigDescriptor | undefined
  readonly account: ChannelCredentialRef
  readonly patch: { displayName?: string; selectors?: readonly string[] }
  readonly expectedRevision?: number
  readonly live: () => boolean
  readonly mutate: (mutation: HostServiceConfigMutation) => Promise<HostServiceConfigMutationResult>
}): Promise<ChannelManagerFormOutcomeV1 & { readonly revision?: number }> {
  const { descriptor, account, patch } = input
  if (!input.live()) return { status: 'unavailable', code: 'STALE_GENERATION' }
  if (!descriptor?.writable) return { status: 'unavailable', code: 'OPERATION_UNAVAILABLE' }
  if (input.expectedRevision !== undefined && descriptor.revision !== input.expectedRevision) {
    return { status: 'conflict', code: 'REVISION_CONFLICT' }
  }
  if (
    Object.keys(patch).some(key => !['displayName', 'selectors'].includes(key))
    || patch.displayName !== undefined
      && (!patch.displayName.trim() || patch.displayName.length > 240 || /[\u0000-\u001f]/u.test(patch.displayName))
    || patch.selectors !== undefined && (!Array.isArray(patch.selectors) || !patch.selectors.length
        || new Set(patch.selectors).size !== patch.selectors.length || patch.selectors.some(item =>
          !['direct', 'group', 'mentions', 'replies'].includes(item)
        ))
  ) {
    return { status: 'rejected', code: 'INVALID_REQUEST' }
  }
  const config = descriptor.configuration as { connections: Array<Record<string, unknown>> }
  let found = false
  const connections = config.connections.map(item => {
    const ref = item.ref as ChannelCredentialRef
    if (
      ref.adapterId !== account.adapterId || ref.accountId !== account.accountId || ref.tenantId !== account.tenantId
    ) return item
    found = true
    return { ...item, ...patch }
  })
  if (!found) return { status: 'rejected', code: 'TARGET_UNAVAILABLE' }
  const result = await input.mutate({
    contract: 'cordisx.service-config-mutation/v1',
    schemaVersion: 1,
    identity: descriptor.identity,
    scope: descriptor.scope,
    expectedRevision: descriptor.revision,
    configuration: { ...config, connections } as HostServiceConfigMutation['configuration'],
  })
  return result.status === 'applied'
    ? { status: 'applied', code: 'APPLIED', revision: result.revision }
    : {
      status: result.status === 'conflict' ? 'conflict' : 'rejected',
      code: result.status === 'conflict' ? 'REVISION_CONFLICT' : 'CONFIGURATION_FAILED',
    }
}
