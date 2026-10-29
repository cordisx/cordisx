import { randomUUID } from 'node:crypto'
import { appendFile, chmod, link, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { type DiagnosticEvent, diagnosticRef, type DiagnosticSink } from './context.js'

export const JOURNAL_RETENTION_MS = 72 * 60 * 60 * 1000
export const JOURNAL_SEGMENT_BYTES = 8 * 1024 * 1024
export const JOURNAL_DISK_BYTES = 512 * 1024 * 1024
const HOUR = 60 * 60 * 1000
const RESERVE = 16 * 1024 * 1024
const MAX_QUEUE = 1024 * 1024
// Every field must be explicitly admitted. Payloads, headers, paths, raw errors and arbitrary env never enter this format.
const NUMBERS = new Set([
  'elapsedMs',
  'timeoutMs',
  'deadline',
  'pid',
  'hostPid',
  'debugPort',
  'exitCode',
  'statusCode',
  'count',
  'dropped',
  'bytes',
  'documentGeneration',
])
const BOOLEANS = new Set(['aborted', 'ready', 'required', 'verified', 'alreadyExited'])
const STRINGS = new Set([
  'event',
  'phase',
  'reason',
  'outcome',
  'signal',
  'ownership',
  'discovery',
  'state',
  'errorCode',
  'errorClass',
  'support',
  'version',
  'hostVersion',
  'generation',
  'serviceGeneration',
  'supervisorGeneration',
  'requestRef',
  'threadRef',
  'turnRef',
  'resourceRef',
  'pluginRef',
  'serviceRef',
  'provider',
  'model',
  'method',
])
const SAFE = /^[a-zA-Z0-9_.:@/+\-]{1,160}$/u
export function projectDiagnostic(input: DiagnosticEvent): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (NUMBERS.has(key) && (value === null || typeof value === 'number' && Number.isFinite(value))) output[key] = value
    if (BOOLEANS.has(key) && typeof value === 'boolean') output[key] = value
    if (STRINGS.has(key) && typeof value === 'string' && SAFE.test(value)) {
      if (
        ['provider', 'model'].includes(key) && (/^(?:\/|[a-zA-Z]:|sk[-_]|Bearer|eyJ[a-zA-Z0-9_-]{16})/u.test(value))
      ) output[key] = 'unknown'
      else output[key] = value
    }
  }
  return output
}
export function journalDirectory(home: string, app: string, profile: string): string {
  return path.join(home, 'diagnostics', diagnosticRef(app), diagnosticRef(profile))
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
async function privateDirectory(directory: string): Promise<void> {
  for (const target of [path.dirname(path.dirname(directory)), path.dirname(directory), directory]) {
    await mkdir(target, { recursive: true, mode: 0o700 })
    const metadata = await lstat(target)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('diagnostic-directory-invalid')
  }
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('diagnostic-directory-invalid')
  await chmod(directory, 0o700)
}
const FILE = /^(\d+)-(\d+)-([a-f0-9-]+)\.(active|sealed)\.jsonl(?:\.gz)?$/u

/** Per-process active shards; other live writers are never renamed. Closed/crashed shards are immutable. */
export async function maintainJournal(directory: string, now = Date.now()): Promise<number> {
  let diskBytes = 0
  for (const name of await readdir(directory)) {
    const match = FILE.exec(name)
    if (!match) {
      if (/^evidence-gap-\d+\.json$/u.test(name) || /\.jsonl\.[a-f0-9-]+\.tmp$/u.test(name)) {
        const auxiliary = path.join(directory, name)
        const metadata = await lstat(auxiliary).catch(() => undefined)
        if (metadata?.isFile() && !metadata.isSymbolicLink()) {
          diskBytes += metadata.size
          if (now - metadata.mtimeMs > JOURNAL_RETENTION_MS) {
            await rm(auxiliary, { force: true })
            diskBytes -= metadata.size
          }
        }
      }
      continue
    }
    const file = path.join(directory, name)
    const stat = await lstat(file).catch(() => undefined)
    if (!stat?.isFile() || stat.isSymbolicLink()) continue
    diskBytes += stat.size
    if (match[4] === 'active' && alive(Number(match[2]))) continue
    // mtime covers the final event, so no shard containing recent evidence expires early.
    if (now - Math.max(Number(match[1]), stat.mtimeMs) > JOURNAL_RETENTION_MS) {
      await rm(file, { force: true })
      diskBytes -= stat.size
      continue
    }
    if (name.endsWith('.gz')) continue
    if (stat.size > JOURNAL_SEGMENT_BYTES + 8192) continue
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const raw = await readFile(file)
      const compressed = gzipSync(raw)
      await writeFile(temporary, compressed, { flag: 'wx', mode: 0o600 })
      // Atomic exclusive publication: concurrent maintainers cannot replace one another's archives.
      await link(temporary, `${file}.gz`)
      await rm(file)
      diskBytes += compressed.length - stat.size
    } catch (error) {
      if (!['EEXIST', 'ENOENT'].includes(String((error as NodeJS.ErrnoException).code))) throw error
      // An interrupted publication may leave both copies. Validate before removing the original.
      const compressed = await readFile(`${file}.gz`).catch(() => undefined)
      if (compressed) {
        const raw = await readFile(file).catch(() => undefined)
        if (raw && gunzipSync(compressed, { maxOutputLength: JOURNAL_SEGMENT_BYTES + 8192 }).equals(raw)) {
          await rm(file, { force: true })
        }
      }
    } finally {
      await rm(temporary, { force: true })
    }
  }
  return diskBytes
}

