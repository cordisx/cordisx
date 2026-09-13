import { appendFile, mkdir, mkdtemp, open, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, type TestContext, vi } from 'vitest'
import { LocalUsageHost } from '../packages/cli/src/launcher/local-usage.js'
import { WorkUsageProfileHost } from '../packages/cli/src/launcher/work-usage-profile.js'
import { CodexAgentHistoryHost } from '../packages/cli/src/launcher/agent-history.js'
import { parseCordisXCli } from '../packages/cli/src/cli/parse.js'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open), mkdir: vi.fn(actual.mkdir) }
})
const tokens = (input: number, last: number, ordinal: number) =>
  JSON.stringify({
    type: 'event_msg',
    ordinal,
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input,
          output_tokens: 0,
          total_tokens: input,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
        last_token_usage: {
          input_tokens: last,
          output_tokens: 0,
          total_tokens: last,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    },
  }) + '\n'
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'work-profile-'))
  const codexHome = path.join(root, 'codex'), homeDir = path.join(root, 'host')
  await mkdir(path.join(codexHome, 'sessions'), { recursive: true })
  await mkdir(path.join(codexHome, 'archived_sessions'))
  const options = {
    codexHome,
    cacheDir: path.join(homeDir, 'cache', 'agent-history'),
    profileName: 'development:/original-config',
    scanCooldownMs: 0,
    now: () => 1000,
  }
  const location = { homeDir, profileId: 'development' }
  const file = path.join(codexHome, 'sessions', 'owner.jsonl')
  await writeFile(
    file,
    JSON.stringify({
      type: 'session_meta',
      payload: { id: 'root-owner', source: 'cli', cwd: '/ordinary-project' },
    }) + '\n' + tokens(100, 100, 1),
  )
  const legacy = new LocalUsageHost({ ...options, projection: 'work-v2' })
  await legacy.read()
  await appendFile(file, tokens(4079196, 4079096, 2))
  const admitted = await legacy.read()
  if (admitted.status !== 'ready') throw new Error('legacy fixture unavailable')
  expect(admitted.eligibleTokens).toBe(4079096)
  t.onTestFinished(async () => {
    legacy.dispose()
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })
  const anchorFile = path.join(homeDir, 'state', 'profiles', 'development', 'work-usage-profile.json')
  return { root, options, location, file, admitted, anchorFile }
}
it('requires original derived scope/epoch for ambiguous bootstrap and reuses it across config moves and restart', async t => {
  const f = await fixture(t)
  const moved = { ...f.options, profileName: 'development:/new-config' }
  const wrong = new LocalUsageHost({ ...moved, projection: 'work-v2' })
  const zero = await wrong.read()
  expect(zero).toMatchObject({ status: 'ready', eligibleTokens: 0 })
  const originalGuard = { scopeId: f.admitted.scopeId, epoch: f.admitted.epoch }
  await expect(new WorkUsageProfileHost({ ...f.location, bootstrapGuard: originalGuard }, moved).preflight())
    .rejects.toThrow('precondition failed')
  expect(await new WorkUsageProfileHost(f.location, f.options).read()).toMatchObject({ status: 'unavailable' })
  expect(await new WorkUsageProfileHost({ ...f.location, bootstrapGuard: originalGuard }, moved).read())
    .toMatchObject({ status: 'unavailable' })
  if (zero.status !== 'ready') throw new Error('wrong fixture unavailable')
  expect(
    await new WorkUsageProfileHost({
      ...f.location,
      bootstrapGuard: { scopeId: zero.scopeId, epoch: zero.epoch },
    }, f.options).read(),
  ).toMatchObject({ status: 'unavailable' })
  await expect(readFile(f.anchorFile)).rejects.toMatchObject({ code: 'ENOENT' })
  const canonical = new WorkUsageProfileHost({ ...f.location, bootstrapGuard: originalGuard }, f.options)
  await canonical.preflight()
  await expect(readFile(f.anchorFile)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await canonical.read()).toMatchObject(originalGuard)
  const frozen = await readFile(f.anchorFile)
  canonical.dispose()
  const adopted = new WorkUsageProfileHost(f.location, moved)
  expect(await adopted.read()).toMatchObject({ ...originalGuard, eligibleTokens: 4079096 })
  await appendFile(f.file, tokens(4090100, 10904, 3))
  expect(await adopted.read()).toMatchObject({ ...originalGuard, eligibleTokens: 4090000 })
  expect(await readFile(f.anchorFile)).toEqual(frozen)
  wrong.dispose()
  adopted.dispose()
})
it.for(['anchor-missing', 'ledger-missing', 'epoch-replaced', 'codex-home-replaced', 'unsafe-anchor'])(
  'fails closed after %s without creating a replacement scope or epoch',
  async (failure, t) => {
    const f = await fixture(t), host = new WorkUsageProfileHost(f.location, f.options)
    const snapshot = await host.read()
    if (snapshot.status !== 'ready') throw new Error('anchor unavailable')
    const ledger = path.join(f.options.cacheDir, 'local-work-usage-v2', snapshot.scopeId + '.sqlite')
    if (failure === 'anchor-missing') await unlink(f.anchorFile)
    if (failure === 'ledger-missing') await unlink(ledger)
    if (failure === 'epoch-replaced') {
      const db = new DatabaseSync(ledger), row = db.prepare('SELECT value FROM ledger WHERE id=1').get()!
      const value = JSON.parse(String(row.value))
      value.snapshot.epoch = '00000000-0000-0000-0000-000000000001'
      db.prepare('UPDATE ledger SET value=? WHERE id=1').run(JSON.stringify(value))
      db.close()
    }
    if (failure === 'codex-home-replaced') {
      const other = path.join(f.root, 'other')
      await mkdir(other)
      host.dispose()
      const alternate = new WorkUsageProfileHost(f.location, { ...f.options, codexHome: other })
      expect(await alternate.read()).toMatchObject({ status: 'unavailable' })
      alternate.dispose()
      return
    }
    if (failure === 'unsafe-anchor') {
      const text = await readFile(f.anchorFile)
      await unlink(f.anchorFile)
      const other = path.join(f.root, 'claim-copy')
      await writeFile(other, text, { mode: 0o600 })
      await symlink(other, f.anchorFile)
    }
    expect(host.current(snapshot)).toBe(false)
    expect(await host.read()).toMatchObject({ status: 'unavailable' })
    host.dispose()
  },
)
it('independent history blocks fresh-process reselection after the anchor and its adjacent marker are lost', async t => {
  const f = await fixture(t)
  const moved = { ...f.options, profileName: 'development:/new-config' }
  const wrong = new LocalUsageHost({ ...moved, projection: 'work-v2' })
  const zero = await wrong.read()
  if (zero.status !== 'ready') throw new Error('wrong fixture unavailable')
  const canonical = new WorkUsageProfileHost({
    ...f.location,
    bootstrapGuard: { scopeId: f.admitted.scopeId, epoch: f.admitted.epoch },
  }, f.options)
  expect(await canonical.read()).toMatchObject({ scopeId: f.admitted.scopeId, epoch: f.admitted.epoch })
  canonical.dispose()
  await unlink(f.anchorFile)
  await rm(f.anchorFile + '.started', { recursive: true })
  for (const options of [f.options, moved]) {
    const identity = options === moved ? zero : f.admitted
    const restarted = new WorkUsageProfileHost({
      ...f.location,
      bootstrapGuard: { scopeId: identity.scopeId, epoch: identity.epoch },
    }, options)
    await expect(restarted.preflight()).rejects.toThrow('reconciliation required')
    expect(await restarted.read()).toMatchObject({ status: 'unavailable' })
    restarted.dispose()
  }
  await expect(readFile(f.anchorFile)).rejects.toMatchObject({ code: 'ENOENT' })
  wrong.dispose()
})
it('owner disposal before lazy work read cannot revive a history reader or create a profile claim', async t => {
  const f = await fixture(t)
  const host = new CodexAgentHistoryHost({ ...f.options, workProfile: f.location, secret: Buffer.alloc(32, 1) })
  host.dispose()
  expect(await host.readWorkUsage()).toMatchObject({ status: 'unavailable' })
  expect(host.workUsageCurrent(f.admitted)).toBe(false)
  await expect(readFile(f.anchorFile)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('disposal while opening the bootstrap record prevents its durable admission', async t => {
  const f = await fixture(t), host = new WorkUsageProfileHost(f.location, f.options)
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let release!: () => void, started = false
  const hold = new Promise<void>(resolve => {
    release = resolve
  })
  vi.mocked(open).mockImplementation(async (...args) => {
    const fd = await actual.open(...args)
    if (String(args[0]).startsWith(f.anchorFile + '.')) {
      started = true
      await hold
    }
    return fd
  })
  const pending = host.read()
  await vi.waitFor(() => expect(started).toBe(true))
  host.dispose()
  release()
  expect(await pending).toMatchObject({ status: 'unavailable' })
  await expect(readFile(f.anchorFile)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(f.anchorFile + '.started')).rejects.toMatchObject({ code: 'ENOENT' })
})
it('disposal during cache preparation cannot create a new reader or advance the legacy ledger', async t => {
  const f = await fixture(t), host = new WorkUsageProfileHost(f.location, f.options)
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let release!: () => void, started = false
  const hold = new Promise<void>(resolve => {
    release = resolve
  })
  vi.mocked(mkdir).mockImplementation(async (...args) => {
    const result = await actual.mkdir(...args)
    if (String(args[0]) === f.options.cacheDir) {
      started = true
      await hold
    }
    return result
  })
  const ledger = path.join(f.options.cacheDir, 'local-work-usage-v2', f.admitted.scopeId + '.sqlite')
  const db = new DatabaseSync(ledger, { readOnly: true })
  const before = db.prepare('SELECT value FROM ledger WHERE id=1').get()
  db.close()
  await appendFile(f.file, tokens(4090100, 10904, 3))
  const pending = host.read()
  await vi.waitFor(() => expect(started).toBe(true))
  host.dispose()
  release()
  expect(await pending).toMatchObject({ status: 'unavailable' })
  const after = new DatabaseSync(ledger, { readOnly: true })
  expect(after.prepare('SELECT value FROM ledger WHERE id=1').get()).toEqual(before)
  after.close()
  await expect(readFile(f.anchorFile)).rejects.toMatchObject({ code: 'ENOENT' })
  vi.mocked(mkdir).mockImplementation(actual.mkdir)
})
it('a legacy ledger appearing during bootstrap prevents unguarded admission', async t => {
  const f = await fixture(t), host = new WorkUsageProfileHost(f.location, f.options)
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let release!: () => void, started = false
  const hold = new Promise<void>(resolve => {
    release = resolve
  })
  vi.mocked(open).mockImplementation(async (...args) => {
    const fd = await actual.open(...args)
    if (String(args[0]).startsWith(f.anchorFile + '.')) {
      started = true
      await hold
    }
    return fd
  })
  const pending = host.read()
  await vi.waitFor(() => expect(started).toBe(true))
  const legacy = new LocalUsageHost({ ...f.options, projection: 'work-v2', profileName: 'development:/other' })
  expect(await legacy.read()).toMatchObject({ status: 'ready' })
  release()
  expect(await pending).toMatchObject({ status: 'unavailable' })
  await expect(readFile(f.anchorFile)).rejects.toMatchObject({ code: 'ENOENT' })
  host.dispose()
  legacy.dispose()
})
it('directory sync failure blocks admission until a later successful flush', async t => {
  const f = await fixture(t), host = new WorkUsageProfileHost(f.location, f.options)
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(open).mockImplementation(async (...args) => {
    const fd = await actual.open(...args)
    if (String(args[0]) === path.dirname(f.anchorFile)) {
      fd.sync = async () => {
        throw new Error('sync failed')
      }
    }
    return fd
  })
  expect(await host.read()).toMatchObject({ status: 'unavailable' })
  expect(await new WorkUsageProfileHost(f.location, f.options).read()).toMatchObject({ status: 'unavailable' })
  vi.mocked(open).mockImplementation(actual.open)
  expect(await host.read()).toMatchObject({ scopeId: f.admitted.scopeId, epoch: f.admitted.epoch })
  host.dispose()
})
it('normal dev parser accepts only a restrictive scope/epoch guard and rejects other actions or malformed guards', () => {
  const guard = 'a'.repeat(64) + '/00000000-0000-0000-0000-000000000001'
  expect(parseCordisXCli(['dev', '--config', '/original/config.json', '--work-scope-guard', guard]))
    .toMatchObject({ action: 'dev', options: { workScopeGuard: guard } })
  expect(() => parseCordisXCli(['--work-scope-guard', guard])).toThrow('only valid with cordisx dev')
  expect(() => parseCordisXCli(['dev', '--work-scope-guard', 'arbitrary'])).toThrow('requires scope/epoch')
})
