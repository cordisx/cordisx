import { expect, it } from 'vitest'
import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LocalWorkSettlementCustody } from '../packages/cli/src/launcher/local-work-settlement-custody.js'
import { LocalWorkSettlementLifetimes } from '../packages/cli/src/launcher/local-work-settlement-lifetime.js'
import { PluginHttpClientLifetimes } from '../packages/cli/src/launcher/plugin-http-client-lifetime.js'
const binding = {
  origin: 'http://127.0.0.1:3000',
  sourceId: 's',
  instanceId: 'i',
  audience: 'local-work-income',
} as const
it('persists original scope custody across restart and alias changes; a missing file cannot reset it', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'settlement-custody-'))
  try {
    const custody = new LocalWorkSettlementCustody(home, 'p')
    await custody.claim('scope', binding, 'original', 'subject', () => {})
    const restarted = new LocalWorkSettlementCustody(home, 'p')
    await restarted.claim('scope', { ...binding, sourceId: 'new-alias' }, 'original', 'subject', () => {})
    expect(restarted.legacyAllowed('scope')).toBe(false)
    await expect(
      restarted.claim('scope', { ...binding, origin: 'http://127.0.0.1:4000' }, 'original', 'subject', () => {}),
    ).rejects.toThrow('conflict')
    await expect(restarted.claim('scope', binding, 'other-account', 'subject', () => {})).rejects.toThrow('conflict')
    await unlink(path.join(home, 'state/profiles/p/local-work-settlement.json'))
    await expect(restarted.claim('scope', binding, 'original', 'subject', () => {})).rejects.toThrow('reconciliation')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
it('concurrent cross-realm owners cannot both claim the same scope', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'settlement-custody-'))
  try {
    const a = new LocalWorkSettlementCustody(home, 'p'), b = new LocalWorkSettlementCustody(home, 'p')
    const results = await Promise.allSettled([
      a.claim('scope', binding, 'original', 'subject', () => {}),
      b.claim('scope', { ...binding, origin: 'http://127.0.0.1:4000' }, 'original', 'subject', () => {}),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const winner = results[0].status === 'fulfilled' ? binding : { ...binding, origin: 'http://127.0.0.1:4000' }
    new LocalWorkSettlementCustody(home, 'p').assert('scope', winner, 'original', 'subject')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
it('a cancelled private attempt never starts or revives, and cancellation is client-scoped', async () => {
  const clients = new PluginHttpClientLifetimes(),
    a = clients.open('owner', 'a'.repeat(16)),
    b = clients.open('owner', 'b'.repeat(16))
  const attempts = new LocalWorkSettlementLifetimes(), id = 'c'.repeat(16)
  attempts.cancel(a, id)
  let called = 0
  const execute = async () => {
    called++
    return { status: 'accepted' as const, value: 1 }
  }
  expect(await attempts.run(a, id, Date.now() + 10_000, execute)).toMatchObject({ code: 'aborted' })
  expect(called).toBe(0)
  expect(await attempts.run(b, id, Date.now() + 10_000, execute)).toMatchObject({ status: 'accepted' })
  expect(await attempts.run(b, id, Date.now() + 10_000, execute)).toMatchObject({ code: 'aborted' })
  expect(called).toBe(1)
})

it('a legacy attempt claims scope before sending and excludes later durable adoption, even after restart', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'settlement-custody-'))
  try {
    const custody = new LocalWorkSettlementCustody(home, 'p')
    await custody.claimLegacy('scope', () => {})
    expect(custody.legacyAllowed('scope')).toBe(true)
    await new LocalWorkSettlementCustody(home, 'p').claimLegacy('scope', () => {})
    await expect(custody.claim('scope', binding, 'original', 'subject', () => {})).rejects.toThrow('conflict')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
it('a legacy sender racing durable custody cannot both obtain permission to send', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'settlement-custody-'))
  try {
    const legacy = new LocalWorkSettlementCustody(home, 'p'), durable = new LocalWorkSettlementCustody(home, 'p')
    const results = await Promise.allSettled([
      legacy.claimLegacy('scope', () => {}),
      durable.claim('scope', binding, 'original', 'subject', () => {}),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    if (results[0].status === 'fulfilled') {
      await expect(durable.claim('scope', binding, 'original', 'subject', () => {})).rejects.toThrow('conflict')
    } else {
      expect(legacy.legacyAllowed('scope')).toBe(false)
      await expect(legacy.claimLegacy('scope', () => {})).rejects.toThrow('conflict')
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
