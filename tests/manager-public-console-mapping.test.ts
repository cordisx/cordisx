import { expect, it } from 'vitest'
import {
  createManagerPublicConsoleMapping,
  managerPublicConsoleTemplate,
} from '../packages/cli/src/cli/manager-public-console.js'

const local = 'http://console-' + 'a'.repeat(32) + '.cordisx-console.localhost:49000'
const template = 'https://{view}.console.example.test'

it('gives each view a fresh origin and retires its credentials with the view', () => {
  const mapping = createManagerPublicConsoleMapping('https://manager.example.test', [local], [template])
  const controller = new AbortController()
  const first = mapping.issue(local, 'first-view', controller.signal)!
  const password = first.cookies.begin([
    '__Host-fixture=' + 'a'.repeat(32) + '; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=90',
  ])!
  const auth = 'Basic ' + Buffer.from('cx:' + password).toString('base64')
  expect(first.cookies.incoming(auth)).toBeDefined()
  mapping.retire('first-view')
  expect(first.signal.aborted).toBe(true)
  expect(first.cookies.incoming(auth)).toBeUndefined()
  expect(mapping.resolve(new URL(first.publicOrigin).host)).toBeUndefined()
  expect(mapping.issue(local, 'first-view', controller.signal)).toBeUndefined()
  const second = mapping.issue(local, 'second-view', controller.signal)!
  expect(second.publicOrigin).not.toBe(first.publicOrigin)
  expect(mapping.resolve(new URL(second.publicOrigin).host)).toBe(second)
  controller.abort()
  expect(second.signal.aborted).toBe(true)
  expect(mapping.resolve(new URL(second.publicOrigin).host)).toBeUndefined()
  mapping.close()
})

it.each([
  'https://console.example.test',
  'https://prefix-{view}.example.test',
  'https://{view}.example.test/path',
  'https://user:password@{view}.example.test',
])('rejects an unsafe or fixed console template %s', value => {
  expect(() => managerPublicConsoleTemplate(value)).toThrow()
})
