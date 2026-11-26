import { createElement } from 'react'
import type {
  ChannelManagerFormMountResultV1,
  ChannelManagerFormOptionsV1,
  ChannelManagerFormOutcomeV1,
} from '@cordisx/protocol/channel-manager/v7'
import type { ChannelCredentialRef } from '../launcher/channel-credential-drafts.js'
import type { PublicChannelManagerController } from './channel-manager-public.js'
import type { ChannelCredentialAuthorizer, ChannelCredentialWorkflow } from './channel-credential-workflow.js'
import { mountChannelHostForm } from './channel-form-mount.js'
import { ChannelConnectionForm, type ChannelConnectionFormSnapshot } from './channel-connection-form.js'
import { applyInlineChannelCredential } from './channel-inline-credential.js'
import { channelReceiveSelectors } from './channel-connection-form-fields.js'
import { ChannelCredentialForm } from './channel-credential-form.js'
import type { HostServiceConfigDescriptor } from '../launcher/service-config.js'
import { channelPendingTenantResolutionAllowed } from './channel-manager-presentation-scope.js'

export function channelConnectionFormSnapshot(
  descriptor: HostServiceConfigDescriptor,
  controller: PublicChannelManagerController,
  connectionToken: string,
  live: () => boolean,
  service?: object,
): ChannelConnectionFormSnapshot {
  const account = controller.target(connectionToken)
  const configuration = descriptor.configuration as {
    connections: Array<{ ref: ChannelCredentialRef; displayName?: string; selectors?: string[] }>
    pendingConnections?: Array<
      { account: { adapterId: string; accountId: string }; displayName?: string; selectors?: string[] }
    >
  }
  const stored = account?.tenantId
    ? configuration.connections.find(item =>
      account && item.ref.adapterId === account.adapterId && item.ref.accountId === account.accountId
      && item.ref.tenantId === account.tenantId
    )
    : configuration.pendingConnections?.find(item =>
      account && item.account.adapterId === account.adapterId
      && item.account.accountId === account.accountId
    )
  const current = controller.snapshot().accounts.find(item => item.connectionToken === connectionToken)
  if (!stored || !current || !live()) throw new Error('TARGET_UNAVAILABLE')
  return {
    displayName: stored.displayName ?? current.displayName ?? '',
    selectors: stored.selectors ?? ['direct', 'group'],
    serviceRevision: descriptor.revision,
    revision: controller.currentRevision(),
    writable: descriptor.writable && (current.availableOperations.includes('connection.update')
      || account?.tenantId === '' && service !== undefined && channelPendingTenantResolutionAllowed(service)
        && ['feishu', 'lark'].includes(account.adapterId)),
    credentialWritable: descriptor.writable && current.availableOperations.includes('target.credential.capture.rotate'),
  }
}

/** Frozen v7 retains its credential-only form. */
export function mountLegacyChannelCredentialForm(input: {
  readonly target: HTMLElement
  readonly pageOwner: string
  readonly operationOwner: string
  readonly connectionToken: string
  readonly account: ChannelCredentialRef
  readonly options: ChannelManagerFormOptionsV1
  readonly lifetime: AbortSignal
  readonly live: () => boolean
  readonly controller: PublicChannelManagerController
  readonly credentials: ChannelCredentialWorkflow
  readonly authorize: ChannelCredentialAuthorizer
}): ChannelManagerFormMountResultV1 {
  return mountChannelHostForm({
    target: input.target,
    owner: input.pageOwner,
    lifetime: input.lifetime,
    options: input.options,
    live: input.live,
    render: signal =>
      createElement(ChannelCredentialForm, {
        account: input.account,
        locale: input.target.ownerDocument.documentElement.lang || 'en',
        signal,
        onResult: result => {
          if (input.live() && !signal.aborted) input.options.onResult?.(result)
        },
        apply: secret => applyInlineChannelCredential({ ...input, owner: input.operationOwner, signal, secret }),
      }),
  })
}

