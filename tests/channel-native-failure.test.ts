import { describe, expect, it, vi } from 'vitest'
import { channelNativeFailureCode } from '../packages/cli/src/launcher/channel-native-failure.js'
import { ChannelNativeSessions } from '../packages/cli/src/launcher/channel-native-sessions.js'
import { a, channel, fixture, message, settle } from './helpers/channel-conversation-fixture.js'

const failed = (info: unknown) => ({
  status: 'failed',
  error: { codexErrorInfo: info, message: 'PRIVATE_MESSAGE', additionalDetails: 'PRIVATE_DETAIL' },
})

describe('Channel native failure categories', () => {
  it.each([
    ['unauthorized', 'NATIVE_MODEL_AUTH_FAILED'],
    ['usageLimitExceeded', 'NATIVE_MODEL_RATE_LIMITED'],
    ['serverOverloaded', 'NATIVE_MODEL_SERVICE_UNAVAILABLE'],
    [{ httpConnectionFailed: { httpStatusCode: 401 } }, 'NATIVE_MODEL_AUTH_FAILED'],
    [{ responseStreamConnectionFailed: { httpStatusCode: 403 } }, 'NATIVE_MODEL_AUTH_FAILED'],
    [{ responseStreamDisconnected: { httpStatusCode: null } }, 'NATIVE_MODEL_CONNECTION_FAILED'],
    [{ responseTooManyFailedAttempts: { httpStatusCode: 429 } }, 'NATIVE_MODEL_RATE_LIMITED'],
    [{ httpConnectionFailed: { httpStatusCode: 408 } }, 'NATIVE_MODEL_CONNECTION_FAILED'],
    [{ httpConnectionFailed: { httpStatusCode: 503 } }, 'NATIVE_MODEL_SERVICE_UNAVAILABLE'],
  ])('classifies only the structured native variant %#', (info, code) => {
    expect(channelNativeFailureCode(failed(info))).toBe(code)
  })
  it.each([
    failed(null),
    failed('other'),
    failed({ httpConnectionFailed: { httpStatusCode: 400 } }),
    failed({ httpConnectionFailed: { httpStatusCode: '401' } }),
    failed({ httpConnectionFailed: { httpStatusCode: 401, secret: 'PRIVATE' } }),
    failed({ httpConnectionFailed: { httpStatusCode: 401 }, responseStreamDisconnected: { httpStatusCode: null } }),
    { ...failed('unauthorized'), status: 'inProgress' },
    { ...failed('unauthorized'), status: 'interrupted' },
    { status: 'failed', error: { message: '401 unauthorized PRIVATE_MESSAGE' } },
  ])('keeps ambiguous or nonfailed evidence generic %#', value => {
    expect(channelNativeFailureCode(value)).toBe('NATIVE_TURN_FAILED')
  })
  it('uses the exact terminal native turn result and does not classify a running tool wait', async () => {
    let turn: Record<string, unknown> = { id: 'turn', status: 'inProgress', error: failed('unauthorized').error }
    const nativeRequest = vi.fn(async () => ({ data: [turn] }))
    const native = new ChannelNativeSessions({ bridge: () => undefined, cwd: '/tmp', nativeRequest })
    expect(await native.completion('session', 'turn')).toEqual({ state: 'running' })
    turn = { id: 'turn', ...failed({ responseStreamConnectionFailed: { httpStatusCode: 401 } }) }
    expect(await native.completion('session', 'turn')).toEqual({ state: 'failed', code: 'NATIVE_MODEL_AUTH_FAILED' })
    expect(nativeRequest.mock.calls.every(([method]) => method === 'thread/turns/list')).toBe(true)
  })
  it('sends a fixed category once to the original authorized session, never the raw error', async () => {
    const f = await fixture()
    await f.consumer.policySet({ enabled: true, autoReply: false, replyMode: 'none' }, 0)
    await f.consumer.bind({ channel: channel(), mode: 'deliver', autoReply: false }, a)
    const native = new ChannelNativeSessions({
      bridge: () => undefined,
      cwd: '/tmp',
      nativeRequest: async () => ({ data: [{ id: 'turn-1', ...failed('unauthorized') }] }),
    })
    f.native.completion.mockImplementation(native.completion.bind(native) as never)
    await f.consumer.receive('inbox:native-auth', message('om_native_auth'))
    await settle(f.consumer)
    await settle(f.consumer)
    expect(f.native.start).toHaveBeenCalledOnce()
    expect(f.runtime.notifyOnce).toHaveBeenCalledOnce()
    const value = f.runtime.notifyOnce.mock.calls[0]![0]
    expect(value).toMatchObject({
      text: '模型服务认证或访问被拒绝，请联系管理员。',
      target: { ...channel(), threadId: 'om_native_auth', semantics: 'reply-chain' },
    })
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE_MESSAGE|PRIVATE_DETAIL/)
  })
})
