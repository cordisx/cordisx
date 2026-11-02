import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  readSupervisorState,
  supervisorPaths,
  type SupervisorState,
  updateSupervisorState,
  writeSupervisorState,
} from '../packages/cli/src/cli/supervisor-state.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-state-fence-'))
  roots.push(root)
  const paths = supervisorPaths(root, 'codex', 'test')
  const state: SupervisorState = {
    schemaVersion: 1,
    appId: 'codex',
    profileId: 'test',
    phase: 'starting',
    pid: process.pid,
    processStartedAt: 'test-process',
    instanceToken: 'a'.repeat(64),
    createdAt: 'test',
    version: 'test',
    effectiveConfig: 'test',
  }
  await writeSupervisorState(paths, state)
  return { paths, state }
}

it('rejects an old generation after a new ready owner is published', async () => {
  const { paths, state } = await fixture()
  await writeSupervisorState(paths, { ...state, instanceToken: 'b'.repeat(64), phase: 'ready' })
  expect(await updateSupervisorState(paths, state, current => ({ ...current, phase: 'failed' }))).toBe(false)
  expect(await readSupervisorState(paths)).toMatchObject({ instanceToken: 'b'.repeat(64), phase: 'ready' })
})

it('serializes updates against latest state without lost fields', async () => {
  const { paths, state } = await fixture()
  await Promise.all([
    updateSupervisorState(paths, state, current => ({ ...current, hostPid: 123 })),
    updateSupervisorState(paths, state, current => ({ ...current, startupSurface: 'workspace-ready' })),
  ])
  expect(await readSupervisorState(paths)).toMatchObject({ hostPid: 123, startupSurface: 'workspace-ready' })
})

it('does not allow a late ready callback to overwrite stopping', async () => {
  const { paths, state } = await fixture()
  await updateSupervisorState(paths, state, current => ({ ...current, phase: 'stopping' }))
  expect(
    await updateSupervisorState(
      paths,
      state,
      current => current.phase === 'starting' ? { ...current, phase: 'ready' } : undefined,
    ),
  ).toBe(false)
  expect(await readSupervisorState(paths)).toMatchObject({ phase: 'stopping' })
})
