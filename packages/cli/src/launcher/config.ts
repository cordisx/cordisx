import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProviderConfigs } from '../providers/config.js'
import type { CliProxyProviderConfig } from '../providers/contracts.js'
import {
  CLI_PROXY_PROVIDER_RUNTIME_CONFIG_INITIAL,
  CLI_PROXY_PROVIDER_RUNTIME_SERVICE_ID,
  CLI_PROXY_PROVIDER_STARTUP_CONFIG_INITIAL,
  CLI_PROXY_PROVIDER_STARTUP_SERVICE_ID,
  parseCliProxyProviderRuntimeConfig,
  parseCliProxyProviderStartupConfig,
  resolveCliProxyProviderConfigs,
} from '../plugins/cli-proxy-api/service-config.js'
import type { CordisXPluginDependencyV1 } from '../plugin-lifecycle-contracts.js'
import type { CordisXLocalDevelopmentSnapshot } from '../local-development-contracts.js'
import type { CordisXPluginManifestV1 } from '../platform-contracts.js'
import type { CordisXPluginManifestV4, CordisXPluginManifestV5, CordisXPluginManifestV6 } from '../permission-contracts.js'

export interface CordisXConfigPlugin {
  readonly id: string
  readonly entry: string
  readonly enabled: boolean
  readonly config: unknown
  readonly revision?: number
  readonly source?: string
  readonly manifest?: CordisXPluginManifestV1 | CordisXPluginManifestV4 | CordisXPluginManifestV5 | CordisXPluginManifestV6
  readonly package?: {
    readonly version: string
    readonly digest: `sha256:${string}`
    readonly moduleGeneration: string
    readonly dependencies: readonly CordisXPluginDependencyV1[]
    readonly canonicalSource?: string
  }
  readonly readme?: string
  readonly readmes?: Readonly<Record<string, string>>
  /** Prebuilt lexical module body used only by the launcher local-dev bootstrap. */
  readonly moduleFactorySource?: string
  readonly development?: CordisXLocalDevelopmentSnapshot
}

export interface LoadConfigOptions {
  readonly profileId?: string
}

export interface CordisXConfig {
  readonly version: 1
  readonly rootDir: string
  readonly codex: {
    readonly debugPort: number
    readonly executable?: string
    /** Explicit opt-in independent App Server used only by the brokered AgentLoop/Platform boundary. */
    readonly agentLoopBackend?: 'local-cli' | 'mock'
  }
  readonly providers: readonly CliProxyProviderConfig[]
  readonly plugins: readonly CordisXConfigPlugin[]
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function pluginEntry(value: unknown, label: string, rootDir: string): string {
  const entry = nonEmptyString(value, label)
  if (entry === 'cordisx:cli-proxy-api') {
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
    return fileURLToPath(new URL(`../plugins/cli-proxy-api/index.${extension}`, import.meta.url))
  }
  if (entry === 'cordisx:channel') {
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
    return fileURLToPath(new URL(`../plugins/channel/index.${extension}`, import.meta.url))
  }
  if (entry.startsWith('cordisx:')) throw new Error(`${label} uses an unknown built-in plugin`)
  return path.resolve(rootDir, entry)
}

function serviceConfiguration(
  plugin: Record<string, unknown>,
  serviceId: string,
  profileId: string,
): unknown | undefined {
  if (plugin.services === undefined) return undefined
  const services = object(plugin.services, `config.plugins.${plugin.id as string}.services`)
  if (!Object.hasOwn(services, serviceId)) return undefined
  const service = object(services[serviceId], `config.plugins.${plugin.id as string}.services.${serviceId}`)
  const profiles = object(service.profiles, `config.plugins.${plugin.id as string}.services.${serviceId}.profiles`)
  if (!Object.hasOwn(profiles, profileId)) return undefined
  return object(profiles[profileId], `config.plugins.${plugin.id as string}.services.${serviceId}.profiles.${profileId}`).config
}

/** Validate a version-1 local composition document without changing its storage envelope. */
export function parseConfigDocument(value: unknown, configPath: string, options: LoadConfigOptions = {}): CordisXConfig {
  const absolutePath = path.resolve(configPath)
  const raw = object(value, 'config')
  if (raw.version !== 1) throw new Error('config.version must be 1')
  const codex = raw.codex === undefined ? {} : object(raw.codex, 'config.codex')
  const debugPort = codex.debugPort ?? 9229
  if (!Number.isInteger(debugPort) || (debugPort as number) < 1024 || (debugPort as number) > 65535) {
    throw new Error('config.codex.debugPort must be an integer between 1024 and 65535')
  }
  const executable = codex.executable === undefined
    ? undefined
    : nonEmptyString(codex.executable, 'config.codex.executable')
  if (codex.agentLoopBackend !== undefined && codex.agentLoopBackend !== 'local-cli' && codex.agentLoopBackend !== 'mock') {
    throw new Error('config.codex.agentLoopBackend must be local-cli or mock when provided')
  }
  if (options.profileId !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(options.profileId)) {
    throw new Error(`invalid profile id: ${options.profileId}`)
  }

  if (!Array.isArray(raw.plugins)) throw new Error('config.plugins must be an array')
  const rawPlugins = raw.plugins.map((value, index) => object(value, `config.plugins[${index}]`))
  const seen = new Set<string>()
  const plugins = rawPlugins.map((plugin, index): CordisXConfigPlugin => {
    const id = nonEmptyString(plugin.id, `config.plugins[${index}].id`)
    if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(id)) throw new Error(`invalid plugin id: ${id}`)
    if (id === 'host' || id.startsWith('cordisx.')) throw new Error(`reserved plugin id: ${id}`)
    if (seen.has(id)) throw new Error(`duplicate plugin id: ${id}`)
    seen.add(id)
    const entry = pluginEntry(plugin.entry, `config.plugins[${index}].entry`, path.dirname(absolutePath))
    if (plugin.enabled !== undefined && typeof plugin.enabled !== 'boolean') {
      throw new Error(`config.plugins[${index}].enabled must be a boolean`)
    }
    let scoped: Record<string, unknown> | undefined
    if (options.profileId !== undefined && plugin.profiles !== undefined) {
      const profiles = object(plugin.profiles, `config.plugins[${index}].profiles`)
      const value = Object.hasOwn(profiles, options.profileId) ? profiles[options.profileId] : undefined
      if (value !== undefined) scoped = object(value, `config.plugins[${index}].profiles.${options.profileId}`)
    }
    const revision = scoped?.revision ?? 0
    if (!Number.isInteger(revision) || (revision as number) < 0) {
      throw new Error(`config.plugins[${index}] scoped revision must be a non-negative integer`)
    }
    return {
      id,
      entry,
      enabled: plugin.enabled !== false,
      config: scoped?.config ?? plugin.config ?? {},
      revision: revision as number,
    }
  })

