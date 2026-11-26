import { expect, it } from 'vitest'
import { useBrotliManagerBundle } from '../packages/cli/src/cli/manager-bundle-encoding.js'

it.each([
  ['gzip, deflate, br', 'br-v1', true],
  ['gzip, BR;q=0.5', 'br-v1', true],
  ['br;q=0', 'br-v1', false],
  ['br;q=0.000', 'br-v1', false],
  ['br;q=1.001', 'br-v1', false],
  ['br, br;q=0', 'br-v1', false],
  ['gzip, deflate', 'br-v1', false],
  ['br', undefined, false],
  ['br', 'unknown', false],
])('negotiates bundle encoding only when both peers support it (%s)', (accept, worker, expected) => {
  expect(useBrotliManagerBundle({ 'accept-encoding': accept, 'x-cordisx-resource-encoding': worker }))
    .toBe(expected)
})
