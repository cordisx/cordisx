import type { Context } from '@deepseek-ai/cordis'
import 'cordisx/contracts'

declare const ctx: Context

export async function inspectPublicChannelServices(): Promise<void> {
  const accounts = await ctx.channel.connections.list()
  void accounts[0]?.ref.tenantId
  ctx.channel.configuration.revision satisfies number
  // @ts-expect-error The Host-stamped revision is read-only.
  ctx.channel.configuration.revision = 2
  // @ts-expect-error The public configuration projection cannot be replaced by a caller.
  ctx.channel.configuration = { revision: 2 }
  // @ts-expect-error No source or generation authority is projected with the revision.
  void ctx.channel.configuration.generation

  const snapshot = ctx.channelManager.snapshot()
  const account = snapshot.accounts[0]
  if (account !== undefined) {
    const request = {
      contract: 'cordisx.channel-manager-request/v2',
      schemaVersion: 2,
      requestId: 'external-query-1',
      expectedRevision: snapshot.revision,
      profileId: snapshot.profileId,
      hostGeneration: snapshot.hostGeneration,
      operation: 'logs.query',
      target: { kind: 'log', connectionToken: account.connectionToken },
      query: { limit: 100 },
    } as const
    await ctx.channelManager.queryLogs(request)
  }

  // @ts-expect-error The public service never exposes the Host legacy adapter.
  void ctx.channelManager.legacy
  // @ts-expect-error The internal migration adapter is absent from the public Context.
  void ctx.channelManagerLegacy
  // @ts-expect-error Service configuration remains Host-private.
  void ctx.channelManager.serviceConfiguration
  // @ts-expect-error Service mutation remains Host-private.
  void ctx.channelManager.mutateServiceConfiguration
  // @ts-expect-error Credentialed connection creation remains Host-private.
  void ctx.channelManager.createConnection
  // @ts-expect-error Legacy action availability is not a public authority signal.
  void ctx.channelManager.actionsAvailable
  // @ts-expect-error Raw legacy actions are replaced by fenced execute requests.
  void ctx.channelManager.runAction
  // @ts-expect-error Public account projections carry opaque tokens, not raw Channel refs.
  void account?.ref
  // @ts-expect-error Public bindings carry opaque tokens, not raw Platform sessions.
  void snapshot.bindings[0]?.session
}
