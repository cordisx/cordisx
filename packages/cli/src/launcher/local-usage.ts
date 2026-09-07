import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { constants } from 'node:fs'
import type { UsageDiagnosticV1, UsageReadySnapshotV1, UsageSnapshotV1 } from '../usage-contracts.js'
import { isUsageSourceState, reduceUsageRecords, type UsageSourceState } from './usage-reducer.js'

interface Checkpoint {
  offset: number
  digest: string
  state: UsageSourceState
  blocked?: true
}
interface Ledger {
  version: 1
  sequence: number
  scanIndex: number
  snapshot: UsageReadySnapshotV1
  sources: Record<string, Checkpoint>
}
export interface LocalUsageOptions {
  readonly codexHome: string
  readonly cacheDir: string
  readonly profileName: string
  readonly now?: () => number
  readonly maxScanBytes?: number
  readonly maxScanMs?: number
}
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const unavailable = (reason: 'store-unavailable' | 'source-unavailable'): UsageSnapshotV1 => ({
  schemaVersion: 1,
  status: 'unavailable',
  reason,
  diagnostics: [{ code: reason }],
})
function decode(value: unknown, scopeId: string): Ledger {
  if (typeof value !== 'string') throw new Error('Invalid usage ledger')
  const ledger = JSON.parse(value) as Ledger
  if (!record(ledger)) throw new Error('Invalid usage ledger')
  const snap = ledger.snapshot
  if (
    ledger.version !== 1 || !integer(ledger.sequence) || !integer(ledger.scanIndex) || !snap || snap.scopeId !== scopeId
    || snap.schemaVersion !== 1 || snap.status !== 'ready' || snap.policyId !== 'codex-local-input-output-v1'
    || snap.sourceId !== 'codex-local-rollouts-v1' || typeof snap.epoch !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(snap.epoch) || !integer(snap.revision)
    || !integer(snap.inputTokens)
    || !integer(snap.outputTokens) || !integer(snap.eligibleTokens)
    || snap.eligibleTokens !== snap.inputTokens + snap.outputTokens || !integer(snap.enabledAt)
    || !integer(snap.observedThrough) || snap.coverage !== 'partial' || snap.revision > ledger.sequence
    || Object.keys(snap).some(key =>
      ![
        'schemaVersion',
        'status',
        'scopeId',
        'sourceId',
        'epoch',
        'revision',
        'policyId',
        'eligibleTokens',
        'inputTokens',
        'outputTokens',
        'enabledAt',
        'observedThrough',
        'coverage',
        'diagnostics',
      ].includes(key)
    )
    || !Array.isArray(snap.diagnostics) || snap.diagnostics.some(item =>
      !record(item) || typeof item.code !== 'string'
      || !/^[a-z][a-z0-9-]{0,63}$/.test(item.code) || (item.count !== undefined && !integer(item.count))
      || Object.keys(item).some(key => !['code', 'count'].includes(key))
    ) || !ledger.sources || typeof ledger.sources !== 'object'
    || Array.isArray(ledger.sources) || Object.keys(ledger.sources).length > 20_000
  ) throw new Error('Invalid usage ledger')
  for (const [key, checkpoint] of Object.entries(ledger.sources)) {
    if (
      !/^[a-f0-9]{64}$/.test(key) || !record(checkpoint) || !integer(checkpoint.offset)
      || !/^[a-f0-9]{64}$/.test(checkpoint.digest) || !isUsageSourceState(checkpoint.state)
      || checkpoint.state.ownerId === null || key !== hash(checkpoint.state.ownerId)
      || (checkpoint.blocked !== undefined && checkpoint.blocked !== true)
    ) throw new Error('Invalid usage checkpoint')
  }
  return ledger
}
/** The only persisted source data are counters, source hashes and continuity checkpoints.
 * SQLite atomically commits aggregate and checkpoints; sequence CAS also fences other processes. */
