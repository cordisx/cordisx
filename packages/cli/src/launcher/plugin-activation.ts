import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationItemV1,
  type CordisXPluginActivationRecordV1,
  type CordisXPluginDependencyV1,
} from '../plugin-lifecycle-contracts.js'

const ID = /^[a-z0-9][a-z0-9._-]{0,95}$/
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const VERSION =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const DIGEST = /^sha256:[a-f0-9]{64}$/

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  const unknown = Object.keys(value).find(key => !allowed.has(key))
  if (unknown !== undefined) throw new Error(`${label} contains unknown field ${unknown}`)
}

function checkedString(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid`)
  return value
}

function revision(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`)
  return value as number
}

function dependency(value: unknown, label: string): CordisXPluginDependencyV1 {
  const raw = object(value, label)
  exactKeys(raw, ['id', 'version'], label)
  return {
    id: checkedString(raw.id, ID, `${label}.id`),
    version: checkedString(raw.version, VERSION, `${label}.version`),
  }
}

function activationItem(value: unknown, label: string): CordisXPluginActivationItemV1 {
  const raw = object(value, label)
  exactKeys(raw, ['id', 'version', 'digest', 'moduleGeneration', 'enabled', 'dependencies', 'canonicalSource'], label)
  if (typeof raw.enabled !== 'boolean') throw new Error(`${label}.enabled must be a boolean`)
  if (!Array.isArray(raw.dependencies) || raw.dependencies.length > 32) {
    throw new Error(`${label}.dependencies is invalid`)
  }
  let canonicalSource: string | undefined
  if (raw.canonicalSource !== undefined) {
    if (typeof raw.canonicalSource !== 'string') throw new Error(`${label}.canonicalSource is invalid`)
    const url = new URL(raw.canonicalSource)
    if (url.protocol !== 'https:' || url.search !== '' || url.hash !== '') {
      throw new Error(`${label}.canonicalSource is invalid`)
    }
    canonicalSource = raw.canonicalSource
  }
  return {
    id: checkedString(raw.id, ID, `${label}.id`),
    version: checkedString(raw.version, VERSION, `${label}.version`),
    digest: checkedString(raw.digest, DIGEST, `${label}.digest`) as `sha256:${string}`,
    moduleGeneration: checkedString(raw.moduleGeneration, GENERATION, `${label}.moduleGeneration`),
    enabled: raw.enabled,
    dependencies: raw.dependencies.map((item, index) => dependency(item, `${label}.dependencies[${index}]`)),
    ...(canonicalSource === undefined ? {} : { canonicalSource }),
  }
}

/** Strict parser used for every durable readback. */
export function normalizePluginActivation(value: unknown): CordisXPluginActivationRecordV1 {
  const raw = object(value, 'activation')
  exactKeys(raw, [
    '$schema',
    'schemaVersion',
    'recordKind',
    'transactionId',
    'profileId',
    'revision',
    'lastGoodRevision',
    'runtimeGeneration',
    'plugins',
  ], 'activation')
  if (raw.$schema !== CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 || raw.schemaVersion !== 1) {
    throw new Error('activation schema is unsupported')
  }
  if (raw.recordKind !== 'active' && raw.recordKind !== 'candidate' && raw.recordKind !== 'last-good') {
    throw new Error('activation.recordKind is unsupported')
  }
  if (raw.recordKind === 'candidate' && typeof raw.transactionId !== 'string') {
    throw new Error('candidate activation requires transactionId')
  }
  if (raw.recordKind !== 'candidate' && raw.transactionId !== undefined) {
    throw new Error('only candidate activation may contain transactionId')
  }
  if (!Array.isArray(raw.plugins) || raw.plugins.length > 256) throw new Error('activation.plugins is invalid')
  const normalized: CordisXPluginActivationRecordV1 = {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: raw.recordKind,
    ...(raw.recordKind === 'candidate'
      ? { transactionId: checkedString(raw.transactionId, GENERATION, 'activation.transactionId') }
      : {}),
    profileId: checkedString(raw.profileId, ID, 'activation.profileId'),
    revision: revision(raw.revision, 'activation.revision'),
    lastGoodRevision: revision(raw.lastGoodRevision, 'activation.lastGoodRevision'),
    runtimeGeneration: checkedString(raw.runtimeGeneration, GENERATION, 'activation.runtimeGeneration'),
    plugins: raw.plugins.map((item, index) => activationItem(item, `activation.plugins[${index}]`)),
  }
  if (normalized.lastGoodRevision > normalized.revision) throw new Error('activation.lastGoodRevision exceeds revision')
  validatePluginActivationGraph(normalized.plugins)
  return normalized
}

