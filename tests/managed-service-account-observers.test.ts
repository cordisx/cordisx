import { expect, it, vi } from 'vitest'
import { ManagedServiceAccountObservers } from '../packages/cli/src/renderer/managed-service-account-observers.js'
import type { ManagedServiceAccountAdoption } from '../packages/cli/src/managed-service-account-adoption.js'

const binding = {
  bindingId: 'binding-1',
  identity: { pluginId: 'plugin', serviceId: 'gateway' },
  scope: { profileId: 'default', generation: 'owner-1' },
}
const accounts = (revision: number) => ({
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-cli-proxy-accounts.v1.schema.json' as const,
  contract: 'cordisx.managed-service-cli-proxy-accounts/v1' as const,
  schemaVersion: 1 as const,
  binding,
  sequence: 1,
  observedAt: '2026-01-01T00:00:00Z',
  revision,
  serviceGeneration: 'service-1',
  accounts: [],
})
const action = (phase: ManagedServiceAccountAdoption['phase'], revision = 1): ManagedServiceAccountAdoption => ({
  requestId: 'request-1',
  pluginId: 'plugin',
  pluginGeneration: 'generation-1',
  serviceId: 'gateway',
  phase,
  binding,
  ...(phase === 'cancel' ? {} : { accounts: accounts(revision) }),
})

it('waits for every current observer before acknowledging an account projection', async () => {
  const observers = new ManagedServiceAccountObservers()
  let finish!: () => void
  const slow = vi.fn(async () => await new Promise<void>(resolve => finish = resolve))
  const late = vi.fn()
  observers.observe('owner', 'gateway', binding, slow)
  const preparing = observers.adopt('owner', action('prepare'), () => true)
  await Promise.resolve()
  observers.observe('owner', 'gateway', binding, late)
  finish()
  expect(await preparing).toBe(true)
  expect(late).toHaveBeenCalledOnce()
  let confirmed = false
  const confirming = observers.adopt('owner', action('confirm', 2), () => true).then(value => {
    confirmed = value
    return value
  })
  await Promise.resolve()
  expect(confirmed).toBe(false)
  finish()
  expect(await confirming).toBe(true)
  observers.close()
})

it('requires the same owner, binding and live request through prepare, confirm and cancel', async () => {
  const observers = new ManagedServiceAccountObservers()
  const seen = vi.fn()
  const dispose = observers.observe('owner', 'gateway', binding, seen)
  expect(await observers.adopt('owner', action('prepare'), () => true)).toBe(true)
  expect(await observers.adopt('owner', { ...action('confirm', 2), requestId: 'other' }, () => true)).toBe(false)
  expect(await observers.adopt('other', action('confirm', 2), () => true)).toBe(false)
  expect(await observers.adopt('owner', action('confirm', 2), () => true)).toBe(true)
  expect(seen.mock.calls.map(call => call[0].revision)).toEqual([1, 2])
  dispose()
  expect(await observers.adopt('owner', action('prepare', 2), () => true)).toBe(true)
  expect(await observers.adopt('owner', action('cancel'), () => true)).toBe(true)
  expect(await observers.adopt('owner', action('confirm', 3), () => true)).toBe(false)
  observers.close()
})

it('does not acknowledge a rejected observer or a replaced service generation', async () => {
  const observers = new ManagedServiceAccountObservers()
  observers.observe('owner', 'gateway', binding, async () => {
    throw new Error('stale view')
  })
  expect(await observers.adopt('owner', action('prepare'), () => true)).toBe(false)
  expect(await observers.adopt('owner', action('cancel'), () => true)).toBe(true)
  observers.releaseOwner('owner')
  expect(await observers.adopt('owner', action('prepare'), () => true)).toBe(true)
  expect(
    await observers.adopt('owner', {
      ...action('confirm', 2),
      accounts: { ...accounts(2), serviceGeneration: 'other' },
    }, () => true),
  ).toBe(false)
  observers.close()
})

it('waits for a late observer to finish its cached account state before a new handoff', async () => {
  const observers = new ManagedServiceAccountObservers()
  expect(await observers.adopt('owner', action('prepare'), () => true)).toBe(true)
  expect(await observers.adopt('owner', action('confirm', 2), () => true)).toBe(true)

  let finishCached!: () => void
  let first = true
  const seen: number[] = []
  observers.observe('owner', 'gateway', binding, async value => {
    if (first) {
      first = false
      await new Promise<void>(resolve => finishCached = resolve)
    }
    seen.push(value.revision)
  })
  let prepared = false
  const preparing = observers.adopt('owner', action('prepare', 2), () => true).then(result => {
    prepared = true
    return result
  })
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(prepared).toBe(false)
  } finally {
    finishCached()
  }
  expect(await preparing).toBe(true)
  expect(await observers.adopt('owner', action('confirm', 3), () => true)).toBe(true)
  expect(seen).toEqual([2, 2, 3])
  observers.close()
})

it('does not deliver queued account state after its owner is retired', async () => {
  const observers = new ManagedServiceAccountObservers()
  expect(await observers.adopt('owner', action('prepare'), () => true)).toBe(true)
  expect(await observers.adopt('owner', action('confirm', 2), () => true)).toBe(true)
  let finishCached!: () => void
  const seen: number[] = []
  observers.observe('owner', 'gateway', binding, async value => {
    seen.push(value.revision)
    if (seen.length === 1) await new Promise<void>(resolve => finishCached = resolve)
  })
  const preparing = observers.adopt('owner', action('prepare', 2), () => true)
  await new Promise<void>(resolve => setImmediate(resolve))
  observers.releaseOwner('owner')
  finishCached()
  expect(await preparing).toBe(false)
  expect(seen).toEqual([2])
  observers.close()
})
