import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { parse, stringify, type TomlTable, type TomlValue } from 'smol-toml'
import type { NativeManagedGatewayConnection } from './managed-service-native-connection.js'

const TOKEN_ENV = 'CORDISX_NATIVE_MANAGED_TOKEN'
const MANAGED_CONFIG_BEGIN = '# BEGIN CORDISX NATIVE MANAGED CONFIG'
const MANAGED_CONFIG_END = '# END CORDISX NATIVE MANAGED CONFIG'
const MANAGED_PROVIDER_IDS_FILE = '.cordisx-native-managed-provider-ids.json'

interface NativeManagedModelCatalogEntry {
  readonly slug: string
  readonly display_name: string
  readonly description: string
  readonly context_window: number
  readonly max_context_window: number
  readonly input_modalities: readonly ['text']
  readonly supported_in_api: true
  readonly visibility: 'list'
  readonly priority: number
  readonly shell_type: 'shell_command'
  readonly base_instructions: string
  readonly default_reasoning_level: 'medium'
  readonly supported_reasoning_levels: readonly {
    readonly effort: 'low' | 'medium' | 'high'
    readonly description: string
  }[]
  readonly experimental_supported_tools: readonly []
  readonly supports_reasoning_summaries: false
  readonly supports_reasoning_summary_parameter: false
  readonly support_verbosity: false
  readonly supports_parallel_tool_calls: false
  readonly requires_sandboxed_review: false
  readonly truncation_policy: { readonly mode: 'tokens'; readonly limit: 10_000 }
}

export interface NativeManagedDesktopLaunch {
  readonly environment: Readonly<Record<string, string>>
  readonly codexHome: string
  readonly catalogPath: string
  readonly providers: readonly NativeManagedDesktopProviderDescriptor[]
  readonly defaultProviderId?: string
  readonly activeProviderId?: string
  readonly modelIds: readonly string[]
  readonly defaultModelId?: string
  readonly activeModelId?: string
}

export type NativeManagedDesktopCredentialMode = 'environment' | 'private-config'

export interface NativeManagedDesktopSelection {
  readonly providerId: string
  readonly modelId: string
}

export interface NativeManagedDesktopModelDescriptor {
  readonly id: string
  readonly label: string
  readonly aliases: readonly string[]
}

export interface NativeManagedDesktopProviderDescriptor {
  readonly providerId: string
  readonly models: readonly NativeManagedDesktopModelDescriptor[]
  readonly modelIds: readonly string[]
  readonly defaultModelId: string
}

export interface NativeManagedDesktopFiles {
  readonly configToml: string
  readonly catalogJson: string
  readonly environment: Readonly<Record<string, string>>
  readonly providers: readonly NativeManagedDesktopProviderDescriptor[]
  readonly defaultProviderId?: string
  readonly activeProviderId?: string
  /** Legacy first-provider credential. Prefer environment for provider-aware launches. */
  readonly token?: string
  readonly modelIds: readonly string[]
  readonly defaultModelId?: string
  readonly activeModelId?: string
}

