import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { HomeConfigApp, HomeConfigModelServiceProvider, HomeConfigProvider } from '../config/home-config.js'
import type { CodexConfigModelProviderProjection } from './codex-config-model-providers.js'
import type { NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'
import {
  applyCodexProviderTargetPlans,
  readCodexProviderTarget,
} from './provider-profile-sync-codex-target.js'

/**
 * Projects `model-service` provider declarations into each app's own native
 * configuration. A declaration never starts a process: it only adds the
 * provider entry the app reads when it starts.
 */

export const MODEL_SERVICE_PROTOCOLS = ['anthropic-messages', 'openai-responses'] as const

/** Codex reads Responses; every other wire API is exposed as `chat-completions`. */
export function codexWireApiFor(provider: HomeConfigModelServiceProvider): 'responses' | 'chat-completions' {
  return provider.wireApi === 'chat' ? 'chat-completions' : 'responses'
}

/** Claude Code speaks Anthropic Messages only. */
export function claudeSpeaks(provider: HomeConfigModelServiceProvider): boolean {
  return provider.protocols.includes('anthropic-messages')
}

export function codexSpeaks(provider: HomeConfigModelServiceProvider): boolean {
  return provider.protocols.includes('openai-responses')
}

export function modelServicesOf(providers: readonly HomeConfigProvider[]): readonly HomeConfigModelServiceProvider[] {
  return providers.filter((provider): provider is HomeConfigModelServiceProvider => provider.kind === 'model-service')
}

function applies(provider: HomeConfigModelServiceProvider, appId: string): boolean {
  return provider.appliesTo === undefined || provider.appliesTo.includes(appId)
}

const DECLARED_PLUGIN_ID = 'cordisx.model-service'

/** Projects one declaration into the catalog entry shape both apps' selectors read. */
export function declarationCatalogEntry(
  provider: HomeConfigModelServiceProvider,
  appId: string,
): NativeModelProviderCatalogEntry {
  const models = modelsForApp(provider, appId)
  return Object.freeze({
    providerId: provider.id,
    pluginId: DECLARED_PLUGIN_ID,
    title: provider.displayName,
    models: Object.freeze(models.map(id => Object.freeze({ id, label: id, aliases: Object.freeze([]) }))),
    ...(models.length === 0 ? {} : { defaultModelId: models[0] }),
  })
}

/**
 * Adds every enabled declaration to a Codex projection read from `config.toml`.
 *
 * A declaration wins over a native table of the same id: it is the entry the
 * user manages in CordisX, and the native table is the copy a previous launch
 * projected from it.
 */
export function mergeDeclaredIntoCodexProjection(
  projection: CodexConfigModelProviderProjection,
  providers: readonly HomeConfigProvider[],
): CodexConfigModelProviderProjection {
  const declared = servicesForApp(providers, 'codex')
  if (declared.length === 0) return projection
  const declaredIds = new Set(declared.map(provider => provider.id))
  const wireApis = new Map(projection.providerWireApis)
  for (const provider of declared) wireApis.set(provider.id, codexWireApiFor(provider))
  const ids = new Set([...projection.providerIds].filter(id => !declaredIds.has(id)))
  for (const provider of declared) ids.add(provider.id)
  return Object.freeze({
    ...projection,
    providers: Object.freeze([
      ...projection.providers.filter(provider => !declaredIds.has(provider.providerId)),
      ...declared.map(provider => declarationCatalogEntry(provider, 'codex')),
    ]),
    providerIds: ids,
    providerWireApis: wireApis,
  })
}

/** Enabled declarations that both target this app and speak a protocol the app understands. */
export function servicesForApp(
  providers: readonly HomeConfigProvider[],
  appId: string,
): readonly HomeConfigModelServiceProvider[] {
  const speaks = appId === 'claude' ? claudeSpeaks : appId === 'codex' ? codexSpeaks : undefined
  if (speaks === undefined) return Object.freeze([])
  return Object.freeze(
    modelServicesOf(providers)
      .filter(provider => provider.enabled !== false && applies(provider, appId) && speaks(provider)),
  )
}

export function modelsForApp(
  provider: HomeConfigModelServiceProvider,
  appId: string,
): readonly string[] {
  return provider.models?.[appId] ?? []
}

export interface ModelServiceProjectionDiagnostic {
  readonly appId: string
  readonly providerId: string
  readonly code:
    | 'protocol-unsupported'
    | 'app-not-configured'
    | 'codex-config-unavailable'
    | 'codex-config-unwritable'
    | 'no-models'
}

export interface ModelServiceProjectionResult {
  readonly appId: string
  readonly providerIds: readonly string[]
  /** The declaration this projection made the launch default, when one was chosen. */
  readonly selectedProviderId?: string
  readonly diagnostics: readonly ModelServiceProjectionDiagnostic[]
}

/**
 * Sets top-level TOML keys, replacing the value in place and appending the key
 * when the file does not already have it. Keys before the first table only.
 */
function setRootKeys(raw: string, values: Readonly<Record<string, string>>): string {
  const lines = raw.split(/(?<=\n)/u)
  const pending = new Map(Object.entries(values))
  const output: string[] = []
  let inRoot = true
  let lastRootLine = 0
  for (const line of lines) {
    if (/^\s*\[/u.test(line)) inRoot = false
    if (!inRoot) {
      output.push(line)
      continue
    }
    const match = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*=/u.exec(line)
    const key = match?.[2]
    if (key !== undefined && pending.has(key)) {
      const newline = line.endsWith('\n') ? '\n' : ''
      const content = newline === '' ? line : line.slice(0, -1)
      const comment = /\s+#.*$/u.exec(content)?.[0] ?? ''
      output.push(`${match![1]}${key} = ${JSON.stringify(pending.get(key))}${comment}${newline}`)
      pending.delete(key)
    } else {
      output.push(line)
    }
    lastRootLine = output.length
  }
  for (const [key, value] of pending) {
    output.splice(lastRootLine, 0, `${key} = ${JSON.stringify(value)}\n`)
    lastRootLine += 1
  }
  return output.join('')
}

/**
 * Resolves the declaration a launch names. Naming none leaves the app's own
 * default untouched: a projection only ever adds providers, never picks one.
 */
function selectedService(
  applicable: readonly HomeConfigModelServiceProvider[],
  selectedId: string | undefined,
): HomeConfigModelServiceProvider | undefined {
  if (selectedId === undefined) return undefined
  return applicable.find(provider => provider.id === selectedId)
}

/**
 * Writes every enabled `model-service` declaration into `codexHome/config.toml`.
 *
 * Existing provider tables keep their other keys; only the routing and display
 * fields this declaration owns are replaced. When `selectedId` names a
 * declaration, `model_provider` and `model` point at it, so a launch uses that
 * service rather than whichever provider the file already named.
 */
export async function projectModelServicesToCodex(
  providers: readonly HomeConfigProvider[],
  codexHome: string,
  options: { readonly selectedId?: string } = {},
): Promise<ModelServiceProjectionResult> {
  const diagnostics: ModelServiceProjectionDiagnostic[] = []
  const selected = servicesForApp(providers, 'codex')
  const applicable = selected.filter(provider => {
    if (modelsForApp(provider, 'codex').length > 0) return true
    diagnostics.push({ appId: 'codex', providerId: provider.id, code: 'no-models' })
    return false
  })
  for (const provider of modelServicesOf(providers)) {
    if (provider.enabled === false || !applies(provider, 'codex') || codexSpeaks(provider)) continue
    diagnostics.push({ appId: 'codex', providerId: provider.id, code: 'protocol-unsupported' })
  }
  if (applicable.length === 0) {
    return Object.freeze({ appId: 'codex', providerIds: Object.freeze([]), diagnostics: Object.freeze(diagnostics) })
  }

  const target = {
    adapterId: 'codex',
    hostInstanceId: 'model-service-projection',
    profileId: 'default',
    configRoot: codexHome,
  } as const
  const defaulted = selectedService(applicable, options.selectedId)
  let snapshot: Awaited<ReturnType<typeof readCodexProviderTarget>>
  try {
    snapshot = await readCodexProviderTarget(target)
  } catch {
    diagnostics.push({ appId: 'codex', providerId: '*', code: 'codex-config-unavailable' })
    return Object.freeze({ appId: 'codex', providerIds: Object.freeze([]), diagnostics: Object.freeze(diagnostics) })
  }
  const base = snapshot ?? { raw: '', revision: '', config: {}, tables: new Map() }
  let raw: string
  try {
    raw = applyCodexProviderTargetPlans(base as NonNullable<typeof snapshot>, applicable.map(provider => ({
      localProviderId: provider.id,
      apply: ['display', 'routing'] as const,
      desired: {
        display: { name: provider.displayName },
        routing: {
          base_url: provider.baseUrl,
          wire_api: codexWireApiFor(provider),
          env_key: provider.apiKeyEnv,
          requires_openai_auth: false,
        },
      },
    })))
  } catch {
    diagnostics.push({ appId: 'codex', providerId: '*', code: 'codex-config-unwritable' })
    return Object.freeze({ appId: 'codex', providerIds: Object.freeze([]), diagnostics: Object.freeze(diagnostics) })
  }

  if (defaulted !== undefined) {
    const model = modelsForApp(defaulted, 'codex')[0]
    raw = setRootKeys(raw, {
      model_provider: defaulted.id,
      ...(model === undefined ? {} : { model }),
    })
  }

  const file = path.join(codexHome, 'config.toml')
  await mkdir(codexHome, { recursive: true, mode: 0o700 })
  await writeFile(file, raw, { mode: 0o600 })
  return Object.freeze({
    appId: 'codex',
    providerIds: Object.freeze(applicable.map(provider => provider.id)),
    ...(defaulted === undefined ? {} : { selectedProviderId: defaulted.id }),
    diagnostics: Object.freeze(diagnostics),
  })
}

export interface ClaudeConfigLibraryEntry {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly apiKeyEnv: string
  readonly models: readonly string[]
}

/**
 * Builds the Claude `configLibrary` document set for one profile.
 *
 * `configLibrary/<id>.json` holds one provider, and `_meta.json` names the
 * applied one, so a launch reads exactly one entry.
 */
export function buildClaudeConfigLibrary(
  providers: readonly HomeConfigProvider[],
): { readonly entries: readonly ClaudeConfigLibraryEntry[]; readonly meta: { readonly appliedId: string | null } } {
  const entries = servicesForApp(providers, 'claude')
    .filter(provider => modelsForApp(provider, 'claude').length > 0)
    .map(provider => Object.freeze({
      id: provider.id,
      name: provider.displayName,
      baseUrl: provider.baseUrl,
      apiKeyEnv: provider.apiKeyEnv,
      models: Object.freeze([...modelsForApp(provider, 'claude')]),
    }))
  return Object.freeze({ entries: Object.freeze(entries), meta: { appliedId: entries[0]?.id ?? null } })
}

/** One provider as the Claude side shows it: declared here, or already on disk. */
export interface ClaudeProviderCatalogEntry {
  readonly providerId: string
  readonly title: string
  readonly baseUrl?: string
  readonly models: readonly string[]
  /** `declared` is a CordisX model service; `library` is an entry already in Claude's own config. */
  readonly source: 'declared' | 'library'
  readonly applied: boolean
}

interface ClaudeLibraryDocument {
  readonly inferenceGatewayBaseUrl?: unknown
  readonly inferenceGatewayApiKeyEnv?: unknown
  readonly inferenceGatewayApiKey?: unknown
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/**
 * Reads the provider catalog for Claude: the declarations managed in CordisX
 * merged with whatever already sits in Claude's own `configLibrary`.
 *
 * A declaration wins over a library entry of the same id, because the library
 * entry is the copy a previous launch wrote from it. Credentials are never read
 * out: only the environment name, the endpoint, and the applied marker.
 */
export async function readClaudeProviderCatalog(
  providers: readonly HomeConfigProvider[],
  applicationSupportDir: string,
): Promise<readonly ClaudeProviderCatalogEntry[]> {
  const library = path.join(applicationSupportDir, 'configLibrary')
  const meta = await readJson(path.join(library, '_meta.json'))
  const appliedId = meta !== null && typeof meta === 'object' && typeof (meta as { appliedId?: unknown }).appliedId === 'string'
    ? (meta as { appliedId: string }).appliedId
    : undefined
  const entries = meta !== null && typeof meta === 'object' && Array.isArray((meta as { entries?: unknown }).entries)
    ? (meta as { entries: Array<{ id?: unknown; name?: unknown }> }).entries
    : []

  const fromLibrary: ClaudeProviderCatalogEntry[] = []
  for (const entry of entries) {
    if (typeof entry.id !== 'string') continue
    const document = await readJson(path.join(library, `${entry.id}.json`)) as ClaudeLibraryDocument | undefined
    const baseUrl = typeof document?.inferenceGatewayBaseUrl === 'string' ? document.inferenceGatewayBaseUrl : undefined
    fromLibrary.push(Object.freeze({
      providerId: entry.id,
      title: typeof entry.name === 'string' ? entry.name : entry.id,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      models: Object.freeze([]),
      source: 'library' as const,
      applied: entry.id === appliedId,
    }))
  }

  const declared = servicesForApp(providers, 'claude').map(provider =>
    Object.freeze({
      providerId: provider.id,
      title: provider.displayName,
      baseUrl: provider.baseUrl,
      models: Object.freeze([...modelsForApp(provider, 'claude')]),
      source: 'declared' as const,
      applied: provider.id === appliedId,
    })
  )
  const declaredIds = new Set(declared.map(entry => entry.providerId))
  return Object.freeze([
    ...declared,
    ...fromLibrary.filter(entry => !declaredIds.has(entry.providerId)),
  ])
}

/** Writes the Claude configuration library into an application data directory. */
export async function projectModelServicesToClaude(
  providers: readonly HomeConfigProvider[],
  applicationSupportDir: string,
): Promise<ModelServiceProjectionResult> {
  const diagnostics: ModelServiceProjectionDiagnostic[] = []
  const { entries, meta } = buildClaudeConfigLibrary(providers)
  for (const provider of modelServicesOf(providers)) {
    if (provider.enabled === false || !applies(provider, 'claude') || claudeSpeaks(provider)) continue
    diagnostics.push({ appId: 'claude', providerId: provider.id, code: 'protocol-unsupported' })
  }
  if (entries.length === 0) {
    return Object.freeze({ appId: 'claude', providerIds: Object.freeze([]), diagnostics: Object.freeze(diagnostics) })
  }
  const library = path.join(applicationSupportDir, 'configLibrary')
  await mkdir(library, { recursive: true, mode: 0o700 })
  for (const entry of entries) {
    const document = {
      inferenceGatewayBaseUrl: entry.baseUrl,
      inferenceGatewayApiKeyEnv: entry.apiKeyEnv,
      inferenceProvider: 'gateway',
      inferenceCredentialKind: 'static',
    }
    await writeFile(path.join(library, `${entry.id}.json`), `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  }
  const metaDocument = {
    appliedId: meta.appliedId,
    entries: entries.map(entry => ({ id: entry.id, name: entry.name })),
  }
  await writeFile(path.join(library, '_meta.json'), `${JSON.stringify(metaDocument, null, 2)}\n`, { mode: 0o600 })
  return Object.freeze({
    appId: 'claude',
    providerIds: Object.freeze(entries.map(entry => entry.id)),
    diagnostics: Object.freeze(diagnostics),
  })
}

/**
 * Reports the app ids a declaration can reach, so a launch names the apps it
 * actually configured instead of assuming every app.
 */
export function projectableApps(
  provider: HomeConfigModelServiceProvider,
  apps: Readonly<Record<string, HomeConfigApp>>,
): readonly string[] {
  const target = provider.appliesTo ?? Object.keys(apps)
  return Object.freeze(target.filter(appId => Object.hasOwn(apps, appId)))
}



