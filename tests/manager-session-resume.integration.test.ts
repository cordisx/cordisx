import { expect, it, vi } from 'vitest'
import { ManagerRendererCommandPeer } from '../packages/cli/src/cli/manager-renderer-peer.js'
import { dispatchManagerRendererOperation } from '../packages/cli/src/cli/manager-renderer-rpc.js'
import { ManagerRendererSessions } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { startManagerWeb } from '../packages/cli/src/cli/manager-web.js'

const secret = (value: string) => value.repeat(64)
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

it('rotates tab-scoped recovery only after the owner confirms renderer retirement', async () => {
  const retired = deferred<{ status: string }>()
  const revoke = vi.fn(async () => await retired.promise)
  const owner = {
    appId: 'codex',
    profileId: 'work',
    generation: 'owner-1',
    isCurrent: async () => true,
    request: async (operation: { action?: string }) => {
      if (operation.action === 'open') {
        return {
          status: 'ok',
          channels: ['plugin-management'],
          commands: true,
          handle: { rendererId: secret('a'), grant: secret('b'), ownerGeneration: 'owner-1' },
        }
      }
      if (operation.action === 'revoke') return await revoke()
      return { status: 'unavailable' }
    },
  }
  const web = await startManagerWeb(owner as never, {
    rendererGateway: { pid: 42, processStartedAt: 'fixture', instanceToken: secret('c') },
  })
  const origin = new URL(web.url).origin
  const post = async (path: string, body: unknown, token?: string, cookie?: string, from = origin) =>
    await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        origin: from,
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    })
  try {
    const opened = await post('/api/session', { token: new URL(web.url).hash.slice(1), resume: true })
    const initial = await opened.json() as { token: string; resumeId: string }
    const cookie = opened.headers.get('set-cookie')!
    expect(cookie).toContain(`Path=/api/session/resume/${initial.resumeId}`)
    expect(cookie).toContain('HttpOnly; SameSite=Strict')
    expect(cookie).not.toContain(initial.token)
    expect((await post('/api/renderer/open', {}, initial.token)).status).toBe(200)
    const resumePath = `/api/session/resume/${initial.resumeId}`
    const cookiePair = cookie.split(';')[0]!
    expect((await post(resumePath, {}, undefined, cookiePair, 'https://example.com')).status).toBe(403)
    expect((await post(resumePath, {}, undefined, 'cordisx_manager_resume=wrong')).status).toBe(401)
    const closing = post('/api/renderer/close', { preserveResume: true }, initial.token)
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledOnce())
    let settled = false
    const resuming = post(resumePath, {}, undefined, cookiePair).then(value => {
      settled = true
      return value
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(settled).toBe(false)
    retired.resolve({ status: 'ok' })
    expect((await closing).status).toBe(200)
    const resumed = await resuming
    expect(resumed.status).toBe(200)
    const next = await resumed.json() as { token: string; resumeId: string }
    expect(next.token).not.toBe(initial.token)
    expect(next.resumeId).not.toBe(initial.resumeId)
    expect((await post(resumePath, {}, undefined, cookiePair)).status).toBe(401)
    expect((await post('/api/renderer/open', {}, initial.token)).status).toBe(401)
    const nextCookie = resumed.headers.getSetCookie().find(value => value.includes(`/resume/${next.resumeId}`))!
    expect((await post('/api/renderer/close', {}, next.token)).status).toBe(200)
    expect((await post(`/api/session/resume/${next.resumeId}`, {}, undefined, nextCookie.split(';')[0])).status).toBe(
      401,
    )
  } finally {
    retired.resolve({ status: 'ok' })
    await web.close()
  }
})

