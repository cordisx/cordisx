import { expect, it } from 'vitest'
import { managerPublicConsoleBootstrap } from '../packages/cli/src/cli/manager-public-console-bootstrap.js'

it('keeps service frame restrictions on the private console exchange', () => {
  const input = {
    managerOrigin: 'https://manager.example.test',
    publicOrigin: 'https://view.console.example.test',
    location: '/providers',
    password: 'fixture-password',
    serviceHeaders: {
      'content-security-policy': "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
    },
  }
  const result = managerPublicConsoleBootstrap(input)
  const headers = Array.from(
    { length: result.headers.length / 2 },
    (_, index) => result.headers.slice(index * 2, index * 2 + 2),
  )
  expect(headers).toContainEqual(['content-security-policy', "frame-ancestors 'none'"])
  expect(headers).toContainEqual(['x-frame-options', 'DENY'])
  expect(result.body).not.toContain('ticket=')
  expect(() => managerPublicConsoleBootstrap({ ...input, location: '//other.example.test/path' })).toThrow()
})

it.each([
  {
    policy: [
      "default-src 'none'; frame-ancestors 'none'; script-src 'self'",
      "script-src 'none'; FRAME-ANCESTORS https://other.example.test; frame-ancestors *",
    ],
  },
  {
    policy:
      "default-src 'none'; frame-ancestors 'none'; script-src 'self', script-src 'none'; FRAME-ANCESTORS https://other.example.test; frame-ancestors *",
  },
])('preserves each embedding restriction without applying service script policy to Host content', ({ policy }) => {
  const result = managerPublicConsoleBootstrap({
    managerOrigin: 'https://manager.example.test',
    publicOrigin: 'https://view.console.example.test',
    location: '/providers',
    password: 'fixture-password',
    serviceHeaders: {
      'content-security-policy': policy,
    },
  })
  const policies = result.headers.flatMap((name, index) =>
    name === 'content-security-policy' ? [result.headers[index + 1]] : []
  )
  expect(policies.slice(1)).toEqual(["frame-ancestors 'none'", 'FRAME-ANCESTORS https://other.example.test'])
})
