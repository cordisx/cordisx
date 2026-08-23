import { readFile } from 'node:fs/promises'
import path from 'node:path'

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
    if (seen.has(id)) throw new Error(`duplicate plugin id: ${id}`)
    seen.add(id)
    const entry = nonEmptyString(plugin.entry, `config.plugins[${index}].entry`)
    if (plugin.enabled !== undefined && typeof plugin.enabled !== 'boolean') {
      throw new Error(`config.plugins[${index}].enabled must be a boolean`)
    }
    return {
      id,
      entry: path.resolve(path.dirname(absolutePath), entry),
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
    plugins,
  }
}
