import { afterEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { Context } from '@deepseek-ai/cordis'
import type { RasterImageSnapshotV1 } from '@cordisx/protocol/raster-image/v1'
import {
  ChannelAccountIdentityStore,
  loadChannelAccountAvatar,
} from '../packages/cli/src/launcher/channel-account-identity.js'
import { feishuProfileHttp } from '../packages/cli/src/launcher/feishu-profile-http.js'
import { projectLocalChannelManager } from '../packages/cli/src/launcher/channel-service.js'
import { CordisXChannelManagerService } from '../packages/cli/src/renderer/channel-manager.js'
import { createChannelActionsBridgeHandler } from '../packages/cli/src/launcher/channel-actions-rpc.js'
import { createFeishuAdapterDefinition } from '../packages/cli/src/launcher/feishu-adapter.js'
import type { ChannelAdapterHost } from '@cordisx/channel-runtime'

const account = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'fixture' }
const image: RasterImageSnapshotV1 = {
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/raster-image-snapshot.v1.schema.json',
  contract: 'cordisx.raster-image-snapshot/v1',
  schemaVersion: 1,
  mediaType: 'image/png',
  encoding: 'base64',
  width: 1,
  height: 1,
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
}
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Channel account identity', () => {
  it('retains only the SDK authenticated bot profile and preserves the connection result', async () => {
    const response = {
      bot: { open_id: 'private-identity', app_name: 'Support bot', avatar_url: 'https://a.feishucdn.com/avatar.png' },
      token: 'private',
    }
    const request = vi.spyOn(defaultHttpInstance, 'request').mockResolvedValue(response)
    const receive = vi.fn()
    const http = feishuProfileHttp(receive)
    await expect(http.request({ url: 'https://open.feishu.cn/open-apis/bot/v3/info', method: 'GET' })).resolves.toBe(
      response,
    )
    expect(receive).toHaveBeenCalledWith({ name: 'Support bot', avatarUrl: response.bot.avatar_url })
    receive.mockImplementation(() => {
      throw new Error('visual-failed')
    })
    await expect(http.request({ url: '/open-apis/bot/v3/info', method: 'GET' })).resolves.toBe(response)
    await http.request({ url: '/open-apis/im/v1/messages', method: 'GET' })
    expect(receive).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('normalizes CDN JPEGs without account headers and rejects redirected private endpoints', async () => {
    const bytes = await sharp({ create: { width: 300, height: 160, channels: 3, background: '#426cab' } }).jpeg()
      .toBuffer()
    const fetcher = vi.fn<typeof fetch>(async () => new Response(bytes))
    vi.stubGlobal('fetch', fetcher)
    const result = await loadChannelAccountAvatar('https://a.feishucdn.com/avatar.jpg', new AbortController().signal)
    expect(result).toMatchObject({ width: 128, height: 128, encoding: 'base64', mediaType: 'image/png' })
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit', redirect: 'manual' })
    fetcher.mockImplementation(async () =>
      new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } })
    )
    await expect(loadChannelAccountAvatar('https://a.feishucdn.com/avatar.jpg', new AbortController().signal)).rejects
      .toThrow('source-unavailable')
    await expect(loadChannelAccountAvatar('https://feishucdn.com.evil.test/avatar.jpg', new AbortController().signal))
      .rejects.toThrow('source-unavailable')
  })

  it('contains unavailable artwork and drops stale account images', async () => {
    let first!: (image: RasterImageSnapshotV1) => void
    let second!: (image: RasterImageSnapshotV1) => void
    const load = vi.fn().mockImplementationOnce(() =>
      new Promise(resolve => {
        first = resolve
      })
    ).mockImplementationOnce(() =>
      new Promise(resolve => {
        second = resolve
      })
    )
    const store = new ChannelAccountIdentityStore(load)
    store.receive(account, { name: 'First', avatarUrl: 'first' })
    store.receive(account, { name: 'Current', avatarUrl: 'second' })
    first(image)
    await flush()
    expect(store.snapshot(account)).toEqual({ accountName: 'Current' })
    second(image)
    await flush()
    expect(store.snapshot(account)?.accountAvatar).toEqual(image)
    store.receive(account, { name: 'Current', avatarUrl: 'second' })
    expect(load).toHaveBeenCalledTimes(2)
    await store.dispose()
    expect(store.snapshot(account)).toBeUndefined()
    const unavailable = new ChannelAccountIdentityStore(async () => {
      throw new Error('temporary')
    })
    unavailable.receive(account, { name: 'Usable bot', avatarUrl: 'failed' })
    await flush()
    expect(unavailable.snapshot(account)).toEqual({ accountName: 'Usable bot' })
    await unavailable.dispose()
  })

  it('projects artwork through public identity snapshots and keeps frozen snapshots unchanged', async () => {
    const store = new ChannelAccountIdentityStore(async () => image)
    store.receive(account, { name: 'Support bot', avatarUrl: 'fixture' })
    await flush()
    const projection = projectLocalChannelManager({
      configuration: {
        contract: 'cordisx.channel-service-config/v1',
        schemaVersion: 1,
        connections: [{
          ref: account,
          adapterKind: 'feishu',
          enabled: false,
          transport: { mode: 'websocket' },
          secretRef: 'host-secret:env/FIXTURE',
        }],
      },
      revision: 1,
      lastGoodRevision: 1,
      writable: false,
      identity: ref => store.snapshot(ref),
    })
    const service = new CordisXChannelManagerService(new Context(), projection)
    expect(service.snapshot().accounts[0]).not.toHaveProperty('accountAvatar')
    expect(service.snapshotWithIdentity().accounts[0]).toMatchObject({
      accountName: 'Support bot',
      accountAvatar: image,
    })
    expect(JSON.stringify(service.snapshotWithIdentity())).not.toContain('cli_fixture')
    expect(JSON.stringify(service.snapshotWithIdentity())).not.toContain('host-secret')
    const apiSnapshot = vi.fn(() => undefined)
    const handler = createChannelActionsBridgeHandler({
      token: 'a'.repeat(64),
      api: { snapshot: apiSnapshot } as never,
    })
    await expect(handler.handle({ version: 1, token: 'wrong', action: 'snapshot' })).rejects.toThrow('unauthorized')
    expect(apiSnapshot).not.toHaveBeenCalled()
    await expect(handler.handle({ version: 1, token: handler.token, action: 'snapshot' })).resolves.toEqual({
      status: 'unavailable',
    })
    await store.dispose()
  })

  it('passes authenticated adapter identity to only its configured account without a second profile request', async () => {
    const store = new ChannelAccountIdentityStore(async () => image)
    const connect = vi.fn(async () => undefined)
    const disconnect = vi.fn(async () => undefined)
    const create = vi.fn(options => {
      options.onProfile({ name: 'Authenticated bot', avatarUrl: 'fixture-artwork' })
      return { connect, disconnect, on: () => () => {}, send: async () => ({ messageId: 'unused' }) } as never
    })
    const definition = createFeishuAdapterDefinition({
      connection: {
        ref: account,
        adapterKind: 'feishu',
        enabled: true,
        transport: { mode: 'websocket' },
        secretRef: 'host-secret:env/FIXTURE',
      },
      configurationRevision: 1,
      source: 'fixture',
      identities: store,
      resolveSecret: async () => 'not-a-real-secret',
      createChannel: create,
    })
    const active = await definition.start({
      drainOutbound: async () => 0,
    } as unknown as ChannelAdapterHost)
    try {
      await flush()
      expect(connect).toHaveBeenCalledTimes(1)
      expect(create).toHaveBeenCalledTimes(1)
      expect(store.snapshot(account)).toMatchObject({ accountName: 'Authenticated bot', accountAvatar: image })
      expect(store.snapshot({ ...account, accountId: 'another-account' })).toBeUndefined()
    } finally {
      await active.stop('disposed')
      await store.dispose()
    }
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('refreshes only the latest live renderer read and rejects canceled, retired and malformed readbacks', async () => {
    const base = projectLocalChannelManager({
      configuration: {
        contract: 'cordisx.channel-service-config/v1',
        schemaVersion: 1,
        connections: [{
          ref: account,
          adapterKind: 'feishu',
          enabled: false,
          transport: { mode: 'websocket' },
          secretRef: 'host-secret:env/FIXTURE',
        }],
      },
      revision: 1,
      lastGoodRevision: 1,
      writable: false,
    })
    const readbacks: Array<(value: unknown) => void> = []
    const run = vi.fn(() => new Promise(resolve => readbacks.push(resolve)))
    let current = true
    const service = new CordisXChannelManagerService(new Context(), {
      projection: base,
      profileId: 'identity-fixture',
      hostGeneration: 'host-fixture',
      isCurrent: () => current,
      actions: { run },
    })
    const changed = vi.fn()
    const subscription = service.subscribe(changed)
    const result = (name: string) => ({
      status: 'applied',
      projection: {
        contract: 'cordisx.channel-manager-runtime/v1',
        schemaVersion: 1,
        observedAt: new Date().toISOString(),
        accounts: [{ ...base.accounts[0]!, accountName: name, accountAvatar: image }],
        bindings: [],
      },
    })
    const first = service.refreshIdentity(new AbortController().signal)
    const latest = service.refreshIdentity(new AbortController().signal)
    readbacks[1]!(result('Current bot'))
    await latest
    readbacks[0]!(result('Stale bot'))
    await first
    expect(service.snapshotWithIdentity().accounts[0]?.accountName).toBe('Current bot')
    expect(service.snapshot().accounts[0]).not.toHaveProperty('accountAvatar')
    expect(changed).toHaveBeenCalledTimes(1)
    const canceled = new AbortController()
    const pending = service.refreshIdentity(canceled.signal)
    canceled.abort()
    readbacks[2]!(result('Canceled bot'))
    await pending
    const malformed = service.refreshIdentity(new AbortController().signal)
    const invalid = result('Bad image')
    invalid.projection.accounts[0]!.accountAvatar = { ...image, width: 2 }
    readbacks[3]!(invalid)
    await expect(malformed).rejects.toThrow()
    expect(service.snapshotWithIdentity().accounts[0]?.accountName).toBe('Current bot')
    const retired = service.refreshIdentity(new AbortController().signal)
    current = false
    readbacks[4]!(result('Retired bot'))
    await retired
    expect(service.snapshotWithIdentity().accounts[0]?.accountName).toBe('Current bot')
    await service.refreshIdentity(new AbortController().signal)
    expect(run).toHaveBeenCalledTimes(5)
    expect(changed).toHaveBeenCalledTimes(1)
    subscription.dispose()
  })
})
