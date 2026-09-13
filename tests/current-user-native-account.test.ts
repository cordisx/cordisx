import { HttpNativeCallingContextUnavailableError } from '../packages/cli/src/launcher/plugin-http-native-account-diagnostics.js'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { readPinnedNativeAccount } from '../packages/cli/src/current-user-native-account.js'
import {
  HTTP_NATIVE_ACCOUNT_EXPRESSION,
  readNativeHttpAccount,
} from '../packages/cli/src/launcher/plugin-http-native-account.js'

afterEach(() => vi.useRealTimers())
const pair = { accountId: 'fixture-account', userId: 'fixture-user' }
const pin = { appVersion: '26.908.40834', buildNumber: '8881', buildFlavor: 'prod' }
function native(value: unknown) {
  const readAccountInfo = vi.fn(async () => value)
  const post = vi.fn(async () => ({ body: pair }))
  return { TW: { accessInputs: { readAccountInfo } }, gJt: { getInstance: () => ({ post }) }, post, readAccountInfo }
}
function expression(module: unknown, metadata: unknown = pin, url = 'app://-/index.html') {
  // Replace only the ESM loader boundary; execute the complete production
  // context/pin/timeout/account projection, including its serialized reader.
  const source = HTTP_NATIVE_ACCOUNT_EXPRESSION.replace(
    'await import(adapter.module)',
    'await __loadNative(adapter.module)',
  )
  expect(source).not.toBe(HTTP_NATIVE_ACCOUNT_EXPRESSION)
  const load = vi.fn(async () => module)
  const result = runInNewContext(source, {
    AbortController,
    setTimeout,
    clearTimeout,
    location: { href: url },
    codexWindowType: 'electron',
    electronBridge: { getSentryInitOptions: () => metadata },
    __loadNative: load,
  }) as Promise<unknown>
  return { result, load }
}
it('executes the 8881 production expression through typed ready input without legacy POST', async () => {
  const module = native({ status: 'ready', data: { ...pair, token: 'fixture-private-extra' } })
  const f = expression(module)
  expect(await f.result).toBe(JSON.stringify([pair.accountId, pair.userId]))
  expect(f.load).toHaveBeenCalledWith('app://-/assets/app-initial-9b95fa538c62.js')
  expect(module.readAccountInfo).toHaveBeenCalledTimes(1)
  expect(module.post).not.toHaveBeenCalled()
})
it.each([
  { status: 'unavailable', reason: 'identity' },
  { status: 'error', message: 'fixture-private-error' },
  { status: 'ready', data: { accountId: '', userId: pair.userId } },
  { status: 'ready', data: { accountId: pair.accountId } },
  { status: 'loading', data: pair },
  null,
])('fails closed for typed input %j without legacy fallback', async value => {
  const module = native(value)
  expect(await expression(module).result).toMatchObject({ status: 'unavailable' })
  expect(module.post).not.toHaveBeenCalled()
})
it('rejects missing typed exports, thrown RPC, unknown pins and non-primary contexts', async () => {
  const old = native({ status: 'ready', data: pair })
  expect(await expression({ gJt: old.gJt }).result).toMatchObject({ status: 'unavailable' })
  const failed = native({ status: 'ready', data: pair })
  failed.readAccountInfo.mockRejectedValue(new Error('fixture-private-error'))
  expect(await expression(failed).result).toMatchObject({ status: 'unavailable' })
  for (
    const [metadata, url] of [[{ ...pin, buildFlavor: 'dev' }, 'app://-/index.html'], [
      pin,
      'app://-/other.html',
    ]] as const
  ) {
    const f = expression(old, metadata, url)
    expect(await f.result).toMatchObject({ status: 'unavailable' })
    expect(f.load).not.toHaveBeenCalled()
  }
  expect(old.post).not.toHaveBeenCalled()
})
it('bounds typed RPC observation and discards late ready completion', async () => {
  vi.useFakeTimers()
  let resolve!: (value: unknown) => void
  const readAccountInfo = () =>
    new Promise(r => {
      resolve = r
    })
  const f = expression({ TW: { accessInputs: { readAccountInfo } } })
  await vi.advanceTimersByTimeAsync(2000)
  expect(await f.result).toMatchObject({ status: 'unavailable' })
  resolve({ status: 'ready', data: pair })
  expect(await f.result).toMatchObject({ status: 'unavailable' })
  expect(vi.getTimerCount()).toBe(0)
})
it('retains the independently pinned 8378 legacy reader and caller abort', async () => {
  const module = native({ status: 'ready', data: pair }), signal = new AbortController().signal
  expect(await readPinnedNativeAccount('8378', module, signal)).toEqual(pair)
  expect(module.post).toHaveBeenCalledWith('vscode://codex/account-info', undefined, undefined, signal)
  expect(module.readAccountInfo).not.toHaveBeenCalled()
  const abort = new AbortController()
  abort.abort()
  await expect(readPinnedNativeAccount('8881', module, abort.signal)).rejects.toThrow()
  expect(module.readAccountInfo).not.toHaveBeenCalled()
})

