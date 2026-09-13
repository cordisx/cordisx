import { localWalletBytes } from '@cordisx/protocol/local-wallet/v1'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto'
import { lstatSync, readFileSync, renameSync, rmdirSync, unlinkSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { LocalWalletBindingV1 } from '@cordisx/protocol/local-wallet/v1'
import type { LauncherKeychainBackend } from './secret-store.js'

export class LocalWalletStateError extends Error {
  constructor(
    readonly code: 'local-wallet-not-enrolled' | 'local-wallet-reconciliation-required' | 'local-wallet-revoked',
  ) {
    super(code)
  }
}
export const LOCAL_WALLET_KEYCHAIN_SERVICE = 'cordisx/local-wallet/v1'
export interface LocalWalletEntry {
  readonly realm: string
  readonly nativeSubject: string
  readonly serverPublicKey: string
  readonly status: 'prepared' | 'submitted' | 'active' | 'revoked'
  readonly accountId?: string
  readonly receipt?: string
}
export interface LocalWalletProfile {
  readonly contract: 'cordisx.local-wallet-profile/v1'
  readonly keyRef: string
  readonly publicKey: string
  readonly subject: string
  readonly revision: string
  readonly entries: readonly LocalWalletEntry[]
}
export const localWalletRealm = (binding: LocalWalletBindingV1) => JSON.stringify([binding.origin, binding.instanceId])
export function localWalletPrivateKey(value: string) {
  if (!/^[A-Za-z0-9+/]{64}$/u.test(value)) throw new Error('invalid local signing key')
  const der = Buffer.from(value, 'base64'), key = createPrivateKey({ key: der, type: 'pkcs8', format: 'der' })
  if (key.asymmetricKeyType !== 'ed25519' || !key.export({ type: 'pkcs8', format: 'der' }).equals(der)) {
    throw new Error('invalid local signing key')
  }
  return key
}
/** Host-private, profile-scoped delegation. Missing keys and unknown enrollment never recreate authority. */
export class LocalWalletRegistry {
  private readonly file: string
  constructor(homeDir: string, profileId: string, private readonly keychain: LauncherKeychainBackend) {
    if (!/^[A-Za-z0-9._-]{1,120}$/u.test(profileId) || ['.', '..'].includes(profileId)) {
      throw new Error('invalid profile')
    }
    this.file = path.join(homeDir, 'state', 'profiles', profileId, 'local-wallet.json')
  }
  read(): LocalWalletProfile | undefined {
    try {
      const stat = lstatSync(this.file)
      if (
        !stat.isFile() || stat.size > 1_048_576 || (stat.mode & 0o077) !== 0
        || (process.getuid && stat.uid !== process.getuid())
      ) throw new Error('unsafe local wallet registry')
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as LocalWalletProfile
      if (
        value.contract !== 'cordisx.local-wallet-profile/v1' || !/^[A-Za-z0-9_-]{43}$/u.test(value.keyRef)
        || !/^[A-Za-z0-9_-]{43}$/u.test(value.revision) || !Array.isArray(value.entries) || value.entries.length > 64
      ) throw new Error('invalid local wallet registry')
      const der = Buffer.from(value.publicKey, 'base64'),
        key = createPublicKey({ key: der, type: 'spki', format: 'der' })
      if (
        key.asymmetricKeyType !== 'ed25519' || der.toString('base64') !== value.publicKey
        || !key.export({ type: 'spki', format: 'der' }).equals(der)
        || value.subject !== 'host-local:' + createHash('sha256').update(der).digest('base64url')
      ) throw new Error('invalid local wallet profile key')
      const realms = new Set<string>()
      for (const entry of value.entries) {
        if (
          typeof entry.realm !== 'string' || realms.has(entry.realm)
          || !/^codex:[A-Za-z0-9_-]{43}$/u.test(entry.nativeSubject)
          || !['prepared', 'submitted', 'active', 'revoked'].includes(entry.status)
          || createPublicKey(entry.serverPublicKey).asymmetricKeyType !== 'ed25519'
          || (entry.status === 'active'
            && (typeof entry.receipt !== 'string' || typeof entry.accountId !== 'string' || !entry.accountId))
        ) throw new Error('invalid local wallet entry')
        if (entry.status === 'active') {
          const receipt = JSON.parse(entry.receipt!), payload = receipt.payload
          if (
            !payload || payload.contract !== 'cordisx.local-wallet-result/v1'
            || payload.audience !== 'local-wallet-enrollment' || payload.subject !== value.subject
            || payload.nativeSubject !== entry.nativeSubject
            || JSON.stringify([payload.origin, payload.instanceId]) !== entry.realm || payload.result?.enrolled !== true
            || payload.result?.instanceId !== payload.instanceId || payload.result?.account?.id !== entry.accountId
            || typeof receipt.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(receipt.signature)
            || !verify(
              null,
              localWalletBytes(payload),
              entry.serverPublicKey,
              Buffer.from(receipt.signature, 'base64url'),
            )
          ) throw new Error('invalid stored local wallet receipt')
        }
        realms.add(entry.realm)
      }
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  private async mutation<T>(run: () => Promise<T>) {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
    await mkdir(this.file + '.lock', { mode: 0o700 })
    try {
      return await run()
    } finally {
      rmdirSync(this.file + '.lock')
    }
  }
  private async write(value: LocalWalletProfile, beforeCommit?: () => Promise<void>, guard?: () => void) {
    const temporary = this.file + '.' + randomBytes(32).toString('base64url')
    try {
      await writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 })
      await beforeCommit?.()
      guard?.()
      renameSync(temporary, this.file)
    } finally {
      try {
        unlinkSync(temporary)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  async prepare(
    binding: LocalWalletBindingV1,
    nativeSubject: string,
    serverPublicKey: string,
    beforeCommit?: () => Promise<void>,
    guard?: () => void,
  ) {
    return this.mutation(async () => {
      let profile = this.read()
      if (!profile) {
        const key = generateKeyPairSync('ed25519'), der = key.publicKey.export({ type: 'spki', format: 'der' })
        const keyRef = randomBytes(32).toString('base64url')
        await this.keychain.upsert(
          LOCAL_WALLET_KEYCHAIN_SERVICE,
          keyRef,
          key.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
        )
        profile = {
          contract: 'cordisx.local-wallet-profile/v1',
          keyRef,
          publicKey: der.toString('base64'),
          subject: 'host-local:' + createHash('sha256').update(der).digest('base64url'),
          revision: randomBytes(32).toString('base64url'),
          entries: [],
        }
        try {
          await this.write(profile, beforeCommit, guard)
        } catch (error) {
          await this.keychain.remove(LOCAL_WALLET_KEYCHAIN_SERVICE, keyRef).catch(() => {})
          throw error
        }
      }
      // Check the retained private key before any enrollment; never replace a missing key.
      const privateKey = localWalletPrivateKey(await this.keychain.read(LOCAL_WALLET_KEYCHAIN_SERVICE, profile.keyRef))
      if (
        createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64') !== profile.publicKey
      ) throw new Error('local wallet key mismatch')
      const realm = localWalletRealm(binding), prior = profile.entries.find(entry => entry.realm === realm)
      if (
        prior
        && (prior.nativeSubject !== nativeSubject || prior.serverPublicKey !== serverPublicKey
          || prior.status !== 'prepared')
      ) throw new Error('local wallet enrollment requires reconciliation')
      if (!prior) {
        if (profile.entries.length >= 64) throw new Error('local wallet realm limit')
        profile = {
          ...profile,
          revision: randomBytes(32).toString('base64url'),
          entries: [...profile.entries, { realm, nativeSubject, serverPublicKey, status: 'prepared' }],
        }
        await this.write(profile, beforeCommit, guard)
      }
      return profile
    })
  }
  async transition(
    profile: LocalWalletProfile,
    realm: string,
    status: LocalWalletEntry['status'],
    receipt?: string,
    accountId?: string,
    beforeCommit?: () => Promise<void>,
    guard?: () => void,
  ) {
    return this.mutation(async () => {
      const current = this.read()
      if (!current || current.revision !== profile.revision || current.keyRef !== profile.keyRef) {
        throw new Error('local wallet delegation retired')
      }
      const entry = current.entries.find(value => value.realm === realm)
      if (
        !entry || (status === 'submitted'
          ? entry.status !== 'prepared'
          : status === 'active'
          ? entry.status !== 'submitted'
          : status !== 'revoked')
      ) throw new Error('invalid local wallet transition')
      const next = {
        ...current,
        revision: randomBytes(32).toString('base64url'),
        entries: current.entries.map(value =>
          value === entry
            ? {
              ...entry,
              status,
              ...(receipt === undefined ? {} : { receipt }),
              ...(accountId === undefined ? {} : { accountId }),
            }
            : value
        ),
      }
      await this.write(next, beforeCommit, guard)
      return next
    })
  }
  active(binding: LocalWalletBindingV1) {
    const profile = this.read(), realm = localWalletRealm(binding)
    if (!profile) throw new LocalWalletStateError('local-wallet-not-enrolled')
    const entry = profile.entries.find(entry => entry.realm === realm)
    if (!entry) throw new LocalWalletStateError('local-wallet-not-enrolled')
    if (entry.status === 'revoked') throw new LocalWalletStateError('local-wallet-revoked')
    if (entry.status !== 'active') throw new LocalWalletStateError('local-wallet-reconciliation-required')
    return profile
  }
  current(profile: LocalWalletProfile) {
    try {
      return this.read()?.revision === profile.revision
    } catch {
      return false
    }
  }
}