/** Reject duplicate, missing, incompatible, disabled, and cyclic dependency graphs. */
export function validatePluginActivationGraph(plugins: readonly CordisXPluginActivationItemV1[]): void {
  const byId = new Map<string, CordisXPluginActivationItemV1>()
  for (const plugin of plugins) {
    if (byId.has(plugin.id)) throw new Error(`duplicate plugin activation: ${plugin.id}`)
    byId.set(plugin.id, plugin)
    const dependencies = new Set<string>()
    for (const item of plugin.dependencies) {
      if (item.id === plugin.id) throw new Error(`plugin ${plugin.id} depends on itself`)
      if (dependencies.has(item.id)) throw new Error(`plugin ${plugin.id} has duplicate dependency ${item.id}`)
      dependencies.add(item.id)
    }
  }
  for (const plugin of plugins) {
    for (const dependency of plugin.dependencies) {
      const target = byId.get(dependency.id)
      if (target === undefined) throw new Error(`plugin ${plugin.id} requires missing dependency ${dependency.id}`)
      if (target.version !== dependency.version) {
        throw new Error(`plugin ${plugin.id} requires ${dependency.id}@${dependency.version}, found ${target.version}`)
      }
      if (plugin.enabled && !target.enabled) {
        throw new Error(`enabled plugin ${plugin.id} depends on disabled ${dependency.id}`)
      }
    }
  }
  topologicalPluginOrder(plugins)
}

