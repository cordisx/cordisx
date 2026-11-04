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
