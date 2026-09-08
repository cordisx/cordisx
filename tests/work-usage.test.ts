import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { LocalUsageHost } from '../packages/cli/src/launcher/local-usage.js'
import { classifyWorkUsageHeader, projectWorkUsage } from '../packages/cli/src/launcher/work-usage.js'
import { AgentLoopAuthority } from '../packages/cli/src/launcher/agent-loop-authority.js'
const header = (id: string, extra: object) =>
  JSON.stringify({ type: 'session_meta', payload: { id, source: 'cli', ...extra } }) + '\n'
const token = (input: number, last: number, ordinal: number) => {
  const vector = (value: number) => ({
    input_tokens: value,
    output_tokens: 0,
    total_tokens: value,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    reasoning_output_tokens: 0,
  })
  return JSON.stringify({
    type: 'event_msg',
    ordinal,
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: vector(input),
        last_token_usage: vector(last),
      },
    },
  }) + '\n'
}
it('keeps real Host-created game cwd and all uncertain sources outside an independent durable work ledger', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-work-usage-'))
  const home = path.join(root, 'codex'), cache = path.join(root, 'cache')
  await mkdir(path.join(home, 'sessions'), { recursive: true })
  await mkdir(path.join(home, 'archived_sessions'))
  const authority = await AgentLoopAuthority.open(root, 'work')
  const gameCwd = await authority.gameWorkspace({
    profileId: 'work',
    compositionGeneration: 'generation',
    ownerKey: 'game',
  }, 'game-command')
  const fixtures = [
    header('normal', { cwd: '/ordinary-project' }),
    header('game', { cwd: gameCwd }),
    header('fork', { cwd: '/ordinary-project', forked_from_id: 'game', subagent_history_start_ordinal: 0 }),
    header('missing', {}),
    header('unknown-source', { cwd: '/ordinary-project', source: 'unknown' }),
  ]
  const files = fixtures.map((_, i) => path.join(home, 'sessions', `${i}.jsonl`))
  await Promise.all(files.map((file, i) => writeFile(file, fixtures[i]! + token(100, 100, 1))))
  const options = { codexHome: home, cacheDir: cache, profileName: 'work', scanCooldownMs: 0, now: () => 1000 }
  const all = new LocalUsageHost(options), work = new LocalUsageHost({ ...options, projection: 'work-v2' })
  t.onTestFinished(async () => {
    all.dispose()
    work.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const old = await all.read(), baseline = projectWorkUsage(await work.read())
  if (old.status !== 'ready' || baseline.status !== 'ready') throw new Error('ledger unavailable')
  expect(old.epoch).not.toBe(baseline.epoch)
  expect(old.scopeId).not.toBe(baseline.scopeId)
  expect(baseline.eligibleTokens).toBe(0)
  await Promise.all(files.map(file => appendFile(file, token(150, 50, 2))))
  const result = projectWorkUsage(await work.read())
  expect(result).toMatchObject({
    schemaVersion: 2,
    eligibleTokens: 50,
    coverage: 'partial',
    policyId: 'codex-local-work-input-output-v2',
    classification: { version: 'host-game-cwd-v1', hostGameTasks: 'excluded' },
  })
  expect(await all.read()).toMatchObject({ eligibleTokens: 250 })
  const restarted = new LocalUsageHost({ ...options, projection: 'work-v2' })
  expect(await restarted.read()).toMatchObject({ epoch: baseline.epoch, eligibleTokens: 50 })
  restarted.dispose()
  expect(JSON.stringify(result)).not.toContain(gameCwd)
  expect(classifyWorkUsageHeader(fixtures[1]!)).toBe('game')
})
