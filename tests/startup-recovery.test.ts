import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { waitForState } from '../packages/cli/src/cli/supervisor-command.js'
import {
  processStartIdentity,
  supervisorPaths,
  writeSupervisorState,
} from '../packages/cli/src/cli/supervisor-state.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture(updatedAt = Date.now()) {
  const root = await mkdtemp(path.join(tmpdir(), 'startup-recovery-'))
  roots.push(root)
  const paths = supervisorPaths(root, 'codex', 'test')
  const identity = (await processStartIdentity(process.pid))!
  const state = {
    schemaVersion: 1 as const,
    appId: 'codex',
    profileId: 'test',
    phase: 'starting' as const,
    pid: process.pid,
    processStartedAt: identity,
    instanceToken: 'a'.repeat(64),
    createdAt: new Date().toISOString(),
    version: 'test',
    effectiveConfig: 'test',
    hostPid: process.pid,
    hostProcessStartedAt: identity,
    startupRecovery: { waitingForUser: true, attempt: 0, updatedAt },
  }
  await writeSupervisorState(paths, state)
  return { paths, state }
}
it('pauses only for a live recovery heartbeat and resumes the same generation after Retry', async () => {
  const { paths, state } = await fixture()
  const events: string[] = []
  const pending = waitForState(paths, 30, async (_state, phase) => {
    events.push(phase)
    if (phase === 'retrying') await writeSupervisorState(paths, { ...state, phase: 'ready' })
  })
  await new Promise(resolve => setTimeout(resolve, 120))
  await writeSupervisorState(paths, {
    ...state,
    startupRecovery: { waitingForUser: false, attempt: 1, updatedAt: Date.now() },
  })
  await expect(pending).resolves.toMatchObject({ phase: 'ready', instanceToken: state.instanceToken })
  expect(events).toContain('waiting-for-user')
  expect(events).toContain('retrying')
})
it('a stale recovery record cannot disable the startup deadline', async () => {
  const { paths } = await fixture(Date.now() - 10000)
  await expect(waitForState(paths, 30)).rejects.toThrow('timed out')
})
