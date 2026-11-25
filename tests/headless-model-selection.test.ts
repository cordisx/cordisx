import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { ChatExecutionPreferences } from '../packages/cli/src/launcher/chat-execution-preferences.js'
import { headlessModelSelection } from '../packages/cli/src/launcher/headless-model-selection.js'

it('persists uncertainty before native selection and serializes later choices for the same thread', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-model-selection-'))
  const configPath = path.join(root, 'config.json'), file = path.join(root, 'execution.json')
  await ensureHomeConfig(configPath)
  const execution = await ChatExecutionPreferences.open({ file, configPath, appId: 'codex', profileId: 'default' })
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const order: string[] = []
  const backend = async (_operation: string, value: unknown, beforeEffect?: () => Promise<boolean>) => {
    if (beforeEffect && !await beforeEffect()) return { status: 'rejected', reason: 'selection-changed' }
    const model = (value as { model: string }).model
    expect(execution.read('local', 'thread')?.modelSelection).toEqual({ status: 'unknown' })
    order.push(model)
    if (model === 'first') await gate
    if (model === 'rejected') return { status: 'rejected' }
    if (model === 'uncertain') return { status: 'reconciliation-required' }
    return { status: 'selected' }
  }
  const select = headlessModelSelection(backend, () => execution)
  const request = (model: string) => select('select', { threadId: 'thread', providerId: 'provider', model })
  try {
    await execution.recordModelSelection('thread', { providerId: 'provider', model: 'old' })
    expect(await select('select', { threadId: 'thread', providerId: 'provider', model: 'blocked' }, async () => false))
      .toEqual({ status: 'rejected', reason: 'selection-changed' })
    expect(execution.read('local', 'thread')?.modelSelection)
      .toEqual({ status: 'confirmed', providerId: 'provider', model: 'old' })
    const first = select('select', { threadId: 'thread', providerId: 'provider', model: 'first' }, async () => {
      expect(execution.read('local', 'thread')?.modelSelection)
        .toEqual({ status: 'confirmed', providerId: 'provider', model: 'old' })
      return true
    })
    const second = request('second')
    await vi.waitFor(() => expect(order).toEqual(['first']))
    release()
    expect(await first).toEqual({ status: 'selected' })
    expect(await second).toEqual({ status: 'selected' })
    expect(execution.read('local', 'thread')?.modelSelection)
      .toEqual({ status: 'confirmed', providerId: 'provider', model: 'second' })
    expect(await request('rejected')).toEqual({ status: 'rejected' })
    expect(execution.read('local', 'thread')?.modelSelection)
      .toEqual({ status: 'confirmed', providerId: 'provider', model: 'second' })
    expect(await request('uncertain')).toEqual({ status: 'reconciliation-required' })
    const reopened = await ChatExecutionPreferences.open({ file, configPath, appId: 'codex', profileId: 'default' })
    try {
      expect(reopened.read('local', 'thread')?.modelSelection).toEqual({ status: 'unknown' })
    } finally {
      await reopened.close()
    }
  } finally {
    release()
    await execution.close()
    await rm(root, { recursive: true, force: true })
  }
})
