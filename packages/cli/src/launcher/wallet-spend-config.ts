import path from 'node:path'
import { lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { WalletSpendSourceV1 } from '@cordisx/protocol/wallet-spend/v1'
import { localWalletBinding } from '@cordisx/protocol/local-wallet/v1'
import { spendObject, spendSource } from './wallet-spend-validation.js'

/** Deployment-private configuration. It is never loaded from plugin configuration. */
export function loadWalletSpendConfig(homeDir: string, profileId: string) {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(profileId) || ['.', '..'].includes(profileId)) throw new Error('invalid profile')
  const file = path.join(homeDir, 'state', 'profiles', profileId, 'wallet-spend.json')
  const stat = lstatSync(file)
  if (
    !stat.isFile() || stat.size > 65_536 || (stat.mode & 0o777) !== 0o600
    || (process.getuid && stat.uid !== process.getuid())
  ) throw new Error('unsafe spend config')
  const fingerprint = readFileSync(file, 'utf8')
  const x = spendObject(JSON.parse(fingerprint), [
    'contract',
    'socketPath',
    'secretFile',
    'walletBinding',
    'services',
    'stores',
  ])
  if (
    x.contract !== 'cordisx.wallet-spend-config/v1' || typeof x.socketPath !== 'string'
    || typeof x.secretFile !== 'string' || !path.isAbsolute(x.socketPath) || !path.isAbsolute(x.secretFile)
    || !Array.isArray(x.services) || x.services.length > 64
  ) throw new Error('invalid spend config')
  const binding = localWalletBinding(x.walletBinding)
  if (binding.audience !== 'local-wallet') throw new Error('invalid wallet binding')
  const services = x.services.map((service: unknown) => {
    const entry = spendObject(service), owner = spendObject(entry.owner, ['pluginId', 'source'])
    if (
      Object.keys(entry).some(key => !['owner', 'source', 'status'].includes(key))
      || (entry.status !== undefined && !['active', 'recovery-only'].includes(entry.status))
    ) throw new Error('invalid pin status')
    if (
      typeof owner.pluginId !== 'string' || !owner.pluginId || typeof owner.source !== 'string'
      || owner.source.length > 4096 || !['file:', 'https:'].includes(new URL(owner.source).protocol)
    ) throw new Error('invalid owner')
    return {
      owner: { pluginId: owner.pluginId, source: owner.source },
      source: spendSource(entry.source),
      status: entry.status ?? 'active',
    }
  })
  if (!Array.isArray(x.stores) || x.stores.length > 64) throw new Error('invalid stores')
  const stores = x.stores.map((store: unknown) => {
    const entry = spendObject(store, ['owner', 'storeId']), owner = spendObject(entry.owner, ['pluginId', 'source'])
    if (typeof owner.pluginId !== 'string' || typeof owner.source !== 'string' || typeof entry.storeId !== 'string') {
      throw new Error('invalid store')
    }
    return { owner: { pluginId: owner.pluginId, source: owner.source }, storeId: entry.storeId }
  })
  return {
    socketPath: x.socketPath as string,
    secretFile: x.secretFile as string,
    binding,
    services,
    stores,
    fingerprint,
  }
}

/** Native-approved TLS pins; rotation preserves old keys exclusively for pending recovery. */
export function persistWalletSpendSource(
  homeDir: string,
  profileId: string,
  fingerprint: string,
  owner: { readonly pluginId: string; readonly source: string },
  source: WalletSpendSourceV1,
  guard: () => void,
): void {
  const file = path.join(homeDir, 'state', 'profiles', profileId, 'wallet-spend.json'), lock = file + '.lock'
  mkdirSync(lock, { mode: 0o700 })
  const temporary = file + '.' + randomBytes(16).toString('hex')
  try {
    if (loadWalletSpendConfig(homeDir, profileId).fingerprint !== fingerprint) throw new Error('pin conflict')
    const config = JSON.parse(fingerprint)
    config.services = config.services.map((entry: any) =>
      entry.owner.pluginId === owner.pluginId
        && entry.owner.source === owner.source && entry.source.serviceOrigin === source.serviceOrigin
        ? { ...entry, status: 'recovery-only' }
        : entry
    )
    config.services.push({ owner, source, status: 'active' })
    if (config.services.length > 64) throw new Error('pin limit')
    writeFileSync(temporary, JSON.stringify(config) + '\n', { flag: 'wx', mode: 0o600 })
    guard()
    renameSync(temporary, file)
  } finally {
    try {
      unlinkSync(temporary)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    rmdirSync(lock)
  }
}
