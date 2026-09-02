import path from 'node:path'
import type { CliProxyProviderConfig } from './contracts.js'

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/
const ENVIRONMENT_KEY = /^[A-Z_][A-Z0-9_]{0,127}$/

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > maximum) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function endpoint(value: unknown, label: string): string {
  const raw = text(value, label)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${label} must be a valid URL`)
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${label} must use HTTPS or loopback HTTP`)
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error(`${label} must not contain credentials, a query, or a fragment`)
  }
  return url.toString().replace(/\/$/, '')
}

export interface ResolveProviderConfigsOptions {
  readonly rootDir: string
  readonly defaultCodexExecutable?: string
}

/** Validate launcher-owned external provider definitions without reading credentials. */
export function resolveProviderConfigs(
  value: unknown,
  options: ResolveProviderConfigsOptions,
): readonly CliProxyProviderConfig[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value)) throw new Error('config.providers must be an array')
  const ids = new Set<string>()
  const dataRoots = new Set<string>()
  const result = value.map((item, index): CliProxyProviderConfig => {
    const label = `config.providers[${index}]`
    const provider = object(item, label)
    const unknown = Object.keys(provider).find(key => ![
      'id', 'kind', 'displayName', 'baseUrl', 'apiKeyEnv', 'codexExecutable', 'dataDir', 'enabled', 'timeoutMs',
    ].includes(key))
    if (unknown !== undefined) throw new Error(`${label} contains unknown field ${unknown}`)
    const id = text(provider.id, `${label}.id`, 96)
    if (!PROVIDER_ID.test(id)) throw new Error(`${label}.id is invalid`)
    if (ids.has(id)) throw new Error(`duplicate provider id: ${id}`)
    ids.add(id)
    if (provider.kind !== 'cli-proxy-api') throw new Error(`${label}.kind must be cli-proxy-api`)
    const displayName = text(provider.displayName, `${label}.displayName`, 200)
    const baseUrl = endpoint(provider.baseUrl, `${label}.baseUrl`)
    const apiKeyEnv = text(provider.apiKeyEnv, `${label}.apiKeyEnv`, 128)
    if (!ENVIRONMENT_KEY.test(apiKeyEnv)) throw new Error(`${label}.apiKeyEnv is invalid`)
    const codexExecutable = provider.codexExecutable === undefined
      ? options.defaultCodexExecutable ?? 'codex'
      : path.resolve(options.rootDir, text(provider.codexExecutable, `${label}.codexExecutable`))
    const codexHome = provider.dataDir === undefined
      ? path.resolve(options.rootDir, 'providers', id, 'codex-home')
      : path.resolve(options.rootDir, text(provider.dataDir, `${label}.dataDir`))
    const normalizedRoot = process.platform === 'win32' ? codexHome.toLowerCase() : codexHome
    if (dataRoots.has(normalizedRoot)) throw new Error(`${label}.dataDir must be unique per provider`)
    dataRoots.add(normalizedRoot)
    if (provider.enabled !== undefined && typeof provider.enabled !== 'boolean') throw new Error(`${label}.enabled must be boolean`)
    const timeoutMs = provider.timeoutMs ?? 30_000
    if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1_000 || (timeoutMs as number) > 120_000) {
      throw new Error(`${label}.timeoutMs must be an integer between 1000 and 120000`)
    }
    return Object.freeze({
      id,
      kind: 'cli-proxy-api',
      displayName,
      baseUrl,
      apiKeyEnv,
      codexExecutable,
      codexHome,
      enabled: provider.enabled !== false,
      timeoutMs: timeoutMs as number,
      modelMappings: [],
    })
  })
  return Object.freeze(result)
}
