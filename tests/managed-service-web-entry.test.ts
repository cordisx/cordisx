import { createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  canonicalManagedServiceWebOrigin,
  createManagedServiceWebEntryReader,
} from '../packages/cli/src/launcher/managed-service-web-entry.js'
import type { ManagedServiceRecord } from '../packages/cli/src/launcher/managed-service-runtime-record.js'
import { ManagedServiceSchemaRegistry } from '../packages/cli/src/launcher/managed-service-schema.js'
import { assertManagedSafeValue } from '../packages/cli/src/launcher/managed-service-runtime-support.js'

const schemaRoot = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/'
const sourceContract = 'cordisx.managed-service-web-entry-source-result/v1'
const proofContract = 'cordisx.managed-service-web-entry-proof/v1'
const primary = 'http://127.0.0.1:31241'
const secondary = 'http://127.0.0.1:31242'
const declaration = {
  contract: 'cordisx.managed-service-web-entry-source/v1',
  serviceId: 'gateway',
  operationId: 'console.info',
  verification: { kind: 'shared-instance-hmac-sha256', path: '/proof' },
}

function fixture(options: { fetch?: typeof globalThis.fetch; timeoutMs?: number; declaration?: unknown } = {}) {
  const secret = randomBytes(32)
  const proof = (challenge: string, origin = secondary, instance = 'instance-one') =>
    createHmac('sha256', secret).update(JSON.stringify([proofContract, challenge, origin, instance])).digest('hex')
  const calls: { url: URL; init: RequestInit }[] = []
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({ url: new URL(String(url)), init: init! })
    if (options.fetch) return options.fetch(url, init)
    const target = new URL(String(url))
    const verification = { instance: 'instance-one', proof: proof(target.searchParams.get('challenge')!) }
    return Response.json(
      target.origin === primary
        ? { contract: sourceContract, status: 'available', origin: secondary, verification }
        : { contract: proofContract, ...verification },
    )
  }
  const listeners = new Set<() => void>()
  const signal = new AbortController()
  let current = true
  let endpointOwned = true
  const record = {
    binding: {
      registrationHandle: 'msr_one',
      serviceHandle: 'mss_one',
      hostGeneration: 'host-one',
      serviceGeneration: 'one',
    },
    definition: {
      serviceId: 'gateway',
      httpAuthentication: { mode: 'authorization-header', scheme: 'Bearer', slot: 'key' },
      operations: [{
        operationId: 'console.info',
        method: 'GET',
        path: '/console',
        requestEncoding: 'query',
        requestSchema: `${schemaRoot}managed-service-web-entry-challenge.v1.schema.json`,
        responseSchema: `${schemaRoot}managed-service-web-entry-source-result.v1.schema.json`,
        timeoutMs: options.timeoutMs ?? 2000,
      }],
    },
    state: 'ready',
    health: 'ready',
    origin: primary,
    brokerHandle: 'msb_one',
    disposed: false,
    processOwnership: 'borrowed',
    lifecycle: new AbortController(),
    secrets: new Map([['key', 'private-broker-key']]),
    schemas: new ManagedServiceSchemaRegistry(),
  } as unknown as ManagedServiceRecord
  const reader = createManagedServiceWebEntryReader({
    record,
    declaration: options.declaration ?? declaration,
    fetch,
    signal: signal.signal,
    current: () => current,
    endpointOwned: () => endpointOwned,
    subscribe: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  })
  return {
    reader,
    record,
    signal,
    calls,
    proof,
    listeners,
    changed: () => {
      for (const listener of listeners) listener()
    },
    revokeEndpoint: () => {
      endpointOwned = false
      for (const listener of listeners) listener()
    },
    replace: () => {
      current = false
      for (const listener of listeners) listener()
    },
  }
}

