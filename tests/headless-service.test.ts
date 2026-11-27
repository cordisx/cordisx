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
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
  persistedProvider: undefined as string | undefined,
  accountReads: 0,
  recoveryAccount: undefined as unknown,
  crossProviderForkReady: undefined as
    | undefined
    | ((target: { providerId: string; model: string }) => Promise<boolean>),
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
      declaredProviders: readonly { providerId: string }[]
    },
  ) => {
    f.declaredProviders = input.declaredProviders
    f.backendEnvironment = input.environment
    f.backendOptions = input as unknown as NonNullable<typeof f.backendOptions>
    f.backendReview = input
    f.events.push('backend-start')
    return {
      call: async () => ({}),
      nativeRequest: async (method: string) =>
        method === 'thread/read'
          ? { thread: { modelProvider: f.persistedProvider } }
          : {},
      readRecoveryAccount: async () => {
        f.accountReads += 1
        return f.recoveryAccount ?? {}
      },
      close: async () => {
        f.events.push('backend-close')
      },
    }
  },
}))
vi.mock('../packages/cli/src/launcher/channel-native-sessions.js', () => ({
  ChannelNativeSessions: class {
    constructor(input: { crossProviderForkReady?: typeof f.crossProviderForkReady }) {
      f.crossProviderForkReady = input.crossProviderForkReady
    }
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
    f.persistedProvider = undefined
    f.accountReads = 0
    f.recoveryAccount = undefined
    f.crossProviderForkReady = undefined
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
  it('permits configured Responses fork recovery without an OpenAI account', async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), 'headless-configured-fork-'))
    const executable = path.join(codexHome, 'codex')
    await writeFile(executable, '#!/bin/sh\nprintf "codex-cli 0.172.0\\n"\n', { mode: 0o755 })
    await writeFile(
      path.join(codexHome, 'config.toml'),
      [
        '[model_providers.fixture]',
        'base_url="http://127.0.0.1:12345/v1"',
        'env_key="FIXTURE_KEY"',
        'wire_api="responses"',
      ].join('\n'),
    )
    f.providers = [{
      id: 'fixture',
      kind: 'model-service',
      displayName: 'Fixture',
      baseUrl: 'http://127.0.0.1:12345/v1',
      apiKeyEnv: 'FIXTURE_KEY',
      protocols: ['openai-responses'],
      models: { codex: ['model'] },
    }]
    let service: Awaited<ReturnType<typeof startHeadlessService>> | undefined
    try {
      service = await startHeadlessService({
        ...input,
        codexHome,
        codexExecutable: executable,
        environment: { FIXTURE_KEY: 'synthetic' },
      })
      expect(f.crossProviderForkReady).toBeDefined()
      expect(await f.crossProviderForkReady!({ providerId: 'fixture', model: 'model' })).toBe(true)
      expect(await f.crossProviderForkReady!({ providerId: 'openai', model: 'model' })).toBe(false)
      expect(f.accountReads).toBe(0)
    } finally {
      await service?.close()
      await rm(codexHome, { recursive: true, force: true })
    }
  })
  it('uses the shared recovery transport for a persisted headless Responses session', async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), 'headless-recovery-'))
    const requests: { body: Record<string, unknown>; auth: string | undefined }[] = []
    const upstream = createServer(async (request, response) => {
      let raw = ''
      for await (const chunk of request) raw += chunk
      requests.push({ body: JSON.parse(raw), auth: request.headers.authorization })
      if (requests.length === 1) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
          error: { code: 'invalid_encrypted_content' },
        }))
      } else response.writeHead(200).end('recovered')
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('missing test port')
    const baseUrl = `http://127.0.0.1:${address.port}/v1`
    f.providers = [{
      id: 'fixture',
      kind: 'model-service',
      displayName: 'Fixture',
      baseUrl,
      apiKeyEnv: 'FIXTURE_KEY',
      protocols: ['openai-responses'],
      models: { codex: ['model'] },
    }]
    f.persistedProvider = 'fixture'
    await writeFile(
      path.join(codexHome, 'config.toml'),
      [
        'model_provider="fixture"',
        '[model_providers.fixture]',
        `base_url="${baseUrl}"`,
        'env_key="FIXTURE_KEY"',
        'wire_api="responses"',
      ].join('\n'),
    )
    let service: Awaited<ReturnType<typeof startHeadlessService>> | undefined
    try {
      service = await startHeadlessService({ ...input, codexHome, environment: { FIXTURE_KEY: 'synthetic' } })
      const history = {
        model: 'model',
        input: [
          { type: 'message', role: 'user', content: 'original' },
          { type: 'reasoning', encrypted_content: 'foreign', summary: [] },
          { type: 'message', role: 'user', content: 'follow-up' },
        ],
      }
      await f.backendOptions!.nativeRequest('thread/resume', { threadId: 'saved' }, async prepared => {
        const config = prepared.config as Record<string, { base_url: string; env_key: string }>
        const route = config['model_providers.fixture']!
        expect(route.env_key).toBe('FIXTURE_KEY')
        const result = await fetch(`${route.base_url}/responses`, {
          method: 'POST',
          headers: { authorization: 'Bearer synthetic' },
          body: JSON.stringify(history),
        })
        expect(await result.text()).toBe('recovered')
        return {}
      })
      expect(requests).toHaveLength(2)
      expect(requests.map(request => request.auth)).toEqual(['Bearer synthetic', 'Bearer synthetic'])
      expect(requests[0]!.body.input as unknown[]).toHaveLength(3)
      expect(requests[1]!.body.input as unknown[]).toEqual([history.input[0], history.input[2]])
    } finally {
      await service?.close()
      upstream.closeAllConnections()
      await new Promise<void>(resolve => upstream.close(() => resolve()))
      await rm(codexHome, { recursive: true, force: true })
    }
  })
  it('keeps native OpenAI recovery opt-in and uses the shared transport when enabled', async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), 'headless-native-recovery-'))
    const requests: { auth: string | undefined; input: unknown[] }[] = []
    const upstream = createServer(async (request, response) => {
      let raw = ''
      for await (const chunk of request) raw += chunk
      requests.push({ auth: request.headers.authorization, input: JSON.parse(raw).input })
      if (requests.length === 1) {
        response.writeHead(400).end(JSON.stringify({ error: { code: 'invalid_encrypted_content' } }))
      } else response.writeHead(200).end('recovered')
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('missing test port')
    await writeFile(path.join(codexHome, 'config.toml'), `openai_base_url="http://127.0.0.1:${address.port}/v1"\n`)
    f.recoveryAccount = { account: { type: 'apiKey' } }
    let service: Awaited<ReturnType<typeof startHeadlessService>> | undefined
    try {
      service = await startHeadlessService({ ...input, codexHome, environment: {} })
      await f.backendOptions!.nativeRequest('thread/start', { modelProvider: 'openai' }, async prepared => {
        expect(prepared.config).toBeUndefined()
        return {}
      })
      expect(f.accountReads).toBe(0)
      await service!.close()
      service = await startHeadlessService({
        ...input,
        codexHome,
        environment: { CORDISX_EXPERIMENTAL_NATIVE_OPENAI_RECOVERY: '1' },
      })
      const original = [{ type: 'message', role: 'user', content: 'original' }, {
        type: 'reasoning',
        encrypted_content: 'foreign',
        summary: [],
      }]
      await f.backendOptions!.nativeRequest('thread/start', { modelProvider: 'openai' }, async prepared => {
        const route = (prepared.config as { openai_base_url: string }).openai_base_url
        const response = await fetch(`${route}/responses`, {
          method: 'POST',
          headers: { authorization: 'Bearer synthetic' },
          body: JSON.stringify({ input: original }),
        })
        expect(await response.text()).toBe('recovered')
        return {}
      })
      expect(requests).toEqual([
        { auth: 'Bearer synthetic', input: original },
        { auth: 'Bearer synthetic', input: [original[0]] },
      ])
      expect(f.accountReads).toBeGreaterThan(1)
      expect(f.backendEnvironment?.CORDISX_EXPERIMENTAL_NATIVE_OPENAI_RECOVERY).toBeUndefined()
      await service!.close()
      f.recoveryAccount = { account: null, requiresOpenaiAuth: false }
      service = await startHeadlessService({
        ...input,
        codexHome,
        environment: { CORDISX_EXPERIMENTAL_NATIVE_OPENAI_RECOVERY: '1' },
      })
      await f.backendOptions!.nativeRequest('thread/start', { modelProvider: 'openai' }, async prepared => {
        expect(prepared.config).toBeUndefined()
        return {}
      })
      expect(requests).toHaveLength(2)
    } finally {
      await service?.close()
      upstream.closeAllConnections()
      await new Promise<void>(resolve => upstream.close(() => resolve()))
      await rm(codexHome, { recursive: true, force: true })
    }
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
})
