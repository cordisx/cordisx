import { lstatSync, readFileSync, renameSync, rmdirSync, unlinkSync } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { LocalWalletBindingV1 } from '@cordisx/protocol/local-wallet/v1'
import { localWalletRealm } from './local-wallet-registry.js'
import type { WorkUsageReader } from './work-usage.js'
export const guardedLegacyWork =
  (custody: LocalWorkSettlementCustody | undefined, reader: WorkUsageReader | undefined) =>
  (snapshot: { readonly scopeId: string; readonly epoch: string }) =>
    (custody?.legacyAllowed(snapshot.scopeId) ?? false) && reader?.current?.(snapshot) !== false
interface Claim {
  readonly policy: 'leased' | 'durable-admitted-v1'
  readonly scopeId: string
  readonly realm: string
  readonly accountId: string
  readonly subject: string
}
/** Permanent profile custody; owner disposal and unknown financial completion never release it. */
export class LocalWorkSettlementCustody {
  private readonly file: string
  private readonly home: string
  constructor(home: string, profile: string) {
    if (!/^[A-Za-z0-9._-]{1,120}$/u.test(profile) || ['.', '..'].includes(profile)) throw new Error('invalid profile')
    this.home = path.resolve(home)
    this.file = path.join(this.home, 'state', 'profiles', profile, 'local-work-settlement.json')
  }
  private stat(file: string, directory = false) {
    try {
      const value = lstatSync(file)
      if (
        (directory ? !value.isDirectory() : !value.isFile()) || (value.mode & 0o077) !== 0
        || (process.getuid && value.uid !== process.getuid()) || (!directory && value.size > 1_048_576)
      ) throw new Error('unsafe settlement custody')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  private read(): readonly Claim[] {
    const started = this.stat(this.file + '.started', true), file = this.stat(this.file)
    if (!started && !file) return []
    if (!started || !file) throw new Error('settlement custody reconciliation required')
    const value = JSON.parse(readFileSync(this.file, 'utf8'))
    if (
      value.contract !== 'cordisx.local-work-settlement-custody/v1' || !Array.isArray(value.claims)
      || value.claims.length > 128
    ) throw new Error('invalid settlement custody')
    const scopes = new Set<string>()
    for (const claim of value.claims as Claim[]) {
      if (
        !claim || typeof claim !== 'object' || Array.isArray(claim)
        || Object.keys(claim).sort().join(',') !== 'accountId,policy,realm,scopeId,subject'
        || [claim.scopeId, claim.realm, claim.accountId, claim.subject].some(v =>
          typeof v !== 'string' || !v || v.length > 1024
        )
        || !['leased', 'durable-admitted-v1'].includes(claim.policy)
        || scopes.has(claim.scopeId)
      ) throw new Error('invalid settlement custody claim')
      scopes.add(claim.scopeId)
    }
    return value.claims as Claim[]
  }
  legacyAllowed(scopeId: string) {
    return !this.read().some(claim => claim.scopeId === scopeId && claim.policy === 'durable-admitted-v1')
  }
  private target(scopeId: string, binding: LocalWalletBindingV1, accountId: string, subject: string): Claim {
    return { policy: 'durable-admitted-v1', scopeId, realm: localWalletRealm(binding), accountId, subject }
  }
  assert(scopeId: string, binding: LocalWalletBindingV1, accountId: string, subject: string) {
    const expected = this.target(scopeId, binding, accountId, subject)
    const claim = this.read().find(value => value.scopeId === scopeId)
    if (!claim || Object.keys(expected).some(key => claim[key as keyof Claim] !== expected[key as keyof Claim])) {
      throw new Error('settlement scope custody conflict')
    }
  }
  async claim(scopeId: string, binding: LocalWalletBindingV1, accountId: string, subject: string, guard: () => void) {
    return this.install(this.target(scopeId, binding, accountId, subject), guard)
  }
  async claimLegacy(scopeId: string, guard: () => void) {
    return this.install({ policy: 'leased', scopeId, realm: 'legacy', accountId: 'legacy', subject: 'legacy' }, guard)
  }
  private async flushDirectory(guard: () => void) {
    let directoryName = path.dirname(this.file)
    while (true) {
      const directory = await open(directoryName, 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
      guard()
      if (directoryName === this.home) break
      directoryName = path.dirname(directoryName)
    }
  }
  private async install(target: Claim, guard: () => void) {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
    await mkdir(this.file + '.lock', { mode: 0o700 })
    try {
      guard()
      const claims = this.read()
      const prior = claims.find(value => value.scopeId === target.scopeId)
      if (prior) {
        if (Object.keys(target).some(key => prior[key as keyof Claim] !== target[key as keyof Claim])) {
          throw new Error('settlement scope custody conflict')
        }
        await this.flushDirectory(guard)
        return
      }
      if (claims.length >= 128) throw new Error('settlement custody limit')
      if ([target.scopeId, target.realm, target.accountId, target.subject].some(v => !v || v.length > 1024)) {
        throw new Error('invalid settlement custody target')
      }
      const temporary = this.file + '.' + randomBytes(32).toString('base64url')
      try {
        const file = await open(temporary, 'wx', 0o600)
        try {
          await file.writeFile(
            JSON.stringify({ contract: 'cordisx.local-work-settlement-custody/v1', claims: [...claims, target] })
              + '\n',
          )
          await file.sync()
        } finally {
          await file.close()
        }
        guard()
        // A failed first adoption leaves a durable marker: a missing custody file cannot silently reset it.
        if (!this.stat(this.file + '.started', true)) await mkdir(this.file + '.started', { mode: 0o700 })
        guard()
        renameSync(temporary, this.file)
        await this.flushDirectory(guard)
      } finally {
        try {
          unlinkSync(temporary)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    } finally {
      rmdirSync(this.file + '.lock')
    }
  }
}
