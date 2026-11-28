import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ChannelAgentAccess } from '../packages/cli/src/launcher/channel-agent-access.js'
import { channelMemoryCommand } from '../packages/cli/src/launcher/channel-memory-command.js'
import { type MemoryAuthority, memoryKey } from '../packages/cli/src/launcher/channel-memory-policy.js'
import { ChannelMemoryStore, type MemoryInput } from '../packages/cli/src/launcher/channel-memory-store.js'
import { MemoryRecordValidationError } from '../packages/cli/src/launcher/channel-memory-record-validation.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const context = (
  conversationId = 'A',
  userId = 'alice',
  kind: 'direct' | 'group' = 'direct',
): MemoryAuthority => ({
  actor: { adapterId: 'feishu', accountId: 'bot', tenantId: 'tenant', userId },
  conversation: { adapterId: 'feishu', accountId: 'bot', tenantId: 'tenant', conversationId },
  kind,
})
const input: MemoryInput = {
  kind: 'fact',
  title: 'Synthetic project',
  summary: 'Synthetic launch Tuesday',
  tags: ['launch'],
  entityRefs: ['project'],
  evidenceType: 'explicit',
  confidence: 1,
}
async function setup(clock?: () => string) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'channel-memory-'))
  roots.push(root)
  return new ChannelMemoryStore(root, clock)
}
describe('Channel memory synthetic authorization and storage', () => {
  it('rejects malformed records before persistence, but does not label corrupt stored data retry-safe', async () => {
    const store = await setup(), authority = context()
    for (
      const record of [
        { ...input, kind: 'task', confidence: 'high' },
        { ...input, confidence: Infinity, tags: 'project' },
        { ...input, kind: 'impression', observedAt: 'yesterday' },
        { ...input, summary: 'bad\0text', owner: 'forged' },
        null,
      ]
    ) {
      const error = await store.remember(authority, record as MemoryInput, 'invalid').catch(error => error)
      expect(error).toBeInstanceOf(MemoryRecordValidationError)
      expect(error.response()).toMatchObject({ code: 'MEMORY_INVALID_RECORD', retrySafe: true })
      expect(error.issues.length).toBeGreaterThan(0)
    }
    expect(await store.search(authority, 'Synthetic')).toHaveLength(0)
    const saved = await store.remember(authority, input, 'valid')
    await writeFile(path.join(store.files.root, `${saved.id}-1.json`), JSON.stringify({ ...saved, confidence: 'high' }))
    const error = await store.get(authority, saved.id).catch(error => error)
    expect(error.message).toBe('MEMORY_INVALID_RECORD')
    expect(error).not.toBeInstanceOf(MemoryRecordValidationError)
  })
  it('progressive cards paginate, route aliases and invalidate after correction', async () => {
    const store = await setup(), authority = context()
    for (let index = 0; index < 18; index++) {
      await store.remember(authority, { ...input, title: `Distractor ${index}`, tags: ['noise'] }, `noise-${index}`)
    }
    const target = await store.remember(authority, {
      ...input,
      title: 'Northstar',
      tags: ['Lantern'],
      summary: 'The tracking code is VIOLET-91',
    }, 'target')
    const first = await store.browse(authority, { navigation: true, limit: 3, maxBytes: 2048 }) as any
    expect(first.cards.length).toBeLessThanOrEqual(3)
    expect(first.returnedBytes).toBeLessThan(2048)
    expect(first.cards.every((card: any) => card.summary === undefined)).toBe(true)
    const hits = await store.browse(authority, { query: 'Lantern', maxBytes: 2048 }) as any
    expect(hits.cards.map((card: any) => card.id)).toContain(target.id)
    expect(JSON.stringify(hits)).not.toContain('keywords')
    expect((await store.batch(authority, [target.id]))[0]?.summary).toContain('VIOLET-91')
    await store.change(authority, target.id, 1, { ...input, title: 'Northstar latest', summary: 'CURRENT-52' })
    await expect(store.browse(authority, { cursor: first.nextCursor })).rejects.toThrow('MEMORY_CURSOR_STALE')
    expect((await store.browse(authority, { query: 'VIOLET-91' }) as any).cards).toHaveLength(0)
  })
  it('non-admin recalls own contributions across direct chats, not another participant', async () => {
    const store = await setup(), record = await store.remember(context(), input, 'synthetic-message')
    expect((await store.get(context('B'), record.id)).id).toBe(record.id)
    await expect(store.get(context('B', 'bob'), record.id)).rejects.toThrow('MEMORY_NOT_FOUND')
    await expect(store.get(context('B', 'alice', 'group'), record.id)).rejects.toThrow('MEMORY_NOT_FOUND')
    expect((await store.get({ ...context('B', 'alice', 'group'), ownDisclosure: true }, record.id)).id).toBe(
      record.id,
    )
    await expect(store.get({ ...context('B', 'bob', 'group'), ownDisclosure: true }, record.id)).rejects
      .toThrow('MEMORY_NOT_FOUND')
  })
  it('directed full A to B grant includes future records and future group members only in B', async () => {
    const store = await setup(), admin = { ...context(), administer: [memoryKey(context().conversation)] }
    const grant = await store.grant(admin, {
      source: memoryKey(context().conversation),
      target: { kind: 'conversation', id: memoryKey(context('B').conversation) },
    })
    const record = await store.remember(context(), input, 'future-synthetic-message')
    expect((await store.get(context('B', 'new-member', 'group'), record.id)).id).toBe(record.id)
    await expect(store.get(context('C', 'new-member', 'group'), record.id)).rejects.toThrow(
      'MEMORY_NOT_FOUND',
    )
    const reverse = await store.remember(context('B', 'bob'), input, 'reverse')
    await expect(store.get(context('A', 'charlie', 'group'), reverse.id)).rejects.toThrow('MEMORY_NOT_FOUND')
    await store.grant({ ...context('B'), administer: [memoryKey(context('B').conversation)] }, {
      source: memoryKey(context('B').conversation),
      target: { kind: 'conversation', id: memoryKey(context().conversation) },
    })
    expect((await store.get(context('A', 'charlie', 'group'), reverse.id)).id).toBe(reverse.id)
    await store.revoke(admin, grant.id)
    await expect(store.get(context('B', 'new-member', 'group'), record.id)).rejects.toThrow(
      'MEMORY_NOT_FOUND',
    )
  })
  it('expires grants and records at read time', async () => {
    let now = '2026-11-22T00:00:00.000Z'
    const store = await setup(() => now), authority = context()
    const record = await store.remember(
      authority,
      { ...input, expiresAt: '2026-11-23T00:00:00.000Z' },
      'expiry',
    )
    await store.grant({ ...authority, administer: [memoryKey(authority.conversation)] }, {
      source: memoryKey(authority.conversation),
      target: { kind: 'conversation', id: memoryKey(context('B').conversation) },
      expiresAt: '2026-11-22T01:00:00.000Z',
    })
    now = '2026-11-22T02:00:00.000Z'
    await expect(store.get(context('B', 'bob'), record.id)).rejects.toThrow('MEMORY_NOT_FOUND')
    now = '2026-11-23T00:00:00.000Z'
    await expect(store.get(authority, record.id)).rejects.toThrow('MEMORY_NOT_FOUND')
  })
  it('CRUD, revision conflicts, bounded entity search and corrupt index recovery', async () => {
    const store = await setup(),
      authority = context(),
      record = await store.remember(authority, input, 'crud')
    expect(await store.search(authority, 'launch', 'project')).toHaveLength(1)
    await expect(store.change(authority, record.id, 2, input)).rejects.toThrow('MEMORY_REVISION_CONFLICT')
    expect(
      (await store.change(authority, record.id, 1, { ...input, summary: 'Corrected Wednesday' }))?.revision,
    ).toBe(2)
    await writeFile(path.join(store.files.root, 'index.json'), '{corrupt')
    expect((await store.index(authority)).count).toBe(1)
    expect(await store.search(authority, 'Wednesday')).toHaveLength(1)
    await store.change(authority, record.id, 2)
    expect(await store.search(authority, 'Wednesday')).toHaveLength(0)
    await expect(store.get(authority, record.id)).rejects.toThrow('MEMORY_NOT_FOUND')
  })
  it('rejects traversal, symlinks, protected metadata injection and claimed admin', async () => {
    const store = await setup()
    await expect(store.get(context(), '../secret')).rejects.toThrow('MEMORY_INVALID_ID')
    await expect(store.remember(context(), { ...input, owner: 'attacker' } as MemoryInput, 'injection'))
      .rejects.toThrow('MEMORY_INVALID_RECORD')
    await expect(
      store.grant(context(), {
        source: memoryKey(context().conversation),
        target: { kind: 'conversation', id: memoryKey(context('B').conversation) },
      }),
    ).rejects.toThrow('MEMORY_GRANT_AUTHORITY_UNAVAILABLE')
    const target = path.join(store.files.root, 'outside')
    await writeFile(target, '{}')
    await symlink(target, path.join(store.files.root, 'state.json'))
    await expect(store.search(context(), 'launch')).rejects.toBeDefined()
  })
  it('real Host resolver rejects forged CLI contexts and accepts active sourced dispatch', async () => {
    const store = await setup(),
      source = {
        ...context().conversation,
        kind: 'direct',
        actor: { userId: 'alice' },
        messageId: 'verified',
      }
    const access = new ChannelAgentAccess(() => ({}) as never, () =>
      ({
        contextFor: (token: string) => token === 'host-token' ? { threadId: 'thread' } : undefined,
        sourceFor: () => source,
        hasPreparation: () => false,
        isPreparing: () => false,
      }) as never)
    await expect(channelMemoryCommand(store, access, { action: 'search', query: 'launch' }, {
      'cordisx/channelContext': 'forged',
    })).rejects.toThrow('CHANNEL_CONTEXT_UNAVAILABLE')
    const result = await channelMemoryCommand(store, access, { action: 'remember', record: input }, {
      'cordisx/channelContext': 'host-token',
    })
    expect(result).toMatchObject({ status: 'ok', result: { provenance: { messageId: 'verified' } } })
    await expect(channelMemoryCommand(store, access, { action: 'get', id: 'x', actor: 'admin' }, {
      'cordisx/channelContext': 'host-token',
    })).rejects.toThrow('MEMORY_INVALID_REQUEST')
  })
  it('confirmed multi-adapter identity prevents collisions and unbind revokes entity eligibility', async () => {
    const store = await setup(), authority = context(), entity = 'e'.repeat(64)
    const telegram = {
      ...context('B', 'telegram-alice'),
      actor: { ...authority.actor, adapterId: 'telegram', userId: '42' },
    }
    await store.bindConfirmed(entity, [authority.actor, telegram.actor])
    await expect(store.bindConfirmed('f'.repeat(64), [authority.actor, telegram.actor])).rejects.toThrow(
      'MEMORY_BINDING_COLLISION',
    )
    await store.grant({ ...authority, administer: [memoryKey(authority.conversation)] }, {
      source: memoryKey(authority.conversation),
      target: { kind: 'entity', id: entity },
    })
    const record = await store.remember(authority, input, 'entity-source')
    expect((await store.get(telegram, record.id)).id).toBe(record.id)
    await expect(store.get({ ...telegram, kind: 'group' }, record.id)).rejects.toThrow('MEMORY_NOT_FOUND')
    await store.unbind(telegram)
    await expect(store.get(telegram, record.id)).rejects.toThrow('MEMORY_NOT_FOUND')
    for (const adapterId of ['feishu', 'wechat', 'qq', 'telegram', 'discord']) {
      expect(memoryKey({ ...authority.actor, adapterId })).toHaveLength(64)
    }
  })
  it('atomic revision manifest survives orphan files and lock contention', async () => {
    const store = await setup(),
      authority = context(),
      record = await store.remember(authority, input, 'atomic')
    await store.files.write(`${record.id}-2.json`, { ...record, summary: 'uncommitted', revision: 2 })
    expect((await store.get(authority, record.id)).summary).toBe(input.summary)
    await writeFile(store.files.file('lock.json'), '{}')
    await expect(store.change(authority, record.id, 1, input)).rejects.toThrow('MEMORY_BUSY')
    expect((await store.get(authority, record.id)).revision).toBe(1)
  })
  it('group correction never returns undisclosed private provenance', async () => {
    const store = await setup(), record = await store.remember(context(), input, 'private-provenance')
    expect(await store.change(context('B', 'alice', 'group'), record.id, 1, input)).toBeNull()
  })
})
