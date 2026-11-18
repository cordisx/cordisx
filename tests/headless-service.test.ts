import { beforeEach, describe, expect, it, vi } from 'vitest'
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

const f = vi.hoisted(() => ({ events: [] as string[], failStart: false, enabled: true }))
vi.mock(
  '../packages/cli/src/launcher/config.js',
  () => ({
    loadConfig: async () => ({ plugins: [{ id: 'channel', enabled: f.enabled, entry: '/plugin/index.mjs' }] }),
  }),
)
vi.mock('../packages/cli/src/launcher/plugin-activation.js', () => ({
  PluginActivationStore: class {
    async loadActive() {
      return {}
    }
  },
}))
vi.mock('../packages/cli/src/launcher/plugin-composition.js', () => ({ loadPluginComposition: async () => [] }))
vi.mock(
  '../packages/cli/src/config/service-config.js',
  () => ({ readServiceConfigState: async () => ({ config: {} }) }),
)
vi.mock('../packages/cli/src/launcher/channel-service.js', () => ({
  CHANNEL_SERVICE_CONFIG_INITIAL: {},
  createLocalChannelService: () => ({
    conversationAccess: () => undefined,
    start: async () => {
      f.events.push('service-start')
      if (f.failStart) throw new Error('start failed')
    },
    dispose: async () => {
      f.events.push('service-close')
    },
  }),
}))
vi.mock('../packages/cli/src/launcher/headless-codex-backend.js', () => ({
  startHeadlessCodexBackend: async () => {
    f.events.push('backend-start')
    return {
      call: async () => ({}),
      nativeRequest: async () => ({}),
      close: async () => {
        f.events.push('backend-close')
      },
    }
  },
}))
vi.mock('../packages/cli/src/launcher/channel-native-sessions.js', () => ({ ChannelNativeSessions: class {} }))
vi.mock('../packages/cli/src/launcher/channel-cli-context.js', () => ({ configuredChannelCliContext: () => ({}) }))
vi.mock('../packages/cli/src/launcher/plugin-documents.js', () => ({ configuredPluginDocuments: async () => ({}) }))
vi.mock(
  '../packages/cli/src/cli/channel-consumer-composition.js',
  () => ({
    createConfiguredChannelConsumer: async () => {
      f.events.push('consumer-attached')
      return {
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
    authority: { request: () => ({}) },
    setReader: () => {},
    close: async () => {
      f.events.push('authority-close')
    },
  }),
}))
import { startHeadlessService } from '../packages/cli/src/cli/headless-service.js'

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
  })
  it('attaches the consumer before ingress and disposes in reverse order once', async () => {
    const service = await startHeadlessService(input)
    expect(f.events).toEqual(['backend-start', 'consumer-attached', 'service-start'])
    await Promise.all([service!.close(), service!.close()])
    expect(f.events.slice(3)).toEqual(['consumer-close', 'service-close', 'backend-close', 'authority-close'])
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
})