export class LocalJournal implements DiagnosticSink {
  readonly runId = randomUUID()
  private queue = Promise.resolve()
  private queuedBytes = 0
  private dropped = 0
  private bytes = 0
  private diskBytes = 0
  private openedAt = 0
  private file: string | undefined
  private readonly metadata: Record<string, unknown> = {}
  private closed = false
  private directoryReady = false
  private warned = false
  private readonly timer: NodeJS.Timeout
  private readonly start = performance.now()
  constructor(
    private readonly options: {
      directory: string
      version: string
      launchId?: string
      now?: () => number
      segmentBytes?: number
      diskBytes?: number
      warn?: (message: string) => void
    },
  ) {
    this.timer = setInterval(() => this.enqueueMaintenance(), 60_000)
    this.timer.unref()
    this.enqueueMaintenance()
    this.emit({ event: 'run-start', support: 'native-upstream-network-timing-unsupported' })
  }
  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
  private gap(): void {
    this.dropped++
    if (this.warned) return
    this.warned = true
    if (this.directoryReady) {
      void writeFile(
        path.join(this.options.directory, `evidence-gap-${process.pid}.json`),
        JSON.stringify({ at: this.now(), event: 'diagnostic-evidence-gap', reason: 'write-queue-or-disk-limit' }),
        { mode: 0o600 },
      ).catch(() => undefined)
    }
    try {
      ;(this.options.warn ?? (message => process.stderr.write(`${message}\n`)))(
        '[cordisx] diagnostic-evidence-gap: local journal write/queue/disk limit; recent evidence may be incomplete',
      )
    } catch {}
  }
  private append(operation: () => Promise<void>): void {
    this.queue = this.queue.then(operation).catch(() => this.gap())
  }
  private enqueueMaintenance(): void {
    this.append(async () => {
      await privateDirectory(this.options.directory)
      this.directoryReady = true
      if (this.file && this.now() - this.openedAt >= HOUR) await this.seal()
      this.diskBytes = await maintainJournal(this.options.directory, this.now())
    })
  }
  emit(event: DiagnosticEvent): void {
    if (this.closed) return
    const projected = projectDiagnostic(event)
    for (const key of ['hostVersion', 'generation', 'supervisorGeneration']) {
      if (projected[key] !== undefined) this.metadata[key] = projected[key]
    }
    const record = {
      schemaVersion: 1,
      at: this.now(),
      monotonicMs: Math.round(performance.now() - this.start),
      runId: this.runId,
      launchId: this.options.launchId ?? this.runId,
      pid: process.pid,
      version: this.options.version,
      ...this.metadata,
      ...projected,
    }
    const line = `${JSON.stringify(record)}\n`
    const size = Buffer.byteLength(line)
    if (this.queuedBytes + size > MAX_QUEUE) {
      this.gap()
      return
    }
    this.queuedBytes += size
    this.append(async () => {
      try {
        const ceiling = this.options.diskBytes ?? JOURNAL_DISK_BYTES
        const critical = /failed|error|cancel|timeout|deadline|gap|exit|cleanup/u.test(event.event)
        if (this.diskBytes + size >= ceiling - (critical ? 0 : Math.min(RESERVE, ceiling / 8))) {
          this.gap()
          return
        }
        await privateDirectory(this.options.directory)
        if (
          this.file
          && (this.bytes + size > (this.options.segmentBytes ?? JOURNAL_SEGMENT_BYTES)
            || this.now() - this.openedAt >= HOUR)
        ) await this.seal()
        if (!this.file) {
          this.openedAt = this.now()
          this.file = path.join(this.options.directory, `${this.openedAt}-${process.pid}-${randomUUID()}.active.jsonl`)
          await writeFile(this.file, '', { flag: 'wx', mode: 0o600 })
        }
        const gap = this.dropped
          ? `${JSON.stringify({ ...record, event: 'evidence-gap', dropped: this.dropped })}\n`
          : ''
        await appendFile(this.file, gap + line)
        this.bytes += Buffer.byteLength(gap) + size
        this.diskBytes += Buffer.byteLength(gap) + size
        this.dropped = 0
        this.warned = false
      } finally {
        this.queuedBytes -= size
      }
    })
  }
  private async seal(): Promise<void> {
    if (!this.file) return
    const file = this.file
    await rename(file, file.replace('.active.', '.sealed.'))
    this.file = undefined
    this.bytes = 0
  }
  async flush(): Promise<void> {
    await this.queue
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.emit({ event: 'run-end' })
    this.closed = true
    clearInterval(this.timer)
    this.append(async () => {
      await this.seal()
      this.diskBytes = await maintainJournal(this.options.directory, this.now())
    })
    await this.queue
  }
}

