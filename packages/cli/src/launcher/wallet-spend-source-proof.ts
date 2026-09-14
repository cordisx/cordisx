import type { WalletSpendSourceV1 } from '@cordisx/protocol/wallet-spend/v1'
import { sameSpendSource, spendObject, spendSource } from './wallet-spend-validation.js'

/** Inline signatures prove key possession. Actual HTTPS supplies the separate origin binding. */
export async function verifyWalletSpendSource(source: WalletSpendSourceV1, signal: AbortSignal): Promise<void> {
  const actual = await fetchWalletSpendSource(source.serviceOrigin, signal, true)
  if (!sameSpendSource(source, actual)) throw new Error('source identity mismatch')
}
export async function fetchWalletSpendSource(
  origin: string,
  signal: AbortSignal,
  configuredLocal = false,
): Promise<WalletSpendSourceV1> {
  const url = new URL(origin)
  const local = configuredLocal && url.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.origin !== origin || (!local && url.protocol !== 'https:')) throw new Error('invalid origin')
  const timeout = AbortSignal.timeout(10_000)
  const response = await fetch(origin + '/v1/spend/identity', {
    method: 'GET',
    headers: { accept: 'application/json' },
    redirect: 'manual',
    credentials: 'omit',
    signal: AbortSignal.any([signal, timeout]),
  })
  if (response.status !== 200) {
    await response.body?.cancel()
    throw new Error('source unavailable')
  }
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []
  let size = 0
  if (!reader) throw new Error('empty source identity')
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > 4096) {
      await reader.cancel()
      throw new Error('oversized source identity')
    }
    chunks.push(next.value)
  }
  const x = spendObject(JSON.parse(Buffer.concat(chunks).toString('utf8')), [
    'contract',
    'serviceOrigin',
    'servicePublicKey',
    'serverId',
  ])
  const source = spendSource({
    serviceOrigin: x.serviceOrigin,
    servicePublicKey: x.servicePublicKey,
    serverId: x.serverId,
  })
  if (x.contract !== 'economy.spend-service/v1' || source.serviceOrigin !== origin) {
    throw new Error('source identity mismatch')
  }
  return source
}
