import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createIntegrationStatus,
  type IntegrationStatusInput,
} from '../packages/cli/src/launcher/integration-status.js'

const CLI_ID = '0b5c8a52-6c6a-4a1c-b982-51a43c159cba'

async function home(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'cx-integration-status-'))
}

/** A home config with one service both apps can use, and one Codex-only service. */
async function writeConfig(
  homeDir: string,
  options: { readonly key?: string; readonly responsesKey?: string; readonly invalid?: boolean } = {},
) {
  const document = {
    version: 1,
    defaultApp: 'codex',
    environmentVariables: [
      ...(options.key === undefined ? [] : [{ name: 'UNIFIED_KEY', value: options.key, enabled: true }]),
      ...(options.responsesKey === undefined
        ? []
        : [{ name: 'RESPONSES_KEY', value: options.responsesKey, enabled: true }]),
    ],
    providers: [
      {
        id: 'unified',
        kind: 'model-service',
        displayName: 'Unified service',
        baseUrl: 'https://unified.invalid',
        apiKeyEnv: 'UNIFIED_KEY',
        protocols: ['anthropic-messages', 'openai-responses'],
        models: { codex: ['gpt-6.1-sol'], claude: ['claude-opus-5-5'] },
      },
      {
        id: 'responses-only',
        kind: 'model-service',
        displayName: 'Responses only',
        baseUrl: 'https://responses.invalid',
        apiKeyEnv: 'RESPONSES_KEY',
        protocols: ['openai-responses'],
        models: { codex: ['gpt-6.1-sol'] },
      },
    ],
    plugins: [],
    permissions: [],
    publisherGrantIssuers: [],
    marketplaceSources: [],
    apps: {
      codex: { defaultProfile: 'default', profiles: { default: { displayName: 'Default', dataMode: 'shared' } } },
    },
  }
  await mkdir(homeDir, { recursive: true })
  await writeFile(
    path.join(homeDir, 'config.json'),
    options.invalid === true ? '{not json' : JSON.stringify(document),
  )
}

/** The files `cordisx start codex` and `cordisx start claude` leave behind. */
async function writeLaunchRecords(
  homeDir: string,
  input: {
    readonly codexProfile?: string
    readonly modelServiceId?: string
    readonly claudeProfile?: string
    readonly claudeProvider?: string
  } = {},
) {
  await mkdir(path.join(homeDir, 'run'), { recursive: true })
  await writeFile(
    path.join(homeDir, 'run', 'agent-bridge.json'),
    JSON.stringify({ version: 1, socketPath: path.join(homeDir, 'run', 'agent-bridge.sock'), token: 'secret-token' }),
  )
  if (input.codexProfile !== undefined) {
    await writeFile(
      path.join(homeDir, 'run', 'codex-launch.json'),
      JSON.stringify({
        version: 1,
        homeDir,
        profileId: input.codexProfile,
        ...(input.modelServiceId === undefined ? {} : { modelServiceId: input.modelServiceId }),
      }),
    )
  }
  if (input.claudeProfile !== undefined) {
    const dataDir = path.join(homeDir, 'apps', 'claude', 'profiles', input.claudeProfile, 'data-3p')
    await mkdir(dataDir, { recursive: true })
    await writeFile(
      path.join(homeDir, 'run', 'claude-desktop.json'),
      JSON.stringify({
        version: 1,
        profileId: input.claudeProfile,
        homeDir,
        dataDir,
        ...(input.claudeProvider === undefined ? {} : {
          provider: { id: input.claudeProvider, baseUrl: 'https://unified.invalid', apiKeyEnv: 'UNIFIED_KEY' },
        }),
      }),
    )
  }
}

async function assembleClaudePlugin(homeDir: string, profileId: string): Promise<string> {
  const directory = path.join(homeDir, 'apps', 'claude', 'profiles', profileId, 'cordisx-plugin')
  await mkdir(path.join(directory, 'hooks'), { recursive: true })
  await writeFile(path.join(directory, 'hooks', 'register.ts'), '')
  return directory
}

