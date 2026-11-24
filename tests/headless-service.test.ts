vi.mock(
  '../packages/cli/src/config/home-config.js',
  () => ({
    loadHomeConfig: async () => ({
      providers: f.providers,
      environmentVariables: f.savedEnvironment,
      apps: {
        codex: {
          profiles: { test: { approvalReview: f.reviewSettings ? { settings: f.reviewSettings } : undefined } },
        },
      },
    }),
  }),
)
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../packages/cli/src/launcher/headless-managed-base-catalog.js', () => ({
  prepareHeadlessManagedBaseCatalog: async () => undefined,
}))
vi.mock('../packages/cli/src/launcher/chat-execution-preferences.js', () => ({
  ChatExecutionPreferences: class {
    static async open() {
      return { close: async () => {} }
    }
  },
}))
vi.mock('../packages/cli/src/launcher/codex-chat-configuration.js', () => ({
  CodexChatConfiguration: class {
    static async open() {
      return { call: async () => ({}), close: async () => {} }
    }
  },
}))

const f = vi.hoisted(() => ({
  events: [] as string[],
  failStart: false,
  enabled: true,
  packageMode: false,
  packageReadCount: 0,
  transportEnvironment: undefined as NodeJS.ProcessEnv | undefined,
  backendEnvironment: undefined as NodeJS.ProcessEnv | undefined,
  sourceGuard: undefined as undefined | ((method: string, params: Record<string, unknown>) => () => void),
  rejectHandoff: false,
  backendOptions: undefined as undefined | {
    onRequest: (method: string, params: unknown) => unknown
    declaredProviders: readonly { providerId: string }[] | (() => Promise<readonly { providerId: string }[]>)
    managedCatalog?: (id: string) => Promise<unknown>
    workerEnvironment?: (id: string) => NodeJS.ProcessEnv
    nativeRequest: (
      method: string,
      params: Record<string, unknown>,
      next: (value: Record<string, unknown>) => Promise<unknown>,
    ) => Promise<unknown>
  },
  reviewSettings: undefined as undefined | { providerId: string },
  backendReview: undefined as undefined | { modelCatalogPath?: string; modelCatalogPreserveProvider?: boolean },
  providers: [] as import('../packages/cli/src/config/home-config.js').HomeConfigProvider[],
  savedEnvironment:
    [] as import('../packages/cli/src/config/home-config-environment.js').HomeConfigEnvironmentVariable[],
  declaredProviders: [] as readonly { providerId: string }[],
  projectedProviders: [] as readonly { id: string }[],
  reports: [] as string[],
}))
vi.mock('../packages/cli/src/launcher/model-service-projection.js', async importOriginal => ({
  ...await importOriginal<typeof import('../packages/cli/src/launcher/model-service-projection.js')>(),
  projectModelServicesToCodex: async (services: readonly { id: string }[]) => {
    f.projectedProviders = services
    return { providerIds: services.map(service => service.id) }
  },
}))
vi.mock(
  '../packages/cli/src/launcher/approval-review-catalog.js',
  () => ({
    prepareApprovalReviewCatalog: async (input: { settings?: unknown }) =>
      input.settings
        ? {
          path: '/review/catalog.json',
          providerId: 'gateway',
          modelIds: ['work'],
          close: async () => {
            f.events.push('review-close')
          },
        }
        : undefined,
  }),
)
vi.mock(
  '../packages/cli/src/launcher/config.js',
  () => ({
    loadConfig: async () => ({
      plugins: f.packageMode ? [] : [{ id: 'channel', enabled: f.enabled, entry: '/plugin/index.mjs' }],
    }),
  }),
)
vi.mock('../packages/cli/src/launcher/plugin-activation.js', () => ({
  PluginActivationStore: class {
    async loadActive() {
      return {}
    }
  },
}))
vi.mock('../packages/cli/src/launcher/plugin-composition.js', () => ({
  loadPluginComposition: async () =>
    f.packageMode
      ? [{ id: 'channel', enabled: f.enabled, entry: '/plugin/index.mjs', package: { version: '0.1.7' } }]
      : [],
}))
vi.mock('../packages/cli/src/launcher/package-plugin-service-config.js', () => ({
  PackagePluginServiceConfigStore: class {
    persistence = {
      read: async () => {
        f.packageReadCount += 1
        return {
          config: {
            contract: 'cordisx.channel-service-config/v2',
            schemaVersion: 2,
            connections: [],
          },
        }
      },
    }
  },
}))
vi.mock(
  '../packages/cli/src/config/service-config.js',
  () => ({
    readServiceConfigState: async () => ({
      config: {
        contract: 'cordisx.channel-service-config/v2',
        schemaVersion: 2,
        connections: [{
          ref: { adapterId: 'feishu', accountId: 'cli_test', tenantId: 'tenant' },
          adapterKind: 'feishu',
          enabled: true,
          transport: { mode: 'websocket' },
          secretRef: 'host-secret:env/CHANNEL_KEY',
        }],
      },
    }),
  }),
)
vi.mock('../packages/cli/src/launcher/channel-service.js', () => ({
  CHANNEL_SERVICE_CONFIG_INITIAL: {},
  createLocalChannelService: (input: { environment: NodeJS.ProcessEnv }) => {
    f.transportEnvironment = input.environment
    return ({
      conversationAccess: () => undefined,
      start: async () => {
        f.events.push('service-start')
        if (f.failStart) throw new Error('start failed')
      },
      dispose: async () => {
        f.events.push('service-close')
      },
    })
  },
}))
vi.mock('../packages/cli/src/launcher/headless-codex-backend.js', () => ({
  startHeadlessCodexBackend: async (
    input: {
      environment: NodeJS.ProcessEnv
      modelCatalogPath?: string
      modelCatalogPreserveProvider?: boolean
      declaredProviders: readonly { providerId: string }[] | (() => Promise<readonly { providerId: string }[]>)
    },
  ) => {
    f.declaredProviders = Array.isArray(input.declaredProviders) ? input.declaredProviders : []
    f.backendEnvironment = input.environment
    f.backendOptions = input as unknown as NonNullable<typeof f.backendOptions>
    f.backendReview = input
    f.events.push('backend-start')
    return {
      call: async () => ({}),
      nativeRequest: async () => ({}),
      verifiedCatalogBase: async () => undefined,
      verifyManagedProviderScope: async () => true,
      close: async () => {
        f.events.push('backend-close')
      },
    }
  },
}))
vi.mock('../packages/cli/src/launcher/channel-native-sessions.js', () => ({
  ChannelNativeSessions: class {
    isPreparing() {
      return false
    }
  },
}))
vi.mock('../packages/cli/src/launcher/channel-cli-context.js', () => ({ configuredChannelCliContext: () => ({}) }))
vi.mock('../packages/cli/src/launcher/plugin-documents.js', () => ({ configuredPluginDocuments: async () => ({}) }))
vi.mock(
  '../packages/cli/src/cli/channel-consumer-composition.js',
  () => ({
    createConfiguredChannelConsumer: async () => {
      f.events.push('consumer-attached')
      return {
        consumer: {
          logicalHistoryCall: async () => ({ success: true, contentItems: [] }),
          enterNativeSourceOperation: (method: string, params: Record<string, unknown>) => {
            f.events.push('source-enter')
            const release = f.sourceGuard?.(method, params)
            return () => {
              release?.()
              f.events.push('source-release')
            }
          },
          assertNativeHandoff: () => {
            f.events.push('handoff-check')
            if (f.rejectHandoff) throw new Error('handoff rejected')
          },
          agentAccess: { preparation: () => false },
        },
        tools: { call: async () => ({ status: 'ok' }) },
        dispose: async () => {
          f.events.push('consumer-close')
          f.events.push('service-close')
        },
      }
    },
  }),
)
vi.mock('../packages/cli/src/launcher/headless-native-authority.js', () => ({
  createHeadlessNativeAuthority: async () => ({
    authority: {
      request: () => ({}),
      execution: {
        bindReviewProvider: (provider: string) => {
          f.events.push(`review-bound:${provider}`)
        },
      },
    },
    setReader: () => {},
    close: async () => {
      f.events.push('authority-close')
    },
  }),
}))
import { startHeadlessService } from '../packages/cli/src/cli/headless-service.js'
import { ChannelNativeSourceFence } from '../packages/cli/src/launcher/channel-native-source-fence.js'

