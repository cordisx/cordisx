import { createHmac, randomBytes } from 'node:crypto'
import {
  type HomeConfig,
  type HomeConfigModelServiceProvider,
  loadHomeConfig,
  parseHomeConfig,
  updateHomeConfigAtomic,
} from '../config/home-config.js'
import {
  type ModelServiceInput,
  modelServiceKeyEnv,
  type ModelServiceRuntimeOptions,
  type ModelServicesReadResult,
  type ModelServicesSaveRequest,
  type ModelServicesSaveResult,
  type ModelServiceView,
} from '../model-service-contracts.js'
import {
  modelServiceRuntimeOptionsView,
  parseModelServiceHeaders,
  parseModelServiceRuntimeOptions,
} from '../config/model-service-runtime-options.js'
import { modelServicesOf } from './model-service-projection.js'

/**
 * Reads and writes the top-level `model-service` providers for the manager
 * page. Gateway providers (`cli-proxy-api`) in the same array are kept as they
 * are. Keys go to `environmentVariables` under the declaration's `apiKeyEnv`
 * and are never read back.
 */

// The revision protects CAS without publishing an offline verifier for write-only headers.
const revisionKey = randomBytes(32)
function revisionOf(config: HomeConfig): string {
  return createHmac('sha256', revisionKey).update(JSON.stringify(modelServicesOf(config.providers))).digest('hex')
}

function keyConfigured(
  config: HomeConfig,
  name: string,
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  const stored = config.environmentVariables.find(entry => entry.name === name)
  if (stored !== undefined) return stored.enabled && (stored.value !== '' || stored.generator !== undefined)
  return typeof environment[name] === 'string' && environment[name] !== ''
}

function view(
  config: HomeConfig,
  provider: HomeConfigModelServiceProvider,
  environment: Readonly<Record<string, string | undefined>>,
): ModelServiceView {
  return {
    id: provider.id,
    displayName: provider.displayName,
    baseUrl: provider.baseUrl,
    apiKeyEnv: provider.apiKeyEnv,
    protocols: [...provider.protocols],
    codexModels: [...provider.models?.codex ?? []],
    claudeModels: [...provider.models?.claude ?? []],
    enabled: provider.enabled !== false,
    ...modelServiceRuntimeOptionsView(provider.runtimeOptions),
    keyConfigured: keyConfigured(config, provider.apiKeyEnv, environment),
  }
}

export async function readModelServices(
  configPath: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ModelServicesReadResult> {
  try {
    const config = await loadHomeConfig(configPath)
    return {
      status: 'ok',
      revision: revisionOf(config),
      services: modelServicesOf(config.providers).map(provider => view(config, provider, environment)),
    }
  } catch {
    return { status: 'rejected', code: 'unavailable' }
  }
}

class ModelServiceConflict extends Error {}

function declaration(
  input: ModelServiceInput,
  previous: HomeConfigModelServiceProvider | undefined,
): Record<string, unknown> {
  const models: Record<string, readonly string[]> = {}
  if (input.codexModels.length > 0) models.codex = [...input.codexModels]
  if (input.claudeModels.length > 0) models.claude = [...input.claudeModels]
  let runtimeOptions: ModelServiceRuntimeOptions | null | undefined = input.runtimeOptions === undefined
    ? previous?.runtimeOptions
    : input.runtimeOptions
  const headers: Record<string, string> = Object.assign(
    Object.create(null),
    input.runtimeOptions === null ? undefined : previous?.runtimeOptions?.codex?.http_headers,
  )
  if (input.httpHeadersPatch !== undefined) {
    for (const [name, value] of Object.entries(input.httpHeadersPatch)) {
      for (const previousName of Object.keys(headers)) {
        if (previousName.toLowerCase() === name.toLowerCase()) delete headers[previousName]
      }
      if (value !== null) headers[name] = value
    }
  }
  if (
    Object.keys(headers).length > 0 || runtimeOptions != null
    || runtimeOptions !== null && Object.keys(input.httpHeadersPatch ?? {}).length > 0
  ) {
    const { http_headers: _fixed, ...codex } = runtimeOptions?.codex ?? {}
    runtimeOptions = { codex: { ...codex, ...(Object.keys(headers).length === 0 ? {} : { http_headers: headers }) } }
  }
  return {
    id: input.id,
    kind: 'model-service',
    displayName: input.displayName,
    baseUrl: input.baseUrl,
    // A declaration keeps the variable it already names; a new one gets a CordisX-owned name.
    apiKeyEnv: previous?.apiKeyEnv ?? modelServiceKeyEnv(input.id),
    protocols: [...input.protocols],
    ...(runtimeOptions === undefined ? {} : { runtimeOptions }),
    ...(Object.keys(models).length === 0 ? {} : { models }),
    ...(previous?.appliesTo === undefined ? {} : { appliesTo: [...previous.appliesTo] }),
    ...(previous?.timeoutMs === undefined ? {} : { timeoutMs: previous.timeoutMs }),
    ...(input.enabled ? {} : { enabled: false }),
  }
}

/** Names `modelServiceKeyEnv` gives; only these are removed with their service. */
const OWNED_KEY_ENV = /^CORDISX_MODEL_SERVICE_[A-Z0-9_]+_KEY$/u
const PROTOCOLS = new Set(['anthropic-messages', 'openai-responses'])
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value)
const modelIds = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.length <= 512 && value.every(item => bounded(item, 512)) ? value as string[] : undefined

