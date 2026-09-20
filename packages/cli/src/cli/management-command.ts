import path from 'node:path'
import os from 'node:os'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { Readable, Writable } from 'node:stream'
import {
  createDefaultHomeConfig,
  ensureHomeConfig,
  type HomeConfig,
  type HomeConfigPathOptions,
  loadHomeConfig,
  resolveHomeConfigPath,
} from '../config/home-config.js'
import { supportsTrustedMarketplaceSource } from '../config/home-config-marketplace.js'
import type {
  PluginManagementCatalogDetail,
  PluginManagementCatalogIdentity,
  PluginManagementCatalogQuery,
  PluginManagementCatalogSnapshot,
  PluginManagementCatalogSummary,
  PluginManagementRequest,
  PluginManagementResult,
  PluginManagementSnapshot,
  PluginManagementSource,
  PluginManagementSourceInput,
  PluginManagementSourceLocal,
} from '../management/contracts.js'
import type { PluginManagementService } from '../management/service.js'
import { resolveMarketplaceSourceReference } from '../management/source-reference.js'
import { confirmManagementMutation } from './management-confirmation.js'
import { openCliPluginManagementClient } from './management-client.js'
import { PLUGIN_MANAGEMENT_HELP, SOURCE_MANAGEMENT_HELP } from './management-help.js'
import type {
  CordisXManagementInvocation,
  CordisXPluginManagementInvocation,
  CordisXSourceManagementInvocation,
} from './management-parse.js'
import { resolveProfileSelection } from './profiles.js'

export interface OpenManagementCommandServiceInput {
  readonly configPath: string
  readonly profileId: string
  readonly homeDir: string
  readonly env: NodeJS.ProcessEnv
}

export type OpenManagementCommandService = (
  input: OpenManagementCommandServiceInput,
) => Promise<PluginManagementService>

export interface ManagementCommandRuntime {
  readonly env?: NodeJS.ProcessEnv
  readonly homedir?: string
  readonly stdout?: (line: string) => void
  readonly stdin?: Readable & { readonly isTTY?: boolean }
  readonly stderr?: Writable
  readonly internalManagementConfirm?: (prompt: string) => boolean | Promise<boolean>
  readonly internalOpenPluginManagementService?: OpenManagementCommandService
}

export class CordisXManagementCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 1,
    readonly reported = false,
  ) {
    super(message)
    this.name = 'CordisXManagementCommandError'
  }
}

function catalogQuery(
  invocation: CordisXPluginManagementInvocation,
  sourceUrl?: string,
): PluginManagementCatalogQuery {
  return {
    ...(invocation.query === undefined ? {} : { query: invocation.query }),
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    ...(invocation.version === undefined ? {} : { version: invocation.version }),
    ...(invocation.includeHidden === true ? { includeHidden: true } : {}),
  }
}

function catalogIdentity(
  invocation: CordisXPluginManagementInvocation,
  detail: PluginManagementCatalogDetail,
  sourceUrl?: string,
): PluginManagementCatalogIdentity {
  if (invocation.target === undefined) throw new Error('plugin id is required')
  return {
    sourceUrl: sourceUrl ?? detail.identity.sourceUrl,
    pluginId: invocation.target,
  }
}

