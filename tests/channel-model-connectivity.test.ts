import { afterEach, expect, it, vi } from 'vitest'
import { channelModelConnectivity } from '../packages/cli/src/launcher/channel-model-connectivity.js'
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
