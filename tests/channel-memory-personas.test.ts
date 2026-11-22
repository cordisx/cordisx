import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { expect, it } from 'vitest'
import { ChannelMemoryPersonas } from '../packages/cli/src/launcher/channel-memory-personas.js'

it('one persona spans bot accounts; rebind pins old tasks and separates spaces', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-personas-'))
  try {
    const registry = new ChannelMemoryPersonas(root)
    const feishu = { adapterId: 'feishu', accountId: 'bot-one', tenantId: 'tenant' }
    const telegram = { adapterId: 'telegram', accountId: 'bot-two', tenantId: 'tenant' }
    await registry.profile('atlas', 'Atlas', 'Continuous careful assistant', 0)
    await registry.profile('nova', 'Nova', 'Separate continuous assistant', 0)
    await registry.bind(feishu, 'atlas', 0)
    await registry.bind(telegram, 'atlas', 0)
    expect((await registry.resolveTask('first', feishu)).personaId).toBe('atlas')
    const capsule = await registry.bootstrap('first', feishu)
    expect(capsule).toMatchObject({ personaId: 'atlas', revision: 1, bindingRevision: 1, name: 'Atlas' })
    expect(Buffer.byteLength(JSON.stringify(capsule))).toBeLessThanOrEqual(2048)
    await registry.profile('atlas', 'Atlas updated', 'Continuous careful assistant', 1)
    expect((await registry.bootstrap('first', feishu)).revision).toBe(2)
    expect((await new ChannelMemoryPersonas(root).bootstrap('first', feishu)).name).toBe('Atlas updated')
    expect((await registry.resolveTask('second', telegram)).personaId).toBe('atlas')
    const first = await registry.memoryForTask('first', feishu)
    const second = await registry.memoryForTask('second', telegram)
    expect(first.files.root).toBe(second.files.root)
    const authority = {
      actor: { ...feishu, userId: 'alice' },
      conversation: { ...feishu, conversationId: 'A' },
      kind: 'direct' as const,
    }
    const record = await first.remember(authority, {
      kind: 'fact',
      title: 'Synthetic continuity',
      summary: 'ATLAS-41',
      tags: [],
      entityRefs: [],
      evidenceType: 'explicit',
      confidence: 1,
    }, 'synthetic')
    expect((await second.get(authority, record.id)).summary).toBe('ATLAS-41')
    await expect(second.get({ ...authority, actor: { ...telegram, userId: 'alice' } }, record.id)).rejects.toThrow(
      'MEMORY_NOT_FOUND',
    )
    await registry.bind(feishu, 'nova', 1)
    expect(await registry.resolveTask('first', feishu)).toMatchObject({ personaId: 'atlas', bindingRevision: 1 })
    expect((await registry.bootstrap('first', feishu)).personaId).toBe('atlas')
    expect(await registry.resolveTask('new-task', feishu)).toMatchObject({ personaId: 'nova', bindingRevision: 2 })
    const isolated = await registry.memoryForTask('new-task', feishu)
    await expect(isolated.get(authority, record.id)).rejects.toThrow('MEMORY_NOT_FOUND')
    await expect(registry.bind(feishu, 'atlas', 1)).rejects.toThrow('PERSONA_REVISION_CONFLICT')
    await expect(registry.resolveTask('unbound', { ...feishu, accountId: 'other' })).rejects.toThrow(
      'PERSONA_ACCOUNT_UNBOUND',
    )
    await expect(registry.resolveTask('first', telegram)).rejects.toThrow('PERSONA_TASK_ACCOUNT_MISMATCH')
    await expect(registry.profile('../escape', 'Bad', 'Bad', 0)).rejects.toThrow('PERSONA_INVALID_ID')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
