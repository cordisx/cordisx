import type { WalletSpendIdentityV1, WalletSpendSourceV1 } from '@cordisx/protocol/wallet-spend/v1'
import type { WalletPoolRecordV1 } from '@cordisx/protocol/wallet-pool/v1'
import type { WalletSpendIpcClient } from './wallet-spend-ipc-client.js'
import type { confirmWalletSpendNative } from './wallet-spend-native-consent.js'
import { spendCanonical } from './wallet-spend-ipc-wire.js'
import {
  sameSpendSource,
  spendId,
  spendObject,
  spendSigned,
  spendSource,
  spendTerms,
} from './wallet-spend-validation.js'

export function poolRecord(
  value: unknown,
  identity: WalletSpendIdentityV1,
  source: WalletSpendSourceV1,
): WalletPoolRecordV1 {
  const r = spendObject(value, ['reservation', 'sequence', 'paid', 'exited', 'decisionHash'])
  const p = spendSigned(r.reservation, 'economy.pool-reservation/v1', identity.walletPublicKey)
  if (
    p.walletId !== identity.walletId || p.walletPublicKey !== identity.walletPublicKey
    || !sameSpendSource(
      source,
      spendSource({ serviceOrigin: p.serviceOrigin, servicePublicKey: p.servicePublicKey, serverId: p.serverId }),
    )
    || !Number.isSafeInteger(r.sequence) || r.sequence < 0 || !Number.isSafeInteger(r.paid) || r.paid < 0
    || typeof r.exited !== 'boolean' || (r.decisionHash !== null && !/^[a-f0-9]{64}$/.test(r.decisionHash))
  ) throw Error('invalid pool record')
  return r as unknown as WalletPoolRecordV1
}
/** Economic effects are delegated to the trusted provider. This layer only authorizes an exact document. */
export async function runPoolOperation(options: {
  operation: string
  input: Record<string, any>
  source: WalletSpendSourceV1
  identity: WalletSpendIdentityV1
  client: WalletSpendIpcClient
  guard: () => void
  markDispatched: () => void
  confirm: typeof confirmWalletSpendNative
  signal: AbortSignal
  plugin: unknown
}) {
  const { operation, input, source, identity, client, guard } = options
  if (operation === 'wallet-spend-pool-lookup') {
    const result = await client.call('pool-lookup', { source, requestId: spendId(input.requestId) })
    return result === null ? null : poolRecord(result, identity, source)
  }
  if (operation === 'wallet-spend-pool-apply') {
    const decision = spendSigned(input.decision, 'economy.pool-decision/v1', source.servicePublicKey, 262_144)
    spendTerms(JSON.stringify(decision.terms), source, identity, false, true)
    guard()
    options.markDispatched()
    return poolRecord(await client.call('pool-apply', { source, decision: input.decision }), identity, source)
  }
  const terms = spendTerms(input.terms, source, identity, false, true)
  const previous = await client.call('pool-lookup', { source, requestId: spendId(input.requestId) })
  guard()
  const check = (value: unknown) => {
    const record = poolRecord(value, identity, source), p = JSON.parse(record.reservation).payload
    if (
      p.termsHash !== terms.hash || p.matchId !== terms.payload.matchId || p.amount !== terms.own.amount
      || p.gameAccountId !== terms.own.gameAccountId
    ) throw Error('pool request conflict')
    return record
  }
  if (previous !== null) return check(previous)
  spendTerms(input.terms, source, identity, true, true)
  const quote = spendObject(await client.call('pool-quote', { terms: input.terms, requestId: input.requestId }), [
    'token',
    'terms',
  ])
  guard()
  const quoted = spendTerms(quote.terms, source, identity, true, true)
  if (spendCanonical(quoted.payload) !== spendCanonical(terms.payload)) throw Error('changed pool quote')
  const approved = await options.confirm({
    summary: `抵押 ${terms.own.amount} Token 参加 ${terms.payload.rounds} 轮游戏，按约定分配奖池。断线时保留抵押。`,
    document: JSON.stringify({ plugin: options.plugin, terms: quoted.payload, termsHash: terms.hash }, null, 2),
    signal: options.signal,
  })
  guard()
  if (!approved) return 'denied' as const
  spendTerms(quote.terms, source, identity, true, true)
  options.markDispatched()
  return check(await client.call('pool-reserve', { token: quote.token }))
}
