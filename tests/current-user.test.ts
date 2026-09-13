import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalAvatar, inlineAvatar } from '../packages/cli/src/renderer/current-user/bitmap.js'
import { avatarRequest, readNativeCurrentUser } from '../packages/cli/src/renderer/current-user/native.js'
import { createCurrentUserService } from '../packages/cli/src/renderer/current-user/service.js'
const services: { dispose(): void }[] = []
afterEach(() => {
  for (const service of services.splice(0)) service.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
function environment() {
  const dom = new JSDOM('', { url: 'https://test.example' })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('localStorage', dom.window.localStorage)
  services.push({ dispose: () => dom.window.close() })
  return dom
}
const sourceProfile = {
  status: 'available' as const,
  identity: 'private-native-account',
  displayName: 'Player',
  avatar: 'data:image/png;base64,AA==',
}
function service(source = vi.fn(async () => sourceProfile), owner = 'plugin-one') {
  const api = createCurrentUserService(() => true, owner, source)
  services.unshift(api)
  return api
}
describe('current Host user public projection', () => {
  it('explicitly projects clones, stable opaque subjects, and isolates account/plugin identity', async () => {
    environment()
    const source = vi.fn(async () => ({
      ...sourceProfile,
      accountId: 'private',
      email: 'private',
      accessToken: 'private',
      refreshToken: 'private',
      usage: {},
      planType: 'private',
    }))
    const one = service(source)
    const [first, concurrent] = await Promise.all([one.read(), one.read()])
    expect(source).toHaveBeenCalledTimes(1)
    expect(first).toEqual(concurrent)
    expect(first).not.toBe(concurrent)
    if (first.status !== 'available') throw Error('profile unavailable')
    expect(first.profile).toEqual({
      subject: expect.stringMatching(/^host:[a-f0-9]{64}$/),
      displayName: 'Player',
      avatar: sourceProfile.avatar,
    })
    const repeated = await one.read()
    expect(repeated).toEqual(first)
    const two = await service(source, 'plugin-two').read()
    expect(two.status === 'available' && two.profile.subject).not.toBe(first.profile.subject)
    source.mockResolvedValue({
      ...sourceProfile,
      identity: 'other-account',
      accountId: 'private',
      email: 'private',
      accessToken: 'private',
      refreshToken: 'private',
      usage: {},
      planType: 'private',
    })
    const switched = await one.read()
    expect(switched.status === 'available' && switched.profile.subject).not.toBe(first.profile.subject)
    const restored = await service(vi.fn(async () => sourceProfile)).read()
    expect(restored).toEqual(first)
    expect(JSON.stringify(first)).not.toContain('private')
  })
  it('bounds names and removes invalid avatar references without replacing a guest profile', async () => {
    environment()
    const api = service(
      vi.fn(async () => ({
        ...sourceProfile,
        displayName: `  ${'😀'.repeat(129)}  `,
        avatar: 'https://example.com/private.png',
      })),
    )
    const result = await api.read()
    expect(result).toMatchObject({ status: 'available', profile: { displayName: '😀'.repeat(128) } })
    expect(result.status === 'available' && result.profile.avatar).toBeUndefined()
    const guest = createCurrentUserService(
      () => true,
      'plugin',
      async () => ({ status: 'unavailable', reason: 'signed-out' }),
    )
    services.unshift(guest)
    expect(await guest.read()).toEqual({ status: 'unavailable', reason: 'signed-out' })
    vi.spyOn(Object.getPrototypeOf(localStorage), 'getItem').mockImplementation(() => {
      throw Error('disabled')
    })
    expect(await api.read()).toEqual({ status: 'unavailable', reason: 'host-unavailable' })
  })
  it('subscribes to changes, isolates listener failures, and clears stale data on sign-out', async () => {
    environment()
    vi.useFakeTimers()
    let value: unknown = sourceProfile
    const source = vi.fn(async () => value as typeof sourceProfile)
    const api = service(source)
    const callback = vi.fn()
    api.subscribe(() => {
      throw Error('listener failed')
    })
    const release = api.subscribe(callback)
    await vi.advanceTimersByTimeAsync(0)
    await api.read()
    await Promise.resolve()
    expect(callback).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    await api.read()
    await Promise.resolve()
    expect(callback).toHaveBeenCalledTimes(1)
    value = { ...sourceProfile, avatar: 'data:image/jpeg;base64,AA==', displayName: 'Updated' }
    await vi.advanceTimersByTimeAsync(5000)
    await api.read()
    await Promise.resolve()
    expect(callback).toHaveBeenLastCalledWith({
      status: 'available',
      profile: {
        subject: expect.any(String),
        displayName: 'Updated',
        avatar: 'data:image/jpeg;base64,AA==',
      },
    })
    value = { status: 'unavailable', reason: 'signed-out' }
    await vi.advanceTimersByTimeAsync(5000)
    await api.read()
    await Promise.resolve()
    expect(callback).toHaveBeenLastCalledWith({ status: 'unavailable', reason: 'signed-out' })
    release()
    release()
    api.dispose()
    const calls = callback.mock.calls.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(callback).toHaveBeenCalledTimes(calls)
    expect(await api.read()).toEqual({ status: 'unavailable', reason: 'generation-retired' })
  })
  it('fences late reads and enforces abort deadlines even when a provider ignores its signal', async () => {
    environment()
    vi.useFakeTimers()
    let active = true
    let resolve: (value: typeof sourceProfile) => void = () => {}
    const source = vi.fn(() =>
      new Promise<typeof sourceProfile>(r => {
        resolve = r
      })
    )
    const api = createCurrentUserService(() => active, 'plugin', source)
    services.unshift(api)
    const callback = vi.fn()
    api.subscribe(callback)
    const read = api.read()
    active = false
    resolve(sourceProfile)
    expect(await read).toEqual({ status: 'unavailable', reason: 'generation-retired' })
    await vi.advanceTimersByTimeAsync(0)
    await api.read()
    await Promise.resolve()
    expect(callback).not.toHaveBeenCalled()
    api.dispose()
    const hung = service(source)
    const pending = hung.read()
    await vi.advanceTimersByTimeAsync(10001)
    expect(await pending).toEqual({ status: 'unavailable', reason: 'host-unavailable' })
  })
})
describe('native profile adaptation and bitmap normalization', () => {
  function native() {
    vi.stubGlobal('location', { href: 'app://-/index.html' })
    vi.stubGlobal('codexWindowType', 'electron')
    vi.stubGlobal('electronBridge', {
      getSentryInitOptions: () => ({ appVersion: '26.903.61454', buildNumber: '8378', buildFlavor: 'prod' }),
    })
    const post = vi.fn(async () => ({
      body: { accountId: 'private-account', userId: 'private-user', email: 'private' },
    }))
    const client = { post, fetch: vi.fn() }
    const load = vi.fn(async () => ({
      gJt: { getInstance: () => client },
      eSt: vi.fn(async () => ({ name: 'Fallback', email: 'private', accessToken: 'private' })),
      jKt: { safeGet: vi.fn(async () => ({ profile: { display_name: 'Profile' }, stats: { private: true } })) },
      NKt: vi.fn(() => ({ nativeControl: '1' })),
    }))
    return { post, client, load }
  }
  it('reads the audited native display source without credential or login operations', async () => {
    const f = native()
    expect(await readNativeCurrentUser(new AbortController().signal, f.load)).toEqual({
      status: 'available',
      identity: JSON.stringify(['private-account', 'private-user']),
      displayName: 'Profile',
    })
    expect(f.post).toHaveBeenCalledTimes(2)
    expect(f.post.mock.calls[0]?.[0]).toBe('vscode://codex/account-info')
    expect(f.client.fetch).not.toHaveBeenCalled()
    vi.stubGlobal('electronBridge', { getSentryInitOptions: () => ({ appVersion: 'future', buildNumber: '9000' }) })
    expect(await readNativeCurrentUser(new AbortController().signal, f.load)).toEqual({
      status: 'unavailable',
      reason: 'host-unavailable',
    })
    expect(f.load).toHaveBeenCalledTimes(1)
  })
  it('selects audited 8881 exports without /me and rejects mismatched old symbols or build identity', async () => {
    const f = native()
    vi.stubGlobal('electronBridge', {
      getSentryInitOptions: () => ({ appVersion: '26.908.40834', buildNumber: '8881', buildFlavor: 'prod' }),
    })
    const profile = vi.fn(async () => ({ profile: { display_name: 'GH L' }, stats: { private: true } }))
    const readAccountInfo = vi.fn(async () => ({
      status: 'ready',
      data: { accountId: 'private-account', userId: 'private-user' },
    }))
    const load = vi.fn(async () => ({
      TW: { accessInputs: { readAccountInfo } },
      mJt: { getInstance: () => f.client },
      Uqt: { safeGet: profile },
      Gqt: () => ({ nativeControl: '1' }),
    }))
    expect(await readNativeCurrentUser(new AbortController().signal, load)).toEqual({
      status: 'available',
      identity: JSON.stringify(['private-account', 'private-user']),
      displayName: 'GH L',
    })
    expect(load).toHaveBeenCalledWith('app://-/assets/app-initial-9b95fa538c62.js')
    expect(readAccountInfo).toHaveBeenCalledTimes(2)
    expect(f.post).not.toHaveBeenCalled()
    expect(profile).toHaveBeenCalledWith(
      '/wham/profiles/me',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(await readNativeCurrentUser(new AbortController().signal, f.load)).toEqual({
      status: 'unavailable',
      reason: 'host-unavailable',
    })
    for (
      const pin of [
        { appVersion: '26.908.40834', buildNumber: '8378', buildFlavor: 'prod' },
        { appVersion: '26.903.61454', buildNumber: '8881', buildFlavor: 'prod' },
        { appVersion: '26.908.40834', buildNumber: '8881', buildFlavor: 'dev' },
      ]
    ) {
      vi.stubGlobal('electronBridge', { getSentryInitOptions: () => pin })
      expect(await readNativeCurrentUser(new AbortController().signal, load)).toEqual({
        status: 'unavailable',
        reason: 'host-unavailable',
      })
    }
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('rejects native identity changes during a profile read and supports signed-out', async () => {
    const f = native()
    f.post.mockResolvedValueOnce({ body: { accountId: 'one', userId: 'user', email: 'private' } })
    f.post.mockResolvedValueOnce({ body: { accountId: 'two', userId: 'user', email: 'private' } })
    expect(await readNativeCurrentUser(new AbortController().signal, f.load)).toEqual({
      status: 'unavailable',
      reason: 'host-unavailable',
    })
    f.post.mockResolvedValue({ body: { accountId: '', userId: '', email: 'private' } })
    expect(await readNativeCurrentUser(new AbortController().signal, f.load)).toEqual({
      status: 'unavailable',
      reason: 'signed-out',
    })
  })
  it('allows only approved avatar routes and native auth flags only for estuary', () => {
    expect(avatarRequest('https://chatgpt.com/backend-api/estuary/content/a?x=1')).toEqual({
      url: 'https://chatgpt.com/backend-api/estuary/content/a?x=1',
      authenticated: true,
    })
    expect(avatarRequest('https://lh3.googleusercontent.com/a')).toEqual({
      url: 'https://lh3.googleusercontent.com/a',
      authenticated: false,
    })
    for (
      const url of [
        'http://chatgpt.com/a',
        'https://chatgpt.com.evil.test/backend-api/estuary/content',
        'https://chatgpt.com/backend-api/account',
        'https://user:secret@chatgpt.com/backend-api/estuary/content',
        'file:///private/a.png',
        'data:image/svg+xml;base64,AA==',
        'https://127.0.0.1/a',
        'https://evil.test/a',
      ]
    ) {
      expect(avatarRequest(url)).toBeUndefined()
    }
    expect(inlineAvatar('data:image/png;base64,AA==\n')).toBeUndefined()
  })
  it('bounds image bytes, rejects SVG, canonicalizes rasters, and closes decoded images', async () => {
    const signal = new AbortController().signal
    expect(await canonicalAvatar(new Response('svg', { headers: { 'content-type': 'image/svg+xml' } }), signal))
      .toBeUndefined()
    expect(
      await canonicalAvatar(
        new Response('image', { headers: { 'content-type': 'image/png', 'content-length': '1048577' } }),
        signal,
      ),
    ).toBeUndefined()
    const close = vi.fn(), draw = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close })))
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return { drawImage: draw }
        }
        async convertToBlob() {
          return new Blob([new Uint8Array([0, 1, 2])], { type: 'image/png' })
        }
      },
    )
    const avatar = await canonicalAvatar(new Response('image', { headers: { 'content-type': 'image/jpeg' } }), signal)
    expect(avatar).toBe('data:image/png;base64,AAEC')
    expect(draw).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    const aborted = new AbortController()
    aborted.abort()
    await expect(canonicalAvatar(new Response('image', { headers: { 'content-type': 'image/png' } }), aborted.signal))
      .rejects.toThrow()
  })
})