async function pluginRequest(
  invocation: CordisXPluginManagementInvocation,
  service: PluginManagementService,
): Promise<PluginManagementRequest> {
  if (invocation.target === undefined) throw new Error('plugin id is required')
  const sourceUrl = await resolvePluginSourceReference(service, invocation.source)
  if (invocation.command === 'install' || invocation.command === 'update') {
    return {
      kind: 'plugin-plan-marketplace',
      pluginId: invocation.target,
      ...(sourceUrl === undefined ? {} : { sourceUrl }),
      ...(invocation.version === undefined ? {} : { version: invocation.version }),
    }
  }
  if (invocation.command === 'enable') return { kind: 'plugin-enable', pluginId: invocation.target }
  if (invocation.command === 'disable') return { kind: 'plugin-disable', pluginId: invocation.target }
  if (invocation.command === 'uninstall') return { kind: 'plugin-uninstall', pluginId: invocation.target }
  if (invocation.command === 'hide' || invocation.command === 'unhide') {
    if (invocation.command === 'unhide') {
      const snapshot = await service.query()
      const matches = snapshot.hiddenCatalogEntries.filter(identity =>
        identity.pluginId === invocation.target
        && (sourceUrl === undefined || identity.sourceUrl === sourceUrl)
      )
      if (matches.length === 0) {
        throw new CordisXManagementCommandError(
          'not-found',
          `hidden marketplace plugin was not found: ${invocation.target}`,
        )
      }
      if (matches.length > 1) {
        throw new CordisXManagementCommandError(
          'ambiguous-selection',
          `hidden marketplace plugin selection is ambiguous; specify --source: ${invocation.target}`,
        )
      }
      return { kind: 'catalog-unhide', identity: matches[0]! }
    }
    const detail = await service.pluginInfo({
      pluginId: invocation.target,
      ...(sourceUrl === undefined ? {} : { sourceUrl }),
    })
    if (detail === undefined) throw new Error(`marketplace plugin was not found: ${invocation.target}`)
    return {
      kind: invocation.command === 'hide' ? 'catalog-hide' : 'catalog-unhide',
      identity: catalogIdentity(invocation, detail, sourceUrl),
    }
  }
  throw new Error(`plugin command is not a mutation: ${invocation.command}`)
}

function canonicalUrl(value: string): string {
  return new URL(value).href
}

async function resolvePluginSourceReference(
  service: PluginManagementService,
  reference: string | undefined,
): Promise<string | undefined> {
  if (reference === undefined) return undefined
  try {
    const url = new URL(reference)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href
  } catch { /* non-URL values are resolved as Host-owned source names */ }
  return resolveMarketplaceSourceReference((await service.query()).sources, reference)
}

function sourceLocal(invocation: CordisXSourceManagementInvocation): PluginManagementSourceLocal | undefined {
  const local = {
    ...(invocation.name === undefined || invocation.name === '' ? {} : { name: invocation.name }),
    ...(invocation.description === undefined || invocation.description === ''
      ? {}
      : { description: invocation.description }),
  }
  return Object.keys(local).length === 0 ? undefined : local
}

function editedSource(
  invocation: CordisXSourceManagementInvocation,
  current: PluginManagementSource,
): PluginManagementSourceInput {
  const currentLocal = current.local
  const local = {
    ...currentLocal,
    ...(invocation.name === undefined ? {} : invocation.name === '' ? { name: undefined } : { name: invocation.name }),
    ...(invocation.description === undefined
      ? {}
      : invocation.description === ''
      ? { description: undefined }
      : { description: invocation.description }),
  }
  const definedLocal: PluginManagementSourceLocal = Object.fromEntries(
    Object.entries(local).filter(([, value]) => value !== undefined),
  )
  return {
    url: invocation.url ?? current.url,
    enabled: current.enabled,
    trusted: invocation.trusted ?? current.trusted,
    ...(Object.keys(definedLocal).length === 0 ? {} : { local: definedLocal }),
  }
}

async function sourceRequest(
  invocation: CordisXSourceManagementInvocation,
  service: PluginManagementService,
): Promise<PluginManagementRequest> {
  if (invocation.command === 'add') {
    if (invocation.url === undefined) throw new Error('source URL is required')
    if (invocation.trusted === true && !supportsTrustedMarketplaceSource(invocation.url)) {
      throw new Error('marketplace source URL must be HTTPS without a query when trusted')
    }
    const local = sourceLocal(invocation)
    return {
      kind: 'source-add',
      source: {
        url: invocation.url,
        enabled: true,
        trusted: invocation.trusted ?? supportsTrustedMarketplaceSource(invocation.url),
        ...(local === undefined ? {} : { local }),
      },
    }
  }
  if (invocation.target === undefined) throw new Error('source URL is required')
  const target = canonicalUrl(invocation.target)
  if (invocation.command === 'edit') {
    const snapshot = await service.query()
    const current = snapshot.sources.find(source => source.url === target)
    if (current === undefined) throw new Error(`marketplace source was not found: ${target}`)
    return { kind: 'source-edit', url: target, source: editedSource(invocation, current) }
  }
  if (invocation.command === 'enable' || invocation.command === 'disable') {
    return { kind: 'source-set-enabled', url: target, enabled: invocation.command === 'enable' }
  }
  if (invocation.command === 'remove') return { kind: 'source-remove', url: target }
  throw new Error(`source command is not a mutation: ${invocation.command}`)
}