export async function readJournal(
  directory: string,
  input: { from: number; until: number; maxBytes: number; maxEvents?: number; launchId?: string },
): Promise<{ text: string; truncated: boolean }> {
  const lines: string[] = []
  let bytes = 0, truncated = false
  const names = await readdir(directory).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  // Newest first gives recent failures priority under the explicit export bound.
  for (const name of names.filter(name => FILE.test(name) || /^evidence-gap-\d+\.json$/u.test(name)).sort().reverse()) {
    const file = path.join(directory, name)
    const stat = await lstat(file).catch(() => undefined)
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > JOURNAL_SEGMENT_BYTES + 8192) {
      truncated = true
      continue
    }
    if (stat.mtimeMs < input.from || (FILE.exec(name) !== null && Number(FILE.exec(name)![1]) > input.until)) continue
    let source: Buffer
    try {
      const raw = await readFile(file)
      source = name.endsWith('.gz') ? gunzipSync(raw, { maxOutputLength: JOURNAL_SEGMENT_BYTES + 8192 }) : raw
    } catch {
      truncated = true
      continue
    }
    for (const line of source.toString('utf8').split('\n').reverse()) {
      if (!line) continue
      let event: Record<string, unknown>
      try {
        event = JSON.parse(line)
      } catch {
        truncated = true
        continue
      }
      if (
        typeof event.at !== 'number' || event.at < input.from || event.at > input.until
        || input.launchId && event.launchId !== input.launchId
      ) continue
      if (bytes + Buffer.byteLength(line) + 1 > input.maxBytes || lines.length >= (input.maxEvents ?? 2000)) {
        truncated = true
        break
      }
      lines.push(line)
      bytes += Buffer.byteLength(line) + 1
    }
    if (truncated && bytes >= input.maxBytes) break
  }
  return { text: lines.reverse().join('\n') + (lines.length ? '\n' : ''), truncated }
}
