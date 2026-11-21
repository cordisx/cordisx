import { afterEach, expect, it, vi } from 'vitest'
import { ManagerSessionResumeGrants } from '../packages/cli/src/cli/manager-session-resume.js'

const cookie = (value: string) => value.split(';')[0]!
const deferred = () => {
  let resolve!: (value: boolean) => void
  const promise = new Promise<boolean>(done => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(() => vi.useRealTimers())

it('requires a separate cookie, confirmed retirement, and a single-use tab handle', async () => {
  const grants = new ManagerSessionResumeGrants()
  const token = 'a'.repeat(64)
  const issued = grants.issue(token)
  const secret = cookie(issued.cookie)
  expect(issued.cookie).toContain(`Path=/api/session/resume/${issued.id}`)
  expect(issued.cookie).toContain('HttpOnly; SameSite=Strict')
  expect(issued.cookie).not.toContain(token)
  expect(await grants.claim(issued.id, undefined)).toBe('denied')
  expect(await grants.claim(issued.id, `${secret}; ${secret}`)).toBe('denied')
  expect(await grants.claim('b'.repeat(64), secret)).toBe('denied')
  expect(await grants.claim(issued.id, secret)).toBe('pending')
  const retired = deferred()
  grants.park(token, retired.promise)
  const pending = grants.claim(issued.id, secret)
  expect(await grants.claim(issued.id, secret)).toBe('denied')
  retired.resolve(true)
  expect(await pending).toBe('accepted')
  expect(await grants.claim(issued.id, secret)).toBe('denied')
  expect(grants.deleteCookie(issued.id)).toContain('Max-Age=0')
})

it('rejects uncertain retirement, explicit revocation, and expired resume windows', async () => {
  vi.useFakeTimers()
  const grants = new ManagerSessionResumeGrants()
  const uncertain = grants.issue('a'.repeat(64))
  grants.park('a'.repeat(64), Promise.resolve(false))
  expect(await grants.claim(uncertain.id, cookie(uncertain.cookie))).toBe('denied')
  const revoked = grants.issue('b'.repeat(64))
  grants.revoke('b'.repeat(64))
  expect(await grants.claim(revoked.id, cookie(revoked.cookie))).toBe('denied')
  const expired = grants.issue('c'.repeat(64))
  grants.park('c'.repeat(64), Promise.resolve(true))
  await vi.advanceTimersByTimeAsync(30_001)
  expect(await grants.claim(expired.id, cookie(expired.cookie))).toBe('denied')
})