/** Strict shape check for a renderer-supplied save; the home config parser validates the rest. */
export function parseModelServicesSaveRequest(value: unknown): ModelServicesSaveRequest | undefined {
  const request = object(value)
  if (!request || !bounded(request.expectedRevision, 128) || !Array.isArray(request.services)) return undefined
  if (request.services.length > 64) return undefined
  const services: ModelServiceInput[] = []
  for (const item of request.services) {
    const service = object(item)
    if (
      !service
      || Object.keys(service).some(key =>
        ![
          'id',
          'displayName',
          'baseUrl',
          'protocols',
          'codexModels',
          'claudeModels',
          'enabled',
          'apiKey',
          'runtimeOptions',
          'httpHeadersPatch',
        ].includes(key)
      )
      || !bounded(service.id, 96) || !bounded(service.displayName, 200) || !bounded(service.baseUrl, 2048)
      || !Array.isArray(service.protocols) || service.protocols.length === 0
      || !service.protocols.every(protocol => typeof protocol === 'string' && PROTOCOLS.has(protocol))
      || typeof service.enabled !== 'boolean'
      || service.apiKey !== undefined && !bounded(service.apiKey, 16_384)
    ) return undefined
    const codexModels = modelIds(service.codexModels)
    const claudeModels = modelIds(service.claudeModels)
    if (codexModels === undefined || claudeModels === undefined) return undefined
    let runtimeOptions: ModelServiceInput['runtimeOptions']
    let httpHeadersPatch: ModelServiceInput['httpHeadersPatch']
    try {
      if (service.runtimeOptions === null) runtimeOptions = null
      else if (service.runtimeOptions !== undefined) {
        const parsed = parseModelServiceRuntimeOptions(service.runtimeOptions)
        if (parsed.codex?.http_headers !== undefined) return undefined
        runtimeOptions = parsed
      }
      if (service.httpHeadersPatch !== undefined) {
        httpHeadersPatch = parseModelServiceHeaders(service.httpHeadersPatch, 'httpHeadersPatch', true)
      }
    } catch {
      return undefined
    }
    services.push({
      id: service.id,
      displayName: service.displayName,
      baseUrl: service.baseUrl,
      protocols: [...new Set(service.protocols as ModelServiceInput['protocols'][number][])],
      codexModels,
      claudeModels,
      enabled: service.enabled,
      ...(runtimeOptions === undefined ? {} : { runtimeOptions }),
      ...(httpHeadersPatch === undefined ? {} : { httpHeadersPatch }),
      ...(service.apiKey === undefined ? {} : { apiKey: service.apiKey as string }),
    })
  }
  return { expectedRevision: request.expectedRevision, services }
}

/** Replaces the declared model services as one compare-and-swap edit of the home config. */
export async function saveModelServices(
  configPath: string,
  request: ModelServicesSaveRequest,
): Promise<ModelServicesSaveResult> {
  const parsed = parseModelServicesSaveRequest(request)
  if (!parsed) return { status: 'rejected', code: 'invalid' }
  request = parsed
  const ids = new Set<string>()
  for (const service of request.services) {
    if (ids.has(service.id)) return { status: 'rejected', code: 'invalid', message: `duplicate id: ${service.id}` }
    ids.add(service.id)
  }
  let saved: HomeConfig
  try {
    saved = await updateHomeConfigAtomic(current => {
      if (revisionOf(current) !== request.expectedRevision) throw new ModelServiceConflict()
      const previous = new Map(modelServicesOf(current.providers).map(provider => [provider.id, provider]))
      const gateways = current.providers.filter(provider => provider.kind !== 'model-service')
      if (gateways.some(provider => ids.has(provider.id))) {
        throw new Error('an id is already used by a gateway provider')
      }
      const declarations = request.services.map(service => declaration(service, previous.get(service.id)))
      let environmentVariables = [...current.environmentVariables]
      for (const [index, service] of request.services.entries()) {
        if (service.apiKey === undefined) continue
        const name = declarations[index]!.apiKeyEnv as string
        const entry = {
          name,
          value: service.apiKey,
          enabled: true,
          description: `${service.displayName} API key (CordisX model service)`,
        }
        environmentVariables = environmentVariables.some(item => item.name === name)
          ? environmentVariables.map(item => item.name === name ? entry : item)
          : [...environmentVariables, entry]
      }
      // A key this page stored for a service that is now gone has no reader left.
      const referenced = new Set(declarations.map(item => item.apiKeyEnv as string))
      environmentVariables = environmentVariables.filter(item =>
        !OWNED_KEY_ENV.test(item.name) || referenced.has(item.name)
      )
      // Full validation of the edited document before it is written.
      return parseHomeConfig({
        ...current,
        environmentVariables,
        providers: [...gateways, ...declarations],
      })
    }, configPath)
  } catch (error) {
    if (error instanceof ModelServiceConflict) return { status: 'rejected', code: 'conflict' }
    const message = error instanceof Error ? error.message : String(error)
    return /must|invalid|not supported|duplicate|already used/u.test(message)
      ? { status: 'rejected', code: 'invalid', message }
      : { status: 'rejected', code: 'persist-failed' }
  }
  return { status: 'applied', applies: 'app-restart', revision: revisionOf(saved) }
}