/** Dependencies precede dependents; throws on a cycle. */
export function topologicalPluginOrder(plugins: readonly CordisXPluginActivationItemV1[]): readonly string[] {
  const byId = new Map(plugins.map(plugin => [plugin.id, plugin]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const result: string[] = []
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`plugin dependency cycle contains ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependencies ?? []) {
      if (byId.has(dependency.id)) visit(dependency.id)
    }
    visiting.delete(id)
    visited.add(id)
    result.push(id)
  }
  for (const id of [...byId.keys()].sort()) visit(id)
  return result
}

/** Target plus every direct and transitive dependent in dependency-first order. */
export function pluginDependentClosure(
  plugins: readonly CordisXPluginActivationItemV1[],
  targetId: string,
): readonly string[] {
  const byId = new Map(plugins.map(plugin => [plugin.id, plugin]))
  if (!byId.has(targetId)) return []
  const closure = new Set([targetId])
  let changed = true
  while (changed) {
    changed = false
    for (const plugin of plugins) {
      if (closure.has(plugin.id) || !plugin.dependencies.some(dependency => closure.has(dependency.id))) continue
      closure.add(plugin.id)
      changed = true
    }
  }
  return topologicalPluginOrder(plugins).filter(id => closure.has(id))
}

async function syncDirectory(directory: string): Promise<void> {
  let handle
  try {
    handle = await open(directory, constants.O_RDONLY)
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR' && code !== 'EPERM') throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function publishAtomic(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(directory, 0o700)
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  let published = false
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    await rename(temporary, filePath)
    published = true
    if (process.platform !== 'win32') await chmod(filePath, 0o600)
    await syncDirectory(directory)
  } finally {
    await handle.close().catch(() => undefined)
    if (!published) await unlink(temporary).catch(() => undefined)
  }
}

async function readActivation(filePath: string): Promise<CordisXPluginActivationRecordV1> {
  const metadata = await lstat(filePath)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('plugin activation target must be a regular file')
  }
  return normalizePluginActivation(JSON.parse(await readFile(filePath, 'utf8')) as unknown)
}

export class PluginActivationStore {
  readonly root: string

  constructor(
    readonly homeDir: string,
    readonly profileId: string,
    readonly runtimeGeneration: string,
  ) {
    checkedString(profileId, ID, 'profileId')
    checkedString(runtimeGeneration, GENERATION, 'runtimeGeneration')
    this.root = path.join(homeDir, 'state', 'profiles', profileId, 'plugins')
  }

  private get activePath(): string {
    return path.join(this.root, 'active.json')
  }

  private candidatePath(transactionId: string): string {
    return path.join(this.root, 'candidates', `${checkedString(transactionId, GENERATION, 'transactionId')}.json`)
  }

  async loadActive(): Promise<CordisXPluginActivationRecordV1> {
    try {
      const record = await readActivation(this.activePath)
      if (record.recordKind !== 'active') throw new Error('active plugin activation has the wrong recordKind')
      if (record.profileId !== this.profileId) throw new Error('active plugin activation profile is stale')
      return record
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return {
        $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
        schemaVersion: 1,
        recordKind: 'active',
        profileId: this.profileId,
        revision: 0,
        lastGoodRevision: 0,
        runtimeGeneration: this.runtimeGeneration,
        plugins: [],
      }
    }
  }

  /** Rebind a durable package set to the freshly created Host runtime generation. */
  async bindRuntimeGeneration(): Promise<CordisXPluginActivationRecordV1> {
    const active = await this.loadActive()
    if (active.runtimeGeneration === this.runtimeGeneration) return active
    const rebound = normalizePluginActivation({ ...active, runtimeGeneration: this.runtimeGeneration })
    await publishAtomic(this.activePath, rebound)
    return await readActivation(this.activePath)
  }

  async writeCandidate(record: CordisXPluginActivationRecordV1): Promise<void> {
    const normalized = normalizePluginActivation(record)
    if (normalized.recordKind !== 'candidate' || normalized.transactionId === undefined) {
      throw new Error('candidate record is required')
    }
    if (normalized.profileId !== this.profileId || normalized.runtimeGeneration !== this.runtimeGeneration) {
      throw new Error('candidate activation scope is stale')
    }
    const active = await this.loadActive()
    if (normalized.lastGoodRevision !== active.revision || normalized.revision !== active.revision + 1) {
      throw new Error('candidate activation revision is stale')
    }
    await publishAtomic(this.candidatePath(normalized.transactionId), normalized)
  }

  async loadCandidate(transactionId: string): Promise<CordisXPluginActivationRecordV1> {
    const record = await readActivation(this.candidatePath(transactionId))
    if (record.recordKind !== 'candidate' || record.transactionId !== transactionId) {
      throw new Error('candidate activation identity is stale')
    }
    if (record.profileId !== this.profileId || record.runtimeGeneration !== this.runtimeGeneration) {
      throw new Error('candidate activation scope is stale')
    }
    return record
  }

  async commitCandidate(transactionId: string): Promise<CordisXPluginActivationRecordV1> {
    const [active, candidate] = await Promise.all([this.loadActive(), this.loadCandidate(transactionId)])
    if (candidate.lastGoodRevision !== active.revision || candidate.revision !== active.revision + 1) {
      throw new Error('candidate activation revision is stale')
    }
    const lastGood: CordisXPluginActivationRecordV1 = {
      ...active,
      recordKind: 'last-good',
    }
    await publishAtomic(path.join(this.root, 'history', `${active.revision}.json`), lastGood)
    const committed: CordisXPluginActivationRecordV1 = {
      ...candidate,
      recordKind: 'active',
      lastGoodRevision: candidate.revision,
    }
    delete (committed as { transactionId?: string }).transactionId
    const normalized = normalizePluginActivation(committed)
    await publishAtomic(this.activePath, normalized)
    const readback = await readActivation(this.activePath)
    if (readback.revision !== candidate.revision) throw new Error('plugin activation readback failed')
    await unlink(this.candidatePath(transactionId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    return readback
  }

  async abortCandidate(transactionId: string): Promise<void> {
    const source = this.candidatePath(transactionId)
    const destination = path.join(this.root, 'aborted', `${transactionId}.json`)
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    await rename(source, destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }

  async loadLastGood(revision: number): Promise<CordisXPluginActivationRecordV1> {
    const record = await readActivation(path.join(this.root, 'history', `${revision}.json`))
    if (record.recordKind !== 'last-good' || record.profileId !== this.profileId) {
      throw new Error('last-good plugin activation is stale')
    }
    return record
  }

  async listCandidates(): Promise<readonly CordisXPluginActivationRecordV1[]> {
    const directory = path.join(this.root, 'candidates')
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    return await Promise.all(
      entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(entry => readActivation(path.join(directory, entry.name))),
    )
  }

  async listLastGood(): Promise<readonly CordisXPluginActivationRecordV1[]> {
    const directory = path.join(this.root, 'history')
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    return await Promise.all(
      entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(entry => readActivation(path.join(directory, entry.name))),
    )
  }

  async releaseLastGood(revision: number): Promise<void> {
    await unlink(path.join(this.root, 'history', `${revision}.json`)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }

  /** CAS-publish a monotonic active record containing the last-good closure. */
  async restoreLastGood(
    expectedAfterRevision: number,
    lastGood: CordisXPluginActivationRecordV1,
  ): Promise<CordisXPluginActivationRecordV1> {
    const active = await this.loadActive()
    if (active.revision !== expectedAfterRevision && active.revision !== lastGood.revision) {
      throw new Error('rollback active revision is stale')
    }
    const restored = normalizePluginActivation({
      ...lastGood,
      recordKind: 'active',
      revision: Math.max(active.revision, expectedAfterRevision) + 1,
      lastGoodRevision: lastGood.revision,
      runtimeGeneration: this.runtimeGeneration,
    })
    await publishAtomic(this.activePath, restored)
    return await readActivation(this.activePath)
  }

  /** Move every incomplete candidate out of the live candidate namespace. */
  async recoverIncompleteCandidates(): Promise<readonly string[]> {
    const directory = path.join(this.root, 'candidates')
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const recovered: string[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const transactionId = entry.name.slice(0, -'.json'.length)
      await this.abortCandidate(transactionId)
      recovered.push(transactionId)
    }
    return recovered
  }
}
