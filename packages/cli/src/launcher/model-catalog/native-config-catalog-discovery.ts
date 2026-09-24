import { createHash, randomUUID } from 'node:crypto'
import type { CodexConfigModelProviderProjection, CodexConfigNativeProvider } from '../codex-config-model-providers.js'
import { codexConfigModelProviders } from '../codex-config-model-providers.js'
import type { ModelSelectorIconOverrides } from '../../model-selector-branding.js'
import { builtinDiscoveryRegistry } from './builtin-registry.js'
import { type CatalogBinding, CatalogError, type CatalogSnapshot, type DiscoveryConnection } from './contracts.js'
import { isDeepSeekOfficialEndpoint } from './deepseek.js'
import { isOpenCodeGoEndpoint } from './opencode-go.js'
import { isOpenRouterEndpoint } from './openrouter.js'
import { createDiscoveryRequestCapability, type DiscoveryFetch } from './request-capability.js'
import { ModelCatalogService } from './service.js'

const TTL_MS = 3_600_000
const bindingRef = (providerId: string) => `codex-config:${providerId}`
const revision = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const supportedEndpoint = (endpoint: string): string | undefined =>
  isDeepSeekOfficialEndpoint(endpoint)
    ? 'https://api.deepseek.com'
    : isOpenCodeGoEndpoint(endpoint)
    ? 'https://opencode.ai/zen/go/v1'
    : isOpenRouterEndpoint(endpoint)
    ? 'https://openrouter.ai/api/v1'
    : undefined

interface ConnectionState {
  readonly endpoint: string
  readonly providerName: string
  readonly wireApi?: 'responses' | 'chat-completions'
  readonly credentialKind: CodexConfigNativeProvider['credential']['kind']
  readonly credentialReference?: string
  readonly credentialValue?: string
  readonly accountRevision: string
  readonly scopeRevision: string
}

/** Host-only native config discovery. Credentials never enter snapshots, renderer state, or plugin services. */
export class NativeConfigCatalogDiscovery {
  readonly #registry = builtinDiscoveryRegistry()
  readonly #service: ModelCatalogService
  readonly #connections = new Map<string, ConnectionState>()
  readonly #bindings = new Map<string, CatalogBinding>()
  readonly #lastGood = new Map<string, CatalogSnapshot>()

