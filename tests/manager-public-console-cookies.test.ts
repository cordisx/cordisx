import { expect, it } from 'vitest'
import { ManagerPublicConsoleCookies } from '../packages/cli/src/cli/manager-public-console-cookies.js'

const attributes = '; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=90'
const local = '__Host-fixture=' + 'a'.repeat(32)

it('keeps service cookies private and binds them to a separate console credential', () => {
  const first = new ManagerPublicConsoleCookies()
  const second = new ManagerPublicConsoleCookies()
  const one = first.begin([local + attributes])!
  const two = second.begin([local + attributes])!
  const auth = (password: string) => 'Basic ' + Buffer.from('cx:' + password).toString('base64')
  expect(one).not.toBe(two)
  expect(first.incoming(auth(one))).toBe(local)
  expect(second.incoming(auth(two))).toBe(local)
  expect(first.incoming(auth(two))).toBeUndefined()
  first.update(auth(one), ['pending=fixture' + attributes])
  expect(first.incoming(auth(one))).toBe(local + '; pending=fixture')
  first.update(auth(one), ['__Host-fixture=; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=0'])
  expect(first.incoming(auth(one))).toBeUndefined()
})

it('rejects malformed or unsafe service cookies and unrelated credentials', () => {
  const cookies = new ManagerPublicConsoleCookies()
  expect(cookies.begin(['bad cookie=value' + attributes])).toBeUndefined()
  expect(cookies.begin([local + '; Path=/; HttpOnly; SameSite=None'])).toBeUndefined()
  expect(cookies.begin([local + attributes + '; Domain=example.test'])).toBeUndefined()
  expect(cookies.incoming('Basic unrelated')).toBeUndefined()
})
