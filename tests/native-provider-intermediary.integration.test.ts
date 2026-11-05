import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { harness } from './fixtures/native-intermediary-harness.js'
import { configuredEncryptedReplay } from '../packages/cli/src/launcher/configured-encrypted-replay.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  draftAction,
  draftScope,
  harness as submissionHarness,
  pendingDraft,
} from './fixtures/native-submission-controller-harness.js'

it('preserves request auth for a marked configured start through the real submission controller', async () => {
  const configured = {
    'model_providers.configured': {
      wire_api: 'responses',
      base_url: 'http://127.0.0.1:1234/opaque',
      env_key: 'DISK_KEY',
    },
  }
  const controller = submissionHarness({
    pending: { ...pendingDraft, providerId: 'configured' },
    providerSource: () => 'config',
    prepareConfiguredProvider: async () => configured,
  })
  const h = await harness(controller.controller, 'native-provider-process.mjs')
  try {
    h.send({ id: 'init', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    await h.read()
    const prepared = await controller.controller.prepareSubmission(draftScope, draftAction)
    if (prepared.kind !== 'allow-original') throw new Error('Configured draft rejected')
    h.send({
      id: 'marked-configured',
      method: 'thread/start',
      params: {
        modelProvider: 'openai',
        config: {
          'cordisx.operation_token': prepared.operationToken,
          'model_providers.configured': { env_key: 'REQUEST_KEY', requires_openai_auth: true },
        },
      },
    })
    const result = JSON.parse(await h.read()).result
    expect(result.current).toBe('configured')
    expect(result.receivedConfig['model_providers.configured']).toEqual({
      wire_api: 'responses',
      base_url: 'http://127.0.0.1:1234/opaque',
      env_key: 'REQUEST_KEY',
      requires_openai_auth: true,
    })
  } finally {
    await h.close()
    await controller.controller.dispose()
  }
})

it('composes configured Responses identity routing with its original authentication and request overrides', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'configured-provider-'))
  const h = await harness(undefined, 'native-provider-process.mjs')
  try {
    await writeFile(
      path.join(home, 'config.toml'),
      'model_provider="configured"\n[model_providers.configured]\nname="Configured"\nbase_url="https://example.com/v1"\nenv_key="ORIGINAL_KEY"\n[model_providers.configured.http_headers]\ncustom="test-private-token"\n',
    )
    h.server.bindConfiguredProvider(configuredEncryptedReplay(home, () => 'http://127.0.0.1:1234/opaque'))
    h.send({ id: 'init', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    await h.read()
    h.send({ method: 'initialized', params: {} })
    h.send({
      id: 'configured',
      method: 'thread/start',
      params: {
        modelProvider: 'configured',
        model: 'test-model',
        config: {
          'model_providers.configured.env_key': 'DOTTED_KEY',
          'model_providers.configured': { env_key: 'REQUEST_KEY', requires_openai_auth: true },
        },
      },
    })
    const result = JSON.parse(await h.read()).result
    expect(result.modelProvider).toBe('configured')
    expect(result.current).toBe('configured')
    expect(result.argvHasSecret).toBe(false)
    expect(result.receivedConfig).toEqual({
      'model_providers.configured.env_key': 'DOTTED_KEY',
      'model_providers.configured': {
        name: 'Configured',
        env_key: 'REQUEST_KEY',
        requires_openai_auth: true,
        wire_api: 'responses',
        base_url: 'http://127.0.0.1:1234/opaque',
        http_headers: { custom: 'test-private-token' },
      },
    })
  } finally {
    await h.close()
    await rm(home, { recursive: true, force: true })
  }
})

it('routes the normal intermediary startup and admitted first turn through a matching native provider process', async () => {
  const h = await harness(undefined, 'native-provider-process.mjs')
  try {
    h.send({ id: 'init', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    expect(JSON.parse(await h.read()).id).toBe('init')
    h.send({ method: 'initialized', params: {} })
    h.send({
      id: 'start',
      method: 'thread/start',
      params: {
        config: { 'cordisx.operation_token': 'allowed-operation-token' },
        modelProvider: 'openai',
      },
    })
    const started = JSON.parse(await h.read())
    expect(started.result.modelProvider).toBe('provider-b')
    const threadId = started.result.thread.id
    h.send({
      id: 'turn',
      method: 'turn/start',
      params: {
        threadId,
        input: [{ type: 'text', text: 'opaque original input' }],
        config: { 'cordisx.operation_token': 'allowed-firstturn-token' },
      },
    })
    expect(JSON.parse(await h.read()).result.current).toBe('provider-b')
    expect(h.authorize).toHaveBeenCalledTimes(2)
    expect(h.complete).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'turn', succeeded: true }))
  } finally {
    await h.close()
  }
})