export interface NativeManagedDesktopFilesOptions {
  readonly credentialMode?: NativeManagedDesktopCredentialMode
  readonly selection?: NativeManagedDesktopSelection
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function providerTokenEnvironmentKey(providerId: string, index: number): string {
  if (index === 0) return TOKEN_ENV
  const suffix = createHash('sha256').update(providerId).digest('hex').slice(0, 16).toUpperCase()
  return `${TOKEN_ENV}_${suffix}`
}

function endpointBaseUrl(providerId: string, connection: NativeManagedGatewayConnection): string {
  const { origin, apiPath } = connection.endpoint
  let parsedOrigin: URL
  let parsedBaseUrl: URL
  try {
    parsedOrigin = new URL(origin)
    parsedBaseUrl = new URL(apiPath, `${origin}/`)
  } catch {
    throw new Error(`native managed provider ${providerId} has an invalid gateway endpoint`)
  }
  const exactOrigin = parsedOrigin.origin === origin && parsedOrigin.href === `${origin}/`
  const loopback = parsedOrigin.hostname === '127.0.0.1'
    || parsedOrigin.hostname === 'localhost'
    || parsedOrigin.hostname === '[::1]'
  const allowedTransport = parsedOrigin.protocol === 'https:'
    || (parsedOrigin.protocol === 'http:' && loopback)
  const exactPath = parsedBaseUrl.origin === origin
    && parsedBaseUrl.pathname === apiPath
    && parsedBaseUrl.search === ''
    && parsedBaseUrl.hash === ''
  if (!exactOrigin || !allowedTransport || !exactPath) {
    throw new Error(`native managed provider ${providerId} endpoint must be an exact loopback HTTP or HTTPS URL`)
  }
  return parsedBaseUrl.href
}

function modelEntry(providerId: string, alias: string, gatewayModelId: string, priority: number) {
  return Object.freeze({
    slug: gatewayModelId,
    display_name: `${providerId}: ${alias}`,
    description: `CordisX managed ${providerId} model`,
    context_window: 128_000,
    max_context_window: 128_000,
    input_modalities: Object.freeze(['text'] as const),
    supported_in_api: true as const,
    visibility: 'list' as const,
    priority,
    shell_type: 'shell_command' as const,
    base_instructions: 'You are Codex, a coding agent.',
    default_reasoning_level: 'medium' as const,
    supported_reasoning_levels: Object.freeze([
      Object.freeze({ effort: 'low' as const, description: 'Fast responses with lighter reasoning' }),
      Object.freeze({ effort: 'medium' as const, description: 'Balanced reasoning' }),
      Object.freeze({ effort: 'high' as const, description: 'Greater reasoning depth' }),
    ]),
    experimental_supported_tools: Object.freeze([] as const),
    supports_reasoning_summaries: false as const,
    supports_reasoning_summary_parameter: false as const,
    support_verbosity: false as const,
    supports_parallel_tool_calls: false as const,
    requires_sandboxed_review: false as const,
    truncation_policy: Object.freeze({ mode: 'tokens' as const, limit: 10_000 as const }),
  }) satisfies NativeManagedModelCatalogEntry
}

function buildNativeManagedDesktopFiles(
  connections: readonly { readonly providerId: string; readonly connection: NativeManagedGatewayConnection }[],
  catalogPath: string,
  options: NativeManagedDesktopFilesOptions = {},
  preserveUnavailableSelection = false,
): NativeManagedDesktopFiles {
  const first = connections[0]
  const models: NativeManagedModelCatalogEntry[] = []
  const modelIds = new Set<string>()
  const providerIds = new Set<string>()
  const environment: Record<string, string> = {}
  const providerTables: string[] = []
  const providers: NativeManagedDesktopProviderDescriptor[] = []
  let defaultModelId: string | undefined
  for (const [providerIndex, item] of connections.entries()) {
    if (item.providerId.trim() === '' || providerIds.has(item.providerId)) {
      throw new Error(`duplicate or empty native managed provider id: ${item.providerId}`)
    }
    providerIds.add(item.providerId)
    const baseUrl = endpointBaseUrl(item.providerId, item.connection)
    const tokenEnvironmentKey = providerTokenEnvironmentKey(item.providerId, providerIndex)
    const auth = item.connection.endpoint.auth
    if (auth.scheme === 'none' && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname)) {
      throw new Error('Unauthenticated managed providers must use loopback endpoints')
    }
    const credential = auth.scheme === 'none' ? '' : options.credentialMode === 'private-config'
      ? `experimental_bearer_token = ${tomlString(auth.token)}, `
      : `env_key = ${tomlString(tokenEnvironmentKey)}, `
    if (auth.scheme === 'bearer' && options.credentialMode !== 'private-config') {
      environment[tokenEnvironmentKey] = auth.token
    }
    providerTables.push(
      `${tomlString(item.providerId)} = { name = ${tomlString(`CordisX Managed (${item.providerId})`)}, base_url = ${
        tomlString(baseUrl)
      }, ${credential}${auth.scheme === 'none' ? 'requires_openai_auth = false, ' : ''}wire_api = "responses" }`,
    )
    const providerDefault = item.connection.models.aliases.find(alias =>
      alias.alias === item.connection.models.defaultAlias
    )?.gatewayModelId
    if (providerDefault === undefined) {
      throw new Error(`native managed provider ${item.providerId} has no default route`)
    }
    defaultModelId ??= providerDefault
    const providerModels = new Map<string, { label: string; aliases: string[] }>()
    for (const alias of item.connection.models.aliases) {
      const providerModel = providerModels.get(alias.gatewayModelId)
      if (providerModel === undefined) {
        providerModels.set(alias.gatewayModelId, { label: alias.alias, aliases: [alias.alias] })
      } else if (!providerModel.aliases.includes(alias.alias)) {
        providerModel.aliases.push(alias.alias)
      }
      if (!modelIds.has(alias.gatewayModelId)) {
        modelIds.add(alias.gatewayModelId)
        models.push(modelEntry(
          item.providerId,
          alias.alias,
          alias.gatewayModelId,
          alias.gatewayModelId === defaultModelId ? 1 : 0,
        ))
      }
    }
    providers.push(Object.freeze({
      providerId: item.providerId,
      models: Object.freeze([...providerModels].map(([id, model]) =>
        Object.freeze({
          id,
          label: model.label,
          aliases: Object.freeze([...model.aliases]),
        })
      )),
      modelIds: Object.freeze([...providerModels.keys()]),
      defaultModelId: providerDefault,
    }))
  }
  const selectedProvider = options.selection === undefined
    ? undefined
    : providers.find(provider => provider.providerId === options.selection!.providerId)
  const selectionValid = selectedProvider?.modelIds.includes(options.selection!.modelId) === true
  if (options.selection !== undefined && !selectionValid && !preserveUnavailableSelection) {
    throw new Error(
      `native managed selection is unavailable: ${options.selection.providerId}/${options.selection.modelId}`,
    )
  }
  const activeProviderId = options.selection === undefined ? first?.providerId : options.selection.providerId
  const activeModelId = options.selection === undefined ? defaultModelId : options.selection.modelId
  const providerConfiguration = providerTables.length === 0
    ? []
    : [`model_providers = { ${providerTables.join(', ')} }`]
  return Object.freeze({
    configToml: [
      ...(activeModelId === undefined ? [] : [`model = ${tomlString(activeModelId)}`]),
      ...(activeProviderId === undefined ? [] : [`model_provider = ${tomlString(activeProviderId)}`]),
      `model_catalog_json = ${tomlString(path.resolve(catalogPath))}`,
      'check_for_update_on_startup = false',
      ...providerConfiguration,
      'analytics.enabled = false',
      '',
    ].join('\n'),
    catalogJson: `${JSON.stringify({ models })}\n`,
    environment: Object.freeze({ ...environment }),
    providers: Object.freeze(providers),
    ...(first === undefined ? {} : { defaultProviderId: first.providerId }),
    ...(activeProviderId === undefined ? {} : { activeProviderId }),
    ...(first?.connection.endpoint.auth.scheme === 'bearer' ? { token: first.connection.endpoint.auth.token } : {}),
    modelIds: Object.freeze([...modelIds]),
    ...(defaultModelId === undefined ? {} : { defaultModelId }),
    ...(activeModelId === undefined ? {} : { activeModelId }),
  })
}

