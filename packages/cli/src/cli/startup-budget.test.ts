import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { RENDERER_READINESS_TIMEOUT_MS, waitForState } from './supervisor-command.js'
import {
  processStartIdentity,
  supervisorPaths,
  type SupervisorState,
  writeSupervisorState,
} from './supervisor-state.js'
import { type DiagnosticEvent, withDiagnostics } from '../diagnostics/context.js'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-budget-'))
  roots.push(root)
  const paths = supervisorPaths(root, 'codex', 'test')
  const state: SupervisorState = {
    schemaVersion: 1,
    appId: 'codex',
    profileId: 'test',
    phase: 'starting',
    pid: process.pid,
    processStartedAt: (await processStartIdentity(process.pid))!,
    instanceToken: 'a'.repeat(64),
    createdAt: new Date().toISOString(),
    version: 'test',
    effectiveConfig: 'test',
  }
  await writeSupervisorState(paths, state)
  return { paths, state }
}
it('accepts real ready state after 100219ms within the cold launch budget, preserving native ready authority', async () => {
  const { paths, state } = await fixture(), events: DiagnosticEvent[] = []
  let now = 0
  const result = await withDiagnostics(
    { emit: event => events.push(event) },
    () =>
      waitForState(paths, RENDERER_READINESS_TIMEOUT_MS, state.instanceToken, undefined, {
        now: () => now,
        wait: async () => {
          now = 100219
          await writeSupervisorState(paths, { ...state, phase: 'ready' })
        },
      }),
  )
  expect(RENDERER_READINESS_TIMEOUT_MS).toBe(180000)
  expect(result?.phase).toBe('ready')
  expect(events).toContainEqual(expect.objectContaining({ event: 'startup-ready', elapsedMs: 100219 }))
})
it('rejects a late ready publication and records the terminal deadline before caller cleanup', async () => {
  const { paths, state } = await fixture(), events: DiagnosticEvent[] = []
  let now = 0
  await expect(
    withDiagnostics({
      emit: event => events.push(event),
    }, () =>
      waitForState(paths, 180000, state.instanceToken, undefined, {
        now: () => now,
        wait: async () => {
          now = 180001
          await writeSupervisorState(paths, { ...state, phase: 'ready' })
        },
      })),
  ).rejects.toThrow('timed out waiting')
  expect(events).toContainEqual(expect.objectContaining({ event: 'startup-deadline', elapsedMs: 180001 }))
})
it('does not let repeated waiting-for-user heartbeats silently renew the bounded launch', async () => {
  const { paths, state } = await fixture()
  let now = 0
  await writeSupervisorState(paths, {
    ...state,
    hostPid: process.pid,
    hostProcessStartedAt: state.processStartedAt,
    startupRecovery: { updatedAt: Date.now(), waitingForUser: true, attempt: 1 },
  })
  await expect(waitForState(paths, 180000, state.instanceToken, undefined, {
    now: () => now,
    wait: async () => {
      now += 61000
    },
  })).rejects.toThrow('timed out waiting')
})