it('resumes a persisted provider through normal Host preparation and keeps native config on the primary connection', async () => {
  const h = await harness(undefined, 'native-provider-process.mjs')
  try {
    h.send({ id: 'init', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    await h.read()
    h.send({ method: 'initialized', params: {} })
    h.send({ id: 'resume', method: 'thread/resume', params: { threadId: 'saved-provider-b', excludeTurns: true } })
    const resumed = JSON.parse(await h.read())
    expect(resumed.result.thread.id).toBe('saved-provider-b')
    expect(resumed.result.modelProvider).toBe('provider-b')
    expect(h.prepareThreadResume).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'saved-provider-b', providerId: 'provider-b' }),
    )
    h.send({ id: 'turn', method: 'turn/start', params: { threadId: 'saved-provider-b', input: [] } })
    expect(JSON.parse(await h.read()).result.current).toBe('provider-b')
    h.send({ id: 'config', method: 'config/read', params: {} })
    expect(JSON.parse(await h.read()).result.current).toBe('openai')
  } finally {
    await h.close()
  }
})

it('delivers source runtime options to the inert native worker without stale nested or dotted values', async () => {
  const { projectModelServicesToCodex } = await import('../packages/cli/src/launcher/model-service-projection.js')
  const { parseHomeConfig, createDefaultHomeConfig } = await import('../packages/cli/src/config/home-config.js')
  const { hostModelServiceEnvironment } = await import('../packages/cli/src/cli/native-submission-catalog-options.js')
  const { modelServiceHeaderEnvironmentName } = await import('../packages/cli/src/launcher/model-service-runtime.js')
  const home = await mkdtemp(path.join(tmpdir(), 'configured-runtime-worker-'))
  const provider = {
    id: 'configured',
    kind: 'model-service',
    displayName: 'Configured',
    baseUrl: 'https://example.com/v1',
    apiKeyEnv: 'SERVICE_KEY',
    protocols: ['openai-responses'],
    models: { codex: ['test-model'] },
    runtimeOptions: {
      codex: {
        http_headers: { 'X-Private': 'test-private-token', 'X-Empty': '' },
        env_http_headers: { 'X-Env': 'HEADER_KEY' },
        supports_websockets: false,
        request_max_retries: 0,
        stream_max_retries: 3,
        stream_idle_timeout_ms: 0,
      },
    },
  }
  const config = parseHomeConfig({ ...createDefaultHomeConfig(), providers: [provider] })
  const environment = hostModelServiceEnvironment(
    { SERVICE_KEY: 'fixture-key', HEADER_KEY: 'test-private-token' },
    [],
    undefined,
    config.providers,
  )
  const h = await harness(undefined, 'native-provider-process.mjs', undefined, environment)
  try {
    await projectModelServicesToCodex(config.providers, home)
    h.prepareThreadResume.mockImplementation(async () => ({ kind: 'reject', reason: 'provider-preparation-failed' }))
    let prepare = configuredEncryptedReplay(home, () => 'http://127.0.0.1:1234/route', config.providers)
    h.server.bindConfiguredProvider(id => prepare(id))
    h.send({ id: 'runtime-init', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    await h.read()
    h.send({ method: 'initialized', params: {} })
    h.send({
      id: 'runtime-start',
      method: 'thread/start',
      params: {
        modelProvider: 'configured',
        model: 'test-model',
        config: {
          model_providers: { configured: { request_max_retries: 41, nested_native_option: 'keep' } },
          'model_providers.configured': {
            supports_websockets: true,
            request_max_retries: 42,
            http_headers: { 'X-Stale': 'stale-secret' },
            other_native_option: 'keep',
          },
          'model_providers.configured.stream_idle_timeout_ms': 43,
          'model_providers.configured.env_http_headers.X-Stale': 'STALE_HEADER',
        },
      },
    })
    const result = JSON.parse(await h.read()).result
    expect(result.current).toBe('configured')
    expect(result.workerInert).toBe(true)
    expect(result.argvHasSecret).toBe(false)
    expect(result.runtimeHeaderResolved).toBe(true)
    expect(JSON.stringify(result.receivedConfig)).not.toMatch(/test-private-token|stale-secret|STALE_HEADER/)
    expect(result.receivedConfig['model_providers.configured']).toMatchObject({
      http_headers: { 'X-Empty': '' },
      supports_websockets: false,
      request_max_retries: 0,
      stream_max_retries: 3,
      stream_idle_timeout_ms: 0,
      env_http_headers: {
        'X-Env': 'HEADER_KEY',
        'X-Private': modelServiceHeaderEnvironmentName('configured', 'X-Private'),
      },
      other_native_option: 'keep',
      nested_native_option: 'keep',
    })
    expect(result.receivedConfig.model_providers).toBeUndefined()
    expect(result.receivedConfig['model_providers.configured.stream_idle_timeout_ms']).toBeUndefined()
    const cleared = parseHomeConfig({
      ...createDefaultHomeConfig(),
      providers: [{ ...provider, runtimeOptions: { codex: {} } }],
    })
    await projectModelServicesToCodex(cleared.providers, home)
    prepare = configuredEncryptedReplay(home, () => 'http://127.0.0.1:1234/route', cleared.providers)
    h.send({
      id: 'runtime-resume',
      method: 'thread/resume',
      params: {
        threadId: result.thread.id,
        modelProvider: 'configured',
        config: result.receivedConfig,
      },
    })
    const resumed = JSON.parse(await h.read()).result
    const definition = resumed.receivedConfig['model_providers.configured']
    for (
      const key of [
        'http_headers',
        'env_http_headers',
        'supports_websockets',
        'request_max_retries',
        'stream_max_retries',
        'stream_idle_timeout_ms',
      ]
    ) {
      expect(definition[key]).toBeUndefined()
    }
    expect(definition.other_native_option).toBe('keep')
    // Delete the source, then load the file in a separate launcher process.
    // The new worker must still reject all old provider options on Resume.
    await projectModelServicesToCodex([], home)
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
        import { configuredEncryptedReplay } from './packages/cli/src/launcher/configured-encrypted-replay.ts'
        const prepare = configuredEncryptedReplay(process.argv[1], () => 'http://127.0.0.1:1234/route')
        process.stdout.write(JSON.stringify(await prepare('configured')))
      `,
      home,
    ], { timeout: 5000, env: { PATH: process.env.PATH } })
    const coldOverrides = JSON.parse(stdout)
    expect(coldOverrides['cordisx.model_service_options']).toEqual(['configured'])
    await h.close()
    const fresh = await harness(undefined, 'native-provider-process.mjs')
    try {
      fresh.prepareThreadResume.mockImplementation(async () => ({
        kind: 'reject',
        reason: 'provider-preparation-failed',
      }))
      fresh.server.bindConfiguredProvider(async () => coldOverrides)
      fresh.send({ id: 'cold-init', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
      await fresh.read()
      fresh.send({ method: 'initialized', params: {} })
      fresh.send({
        id: 'cold-resume',
        method: 'thread/resume',
        params: {
          threadId: result.thread.id,
          modelProvider: 'configured',
          config: { ...result.receivedConfig, 'model_providers.configured.stream_idle_timeout_ms': 43 },
        },
      })
      const cold = JSON.parse(await fresh.read()).result
      expect(cold.workerInert).toBe(true)
      expect(cold.receivedConfig['cordisx.model_service_options']).toBeUndefined()
      expect(cold.receivedConfig['model_providers.configured.stream_idle_timeout_ms']).toBeUndefined()
      expect(cold.receivedConfig['model_providers.configured']).toEqual(definition)
    } finally {
      await fresh.close()
    }
  } finally {
    await h.close()
    await rm(home, { recursive: true, force: true })
  }
})