export function nativeManagedDesktopFiles(
  connections: readonly { readonly providerId: string; readonly connection: NativeManagedGatewayConnection }[],
  catalogPath: string,
  options: NativeManagedDesktopFilesOptions = {},
): NativeManagedDesktopFiles {
  return buildNativeManagedDesktopFiles(connections, catalogPath, options)
}

async function privateWrite(file: string, value: string): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temporary, value, { mode: 0o600 })
  await rename(temporary, file)
  if (process.platform !== 'win32') await chmod(file, 0o600)
}

function tomlTable(value: TomlValue | undefined): TomlTable | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
    ? value as TomlTable
    : undefined
}

function generatedSelection(config: TomlTable): NativeManagedDesktopSelection | undefined {
  const model = config.model
  const providerId = config.model_provider
  return typeof model === 'string' && typeof providerId === 'string' ? { providerId, modelId: model } : undefined
}

function providerIds(value: TomlValue | undefined): readonly string[] {
  return Object.keys(tomlTable(value) ?? {})
}

function legacyManagedProviderIds(source: string, config: TomlTable): readonly string[] {
  const begin = source.indexOf(MANAGED_CONFIG_BEGIN)
  const end = source.indexOf(MANAGED_CONFIG_END, begin + MANAGED_CONFIG_BEGIN.length)
  if (begin !== -1 && end > begin) {
    const managed = parse(source.slice(begin + MANAGED_CONFIG_BEGIN.length, end))
    return providerIds(managed.model_providers)
  }
  const providers = tomlTable(config.model_providers)
  return providers === undefined
    ? []
    : Object.entries(providers)
      .filter(([providerId, provider]) => tomlTable(provider)?.name === `CordisX Managed (${providerId})`)
      .map(([providerId]) => providerId)
}

