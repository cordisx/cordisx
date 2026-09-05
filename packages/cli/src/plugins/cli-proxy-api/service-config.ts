import path from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import type { JsonValue } from '../../config/home-config.js'
import type { CliProxyProviderConfig } from '../../providers/contracts.js'
import type {
  HostSecretState,
  HostServiceConfigContract,
  HostServiceConfigProjection,
} from '../../launcher/service-config.js'

export const CLI_PROXY_PROVIDER_RUNTIME_SERVICE_ID = 'providers-runtime'
export const CLI_PROXY_PROVIDER_STARTUP_SERVICE_ID = 'providers-startup'
export const CLI_PROXY_PROVIDER_RUNTIME_CONFIG_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/cli-proxy-provider-runtime-config.v1.schema.json'
export const CLI_PROXY_PROVIDER_STARTUP_CONFIG_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/cli-proxy-provider-startup-config.v1.schema.json'

export interface CliProxyProviderModelMappingV1 {
  readonly sourceModelId: string
  readonly modelId: string
  readonly displayName?: string
  readonly enabled: boolean
  readonly isDefault: boolean
}

export interface CliProxyProviderRuntimeEntryV1 {
  readonly id: string
  readonly displayName: string
  readonly enabled: boolean
  readonly endpoint: {
    readonly baseUrl: string
    readonly secretRef?: string
  }
  readonly models: { readonly mappings: readonly CliProxyProviderModelMappingV1[] }
  readonly timeoutMs: number
}

export interface CliProxyProviderRuntimeConfigV1 {
  readonly contract: 'cordisx.cli-proxy-provider-runtime-config/v1'
  readonly schemaVersion: 1
  readonly providers: readonly CliProxyProviderRuntimeEntryV1[]
}

export interface CliProxyProviderStartupEntryV1 {
  readonly id: string
  readonly executable: string
  readonly dataDir: string
}

export interface CliProxyProviderStartupConfigV1 {
  readonly contract: 'cordisx.cli-proxy-provider-startup-config/v1'
  readonly schemaVersion: 1
  readonly providers: readonly CliProxyProviderStartupEntryV1[]
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/
const SECRET_REF = /^(?:keychain|host-secret):[A-Za-z0-9][A-Za-z0-9._:/-]{0,500}$/

const modelMappingSchema = Schema.object({
  sourceModelId: Schema.string().required().max(256)
    .extra('extra', { label: { 'zh-CN': '远端模型 ID', en: 'Remote model ID' } }),
  modelId: Schema.string().required().max(256)
    .extra('extra', { label: { 'zh-CN': '公开模型 ID', en: 'Public model ID' } }),
  displayName: Schema.string().max(200)
    .extra('extra', { label: { 'zh-CN': '显示名称', en: 'Display name' } }),
  enabled: Schema.boolean().default(true)
    .extra('extra', { label: { 'zh-CN': '启用映射', en: 'Enable mapping' } }),
  isDefault: Schema.boolean().default(false)
    .extra('extra', { label: { 'zh-CN': '默认模型', en: 'Default model' } }),
})

const runtimeProviderSchema = Schema.object({
  id: Schema.string().required().max(96).pattern(PROVIDER_ID)
    .extra('extra', { label: { 'zh-CN': 'Provider ID', en: 'Provider ID' } }),
  displayName: Schema.string().required().max(200)
    .extra('extra', { label: { 'zh-CN': '显示名称', en: 'Display name' } }),
  enabled: Schema.boolean().default(true)
    .extra('extra', { label: { 'zh-CN': '启用 Provider', en: 'Enable provider' } }),
  endpoint: Schema.object({
    baseUrl: Schema.string().required().max(4096)
      .extra('extra', { label: { 'zh-CN': 'CLIProxy API 地址', en: 'CLIProxy API endpoint' } })
      .extra('description', {
        'zh-CN': '远端必须使用 HTTPS；本机服务可使用 loopback HTTP。',
        en: 'Remote endpoints require HTTPS; local services may use loopback HTTP.',
      }),
    secretRef: Schema.string().max(512).pattern(SECRET_REF).role('credential-ref')
      .extra('extra', { label: { 'zh-CN': '凭据引用', en: 'Credential reference' } })
      .extra('description', {
        'zh-CN': '仅接受 Host 保管的 keychain: 或 host-secret: 引用，不显示凭据值。',
        en: 'Accepts only Host-managed keychain: or host-secret: references; secret values are never displayed.',
      }),
  }),
  models: Schema.object({
    mappings: Schema.array(modelMappingSchema).default([]).max(256)
      .extra('extra', { label: { 'zh-CN': '模型映射', en: 'Model mappings' } }),
  }),
  timeoutMs: Schema.number().default(30_000).min(1_000).max(120_000)
    .extra('extra', { label: { 'zh-CN': '请求超时（毫秒）', en: 'Request timeout (ms)' } }),
})

const startupProviderSchema = Schema.object({
  id: Schema.string().required().max(96).pattern(PROVIDER_ID)
    .extra('extra', { label: { 'zh-CN': 'Provider ID', en: 'Provider ID' } }),
  executable: Schema.string().required().max(4096)
    .extra('extra', { label: { 'zh-CN': 'Codex 可执行文件', en: 'Codex executable' } }),
  dataDir: Schema.string().required().max(4096)
    .extra('extra', { label: { 'zh-CN': 'Provider 数据目录', en: 'Provider data directory' } }),
})

export const CliProxyProviderRuntimeConfigSchema = Schema.object({
  contract: Schema.const('cordisx.cli-proxy-provider-runtime-config/v1'),
  schemaVersion: Schema.const(1),
  providers: Schema.array(runtimeProviderSchema).default([]).max(64)
    .extra('extra', { label: { 'zh-CN': 'Providers', en: 'Providers' } })
    .extra('description', {
      'zh-CN': '保存后重启 external Provider Fleet 服务；不会替换原生 current connection。',
      en: 'Saving restarts the external Provider Fleet service; it never replaces the native current connection.',
    }),
})

export const CliProxyProviderStartupConfigSchema = Schema.object({
  contract: Schema.const('cordisx.cli-proxy-provider-startup-config/v1'),
  schemaVersion: Schema.const(1),
  providers: Schema.array(startupProviderSchema).default([]).max(64)
    .extra('extra', { label: { 'zh-CN': '下次启动设置', en: 'Next-start settings' } })
    .extra('description', {
      'zh-CN': '修改可执行文件或数据目录只保存为候选值，完整重启 CordisX 后生效。',
      en: 'Executable and data-directory changes are staged and apply only after a complete CordisX restart.',
    }),
})

function schemaEnvelope(schema: { readonly toJSON: () => unknown }): Readonly<Record<string, JsonValue>> {
  return JSON.parse(JSON.stringify(schema.toJSON())) as Readonly<Record<string, JsonValue>>
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).find(key => !allowed.includes(key))
  if (unexpected !== undefined) throw new TypeError(`${label}.${unexpected} is not supported`)
}