  constructor(
    private readonly options: {
      readonly environment: () => Readonly<Record<string, string | undefined>>
      readonly fetcher?: DiscoveryFetch
      readonly enabled?: boolean
    },
  ) {
    this.#service = new ModelCatalogService({
      registry: this.#registry,
      connection: binding => this.connection(binding.bindingRef),
      read: async () => [],
    })
    this.#service.subscribe(() => {
      for (const providerId of this.#bindings.keys()) {
        const snapshot = this.#service.snapshot(bindingRef(providerId))
        if (snapshot?.complete && snapshot.freshness === 'fresh') this.#lastGood.set(providerId, snapshot)
      }
    })
  }

  async load(input: {
    readonly codexHome: string
    readonly catalogs?: Readonly<Record<string, string>>
    readonly selectorIcons?: ModelSelectorIconOverrides
  }): Promise<CodexConfigModelProviderProjection> {
    let providers: readonly CodexConfigNativeProvider[] = []
    const projection = await codexConfigModelProviders(
      input.codexHome,
      input.catalogs,
      input.selectorIcons,
      value => providers = value,
    )
    this.configure(this.options.enabled === false ? [] : providers)
    return projection
  }

  private credentialValue(provider: CodexConfigNativeProvider): string | undefined {
    return provider.credential.kind === 'environment'
      ? this.options.environment()[provider.credential.reference]
      : provider.credential.kind === 'inline-private'
      ? provider.credential.token
      : undefined
  }

  private configure(providers: readonly CodexConfigNativeProvider[]): void {
    const nextIds = new Set<string>()
    for (const provider of providers) {
      if (provider.endpoint === undefined || !['environment', 'inline-private'].includes(provider.credential.kind)) {
        continue
      }
      const endpoint = supportedEndpoint(provider.endpoint)
      if (endpoint === undefined) continue
      nextIds.add(provider.providerId)
      const previous = this.#connections.get(provider.providerId)
      const credentialValue = this.credentialValue(provider)
      const sameCredentialReference = previous?.credentialKind === provider.credential.kind
        && (provider.credential.kind !== 'environment'
          || previous.credentialReference === provider.credential.reference)
      const sameIdentity = previous !== undefined
        && previous.endpoint === endpoint
        && previous.wireApi === provider.wireApi
        && sameCredentialReference
        && previous.credentialValue === credentialValue
      if (sameIdentity) {
        continue
      }
      const stableIdentity = [
        'codex-config-discovery-account-v1',
        provider.providerId,
        endpoint,
        provider.wireApi ?? '',
        provider.credential.kind,
        provider.credential.kind === 'environment' ? provider.credential.reference : '',
      ]
      const sameConfiguredIdentity = previous !== undefined
        && previous.endpoint === endpoint
        && previous.wireApi === provider.wireApi
        && sameCredentialReference
      const accountRevision = previous === undefined
        ? revision(stableIdentity)
        : sameConfiguredIdentity
        ? randomUUID()
        : revision(stableIdentity)
      const scopeRevision = revision([
        'codex-config-discovery-v1',
        provider.providerId,
        endpoint,
        provider.wireApi ?? '',
        provider.credential.kind,
        provider.credential.kind === 'environment' ? provider.credential.reference : '',
        accountRevision,
      ])
      const state: ConnectionState = Object.freeze({
        endpoint,
        providerName: provider.title,
        ...(provider.wireApi === undefined ? {} : { wireApi: provider.wireApi }),
        credentialKind: provider.credential.kind,
        ...(provider.credential.kind === 'environment'
          ? { credentialReference: provider.credential.reference }
          : {}),
        ...(credentialValue === undefined ? {} : { credentialValue }),
        accountRevision,
        scopeRevision,
      })
      this.#connections.set(provider.providerId, state)
      this.#lastGood.delete(provider.providerId)
      const binding: CatalogBinding = Object.freeze({
        bindingRef: bindingRef(provider.providerId),
        scopeRevision,
        authorityRevision: revision([scopeRevision, 'detect', TTL_MS]),
        strategy: Object.freeze({ kind: 'auto', adapter: 'detect', ttlMs: TTL_MS, mode: 'augment' }),
      })
      this.#bindings.set(provider.providerId, binding)
      this.#service.configure(binding)
    }
    for (const providerId of [...this.#connections.keys()]) {
      if (nextIds.has(providerId)) continue
      this.#connections.delete(providerId)
      this.#bindings.delete(providerId)
      this.#lastGood.delete(providerId)
      this.#service.remove(bindingRef(providerId))
    }
  }

  private connection(ref: string): DiscoveryConnection | undefined {
    const providerId = ref.startsWith('codex-config:') ? ref.slice('codex-config:'.length) : ''
    const state = this.#connections.get(providerId)
    if (state === undefined) return undefined
    const current = () => this.#connections.get(providerId) === state
    return Object.freeze({
      endpoint: state.endpoint,
      providerName: state.providerName,
      scopeRevision: state.scopeRevision,
      current,
      request: createDiscoveryRequestCapability({
        operation: { origin: state.endpoint, method: 'GET', path: '/models' },
        current,
        bearer: async () => {
          const value = state.credentialKind === 'environment'
            ? this.options.environment()[state.credentialReference!]
            : state.credentialValue
          if (value !== state.credentialValue) throw new CatalogError('cancelled')
          return value
        },
        ...(this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher }),
      }),
    })
  }

  snapshot(providerId: string): CatalogSnapshot | undefined {
    const snapshot = this.#service.snapshot(bindingRef(providerId))
    const lastGood = this.#lastGood.get(providerId)
    if (snapshot === undefined || lastGood?.scopeRevision !== snapshot.scopeRevision) return snapshot
    return Object.freeze({
      ...snapshot,
      models: snapshot.freshness === 'fresh' ? snapshot.models : lastGood.models,
    })
  }

  has(providerId: string): boolean {
    return this.#bindings.has(providerId)
  }

  refresh(providerId: string): Promise<void> {
    const binding = this.#bindings.get(providerId)
    if (binding === undefined) return Promise.resolve()
    const cached = this.#service.snapshot(binding.bindingRef)
    const forced = Object.freeze({
      ...binding,
      authorityRevision: revision([binding.authorityRevision, randomUUID()]),
    })
    this.#bindings.set(providerId, forced)
    this.#service.configure(forced, {
      ...(cached?.complete
        ? { cached: Object.freeze({ ...cached, authorityRevision: forced.authorityRevision }) }
        : {}),
    })
    return this.#service.refresh(forced.bindingRef)
  }

  subscribe(listener: () => void): () => void {
    return this.#service.subscribe(listener)
  }

  dispose(): void {
    this.#connections.clear()
    this.#bindings.clear()
    this.#lastGood.clear()
    this.#service.dispose()
  }
}
