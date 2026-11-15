import type { ChannelServiceConfigV1, ChannelServiceConnectionConfig } from './config.js'

export type ChannelReceiveSelector = 'direct' | 'group' | 'mentions' | 'replies'
export interface ChannelServiceConnectionConfigV2 extends ChannelServiceConnectionConfig {
  readonly displayName?: string
  readonly selectors?: readonly ChannelReceiveSelector[]
}
export interface ChannelServiceConfigV2 {
  readonly contract: 'cordisx.channel-service-config/v2'
  readonly schemaVersion: 2
  readonly connections: readonly ChannelServiceConnectionConfigV2[]
}

/** V1 is frozen: validate its exact projection, then independently validate v2 metadata. */
export function parseChannelConfigV2(
  value: unknown,
  parseV1: (value: unknown) => ChannelServiceConfigV1,
): ChannelServiceConfigV2 {
  const config = value as Record<string, unknown>
  if (
    config.contract !== 'cordisx.channel-service-config/v2' || config.schemaVersion !== 2
    || Object.keys(config).some(key => !['contract', 'schemaVersion', 'connections'].includes(key))
    || !Array.isArray(config.connections)
  ) throw new TypeError('Channel v2 configuration is invalid')
  const metadata = config.connections.map((raw: unknown) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TypeError('Channel connection is invalid')
    }
    const { displayName, selectors, ...base } = raw as Record<string, unknown>
    if (
      displayName !== undefined && (typeof displayName !== 'string' || !displayName.trim()
        || displayName.length > 240 || /[\u0000-\u001f]/u.test(displayName))
    ) {
      throw new TypeError('Channel display name is invalid')
    }
    if (
      selectors !== undefined && (!Array.isArray(selectors) || !selectors.length || selectors.length > 4
        || selectors.some(item => !['direct', 'group', 'mentions', 'replies'].includes(item))
        || new Set(selectors).size !== selectors.length)
    ) throw new TypeError('Channel receive selectors are invalid')
    return {
      base,
      ...(displayName === undefined ? {} : { displayName: displayName as string }),
      ...(selectors === undefined ? {} : { selectors: selectors as ChannelReceiveSelector[] }),
    }
  })
  const parsed = parseV1({
    contract: 'cordisx.channel-service-config/v1',
    schemaVersion: 1,
    connections: metadata.map(item => item.base),
  })
  return Object.freeze({
    contract: 'cordisx.channel-service-config/v2',
    schemaVersion: 2,
    connections: Object.freeze(parsed.connections.map((base, index) =>
      Object.freeze({
        ...base,
        ...(metadata[index]!.displayName === undefined ? {} : { displayName: metadata[index]!.displayName }),
        ...(metadata[index]!.selectors === undefined
          ? {}
          : { selectors: Object.freeze([...metadata[index]!.selectors!]) }),
      })
    )),
  })
}

/** Explicit adapter input projection; never writes a downgraded document to storage. */
export function channelServiceInputV1(
  configuration: ChannelServiceConfigV1 | ChannelServiceConfigV2,
): ChannelServiceConfigV1 {
  return {
    contract: 'cordisx.channel-service-config/v1',
    schemaVersion: 1,
    connections: configuration.connections.map(({ ref, adapterKind, enabled, transport, secretRef }) => ({
      ref,
      adapterKind,
      enabled,
      transport,
      ...(secretRef === undefined ? {} : { secretRef }),
    })),
  }
}
