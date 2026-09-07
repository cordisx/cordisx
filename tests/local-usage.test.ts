import { appendFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, type TestContext } from 'vitest'
import { LocalUsageHost } from '../packages/cli/src/launcher/local-usage.js'

function total(input: number) {
  return {
    input_tokens: input,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: input,
  }
}
const header = (id: string) => JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n'
const token = (input: number, last: number, ordinal: number) =>
  JSON.stringify({
    type: 'event_msg',
    ordinal,
    payload: { type: 'token_count', info: { total_token_usage: total(input), last_token_usage: total(last) } },
  }) + '\n'
async function fixture(
  t: TestContext,
  options: { maxScanBytes?: number; scanCooldownMs?: number; now?: () => number } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-local-usage-'))
  const home = path.join(root, 'home'), cache = path.join(root, 'cache')
  await mkdir(path.join(home, 'sessions'), { recursive: true })
  await mkdir(path.join(home, 'archived_sessions'))
  const hosts: LocalUsageHost[] = []
  const create = () => {
    const host = new LocalUsageHost({
      codexHome: home,
      cacheDir: cache,
      profileName: 'test',
      now: () => 1000,
      scanCooldownMs: 0,
      ...options,
    })
    hosts.push(host)
    return host
  }
  t.onTestFinished(async () => {
    hosts.forEach(host => host.dispose())
    await rm(root, { recursive: true, force: true })
  })
  const file = (name = 'one') => path.join(home, 'sessions', `${name}.jsonl`)
  const archive = (name = 'one') => path.join(home, 'archived_sessions', `${name}.jsonl`)
  return { root, home, cache, create, file, archive }
}
function ready(snapshot: Awaited<ReturnType<LocalUsageHost['read']>>) {
  expect(snapshot.status).toBe('ready')
  if (snapshot.status !== 'ready') throw new Error('Expected available snapshot')
  return snapshot
}
it('baselines old and newly discovered sources and resumes durable deltas after restart', async t => {
  const f = await fixture(t), host = f.create()
  await writeFile(f.file(), header('owner') + token(100, 100, 1))
  const baseline = ready(await host.read())
  expect(baseline.eligibleTokens).toBe(0)
  await appendFile(f.file(), token(150, 50, 2))
  const earned = ready(await host.read())
  expect(earned.eligibleTokens).toBe(50)
  expect(earned.epoch).toBe(baseline.epoch)
  host.dispose()
  const restarted = f.create()
  expect(ready(await restarted.read()).eligibleTokens).toBe(50)
  await writeFile(f.file('two'), header('new-owner') + token(10000, 10000, 1))
  expect(ready(await restarted.read()).eligibleTokens).toBe(50)
  await appendFile(f.file('two'), token(10030, 30, 2))
  expect(ready(await restarted.read()).eligibleTokens).toBe(80)
})
it('two independent Host instances commit each increment exactly once', async t => {
  const f = await fixture(t), a = f.create(), b = f.create()
  await writeFile(f.file(), header('owner') + token(100, 100, 1))
  const initial = await Promise.all([a.read(), b.read()])
  expect(ready(initial[0]!).epoch).toBe(ready(initial[1]!).epoch)
  await appendFile(f.file(), token(140, 40, 2))
  const results = await Promise.all([a.read(), b.read()])
  expect(results.map(value => ready(value).eligibleTokens)).toEqual([40, 40])
  expect(ready(await a.read()).eligibleTokens).toBe(40)
})
it('archive moves and identical aliases retain the same accounting source', async t => {
  const f = await fixture(t), host = f.create()
  await writeFile(f.file(), header('owner') + token(100, 100, 1))
  await host.read()
  await appendFile(f.file(), token(140, 40, 2))
  expect(ready(await host.read()).eligibleTokens).toBe(40)
  await rename(f.file(), f.archive())
  expect(ready(await host.read()).eligibleTokens).toBe(40)
  await writeFile(f.file(), await readFile(f.archive()))
  await appendFile(f.file(), token(180, 40, 3))
  expect(ready(await host.read()).eligibleTokens).toBe(80)
  expect(ready(await host.read()).eligibleTokens).toBe(80)
})
it('short aliases and temporary truncation cannot roll checkpoints back or prevent a matching longer source', async t => {
  const f = await fixture(t), host = f.create()
  const first = header('owner') + token(100, 100, 1)
  await writeFile(f.file(), first)
  await host.read()
  const longer = first + token(140, 40, 2)
  await writeFile(f.file(), longer)
  expect(ready(await host.read()).eligibleTokens).toBe(40)
  await writeFile(f.file(), first)
  expect(ready(await host.read()).eligibleTokens).toBe(40)
  await writeFile(f.file(), longer + token(160, 20, 3))
  expect(ready(await host.read()).eligibleTokens).toBe(60)
})
it('rewritten source and conflicting owner aliases are quarantined without replay credit', async t => {
  const f = await fixture(t), host = f.create()
  const base = header('owner') + token(100, 100, 1)
  await writeFile(f.file(), base)
  await host.read()
  await writeFile(f.file(), header('owner') + token(200, 200, 1) + token(240, 40, 2))
  const rewritten = ready(await host.read())
  expect(rewritten.eligibleTokens).toBe(0)
  expect(rewritten.diagnostics.some(item => item.code === 'quarantined-source')).toBe(true)
  await writeFile(f.file(), base + token(150, 50, 2))
  expect(ready(await host.read()).eligibleTokens).toBe(0)
  await writeFile(f.file('new'), header('conflict') + token(100, 100, 1))
  await writeFile(f.archive('new'), header('conflict') + token(200, 200, 1))
  await host.read()
  await rm(f.archive('new'))
  await appendFile(f.file('new'), token(140, 40, 2))
  expect(ready(await host.read()).eligibleTokens).toBe(0)
})
it('complete-line checkpoints defer partial writes and reveal no message content or file paths', async t => {
  const f = await fixture(t), host = f.create()
  await writeFile(f.file(), header('owner') + token(100, 100, 1))
  await host.read()
  const next = token(150, 50, 2)
  await appendFile(f.file(), next.slice(0, -1))
  expect(ready(await host.read()).eligibleTokens).toBe(0)
  await appendFile(
    f.file(),
    '\n' + JSON.stringify({ type: 'response_item', payload: { content: 'private-message-content', path: f.home } })
      + '\n',
  )
  const snapshot = ready(await host.read())
  expect(snapshot.eligibleTokens).toBe(50)
  expect(JSON.stringify(snapshot)).not.toContain('private-message-content')
  expect(JSON.stringify(snapshot)).not.toContain(f.home)
  const directory = path.join(f.cache, 'local-usage-v1')
  const dbFile = (await readdir(directory)).find(name => name.endsWith('.sqlite'))!
  const db = new DatabaseSync(path.join(directory, dbFile))
  try {
    expect(String(db.prepare('SELECT value FROM ledger').get()!.value)).not.toContain('private-message-content')
  } finally {
    db.close()
  }
})
it('byte-budget rotation eventually baselines and updates every source', async t => {
  const first = header('owner-a') + token(100, 100, 1)
  const second = header('owner-b') + token(100, 100, 1)
  const f = await fixture(t, { maxScanBytes: Buffer.byteLength(first + token(120, 20, 2)) + 5 }), host = f.create()
  await writeFile(f.file('a'), first)
  await writeFile(f.file('b'), second)
  await host.read()
  await host.read()
  await appendFile(f.file('a'), token(120, 20, 2))
  await appendFile(f.file('b'), token(120, 20, 2))
  await host.read()
  await host.read()
  expect(ready(await host.read()).eligibleTokens).toBe(40)
})
it('invalid ledger fields fail closed and retain the original corrupted record', async t => {
  const f = await fixture(t), host = f.create()
  await writeFile(f.file(), header('owner') + token(100, 100, 1))
  await host.read()
  const directory = path.join(f.cache, 'local-usage-v1')
  const dbFile = (await readdir(directory)).find(name => name.endsWith('.sqlite'))!
  const db = new DatabaseSync(path.join(directory, dbFile))
  let broken = ''
  try {
    const ledger = JSON.parse(String(db.prepare('SELECT value FROM ledger').get()!.value))
    ledger.snapshot.diagnostics = [{ code: 'read-failed', detail: 'private-content' }]
    broken = JSON.stringify(ledger)
    db.prepare('UPDATE ledger SET value=?').run(broken)
  } finally {
    db.close()
  }
  expect((await host.read()).status).toBe('unavailable')
  const check = new DatabaseSync(path.join(directory, dbFile))
  try {
    expect(check.prepare('SELECT value FROM ledger').get()!.value).toBe(broken)
  } finally {
    check.close()
  }
})

