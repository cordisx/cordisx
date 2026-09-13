import { createHash, randomBytes } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs'
import { mkdir, open, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { UsageSnapshotV1 } from '../usage-contracts.js'
import { LocalUsageHost, localUsageLedgerIdentity, type LocalUsageOptions } from './local-usage.js'

interface Claim {
  contract: 'cordisx.work-usage-profile/v1'
  codexHome: string
  cacheDir: string
  legacyProfileName: string
  scopeId: string
  epoch: string
}
export interface WorkUsageProfileLocation {
  readonly homeDir: string
  readonly profileId: string
  readonly bootstrapGuard?: { readonly scopeId: string; readonly epoch: string }
}
const scope = (home: string, profile: string) =>
  createHash('sha256').update(`${home}\0${profile}\0work-v2`).digest('hex')
const unavailable = (): UsageSnapshotV1 => ({
  schemaVersion: 1,
  status: 'unavailable',
  reason: 'store-unavailable',
  diagnostics: [{ code: 'work-profile-continuity-conflict' }],
})

/** Retain the original ledger identity when a development config or its entries move. */
export class WorkUsageProfileHost {
  private readonly file: string
  private readonly history: string
  private readonly home: string
  private reader: LocalUsageHost | undefined
  private pinned: Claim | undefined
  private active: Promise<UsageSnapshotV1> | undefined
  private closed = false
  private readonly guard: WorkUsageProfileLocation['bootstrapGuard']
  constructor(location: WorkUsageProfileLocation, private readonly options: LocalUsageOptions) {
    if (!/^[A-Za-z0-9._-]{1,120}$/u.test(location.profileId) || ['.', '..'].includes(location.profileId)) {
      throw new Error('invalid work profile')
    }
    this.home = path.resolve(location.homeDir)
    this.guard = location.bootstrapGuard
    this.file = path.join(this.home, 'state', 'profiles', location.profileId, 'work-usage-profile.json')
    this.history = path.join(this.home, 'state', 'work-usage-history', location.profileId + '.started')
  }
  private stat(file: string, directory = false) {
    try {
      const s = lstatSync(file)
      if (
        (directory ? !s.isDirectory() : !s.isFile()) || (s.mode & 0o077) !== 0
        || (process.getuid && s.uid !== process.getuid()) || (!directory && s.size > 16_384)
      ) throw new Error('unsafe work profile claim')
      return s
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  private claim(): Claim | undefined {
    for (const file of [this.file, this.history]) {
      let directory = path.dirname(file)
      while (true) {
        this.stat(directory, true)
        if (directory === this.home) break
        directory = path.dirname(directory)
      }
    }
    const history = this.stat(this.history, true)
    const started = this.stat(this.file + '.started', true), file = this.stat(this.file)
    if (!history && !started && !file) return undefined
    if (!history || !started || !file) throw new Error('work profile reconciliation required')
    const c = JSON.parse(readFileSync(this.file, 'utf8')) as Claim
    if (
      !c || typeof c !== 'object' || Array.isArray(c)
      || Object.keys(c).sort().join(',') !== 'cacheDir,codexHome,contract,epoch,legacyProfileName,scopeId'
      || c.contract !== 'cordisx.work-usage-profile/v1'
      || [c.codexHome, c.cacheDir].some(v => typeof v !== 'string' || !path.isAbsolute(v) || path.resolve(v) !== v)
      || typeof c.legacyProfileName !== 'string' || !c.legacyProfileName || c.legacyProfileName.length > 4096
      || c.scopeId !== scope(c.codexHome, c.legacyProfileName)
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(c.epoch)
    ) throw new Error('invalid work profile claim')
    return c
  }
  private ledger(claim: Pick<Claim, 'cacheDir' | 'scopeId'>) {
    return path.join(claim.cacheDir, 'local-work-usage-v2', claim.scopeId + '.sqlite')
  }
  private ledgerIdentity(file: string): { scopeId: string; epoch: string } | undefined {
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(file, { readOnly: true })
      const row = db.prepare('SELECT value FROM ledger WHERE id=1').get()
      return row ? localUsageLedgerIdentity(row.value, path.basename(file, '.sqlite')) : undefined
    } finally {
      db?.close()
    }
  }
  current(snapshot: { readonly scopeId: string; readonly epoch: string }): boolean {
    try {
      const c = this.claim(), p = this.pinned
      if (
        this.closed || !c || !p || JSON.stringify(c) !== JSON.stringify(p)
        || c.codexHome !== realpathSync(this.options.codexHome) || c.cacheDir !== realpathSync(c.cacheDir)
        || snapshot.scopeId !== c.scopeId || snapshot.epoch !== c.epoch
      ) return false
      const row = this.ledgerIdentity(this.ledger(c))
      return row?.scopeId === c.scopeId && row.epoch === c.epoch
    } catch {
      return false
    }
  }
  read(): Promise<UsageSnapshotV1> {
    if (this.closed) return Promise.resolve(unavailable())
    return this.active ??= this.load().catch(() => unavailable()).finally(() => {
      this.active = undefined
    })
  }
  private async initialIdentity(codexHome: string) {
    const scopeId = scope(codexHome, this.options.profileName)
    const location = { scopeId, cacheDir: path.resolve(this.options.cacheDir) }
    const files = await readdir(path.dirname(this.ledger(location))).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return [] as string[]
    })
    const present = files.includes(scopeId + '.sqlite')
    const others = files.some(file => /^[a-f0-9]{64}\.sqlite$/u.test(file) && file !== scopeId + '.sqlite')
    if (others && (!present || !this.guard)) throw new Error('canonical legacy work profile required')
    const identity = present ? this.ledgerIdentity(this.ledger(location)) : undefined
    if (present && (!identity || identity.scopeId !== scopeId)) throw new Error('legacy work ledger invalid')
    if (this.guard && (!identity || this.guard.scopeId !== scopeId || this.guard.epoch !== identity.epoch)) {
      throw new Error('canonical work profile precondition failed')
    }
    return identity
  }
  /** Normal CLI preflight reads existing identity only; it does not scan or admit an anchor. */
  async preflight() {
    if (this.closed) throw new Error('work profile closed')
    const c = this.claim()
    const home = await realpath(this.options.codexHome).catch(() => undefined)
    if (this.closed) throw new Error('work profile closed')
    if (!home) {
      if (!c && !this.guard) return
      throw new Error('work profile source unavailable')
    }
    if (!c) {
      await this.initialIdentity(home)
      if (this.closed) throw new Error('work profile closed')
      return
    }
    const row = this.ledgerIdentity(this.ledger(c))
    if (
      this.closed || c.codexHome !== home || c.cacheDir !== realpathSync(c.cacheDir)
      || row?.scopeId !== c.scopeId || row.epoch !== c.epoch
      || this.guard && (this.guard.scopeId !== c.scopeId || this.guard.epoch !== c.epoch)
    ) throw new Error('work profile precondition failed')
  }
  private async flush() {
    for (const file of [this.file, this.history]) {
      let directory = path.dirname(file)
      while (true) {
        const fd = await open(directory, 'r')
        try {
          await fd.sync()
        } finally {
          await fd.close()
        }
        if (directory === this.home) break
        directory = path.dirname(directory)
      }
    }
  }
  private async load(): Promise<UsageSnapshotV1> {
    if (this.closed) throw new Error('work profile closed')
    const codexHome = await realpath(this.options.codexHome)
    if (this.closed) throw new Error('work profile closed')
    const existing = this.claim()
    if (existing) {
      if (this.guard && (existing.scopeId !== this.guard.scopeId || existing.epoch !== this.guard.epoch)) {
        throw new Error('work profile precondition failed')
      }
      if (existing.codexHome !== codexHome || this.pinned && JSON.stringify(existing) !== JSON.stringify(this.pinned)) {
        throw new Error('work profile source retired')
      }
      await this.flush()
      if (this.closed) throw new Error('work profile closed')
      this.pinned = existing
      if (!this.current(existing)) throw new Error('work profile ledger retired')
      this.reader ??= new LocalUsageHost({
        ...this.options,
        projection: 'work-v2',
        codexHome,
        cacheDir: existing.cacheDir,
        profileName: existing.legacyProfileName,
        expectedWorkIdentity: existing,
      })
      const result = await this.reader.read()
      return result.status === 'ready' && this.current(result) ? result : unavailable()
    }
    if (this.pinned) throw new Error('work profile claim lost')
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
    await mkdir(path.dirname(this.history), { recursive: true, mode: 0o700 })
    await mkdir(this.file + '.lock', { mode: 0o700 })
    try {
      if (this.claim()) return this.load()
      // A different legacy ledger is evidence of prior admission, never proof of an empty new profile.
      const identity = await this.initialIdentity(codexHome)
      if (this.closed || realpathSync(this.options.codexHome) !== codexHome) throw new Error('work profile closed')
      await mkdir(this.options.cacheDir, { recursive: true, mode: 0o700 })
      const cacheDir = await realpath(this.options.cacheDir)
      if (this.closed || realpathSync(this.options.codexHome) !== codexHome) throw new Error('work profile closed')
      this.reader = new LocalUsageHost({
        ...this.options,
        projection: 'work-v2',
        codexHome,
        cacheDir,
        ...(identity ? { expectedWorkIdentity: identity } : {}),
      })
      const result = await this.reader.read()
      if (result.status !== 'ready' || this.closed) return unavailable()
      const claim: Claim = {
        contract: 'cordisx.work-usage-profile/v1',
        codexHome,
        cacheDir,
        legacyProfileName: this.options.profileName,
        scopeId: result.scopeId,
        epoch: result.epoch,
      }
      const fresh = () => {
        if (
          this.closed || realpathSync(this.options.codexHome) !== codexHome
          || realpathSync(this.options.cacheDir) !== cacheDir
        ) throw new Error('work profile bootstrap retired')
        const stored = this.ledgerIdentity(this.ledger(claim))
        if (stored?.scopeId !== claim.scopeId || stored.epoch !== claim.epoch) {
          throw new Error('work profile bootstrap ledger retired')
        }
        if (
          !this.guard
          && readdirSync(path.dirname(this.ledger(claim))).some(file =>
            /^[a-f0-9]{64}\.sqlite$/u.test(file) && file !== claim.scopeId + '.sqlite'
          )
        ) throw new Error('canonical legacy work profile required')
      }
      fresh()
      const temporary = this.file + '.' + randomBytes(8).toString('hex')
      try {
        const fd = await open(temporary, 'wx', 0o600)
        try {
          fresh()
          await fd.writeFile(JSON.stringify(claim) + '\n')
          await fd.sync()
        } finally {
          await fd.close()
        }
        fresh()
        mkdirSync(this.history, { mode: 0o700 })
        mkdirSync(this.file + '.started', { mode: 0o700 })
        renameSync(temporary, this.file)
        await this.flush()
        fresh()
      } finally {
        try {
          unlinkSync(temporary)
        } catch {}
      }
      this.pinned = claim
      return this.current(result) ? result : unavailable()
    } finally {
      rmdirSync(this.file + '.lock')
    }
  }
  dispose() {
    this.closed = true
    this.reader?.dispose()
  }
}
