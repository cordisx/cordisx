import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { bindChannelPluginContext, CordisXChannelService } from './cordis-service.js'
import type { ChannelPluginIdentity } from './types.js'
import { ChannelRuntime } from './runtime.js'
import type { ChannelServiceConfigurationDeclaration } from './config.js'

const MAX_SERVICE_MODULE_BYTES = 8 * 1024 * 1024

export interface LauncherChannelServiceModuleAccess {
  readonly packageIdentity: {
    readonly pluginId: string
    readonly version: string
    readonly integrity: `sha256:${string}`
  }
  readonly pluginIdentity: ChannelPluginIdentity
  readonly serviceId: string
  readonly serviceKind: 'channel-adapter'
  readonly configuration: ChannelServiceConfigurationDeclaration
  readonly artifactDirectory: string
  /** Authority-projected bounded module path; built-ins may live at package root. */
  readonly runtimeEntry: `./${string}.mjs`
}

export interface LauncherChannelServiceModule {
  readonly name?: string
  readonly inject?: readonly string[] | Readonly<Record<string, unknown>>
  readonly apply: (ctx: Context, config: unknown) => unknown
}

export interface ActiveLauncherChannelService {
  readonly identity: ChannelPluginIdentity
  readonly serviceId: string
  dispose(): Promise<void>
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function pluginFromModule(value: unknown): LauncherChannelServiceModule {
  if (value === null || typeof value !== 'object') throw new Error('Channel service module namespace is invalid')
  const namespace = value as Record<string, unknown>
  const candidate = typeof namespace.apply === 'function'
    ? namespace
    : namespace.default !== null && typeof namespace.default === 'object'
      ? namespace.default as Record<string, unknown>
      : undefined
  if (candidate === undefined || typeof candidate.apply !== 'function') {
    throw new Error('Channel service module must export apply() or a default Cordis plugin object')
  }
  if (candidate.name !== undefined && typeof candidate.name !== 'string') {
    throw new Error('Channel service module name must be a string')
  }
  if (candidate.inject !== undefined && !Array.isArray(candidate.inject)
    && (candidate.inject === null || typeof candidate.inject !== 'object')) {
    throw new Error('Channel service module inject declaration is invalid')
  }
  return Object.freeze({
    ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
    ...(candidate.inject === undefined ? {} : {
      inject: candidate.inject as readonly string[] | Readonly<Record<string, unknown>>,
    }),
    apply: candidate.apply as LauncherChannelServiceModule['apply'],
  })
}

/** Import only the authority-projected immutable Node service artifact. */
export async function loadLauncherChannelServiceModule(
  access: LauncherChannelServiceModuleAccess,
): Promise<LauncherChannelServiceModule> {
  if (access.serviceKind !== 'channel-adapter'
    || !/^\.\/(?:services\/)?[a-z0-9][a-z0-9._-]{0,95}\.mjs$/.test(access.runtimeEntry)
    || !path.isAbsolute(access.artifactDirectory)) {
    throw new Error('Channel service module projection is invalid')
  }
  const root = await realpath(access.artifactDirectory)
  const entry = await realpath(path.resolve(root, access.runtimeEntry))
  if (!inside(root, entry)) throw new Error('Channel service module entry escapes its immutable artifact directory')
  const metadata = await stat(entry)
  if (!metadata.isFile() || metadata.size > MAX_SERVICE_MODULE_BYTES) {
    throw new Error('Channel service module entry is not a bounded regular file')
  }
  const source = await readFile(entry, 'utf8')
  if (source.includes('sourceMappingURL=')) throw new Error('Channel service module must not load an external source map')
  return pluginFromModule(await import(`${pathToFileURL(entry).href}?integrity=${access.packageIdentity.integrity}`))
}

/**
 * Node-only Cordis composition host. The renderer never receives the root
 * Context, imported namespace, runtime, adapter connection, or configuration.
 */
export class LauncherChannelServiceHost {
  readonly #root = new Context()
  readonly #active = new Set<Fiber>()
  #disposed = false

  constructor(readonly runtime: ChannelRuntime) {
    new CordisXChannelService(this.#root, runtime)
  }

  async activate(
    access: LauncherChannelServiceModuleAccess,
    configuration?: unknown,
  ): Promise<ActiveLauncherChannelService> {
    if (this.#disposed) throw new Error('Channel service host is disposed')
    if (access.pluginIdentity.pluginId !== access.packageIdentity.pluginId
      || access.pluginIdentity.source.length < 1
      || access.pluginIdentity.generation.length < 1) {
      throw new Error('Channel service identity is not bound to its authority projection')
    }
    if (access.configuration.kind === 'none' && configuration !== undefined) {
      throw new Error('A no-configuration Channel service cannot receive configuration')
    }
    if (access.configuration.kind === 'host' && configuration === undefined) {
      throw new Error('Channel service Host configuration is required')
    }
    const module = await loadLauncherChannelServiceModule(access)
    const context = bindChannelPluginContext(this.#root, access.pluginIdentity)
    const fiber = context.plugin(module as Plugin.Object, configuration)
    await fiber
    this.#active.add(fiber)
    let disposed = false
    return Object.freeze({
      identity: access.pluginIdentity,
      serviceId: access.serviceId,
      dispose: async () => {
        if (disposed) return
        disposed = true
        this.#active.delete(fiber)
        await fiber.dispose()
      },
    })
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    const active = [...this.#active]
    this.#active.clear()
    await Promise.all(active.map(async fiber => await fiber.dispose()))
    await this.runtime.dispose()
  }
}