it('shares a durable scan cooldown and resumes validation after expiry', async t => {
  let now = 1000
  const f = await fixture(t, { scanCooldownMs: 30_000, now: () => now })
  await writeFile(f.file(), header('owner') + token(100, 100, 1))
  const baseline = ready(await f.create().read())
  await appendFile(f.file(), token(150, 50, 2))
  // Remove all rollout roots: a cached read must not enumerate or open them.
  await rename(path.join(f.home, 'sessions'), path.join(f.home, 'hidden'))
  await rename(path.join(f.home, 'archived_sessions'), path.join(f.home, 'hidden-archive'))
  expect(await f.create().read()).toEqual(baseline)
  now += 30_000
  expect(await f.create().read()).toMatchObject({ status: 'unavailable', reason: 'source-unavailable' })
  await rename(path.join(f.home, 'hidden'), path.join(f.home, 'sessions'))
  await rename(path.join(f.home, 'hidden-archive'), path.join(f.home, 'archived_sessions'))
  expect(ready(await f.create().read()).eligibleTokens).toBe(50)
})

it('does not reuse a cooldown snapshot when the wall clock moves backwards', async t => {
  let now = 100_000
  const f = await fixture(t, { scanCooldownMs: 30_000, now: () => now })
  await writeFile(f.file(), header('owner') + token(100, 100, 1))
  const host = f.create()
  const baseline = ready(await host.read())
  await appendFile(f.file(), token(150, 50, 2))
  now = 90_000
  const updated = ready(await f.create().read())
  expect(updated.eligibleTokens).toBe(50)
  expect(updated.revision).toBe(baseline.revision + 1)
  expect(updated.observedThrough).toBe(baseline.observedThrough)
})
