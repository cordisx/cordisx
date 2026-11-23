import { expect, it, vi } from 'vitest'
import {
  channelMemoryRuntimeConnection,
  channelMemoryServiceConnection,
} from '../packages/cli/src/launcher/channel-user-memory-connection.js'
import { createChannelUserMemoryAnalysis } from '../packages/cli/src/launcher/channel-user-memory-model.js'

it('uses only enabled declared models and exact Host credential references', async () => {
  const config = {
    providers: [{
      id: 'synthetic',
      kind: 'model-service' as const,
      displayName: 'Synthetic',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKeyEnv: 'TEST_KEY',
      models: { codex: ['test'] },
      protocols: ['openai-responses' as const],
      runtimeOptions: { codex: { env_http_headers: { 'x-test': 'HEADER' } } },
    }],
    environmentVariables: [{ name: 'TEST_KEY', value: 'private-fixture', enabled: false }, {
      name: 'HEADER',
      value: 'header-fixture',
      enabled: true,
    }],
  }
  const connect = channelMemoryServiceConnection(config, { TEST_KEY: 'external' })
  await expect(connect('synthetic', 'test', new AbortController().signal)).rejects.toThrow(
    'CHANNEL_USER_MEMORY_MODEL_UNAVAILABLE',
  )
  config.environmentVariables[0]!.enabled = true
  const connection = await connect('synthetic', 'test', new AbortController().signal)
  expect(connection.headers).toEqual({ authorization: 'Bearer private-fixture', 'x-test': 'header-fixture' })
  await expect(connect('other', 'test', new AbortController().signal)).rejects.toThrow(
    'CHANNEL_USER_MEMORY_MODEL_UNAVAILABLE',
  )
  await expect(connect('synthetic', 'unlisted', new AbortController().signal)).rejects.toThrow(
    'CHANNEL_USER_MEMORY_MODEL_UNAVAILABLE',
  )
})
it('releases managed gateway leases on retirement or mismatched models, never exposes them as context', async () => {
  let active = true
  const dispose = vi.fn(),
    prepare = vi.fn(async () => ({
      value: {
        models: { aliases: [{ gatewayModelId: 'test' }] },
        endpoint: { origin: 'http://localhost', apiPath: '/v1', auth: { scheme: 'bearer', token: 'private-fixture' } },
      },
      dispose,
    }))
  const connect = channelMemoryRuntimeConnection({
    active: () => active,
    managed: () => true,
    prepare: prepare as any,
    config: async () => ({ providers: [], environmentVariables: [] }),
    environment: {},
  })
  await expect(connect('synthetic', 'unlisted', new AbortController().signal)).rejects.toThrow(
    'CHANNEL_USER_MEMORY_MODEL_UNAVAILABLE',
  )
  expect(dispose).toHaveBeenCalledOnce()
  prepare.mockImplementationOnce(async () => {
    active = false
    return (await prepare())
  })
  await expect(connect('synthetic', 'test', new AbortController().signal)).rejects.toThrow(
    'CHANNEL_USER_MEMORY_MODEL_UNAVAILABLE',
  )
  expect(dispose).toHaveBeenCalledTimes(2)
  active = true
  const connection = await connect('synthetic', 'test', new AbortController().signal)
  expect(connection.headers.authorization).toBe('Bearer private-fixture')
  connection.dispose()
  expect(dispose).toHaveBeenCalledTimes(3)
})
it('unsupported plain inference disposes connection and does not execute or substitute an Agent', async () => {
  const dispose = vi.fn()
  const analyze = createChannelUserMemoryAnalysis(async () => ({
    baseUrl: 'http://127.0.0.1:1/v1',
    headers: {},
    protocols: ['anthropic-messages'],
    dispose,
  }))
  await expect(analyze('I am a designer', { providerId: 'synthetic', model: 'test' }, new AbortController().signal))
    .rejects.toThrow('CHANNEL_USER_MEMORY_MODEL_UNAVAILABLE')
  expect(dispose).toHaveBeenCalledOnce()
})
