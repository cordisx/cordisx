import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProviderConfigs } from '../providers/config.js'
import type { CliProxyProviderConfig } from '../providers/contracts.js'

export interface CordisXConfigPlugin {
  readonly id: string
  readonly entry: string
  readonly enabled: boolean
  readonly config: unknown
}

export interface CordisXConfig {
  readonly version: 1
  readonly rootDir: string
  readonly codex: {
    readonly debugPort: number
    readonly executable?: string
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
  if (entry.startsWith('cordisx:')) throw new Error(`${label} uses an unknown built-in plugin`)
  return path.resolve(rootDir, entry)
}

/** Read and validate the version-1 local composition file. */
export async function loadConfig(configPath: string): Promise<CordisXConfig> {
  const absolutePath = path.resolve(configPath)
  const raw = object(JSON.parse(await readFile(absolutePath, 'utf8')) as unknown, 'config')
  if (raw.version !== 1) throw new Error('config.version must be 1')
  const codex = raw.codex === undefined ? {} : object(raw.codex, 'config.codex')
  const debugPort = codex.debugPort ?? 9229
  if (!Number.isInteger(debugPort) || (debugPort as number) < 1024 || (debugPort as number) > 65535) {
    throw new Error('config.codex.debugPort must be an integer between 1024 and 65535')
  }
  const executable = codex.executable === undefined
    ? undefined
    : nonEmptyString(codex.executable, 'config.codex.executable')

  if (!Array.isArray(raw.plugins)) throw new Error('config.plugins must be an array')
  const seen = new Set<string>()
  const plugins = raw.plugins.map((value, index): CordisXConfigPlugin => {
    const plugin = object(value, `config.plugins[${index}]`)
    const id = nonEmptyString(plugin.id, `config.plugins[${index}].id`)
    if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(id)) throw new Error(`invalid plugin id: ${id}`)
    if (id === 'host' || id.startsWith('cordisx.')) throw new Error(`reserved plugin id: ${id}`)
    if (seen.has(id)) throw new Error(`duplicate plugin id: ${id}`)
    seen.add(id)
    const entry = pluginEntry(plugin.entry, `config.plugins[${index}].entry`, path.dirname(absolutePath))
    if (plugin.enabled !== undefined && typeof plugin.enabled !== 'boolean') {
      throw new Error(`config.plugins[${index}].enabled must be a boolean`)
    }
    return {
      id,
      entry,
      enabled: plugin.enabled !== false,
      config: plugin.config ?? {},
    }
  })

  return {
    version: 1,
    rootDir: path.dirname(absolutePath),
    codex: {
      debugPort: debugPort as number,
      ...(executable === undefined ? {} : { executable: path.resolve(path.dirname(absolutePath), executable) }),
    },
    providers: resolveProviderConfigs(raw.providers, { rootDir: path.dirname(absolutePath) }),
    plugins,
  }
}
