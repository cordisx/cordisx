import { runInNewContext } from 'node:vm'
import { nativeAccountResource } from './fixtures/native-account-resource.js'
import { afterEach, expect, it, vi } from 'vitest'
import { readPinnedNativeAccount } from '../packages/cli/src/current-user-native-account.js'
import { HTTP_NATIVE_ACCOUNT_EXPRESSION } from '../packages/cli/src/launcher/plugin-http-native-account.js'

afterEach(() => vi.useRealTimers())

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}
const account = { accountId: 'fixture-account', userId: 'fixture-user' }
type Account = typeof account
type Result = { status: 'ready'; data: Account } | { status: 'unavailable'; reason: 'retired' | 'connection' }

// Dependency model of build 8881's typed input, not an execution of Native.
// Preserve the observed ordering: before context -> staleTime=5000 fetchQuery
// -> awaited after context -> generation/context and cache-reference checks.
// structuralSharing=false keeps a same-identity refetch's new object reference.
// Scope: normal reads with a stable initial context; no force invalidation or
// Native timeout model. Switch/exit controls cover the final generation fence.
function typedInput() {
  let now = 0, generation = 0, connected = true, identity = account
  let cached = { data: { ...account }, updatedAt: 0 }
  let pending: Promise<Account> | undefined, fetchGate: ReturnType<typeof deferred<void>> | undefined
  let reads = 0, fetches = 0
  const queries = new Map<number, ReturnType<typeof deferred<void>>>()
  const posts = new Map<number, ReturnType<typeof deferred<void>>>()
  const arrivals = new Map<number, ReturnType<typeof deferred<void>>>()
  const fetched = new Map<number, Account>()
  function query() {
    if (now - cached.updatedAt < 5000) return Promise.resolve(cached.data)
    if (pending) return pending
    fetches++
    const fetchedIdentity = { ...identity }
    pending = (async () => {
      await fetchGate?.promise
      cached = { data: fetchedIdentity, updatedAt: now }
      return cached.data
    })().finally(() => {
      pending = undefined
    })
    return pending
  }
  async function readAccountInfo(): Promise<Result> {
    const id = ++reads, startedGeneration = generation
    const reached = deferred<void>()
    queries.set(id, reached)
    if (!connected) return { status: 'unavailable', reason: 'connection' }
    const before = await Promise.resolve({ ...identity })
    if (!connected || startedGeneration !== generation) return { status: 'unavailable', reason: 'retired' }
    const fetching = query()
    reached.resolve()
    const data = await fetching
    fetched.set(id, data)
    arrivals.get(id)?.resolve()
    await posts.get(id)?.promise
    const after = await Promise.resolve({ ...identity })
    if (
      !connected || startedGeneration !== generation
      || before.accountId !== after.accountId || before.userId !== after.userId
      || cached.data !== data
    ) return { status: 'unavailable', reason: 'retired' }
    return { status: 'ready', data }
  }
  return {
    module: { TW: { accessInputs: { readAccountInfo } } },
    readAccountInfo,
    at: (time: number) => {
      now = time
    },
    holdPost(id: number) {
      const gate = deferred<void>(), arrived = deferred<void>()
      posts.set(id, gate)
      arrivals.set(id, arrived)
      return { arrived: arrived.promise, release: () => gate.resolve() }
    },
    holdFetch() {
      fetchGate = deferred<void>()
      return () => fetchGate?.resolve()
    },
    queried: (id: number) => queries.get(id)!.promise,
    switchAccount() {
      generation++
      identity = { accountId: 'fixture-next-account', userId: 'fixture-next-user' }
      cached = { data: { ...identity }, updatedAt: now }
    },
    exit: () => {
      generation++
      connected = false
    },
    counts: () => ({ reads, fetches }),
    cachedData: () => cached.data,
    fetchedData: (id: number) => fetched.get(id),
  }
}

it('reproduces same-identity reference retirement across 5s in three concurrent normal reads', async () => {
  const f = typedInput(), held = f.holdPost(1), releaseFetch = f.holdFetch()
  f.at(4990)
  const original = f.cachedData()
  const a = f.readAccountInfo()
  await held.arrived
  expect(f.fetchedData(1)).toBe(original)
  f.at(5010)
  const b = f.readAccountInfo(), c = f.readAccountInfo()
  await Promise.all([f.queried(2), f.queried(3)])
  expect(f.counts()).toEqual({ reads: 3, fetches: 1 })
  releaseFetch()
  const [second, third] = await Promise.all([b, c])
  expect(second).toEqual({ status: 'ready', data: account })
  expect(f.cachedData()).toEqual(original)
  expect(f.cachedData()).not.toBe(original)
  expect(third).toEqual(second)
  if (second.status === 'ready' && third.status === 'ready') expect(second.data).toBe(third.data)
  f.at(5050)
  held.release()
  expect(await a).toEqual({ status: 'unavailable', reason: 'retired' })
})

it('maps the modeled near-expiry retirement through the current Host reader', async () => {
  const f = typedInput(), held = f.holdPost(1)
  f.at(4990)
  const a = readPinnedNativeAccount('8881', f.module, new AbortController().signal)
  const outcome = a.catch(error => error)
  await held.arrived
  f.at(5010)
  expect(await readPinnedNativeAccount('8881', f.module, new AbortController().signal)).toEqual(account)
  f.at(5050)
  held.release()
  expect(await outcome).toMatchObject({ nativeAccountReason: 'typed-retired' })
  expect(f.counts()).toEqual({ reads: 2, fetches: 1 })
})