const input = {
  configPath: '/state/config.json',
  homeDir: '/state',
  appId: 'codex',
  profileId: 'test',
  userHome: '/user',
  codexHome: '/user/.codex',
  codexExecutable: '/codex',
  cwd: '/work',
  environment: {},
  generation: 'test-generation',
  report: () => {},
}
describe('headless service lifecycle', () => {
  beforeEach(() => {
    f.events.length = 0
    f.failStart = false
    f.enabled = true
    f.packageMode = false
    f.packageReadCount = 0
    f.backendOptions = undefined
    f.sourceGuard = undefined
    f.rejectHandoff = false
    f.reviewSettings = undefined
    f.backendReview = undefined
    f.providers = []
    f.savedEnvironment = []
    f.projectedProviders = []
    f.declaredProviders = []
    f.reports = []
  })
  it('passes profile review routing to the native backend before ingress and closes its snapshot', async () => {
    f.reviewSettings = { providerId: 'gateway' }
    const service = await startHeadlessService(input)
    expect(f.backendReview).toMatchObject({
      modelCatalogPath: '/review/catalog.json',
      modelCatalogPreserveProvider: true,
    })
    expect(f.events.slice(0, 2)).toEqual(['review-bound:gateway', 'backend-start'])
    await service.close()
    expect(f.events).toContain('review-close')
  })
  it('attaches the consumer before ingress and disposes in reverse order once', async () => {
    const service = await startHeadlessService(input)
    expect(f.events).toEqual(['backend-start', 'consumer-attached', 'service-start'])
    await Promise.all([service!.close(), service!.close()])
    expect(f.events.slice(3)).toEqual(['consumer-close', 'service-close', 'backend-close', 'authority-close'])
  })
  it('routes native history requests and guards the final owned turn dispatch', async () => {
    const service = await startHeadlessService(input)
    expect(await f.backendOptions!.onRequest('item/tool/call', { threadId: 'target' })).toMatchObject({ success: true })
    await f.backendOptions!.nativeRequest('turn/start', { threadId: 'target' }, async () => {
      f.events.push('native-write')
      return {}
    })
    expect(f.events.slice(-4)).toEqual(['source-enter', 'handoff-check', 'native-write', 'source-release'])
    await service.close()
  })
  it('keeps the native writer fence after an uncertain transport failure', async () => {
    const fence = new ChannelNativeSourceFence(() => false)
    f.sourceGuard = (method, params) => fence.enterNative(method, params)
    const service = await startHeadlessService(input)
    try {
      await expect(f.backendOptions!.nativeRequest('turn/start', { threadId: 'source' }, async () => {
        throw new Error('transport timeout')
      })).rejects.toThrow('transport timeout')
      expect(f.events.slice(-2)).toEqual(['source-enter', 'handoff-check'])
      expect(fence.beginMigration('source')).toBeUndefined()
      await expect(f.backendOptions!.nativeRequest('turn/start', { threadId: 'other' }, async () => {
        throw Object.assign(new Error('native rejection'), { rpcCode: -32600 })
      })).rejects.toThrow('native rejection')
      expect(fence.beginMigration('other')).toBeUndefined()
      f.rejectHandoff = true
      await expect(f.backendOptions!.nativeRequest('turn/start', { threadId: 'before-send' }, async () => ({})))
        .rejects.toThrow('handoff rejected')
      expect(fence.beginMigration('before-send')).toBeTypeOf('function')
    } finally {
      await service.close()
    }
  })
  it('loads lifecycle-installed Channel service configuration from its package store', async () => {
    f.packageMode = true
    const service = await startHeadlessService(input)
    expect(f.packageReadCount).toBe(1)
    expect(f.events).toContain('service-start')
    await service.close()
  })
  it('cleans up every owner if startup fails', async () => {
    f.failStart = true
    await expect(startHeadlessService(input)).rejects.toThrow('start failed')
    expect(f.events).toEqual([
      'backend-start',
      'consumer-attached',
      'service-start',
      'consumer-close',
      'service-close',
      'backend-close',
      'authority-close',
    ])
  })
  it('keeps environment credentials in the transport and out of the Codex backend', async () => {
    const environment = { PATH: '/bin', CHANNEL_KEY: 'fixture-only' }
    const service = await startHeadlessService({ ...input, environment })
    try {
      expect(f.transportEnvironment).toEqual(environment)
      expect(f.backendEnvironment).toEqual({ PATH: '/bin' })
      expect(environment.CHANNEL_KEY).toBe('fixture-only')
    } finally {
      await service.close()
    }
  })
  it('does not start a backend for a disabled Channel plugin', async () => {
    f.enabled = false
    const service = await startHeadlessService(input)
    expect(service.channel).toBeUndefined()
    expect(await service.codex('capabilities', {})).toMatchObject({
      capabilities: { modelServices: true, providerCatalog: false, executionSettings: true },
    })
    expect(f.events).toEqual([])
    await service.close()
    expect(await service.codex('capabilities', {})).toMatchObject({ code: 'CODEX_RUNTIME_UNAVAILABLE' })
  })
  it('wires all saved shared services into the backend while keeping unrelated and Channel secrets out', async () => {
    f.providers = ['one', 'two', 'three'].map(id => ({
      id,
      kind: 'model-service',
      displayName: id,
      baseUrl: 'https://example.com/v1',
      apiKeyEnv: id.toUpperCase() + '_KEY',
      protocols: ['openai-responses'],
      models: { codex: ['work'] },
    }))
    f.savedEnvironment = ['ONE_KEY', 'TWO_KEY', 'THREE_KEY', 'UNRELATED_KEY'].map(name => ({
      name,
      value: 'synthetic-' + name,
      enabled: true,
    }))
    const service = await startHeadlessService({
      ...input,
      environment: { CHANNEL_KEY: 'channel-only', PATH: '/bin' },
      report: code => f.reports.push(code),
    })
    try {
      expect(f.declaredProviders.map(service => service.providerId)).toEqual(['one', 'two', 'three'])
      expect(f.projectedProviders.map(service => service.id)).toEqual(['one', 'two', 'three'])
      expect(f.backendEnvironment).toEqual({
        PATH: '/bin',
        ONE_KEY: 'synthetic-ONE_KEY',
        TWO_KEY: 'synthetic-TWO_KEY',
        THREE_KEY: 'synthetic-THREE_KEY',
      })
      expect(f.reports).toEqual([])
    } finally {
      await service.close()
    }
  })
  it('connects plugin routes and credentials while refusing an unproven native catalog', async () => {
    const active = new Map<string, string>()
    const activation = {
      get nativeProviderIds() {
        return [...active.keys()]
      },
      startup: { hasProvider: (id: string) => id === 'fixture' },
      prepareNativeConnection(id: string) {
        const model = active.get(id)
        if (!model) throw new Error('unavailable')
        return {
          value: {
            service: { pluginId: 'fixture-plugin', serviceId: 'service', generation: 'one' },
            endpoint: { origin: 'http://127.0.0.1:8317', apiPath: '/v1', auth: { scheme: 'none' } },
            models: {
              generation: 'catalog-one',
              defaultAlias: 'fixture',
              aliases: [{ alias: 'fixture', gatewayModelId: model }],
            },
            cleanup: { authorityId: 'fixture' },
          },
          dispose() {},
        }
      },
    } as unknown as import('../packages/cli/src/launcher/managed-service-plugin-lifecycle.js').ManagedServiceNativeActivation
    const service = await startHeadlessService({
      ...input,
      nativeActivation: activation,
      report: code => f.reports.push(code),
    })
    try {
      const options = f.backendOptions!
      if (typeof options.declaredProviders !== 'function') throw new Error('missing dynamic catalog')
      expect(await options.declaredProviders()).toEqual([])
      active.set('fixture', 'fixture-model')
      expect(await options.declaredProviders()).toMatchObject([{ providerId: 'fixture' }])
      expect(await options.managedCatalog!('fixture')).toMatchObject({ status: 'unavailable' })
      expect(f.reports).toContain('HEADLESS_MANAGED_CATALOG_UNAVAILABLE')
      let sent: Record<string, unknown> | undefined
      await options.nativeRequest('thread/start', { modelProvider: 'fixture', model: 'fixture-model' }, async value => {
        sent = value
        return { thread: { id: 'thread-fixture' }, model: 'fixture-model' }
      })
      expect(sent).toMatchObject({ config: { 'model_providers.fixture': { wire_api: 'responses' } } })
      active.clear()
      expect(await options.declaredProviders()).toEqual([])
    } finally {
      await service.close()
    }
  })
})