describe('dedicated web entry ownership', () => {
  it('proves a second endpoint with a fresh challenge and never sends authority to that endpoint', async () => {
    const f = fixture()
    expect(await f.reader.read('one', new AbortController().signal)).toEqual({ status: 'available', origin: secondary })
    expect(await f.reader.read('one', new AbortController().signal)).toEqual({ status: 'available', origin: secondary })
    const [source, proof, secondSource] = f.calls
    expect(source!.url.searchParams.size).toBe(1)
    expect(source!.url.searchParams.get('challenge')).toMatch(/^[a-f0-9]{64}$/u)
    expect(source!.url.search).toBe(proof!.url.search)
    expect(secondSource!.url.search).not.toBe(source!.url.search)
    expect(source!.init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      headers: { Authorization: 'Bearer private-broker-key' },
    })
    expect(proof!.init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', headers: {} })
    expect(source!.init.body).toBeUndefined()
    expect(f.listeners.size).toBe(0)
  })

  it('accepts the current registered origin with no secondary proof and preserves generic invoke restrictions', async () => {
    const f = fixture({
      fetch: async () => Response.json({ contract: sourceContract, status: 'available', origin: primary }),
    })
    expect(await f.reader.read('one', new AbortController().signal)).toEqual({ status: 'available', origin: primary })
    expect(f.calls).toHaveLength(1)
    expect(() => assertManagedSafeValue({ origin: primary })).toThrow('authority-shaped')
  })

  it.each([
    'http://localhost:1234',
    'http://127.1:1234',
    'http://127.0.0.1:80',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:1234/',
    'http://127.0.0.1:1234?x',
    'http://x@127.0.0.1:1234',
    'http://127.0.0.1:1234#x',
    'http://127.0.0.1:01234',
    'http://2130706433:1234',
    'http://[::ffff:127.0.0.1]:1234',
  ])('rejects noncanonical origin %s before a second request', async origin => {
    const f = fixture({ fetch: async () => Response.json({ contract: sourceContract, status: 'available', origin }) })
    expect(await f.reader.read('one', new AbortController().signal)).toEqual({
      status: 'unavailable',
      code: 'invalid-source',
    })
    expect(f.calls).toHaveLength(1)
  })

  it.each(['http://127.0.0.1', 'https://127.0.0.1', 'https://[::1]:1234'])('supports canonical loopback %s', origin => {
    expect(canonicalManagedServiceWebOrigin(origin)).toBe(origin)
  })

  it.each(['missing-proof', 'copied-instance', 'replay', 'foreign-origin', 'extra-field', 'redirect'])(
    'rejects %s ownership claims',
    async mode => {
      let f: ReturnType<typeof fixture>
      f = fixture({
        fetch: async (url) => {
          const target = new URL(String(url))
          const verification = { instance: 'instance-one', proof: f.proof(target.searchParams.get('challenge')!) }
          if (target.origin === primary) {
            return Response.json({
              contract: sourceContract,
              status: 'available',
              origin: secondary,
              ...(mode === 'missing-proof' ? {} : { verification }),
            })
          }
          if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: primary } })
          return Response.json({
            contract: proofContract,
            instance: 'instance-one',
            proof: mode === 'replay' ? f.proof('0'.repeat(64)) : mode === 'foreign-origin'
              ? f.proof(target.searchParams.get('challenge')!, primary)
              : mode === 'copied-instance'
              ? '0'.repeat(64)
              : verification.proof,
            ...(mode === 'extra-field' ? { token: 'must-not-leak' } : {}),
          })
        },
      })
      expect(await f.reader.read('one', new AbortController().signal)).toEqual({
        status: 'unavailable',
        code: 'ownership-unverified',
      })
    },
  )

  it.each(['pid', 'instance', 'token', 'runtimeHandle'])('rejects unexpected source field %s', async key => {
    const f = fixture({
      fetch: async () =>
        Response.json({ contract: sourceContract, status: 'available', origin: primary, [key]: 'private' }),
    })
    expect(await f.reader.read('one', new AbortController().signal)).toEqual({
      status: 'unavailable',
      code: 'invalid-source',
    })
  })

  it.each(['stopped', 'failed', 'disposed'])('does no request for %s service', async state => {
    const f = fixture()
    f.record.state = state as ManagedServiceRecord['state']
    expect((await f.reader.read('one', new AbortController().signal)).status).toBe('unavailable')
    expect(f.calls).toHaveLength(0)
  })

  it('rejects a exited or replaced owned child and a lost endpoint reservation', async () => {
    const f = fixture()
    f.record.processOwnership = 'host-owned'
    f.record.child = { exitCode: 0, signalCode: null } as ManagedServiceRecord['child']
    expect((await f.reader.read('one', new AbortController().signal)).status).toBe('unavailable')
    expect(f.calls).toHaveLength(0)
    f.record.processOwnership = 'borrowed'
    f.record.child = undefined
    f.revokeEndpoint()
    expect(await f.reader.read('one', new AbortController().signal)).toEqual({
      status: 'unavailable',
      code: 'ownership-unverified',
    })
    expect(f.calls).toHaveLength(0)
  })

  it.each(['generation', 'replacement', 'dispose', 'abort', 'endpoint', 'child'])(
    'cancels pending source on %s and denies late completion',
    async transition => {
      let entered!: () => void
      const started = new Promise<void>(resolve => {
        entered = resolve
      })
      let release!: (value: Response) => void
      const response = new Promise<Response>(resolve => {
        release = resolve
      })
      const f = fixture({
        fetch: async () => {
          entered()
          return response
        },
      })
      const caller = new AbortController()
      const pending = f.reader.read('one', caller.signal)
      await started
      if (transition === 'generation') {
        f.record.binding = { ...f.record.binding, serviceGeneration: 'two' }
        f.changed()
      }
      if (transition === 'replacement') f.replace()
      if (transition === 'dispose') {
        f.record.disposed = true
        f.record.lifecycle.abort()
      }
      if (transition === 'abort') caller.abort()
      if (transition === 'endpoint') f.revokeEndpoint()
      if (transition === 'child') {
        f.record.child = {} as ManagedServiceRecord['child']
        f.changed()
      }
      expect((await pending).status).toBe('unavailable')
      expect(f.calls[0]!.init.signal?.aborted).toBe(true)
      release(Response.json({ contract: sourceContract, status: 'available', origin: primary }))
      expect(f.listeners.size).toBe(0)
    },
  )

  it('bounds an uncooperative source and an oversized streaming body', async () => {
    const timeout = fixture({ timeoutMs: 20, fetch: async () => new Promise(() => undefined) })
    expect(await timeout.reader.read('one', new AbortController().signal)).toEqual({
      status: 'unavailable',
      code: 'timeout',
    })
    const cancel = vi.fn()
    const oversized = fixture({
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(65537))
            },
            cancel,
          }),
        ),
    })
    expect(await oversized.reader.read('one', new AbortController().signal)).toEqual({
      status: 'unavailable',
      code: 'invalid-source',
    })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([{ ...declaration, serviceId: 'foreign' }, { ...declaration, operationId: 'unknown' }, {
    ...declaration,
    verification: { kind: 'shared-instance-hmac-sha256', path: '//foreign' },
  }, { ...declaration, arbitrary: 'value' }])('rejects invalid source admission', declaration => {
    expect(() => fixture({ declaration })).toThrow()
  })
})
