import { afterEach, expect, it, vi } from 'vitest'
import { issueOwnerDocumentPrincipalToken } from '../packages/cli/src/launcher/owner-document-rpc.js'
import { binding, managedSourceFixture, principal, secret } from './fixtures/managed-source-http.js'
import type { HttpConnectionV1 } from '@cordisx/protocol/plugin-http/v1'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanups.splice(0)) await close()
})
const account = JSON.stringify(['account-A', 'user-A'])
async function connected() {
  const f = managedSourceFixture(cleanups)
  const result = await f.invoke('plugin-http-connect-account', binding)
  if (result.status !== 'accepted') throw new Error('managed connection fixture')
  const connection = (result.value as { connection: HttpConnectionV1 }).connection
  return { ...f, connection }
}
function request(f: Awaited<ReturnType<typeof connected>>, read: () => Promise<string | null>) {
  return f.authority.handle({
    token: issueOwnerDocumentPrincipalToken(secret, principal),
    operation: 'plugin-http-request',
    connection: f.connection,
    operationId: 'fresh-account-checkpoints',
    method: 'GET',
    path: '/v1/me',
    deadline: Date.now() + 2000,
  }, read)
}
it('uses three fresh reads for a retained Native grant and accepts only after the final checkpoint', async () => {
  const f = await connected(), read = vi.fn(async () => account)
  expect(await request(f, read)).toMatchObject({ status: 'accepted', value: { body: '{"balance":0}' } })
  expect(read).toHaveBeenCalledTimes(3)
  expect(f.bearerReads()).toBe(1)
  expect(f.seen.filter(e => e.path === '/v1/me')).toHaveLength(1)
})
it.each([1, 2, 3])(
  'retires the owner when fresh Native read %i fails without accepting a late response',
  async phase => {
    const f = await connected()
    let reads = 0
    const read = vi.fn(async () => ++reads === phase ? null : account)
    expect(await request(f, read)).toMatchObject({ status: 'unavailable', code: 'credential-unavailable' })
    expect(read).toHaveBeenCalledTimes(phase)
    expect(f.seen.filter(e => e.path === '/v1/me')).toHaveLength(phase === 3 ? 1 : 0)
    expect(await request(f, vi.fn(async () => account))).toMatchObject({
      status: 'unavailable',
      code: 'connection-unavailable',
    })
    expect((await f.invoke('plugin-http-connect-account', binding)).status).toBe('accepted')
  },
)
it('a retirement during a held post-secret checkpoint sends no authenticated HTTP request and retires sibling grants', async () => {
  const f = await connected()
  const sibling = await f.invoke('plugin-http-connect-account', binding)
  if (sibling.status !== 'accepted') throw new Error('sibling fixture')
  const siblingConnection = (sibling.value as { connection: HttpConnectionV1 }).connection
  let finish!: (value: string | null) => void, calls = 0
  const read = () =>
    ++calls === 2
      ? new Promise<string | null>(r => {
        finish = r
      })
      : Promise.resolve(account)
  const pending = request(f, read)
  await vi.waitFor(() => expect(calls).toBe(2))
  finish(null)
  expect(await pending).toMatchObject({ code: 'credential-unavailable' })
  expect(f.seen.filter(e => e.path === '/v1/me')).toHaveLength(0)
  expect(await request({ ...f, connection: siblingConnection }, async () => account)).toMatchObject({
    code: 'connection-unavailable',
  })
})
