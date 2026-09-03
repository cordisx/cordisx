import { randomBytes } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildRendererBundle,
  buildRendererCompositionSource,
  type RendererCompositionSource,
} from '../launcher/bundle.js'
import { loadConfig, type CordisXConfig } from '../launcher/config.js'
import { buildLocalDevelopmentPlugin } from '../launcher/development.js'
import {
  PlaygroundAgentSessionStore,
  type PlaygroundAgentSessionStoreRequest,
} from './agent-session-store.js'
import {
  configBridgeError,
  createConfigBridgeHandler,
  parseConfigBindingRequest,
  type ConfigBridgeHandler,
} from '../launcher/config-rpc.js'
import { createChannelCredentialBridgeHandler, type ChannelCredentialBridgeHandler } from '../launcher/channel-credential-rpc.js'
import { createChannelHostServiceConfigContract, projectLocalChannelManager } from '../launcher/channel-service.js'
import { HostServiceConfigNarrowApi } from '../launcher/service-config.js'
import {
  createServiceConfigBridgeHandler,
  parseServiceConfigBindingRequest,
  serviceConfigBridgeError,
  type ServiceConfigBridgeHandler,
} from '../launcher/service-config-rpc.js'
import { LauncherKeychainError, LauncherSecretStore, type LauncherKeychainBackend } from '../launcher/secret-store.js'
import {
  handleProviderBindingRequest,
  MAX_PROVIDER_REQUEST_BYTES,
  MAX_PROVIDER_REQUESTS,
  parseProviderBindingRequest,
} from '../launcher/provider-rpc.js'
import {
  normalizePersistedPermissionPolicyRecord,
  type CordisXPersistedPermissionPolicyRecord,
} from '../permission-persistence.js'
import { resolveLocalCodexProviderConfig } from '../providers/config.js'
import type { CodexProviderConfig } from '../providers/contracts.js'
import { ProviderFleet } from '../providers/fleet.js'
import type { ChannelManagerProjectionV1 } from '../renderer/channel-manager.js'
import { OwnerDocumentStore } from '../launcher/owner-document-store.js'
import {
  createOwnerDocumentBridgeHandler,
  entityInstallationId,
  OwnerDocumentLeaseRegistry,
  ownerDocumentBridgeError,
  parseOwnerDocumentBindingRequest,
  type OwnerDocumentBridgeHandler,
} from '../launcher/owner-document-rpc.js'
import { EntityDirectoryAuthority } from '../launcher/entity-directory.js'
import { createEntityBridgeHandler, isEntityBindingRequest } from '../launcher/entity-rpc.js'

export interface PlaygroundFixtureInfo {
  readonly name: string
  readonly source: string
  readonly reviewNavigationItem?: string
}

interface PlaygroundGeneration {
  readonly generation: string
  readonly token: string
  readonly agentSessionStoreToken: string
  readonly config: CordisXConfig
  readonly localDevelopmentWatchFiles: readonly string[]
  readonly permissionPolicies: readonly CordisXPersistedPermissionPolicyRecord[]
  readonly bridge: ConfigBridgeHandler
  readonly documents: OwnerDocumentBridgeHandler
  readonly documentSecret: string
  readonly serviceConfig?: ServiceConfigBridgeHandler
  readonly credential?: ChannelCredentialBridgeHandler
  readonly channelConfig?: HostServiceConfigNarrowApi
  readonly channelManager?: ChannelManagerProjectionV1
  readonly providerFleet?: ProviderFleet
  readonly providerToken?: string
}

export interface PreparedPlaygroundComposition extends RendererCompositionSource {
  readonly generation: string
}

export interface PlaygroundSession {
  readonly configPath: string
  readonly fixture: PlaygroundFixtureInfo
  readonly homeDir: string
  buildBundle(): Promise<{ readonly generation: string; readonly source: string }>
  buildComposition(runtimeImport: string): Promise<PreparedPlaygroundComposition>
  handleConfigRequest(raw: string): Promise<unknown>
  handleAgentSessionStoreRequest(raw: string): Promise<unknown>
  handleOwnerDocumentRequest(raw: string): Promise<unknown>
  handleServiceConfigRequest(raw: string): Promise<unknown>
  handleChannelCredentialRequest(raw: string): Promise<unknown>
  handleProviderRequest(raw: string): Promise<unknown>
  reset(): Promise<void>
  close(): Promise<void>
}