  const profileId = options.profileId ?? 'default'
  const cliProxyPlugin = rawPlugins.find(plugin => plugin.id === 'cli-proxy-api' && plugin.enabled !== false)
  const runtimeValue = cliProxyPlugin === undefined
    ? undefined
    : serviceConfiguration(cliProxyPlugin, CLI_PROXY_PROVIDER_RUNTIME_SERVICE_ID, profileId)
  const providers = runtimeValue === undefined
    ? resolveProviderConfigs(raw.providers, { rootDir: path.dirname(absolutePath) })
    : resolveCliProxyProviderConfigs(
        parseCliProxyProviderRuntimeConfig(runtimeValue ?? CLI_PROXY_PROVIDER_RUNTIME_CONFIG_INITIAL),
        parseCliProxyProviderStartupConfig(
          serviceConfiguration(cliProxyPlugin!, CLI_PROXY_PROVIDER_STARTUP_SERVICE_ID, profileId)
            ?? CLI_PROXY_PROVIDER_STARTUP_CONFIG_INITIAL,
        ),
        { rootDir: path.dirname(absolutePath) },
      )
  if (codex.agentLoopBackend === 'local-cli' && providers.some(provider => provider.id === 'codex-local')) {
    throw new Error('config.providers id codex-local is reserved by config.codex.agentLoopBackend')
  }

  return {
    version: 1,
    rootDir: path.dirname(absolutePath),
    codex: {
      debugPort: debugPort as number,
      ...(executable === undefined ? {} : { executable: path.resolve(path.dirname(absolutePath), executable) }),
      ...(codex.agentLoopBackend === 'local-cli'
        ? { agentLoopBackend: 'local-cli' as const }
        : codex.agentLoopBackend === 'mock'
          ? { agentLoopBackend: 'mock' as const }
          : {}),
    },
    providers,
    plugins,
  }
}

/** Read and validate the version-1 local composition file. */
export async function loadConfig(configPath: string, options: LoadConfigOptions = {}): Promise<CordisXConfig> {
  const absolutePath = path.resolve(configPath)
  return parseConfigDocument(JSON.parse(await readFile(absolutePath, 'utf8')) as unknown, absolutePath, options)
}
