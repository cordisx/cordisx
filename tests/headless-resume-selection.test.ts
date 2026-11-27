import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { headlessResumeSelection } from '../packages/cli/src/launcher/headless-resume-selection.js'
import type { ChatExecutionRecord } from '../packages/cli/src/launcher/chat-execution-preferences.js'

it('recovers only a matching applied selection for the exact bound or migrated thread', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-resume-selection-'))
  const selected = { providerId: 'fixture-provider', model: 'fixture-model' }
  const execution: ChatExecutionRecord = {
    hostId: 'local',
    threadId: 'thread',
    capturedDefaults: {},
    defaultsRevision: 0,
    revision: 3,
    appliedRevision: 3,
    application: 'applied',
    effective: { modelProvider: selected.providerId, model: selected.model },
  }
  const resolve = (record: ChatExecutionRecord | undefined = execution, threadId = 'thread') =>
    headlessResumeSelection({ profileDirectory: root, threadId, execution: record })
  const channel = (value: unknown) => writeFile(path.join(root, 'channel-conversations.json'), JSON.stringify(value))
  const migrations = (value: unknown) =>
    writeFile(path.join(root, 'history-provider-overrides.json'), JSON.stringify(value))
  try {
    expect(await resolve()).toEqual(selected)
    expect(await resolve({ ...execution, application: 'unknown' })).toBeUndefined()
    expect(await resolve({ ...execution, appliedRevision: 2 })).toBeUndefined()
    await migrations({
      schema: 'cordisx.history-provider-overrides/v1',
      entries: {
        thread: { status: 'applied', ...selected },
      },
    })
    expect(await resolve()).toEqual(selected)
    await migrations({
      schema: 'cordisx.history-provider-overrides/v1',
      entries: {
        thread: { status: 'applied', providerId: 'other', model: selected.model },
      },
    })
    await expect(resolve()).rejects.toThrow('RESUME_SELECTION_UNCONFIRMED')
    expect(await resolve({ ...execution, modelSelection: { status: 'confirmed', ...selected } })).toEqual(selected)
    await expect(resolve({ ...execution, modelSelection: { status: 'unknown' } }))
      .rejects.toThrow('RESUME_SELECTION_UNCONFIRMED')
    await migrations({
      schema: 'cordisx.history-provider-overrides/v1',
      entries: {
        thread: { status: 'unknown', ...selected },
      },
    })
    await expect(resolve()).rejects.toThrow('RESUME_SELECTION_UNCONFIRMED')
    await channel({ bindings: { active: { state: 'active', sessionId: 'thread' } } })
    expect(await resolve()).toBeUndefined()
    const explicit = { ...execution, modelSelection: { status: 'confirmed' as const, ...selected } }
    expect(await resolve(explicit)).toEqual(selected)
    expect(await resolve({ ...explicit, application: 'unknown' })).toBeUndefined()
    expect(await resolve({ ...explicit, effective: { modelProvider: 'other', model: selected.model } }))
      .toBeUndefined()
    await channel({
      bindings: { active: { state: 'active', sessionId: 'thread' } },
      taskRequests: { pending: { threadId: 'thread', state: 'queued' } },
    })
    await expect(resolve(explicit)).rejects.toThrow('RESUME_SELECTION_UNCONFIRMED')
    await channel({
      bindings: { active: { state: 'active', sessionId: 'thread' } },
      taskSettings: { thread: { application: 'applied', settings: selected } },
    })
    expect(await resolve()).toEqual(selected)
    expect(await resolve(execution, 'different-thread')).toBeUndefined()
    await expect(headlessResumeSelection({ profileDirectory: root, threadId: 'thread' }))
      .rejects.toThrow('RESUME_SELECTION_UNCONFIRMED')
    await channel({ taskSettings: { thread: { application: 'unknown', settings: selected } } })
    await expect(resolve()).rejects.toThrow('RESUME_SELECTION_UNCONFIRMED')
    await channel({ taskSettings: { thread: { application: 'applied', settings: selected, pending: selected } } })
    expect(await resolve()).toBeUndefined()
    await channel({ taskSettings: { thread: { application: 'applying', settings: selected, pendingPatch: selected } } })
    await expect(resolve()).rejects.toThrow('RESUME_SELECTION_UNCONFIRMED')
    await channel({ taskSettings: { thread: { application: 'applied', settings: { ...selected, model: 'other' } } } })
    await expect(resolve()).rejects.toThrow('RESUME_SELECTION_UNCONFIRMED')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
