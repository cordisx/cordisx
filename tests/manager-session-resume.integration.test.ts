import { expect, it, vi } from 'vitest'
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
    expect((await post(resumePath, {}, undefined, cookiePair)).status).toBe(409)
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