it.each(
  [
    ['reader-closed', undefined, undefined, false],
    ['context-missing', undefined, undefined, true],
    ['context-unavailable', new Error('CDP -32000: Cannot find context with specified id'), undefined, true],
    ['reader-closed', new Error('CDP connection closed'), undefined, true],
    ['cdp-read-timeout', new Error('CDP request timed out: Runtime.evaluate'), undefined, true],
    ['cdp-read-exception', new Error('fixture-private-error-payload'), undefined, true],
    [
      'native-evaluation-exception',
      undefined,
      { exceptionDetails: { private: 'fixture-private-error-payload' } },
      true,
    ],
    ['typed-identity', undefined, { result: { value: { status: 'unavailable', reason: 'typed-identity' } } }, true],
    ['native-result-invalid', undefined, {
      result: { value: { status: 'unavailable', reason: 'fixture-private-error-payload' } },
    }, true],
  ] as const,
)('keeps %s failclosed and reports only its bounded phase', async (reason, error, response, active) => {
  const seen: string[] = []
  const send = vi.fn(async () => {
    if (error) throw error
    return response ?? {}
  })
  const result = await readNativeHttpAccount(
    { send },
    reason === 'context-missing' ? undefined : 17,
    () => active,
    phase => {
      seen.push(phase)
      throw new Error('fixture-diagnostic-failure')
    },
  )
  if (reason === 'reader-closed' || reason === 'context-missing' || reason === 'context-unavailable') {
    expect(result).toBeInstanceOf(HttpNativeCallingContextUnavailableError)
    expect(result).toMatchObject({ reason })
  } else expect(result).toBeNull()
  expect(seen).toEqual([reason])
  expect(JSON.stringify(seen)).not.toContain('fixture-private-error-payload')
  if (reason === 'reader-closed' && !active || reason === 'context-missing') expect(send).not.toHaveBeenCalled()
})
it('rejects a completed account read after its calling bridge closed', async () => {
  let active = true
  const seen: string[] = []
  expect(
    await readNativeHttpAccount(
      {
        send: async () => {
          active = false
          return { result: { value: JSON.stringify([pair.accountId, pair.userId]) } }
        },
      },
      17,
      () => active,
      reason => seen.push(reason),
    ),
  ).toBeInstanceOf(HttpNativeCallingContextUnavailableError)
  expect(seen).toEqual(['reader-closed'])
})

it.each(
  [
    [{ status: 'unavailable', reason: 'retired' }, 'typed-retired'],
    [{ status: 'unavailable', reason: 'connection' }, 'typed-connection'],
    [{ status: 'unavailable', reason: 'identity' }, 'typed-identity'],
    [{ status: 'unavailable', reason: 'unsupported-auth' }, 'typed-unsupported-auth'],
    [{ status: 'error', message: 'fixture-private-error-payload' }, 'typed-read-error'],
    [{ status: 'loading' }, 'typed-not-ready'],
  ] as const,
)('projects typed unavailable phase %s without its private payload', async (value, reason) => {
  const module = native(value)
  expect(await expression(module).result).toEqual({ status: 'unavailable', reason })
  expect(module.post).not.toHaveBeenCalled()
})
