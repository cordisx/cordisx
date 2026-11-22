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
