import { mkdtemp, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { expect, it } from 'vitest'
import { mockMemoryBoundary } from './fixtures/channel-memory-model-boundary.js'

it('mock platform dispatch reaches real command/store with reset verified context', async () => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'memory-boundary-'))
  try {
    const boundary = mockMemoryBoundary(root)
    boundary.dispatch('alice', 'A', 'direct', 'qq', 'message-one', 'context-one')
    expect(await boundary.call({ action: 'guide' }, 'context-one')).toMatchObject({
      status: 'ok',
      result: { topics: ['write', 'organize', 'recall'] },
    })
    expect(await boundary.call({ action: 'guide', topic: 'write' }, 'context-one')).toMatchObject({ status: 'ok' })
    const guide = await boundary.call({ action: 'guide', topic: 'recall' }, 'context-one') as {
      result: { unsupportedContextProfiles: string; experienceOrganization: string; outboundStyle: string }
    }
    expect(guide.result.unsupportedContextProfiles).toContain('one continuous configurable assistant')
    expect(guide.result.unsupportedContextProfiles).toContain('Human person entities/role scopes are distinct')
    expect(guide.result.unsupportedContextProfiles).toContain('not implemented')
    expect(guide.result.unsupportedContextProfiles).toContain('integrated into native dispatch and operator CLI')
    expect(guide.result.unsupportedContextProfiles).not.toContain('not integrated into production')
    expect(guide.result.experienceOrganization).toContain(
      'Keep episodic/person/group/project details and petty trivia local',
    )
    expect(guide.result.experienceOrganization).toContain('explicit acceptance')
    expect(guide.result.experienceOrganization).toContain('2048 UTF-8 bytes')
    expect(guide.result.experienceOrganization).toContain('not implemented')
    expect(guide.result.outboundStyle).toContain('all user-visible outbound text')
    expect(guide.result.outboundStyle).toContain('option semantic values stay unchanged')
    expect(guide.result.outboundStyle).toContain('not implemented')
    expect(
      await boundary.call({
        action: 'remember',
        record: {
          kind: 'fact',
          title: 'Synthetic',
          summary: 'Verified boundary fact',
          tags: [],
          entityRefs: [],
          evidenceType: 'explicit',
          confidence: 1,
        },
      }, 'context-one'),
    )
      .toMatchObject({ status: 'ok', result: { provenance: { messageId: 'message-one' } } })
    boundary.dispatch('alice', 'B', 'direct', 'qq', 'message-two', 'context-two')
    expect(await boundary.call({ action: 'search', query: 'boundary' }, 'context-one')).toMatchObject({
      status: 'rejected',
    })
    expect(await boundary.call({ action: 'search', query: 'boundary' }, 'context-two')).toMatchObject({ status: 'ok' })
    expect(await boundary.records()).toHaveLength(1)
    await boundary.configureAdministrator('alice', ['A'])
    boundary.dispatch('alice', 'A', 'group', 'feishu', 'grant-message', 'grant-context', 'Fully share A to B')
    const grant = await boundary.call(
      { action: 'grant', grant: { target: { kind: 'conversation', id: 'B' } } },
      'grant-context',
    ) as any
    expect(grant.status).toBe('ok')
    boundary.dispatch('alice', 'A', 'direct', 'feishu', 'save-message', 'save-context', 'Remember target code')
    const saved = await boundary.call({
      action: 'remember',
      record: {
        kind: 'fact',
        title: 'Shared target',
        summary: 'CODE-77',
        tags: [],
        entityRefs: [],
        evidenceType: 'explicit',
        confidence: 1,
      },
    }, 'save-context') as any
    boundary.dispatch('new-member', 'B', 'group', 'feishu', 'recall-message', 'recall-context', 'What code?')
    expect(await boundary.call({ action: 'get', id: saved.result.id }, 'recall-context')).toMatchObject({
      status: 'ok',
    })
    boundary.dispatch('alice', 'A', 'group', 'feishu', 'revoke-message', 'revoke-context', 'Revoke sharing')
    expect(await boundary.call({ action: 'revoke', id: grant.result.id }, 'revoke-context')).toMatchObject({
      status: 'ok',
    })
    boundary.dispatch('new-member', 'B', 'group', 'feishu', 'after-revoke', 'denied-context', 'What code?')
    expect(await boundary.call({ action: 'get', id: saved.result.id }, 'denied-context')).toMatchObject({
      status: 'rejected',
    })
    boundary.dispatch('alice', 'A', 'direct', 'feishu', 'link-message', 'link-context', 'Link my Telegram account')
    const challenge = await boundary.call({
      action: 'identity-challenge',
      target: { adapterId: 'telegram', accountId: 'synthetic-bot', tenantId: 'synthetic-tenant', userId: 'alice' },
    }, 'link-context') as any
    boundary.dispatch(
      'alice',
      'B',
      'direct',
      'telegram',
      'confirm-message',
      'confirm-context',
      `Confirm ${challenge.result.challenge}`,
    )
    expect(
      await boundary.call({ action: 'identity-confirm', challenge: challenge.result.challenge }, 'confirm-context'),
    ).toMatchObject({ status: 'ok' })
    expect(await boundary.call({ action: 'get', id: saved.result.id }, 'confirm-context')).toMatchObject({
      status: 'ok',
    })
    expect(
      await boundary.call({ action: 'identity-confirm', challenge: challenge.result.challenge }, 'confirm-context'),
    ).toMatchObject({ status: 'rejected' })
    boundary.dispatch('alice', 'oc_private', 'direct', 'feishu', 'send-message', 'send-context', 'Send code')
    expect(await boundary.call({ action: 'send', text: 'Code CODE-77', operationId: 'synthetic-send' }, 'send-context'))
      .toMatchObject({ status: 'ok', deliveryState: 'sent' })
    expect(boundary.outbound()).toHaveLength(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('Chinese owned project recall matches concise stored subjects without opening unrelated private records', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-chinese-boundary-'))
  try {
    const boundary = mockMemoryBoundary(root)
    boundary.dispatch('alice', 'A', 'direct', 'feishu', 'save', 'save-context', '记住青杉项目')
    const record = {
      kind: 'fact',
      title: '青杉',
      summary: '已完成接口，下一步是文档',
      tags: ['青杉'],
      entityRefs: [],
      evidenceType: 'explicit',
      confidence: 1,
    }
    const saved = await boundary.call({ action: 'remember', record }, 'save-context') as any
    boundary.dispatch('alice', 'B', 'group', 'feishu', 'recall', 'recall-context', '我的青杉项目现在进度是什么？')
    expect(await boundary.call({ action: 'get', id: saved.result.id }, 'recall-context')).toMatchObject({
      status: 'ok',
    })
    expect(await boundary.call({ action: 'search-page', query: '青杉' }, 'recall-context')).toMatchObject({
      result: { cards: [{ id: saved.result.id }] },
    })
    boundary.dispatch('bob', 'B', 'group', 'feishu', 'other-user', 'other-context', '我的青杉项目现在进度是什么？')
    expect(await boundary.call({ action: 'get', id: saved.result.id }, 'other-context')).toMatchObject({
      status: 'rejected',
    })
    boundary.dispatch('alice', 'B', 'group', 'feishu', 'generic', 'generic-context', '我的项目现在进度是什么？')
    expect(await boundary.call({ action: 'get', id: saved.result.id }, 'generic-context')).toMatchObject({
      status: 'rejected',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('a configured command administrator recalls own relevant work in a group without a persistent sharing grant', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-admin-recall-'))
  try {
    const boundary = mockMemoryBoundary(root)
    boundary.policy({
      enabled: true,
      rules: [{
        id: 'admin',
        adapterId: 'feishu',
        accountId: 'synthetic-bot',
        tenantId: 'synthetic-tenant',
        action: 'command',
        effect: 'allow',
        userIds: ['alice'],
        commands: ['allow-user', 'deny-user', 'reset-user'],
      }],
    })
    const record = {
      kind: 'fact',
      title: 'Cedar project',
      summary: 'Deployment verified: ADMIN-42',
      tags: ['Cedar'],
      entityRefs: [],
      evidenceType: 'verified',
      confidence: 1,
    }
    boundary.dispatch('alice', 'A', 'direct', 'feishu', 'save', 'save-context', 'Save Cedar progress')
    const saved = await boundary.call({ action: 'remember', record }, 'save-context') as any
    boundary.dispatch('bob', 'C', 'direct', 'feishu', 'other', 'other-context')
    const other = await boundary.call(
      { action: 'remember', record: { ...record, summary: 'OTHER-PRIVATE' } },
      'other-context',
    ) as any
    boundary.dispatch('alice', 'B', 'group', 'feishu', 'recall', 'recall-context', '你记得自己最近都做了什么吗？')
    expect(await boundary.call({ action: 'guide', topic: 'recall' }, 'recall-context')).toMatchObject({
      result: { recallAccess: { administrator: true, ownRequestScope: 'recent-work', persistentGrantCreated: false } },
    })
    const hits = await boundary.call({ action: 'search-page', query: '' }, 'recall-context') as any
    expect(hits.result.cards.map((card: any) => card.id)).toEqual([saved.result.id])
    expect(JSON.stringify(hits)).not.toContain('OTHER-PRIVATE')
    expect(await boundary.call({ action: 'get', id: saved.result.id }, 'recall-context')).toMatchObject({
      result: { summary: 'Deployment verified: ADMIN-42' },
    })
    expect(await boundary.call({ action: 'get', id: other.result.id }, 'recall-context')).toMatchObject({
      code: 'MEMORY_NOT_FOUND',
    })
    expect(await boundary.call({ action: 'grant-list' }, 'recall-context')).toMatchObject({ result: [] })
    boundary.dispatch('bob', 'B', 'group', 'feishu', 'member-recall', 'member-context', '你记得自己最近都做了什么吗？')
    expect(await boundary.call({ action: 'get', id: saved.result.id }, 'member-context')).toMatchObject({
      code: 'MEMORY_NOT_FOUND',
    })
    boundary.dispatch('alice', 'B', 'group', 'feishu', 'new', 'new-context', '你好')
    expect(await boundary.call({ action: 'get', id: saved.result.id }, 'new-context')).toMatchObject({
      code: 'MEMORY_NOT_FOUND',
    })
    boundary.dispatch('alice', 'B', 'group', 'feishu', 'topic', 'topic-context', 'What is Cedar project progress?')
    expect(await boundary.call({ action: 'get', id: saved.result.id }, 'topic-context')).toMatchObject({ status: 'ok' })
    expect(await boundary.call({ action: 'get', id: saved.result.id, administrator: true }, 'topic-context'))
      .toMatchObject({ code: 'MEMORY_INVALID_REQUEST' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('the verified owner can find and update a record in its source group without a recall phrase', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-group-update-'))
  try {
    const boundary = mockMemoryBoundary(root)
    boundary.dispatch('alice', 'A', 'group', 'feishu', 'save', 'save-context', '青杉部署还有文档待完成')
    const record = {
      kind: 'fact',
      title: '青杉',
      summary: '部署进行中，文档待完成',
      tags: ['青杉'],
      entityRefs: [],
      evidenceType: 'explicit',
      confidence: 1,
    }
    const saved = await boundary.call({ action: 'remember', record }, 'save-context') as any
    boundary.dispatch('alice', 'A', 'group', 'feishu', 'progress', 'progress-context', '青杉部署已完成')
    expect(await boundary.call({ action: 'search-page', query: '青杉' }, 'progress-context')).toMatchObject({
      result: { cards: [{ id: saved.result.id, revision: 1 }] },
    })
    expect(await boundary.call({ action: 'get', id: saved.result.id }, 'progress-context')).toMatchObject({
      status: 'ok',
    })
    expect(
      await boundary.call({
        action: 'update',
        id: saved.result.id,
        revision: 1,
        record: { ...record, summary: '部署与文档已完成' },
      }, 'progress-context'),
    ).toMatchObject({ result: { revision: 2 } })
    for (
      const [actor, conversation, account] of [['bob', 'A', 'synthetic-bot'], ['alice', 'B', 'synthetic-bot'], [
        'alice',
        'A',
        'other-bot',
      ]]
    ) {
      boundary.dispatch(actor!, conversation!, 'group', 'feishu', 'denied', 'denied-context', '青杉部署已完成', account)
      expect(await boundary.call({ action: 'search-page', query: '青杉' }, 'denied-context')).toMatchObject({
        result: { cards: [] },
      })
      expect(await boundary.call({ action: 'get', id: saved.result.id }, 'denied-context')).toMatchObject({
        status: 'rejected',
      })
    }
    expect(await boundary.records()).toHaveLength(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