function text(value: unknown, label: string, maximum: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > maximum) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  const normalized = value.trim()
  if (pattern !== undefined && !pattern.test(normalized)) throw new TypeError(`${label} is invalid`)
  return normalized
}

function boolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean`)
  return value
}

function endpoint(value: unknown, label: string): string {
  const raw = text(value, label, 4096)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new TypeError(`${label} must be a valid URL`)
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new TypeError(`${label} must use HTTPS or loopback HTTP`)
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new TypeError(`${label} must not contain credentials, a query, or a fragment`)
  }
  return url.toString().replace(/\/$/, '')
}

function modelMapping(value: unknown, label: string): CliProxyProviderModelMappingV1 {
  const mapping = object(value, label)
  exactKeys(mapping, ['sourceModelId', 'modelId', 'displayName', 'enabled', 'isDefault'], label)
  return {
    sourceModelId: text(mapping.sourceModelId, `${label}.sourceModelId`, 256),
    modelId: text(mapping.modelId, `${label}.modelId`, 256),
    ...(mapping.displayName === undefined
      ? {}
      : { displayName: text(mapping.displayName, `${label}.displayName`, 200) }),
    enabled: boolean(mapping.enabled, `${label}.enabled`, true),
    isDefault: boolean(mapping.isDefault, `${label}.isDefault`, false),
  }
}

function runtimeProvider(
  value: unknown,
  label: string,
  current?: CliProxyProviderRuntimeEntryV1,
): CliProxyProviderRuntimeEntryV1 {
  const provider = object(value, label)
  exactKeys(provider, ['id', 'displayName', 'enabled', 'endpoint', 'models', 'timeoutMs'], label)
  const id = text(provider.id, `${label}.id`, 96, PROVIDER_ID)
  const endpointValue = object(provider.endpoint, `${label}.endpoint`)
  exactKeys(endpointValue, ['baseUrl', 'secretRef'], `${label}.endpoint`)
  const secretRef = endpointValue.secretRef === undefined
    ? current?.endpoint.secretRef
    : text(endpointValue.secretRef, `${label}.endpoint.secretRef`, 512, SECRET_REF)
  const models = provider.models === undefined ? {} : object(provider.models, `${label}.models`)
  exactKeys(models, ['mappings'], `${label}.models`)
  const rawMappings = models.mappings ?? []
  if (!Array.isArray(rawMappings) || rawMappings.length > 256) {
    throw new TypeError(`${label}.models.mappings must contain at most 256 items`)
  }
  const mappings = rawMappings.map((item, index) => modelMapping(item, `${label}.models.mappings[${index}]`))
  const sourceIds = new Set<string>()
  const modelIds = new Set<string>()
  let defaultCount = 0
  for (const mapping of mappings) {
    if (sourceIds.has(mapping.sourceModelId)) {
      throw new TypeError(`${label}.models.mappings contains duplicate sourceModelId ${mapping.sourceModelId}`)
    }
    if (modelIds.has(mapping.modelId)) {
      throw new TypeError(`${label}.models.mappings contains duplicate modelId ${mapping.modelId}`)
    }
    sourceIds.add(mapping.sourceModelId)
    modelIds.add(mapping.modelId)
    if (mapping.enabled && mapping.isDefault) defaultCount += 1
  }
  if (defaultCount > 1) throw new TypeError(`${label}.models.mappings contains multiple enabled defaults`)
  const timeoutMs = provider.timeoutMs ?? 30_000
  if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1_000 || (timeoutMs as number) > 120_000) {
    throw new TypeError(`${label}.timeoutMs must be an integer between 1000 and 120000`)
  }
  return {
    id,
    displayName: text(provider.displayName, `${label}.displayName`, 200),
    enabled: boolean(provider.enabled, `${label}.enabled`, true),
    endpoint: {
      baseUrl: endpoint(endpointValue.baseUrl, `${label}.endpoint.baseUrl`),
      ...(secretRef === undefined ? {} : { secretRef }),
    },
    models: { mappings },
    timeoutMs: timeoutMs as number,
  }
}

function startupProvider(value: unknown, label: string): CliProxyProviderStartupEntryV1 {
  const provider = object(value, label)
  exactKeys(provider, ['id', 'executable', 'dataDir'], label)
  return {
    id: text(provider.id, `${label}.id`, 96, PROVIDER_ID),
    executable: text(provider.executable, `${label}.executable`, 4096),
    dataDir: text(provider.dataDir, `${label}.dataDir`, 4096),
  }
}

function immutable<T>(value: T): T {
  const cloned = structuredClone(value)
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== 'object' || Object.isFrozen(item)) return
    for (const child of Object.values(item as Record<string, unknown>)) freeze(child)
    Object.freeze(item)
  }
  freeze(cloned)
  return cloned
}

function parseRuntime(
  value: unknown,
  current?: CliProxyProviderRuntimeConfigV1,
): CliProxyProviderRuntimeConfigV1 {
  const config = object(value, 'CLIProxy provider runtime configuration')
  exactKeys(config, ['contract', 'schemaVersion', 'providers'], 'CLIProxy provider runtime configuration')
  if (config.contract !== 'cordisx.cli-proxy-provider-runtime-config/v1' || config.schemaVersion !== 1) {
    throw new TypeError('CLIProxy provider runtime configuration contract/version is unsupported')
  }
  if (!Array.isArray(config.providers) || config.providers.length > 64) {
    throw new TypeError('CLIProxy provider runtime configuration.providers must contain at most 64 items')
  }
  const currentProviders = new Map(current?.providers.map(provider => [provider.id, provider]))
  const providers = config.providers.map((item, index) => {
    const candidate = object(item, `CLIProxy provider runtime configuration.providers[${index}]`)
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
    return runtimeProvider(
      item,
      `CLIProxy provider runtime configuration.providers[${index}]`,
      currentProviders.get(id),
    )
  })
  const ids = new Set<string>()
  for (const provider of providers) {
    if (ids.has(provider.id)) throw new TypeError(`duplicate CLIProxy provider id: ${provider.id}`)
    ids.add(provider.id)
  }
  return immutable({
    contract: 'cordisx.cli-proxy-provider-runtime-config/v1',
    schemaVersion: 1,
    providers,
  })
}

function parseStartup(value: unknown): CliProxyProviderStartupConfigV1 {
  const config = object(value, 'CLIProxy provider startup configuration')
  exactKeys(config, ['contract', 'schemaVersion', 'providers'], 'CLIProxy provider startup configuration')
  if (config.contract !== 'cordisx.cli-proxy-provider-startup-config/v1' || config.schemaVersion !== 1) {
    throw new TypeError('CLIProxy provider startup configuration contract/version is unsupported')
  }
  if (!Array.isArray(config.providers) || config.providers.length > 64) {
    throw new TypeError('CLIProxy provider startup configuration.providers must contain at most 64 items')
  }
  const providers = config.providers.map((item, index) =>
    startupProvider(item, `CLIProxy provider startup configuration.providers[${index}]`)
  )
  const ids = new Set<string>()
  const dataDirs = new Set<string>()
  for (const provider of providers) {
    if (ids.has(provider.id)) throw new TypeError(`duplicate CLIProxy provider startup id: ${provider.id}`)
    ids.add(provider.id)
    const normalizedDataDir = path.normalize(provider.dataDir)
    if (dataDirs.has(normalizedDataDir)) throw new TypeError(`CLIProxy provider ${provider.id} dataDir must be unique`)
    dataDirs.add(normalizedDataDir)
  }
  return immutable({
    contract: 'cordisx.cli-proxy-provider-startup-config/v1',
    schemaVersion: 1,
    providers,
  })
}

export function parseCliProxyProviderRuntimeConfig(value: unknown): CliProxyProviderRuntimeConfigV1 {
  return parseRuntime(value)
}

export function normalizeCliProxyProviderRuntimeMutation(
  value: unknown,
  current: CliProxyProviderRuntimeConfigV1,
): CliProxyProviderRuntimeConfigV1 {
  return parseRuntime(value, current)
}

export function parseCliProxyProviderStartupConfig(value: unknown): CliProxyProviderStartupConfigV1 {
  return parseStartup(value)
}

export function validateCliProxyProviderPlanes(
  runtime: CliProxyProviderRuntimeConfigV1,
  startup: CliProxyProviderStartupConfigV1,
): void {
  const runtimeIds = new Set(runtime.providers.map(provider => provider.id))
  const orphan = startup.providers.find(provider => !runtimeIds.has(provider.id))
  if (orphan !== undefined) {
    throw new TypeError(`CLIProxy startup provider ${orphan.id} has no matching runtime provider`)
  }
}

export function resolveCliProxyProviderConfigs(
  runtime: CliProxyProviderRuntimeConfigV1,
  startup: CliProxyProviderStartupConfigV1,
  options: { readonly rootDir: string; readonly defaultCodexExecutable?: string },
): readonly CliProxyProviderConfig[] {
  validateCliProxyProviderPlanes(runtime, startup)
  const startupById = new Map(startup.providers.map(provider => [provider.id, provider]))
  const roots = new Set<string>()
  return Object.freeze(runtime.providers.map(provider => {
    const nextStart = startupById.get(provider.id)
    const executable = nextStart?.executable ?? options.defaultCodexExecutable ?? 'codex'
    const dataDir = nextStart?.dataDir ?? `providers/${provider.id}/codex-home`
    const codexExecutable = path.isAbsolute(executable) ? executable : path.resolve(options.rootDir, executable)
    const codexHome = path.resolve(options.rootDir, dataDir)
    const normalizedRoot = process.platform === 'win32' ? codexHome.toLowerCase() : codexHome
    if (roots.has(normalizedRoot)) throw new TypeError(`CLIProxy provider ${provider.id} dataDir must be unique`)
    roots.add(normalizedRoot)
    return Object.freeze({
      id: provider.id,
      kind: 'cli-proxy-api' as const,
      displayName: provider.displayName,
      baseUrl: provider.endpoint.baseUrl,
      ...(provider.endpoint.secretRef === undefined ? {} : { credentialRef: provider.endpoint.secretRef }),
      codexExecutable,
      codexHome,
      enabled: provider.enabled,
      timeoutMs: provider.timeoutMs,
      modelMappings: provider.models.mappings,
    })
  }))
}

export function projectCliProxyProviderRuntimeConfig(
  value: CliProxyProviderRuntimeConfigV1,
  secretState: (secretRef: string | undefined) => HostSecretState,
): HostServiceConfigProjection {
  const secrets = value.providers.map((provider, index) => ({
    path: ['providers', String(index), 'endpoint', 'secretRef'],
    set: secretState(provider.endpoint.secretRef) === 'ready',
  }))
  return immutable({
    configuration: {
      contract: 'cordisx.cli-proxy-provider-runtime-config/v1',
      schemaVersion: 1,
      providers: value.providers.map(provider => ({
        id: provider.id,
        displayName: provider.displayName,
        enabled: provider.enabled,
        endpoint: { baseUrl: provider.endpoint.baseUrl },
        models: provider.models,
        timeoutMs: provider.timeoutMs,
      })),
    },
    secrets,
  } as unknown as HostServiceConfigProjection)
}

export function projectCliProxyProviderStartupConfig(
  value: CliProxyProviderStartupConfigV1,
): HostServiceConfigProjection {
  return immutable({ configuration: value as unknown as JsonValue, secrets: [] })
}

export function sourceModelId(
  provider: CliProxyProviderRuntimeEntryV1,
  modelId: string,
): string | undefined {
  const mapping = provider.models.mappings.find(item => item.modelId === modelId)
  return mapping === undefined ? modelId : mapping.enabled ? mapping.sourceModelId : undefined
}

export function projectedModel(
  provider: CliProxyProviderRuntimeEntryV1,
  model: { readonly modelId: string; readonly displayName: string; readonly isDefault: boolean },
): { readonly modelId: string; readonly displayName: string; readonly isDefault: boolean } | undefined {
  const mapping = provider.models.mappings.find(item => item.sourceModelId === model.modelId)
  if (mapping?.enabled === false) return undefined
  return {
    modelId: mapping?.modelId ?? model.modelId,
    displayName: mapping?.displayName ?? model.displayName,
    isDefault: mapping?.isDefault ?? model.isDefault,
  }
}

export const CLI_PROXY_PROVIDER_RUNTIME_CONFIG_INITIAL: CliProxyProviderRuntimeConfigV1 = immutable({
  contract: 'cordisx.cli-proxy-provider-runtime-config/v1',
  schemaVersion: 1,
  providers: [],
})

export const CLI_PROXY_PROVIDER_STARTUP_CONFIG_INITIAL: CliProxyProviderStartupConfigV1 = immutable({
  contract: 'cordisx.cli-proxy-provider-startup-config/v1',
  schemaVersion: 1,
  providers: [],
})

const identitySource = 'https://github.com/cordisx/cordisx/tree/main/packages/cli/src/plugins/cli-proxy-api'

export const CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT: HostServiceConfigContract = Object.freeze({
  identity: Object.freeze({
    source: identitySource,
    pluginId: 'cli-proxy-api',
    serviceId: CLI_PROXY_PROVIDER_RUNTIME_SERVICE_ID,
  }),
  schema: Object.freeze({
    id: CLI_PROXY_PROVIDER_RUNTIME_CONFIG_SCHEMA_V1,
    projection: Object.freeze({
      kind: 'schemastery' as const,
      envelope: schemaEnvelope(CliProxyProviderRuntimeConfigSchema),
    }),
  }),
  configApplies: 'service-restart' as const,
  initialConfiguration: CLI_PROXY_PROVIDER_RUNTIME_CONFIG_INITIAL as unknown as JsonValue,
  parseStored: (value: unknown) => parseCliProxyProviderRuntimeConfig(value) as unknown as JsonValue,
  normalizeMutation: (value: unknown, current: JsonValue) =>
    normalizeCliProxyProviderRuntimeMutation(
      value,
      current as unknown as CliProxyProviderRuntimeConfigV1,
    ) as unknown as JsonValue,
  project: (value: JsonValue, secretState: (secretRef: string | undefined) => HostSecretState) =>
    projectCliProxyProviderRuntimeConfig(
      value as unknown as CliProxyProviderRuntimeConfigV1,
      secretState,
    ),
})

export const CLI_PROXY_PROVIDER_STARTUP_CONFIG_CONTRACT: HostServiceConfigContract = Object.freeze({
  identity: Object.freeze({
    source: identitySource,
    pluginId: 'cli-proxy-api',
    serviceId: CLI_PROXY_PROVIDER_STARTUP_SERVICE_ID,
  }),
  schema: Object.freeze({
    id: CLI_PROXY_PROVIDER_STARTUP_CONFIG_SCHEMA_V1,
    projection: Object.freeze({
      kind: 'schemastery' as const,
      envelope: schemaEnvelope(CliProxyProviderStartupConfigSchema),
    }),
  }),
  configApplies: 'app-restart' as const,
  initialConfiguration: CLI_PROXY_PROVIDER_STARTUP_CONFIG_INITIAL as unknown as JsonValue,
  parseStored: (value: unknown) => parseCliProxyProviderStartupConfig(value) as unknown as JsonValue,
  normalizeMutation: (value: unknown) => parseCliProxyProviderStartupConfig(value) as unknown as JsonValue,
  project: (value: JsonValue) =>
    projectCliProxyProviderStartupConfig(
      value as unknown as CliProxyProviderStartupConfigV1,
    ),
})