export interface PlaygroundSessionOptions {
  /** Explicit external isolated home. The caller, not the session, owns its lifecycle. */
  readonly homeDir?: string
}

class PlaygroundCredentialBackend implements LauncherKeychainBackend {
  private readonly values = new Map<string, string>()

  private key(service: string, account: string): string { return `${service}\u0000${account}` }
  async read(service: string, account: string): Promise<string> {
    const value = this.values.get(this.key(service, account))
    if (value === undefined) throw new LauncherKeychainError('MISSING')
    return value
  }
  async upsert(service: string, account: string, value: string): Promise<void> { this.values.set(this.key(service, account), value) }
  async remove(service: string, account: string): Promise<void> { this.values.delete(this.key(service, account)) }
  async status(service: string, account: string): Promise<'set' | 'unset'> { return this.values.has(this.key(service, account)) ? 'set' : 'unset' }
  clear(): void { this.values.clear() }
}

function fixtureInfo(source: Record<string, unknown>, sourcePath: string): PlaygroundFixtureInfo {
  const playground = source.playground
  const metadata = playground !== null && typeof playground === 'object'
    ? playground as Record<string, unknown>
    : undefined
  const name = typeof metadata?.name === 'string'
    ? metadata.name
    : path.basename(sourcePath)
  const reviewNavigationItem = metadata?.reviewNavigationItem
  if (reviewNavigationItem !== undefined
    && (typeof reviewNavigationItem !== 'string' || !/^[a-z][a-z0-9-]{0,63}:[a-z][a-z0-9-]{0,63}$/.test(reviewNavigationItem))) {
    throw new Error('playground.reviewNavigationItem must be an exact owner-qualified contribution id')
  }
  return {
    name,
    source: path.basename(sourcePath),
    ...(reviewNavigationItem === undefined ? {} : { reviewNavigationItem }),
  }
}

/**
 * Materialize a source fixture into an isolated, writable Playground home.
 * Both the production-bundle server and Vite dev server share this authority.
 */
async function externalPlaygroundHome(input: string, sourcePath: string): Promise<string> {
  if (input.trim() === '' || !path.isAbsolute(input)) {
    throw new Error('Playground external home must be a non-empty absolute path')
  }
  const homeDir = path.resolve(input)
  const protectedRoots = [path.parse(homeDir).root, os.homedir(), process.cwd(), path.dirname(sourcePath)]
    .map(candidate => path.resolve(candidate))
  if (protectedRoots.some(root => homeDir === root || path.relative(homeDir, root) === ''
    || (!path.relative(homeDir, root).startsWith('..') && !path.isAbsolute(path.relative(homeDir, root))))) {
    throw new Error('Playground external home cannot contain a protected root')
  }
  try {
    const entry = await lstat(homeDir)
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error('Playground external home must be a real directory')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(homeDir, { recursive: true, mode: 0o700 })
  }
  return homeDir
}

