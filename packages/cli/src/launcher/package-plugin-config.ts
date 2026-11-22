import { constants } from 'node:fs'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { JsonValue } from '../config/home-config.js'
import { PluginConfigConflictError } from '../config/plugin-config.js'
import { fencePackageProfileWrite, ProfilePluginConfigFenceBusyError } from '../config/profile-plugin-config-fence.js'

interface Candidate {
  readonly revision: number
  readonly config: JsonValue
  readonly ownerToken: string
  readonly generation: string
  readonly createdAt: string
}

interface State {
  readonly version: 1
  readonly pluginId: string
  readonly revision: number
  readonly config: JsonValue
  readonly candidate?: Candidate
}

const queues = new Map<string, Promise<void>>()

function jsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${label}[${index}]`))
  if (value === null || typeof value !== 'object') throw new Error(`${label} is not JSON-compatible`)
  const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = jsonValue(item, `${label}.${key}`)
  }
  return output
}

async function publishAtomic(filePath: string, value: State): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  let published = false
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    await rename(temporary, filePath)
    published = true
  } finally {
    await handle.close().catch(() => undefined)
    if (!published) await unlink(temporary).catch(() => undefined)
  }
}

export class PackagePluginConfigStore {
  constructor(
    private readonly root: string,
    private readonly profileId: string,
    private readonly generation: string,
  ) {}

  private file(pluginId: string): string {
    if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(pluginId)) throw new Error('package plugin config id is invalid')
    return path.join(this.root, 'state', 'profiles', this.profileId, 'plugins', 'config', `${pluginId}.json`)
  }

  async load(pluginId: string): Promise<{ readonly revision: number; readonly config: JsonValue }> {
    const filePath = this.file(pluginId)
    return await this.serial(filePath, async () => {
      let state = await this.readState(pluginId)
      if (state.candidate !== undefined && state.candidate.generation !== this.generation) {
        let release: () => Promise<void>
        try {
          release = await fencePackageProfileWrite(this.root, this.profileId, pluginId)
        } catch (error) {
          // A live Manager can still read last-good state, but cannot erase an unconfirmed candidate.
          if (error instanceof ProfilePluginConfigFenceBusyError) {
            return { revision: state.revision, config: state.config }
          }
          throw error
        }
        try {
          state = await this.readState(pluginId)
          if (state.candidate !== undefined && state.candidate.generation !== this.generation) {
            state = { version: 1, pluginId, revision: state.revision, config: state.config }
            await publishAtomic(filePath, state)
          }
        } finally {
          await release()
        }
      }
      return { revision: state.revision, config: state.config }
    })
  }

  /** Manager admission cannot accept an in-flight candidate as a settled snapshot. */
  async loadStable(pluginId: string): Promise<{ readonly revision: number; readonly config: JsonValue }> {
    const filePath = this.file(pluginId)
    return await this.serial(filePath, async () => {
      const state = await this.readState(pluginId, true)
      if (state.candidate !== undefined) throw new Error('package plugin configuration candidate is pending')
      return { revision: state.revision, config: state.config }
    })
  }

  private async readState(pluginId: string, strict = false): Promise<State> {
    const filePath = this.file(pluginId)
    let raw: unknown
    try {
      let text: string
      if (strict) {
        const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const info = await handle.stat()
          if (
            !info.isFile() || info.nlink !== 1 || info.size > 8 * 1024 * 1024
            || process.geteuid !== undefined && info.uid !== process.geteuid()
            || process.platform !== 'win32' && (info.mode & 0o077) !== 0
          ) throw new Error('package plugin config state is unavailable')
          text = await handle.readFile('utf8')
        } finally {
          await handle.close()
        }
      } else text = await readFile(filePath, 'utf8')
      raw = JSON.parse(text) as unknown
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, pluginId, revision: 0, config: {} }
      }
      throw error
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('package plugin config state is invalid')
    }
    const record = raw as Partial<State>
    if (
      record.version !== 1 || record.pluginId !== pluginId || !Number.isInteger(record.revision)
      || (record.revision as number) < 0
    ) {
      throw new Error('package plugin config state is invalid')
    }
    const config = jsonValue(record.config, 'package plugin config')
    if (record.candidate !== undefined && (record.candidate === null || typeof record.candidate !== 'object')) {
      throw new Error('package plugin config candidate is invalid')
    }
    return {
      version: 1,
      pluginId,
      revision: record.revision as number,
      config,
      ...(record.candidate === undefined ? {} : { candidate: record.candidate }),
    }
  }

  stage(
    pluginId: string,
    expectedRevision: number,
    config: JsonValue,
    ownerToken: string,
  ): Promise<{ readonly candidateRevision: number }> {
    return this.update(pluginId, async state => {
      if (state.revision !== expectedRevision || state.candidate !== undefined) {
        throw new PluginConfigConflictError(state.revision)
      }
      const candidateRevision = expectedRevision + 1
      return {
        state: {
          ...state,
          candidate: {
            revision: candidateRevision,
            config,
            ownerToken,
            generation: this.generation,
            createdAt: new Date().toISOString(),
          },
        },
        result: { candidateRevision },
      }
    })
  }

  commit(
    pluginId: string,
    candidateRevision: number,
    ownerToken: string,
  ): Promise<{ readonly revision: number; readonly config: JsonValue }> {
    return this.update(pluginId, async state => {
      const candidate = state.candidate
      if (
        candidate === undefined || candidate.revision !== candidateRevision
        || candidate.ownerToken !== ownerToken || candidate.generation !== this.generation
      ) {
        throw new PluginConfigConflictError(
          state.revision,
          'package plugin config candidate is not owned by this generation',
        )
      }
      return {
        state: { version: 1, pluginId, revision: candidate.revision, config: candidate.config },
        result: { revision: candidate.revision, config: candidate.config },
      }
    })
  }

  abort(pluginId: string, candidateRevision: number, ownerToken: string): Promise<void> {
    return this.update(pluginId, async state => {
      const candidate = state.candidate
      if (candidate === undefined) return { state, result: undefined }
      if (
        candidate.revision !== candidateRevision || candidate.ownerToken !== ownerToken
        || candidate.generation !== this.generation
      ) {
        throw new PluginConfigConflictError(
          state.revision,
          'package plugin config candidate is not owned by this generation',
        )
      }
      return { state: { version: 1, pluginId, revision: state.revision, config: state.config }, result: undefined }
    })
  }

  private async update<T>(
    pluginId: string,
    operation: (state: State) => Promise<{ readonly state: State; readonly result: T }>,
  ): Promise<T> {
    const filePath = this.file(pluginId)
    return await this.serial(filePath, async () => {
      const release = await fencePackageProfileWrite(this.root, this.profileId, pluginId)
      try {
        const loaded = await this.readState(pluginId)
        const state: State = loaded.candidate !== undefined && loaded.candidate.generation !== this.generation
          ? { version: 1, pluginId, revision: loaded.revision, config: loaded.config }
          : loaded
        const next = await operation(state)
        await publishAtomic(filePath, next.state)
        return next.result
      } finally {
        await release()
      }
    })
  }

  private async serial<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(filePath) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => {
      release = resolve
    })
    const tail = previous.catch(() => undefined).then(() => current)
    queues.set(filePath, tail)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (queues.get(filePath) === tail) queues.delete(filePath)
    }
  }
}
