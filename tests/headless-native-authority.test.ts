import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const execution = vi.hoisted(() => ({
  prepare: vi.fn(async (_method: string, params: unknown) => ({ params, captureId: 'capture' })),
  complete: vi.fn(async () => {}),
  observe: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  read: vi.fn(() => undefined),
}))
vi.mock('../packages/cli/src/launcher/chat-execution-preferences.js', () => ({
  ChatExecutionPreferences: { open: async () => execution },
}))
import { createHeadlessNativeAuthority } from '../packages/cli/src/launcher/headless-native-authority.js'
import { HeadlessWorkMode } from '../packages/cli/src/launcher/headless-work-mode.js'

const input = {
  homeDir: '/state',
  configPath: '/state/config.json',
  appId: 'codex',
  profileId: 'test',
  report: () => {},
}
describe('headless native authority', () => {
  it('restores a confirmed selection on resume while preserving a later explicit choice', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cx-headless-resume-'))
    const record = {
      hostId: 'local',
      threadId: 'thread',
      revision: 1,
      appliedRevision: 1,
      application: 'applied',
      effective: { modelProvider: 'provider', model: 'model' },
    }
    execution.read.mockReturnValue(record as never)
    const native = await createHeadlessNativeAuthority({ ...input, homeDir: root })
    const next = vi.fn(async () => ({ thread: { id: 'thread' } }))
    try {
      await native.authority.nativeRequest!('thread/resume', { threadId: 'thread' }, next)
      expect(next).toHaveBeenLastCalledWith({ threadId: 'thread', modelProvider: 'provider', model: 'model' })
      await native.authority.nativeRequest!('thread/resume', {
        threadId: 'thread',
        modelProvider: 'new-provider',
        model: 'new-model',
      }, next)
      expect(next).toHaveBeenLastCalledWith({
        threadId: 'thread',
        modelProvider: 'new-provider',
        model: 'new-model',
      })
      execution.read.mockReturnValue({ ...record, application: 'unknown' } as never)
      await native.authority.nativeRequest!('thread/resume', { threadId: 'thread' }, next)
      expect(next).toHaveBeenLastCalledWith({ threadId: 'thread' })
    } finally {
      execution.read.mockReturnValue(undefined)
      await native.close()
      await rm(root, { recursive: true, force: true })
    }
  })
  it('does not infer a mode when two writes overlap, even if a notification agrees', () => {
    const evidence = new HeadlessWorkMode(false)
    const first = evidence.begin('thread'), second = evidence.begin('thread')
    evidence.observe('thread', 'default')
    first(true, 'default', false)
    second(true, 'default', false)
    expect(evidence.get('thread')).toBeUndefined()
  })
  it('requires the actual native request id and delegates exact approval to shared chat control', async () => {
    const native = await createHeadlessNativeAuthority(input)
    const events: Record<string, unknown>[] = []
    native.authority.subscribeApprovals!(event => events.push(event))
    const params = { threadId: 'thread', turnId: 'turn', itemId: 'item' }
    expect(() => native.authority.request('item/commandExecution/requestApproval', params)).toThrow('ID_UNAVAILABLE')
    const response = native.authority.request('item/commandExecution/requestApproval', params, 41)
    await vi.waitFor(() => expect(events).toHaveLength(1))
    const result = native.authority.respondApproval!({
      reference: events[0]!.reference,
      requestId: 41,
      ...params,
      decision: 'accept',
    })
    await expect(result).rejects.toThrow('HEADLESS_APPROVAL_WRITE_UNCONFIRMED')
    expect(await response).toEqual({ decision: 'accept' })
    expect(
      await native.authority.respondApproval!({
        reference: events[0]!.reference,
        requestId: 41,
        ...params,
        decision: 'accept',
      }),
    ).toEqual({ status: 'expired' })
    await native.close()
  })
  it('applies the existing execution store around the actual native request', async () => {
    const native = await createHeadlessNativeAuthority(input)
    const next = vi.fn(async () => ({ thread: { id: 'thread' } }))
    await native.authority.nativeRequest!('thread/start', { cwd: '/work' }, next)
    expect(execution.prepare).toHaveBeenCalledWith('thread/start', { cwd: '/work' })
    expect(execution.complete).toHaveBeenCalledWith('capture', true, { thread: { id: 'thread' } })
    await native.close()
  })
  it('tracks only proven owned modes and invalidates uncertain or stale changes', async () => {
    const native = await createHeadlessNativeAuthority({ ...input, knownNewThreadDefault: true })
    const request = native.authority.nativeRequest!
    const mode = native.authority.confirmedWorkMode!
    await request('thread/start', {}, async () => ({ thread: { id: 'owned' } }))
    expect(mode('owned')).toBe('default')
    expect(mode('external')).toBeUndefined()
    await request('turn/start', { threadId: 'owned', collaborationMode: { mode: 'plan' } }, async () => ({}))
    expect(mode('owned')).toBe('plan')
    await expect(request('turn/start', { threadId: 'owned' }, async () => {
      throw new Error('failed')
    }))
      .rejects.toThrow('failed')
    expect(mode('owned')).toBeUndefined()
    native.authority.notification!('thread/settings/updated', {
      threadId: 'owned',
      threadSettings: { collaborationMode: { mode: 'default' } },
    })
    expect(mode('owned')).toBe('default')
    let finish!: () => void
    const pending = request(
      'turn/start',
      { threadId: 'owned', collaborationMode: { mode: 'plan' } },
      () =>
        new Promise(resolve => {
          finish = () => resolve({})
        }),
    )
    await vi.waitFor(() => expect(finish).toBeDefined())
    expect(mode('owned')).toBeUndefined()
    native.authority.notification!('thread/settings/updated', {
      threadId: 'owned',
      threadSettings: { collaborationMode: { mode: 'default' } },
    })
    finish()
    await pending
    expect(mode('owned')).toBeUndefined()
    native.authority.notification!('thread/settings/updated', {
      threadId: 'owned',
      threadSettings: { collaborationMode: { mode: 'default' } },
    })
    expect(mode('owned')).toBe('default')
    await request('thread/resume', { threadId: 'owned' }, async () => ({}))
    expect(mode('owned')).toBeUndefined()
    native.authority.notification!('thread/closed', { threadId: 'owned' })
    expect(mode('owned')).toBeUndefined()
    await native.close()
    const unknownVersion = await createHeadlessNativeAuthority(input)
    await unknownVersion.authority.nativeRequest!('thread/start', {}, async () => ({ thread: { id: 'thread' } }))
    expect(unknownVersion.authority.confirmedWorkMode!('thread')).toBeUndefined()
    let finishDefault!: () => void
    const changingDefault = unknownVersion.authority.nativeRequest!(
      'turn/start',
      { threadId: 'thread', collaborationMode: { mode: 'default' } },
      () =>
        new Promise(resolve => {
          finishDefault = () => resolve({})
        }),
    )
    await vi.waitFor(() => expect(finishDefault).toBeDefined())
    unknownVersion.authority.notification!('thread/settings/updated', {
      threadId: 'thread',
      threadSettings: { collaborationMode: { mode: 'default' } },
    })
    finishDefault()
    await changingDefault
    expect(unknownVersion.authority.confirmedWorkMode!('thread')).toBe('default')
    await unknownVersion.authority.nativeRequest!('thread/resume', { threadId: 'thread' }, async () => ({}))
    expect(unknownVersion.authority.confirmedWorkMode!('thread')).toBeUndefined()
    await unknownVersion.authority.nativeRequest!(
      'turn/start',
      { threadId: 'thread', collaborationMode: { mode: 'default' } },
      async () => ({}),
    )
    expect(unknownVersion.authority.confirmedWorkMode!('thread')).toBe('default')
    await unknownVersion.authority.nativeRequest!('thread/resume', { threadId: 'thread' }, async () => ({}))
    expect(unknownVersion.authority.confirmedWorkMode!('thread')).toBeUndefined()
    await unknownVersion.close()
  })
})