it('returns typed-retired through the complete HTTP expression after 60ms with its 2s timer still live', async () => {
  vi.useFakeTimers()
  const f = typedInput(), held = f.holdPost(1)
  const source = HTTP_NATIVE_ACCOUNT_EXPRESSION.replace('url=>import(url)', 'url=>__loadNative()')
  expect(source).not.toBe(HTTP_NATIVE_ACCOUNT_EXPRESSION)
  const evaluate = () =>
    runInNewContext(source, {
      ...nativeAccountResource,
      AbortController,
      Symbol,
      setTimeout,
      clearTimeout,
      location: { href: 'app://-/index.html' },
      codexWindowType: 'electron',
      electronBridge: {
        getSentryInitOptions: () => ({
          appVersion: '26.908.40834',
          buildNumber: '8881',
          buildFlavor: 'prod',
        }),
      },
      __loadNative: async () => f.module,
    }) as Promise<unknown>
  f.at(4990)
  const a = evaluate()
  await held.arrived
  await vi.advanceTimersByTimeAsync(20)
  f.at(5010)
  expect(await evaluate()).toBe(JSON.stringify([account.accountId, account.userId]))
  await vi.advanceTimersByTimeAsync(40)
  f.at(5050)
  expect(vi.getTimerCount()).toBe(1)
  held.release()
  expect(await a).toMatchObject({ status: 'unavailable', reason: 'typed-retired' })
  expect(vi.getTimerCount()).toBe(0)
})

it('does not retire ordinary concurrent reads while their shared cache remains fresh', async () => {
  const f = typedInput(), held = f.holdPost(1)
  f.at(100)
  const original = f.cachedData()
  const a = f.readAccountInfo()
  await held.arrived
  expect(await f.readAccountInfo()).toEqual({ status: 'ready', data: account })
  expect(f.fetchedData(2)).toBe(original)
  held.release()
  expect(await a).toEqual({ status: 'ready', data: account })
  expect(f.counts()).toEqual({ reads: 2, fetches: 0 })
})

it('serializing complete modeled reads avoids this race and still starts each fresh checkpoint', async () => {
  const f = typedInput(), held = f.holdPost(1)
  // Mechanism experiment only: this local queue is not a production proposal.
  let tail: Promise<unknown> = Promise.resolve()
  const read = () => {
    const result = tail.then(() => f.readAccountInfo())
    tail = result.catch(() => {})
    return result
  }
  f.at(4990)
  const a = read()
  await held.arrived
  f.at(5010)
  const b = read(), c = read()
  expect(f.counts().reads).toBe(1)
  held.release()
  expect(await a).toEqual({ status: 'ready', data: account })
  expect(await b).toEqual({ status: 'ready', data: account })
  expect(await c).toEqual({ status: 'ready', data: account })
  expect(f.counts()).toEqual({ reads: 3, fetches: 1 })
})

it('a caller outside a local queue can still replace the shared Native cache reference', async () => {
  const f = typedInput(), held = f.holdPost(1)
  let tail: Promise<unknown> = Promise.resolve()
  const queued = () => {
    const result = tail.then(() => f.readAccountInfo())
    tail = result.catch(() => {})
    return result
  }
  f.at(4990)
  const a = queued()
  await held.arrived
  f.at(5010)
  const b = queued()
  expect(f.counts().reads).toBe(1)
  expect(await f.readAccountInfo()).toEqual({ status: 'ready', data: account })
  held.release()
  expect(await a).toEqual({ status: 'unavailable', reason: 'retired' })
  expect(await b).toEqual({ status: 'ready', data: account })
})

it('local abort and invocation disposal need not acknowledge completion of the underlying typed read', async () => {
  const f = typedInput(), held = f.holdPost(1), abort = new AbortController()
  const dispose = (Symbol as SymbolConstructor & { readonly dispose?: symbol }).dispose
  if (dispose === undefined) throw new Error('fixture requires the supported RPC disposal symbol')
  let releases = 0, underlying!: Promise<Result>
  // Model the completion gap explicitly. This fixture does not claim to prove
  // Native's private RPC implementation; the caller has no completion ack.
  const module = {
    TW: {
      accessInputs: {
        readAccountInfo() {
          underlying = f.readAccountInfo()
          Object.defineProperty(underlying, dispose, {
            value: () => {
              releases++
            },
          })
          return underlying
        },
      },
    },
  }
  f.at(4990)
  const observation = readPinnedNativeAccount('8881', module, abort.signal).catch(error => error)
  await held.arrived
  abort.abort()
  expect(await observation).toBeInstanceOf(Error)
  expect(releases).toBe(1)
  f.at(5010)
  expect(await f.readAccountInfo()).toEqual({ status: 'ready', data: account })
  held.release()
  expect(await underlying).toEqual({ status: 'unavailable', reason: 'retired' })
  expect(releases).toBe(1)
})

it.each(['switch', 'exit'] as const)(
  'preserves retirement on a real %s during the after-context wait',
  async action => {
    const f = typedInput(), held = f.holdPost(1)
    const a = readPinnedNativeAccount('8881', f.module, new AbortController().signal)
    const outcome = a.catch(error => error)
    await held.arrived
    if (action === 'switch') f.switchAccount()
    else f.exit()
    held.release()
    expect(await outcome).toMatchObject({ nativeAccountReason: 'typed-retired' })
    if (action === 'switch') {
      expect(await readPinnedNativeAccount('8881', f.module, new AbortController().signal)).toEqual({
        accountId: 'fixture-next-account',
        userId: 'fixture-next-user',
      })
    } else {
      await expect(readPinnedNativeAccount('8881', f.module, new AbortController().signal)).rejects.toMatchObject({
        nativeAccountReason: 'typed-connection',
      })
    }
  },
)
