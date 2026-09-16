import { createHash, createPublicKey, verify } from 'node:crypto'
import type { WalletSpendIdentityV1, WalletSpendRecordV1, WalletSpendSourceV1 } from '@cordisx/protocol/wallet-spend/v1'
import { spendCanonical } from './wallet-spend-ipc-wire.js'

export function spendObject(value: unknown, keys?: readonly string[]): Record<string, any> {
  if (
    !value || typeof value !== 'object' || Array.isArray(value)
    || (keys && Object.keys(value).sort().join(',') !== [...keys].sort().join(','))
  ) throw new Error('invalid object')
  return value as Record<string, any>
}
export function spendId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new Error('invalid id')
  return value
}
export function spendPublicKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{59}$/.test(value)) throw new Error('invalid key')
  const der = Buffer.from(value, 'base64url'), key = createPublicKey({ key: der, type: 'spki', format: 'der' })
  if (
    der.toString('base64url') !== value || key.asymmetricKeyType !== 'ed25519'
    || !key.export({ type: 'spki', format: 'der' }).equals(der)
  ) throw new Error('invalid key')
  return value
}
export function spendSource(value: unknown): WalletSpendSourceV1 {
  const x = spendObject(value, ['serviceOrigin', 'servicePublicKey', 'serverId']), u = new URL(x.serviceOrigin)
  const local = u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  if ((!local && u.protocol !== 'https:') || u.origin !== x.serviceOrigin || u.username || u.password) {
    throw new Error('invalid origin')
  }
  return {
    serviceOrigin: u.origin,
    servicePublicKey: spendPublicKey(x.servicePublicKey),
    serverId: spendId(x.serverId),
  }
}
export function sameSpendSource(a: WalletSpendSourceV1, b: WalletSpendSourceV1): boolean {
  return a.serviceOrigin === b.serviceOrigin && a.servicePublicKey === b.servicePublicKey && a.serverId === b.serverId
}
export function spendSigned(text: unknown, contract: string, key: string, limit = 65_536): Record<string, any> {
  if (typeof text !== 'string' || Buffer.byteLength(text) > limit) throw new Error('invalid envelope')
  const envelope = spendObject(JSON.parse(text), ['payload', 'signature']), payload = spendObject(envelope.payload)
  if (
    payload.contract !== contract || typeof envelope.signature !== 'string'
    || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)
  ) throw new Error('invalid signature')
  const signature = Buffer.from(envelope.signature, 'base64url')
  if (
    signature.toString('base64url') !== envelope.signature
    || !verify(
      null,
      Buffer.from(contract + '\0' + spendCanonical(payload)),
      createPublicKey({ key: Buffer.from(spendPublicKey(key), 'base64url'), type: 'spki', format: 'der' }),
      signature,
    )
  ) {
    throw new Error('invalid signature')
  }
  return payload
}
export function spendIdentity(value: unknown): WalletSpendIdentityV1 {
  const x = spendObject(value, ['walletId', 'walletPublicKey'])
  return { walletId: spendId(x.walletId), walletPublicKey: spendPublicKey(x.walletPublicKey) }
}
export function spendTerms(
  text: string,
  source: WalletSpendSourceV1,
  identity: WalletSpendIdentityV1,
  fresh = true,
  pool = false,
) {
  const p = spendSigned(text, pool ? 'economy.pool-terms/v1' : 'economy.spend-terms/v1', source.servicePublicKey)
  spendObject(p, [
    'contract',
    'serviceOrigin',
    'servicePublicKey',
    'serverId',
    'matchId',
    'game',
    'participants',
    'policy',
    'acceptBefore',
    ...(pool ? ['rounds'] : []),
  ])
  if (
    !sameSpendSource(
      source,
      spendSource({ serviceOrigin: p.serviceOrigin, servicePublicKey: p.servicePublicKey, serverId: p.serverId }),
    )
    || (pool
      ? !['winner-weights', 'remaining-chips'].includes(p.policy) || !Number.isSafeInteger(p.rounds) || p.rounds < 1
        || p.rounds > 1000
      : p.policy !== 'capture-and-release')
    || !Number.isSafeInteger(p.acceptBefore) || p.acceptBefore < 0
    || (fresh && p.acceptBefore <= Date.now())
    || !Array.isArray(p.participants) || p.participants.length < 1 || p.participants.length > 8
  ) throw new Error('invalid terms')
  spendId(p.matchId)
  spendObject(p.game, ['id', 'version', 'digest', 'reviewStatus'])
  spendId(p.game.id)
  spendId(p.game.version)
  if (!/^[a-f0-9]{64}$/.test(p.game.digest) || !['reviewed', 'unreviewed'].includes(p.game.reviewStatus)) {
    throw new Error('invalid game')
  }
  const accounts = new Set(), wallets = new Set()
  for (const member of p.participants) {
    spendObject(member, ['gameAccountId', 'walletId', 'walletPublicKey', 'amount'])
    spendId(member.gameAccountId)
    spendId(member.walletId)
    spendPublicKey(member.walletPublicKey)
    if (
      !Number.isSafeInteger(member.amount) || member.amount < 1 || member.amount > 1_000_000_000_000
      || accounts.has(member.gameAccountId) || wallets.has(member.walletId)
    ) throw new Error('invalid participant')
    accounts.add(member.gameAccountId)
    wallets.add(member.walletId)
  }
  const own = p.participants.filter((member: any) =>
    member.walletId === identity.walletId && member.walletPublicKey === identity.walletPublicKey
  )
  if (own.length !== 1) throw new Error('original wallet not a participant')
  return { payload: p, own: own[0], hash: createHash('sha256').update(spendCanonical(p)).digest('hex') }
}
export function spendChallenge(text: string, source: WalletSpendSourceV1) {
  const p = spendSigned(text, 'economy.spend-wallet-challenge/v1', source.servicePublicKey)
  spendObject(p, ['contract', 'serviceOrigin', 'servicePublicKey', 'serverId', 'gameAccountId', 'nonce', 'expiresAt'])
  if (
    !sameSpendSource(
      source,
      spendSource({ serviceOrigin: p.serviceOrigin, servicePublicKey: p.servicePublicKey, serverId: p.serverId }),
    )
    || typeof p.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(p.nonce)
    || !Number.isSafeInteger(p.expiresAt) || p.expiresAt <= Date.now()
  ) throw new Error('invalid challenge')
  spendId(p.gameAccountId)
  return p
}
export function spendRecord(
  value: unknown,
  identity: WalletSpendIdentityV1,
  source: WalletSpendSourceV1,
): WalletSpendRecordV1 {
  const x = spendObject(value)
  if (
    Object.keys(x).some(key => !['reservation', 'state', 'settlement'].includes(key))
    || !['pending', 'captured', 'refunded'].includes(x.state)
  ) throw new Error('invalid record')
  const r = spendSigned(x.reservation, 'economy.spend-reservation/v1', identity.walletPublicKey)
  if (
    r.walletId !== identity.walletId || r.walletPublicKey !== identity.walletPublicKey
    || !sameSpendSource(
      source,
      spendSource({ serviceOrigin: r.serviceOrigin, servicePublicKey: r.servicePublicKey, serverId: r.serverId }),
    )
  ) throw new Error('wrong receipt')
  if (x.state !== 'pending') {
    const s = spendSigned(x.settlement, 'economy.spend-settlement/v1', identity.walletPublicKey)
    if (
      s.reservationId !== r.reservationId || s.walletId !== identity.walletId || s.amount !== r.amount
      || !Number.isSafeInteger(s.captured) || s.captured < 0 || s.captured > r.amount
      || s.released !== r.amount - s.captured
    ) throw new Error('invalid settlement')
  } else if (x.settlement !== undefined) throw new Error('pending settlement')
  return x as unknown as WalletSpendRecordV1
}

