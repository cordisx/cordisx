import { afterEach, expect, it, vi } from 'vitest'
import {
  channelModelConnectivity,
  channelModelConnectivityEvidence,
} from '../packages/cli/src/launcher/channel-model-connectivity.js'
import type { ChannelMemoryModelConnection } from '../packages/cli/src/launcher/channel-user-memory-model.js'
import { channelMemoryRuntimeConnection } from '../packages/cli/src/launcher/channel-user-memory-connection.js'

const candidate = { providerId: 'provider', model: 'model' }
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('probes only synthetic input without tools and disposes the credential lease', async () => {
  const dispose = vi.fn()
  const connect: ChannelMemoryModelConnection = async () => ({
    baseUrl: 'https://example.test/v1',
    headers: {},
    dispose,
  })
  const fetch = vi.fn(async () => new Response(JSON.stringify({ status: 'completed' }), { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  expect(await channelModelConnectivity(connect, candidate)).toBe(true)
  const [url, request] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://example.test/v1/responses')
  expect(JSON.parse(String(request.body))).toMatchObject({
    model: 'model',
    tools: [],
    tool_choice: 'none',
    store: false,
    stream: false,
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Connectivity check.' }] }],
  })
  expect(JSON.parse(String(request.body)).prompt_cache_key).toMatch(/^[0-9a-f-]{36}$/u)
  expect(dispose).toHaveBeenCalledOnce()
})

it.each([401, 403, 408, 429, 500, 503])('skips a candidate on probe HTTP %s', async status => {
  const dispose = vi.fn()
  const connect: ChannelMemoryModelConnection = async () => ({ baseUrl: 'https://example.test', headers: {}, dispose })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })))
  expect(await channelModelConnectivity(connect, candidate)).toBe(false)
  expect(dispose).toHaveBeenCalledOnce()
})

it('skips a network failure but treats an unsupported connection as inconclusive', async () => {
  const dispose = vi.fn()
  const connect: ChannelMemoryModelConnection = async () => ({ baseUrl: 'https://example.test', headers: {}, dispose })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network')
    }),
  )
  expect(await channelModelConnectivity(connect, candidate)).toBe(false)
  expect(dispose).toHaveBeenCalledOnce()
  expect(await channelModelConnectivity(undefined, candidate)).toBe(true)
  expect(
    await channelModelConnectivity(async () => {
      throw new Error('unsupported')
    }, candidate),
  ).toBe(true)
})

it('skips a managed provider whose connection preparation fails', async () => {
  const connect = channelMemoryRuntimeConnection({
    active: () => true,
    managed: () => true,
    prepare: async () => {
      throw new Error('private provider details')
    },
    config: async () => ({ providers: [], environmentVariables: [] }),
    environment: {},
  })
  expect(await channelModelConnectivity(connect, candidate)).toBe(false)
})

it('bounds a stalled connection and disposes a lease that arrives after the timeout', async () => {
  let resolve!: (value: Awaited<ReturnType<ChannelMemoryModelConnection>>) => void
  const dispose = vi.fn()
  const connect: ChannelMemoryModelConnection = () =>
    new Promise(done => {
      resolve = done
    })
  const probe = channelModelConnectivity(connect, candidate, undefined, 20)
  expect(await probe).toBe(false)
  resolve({ baseUrl: 'https://example.test', headers: {}, dispose })
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
})

it('rechecks authority after obtaining a connection and before sending a probe', async () => {
  const dispose = vi.fn()
  const connect: ChannelMemoryModelConnection = async () => ({ baseUrl: 'https://example.test', headers: {}, dispose })
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  expect(await channelModelConnectivity(connect, candidate, undefined, 1000, async () => false)).toBe(false)
  expect(fetch).not.toHaveBeenCalled()
  expect(dispose).toHaveBeenCalledOnce()
})

it('distinguishes a completed real probe from unsupported or malformed responses', async () => {
  const connect: ChannelMemoryModelConnection = async () => ({
    baseUrl: 'https://example.test',
    headers: {},
    dispose: () => {},
  })
  expect(await channelModelConnectivityEvidence(undefined, candidate)).toBe('inconclusive')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'completed', model: 'model' }))))
  expect(await channelModelConnectivityEvidence(connect, candidate)).toBe('healthy')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'completed', model: 'other' }))))
  expect(await channelModelConnectivityEvidence(connect, candidate)).toBe('inconclusive')
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not json')))
  expect(await channelModelConnectivityEvidence(connect, candidate)).toBe('inconclusive')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
  expect(await channelModelConnectivityEvidence(connect, candidate)).toBe('unavailable')
})

it('does not interpret cancellation, a revoked fence or an unknown fetch error as service failure', async () => {
  const connect: ChannelMemoryModelConnection = async () => ({
    baseUrl: 'https://example.test',
    headers: {},
    dispose: () => {},
  })
  const cancelled = AbortSignal.abort()
  expect(await channelModelConnectivityEvidence(connect, candidate, cancelled)).toBe('cancelled')
  expect(await channelModelConnectivityEvidence(connect, candidate, undefined, 1000, async () => false))
    .toBe('cancelled')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('unknown')
    }),
  )
  expect(await channelModelConnectivityEvidence(connect, candidate)).toBe('inconclusive')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network', { cause: { code: 'ECONNRESET' } })
    }),
  )
  expect(await channelModelConnectivityEvidence(connect, candidate)).toBe('unavailable')
})

it('does not treat an incomplete connection setup or a failed authority check as a model failure', async () => {
  const stalled: ChannelMemoryModelConnection = () => new Promise(() => {})
  expect(await channelModelConnectivityEvidence(stalled, candidate, undefined, 20)).toBe('inconclusive')
  const connect: ChannelMemoryModelConnection = async () => ({
    baseUrl: 'https://example.test',
    headers: {},
    dispose: () => {},
  })
  const denied = async () => {
    throw new Error('guard', { cause: { code: 'ECONNRESET' } })
  }
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  expect(await channelModelConnectivityEvidence(connect, candidate, undefined, 1000, denied)).toBe('inconclusive')
  expect(fetch).not.toHaveBeenCalled()
})

it('bounds a stalled authorization recheck without sending a probe or declaring service failure', async () => {
  const connect: ChannelMemoryModelConnection = async () => ({
    baseUrl: 'https://example.test',
    headers: {},
    dispose: () => {},
  })
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  expect(await channelModelConnectivityEvidence(connect, candidate, undefined, 20, () => new Promise(() => {})))
    .toBe('inconclusive')
  expect(fetch).not.toHaveBeenCalled()
})