export async function createPlaygroundSession(
  sourceConfigPath: string,
  options: PlaygroundSessionOptions = {},
): Promise<PlaygroundSession> {
  const sourcePath = path.resolve(sourceConfigPath)
  const source = JSON.parse(await readFile(sourcePath, 'utf8')) as Record<string, unknown>
  if (source.version !== 1 || !Array.isArray(source.plugins)) {
    throw new Error('Playground config must be a CordisX version-1 composition')
  }

  const fixture = fixtureInfo(source, sourcePath)
  const playground = source.playground !== null && typeof source.playground === 'object'
    ? source.playground as Record<string, unknown>
    : {}
  const previewPermissionPolicies = playground.permissionPolicies === undefined
    ? []
    : Array.isArray(playground.permissionPolicies)
      ? playground.permissionPolicies.map((policy, index) => normalizePersistedPermissionPolicyRecord(
        policy,
        `playground.permissionPolicies[${index}]`,
      ))
      : (() => { throw new Error('playground.permissionPolicies must be an array') })()
  const ownsHome = options.homeDir === undefined
  const homeDir = options.homeDir === undefined
    ? await mkdtemp(path.join(os.tmpdir(), 'cordisx-ui-playground-'))
    : await externalPlaygroundHome(options.homeDir, sourcePath)
  const stateRoot = path.join(homeDir, 'state')
  const configPath = path.join(homeDir, 'config', 'playground.config.json')
  const serviceConfigPath = path.join(homeDir, 'config', 'playground.home.json')
  const rootDir = path.dirname(sourcePath)
  const { playground: _fixtureMetadata, ...compositionConfig } = source
  const explicitlyConfiguredLocalEntries = new Set(source.plugins.flatMap((item: unknown) => {
    const plugin = item as Record<string, unknown>
    return typeof plugin.entry === 'string' && !plugin.entry.startsWith('cordisx:')
      ? [path.resolve(rootDir, plugin.entry)]
      : []
  }))
  const materialized = {
    ...compositionConfig,
    plugins: source.plugins.map((item: unknown) => {
      const plugin = item as Record<string, unknown>
      return {
        ...plugin,
        entry: typeof plugin.entry === 'string' && !plugin.entry.startsWith('cordisx:')
          ? path.resolve(rootDir, plugin.entry)
          : plugin.entry,
      }
    }),
  }
  const writeFixture = async (): Promise<void> => {
    await writeFile(configPath, `${JSON.stringify(materialized, null, 2)}\n`, { mode: 0o600 })
    await writeFile(serviceConfigPath, `${JSON.stringify({
      version: 1,
      defaultApp: 'codex',
      providers: [],
      plugins: materialized.plugins,
      permissions: previewPermissionPolicies,
      publisherGrantIssuers: [],
      apps: {
        codex: {
          defaultProfile: 'playground',
          profiles: { playground: { displayName: 'Playground', dataMode: 'host-isolated' } },
        },
      },
    }, null, 2)}\n`, { mode: 0o600 })
  }

  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 })
  await mkdir(path.join(homeDir, 'cache'), { recursive: true, mode: 0o700 })
  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
  await writeFixture()

  let active: PlaygroundGeneration | undefined
  let activeProviderRequests = 0
  const credentialBackend = new PlaygroundCredentialBackend()
  const ownerDocumentStore = new OwnerDocumentStore(homeDir)
  const entityAuthority = new EntityDirectoryAuthority(homeDir, 'playground')
  const agentSessionStore = new PlaygroundAgentSessionStore(homeDir)
  const nextGeneration = async (): Promise<PlaygroundGeneration> => {
    active?.channelConfig?.dispose()
    await active?.providerFleet?.close()
    const generation = `playground-${randomBytes(12).toString('hex')}`
    const token = randomBytes(32).toString('hex')
    const agentSessionStoreToken = randomBytes(32).toString('hex')
    const serviceConfigToken = randomBytes(32).toString('hex')
    const credentialToken = randomBytes(32).toString('hex')
    const loadedConfig = await loadConfig(configPath, { profileId: 'playground' })
    const localDevelopmentBuilds = await Promise.all(loadedConfig.plugins.map(async plugin => {
      if (!plugin.enabled || !explicitlyConfiguredLocalEntries.has(plugin.entry)) return undefined
      // This candidate is embedded again inside Vite's virtual composition.
      // A nested inline map makes its virtual React/UI sources look like real
      // filesystem imports during Vite import analysis.
      return { plugin, build: await buildLocalDevelopmentPlugin(plugin.entry, { sourcemap: false }) }
    }))
    const successfulAt = new Date().toISOString()
    const localDevelopmentByPlugin = new Map(localDevelopmentBuilds.flatMap(item => item === undefined ? [] : [[item.plugin.id, item] as const]))
    const config: CordisXConfig = {
      ...loadedConfig,
      plugins: loadedConfig.plugins.map(plugin => {
        const local = localDevelopmentByPlugin.get(plugin.id)
        if (local === undefined) return plugin
        const identityPrefix = local.build.identitySource.slice(0, local.build.identitySource.lastIndexOf('/') + 1)
        return {
          ...plugin,
          source: `${identityPrefix}${plugin.id}.js`,
          moduleFactorySource: local.build.moduleFactorySource,
          development: {
            origin: 'local-dev', pluginId: plugin.id, sourcePath: plugin.entry,
            state: 'ready', lastSuccessfulAt: successfulAt,
          },
          ...(local.build.readme === undefined ? {} : { readme: local.build.readme }),
        }
      }),
    }
    const localDevelopmentWatchFiles = localDevelopmentBuilds.flatMap(item => item?.build.watchFiles ?? [])
    const developmentIdentityByConfiguredIdentity = new Map(config.plugins.flatMap(plugin => {
      if (plugin.development === undefined || plugin.source === undefined) return []
      return [[`${pathToFileURL(plugin.entry).href}\u0000${plugin.id}`, plugin.source] as const]
    }))
    const permissionPolicies = previewPermissionPolicies.map(record => {
      const source = developmentIdentityByConfiguredIdentity.get(`${record.key.identity.source}\u0000${record.key.identity.pluginId}`)
      if (source === undefined) return record
      return normalizePersistedPermissionPolicyRecord({
        ...record,
        key: { ...record.key, identity: { ...record.key.identity, source } },
      }, 'playground remapped local-development permission policy')
    })
    const mockAgentLoop = config.codex.agentLoopBackend === 'mock'
    const localProvider = mockAgentLoop ? undefined : resolveLocalCodexProviderConfig(config.codex, process.env)
    // The deterministic Simulator is a complete Playground AgentLoop backend.
    // It must not create a Provider Fleet even when the reviewed composition
    // still contains enabled real-provider configuration.
    const providerConfigs: readonly CodexProviderConfig[] = mockAgentLoop
      ? []
      : localProvider === undefined
        ? config.providers
        : [...config.providers, localProvider]
    const providerFleet = providerConfigs.some(provider => provider.enabled)
      ? await ProviderFleet.create(providerConfigs, { appServer: { environment: process.env } })
      : undefined
    const providerToken = providerFleet === undefined ? undefined : randomBytes(32).toString('hex')
    const bridge = createConfigBridgeHandler({
      token,
      profileId: 'playground',
      generation,
      configPath,
      composition: config,
    })
    const identities = new Map(config.plugins.map(plugin => [
      plugin.id,
      plugin.source ?? pathToFileURL(plugin.entry).href,
    ]))
    const documentSecret = randomBytes(32).toString('hex')
    const documentLeases = new OwnerDocumentLeaseRegistry({
      stable: [...identities].map(([pluginId, source]) => ({ pluginId, source })),
    })
    const ownerDocuments = createOwnerDocumentBridgeHandler({
      secret: documentSecret,
      profileId: 'playground',
      generation,
      store: ownerDocumentStore,
      principalAllowed: principal => documentLeases.allowed(principal),
    })
    for (const plugin of config.plugins.filter(item => item.enabled)) entityAuthority.register({
      profileId: 'playground', installationId: entityInstallationId('playground', plugin.id),
      pluginId: plugin.id, pluginGeneration: 1,
    }, [])
    const documents = Object.assign(ownerDocuments, { entities: createEntityBridgeHandler({
      secret: documentSecret, profileId: 'playground', generation, authority: entityAuthority,
      principalAllowed: principal => documentLeases.allowed(principal),
    }) })
    const channelPlugin = config.plugins.find(plugin => plugin.id === 'channel')
    const channelConfig = channelPlugin === undefined ? undefined : new HostServiceConfigNarrowApi({
      contract: createChannelHostServiceConfigContract({
        source: channelPlugin.source ?? pathToFileURL(channelPlugin.entry).href,
        pluginId: 'channel', serviceId: 'runtime',
      }) as unknown as ConstructorParameters<typeof HostServiceConfigNarrowApi>[0]['contract'],
      profileId: 'playground', generation, ownerToken: serviceConfigToken,
      configPath: serviceConfigPath, writable: true, authorize: () => true,
      restartService: async () => ({
        generation: `playground-service-${randomBytes(8).toString('hex')}`,
        rollback: async () => undefined,
      }),
    })
    const serviceConfig = channelConfig === undefined ? undefined : createServiceConfigBridgeHandler({
      token: serviceConfigToken, profileId: 'playground', generation,
      services: [{ pluginId: 'channel', serviceId: 'runtime', api: channelConfig }],
    })
    const credential = channelConfig === undefined ? undefined : createChannelCredentialBridgeHandler({
      token: credentialToken, profileId: 'playground',
      store: new LauncherSecretStore({ platform: 'darwin', backend: credentialBackend }),
      service: channelConfig,
    })
    const channelDescriptor = await channelConfig?.descriptor()
    const channelManager = channelDescriptor === undefined ? undefined : projectLocalChannelManager({
      configuration: channelDescriptor.configuration,
      revision: channelDescriptor.revision,
      lastGoodRevision: channelDescriptor.lastGoodRevision,
      writable: channelDescriptor.writable,
    })
    const next: PlaygroundGeneration = {
      generation, token, agentSessionStoreToken, config, localDevelopmentWatchFiles, permissionPolicies, bridge, documents, documentSecret,
      ...(channelConfig === undefined ? {} : { channelConfig }),
      ...(serviceConfig === undefined ? {} : { serviceConfig }),
      ...(credential === undefined ? {} : { credential }),
      ...(channelManager === undefined ? {} : { channelManager }),
      ...(providerFleet === undefined ? {} : { providerFleet }),
      ...(providerToken === undefined ? {} : { providerToken }),
    }
    active = next
    return next
  }
  const rendererOptions = (generation: PlaygroundGeneration) => ({
    playground: true as const,
    generation: generation.generation,
    configBridgeToken: generation.token,
    playgroundAgentSessionStoreToken: generation.agentSessionStoreToken,
    ownerDocumentAuthority: {
      secret: generation.documentSecret,
      profileId: 'playground',
      generation: generation.generation,
    },
    ...(generation.serviceConfig === undefined ? {} : { serviceConfigBridgeToken: generation.serviceConfig.token }),
    ...(generation.credential === undefined ? {} : { channelCredentialBridgeToken: generation.credential.token }),
    ...(generation.channelManager === undefined ? {} : { channelManager: generation.channelManager }),
    ...(generation.providerToken === undefined ? {} : { providerBridgeToken: generation.providerToken }),
    profileId: 'playground',
    permission: { profileId: 'playground', policies: generation.permissionPolicies },
  })

  return {
    configPath,
    fixture,
    homeDir,
    async buildBundle() {
      const generation = await nextGeneration()
      return {
        generation: generation.generation,
        source: await buildRendererBundle(generation.config, rendererOptions(generation)),
      }
    },
    async buildComposition(runtimeImport) {
      const generation = await nextGeneration()
      const composition = await buildRendererCompositionSource(
        generation.config,
        rendererOptions(generation),
        { runtimeImport, awaitBoot: true },
      )
      return {
        ...composition,
        watchFiles: [...new Set([...composition.watchFiles, ...generation.localDevelopmentWatchFiles])],
        generation: generation.generation,
      }
    },
    async handleConfigRequest(raw) {
      if (active === undefined) throw new Error('Playground has no active generation')
      const parsed = parseConfigBindingRequest(
        JSON.parse(raw),
        active.bridge.token,
        active.bridge.profileId,
        active.generation,
      )
      try {
        return { requestId: parsed.requestId, ok: true, value: await active.bridge.handle(parsed) }
      } catch (error) {
        return { requestId: parsed.requestId, ok: false, ...configBridgeError(error) }
      }
    },
    async handleAgentSessionStoreRequest(raw) {
      if (active === undefined) throw new Error('Playground has no active generation')
      let requestId = 'invalid'
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        requestId = typeof parsed.requestId === 'string' && parsed.requestId !== '' ? parsed.requestId : 'invalid'
        if (parsed.version !== 1 || parsed.token !== active.agentSessionStoreToken
          || parsed.runtimeGeneration !== active.generation || requestId === 'invalid') {
          return { requestId, ok: true, value: { status: 'unavailable', code: 'generation-conflict' } }
        }
        const { version: _version, requestId: _requestId, token: _token, runtimeGeneration: _runtimeGeneration, ...request } = parsed
        return { requestId, ok: true, value: await agentSessionStore.handle(request as unknown as PlaygroundAgentSessionStoreRequest) }
      } catch {
        return { requestId, ok: true, value: { status: 'unavailable', code: 'invalid-request' } }
      }
    },
    async handleOwnerDocumentRequest(raw) {
      if (active === undefined) throw new Error('Playground has no active generation')
      let requestId = 'invalid'
      let entityRequest = false
      try {
        const value = JSON.parse(raw) as unknown
        const generic = value as { readonly requestId?: unknown }
        requestId = typeof generic.requestId === 'string' ? generic.requestId : 'invalid'
        entityRequest = isEntityBindingRequest(value)
        if (entityRequest && active.documents.entities !== undefined) {
          return { requestId, ok: true, value: await active.documents.entities.handle(value) }
        }
        const parsed = parseOwnerDocumentBindingRequest(value)
        requestId = parsed.requestId
        const result = parsed.operation === 'load'
          ? await active.documents.load(parsed)
          : await active.documents.replace(parsed)
        return { requestId, ok: true, value: result }
      } catch (error) {
        if (entityRequest) return { requestId, ok: false, error: error instanceof Error ? error.message : 'entity request rejected' }
        return { requestId, ok: true, value: ownerDocumentBridgeError() }
      }
    },
    async handleServiceConfigRequest(raw) {
      if (active?.serviceConfig === undefined) throw new Error('Playground has no active Channel configuration service')
      const parsed = parseServiceConfigBindingRequest(
        JSON.parse(raw), active.serviceConfig.token, active.serviceConfig.profileId, active.serviceConfig.generation,
      )
      try {
        return { requestId: parsed.requestId, ok: true, value: await active.serviceConfig.handle(parsed) }
      } catch (error) {
        return { requestId: parsed.requestId, ok: false, ...serviceConfigBridgeError(error) }
      }
    },
    async handleChannelCredentialRequest(raw) {
      if (active?.credential === undefined) throw new Error('Playground has no active Channel credential service')
      const parsed = JSON.parse(raw) as { readonly requestId?: unknown }
      const requestId = typeof parsed.requestId === 'string' ? parsed.requestId : ''
      try {
        return { requestId, ok: true, value: await active.credential.handle(parsed) }
      } catch {
        return { requestId, ok: false, code: 'unavailable', error: 'Channel credential capture is unavailable.' }
      }
    },
    async handleProviderRequest(raw) {
      if (active?.providerFleet === undefined || active.providerToken === undefined) throw new Error('Playground has no active provider service')
      let requestId = 'invalid'
      try {
        if (Buffer.byteLength(raw) > MAX_PROVIDER_REQUEST_BYTES) throw new Error('provider request exceeds maximum size')
        if (activeProviderRequests >= MAX_PROVIDER_REQUESTS) throw new Error('too many concurrent provider requests')
        const request = parseProviderBindingRequest(JSON.parse(raw), active.providerToken)
        requestId = request.requestId
        activeProviderRequests += 1
        try {
          return { requestId, ok: true, value: await handleProviderBindingRequest(active.providerFleet, request) }
        } finally {
          activeProviderRequests -= 1
        }
      } catch {
        return { requestId, ok: false, error: 'Provider request was rejected' }
      }
    },
    async reset() {
      active?.channelConfig?.dispose()
      await active?.providerFleet?.close()
      credentialBackend.clear()
      await writeFixture()
      await rm(stateRoot, { recursive: true, force: true })
      await mkdir(stateRoot, { recursive: true, mode: 0o700 })
      active = undefined
    },
    async close() {
      active?.channelConfig?.dispose()
      await active?.providerFleet?.close()
      credentialBackend.clear()
      active = undefined
      if (ownsHome) await rm(homeDir, { recursive: true, force: true })
    },
  }
}
