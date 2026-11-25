import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import { dispatchManagerRendererOperation } from '../packages/cli/src/cli/manager-renderer-rpc.js'
import { ManagerRendererSessions } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { startManagerWeb } from '../packages/cli/src/cli/manager-web.js'

const secret = () => randomBytes(32).toString('hex')

async function harness(input: { readonly loseFirstOpen?: boolean; readonly retirementSucceeds?: boolean } = {}) {
  const gateway = { pid: 42, processStartedAt: 'fixture', instanceToken: secret() }
  const authority = new ManagerRendererSessions({
    profileId: 'work',
    ownerGeneration: 'owner-1',
    ownerCurrent: () => true,
    authenticateGateway: async value => value.instanceToken === gateway.instanceToken,
    channels: new Map([['plugin-management', {
      prepare: () => {
        throw new Error('unused')
      },
    }]]),
    waitForRetirement: async () => input.retirementSucceeds !== false,
  })
  let loseOpen = input.loseFirstOpen === true
  const web = await startManagerWeb({
    appId: 'codex',
    profileId: 'work',
    generation: 'owner-1',
    isCurrent: async () => true,
    request: async operation => {
      const result = await dispatchManagerRendererOperation(authority, operation)
      if (loseOpen && operation.kind === 'manager-renderer' && operation.action === 'open') {
        loseOpen = false
        return { status: 'unavailable' }
      }
      return result
    },
  }, { rendererGateway: gateway })
  const origin = new URL(web.url).origin
  const post = async (route: string, value: unknown, token?: string, cookie?: string) =>
    await fetch(origin + route, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(value),
    })
  return { authority, web, post }
}

it('reopens the same tab after a temporary owner admission fence clears', async () => {
  const { authority, web, post } = await harness()
  const fence = await authority.suspendMutations()
  try {
    const opened = await post('/api/session', { token: new URL(web.url).hash.slice(1), resume: true })
    const first = await opened.json() as { token: string; resumeId: string }
    const cookie = opened.headers.get('set-cookie')!.split(';')[0]!
    const blocked = await post('/api/renderer/open', {}, first.token)
    expect(blocked.status).toBe(503)
    expect(await blocked.json()).toEqual({ error: 'RENDERER_UNAVAILABLE' })
    expect((await post('/api/renderer/close', { preserveResume: true }, first.token)).status).toBe(200)
    expect(fence.release()).toBe(true)
    const resumed = await post(`/api/session/resume/${first.resumeId}`, { attempt: secret() }, undefined, cookie)
    expect(resumed.status).toBe(200)
    const second = await resumed.json() as { token: string; resumeId: string }
    expect(second.token).not.toBe(first.token)
    expect((await post('/api/renderer/open', {}, first.token)).status).toBe(401)
    expect((await post('/api/renderer/open', {}, second.token)).status).toBe(200)
  } finally {
    fence.release()
    authority.dispose()
    await web.close()
  }
})

it('does not recover a failed open until the potentially created renderer is retired', async () => {
  const { authority, web, post } = await harness({ loseFirstOpen: true, retirementSucceeds: false })
  try {
    const opened = await post('/api/session', { token: new URL(web.url).hash.slice(1), resume: true })
    const first = await opened.json() as { token: string; resumeId: string }
    const cookie = opened.headers.get('set-cookie')!.split(';')[0]!
    expect((await post('/api/renderer/open', {}, first.token)).status).toBe(503)
    expect((await post('/api/renderer/close', { preserveResume: true }, first.token)).status).toBe(503)
    expect((await post(`/api/session/resume/${first.resumeId}`, { attempt: secret() }, undefined, cookie)).status)
      .toBe(401)
  } finally {
    authority.dispose()
    await web.close()
  }
})