function mergeNativeManagedConfig(
  existing: TomlTable,
  generated: TomlTable,
  previousManagedProviderIds: readonly string[],
): string {
  const previousProviders = tomlTable(existing.model_providers)
  const generatedProviders = tomlTable(generated.model_providers)
  const managedProviderIds = new Set(previousManagedProviderIds)
  const preservedProviders = previousProviders === undefined
    ? {}
    : Object.fromEntries(
      Object.entries(previousProviders).filter(([providerId]) => !managedProviderIds.has(providerId)),
    )
  const previousAnalytics = tomlTable(existing.analytics)
  const generatedAnalytics = tomlTable(generated.analytics)

  delete existing.model
  delete existing.model_provider
  delete existing.model_catalog_json
  delete existing.check_for_update_on_startup
  delete existing.model_providers
  delete existing.analytics

  return stringify({
    ...existing,
    ...generated,
    ...(generatedProviders === undefined
      ? Object.keys(preservedProviders).length === 0 ? {} : { model_providers: preservedProviders }
      : { model_providers: { ...preservedProviders, ...generatedProviders } }),
    ...(previousAnalytics === undefined && generatedAnalytics === undefined
      ? {}
      : { analytics: { ...previousAnalytics, ...generatedAnalytics } }),
  })
}

async function readManagedProviderIds(codexHome: string, source: string, config: TomlTable) {
  const file = path.join(codexHome, MANAGED_PROVIDER_IDS_FILE)
  const serialized = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (serialized === undefined) return legacyManagedProviderIds(source, config)
  try {
    const value = JSON.parse(serialized) as unknown
    if (Array.isArray(value) && value.every(providerId => typeof providerId === 'string')) return value
  } catch {
    // A corrupt private sidecar falls back to migration evidence in config.toml.
  }
  return legacyManagedProviderIds(source, config)
}

const nativeManagedDesktopWrites = new Map<string, Promise<unknown>>()

async function serializedNativeManagedDesktopWrite<Result>(
  codexHome: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const previous = nativeManagedDesktopWrites.get(codexHome) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  nativeManagedDesktopWrites.set(codexHome, current)
  try {
    return await current
  } finally {
    if (nativeManagedDesktopWrites.get(codexHome) === current) nativeManagedDesktopWrites.delete(codexHome)
  }
}

