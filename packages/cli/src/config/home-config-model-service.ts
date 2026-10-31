/** Validation for `model-service` provider declarations in the CordisX home config. */

export type HomeConfigProviderProtocol = 'anthropic-messages' | 'openai-responses'

export interface HomeConfigModelServiceProvider {
  readonly id: string
  readonly kind: 'model-service'
  readonly displayName: string
  readonly baseUrl: string
  readonly apiKeyEnv: string
  /** Protocols this endpoint serves. A projection requires the protocol its app speaks. */
  readonly protocols: readonly HomeConfigProviderProtocol[]
  /** Model ids per app id. */
  readonly models?: Readonly<Record<string, readonly string[]>>
  /** App ids this service is projected into. Omitted means every app it has a protocol for. */
  readonly appliesTo?: readonly string[]
  /** Codex `wire_api` override for providers that are not Responses-native. */
  readonly wireApi?: 'responses' | 'chat'
  readonly enabled?: boolean
  readonly timeoutMs?: number
}

const PROVIDER_PROTOCOLS = ['anthropic-messages', 'openai-responses'] as const
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/
const PORTABLE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const ENVIRONMENT_KEY = /^[A-Z_][A-Z0-9_]{0,127}$/

export interface ModelServiceParseContext {
  readonly record: (value: unknown, label: string) => Record<string, unknown>
  readonly rejectUnknownKeys: (value: Record<string, unknown>, allowed: readonly string[], label: string) => void
  readonly nonEmptyString: (value: unknown, label: string) => string
}

export function isModelServiceProviderId(value: unknown): boolean {
  return typeof value === 'string' && PROVIDER_ID.test(value)
}

function parseProtocols(value: unknown, label: string): HomeConfigProviderProtocol[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`)
  const seen = new Set<HomeConfigProviderProtocol>()
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || !(PROVIDER_PROTOCOLS as readonly string[]).includes(item)) {
      throw new Error(`${label}[${index}] must be one of ${PROVIDER_PROTOCOLS.join(', ')}`)
    }
    seen.add(item as HomeConfigProviderProtocol)
  }
  return [...seen]
}

function parseEndpoint(value: unknown, label: string, text: ModelServiceParseContext['nonEmptyString']): string {
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
  return url.toString().replace(/\/$/u, '')
}

function parseModels(
  value: unknown,
  label: string,
  context: ModelServiceParseContext,
): Readonly<Record<string, readonly string[]>> | undefined {
  if (value === undefined) return undefined
  const source = context.record(value, label)
  const result: Record<string, readonly string[]> = Object.create(null) as Record<string, readonly string[]>
  for (const [appId, models] of Object.entries(source)) {
    if (!PORTABLE_ID.test(appId)) throw new Error(`${label} app id is invalid: ${appId}`)
    if (!Array.isArray(models) || models.length === 0) throw new Error(`${label}.${appId} must be a non-empty array`)
    result[appId] = Object.freeze(
      models.map((model, index) => context.nonEmptyString(model, `${label}.${appId}[${index}]`)),
    )
  }
  return Object.freeze(result)
}

export function parseModelServiceProvider(
  value: unknown,
  label: string,
  context: ModelServiceParseContext,
): HomeConfigModelServiceProvider {
  const provider = context.record(value, label)
  context.rejectUnknownKeys(provider, [
    'id',
    'kind',
    'displayName',
    'baseUrl',
    'apiKeyEnv',
    'protocols',
    'models',
    'appliesTo',
    'wireApi',
    'enabled',
    'timeoutMs',
  ], label)
  const { nonEmptyString } = context
  const id = nonEmptyString(provider.id, `${label}.id`)
  if (!PROVIDER_ID.test(id)) throw new Error(`${label}.id is invalid: ${id}`)
  const displayName = nonEmptyString(provider.displayName, `${label}.displayName`)
  const baseUrl = parseEndpoint(provider.baseUrl, `${label}.baseUrl`, nonEmptyString)
  const apiKeyEnv = nonEmptyString(provider.apiKeyEnv, `${label}.apiKeyEnv`)
  if (!ENVIRONMENT_KEY.test(apiKeyEnv)) throw new Error(`${label}.apiKeyEnv must be an environment name`)
  const protocols = parseProtocols(provider.protocols, `${label}.protocols`)
  const models = parseModels(provider.models, `${label}.models`, context)
  let appliesTo: readonly string[] | undefined
  if (provider.appliesTo !== undefined) {
    if (!Array.isArray(provider.appliesTo) || provider.appliesTo.length === 0) {
      throw new Error(`${label}.appliesTo must be a non-empty array`)
    }
    appliesTo = Object.freeze(provider.appliesTo.map((app, index) => {
      if (typeof app !== 'string' || !PORTABLE_ID.test(app)) {
        throw new Error(`${label}.appliesTo[${index}] must be an app id`)
      }
      return app
    }))
  }
  if (provider.wireApi !== undefined && provider.wireApi !== 'responses' && provider.wireApi !== 'chat') {
    throw new Error(`${label}.wireApi must be responses or chat`)
  }
  if (provider.enabled !== undefined && typeof provider.enabled !== 'boolean') {
    throw new Error(`${label}.enabled must be a boolean`)
  }
  if (provider.timeoutMs !== undefined && !Number.isInteger(provider.timeoutMs)) {
    throw new Error(`${label}.timeoutMs must be an integer`)
  }
  return Object.freeze({
    id,
    kind: 'model-service',
    displayName,
    baseUrl,
    apiKeyEnv,
    protocols: Object.freeze(protocols),
    ...(models === undefined ? {} : { models }),
    ...(appliesTo === undefined ? {} : { appliesTo }),
    ...(provider.wireApi === undefined ? {} : { wireApi: provider.wireApi }),
    ...(provider.enabled === undefined ? {} : { enabled: provider.enabled }),
    ...(provider.timeoutMs === undefined ? {} : { timeoutMs: provider.timeoutMs as number }),
  })
}