it('retires the previous renderer when a refresh loses its unload request', async () => {
  const retired = deferred<{ status: string }>()
  const revoke = vi.fn(async () => await retired.promise)
  const web = await startManagerWeb({
    appId: 'codex',
    profileId: 'work',
    generation: 'owner-1',
    isCurrent: async () => true,
    request: async (operation: { action?: string }) => {
      if (operation.action === 'open') {
        return {
          status: 'ok',
          channels: ['plugin-management'],
          commands: true,
          handle: { rendererId: secret('a'), grant: secret('b'), ownerGeneration: 'owner-1' },
        }
      }
      if (operation.action === 'revoke') return await revoke()
      return { status: 'unavailable' }
    },
  } as never, { rendererGateway: { pid: 42, processStartedAt: 'fixture', instanceToken: secret('c') } })
  const origin = new URL(web.url).origin
  const post = async (path: string, body: unknown, token?: string, cookie?: string) =>
    await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    })
  try {
    const opened = await post('/api/session', { token: new URL(web.url).hash.slice(1), resume: true })
    const initial = await opened.json() as { token: string; resumeId: string }
    const cookie = opened.headers.get('set-cookie')!.split(';')[0]!
    const resumePath = `/api/session/resume/${initial.resumeId}`
    expect((await post('/api/renderer/open', {}, initial.token)).status).toBe(200)
    expect((await post(resumePath, {}, undefined, 'cordisx_manager_resume=wrong')).status).toBe(401)
    expect(revoke).not.toHaveBeenCalled()
    const resuming = post(resumePath, {}, undefined, cookie)
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledOnce())
    expect((await post(resumePath, {}, undefined, cookie)).status).toBe(401)
    retired.resolve({ status: 'ok' })
    const resumed = await resuming
    expect(resumed.status).toBe(200)
    const next = await resumed.json() as { token: string; resumeId: string }
    expect(next.token).not.toBe(initial.token)
    expect(next.resumeId).not.toBe(initial.resumeId)
    expect((await post('/api/renderer/open', {}, initial.token)).status).toBe(401)
    expect((await post(resumePath, {}, undefined, cookie)).status).toBe(401)

    revoke.mockResolvedValueOnce({ status: 'unavailable' })
    const secondOpen = await post('/api/session', { token: new URL(web.issueUrl()).hash.slice(1), resume: true })
    const second = await secondOpen.json() as { token: string; resumeId: string }
    const secondCookie = secondOpen.headers.get('set-cookie')!.split(';')[0]!
    expect((await post('/api/renderer/open', {}, second.token)).status).toBe(200)
    expect((await post(`/api/session/resume/${second.resumeId}`, {}, undefined, secondCookie)).status).toBe(401)
    expect((await post('/api/renderer/open', {}, second.token)).status).toBe(401)
  } finally {
    retired.resolve({ status: 'ok' })
    await web.close()
  }
})

