import { expect, it } from 'vitest'
import { safeServiceConfigEdit } from '../packages/cli/assets/manager/manager-schema.js'

it('admits known scalar edits without allowing sensitive, unknown, or array identity changes', () => {
  const envelope = {
    uid: 1,
    refs: {
      1: { type: 'object', dict: { providers: 2, contract: 7 } },
      2: { type: 'array', inner: 3 },
      3: { type: 'object', dict: { id: 4, name: 4, secret: 5 } },
      4: { type: 'string' },
      5: { type: 'string', meta: { role: 'credential-ref' } },
      7: { type: 'const', value: 'example' },
    },
  }
  const before = { contract: 'example', providers: [{ id: 'a', name: 'old', opaque: 'preserve' }] }
  const changed = { contract: 'example', providers: [{ id: 'a', name: 'new', opaque: 'preserve' }] }
  expect(safeServiceConfigEdit(envelope, before, changed)).toBe(true)
  expect(safeServiceConfigEdit(envelope, before, { ...changed, unknown: 'new' })).toBe(false)
  expect(safeServiceConfigEdit(envelope, before, { ...changed, providers: [{ id: 'a', name: 'new' }] })).toBe(false)
  expect(safeServiceConfigEdit(envelope, before, { ...changed, providers: [{ ...changed.providers[0], secret: 'x' }] }))
    .toBe(false)
  expect(safeServiceConfigEdit(envelope, before, { ...changed, providers: [{ ...changed.providers[0], id: 'b' }] }))
    .toBe(false)
  expect(safeServiceConfigEdit(envelope, before, { ...changed, providers: [] })).toBe(false)
  expect(safeServiceConfigEdit(envelope, before, { ...changed, contract: 'other' })).toBe(false)
})