function mutationPrompt(invocation: CordisXManagementInvocation, planned: PluginManagementResult): string {
  const target = 'target' in invocation && invocation.target !== undefined
    ? invocation.target
    : 'url' in invocation && invocation.url !== undefined
    ? invocation.url
    : ''
  const affected = planned.status === 'planned' && planned.affectedPluginIds !== undefined
    ? ` This also affects: ${planned.affectedPluginIds.join(', ')}.`
    : ''
  return `Apply cordisx ${invocation.namespace} ${invocation.command}${
    target === '' ? '' : ` for ${target}`
  }?${affected}`
}

function resultError(result: PluginManagementResult): Error | undefined {
  if (result.status !== 'rejected' && result.status !== 'conflict') return undefined
  return new CordisXManagementCommandError(result.error.code, result.error.message)
}

async function runMutation(
  invocation: Exclude<CordisXManagementInvocation, { readonly command: 'help' }>,
  service: PluginManagementService,
  runtime: ManagementCommandRuntime,
  request: PluginManagementRequest,
): Promise<PluginManagementResult | { readonly status: 'cancelled'; readonly request: PluginManagementRequest }> {
  const planned = await service.plan(request)
  const planError = resultError(planned)
  if (planError !== undefined) throw planError
  if (invocation.options.dryRun || planned.status === 'permission-review-required') return planned
  if (planned.status !== 'planned') return planned
  if (!invocation.options.yes) {
    const confirmed = await confirmManagementMutation(mutationPrompt(invocation, planned), {
      ...(runtime.stdin === undefined ? {} : { stdin: runtime.stdin }),
      ...(runtime.stderr === undefined ? {} : { stderr: runtime.stderr }),
      ...(runtime.internalManagementConfirm === undefined ? {} : { confirm: runtime.internalManagementConfirm }),
    })
    if (!confirmed) return { status: 'cancelled', request: planned.request }
  }
  if (planned.executionRequest === undefined) {
    throw new Error('plugin management plan did not provide an executable request')
  }
  const result = await service.execute(planned.executionRequest, planned.snapshot.revision)
  const executionError = resultError(result)
  if (executionError !== undefined) throw executionError
  return result
}

function printJson(stdout: (line: string) => void, value: unknown): void {
  stdout(JSON.stringify(value))
}

function errorCode(error: unknown): string {
  if (error instanceof CordisXManagementCommandError) return error.code
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code
  return 'management-command-failed'
}

function printPluginList(stdout: (line: string) => void, snapshot: PluginManagementSnapshot): void {
  stdout(`Profile ${snapshot.profileId}: ${snapshot.plugins.length} installed plugin(s)`)
  for (const plugin of snapshot.plugins) {
    stdout(`${plugin.enabled ? 'enabled ' : 'disabled'}  ${plugin.id}@${plugin.version}  ${plugin.status}`)
  }
}

function printCatalog(stdout: (line: string) => void, plugins: readonly PluginManagementCatalogSummary[]): void {
  stdout(`${plugins.length} plugin(s) found`)
  for (const plugin of plugins) {
    stdout(
      `${plugin.hidden ? 'hidden   ' : 'available'}  ${plugin.identity.pluginId}@${plugin.version}  ${plugin.name}`,
    )
  }
}