it('does not resume an owner session while a dispatched write has an unknown result', async () => {
  const gateway = { pid: 42, processStartedAt: 'fixture', instanceToken: secret('c') }
  const entered = deferred<void>()
  const finish = deferred<void>()
  let peer: ManagerRendererCommandPeer | undefined
  const authority = new ManagerRendererSessions({
    profileId: 'work',
    ownerGeneration: 'owner-1',
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    channels: new Map([
      ['plugin-management', {
        prepare: () => {
          throw new Error('unused')
        },
      }],
      ['channel-credentials', {
        prepare: () => ({
          mode: 'write',
          dispatch: async () => {
            entered.resolve()
            await finish.promise
            return { status: 'applied' }
          },
        }),
      }],
    ]),
    participant: {
      create({ browserSessionId, handle }) {
        peer = new ManagerRendererCommandPeer({
          scope: { homeDigest: secret('d'), ownerAppId: 'codex', profileId: 'work', generation: 'owner-1' },
          identity: {
            appId: 'codex',
            adapterId: 'manager',
            rendererId: handle.rendererId,
            pid: gateway.pid,
            processStartedAt: gateway.processStartedAt,
          },
          sessionId: browserSessionId,
        })
        return peer
      },
      attach: async () => {},
    },
  })
  const web = await startManagerWeb({
    appId: 'codex',
    profileId: 'work',
    generation: 'owner-1',
    isCurrent: async () => true,
    request: async operation => await dispatchManagerRendererOperation(authority, operation),
  }, { rendererGateway: gateway })
  const origin = new URL(web.url).origin
  const post = async (path: string, body: unknown, token?: string, cookie?: string) =>
    await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    })
  try {
    const opened = await post('/api/session', { token: new URL(web.url).hash.slice(1), resume: true })
    const initial = await opened.json() as { token: string; resumeId: string }
    const cookie = opened.headers.get('set-cookie')!.split(';')[0]!
    expect((await post('/api/renderer/open', {}, initial.token)).status).toBe(200)
    expect((await post('/api/renderer/admit', {}, initial.token)).status).toBe(200)
    const write = post('/api/renderer/binding', {
      channel: 'channel-credentials',
      payload: JSON.stringify({ operation: 'commit' }),
    }, initial.token)
    await entered.promise
    const resuming = post(`/api/session/resume/${initial.resumeId}`, {}, undefined, cookie)
    await vi.waitFor(() => expect(peer?.closed).toBe(true))
    finish.resolve()
    expect((await write).status).toBe(503)
    expect((await resuming).status).toBe(401)
    expect(authority.mutationAvailability()).toBe('unavailable')
  } finally {
    finish.resolve()
    authority.dispose()
    await web.close()
  }
})

it('does not issue a replacement if renderer retirement is uncertain', async () => {
  const owner = {
    appId: 'codex',
    profileId: 'work',
    generation: 'owner-1',
    isCurrent: async () => true,
    request: async (operation: { action?: string }) =>
      operation.action === 'open'
        ? {
          status: 'ok',
          channels: ['plugin-management'],
          commands: true,
          handle: { rendererId: secret('a'), grant: secret('b'), ownerGeneration: 'owner-1' },
        }
        : { status: 'unavailable' },
  }
  const web = await startManagerWeb(owner as never, {
    rendererGateway: { pid: 42, processStartedAt: 'fixture', instanceToken: secret('c') },
  })
  const origin = new URL(web.url).origin
  const post = async (path: string, body: unknown, token?: string, cookie?: string) =>
    await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    })
  try {
    const opened = await post('/api/session', { token: new URL(web.url).hash.slice(1), resume: true })
    const initial = await opened.json() as { token: string; resumeId: string }
    const cookie = opened.headers.get('set-cookie')!.split(';')[0]!
    expect((await post('/api/renderer/open', {}, initial.token)).status).toBe(200)
    expect((await post('/api/renderer/close', { preserveResume: true }, initial.token)).status).toBe(503)
    expect((await post(`/api/session/resume/${initial.resumeId}`, {}, undefined, cookie)).status).toBe(401)
  } finally {
    await web.close()
  }
})

