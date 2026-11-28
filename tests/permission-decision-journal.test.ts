import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  PermissionDecisionJournal,
  permissionDecisionKey,
} from '../packages/cli/src/cli/permission-decision-journal.js'
import { createOwnerAdapterPermissionHistory } from '../packages/cli/src/cli/owner-adapter-permission-history.js'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'
import { withManagerDomAskPolicies } from '../packages/cli/src/cli/permission-decision-history.js'

const temporary = new Set<string>()
const record = createPermissionPolicyRecord({
  profileId: 'work',
  identity: { id: 'demo', source: 'file:///private/example/plugin.js' },
  capability: 'models.read',
  scope: { providers: ['provider'] },
  policy: 'allow',
})

async function fixture() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cx-permission-decisions-'))
  temporary.add(homeDir)
  return { homeDir, journal: new PermissionDecisionJournal({ homeDir, profileId: 'work' }) }
}

afterEach(async () => {
  await Promise.all([...temporary].map(async directory => await rm(directory, { recursive: true, force: true })))
  temporary.clear()
})

it('records the client before publication and only reports a committed decision after its receipt', async () => {
  const { homeDir, journal } = await fixture()
  const pending = await journal.begin({ client: 'web', requestId: 'request-1', records: [record] })
  const before = await journal.read(pending.id)
  expect(before.committedAt).toBeUndefined()
  expect(before.entry).toMatchObject({
    client: 'web',
    profileId: 'work',
    requestId: 'request-1',
    changes: [{ pluginId: 'demo', capability: 'models.read', key: permissionDecisionKey(record), policy: 'allow' }],
  })
  const file = path.join(homeDir, 'state', 'profiles', 'work', 'permission-decisions', `${pending.id}.json`)
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  expect(await readFile(file, 'utf8')).not.toContain(record.key.identity.source)
  await pending.commit()
  expect((await journal.read(pending.id)).committedAt).toEqual(expect.any(String))
  await expect(pending.commit()).rejects.toThrow('permission-decision-journal-unavailable')
})

it('preserves an unconfirmed decision after reopening and rejects another profile or duplicate policy key', async () => {
  const { homeDir, journal } = await fixture()
  const pending = await journal.begin({ client: 'codex', requestId: 'request-2', records: [record] })
  const reopened = new PermissionDecisionJournal({ homeDir, profileId: 'work' })
  expect(await reopened.read(pending.id)).toMatchObject({ entry: { client: 'codex' } })
  expect((await reopened.read(pending.id)).committedAt).toBeUndefined()
  await expect(journal.begin({ client: 'web', requestId: 'same', records: [record, record] })).rejects.toThrow()
  await expect(
    new PermissionDecisionJournal({ homeDir, profileId: 'other' }).begin({
      client: 'web',
      requestId: 'cross-profile',
      records: [record],
    }),
  ).rejects.toThrow()
})

it('projects only the requested policy history, including unconfirmed attempts', async () => {
  const { journal } = await fixture()
  const other = createPermissionPolicyRecord({
    profileId: 'work',
    identity: { id: 'other', source: 'file:///private/other.js' },
    capability: 'models.read',
    scope: { providers: ['provider'] },
    policy: 'deny',
  })
  const first = await journal.begin({ client: 'web', requestId: 'first', records: [record, other] })
  await first.commit()
  await journal.begin({ client: 'codex', requestId: 'second', records: [record] })
  const entries = await journal.recent([record])
  expect(entries).toHaveLength(2)
  expect(entries.every(item => item.entry.changes.length === 1 && item.entry.changes[0]?.pluginId === 'demo'))
    .toBe(true)
  expect(entries.find(item => item.entry.requestId === 'first')?.committedAt).toEqual(expect.any(String))
  expect(entries.find(item => item.entry.requestId === 'second')?.committedAt).toBeUndefined()
})

it('lets an admitted native client read owner history and rejects a disconnected or foreign profile', async () => {
  const { journal } = await fixture()
  const decision = await journal.begin({ client: 'web', requestId: 'first', records: [record] })
  await decision.commit()
  let current = true
  let policies = [record]
  const handler = createOwnerAdapterPermissionHistory({
    profileId: 'work',
    journal,
    loadPolicies: async () => policies,
  })
  const context = { secret: 'not-exposed', current: () => current }
  expect(await handler({ kind: 'permission-history', pluginId: 'demo' }, context)).toMatchObject([{
    record,
    decision: 'allow',
    client: 'web',
    committedAt: expect.any(String),
  }])
  current = false
  await expect(handler({ kind: 'permission-history', pluginId: 'demo' }, context)).rejects.toThrow()
  current = true
  policies = [{ ...record, key: { ...record.key, profileId: 'other' } }]
  await expect(handler({ kind: 'permission-history', pluginId: 'demo' }, context)).rejects.toThrow()
})

it('finds a one-time decision even before a policy is saved', async () => {
  const { journal } = await fixture()
  const records = withManagerDomAskPolicies([], 'work', { id: 'demo', source: 'file:///demo.js' })
  const decision = await journal.begin({
    client: 'codex',
    requestId: 'one-time',
    records: [records[0]!],
    onceDecision: 'allow-once',
  })
  await decision.commit()
  expect(await journal.recent(records)).toMatchObject([{
    entry: { client: 'codex', changes: [{ policy: 'allow-once' }] },
    committedAt: expect.any(String),
  }])
})

it('projects lifecycle reviews only for the exact plugin source and keeps unconfirmed outcomes distinct', async () => {
  const { journal } = await fixture()
  const ask = { ...record, policy: 'ask' as const }
  const pending = await journal.begin({
    client: 'codex',
    requestId: 'install-1',
    records: [ask],
    lifecycle: { operation: 'install', decisions: ['allow-once'] },
  })
  const identity = { id: 'demo', source: record.key.identity.source }
  expect(await journal.recentLifecycle(identity)).toMatchObject([{
    operation: 'install',
    client: 'codex',
    decisions: [{ capability: 'models.read', decision: 'allow-once' }],
  }])
  expect((await journal.recentLifecycle(identity))[0]?.committedAt).toBeUndefined()
  expect(await journal.recentLifecycle({ ...identity, source: 'file:///another/plugin.js' })).toEqual([])
  await pending.commit()
  const handler = createOwnerAdapterPermissionHistory({
    profileId: 'work',
    journal,
    loadPolicies: async () => [],
    reviewIdentity: async () => ({ identity, isCurrent: () => true }),
  })
  const result = await handler({ kind: 'plugin-authorization-history', pluginId: 'demo' }, {
    secret: 'not-exposed',
    current: () => true,
  })
  expect(result).toMatchObject([{ client: 'codex', committedAt: expect.any(String) }])
  expect(JSON.stringify(result)).not.toContain(identity.source)
})
