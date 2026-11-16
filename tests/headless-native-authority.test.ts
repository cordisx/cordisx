import { describe, expect, it, vi } from 'vitest'

const execution = vi.hoisted(() => ({
  prepare: vi.fn(async (_method: string, params: unknown) => ({ params, captureId: 'capture' })),
  complete: vi.fn(async () => {}),
  observe: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
}))
vi.mock('../packages/cli/src/launcher/chat-execution-preferences.js', () => ({
  ChatExecutionPreferences: { open: async () => execution },
}))
import { createHeadlessNativeAuthority } from '../packages/cli/src/launcher/headless-native-authority.js'

const input = {
  homeDir: '/state',
  configPath: '/state/config.json',
  appId: 'codex',
  profileId: 'test',
  report: () => {},
}
describe('headless native authority', () => {
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
})