it('resumes after read-only checks find no Channel or managed-service owner', async () => {
  const request = vi.fn(async (operation: { kind?: string; action?: string }) => {
    if (operation.kind === 'manager-renderer' && operation.action === 'open') {
      return {
        status: 'ok',
        channels: ['plugin-management'],
        commands: true,
        handle: { rendererId: secret('a'), grant: secret('b'), ownerGeneration: 'owner-1' },
      }
    }
    if (operation.kind === 'manager-renderer' && operation.action === 'revoke') return { status: 'ok' }
    return operation.kind === 'manager-channel-credentials'
      ? { status: 'unavailable', code: 'CHANNEL_OWNER_UNAVAILABLE' }
      : { status: 'unavailable', code: 'OWNER_UNAVAILABLE' }
  })
  const web = await startManagerWeb({
    appId: 'codex',
    profileId: 'work',
    generation: 'owner-1',
    isCurrent: async () => true,
    request,
  } as never, { rendererGateway: { pid: 42, processStartedAt: 'fixture', instanceToken: secret('c') } })
  const origin = new URL(web.url).origin
  const post = async (path: string, body: unknown, token?: string, cookie?: string) =>
    await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    })
  try {
    const opened = await post('/api/session', { token: new URL(web.url).hash.slice(1), resume: true })
    const initial = await opened.json() as { token: string; resumeId: string }
    const cookie = opened.headers.get('set-cookie')!.split(';')[0]!
    expect((await post('/api/renderer/open', {}, initial.token)).status).toBe(200)
    expect(await (await post('/api/channel-credentials', { action: 'view' }, initial.token)).json())
      .toEqual({ status: 'unavailable', code: 'CHANNEL_OWNER_UNAVAILABLE' })
    expect(await (await post('/api/managed-services', { action: 'list' }, initial.token)).json())
      .toEqual({ status: 'unavailable', code: 'OWNER_UNAVAILABLE' })
    expect((await post('/api/renderer/close', { preserveResume: true }, initial.token)).status).toBe(200)
    expect(
      request.mock.calls.some(([operation]) =>
        operation.kind === 'manager-channel-credentials' && operation.action === 'retire'
      ),
    ).toBe(true)
    expect(
      request.mock.calls.some(([operation]) =>
        operation.kind === 'manager-service-auth' && operation.action === 'retire'
      ),
    ).toBe(true)
    expect((await post(`/api/session/resume/${initial.resumeId}`, {}, undefined, cookie)).status).toBe(200)
  } finally {
    await web.close()
  }
})

it.each(['channel', 'managed-service'] as const)(
  'does not resume after an unconfirmed %s write or lease',
  async kind => {
    const request = async (operation: { kind?: string; action?: string }) => {
      if (operation.kind === 'manager-renderer' && operation.action === 'open') {
        return {
          status: 'ok',
          channels: ['plugin-management'],
          commands: true,
          handle: { rendererId: secret('a'), grant: secret('b'), ownerGeneration: 'owner-1' },
        }
      }
      if (operation.kind === 'manager-renderer' && operation.action === 'revoke') return { status: 'ok' }
      return operation.kind === 'manager-channel-credentials'
        ? { status: 'unavailable', code: 'CHANNEL_OWNER_UNAVAILABLE' }
        : { status: 'unavailable', code: 'OWNER_UNAVAILABLE' }
    }
    const web = await startManagerWeb({
      appId: 'codex',
      profileId: 'work',
      generation: 'owner-1',
      isCurrent: async () => true,
      request,
    } as never, { rendererGateway: { pid: 42, processStartedAt: 'fixture', instanceToken: secret('c') } })
    const origin = new URL(web.url).origin
    const post = async (path: string, body: unknown, token?: string, cookie?: string) =>
      await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      })
    try {
      const opened = await post('/api/session', { token: new URL(web.url).hash.slice(1), resume: true })
      const initial = await opened.json() as { token: string; resumeId: string }
      const cookie = opened.headers.get('set-cookie')!.split(';')[0]!
      expect((await post('/api/renderer/open', {}, initial.token)).status).toBe(200)
      const action = kind === 'channel'
        ? {
          action: 'capture',
          purpose: 'create',
          expectedRevision: 0,
          serviceGeneration: 'service-1',
          account: { adapterId: 'feishu', accountId: 'fixture', tenantId: '' },
          secret: 'synthetic-secret',
        }
        : {
          action: 'prepare-login',
          pluginId: 'fixture',
          serviceId: 'gateway',
          pluginGeneration: 'plugin-1',
          bindingId: 'binding-1',
        }
      const route = kind === 'channel' ? '/api/channel-credentials' : '/api/managed-services'
      expect((await post(route, action, initial.token)).status).toBe(200)
      expect((await post('/api/renderer/close', { preserveResume: true }, initial.token)).status).toBe(503)
      expect((await post(`/api/session/resume/${initial.resumeId}`, {}, undefined, cookie)).status).toBe(401)
    } finally {
      await web.close()
    }
  },
)
