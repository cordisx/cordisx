import { HOME_ENVIRONMENT_NAME } from './home-config-environment.js'

export type McpValue = string | Readonly<{ env: string }>
export type McpServer =
  | Readonly<{
    type: 'stdio'
    command: string
    args?: readonly string[]
    cwd?: string
    env?: Readonly<Record<string, McpValue>>
  }>
  | Readonly<{
    type: 'http'
    url: McpValue
    headers?: Readonly<Record<string, McpValue>>
  }>
export interface HomeMcpConfig {
  readonly servers: Readonly<Record<string, McpServer>>
  readonly apps?: Readonly<Partial<Record<'codex' | 'claude-code', Readonly<Record<string, McpServer | null>>>>>
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
function string(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value) || value.includes('\0') || value.length > 16384) {
    throw new Error(`${label} must be a nonempty string`)
  }
  return value
}
function value(input: unknown, label: string): McpValue {
  if (typeof input === 'string') return string(input, label, true)
  const ref = object(input, label)
  if (Object.keys(ref).join(',') !== 'env' || typeof ref.env !== 'string' || !HOME_ENVIRONMENT_NAME.test(ref.env)) {
    throw new Error(`${label} must be a string or an environment reference { env: NAME }`)
  }
  return { env: ref.env }
}
function values(input: unknown, label: string, environment: boolean): Readonly<Record<string, McpValue>> {
  const result: Record<string, McpValue> = Object.create(null)
  for (const [key, entry] of Object.entries(object(input, label))) {
    if (!(environment ? HOME_ENVIRONMENT_NAME : /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u).test(key)) {
      throw new Error(`${label} contains an invalid name`)
    }
    result[key] = value(entry, `${label}.${key}`)
  }
  return result
}
function server(input: unknown, label: string): McpServer {
  const item = object(input, label)
  const allowed = item.type === 'stdio'
    ? ['type', 'command', 'args', 'cwd', 'env']
    : item.type === 'http'
    ? ['type', 'url', 'headers']
    : []
  if (!allowed.length || Object.keys(item).some(key => !allowed.includes(key))) {
    throw new Error(`${label}: supported transports are stdio and streamable http with documented fields`)
  }
  if (item.type === 'stdio') {
    if (item.args !== undefined && !Array.isArray(item.args)) throw new Error(`${label}.args must be an array`)
    return {
      type: 'stdio',
      command: string(item.command, `${label}.command`),
      ...(item.args === undefined
        ? {}
        : { args: (item.args as unknown[]).map((v, i) => string(v, `${label}.args[${i}]`, true)) }),
      ...(item.cwd === undefined ? {} : { cwd: string(item.cwd, `${label}.cwd`) }),
      ...(item.env === undefined ? {} : { env: values(item.env, `${label}.env`, true) }),
    }
  }
  return {
    type: 'http',
    url: value(item.url, `${label}.url`),
    ...(item.headers === undefined ? {} : { headers: values(item.headers, `${label}.headers`, false) }),
  }
}
function servers(input: unknown, label: string, allowNull: boolean): Record<string, McpServer | null> {
  const result: Record<string, McpServer | null> = Object.create(null)
  for (const [name, entry] of Object.entries(object(input, label))) {
    if (!/^[A-Za-z0-9_-]{1,100}$/u.test(name)) throw new Error(`${label} contains an invalid server name`)
    result[name] = entry === null && allowNull ? null : server(entry, `${label}.${name}`)
  }
  return result
}
export function parseHomeMcpConfig(input: unknown): HomeMcpConfig | undefined {
  if (input === undefined) return undefined
  const config = object(input, 'config.mcp')
  if (Object.keys(config).some(key => !['servers', 'apps'].includes(key))) {
    throw new Error('config.mcp contains unknown fields')
  }
  const base = servers(config.servers ?? {}, 'config.mcp.servers', false) as Record<string, McpServer>
  if (config.apps === undefined) return { servers: base }
  const apps = object(config.apps, 'config.mcp.apps')
  if (Object.keys(apps).some(key => !['codex', 'claude-code'].includes(key))) {
    throw new Error('config.mcp.apps contains an unsupported app')
  }
  return {
    servers: base,
    apps: Object.fromEntries(
      Object.entries(apps).map(([key, entries]) => [key, servers(entries, `config.mcp.apps.${key}`, true)]),
    ),
  }
}
export function mcpServersForApp(
  config: HomeMcpConfig | undefined,
  app: 'codex' | 'claude-code',
): Readonly<Record<string, McpServer>> {
  const merged = { ...config?.servers, ...config?.apps?.[app] }
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, McpServer] => entry[1] !== null))
}