const status = (overrides: Partial<IntegrationStatusInput> & { readonly cordisxHomeDir: string }) =>
  createIntegrationStatus({ caller: 'codex', environment: {}, ...overrides })

describe('integration status', () => {
  it('reports a healthy pair with both sides answering and their declared services', async () => {
    const homeDir = await home()
    await writeConfig(homeDir, { key: 'sk-live', responsesKey: 'sk-live-2' })
    await writeLaunchRecords(homeDir, {
      codexProfile: 'work',
      modelServiceId: 'unified',
      claudeProfile: 'e2e',
      claudeProvider: 'unified',
    })
    await assembleClaudePlugin(homeDir, 'e2e')
    const report = await status({
      cordisxHomeDir: homeDir,
      bridgeAnswers: () => true,
      claudePluginPolling: () => true,
      runningClaudePid: async () => 42,
      codexAppServer: async () => true,
    })()

    expect(report).toMatchObject({
      version: 1,
      status: 'ok',
      app: 'codex',
      cordisxHome: homeDir,
      self: { app: 'codex', status: 'ok', profileId: 'work', modelService: { id: 'unified', declared: true } },
      other: { app: 'claude', status: 'ok', profileId: 'e2e', modelService: { id: 'unified', declared: true } },
      problems: [],
    })
    expect(report.self.bridge).toMatchObject({ status: 'ok', token: 'present' })
    expect(report.other.bridge).toMatchObject({ status: 'ok', token: 'present' })
    expect(report.plugins).toMatchObject({
      claudePluginDirectory: { status: 'ok' },
      claudeSessionTools: { status: 'ok' },
      codexAppServer: { status: 'ok' },
    })
    // The key is reported as present, never by value.
    expect(JSON.stringify(report)).not.toContain('sk-live')
  })

  it('names a missing token and tells the agent how to create the bridge', async () => {
    const homeDir = await home()
    await writeConfig(homeDir)
    const report = await status({
      cordisxHomeDir: homeDir,
      bridgeAnswers: () => false,
      runningClaudePid: async () => undefined,
    })()

    expect(report.status).toBe('unavailable')
    expect(report.self.bridge.token).toBe('missing')
    expect(report.self).toMatchObject({ status: 'not-running', reason: 'bridge-binding-missing' })
    expect(report.self.remedy).toContain('cordisx start codex')
    expect(report.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ area: 'self.bridge', reason: 'bridge-binding-missing', remedy: expect.any(String) }),
    ]))
  })

  it('separates a Codex host that is running without a bridge from one that is not running', async () => {
    const homeDir = await home()
    await writeConfig(homeDir)
    await writeLaunchRecords(homeDir, { codexProfile: 'work' })

    const running = await status({
      cordisxHomeDir: homeDir,
      bridgeAnswers: () => false,
      codexHostStatus: async () => 'running',
      runningClaudePid: async () => undefined,
    })()
    expect(running.self).toMatchObject({ status: 'unreachable', reason: 'codex-running-without-bridge' })
    expect(running.self.remedy).toContain('cordisx restart codex work')

    const stopped = await status({
      cordisxHomeDir: homeDir,
      bridgeAnswers: () => false,
      codexHostStatus: async () => 'stopped',
      runningClaudePid: async () => undefined,
    })()
    expect(stopped.self).toMatchObject({ status: 'not-running', reason: 'launch-record-without-process' })
  })

  it('reports a Claude profile with no recorded launch and one whose process is gone', async () => {
    const homeDir = await home()
    await writeConfig(homeDir)
    await writeLaunchRecords(homeDir, { codexProfile: 'work' })

    const unrecorded = await status({
      cordisxHomeDir: homeDir,
      bridgeAnswers: () => true,
      runningClaudePid: async () => undefined,
    })()
    expect(unrecorded.other).toMatchObject({ app: 'claude', status: 'not-configured', reason: 'profile-not-recorded' })
    expect(unrecorded.other.remedy).toContain('cordisx start claude')
    expect(unrecorded.plugins.claudePluginDirectory).toMatchObject({
      status: 'unknown',
      reason: 'claude-profile-not-recorded',
    })

    await writeLaunchRecords(homeDir, { claudeProfile: 'e2e' })
    await mkdir(path.join(homeDir, 'apps', 'claude', 'profiles', 'e2e'), { recursive: true })
    await writeFile(path.join(homeDir, 'apps', 'claude', 'profiles', 'e2e', 'claude.pid'), '4242\n')
    const stale = await status({
      cordisxHomeDir: homeDir,
      bridgeAnswers: () => true,
      runningClaudePid: async () => undefined,
    })()
    expect(stale.other).toMatchObject({ status: 'not-running', reason: 'pid-record-without-process', profileId: 'e2e' })
    expect(stale.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ area: 'other', reason: 'pid-record-without-process' }),
    ]))
  })

  it('distinguishes a Claude app whose plugin is not polling from one without bridge state', async () => {
    const homeDir = await home()
    await writeConfig(homeDir)
    await writeLaunchRecords(homeDir, { codexProfile: 'work', claudeProfile: 'e2e' })
    await assembleClaudePlugin(homeDir, 'e2e')

    const silent = await status({
      cordisxHomeDir: homeDir,
      bridgeAnswers: () => true,
      claudePluginPolling: () => false,
      runningClaudePid: async () => 42,
    })()
    expect(silent.other).toMatchObject({ status: 'ok' })
    expect(silent.other.bridge).toMatchObject({ status: 'not-connected', reason: 'claude-plugin-not-polling' })
    // The app itself is healthy, so the report is degraded rather than unavailable.
    expect(silent.status).toBe('degraded')
    expect(silent.plugins.claudeSessionTools).toMatchObject({
      status: 'not-connected',
      reason: 'claude-plugin-not-polling',
    })

    const unknown = await status({
      cordisxHomeDir: homeDir,
      bridgeAnswers: () => true,
      runningClaudePid: async () => 42,
    })()
    expect(unknown.other.bridge.reason).toBe('claude-plugin-state-unknown')
  })

  it('reports a missing and an unparsable plugin directory as their own fixes', async () => {
    const homeDir = await home()
    await writeConfig(homeDir)
    await writeLaunchRecords(homeDir, { claudeProfile: 'e2e' })

    const missing = await status({
      cordisxHomeDir: homeDir,
      bridgeAnswers: () => true,
      runningClaudePid: async () => 42,
      claudePluginPolling: () => true,
    })()
    expect(missing.plugins.claudePluginDirectory).toMatchObject({
      status: 'missing',
      reason: 'plugin-not-assembled',
      path: path.join(homeDir, 'apps', 'claude', 'profiles', 'e2e', 'cordisx-plugin'),
    })
    expect(missing.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        area: 'plugins.claudePluginDirectory',
        remedy: expect.stringContaining('restart claude e2e'),
      }),
    ]))
  })

  it("lists declared services with each app's usable models and never a key value", async () => {
    const homeDir = await home()
    await writeConfig(homeDir, { key: 'sk-from-config' })
    await writeLaunchRecords(homeDir, { codexProfile: 'work', claudeProfile: 'e2e' })

    const report = await status({
      cordisxHomeDir: homeDir,
      environment: {},
      bridgeAnswers: () => true,
      runningClaudePid: async () => 42,
      claudePluginPolling: () => true,
    })()
    expect(report.modelServices).toEqual([
      {
        id: 'unified',
        displayName: 'Unified service',
        keyVariable: 'UNIFIED_KEY',
        keySet: true,
        apps: {
          codex: { usable: true, models: ['gpt-6.1-sol'] },
          claude: { usable: true, models: ['claude-opus-5-5'] },
        },
      },
      {
        id: 'responses-only',
        displayName: 'Responses only',
        keyVariable: 'RESPONSES_KEY',
        keySet: false,
        apps: {
          codex: { usable: true, models: ['gpt-6.1-sol'] },
          claude: { usable: false, models: [], reason: 'protocol-unsupported' },
        },
      },
    ])
    expect(JSON.stringify(report)).not.toContain('sk-from-config')
    expect(report.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ area: 'model-service:responses-only', reason: 'key-not-set' }),
    ]))
  })

  it('reads a key from the launch environment before the config, and flags a service no app can use', async () => {
    const homeDir = await home()
    await writeConfig(homeDir)
    const config = JSON.parse(
      await (await import('node:fs/promises')).readFile(path.join(homeDir, 'config.json'), 'utf8'),
    )
    config.providers.push({
      id: 'unusable',
      kind: 'model-service',
      displayName: 'Unusable',
      baseUrl: 'https://unusable.invalid',
      apiKeyEnv: 'UNUSABLE_KEY',
      protocols: ['openai-responses'],
      models: { gemini: ['x'] },
    })
    await writeFile(path.join(homeDir, 'config.json'), JSON.stringify(config))
    await writeLaunchRecords(homeDir, { codexProfile: 'work', claudeProfile: 'e2e' })

    const report = await status({
      cordisxHomeDir: homeDir,
      environment: { UNIFIED_KEY: 'from-environment' },
      bridgeAnswers: () => true,
      runningClaudePid: async () => 42,
      claudePluginPolling: () => true,
    })()
    expect(report.modelServices.find(service => service.id === 'unified')?.keySet).toBe(true)
    expect(report.modelServices.find(service => service.id === 'unusable')?.apps.codex).toEqual({
      usable: false,
      models: [],
      reason: 'no-models',
    })
    expect(report.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ area: 'model-service:unusable', reason: 'no-app-can-use-it' }),
    ]))
    expect(JSON.stringify(report)).not.toContain('from-environment')
  })

  it('reports a missing home config and an invalid one as different fixes', async () => {
    const empty = await home()
    const missing = await status({
      cordisxHomeDir: empty,
      bridgeAnswers: () => false,
      runningClaudePid: async () => undefined,
    })()
    expect(missing.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        area: 'config',
        reason: 'home-config-missing',
        remedy: expect.stringContaining('cordisx setup'),
      }),
    ]))
    expect(missing.modelServices).toEqual([])

    const broken = await home()
    await writeConfig(broken, { invalid: true })
    const invalid = await status({
      cordisxHomeDir: broken,
      bridgeAnswers: () => false,
      runningClaudePid: async () => undefined,
    })()
    expect(invalid.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        area: 'config',
        reason: 'home-config-invalid',
        remedy: expect.stringContaining('config.json'),
      }),
    ]))
  })

  it("answers from either app's perspective, naming that app as self", async () => {
    const homeDir = await home()
    await writeConfig(homeDir, { key: 'sk' })
    await writeLaunchRecords(homeDir, { codexProfile: 'work', claudeProfile: 'e2e', claudeProvider: 'unified' })
    await assembleClaudePlugin(homeDir, 'e2e')
    const claudeView = await createIntegrationStatus({
      cordisxHomeDir: homeDir,
      caller: 'claude',
      environment: {},
      bridgeAnswers: () => true,
      claudePluginPolling: () => true,
      runningClaudePid: async () => 42,
    })()
    expect(claudeView.app).toBe('claude')
    expect(claudeView.self.app).toBe('claude')
    expect(claudeView.other.app).toBe('codex')
    expect(claudeView.self.modelService).toEqual({ id: 'unified', declared: true })

    const named = await createIntegrationStatus({
      cordisxHomeDir: homeDir,
      caller: 'claude',
      environment: {},
      bridgeAnswers: () => true,
      claudePluginPolling: () => true,
      runningClaudePid: async () => 42,
    })({ app: 'codex' })
    expect(named.app).toBe('codex')
    expect(named.self.app).toBe('codex')
  })

  it('never reports the bridge token, only whether one exists', async () => {
    const homeDir = await home()
    await writeConfig(homeDir)
    await writeLaunchRecords(homeDir, { codexProfile: 'work' })
    const report = await status({
      cordisxHomeDir: homeDir,
      bridgeAnswers: () => true,
      runningClaudePid: async () => undefined,
    })()
    expect(JSON.stringify(report)).not.toContain('secret-token')
    expect(report.self.bridge.token).toBe('present')
    expect(report.self.bridge.socketPath).toBe(path.join(homeDir, 'run', 'agent-bridge.sock'))
    expect(CLI_ID).toBeTruthy()
  })
})
