import { describe, expect, it, vi } from 'vitest'
import { resolveManagedServiceConfiguration } from '../packages/cli/src/launcher/managed-service-configuration-policy.js'
import { snapshotSelectedManagedServiceConfiguration } from '../packages/cli/src/launcher/managed-service-instance-configuration.js'

const object = (dict: Record<string, unknown>, meta = {}) => ({ type: 'object', dict, meta })
const scalar = (type = 'string', meta = {}) => ({ type, meta })
const Config = (schema: unknown, validate: (value: unknown) => unknown = value => ({ value })) => ({
  type: 'object',
  '~standard': { version: 1, vendor: 'fixture', validate },
  toJSON: () => schema,
})

describe('Node instance configuration proof and immutable data', () => {
  it('removes nested/array reserved roles before validation, keeps declared port and account paths', () => {
    const schema = object({
      account: object({ root: scalar(), site: scalar() }),
      port: scalar('number'),
      rows: { type: 'array', inner: object({ title: scalar(), opaque: scalar('string', { role: 'credential-ref' }) }) },
      ...Object.fromEntries(
        ['secret', 'credential', 'credential-ref', 'permission', 'capability'].map((
          role,
          i,
        ) => [`field${i}`, scalar('string', { role })]),
      ),
    })
    const raw = {
      account: { root: './account', site: 'local' },
      port: 41231,
      rows: [{ title: 'a', opaque: 'hidden' }],
      ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`field${i}`, 'hidden'])),
    }
    const validate = vi.fn(value => ({ value }))
    const snapshot = resolveManagedServiceConfiguration(raw, Config(schema, validate))!
    expect(validate).toHaveBeenCalledWith({
      account: { root: './account', site: 'local' },
      port: 41231,
      rows: [{ title: 'a' }],
    })
    expect(snapshot.value).toEqual(validate.mock.calls[0]![0])
    raw.account.root = './later'
    raw.rows[0]!.title = 'later'
    expect(snapshot.value.account).toEqual({ root: './account', site: 'local' })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.value.rows)).toBe(true)
    expect(Object.isFrozen((snapshot.value.rows as object[])[0])).toBe(true)
  })

  it('keeps omission/empty defaults, validates a declared schema even without overrides', () => {
    expect(resolveManagedServiceConfiguration(undefined, undefined)).toBeUndefined()
    expect(resolveManagedServiceConfiguration({}, undefined)).toBeUndefined()
    const validate = vi.fn(() => ({ value: { root: './default' } }))
    expect(resolveManagedServiceConfiguration({}, Config(object({ root: scalar() }), validate))).toBeUndefined()
    expect(validate).toHaveBeenCalledOnce()
    expect(() =>
      resolveManagedServiceConfiguration(
        {},
        Config(object({ bad: scalar('string', { role: 'secret', default: 'hidden' }) })),
      )
    ).toThrow('complete nonsecret')
    expect(() => resolveManagedServiceConfiguration({ root: './selected' }, undefined)).toThrow('complete nonsecret')
  })

  it.each([
    {},
    { type: 'object' },
    { uid: 1, refs: {} },
    { kind: 'schemastery', envelope: object({}) },
    object({ nested: { type: 'lazy' } }),
    object({ nested: { type: 'any' } }),
    object({ rows: { type: 'array' } }),
    object({ nested: { type: 'union', list: [scalar(), { type: 'lazy' }] } }),
    object({ root: scalar() }, { default: { unknown: 'hidden' } }),
    object({
      rows: {
        type: 'array',
        inner: object({ opaque: scalar('string', { role: 'secret' }) }),
        meta: { default: [{ opaque: 'hidden' }] },
      },
    }),
  ])('rejects incomplete projections and invalid/sensitive defaults without validator invocation %#', schema => {
    const validate = vi.fn(value => ({ value }))
    expect(() => resolveManagedServiceConfiguration({ root: 'value' }, Config(schema, validate))).toThrow(
      'complete nonsecret',
    )
    expect(validate).not.toHaveBeenCalled()
  })

  it('rejects undeclared input, nested/array fields and validator output rather than stripping them', () => {
    const schema = object({
      root: scalar(),
      nested: object({ known: scalar() }),
      rows: { type: 'array', inner: object({ known: scalar() }) },
    })
    for (const raw of [{ hidden: 'value' }, { nested: { hidden: 'value' } }, { rows: [{ hidden: 'value' }] }]) {
      const validate = vi.fn(() => ({ value: {} }))
      expect(() => resolveManagedServiceConfiguration(raw, Config(schema, validate))).toThrow('complete nonsecret')
      expect(validate).not.toHaveBeenCalled()
    }
    expect(() =>
      resolveManagedServiceConfiguration({ root: 'ok' }, Config(schema, () => ({ value: { hidden: 'value' } })))
    ).toThrow('complete nonsecret')
    expect(() =>
      resolveManagedServiceConfiguration(
        { root: 'ok' },
        Config(
          object({ root: scalar(), opaque: scalar('string', { role: 'secret' }) }),
          () => ({ value: { root: 'ok', opaque: 'restored' } }),
        ),
      )
    ).toThrow('complete nonsecret')
  })

  it('rejects async/thenable/failed validators with bounded diagnostics', () => {
    for (
      const validate of [
        () => Promise.resolve({ value: {} }),
        () => ({ then() {}, value: {} }),
        () => Object.create({ then() {} }),
        () => ({ issues: [{ message: 'private-value' }] }),
        () => {
          throw new Error('private-value')
        },
      ]
    ) {
      expect(() => resolveManagedServiceConfiguration({ root: 'ok' }, Config(object({ root: scalar() }), validate)))
        .toThrow(/^managed service Config cannot establish complete nonsecret configuration$/)
    }
  })

  it('rejects non-JSON data without executing getters, toJSON or proxies', () => {
    const trap = vi.fn(() => {
      throw new Error('must not run')
    })
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const sparse = Array(2)
    const extra = Object.assign([1], { extra: 2 })
    const getter = Object.defineProperty({}, 'root', { enumerable: true, get: trap })
    const symbol = { [Symbol('hidden')]: 'value' }
    for (
      const value of [
        NaN,
        Infinity,
        undefined,
        () => {},
        new Date(),
        cycle,
        sparse,
        extra,
        getter,
        symbol,
        new Proxy({}, { ownKeys: trap }),
        Object.defineProperty({}, 'hidden', { value: 1 }),
        { toJSON: trap },
      ]
    ) {
      expect(() => snapshotSelectedManagedServiceConfiguration({ value })).toThrow()
    }
    for (
      const result of [
        getter,
        new Proxy({}, { ownKeys: trap }),
        Object.defineProperty({}, 'then', { enumerable: true, get: trap }),
        Object.defineProperty({}, 'value', { enumerable: true, get: trap }),
      ]
    ) {
      expect(() => resolveManagedServiceConfiguration({ root: 'ok' }, Config(object({ root: scalar() }), () => result)))
        .toThrow('complete nonsecret')
    }
    expect(() =>
      resolveManagedServiceConfiguration({ root: 'ok' }, { ...Config(object({ root: scalar() })), type: 'array' })
    ).toThrow('complete nonsecret')
    expect(trap).not.toHaveBeenCalled()
  })
})