function printPluginInfo(stdout: (line: string) => void, plugin: PluginManagementCatalogDetail): void {
  stdout(`${plugin.name} (${plugin.identity.pluginId})`)
  stdout(`Version: ${plugin.version}`)
  stdout(`Source: ${plugin.identity.sourceUrl}`)
  stdout(`Installable: ${plugin.installable ? 'yes' : 'no'}`)
  stdout(plugin.description)
}

function printSources(stdout: (line: string) => void, snapshot: PluginManagementSnapshot): void {
  stdout(`Profile ${snapshot.profileId}: ${snapshot.sources.length} discovery source(s)`)
  for (const source of snapshot.sources) {
    const name = source.local?.name === undefined ? '' : `  ${source.local.name}`
    stdout(
      `${source.enabled ? 'enabled ' : 'disabled'}  ${
        source.trusted ? 'trusted  ' : 'untrusted'
      }  ${source.url}${name}`,
    )
  }
}

function printCatalogRefresh(stdout: (line: string) => void, snapshot: PluginManagementCatalogSnapshot): void {
  stdout(`Catalog refreshed: ${snapshot.plugins.length} plugin(s)`)
  for (const source of snapshot.sources) {
    stdout(`${source.status.padEnd(8)}  ${source.url}${source.error === undefined ? '' : `  ${source.error}`}`)
  }
}

function printMutationResult(
  stdout: (line: string) => void,
  result: Awaited<ReturnType<typeof runMutation>>,
): void {
  if (result.status === 'cancelled') {
    stdout('Cancelled; no management change was applied.')
    return
  }
  if (result.status === 'permission-review-required') {
    stdout('Permission review required; no plugin permissions were approved by this command.')
    stdout(`Candidate: ${result.candidateId}`)
    throw new CordisXManagementCommandError(
      'permission-review-required',
      'Plugin permission review is required before this operation can be applied.',
      2,
      true,
    )
  }
  if (result.status === 'planned') {
    stdout(`Dry run: ${result.request.kind} is ready to execute.`)
    return
  }
  if (result.status === 'applied') {
    stdout(`Applied: ${result.request.kind}${result.pendingActivation ? ' (runtime activation pending)' : ''}`)
    return
  }
  const error = resultError(result)
  if (error !== undefined) throw error
}

interface ManagementConfigContext {
  readonly config: HomeConfig
  readonly configPath: string
  readonly homeDir: string
  readonly cleanup: () => Promise<void>
}

async function managementConfigContext(
  invocation: CordisXManagementInvocation,
  options: HomeConfigPathOptions,
): Promise<ManagementConfigContext> {
  const configPath = resolveHomeConfigPath(options)
  const homeDir = path.dirname(configPath)
  let config: HomeConfig
  let missing = false
  if (invocation.options.dryRun) {
    try {
      config = await loadHomeConfig(options)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      config = createDefaultHomeConfig()
      missing = true
    }
  } else {
    config = await ensureHomeConfig(options)
  }
  const selection = await resolveProfileSelection({
    config,
    configPath,
    ...(invocation.options.profile === undefined ? {} : { profileId: invocation.options.profile }),
    ...(invocation.options.dryRun ? { persistMissing: false } : {}),
  })
  if (!invocation.options.dryRun || (!missing && !selection.created)) {
    return { config: selection.config, configPath, homeDir, cleanup: async () => {} }
  }
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), 'cordisx-management-dry-run-'))
  const temporaryConfigPath = path.join(temporaryHome, 'config.json')
  await mkdir(temporaryHome, { recursive: true, mode: 0o700 })
  await writeFile(temporaryConfigPath, `${JSON.stringify(selection.config, null, 2)}\n`, { mode: 0o600 })
  return {
    config: selection.config,
    configPath: temporaryConfigPath,
    homeDir: temporaryHome,
    cleanup: async () => await rm(temporaryHome, { recursive: true, force: true }),
  }
}

async function openService(
  runtime: ManagementCommandRuntime,
  input: OpenManagementCommandServiceInput,
): Promise<PluginManagementService> {
  if (runtime.internalOpenPluginManagementService !== undefined) {
    return await runtime.internalOpenPluginManagementService(input)
  }
  return await openCliPluginManagementClient({
    configPath: input.configPath,
    profileId: input.profileId,
    homeDir: input.homeDir,
    env: input.env,
  })
}

