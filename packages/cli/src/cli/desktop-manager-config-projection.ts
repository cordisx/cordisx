import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { CordisXConfigPlugin } from '../launcher/config.js'
import type { DesktopManagerConfigProof } from '../launcher/renderer-config-management.js'
import {
  assertPath,
  hasOwnPath,
  isReservedConfigRole,
  ownValue,
  pathStartsWith,
  removePaths,
  setAtPath,
} from '../renderer/configuration/values.js'
import type { ServiceRendererSnapshot } from './service-renderer-bootstrap-state.js'

function normalized(value: unknown): unknown {
  const json = JSON.stringify(value)
  if (json === undefined || Buffer.byteLength(json) > 1_048_576) {
    throw new Error('desktop-manager-config-unavailable')
  }
  return JSON.parse(json) as unknown
}

/** Keep only declared, non-sensitive scalar fields from a verified native configuration. */
export function projectDesktopManagerConfig(
  snapshot: ServiceRendererSnapshot,
  plugin: CordisXConfigPlugin,
  proof: DesktopManagerConfigProof,
): unknown {
  const active = snapshot.active.plugins.find(item => item.id === plugin.id)
  const item = proof?.plugin
  const config = item?.configuration
  if (
    !active || !plugin.package || !item?.package || !config
    || !isDeepStrictEqual(normalized(proof.snapshot), normalized(snapshot))
    || item.id !== plugin.id || item.source !== plugin.source
    || item.package.version !== active.version || item.package.digest !== active.digest
    || item.package.moduleGeneration !== active.moduleGeneration
    || item.package.canonicalSource !== active.canonicalSource
    || !isDeepStrictEqual(item.package.dependencies, active.dependencies.map(dependency => dependency.id))
    || plugin.package.digest !== active.digest || plugin.package.moduleGeneration !== active.moduleGeneration
    || config.namespace !== plugin.id || config.schemaKind !== 'schemastery'
    || config.revision !== plugin.revision || config.lastGoodRevision !== config.revision
    || !Array.isArray(config.fields) || config.fields.length > 256
    || !Array.isArray(config.secrets) || config.secrets.length > 256
  ) throw new Error('desktop-manager-config-unavailable')
  const secretPaths = config.secrets.map(secret => {
    assertPath(secret.path)
    return secret.path
  })
  const redacted = normalized(removePaths(plugin.config, secretPaths))
  if (!isDeepStrictEqual(redacted, normalized(config.value))) throw new Error('desktop-manager-config-unavailable')
  let result: unknown = {}
  const seen = new Set<string>()
  for (const field of config.fields) {
    assertPath(field.path)
    const key = JSON.stringify(field.path)
    if (seen.has(key)) throw new Error('desktop-manager-config-unavailable')
    seen.add(key)
    const sensitive = field.role !== undefined && isReservedConfigRole(field.role)
      || secretPaths.some(path => pathStartsWith(field.path, path) || pathStartsWith(path, field.path))
    if (sensitive || !hasOwnPath(redacted, field.path)) continue
    const value = ownValue(redacted, field.path)
    if (
      !['string', 'number', 'natural', 'boolean', 'const', 'union'].includes(field.type)
      || value !== null && !['string', 'number', 'boolean'].includes(typeof value)
      || typeof value === 'number' && !Number.isFinite(value)
    ) throw new Error('desktop-manager-config-unavailable')
    result = setAtPath(result, field.path, value, false)
  }
  if (!isDeepStrictEqual(normalized(result), redacted)) throw new Error('desktop-manager-config-unavailable')
  return normalized(result)
}

/** Cache only redacted values while the same Desktop seat and profile inputs remain fenced. */
export class DesktopManagerConfigProjection {
  private epoch = 0
  private boundSeat: symbol | undefined
  private readonly cache = new Map<string, unknown>()
  private readonly pending = new Map<string, Promise<unknown>>()
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly input: {
      readonly current: (snapshot: ServiceRendererSnapshot) => boolean
      readonly seat: () => symbol | undefined
      readonly read: (pluginId: string) => Promise<DesktopManagerConfigProof | undefined>
    },
  ) {}

  get hasValues(): boolean {
    return this.cache.size !== 0 || this.pending.size !== 0
  }

  async project(snapshot: ServiceRendererSnapshot, plugin: CordisXConfigPlugin): Promise<unknown> {
    const seat = this.input.seat()
    if (seat === undefined || !this.input.current(snapshot)) throw new Error('desktop-manager-config-unavailable')
    if (this.boundSeat !== seat) {
      this.clear()
      this.boundSeat = seat
    }
    const epoch = this.epoch
    const current = () => epoch === this.epoch && this.input.seat() === seat && this.input.current(snapshot)
    const key = createHash('sha256').update(
      JSON.stringify([snapshot, plugin.id, plugin.package, plugin.revision, plugin.config]),
    )
      .digest('hex')
    if (this.cache.has(key)) return structuredClone(this.cache.get(key))
    const existing = this.pending.get(key)
    if (existing) {
      const value = await existing
      if (!current()) throw new Error('desktop-manager-config-unavailable')
      return structuredClone(value)
    }
    const task = this.queue.then(async () => {
      if (!current()) throw new Error('desktop-manager-config-unavailable')
      const proof = await this.input.read(plugin.id)
      if (!proof || !current()) {
        throw new Error('desktop-manager-config-unavailable')
      }
      const projected = projectDesktopManagerConfig(snapshot, plugin, proof)
      if (this.cache.size >= 256) this.cache.clear()
      this.cache.set(key, projected)
      return projected
    })
    this.pending.set(key, task)
    this.queue = task.then(() => undefined, () => undefined)
    try {
      return structuredClone(await task)
    } finally {
      if (this.pending.get(key) === task) this.pending.delete(key)
    }
  }

  clear(): void {
    this.epoch++
    this.boundSeat = undefined
    this.cache.clear()
    this.pending.clear()
  }
}