export class LocalUsageHost {
  private active: Promise<UsageSnapshotV1> | undefined
  private closed = false
  constructor(private readonly options: LocalUsageOptions) {}
  dispose(): void {
    this.closed = true
  }
  read(): Promise<UsageSnapshotV1> {
    if (this.closed) return Promise.resolve(unavailable('store-unavailable'))
    if (this.active) return this.active
    this.active = this.scan().catch(() => unavailable('store-unavailable')).finally(() => {
      this.active = undefined
    })
    return this.active
  }
  private async scan(): Promise<UsageSnapshotV1> {
    const now = this.options.now ?? Date.now
    const home = await realpath(this.options.codexHome).catch(() => undefined)
    if (!home) return unavailable('source-unavailable')
    const scopeId = hash(`${home}\0${this.options.profileName}`)
    const directory = path.join(this.options.cacheDir, 'local-usage-v1')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path.join(directory, `${scopeId}.sqlite`))
    try {
      db.exec(
        'PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)',
      )
      const row = db.prepare('SELECT value FROM ledger WHERE id=1').get()
      const stamp = now()
      const ledger: Ledger = row ? decode(row.value, scopeId) : {
        version: 1,
        sequence: 0,
        scanIndex: 0,
        sources: {},
        snapshot: {
          schemaVersion: 1,
          status: 'ready',
          scopeId,
          sourceId: 'codex-local-rollouts-v1',
          epoch: randomUUID(),
          revision: 0,
          policyId: 'codex-local-input-output-v1',
          eligibleTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          enabledAt: stamp,
          observedThrough: stamp,
          coverage: 'partial',
          diagnostics: [],
        },
      }
      const expectedSequence = row ? ledger.sequence : undefined
      const diagnostics = new Map<string, number>()
      const diagnostic = (code: string, count = 1) => diagnostics.set(code, (diagnostics.get(code) ?? 0) + count)
      const maxBytes = this.options.maxScanBytes ?? 256 * 1024 * 1024
      const deadline = now() + (this.options.maxScanMs ?? 5_000)
      const files: string[] = []
      let roots = 0, bytes = 0
      const visit = async (directory: string): Promise<void> => {
        const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined)
        if (!entries) return
        for (const entry of entries) {
          if (files.length >= 20_000 || now() > deadline) {
            diagnostic('scan-budget')
            return
          }
          if (entry.isSymbolicLink()) continue
          const file = path.join(directory, entry.name)
          if (entry.isDirectory()) await visit(file)
          else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file)
        }
      }
      for (const name of ['sessions', 'archived_sessions']) {
        const root = path.join(home, name)
        const canonical = await realpath(root).catch(() => undefined)
        if (canonical !== root) continue
        roots++
        await visit(root)
      }
      if (!roots) return unavailable('source-unavailable')
      let input = 0, output = 0
      // Stable traversal prevents archive aliases from minting a second source. Continuity is owner-based.
      const seen = new Map<string, { content: Buffer; conflict: boolean }>()
      files.sort()
      const scanStart = ledger.scanIndex % Math.max(1, files.length)
      const ordered = [...files.slice(scanStart), ...files.slice(0, scanStart)]
      let attempted = 0
      for (const file of ordered) {
        // Time budgets are cooperative. Once discovery found files, attempt at least
        // one bounded read so slow directory enumeration cannot starve every scan.
        if ((now() > deadline && attempted > 0) || bytes >= maxBytes) {
          diagnostic('scan-budget')
          break
        }
        attempted++
        ledger.scanIndex = (files.indexOf(file) + 1) % Math.max(1, files.length)
        const canonical = await realpath(file).catch(() => undefined)
        if (canonical !== file) {
          diagnostic('source-read-failed')
          continue
        }
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined)
        if (!handle) {
          diagnostic('source-read-failed')
          continue
        }
        try {
          const stat = await handle.stat()
          if (!stat.isFile() || stat.size > 64 * 1024 * 1024 || stat.size > maxBytes) {
            diagnostic('scan-budget')
            continue
          }
          if (bytes + stat.size > maxBytes) {
            // Resume at the first deferred file. Advancing past it would repeatedly
            // spend the next scan's budget on the same earlier files.
            ledger.scanIndex = files.indexOf(file)
            diagnostic('scan-budget')
            break
          }
          // Bounded reads ignore concurrently appended bytes until the next observation.
          const buffer = Buffer.alloc(stat.size)
          let read = 0
          while (read < buffer.length) {
            const result = await handle.read(buffer, read, buffer.length - read, read)
            if (!result.bytesRead) break
            read += result.bytesRead
          }
          bytes += read
          const complete = buffer.subarray(0, read).lastIndexOf(10) + 1
          if (!complete) {
            diagnostic('incomplete-record')
            continue
          }
          const content = buffer.subarray(0, complete)
          const header = content.subarray(0, content.indexOf(10)).toString('utf8')
          const ownership = reduceUsageRecords(undefined, [header], { baseline: true }).state
          if (!ownership.ownerId) {
            diagnostic('missing-owner')
            continue
          }
          const key = hash(ownership.ownerId)
          const alias = seen.get(key)
          if (alias) {
            const shorter = content.length < alias.content.length ? content : alias.content
            const longer = content.length < alias.content.length ? alias.content : content
            const conflict = !longer.subarray(0, shorter.length).equals(shorter)
            diagnostic(conflict ? 'conflicting-source' : 'duplicate-source')
            seen.set(key, { content: longer, conflict: alias.conflict || conflict })
          } else seen.set(key, { content, conflict: false })
        } finally {
          await handle.close()
        }
      }
      for (const [key, candidate] of seen) {
        const { content } = candidate
        const complete = content.length
        const previous = ledger.sources[key]
        if (!previous && Object.keys(ledger.sources).length >= 20_000) {
          diagnostic('source-budget')
          continue
        }
        if (previous?.blocked) {
          diagnostic('quarantined-source')
          continue
        }
        if (candidate.conflict) {
          const checkpoint = previous
            ?? {
              offset: complete,
              digest: hash(content),
              state:
                reduceUsageRecords(undefined, content.toString('utf8').split('\n').filter(Boolean), { baseline: true })
                  .state,
            }
          ledger.sources[key] = { ...checkpoint, blocked: true }
          continue
        }
        if (previous && previous.offset > complete) {
          // A shorter archive alias cannot roll back a longer checkpoint. Retain
          // it unchanged: a future longer candidate must still prove the old digest.
          diagnostic('short-source')
          continue
        }
        const continuous = previous !== undefined && previous.offset <= complete
          && hash(content.subarray(0, previous.offset)) === previous.digest
        if (previous && !continuous) {
          diagnostic('quarantined-source')
          ledger.sources[key] = { ...previous, blocked: true }
          continue
        }
        const start = continuous ? previous.offset : 0
        const records = content.subarray(start).toString('utf8').split('\n').filter(Boolean)
        const reduced = reduceUsageRecords(continuous ? previous.state : undefined, records, { baseline: !continuous })
        for (const item of reduced.diagnostics) diagnostic(item.code, item.count)
        ledger.sources[key] = { offset: complete, digest: hash(content), state: reduced.state }
        input += reduced.increment.inputTokens
        output += reduced.increment.outputTokens
      }
      const inputTokens = ledger.snapshot.inputTokens + input, outputTokens = ledger.snapshot.outputTokens + output
      if (
        ![inputTokens, outputTokens, inputTokens + outputTokens, ledger.sequence + 1, ledger.snapshot.revision + 1]
          .every(integer)
      ) {
        return unavailable('store-unavailable')
      }
      const publicDiagnostics: UsageDiagnosticV1[] = [...diagnostics].map(([code, count]) => ({ code, count }))
      ledger.snapshot = {
        ...ledger.snapshot,
        inputTokens,
        outputTokens,
        eligibleTokens: inputTokens + outputTokens,
        revision: ledger.snapshot.revision + (input + output > 0 ? 1 : 0),
        observedThrough: Math.max(ledger.snapshot.observedThrough, now()),
        diagnostics: publicDiagnostics,
      }
      ledger.sequence++
      if (this.closed) return unavailable('store-unavailable')
      db.exec('BEGIN IMMEDIATE')
      try {
        const latest = db.prepare('SELECT value FROM ledger WHERE id=1').get()
        if (latest ? decode(latest.value, scopeId).sequence !== expectedSequence : expectedSequence !== undefined) {
          db.exec('ROLLBACK')
          return latest ? decode(latest.value, scopeId).snapshot : unavailable('store-unavailable')
        }
        db.prepare('INSERT INTO ledger(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(
          JSON.stringify(ledger),
        )
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return ledger.snapshot
    } finally {
      db.close()
    }
  }
}