export async function runManagementCommand(
  invocation: CordisXManagementInvocation,
  runtime: ManagementCommandRuntime,
): Promise<void> {
  const stdout = runtime.stdout ?? console.log
  if (invocation.command === 'help') {
    stdout(invocation.namespace === 'plugin' ? PLUGIN_MANAGEMENT_HELP : SOURCE_MANAGEMENT_HELP)
    return
  }
  const environment = runtime.env ?? process.env
  const homeConfigOptions: HomeConfigPathOptions = {
    env: environment,
    ...(runtime.homedir === undefined ? {} : { homedir: runtime.homedir }),
  }
  let context: ManagementConfigContext | undefined
  let service: PluginManagementService | undefined
  try {
    context = await managementConfigContext(invocation, homeConfigOptions)
    const selection = await resolveProfileSelection({
      config: context.config,
      configPath: context.configPath,
      ...(invocation.options.profile === undefined ? {} : { profileId: invocation.options.profile }),
      persistMissing: false,
    })
    service = await openService(runtime, {
      configPath: context.configPath,
      profileId: selection.profileId,
      homeDir: context.homeDir,
      env: environment,
    })
    if (invocation.namespace === 'plugin') {
      if (invocation.command === 'list') {
        const snapshot = await service.query()
        invocation.options.json ? printJson(stdout, snapshot) : printPluginList(stdout, snapshot)
        return
      }
      if (invocation.command === 'search') {
        const sourceUrl = await resolvePluginSourceReference(service, invocation.source)
        const result = await service.queryCatalog(catalogQuery(invocation, sourceUrl))
        invocation.options.json ? printJson(stdout, result) : printCatalog(stdout, result)
        return
      }
      if (invocation.command === 'info') {
        if (invocation.target === undefined) throw new Error('plugin id is required')
        const sourceUrl = await resolvePluginSourceReference(service, invocation.source)
        const detail = await service.pluginInfo({
          pluginId: invocation.target,
          ...(sourceUrl === undefined ? {} : { sourceUrl }),
          ...(invocation.version === undefined ? {} : { version: invocation.version }),
        })
        if (detail === undefined) throw new Error(`marketplace plugin was not found: ${invocation.target}`)
        invocation.options.json ? printJson(stdout, detail) : printPluginInfo(stdout, detail)
        return
      }
      const result = await runMutation(invocation, service, runtime, await pluginRequest(invocation, service))
      if (invocation.options.json) printJson(stdout, result)
      else printMutationResult(stdout, result)
      if (result.status === 'permission-review-required') {
        throw new CordisXManagementCommandError(
          'permission-review-required',
          'Plugin permission review is required before this operation can be applied.',
          2,
          true,
        )
      }
      return
    }
    if (invocation.command === 'list') {
      const snapshot = await service.query()
      invocation.options.json ? printJson(stdout, snapshot) : printSources(stdout, snapshot)
      return
    }
    if (invocation.command === 'refresh') {
      const result = invocation.target === undefined
        ? await service.refreshCatalog()
        : await service.refreshCatalog(canonicalUrl(invocation.target))
      invocation.options.json ? printJson(stdout, result) : printCatalogRefresh(stdout, result)
      return
    }
    const result = await runMutation(invocation, service, runtime, await sourceRequest(invocation, service))
    if (invocation.options.json) printJson(stdout, result)
    else printMutationResult(stdout, result)
  } catch (error) {
    if (error instanceof CordisXManagementCommandError && error.reported) throw error
    if (invocation.options.json) {
      const message = error instanceof Error ? error.message : String(error)
      printJson(stdout, { status: 'error', error: { code: errorCode(error), message } })
      throw new CordisXManagementCommandError(errorCode(error), message, 1, true)
    }
    throw error
  } finally {
    service?.close()
    await context?.cleanup()
  }
}
