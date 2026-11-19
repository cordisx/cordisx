import type { ChannelServiceConfigV3 } from '@cordisx/protocol/channel-service-config/v3'
import type { ChannelReceiveSelector, ChannelServiceConfigV2 } from './config-v2.js'

export type {
  ChannelPendingConnectionConfigV3,
  ChannelServiceConfigV3,
} from '@cordisx/protocol/channel-service-config/v3'

/** Pending accounts never enter the v1 runtime projection. */
export function parseChannelConfigV3(
  value: unknown,
  parseV2: (value: unknown) => ChannelServiceConfigV2,
): ChannelServiceConfigV3 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Channel v3 config')
  const config = value as Record<string, unknown>
  if (
    config.contract !== 'cordisx.channel-service-config/v3' || config.schemaVersion !== 3
    || Object.keys(config).some(key =>
      !['contract', 'schemaVersion', 'connections', 'pendingConnections'].includes(key)
    )
    || !Array.isArray(config.pendingConnections)
  ) throw new TypeError('Invalid Channel v3 config')
  const resolved = parseV2({
    contract: 'cordisx.channel-service-config/v2',
    schemaVersion: 2,
    connections: config.connections,
  })
  const seen = new Set<string>()
  for (const connection of resolved.connections) {
    const key = JSON.stringify([connection.ref.adapterId, connection.ref.accountId])
    seen.add(key)
  }
  const pending = config.pendingConnections.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Invalid pending account')
    const item = raw as Record<string, unknown>
    if (
      Object.keys(item).some(key => !['account', 'adapterKind', 'secretRef', 'displayName', 'selectors'].includes(key))
      || !item.account || typeof item.account !== 'object' || Array.isArray(item.account)
    ) throw new TypeError('Invalid pending account')
    const account = item.account as Record<string, unknown>
    if (
      Object.keys(account).some(key => !['adapterId', 'accountId'].includes(key))
      || !['feishu', 'lark'].includes(String(item.adapterKind)) || account.adapterId !== item.adapterKind
      || typeof account.accountId !== 'string' || !/^cli_[A-Za-z0-9_]+$/u.test(account.accountId)
      || account.accountId.length > 512
      || typeof item.secretRef !== 'string'
      || !/^(?:keychain|host-secret):[A-Za-z0-9][A-Za-z0-9._:/-]{0,500}$/u.test(item.secretRef)
      || typeof item.displayName !== 'string' || !item.displayName.trim() || item.displayName.length > 240
      || /[\u0000-\u001f]/u.test(item.displayName)
      || item.selectors !== undefined && (!Array.isArray(item.selectors) || !item.selectors.length
          || item.selectors.some(selector => !['direct', 'group', 'mentions', 'replies'].includes(selector))
          || new Set(item.selectors).size !== item.selectors.length)
    ) throw new TypeError('Invalid pending account')
    const key = JSON.stringify([account.adapterId, account.accountId])
    if (seen.has(key)) throw new TypeError('Duplicate Channel account')
    seen.add(key)
    return {
      account: Object.freeze({ adapterId: account.adapterId as string, accountId: account.accountId }),
      adapterKind: item.adapterKind as 'feishu' | 'lark',
      secretRef: item.secretRef,
      displayName: item.displayName,
      ...(item.selectors === undefined
        ? {}
        : { selectors: Object.freeze([...(item.selectors as ChannelReceiveSelector[])]) }),
    }
  })
  if (resolved.connections.length + pending.length > 64) throw new TypeError('Too many Channel accounts')
  return Object.freeze({
    contract: 'cordisx.channel-service-config/v3',
    schemaVersion: 3,
    connections: resolved.connections,
    pendingConnections: Object.freeze(pending.map(item => Object.freeze(item))),
  })
}
