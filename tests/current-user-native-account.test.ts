import { HttpNativeCallingContextUnavailableError } from '../packages/cli/src/launcher/plugin-http-native-account-diagnostics.js'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { readPinnedNativeAccount } from '../packages/cli/src/current-user-native-account.js'
import {
  HTTP_NATIVE_ACCOUNT_EXPRESSION,
  HTTP_NATIVE_ACCOUNT_READ_TIMEOUT_MS,
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
    Symbol,
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
it('accepts a fresh typed ready result delayed three seconds and releases only its invocation', async () => {
  vi.useFakeTimers()
  expect(HTTP_NATIVE_ACCOUNT_READ_TIMEOUT_MS).toBe(5000)
  const dispose = vi.fn(), sharedDispose = vi.fn()
  const invocation = Object.assign(
    new Promise(resolve => setTimeout(() => resolve({ status: 'ready', data: pair }), 3000)),
    { [(Symbol as SymbolConstructor & { readonly dispose: symbol }).dispose]: dispose },
  )
  const f = expression({
    TW: {
      accessInputs: {
        readAccountInfo: () => invocation,
        [(Symbol as SymbolConstructor & { readonly dispose: symbol }).dispose]: sharedDispose,
      },
    },
  })
  await vi.advanceTimersByTimeAsync(2999)
  expect(dispose).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(await f.result).toBe(JSON.stringify([pair.accountId, pair.userId]))
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(sharedDispose).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
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
  await vi.advanceTimersByTimeAsync(HTTP_NATIVE_ACCOUNT_READ_TIMEOUT_MS)
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

const disposeSymbol = (Symbol as SymbolConstructor & { readonly dispose: symbol }).dispose
function disposableRead(value: unknown, reject = false) {
  const dispose = vi.fn()
  const invocation = Object.assign(reject ? Promise.reject(new Error('fixture-rpc-error')) : Promise.resolve(value), {
    [disposeSymbol]: dispose,
  })
  const readAccountInfo = vi.fn(() => invocation)
  const sharedDispose = vi.fn()
  return {
    module: { TW: { accessInputs: { readAccountInfo, [disposeSymbol]: sharedDispose } } },
    invocation,
    dispose,
    readAccountInfo,
    sharedDispose,
  }
}
it.each([
  [{ status: 'ready', data: pair }, false, JSON.stringify([pair.accountId, pair.userId])],
  [{ status: 'unavailable', reason: 'retired' }, false, { status: 'unavailable', reason: 'typed-retired' }],
  [{ status: 'error' }, false, { status: 'unavailable', reason: 'typed-read-error' }],
  [null, true, { status: 'unavailable', reason: 'typed-read-exception' }],
])('releases exactly the original typed invocation after completion %j', async (value, reject, expected) => {
  const f = disposableRead(value, reject as boolean)
  expect(await expression(f.module).result).toEqual(expected)
  expect(f.dispose).toHaveBeenCalledTimes(1)
  expect(f.dispose.mock.contexts[0]).toBe(f.invocation)
  expect(f.sharedDispose).not.toHaveBeenCalled()
})
it('releases a held RPC at the production timeout and never accepts its late ready result', async () => {
  vi.useFakeTimers()
  let resolve!: (value: unknown) => void
  const dispose = vi.fn(), sharedDispose = vi.fn()
  const invocation = Object.assign(
    new Promise(r => {
      resolve = r
    }),
    { [disposeSymbol]: dispose },
  )
  const f = expression({ TW: { accessInputs: { readAccountInfo: () => invocation, [disposeSymbol]: sharedDispose } } })
  await vi.advanceTimersByTimeAsync(HTTP_NATIVE_ACCOUNT_READ_TIMEOUT_MS)
  expect(await f.result).toEqual({ status: 'unavailable', reason: 'native-read-timeout' })
  expect(dispose).toHaveBeenCalledTimes(1)
  resolve({ status: 'ready', data: pair })
  await Promise.resolve()
  await Promise.resolve()
  expect(await f.result).toEqual({ status: 'unavailable', reason: 'native-read-timeout' })
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(sharedDispose).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
it('releases once when invocation creation synchronously aborts and never calls a pre-aborted input', async () => {
  const abort = new AbortController(), f = disposableRead({ status: 'ready', data: pair })
  f.module.TW.accessInputs.readAccountInfo.mockImplementation(() => {
    abort.abort()
    return f.invocation
  })
  await expect(readPinnedNativeAccount('8881', f.module, abort.signal)).rejects.toThrow()
  expect(f.dispose).toHaveBeenCalledTimes(1)
  const before = f.readAccountInfo.mock.calls.length
  await expect(readPinnedNativeAccount('8881', f.module, abort.signal)).rejects.toThrow()
  expect(f.readAccountInfo).toHaveBeenCalledTimes(before)
  expect(f.sharedDispose).not.toHaveBeenCalled()
})
it('aborting one concurrent read releases only its invocation and keeps the sibling and shared input usable', async () => {
  const a = new AbortController(), b = new AbortController()
  let finishA!: (value: unknown) => void, finishB!: (value: unknown) => void
  const releaseA = vi.fn(), releaseB = vi.fn(), sharedDispose = vi.fn()
  const pendingA = Object.assign(
    new Promise(r => {
      finishA = r
    }),
    { [disposeSymbol]: releaseA },
  )
  const pendingB = Object.assign(
    new Promise(r => {
      finishB = r
    }),
    { [disposeSymbol]: releaseB },
  )
  const readAccountInfo = vi.fn().mockReturnValueOnce(pendingA).mockReturnValueOnce(pendingB)
  const module = { TW: { accessInputs: { readAccountInfo, [disposeSymbol]: sharedDispose } } }
  const first = readPinnedNativeAccount('8881', module, a.signal)
  const second = readPinnedNativeAccount('8881', module, b.signal)
  a.abort()
  await expect(first).rejects.toThrow()
  expect(releaseA).toHaveBeenCalledTimes(1)
  expect(releaseB).not.toHaveBeenCalled()
  finishB({ status: 'ready', data: pair })
  expect(await second).toEqual(pair)
  finishA({ status: 'ready', data: pair })
  await Promise.resolve()
  expect(releaseA).toHaveBeenCalledTimes(1)
  expect(releaseB).toHaveBeenCalledTimes(1)
  expect(sharedDispose).not.toHaveBeenCalled()
})