async function writeNativeManagedDesktopFiles(
  codexHome: string,
  connections: readonly { readonly providerId: string; readonly connection: NativeManagedGatewayConnection }[],
  options: NativeManagedDesktopFilesOptions,
): Promise<NativeManagedDesktopFiles> {
  return await serializedNativeManagedDesktopWrite(codexHome, async () => {
    const catalogPath = path.join(codexHome, 'models.json')
    const configPath = path.join(codexHome, 'config.toml')
    const existingConfig = await readFile(configPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    const existing = parse(existingConfig)
    const previousManagedProviderIds = await readManagedProviderIds(codexHome, existingConfig, existing)
    const existingSelection = options.selection ?? generatedSelection(existing)
    const generated = buildNativeManagedDesktopFiles(
      connections,
      catalogPath,
      {
        ...(options.credentialMode === undefined ? {} : { credentialMode: options.credentialMode }),
        ...(existingSelection === undefined ? {} : { selection: existingSelection }),
      },
      options.selection === undefined && existingSelection !== undefined,
    )
    const files = Object.freeze({
      ...generated,
      configToml: mergeNativeManagedConfig(existing, parse(generated.configToml), previousManagedProviderIds),
    })
    await privateWrite(catalogPath, files.catalogJson)
    await privateWrite(configPath, files.configToml)
    await privateWrite(
      path.join(codexHome, MANAGED_PROVIDER_IDS_FILE),
      `${JSON.stringify(files.providers.map(provider => provider.providerId))}\n`,
    )
    return files
  })
}

export async function refreshNativeManagedDesktop(input: {
  readonly codexHome: string
  readonly connections: readonly { readonly providerId: string; readonly connection: NativeManagedGatewayConnection }[]
  readonly credentialMode?: NativeManagedDesktopCredentialMode
  readonly selection?: NativeManagedDesktopSelection
}): Promise<NativeManagedDesktopLaunch> {
  const files = await writeNativeManagedDesktopFiles(input.codexHome, input.connections, {
    ...(input.credentialMode === undefined ? {} : { credentialMode: input.credentialMode }),
    ...(input.selection === undefined ? {} : { selection: input.selection }),
  })
  return Object.freeze({
    environment: Object.freeze({ CODEX_HOME: input.codexHome, ...files.environment }),
    codexHome: input.codexHome,
    catalogPath: path.join(input.codexHome, 'models.json'),
    providers: files.providers,
    ...(files.defaultProviderId === undefined ? {} : { defaultProviderId: files.defaultProviderId }),
    ...(files.activeProviderId === undefined ? {} : { activeProviderId: files.activeProviderId }),
    modelIds: files.modelIds,
    ...(files.defaultModelId === undefined ? {} : { defaultModelId: files.defaultModelId }),
    ...(files.activeModelId === undefined ? {} : { activeModelId: files.activeModelId }),
  })
}

async function snapshotCodexAuth(sourceCodexHome: string, codexHome: string): Promise<void> {
  const source = path.join(sourceCodexHome, 'auth.json')
  const destination = path.join(codexHome, 'auth.json')
  const sourceMetadata = await lstat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (sourceMetadata === undefined) {
    await rm(destination, { force: true })
    return
  }
  const resolvedSource = sourceMetadata.isSymbolicLink() ? await realpath(source) : source
  if (!(await stat(resolvedSource)).isFile()) {
    throw new Error(`Codex auth source is not a regular file: ${source}`)
  }
  const temporary = `${destination}.tmp-${process.pid}`
  await copyFile(resolvedSource, temporary)
  if (process.platform !== 'win32') await chmod(temporary, 0o600)
  await rename(temporary, destination)
  if (process.platform !== 'win32') await chmod(destination, 0o600)
}

export async function prepareNativeManagedDesktop(input: {
  readonly homeDir: string
  readonly profileId: string
  readonly sourceCodexHome: string
  readonly connections: readonly { readonly providerId: string; readonly connection: NativeManagedGatewayConnection }[]
  readonly credentialMode?: NativeManagedDesktopCredentialMode
}): Promise<NativeManagedDesktopLaunch> {
  const codexHome = path.join(input.homeDir, 'apps', 'codex', 'profiles', input.profileId, 'native-managed-codex-home')
  await mkdir(codexHome, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(codexHome, 0o700)
  const catalogPath = path.join(codexHome, 'models.json')
  const files = await writeNativeManagedDesktopFiles(
    codexHome,
    input.connections,
    input.credentialMode === undefined
      ? {}
      : { credentialMode: input.credentialMode },
  )
  await snapshotCodexAuth(input.sourceCodexHome, codexHome)
  return Object.freeze({
    environment: Object.freeze({ CODEX_HOME: codexHome, ...files.environment }),
    codexHome,
    catalogPath,
    providers: files.providers,
    ...(files.defaultProviderId === undefined ? {} : { defaultProviderId: files.defaultProviderId }),
    ...(files.activeProviderId === undefined ? {} : { activeProviderId: files.activeProviderId }),
    modelIds: files.modelIds,
    ...(files.defaultModelId === undefined ? {} : { defaultModelId: files.defaultModelId }),
    ...(files.activeModelId === undefined ? {} : { activeModelId: files.activeModelId }),
  })
}