/** Host-private composition for the public v8 empty body seat. */
export async function mountChannelConnectionForm(input: {
  readonly target: HTMLElement
  readonly pageOwner: string
  readonly operationOwner: string
  readonly connectionToken: string
  readonly account: ChannelCredentialRef
  readonly options: ChannelManagerFormOptionsV1
  readonly lifetime: AbortSignal
  readonly live: () => boolean
  readonly controller: PublicChannelManagerController
  readonly credentials?: ChannelCredentialWorkflow
  readonly read: () => Promise<ChannelConnectionFormSnapshot>
  readonly subscribe: (listener: () => void) => () => void
  readonly authorize: ChannelCredentialAuthorizer
  readonly update: (
    ref: ChannelCredentialRef,
    patch: { displayName?: string; selectors?: readonly string[] },
    serviceRevision: number,
  ) => Promise<ChannelManagerFormOutcomeV1>
}): Promise<ChannelManagerFormMountResultV1> {
  const signal = AbortSignal.any([input.lifetime, input.options.signal])
  const initial = await input.read()
  if (!input.live() || signal.aborted) return { status: 'unavailable', code: 'STALE_GENERATION' }
  return mountChannelHostForm({
    target: input.target,
    owner: input.pageOwner,
    lifetime: input.lifetime,
    options: input.options,
    live: input.live,
    render: signal =>
      createElement(ChannelConnectionForm, {
        account: input.account,
        initial,
        credentialsAvailable: input.credentials !== undefined,
        externalStyles: input.target.closest('[data-manager-surface="standalone"]') !== null,
        locale: input.target.ownerDocument.documentElement.lang || 'en',
        signal,
        read: input.read,
        subscribe: input.subscribe,
        onResult: result => {
          if (input.live() && !signal.aborted) input.options.onResult?.(result)
        },
        resolveTenant: async (tenantId, baseline) => {
          if (!input.credentials || !input.live() || signal.aborted || !baseline.writable) {
            return { status: 'unavailable', code: 'OPERATION_UNAVAILABLE' }
          }
          return input.credentials.resolveTenant({
            owner: input.operationOwner,
            account: input.account,
            tenantId,
            expectedServiceRevision: baseline.serviceRevision,
            signal,
            live: input.live,
            authorize: input.authorize,
          })
        },
        apply: async (values, baseline) => {
          if (!input.account.tenantId) {
            if (!input.credentials || !baseline.writable) {
              return { status: 'unavailable', code: 'OPERATION_UNAVAILABLE' }
            }
            return input.credentials.resolveTenant({
              owner: input.operationOwner,
              account: input.account,
              tenantId: values.tenantId,
              expectedServiceRevision: baseline.serviceRevision,
              signal,
              live: input.live,
              authorize: input.authorize,
            })
          }
          const snapshot = input.controller.snapshot()
          const patch = { displayName: values.displayName.trim(), selectors: channelReceiveSelectors(values.groupMode) }
          if (!input.live() || signal.aborted) return { status: 'unavailable', code: 'STALE_GENERATION' }
          if (values.secret) {
            if (!input.credentials || !baseline.credentialWritable) {
              return { status: 'unavailable', code: 'OPERATION_UNAVAILABLE' }
            }
            return applyInlineChannelCredential({
              controller: input.controller,
              credentials: input.credentials,
              owner: input.operationOwner,
              connectionToken: input.connectionToken,
              signal,
              live: input.live,
              authorize: input.authorize,
              secret: values.secret,
              expectedRevision: baseline.revision,
              configuration: { expectedServiceRevision: baseline.serviceRevision, patch },
            })
          }
          if (!baseline.writable || !await input.authorize(input.account)) {
            return { status: 'rejected', code: 'PERMISSION_DENIED' }
          }
          const result = await input.controller.execute(
            {
              contract: 'cordisx.channel-manager-request/v2',
              schemaVersion: 2,
              operation: 'connection.update',
              target: { kind: 'connection', connectionToken: input.connectionToken },
              profileId: snapshot.profileId,
              hostGeneration: snapshot.hostGeneration,
              requestId: crypto.randomUUID(),
              expectedRevision: baseline.revision,
              patch,
            },
            input.operationOwner,
            input.live,
            signal,
            input.authorize,
            {
              update: (ref, patch) => input.update(ref, patch, baseline.serviceRevision),
            },
          )
          return {
            status: result.status === 'applied' ? 'applied' : result.status === 'conflict'
              ? 'conflict'
              : result.status === 'rejected'
              ? 'rejected'
              : 'unavailable',
            code: result.code,
          }
        },
      }),
  })
}