export function spendPurchaseReceipt(
  text: unknown,
  input: object,
  instanceId: string,
  accountId: string,
): 'purchased' | 'cancelled' {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 65_536) throw new Error('invalid purchase receipt')
  const x = spendObject(JSON.parse(text)), expected = input as Record<string, unknown>
  if (x.accountId !== accountId || x.instanceId !== instanceId) throw new Error('wrong wallet')
  if (x.state === 'cancelled') {
    spendObject(x, ['contract', 'state', 'instanceId', 'accountId', 'storeId', 'requestId', 'input', 'inputHash'])
    if (
      x.contract !== 'economy.local-purchase-cancelled/v1' || x.storeId !== expected.storeId
      || x.requestId !== expected.requestId || spendCanonical(x.input) !== spendCanonical(input)
      || x.inputHash !== createHash('sha256').update(spendCanonical(input)).digest('hex')
    ) throw new Error('wrong cancellation')
    return 'cancelled'
  }
  spendObject(x, [
    'instanceId',
    'accountId',
    'id',
    'itemId',
    'quantity',
    'total',
    ...(expected.fulfillmentTarget === undefined ? [] : ['fulfillmentTarget']),
  ])
  spendId(x.id)
  if (
    x.itemId !== expected.itemId || x.quantity !== expected.quantity || x.total !== expected.expectedTotal
    || spendCanonical(x.fulfillmentTarget ?? null) !== spendCanonical(expected.fulfillmentTarget ?? null)
  ) throw new Error('wrong order')
  return 'purchased'
}
