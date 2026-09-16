import { mkdir, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  acquireSupervisorStartLock,
  effectiveConfigFingerprint,
  hasMatchingProcess,
  processStartIdentity,
  readSupervisorState,
  removeSupervisorState,
  stateFileIsPrivate,
  supervisorPaths,
  writeSupervisorState,
} from '../packages/cli/src/cli/supervisor-state.js'

describe('transient supervisor state', () => {
  it('uses one app/profile-scoped private run authority and atomically round-trips its state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-supervisor-'))
    const paths = supervisorPaths(root, 'codex', 'work')
    const processStartedAt = await processStartIdentity(process.pid)
    expect(processStartedAt).toBeDefined()
    await writeSupervisorState(paths, {
      schemaVersion: 1,
      appId: 'codex',
      profileId: 'work',
      phase: 'ready',
      pid: process.pid,
      processStartedAt: processStartedAt!,
      instanceToken: 'a'.repeat(32),
      createdAt: new Date().toISOString(),
      version: '0.1.0-test',
      effectiveConfig: effectiveConfigFingerprint({ mode: 'shared', plugins: [] }),
      cdpEndpoint: 'http://127.0.0.1:43135',
    })
    expect(await readSupervisorState(paths)).toMatchObject({ phase: 'ready', appId: 'codex', profileId: 'work' })
    expect(await stateFileIsPrivate(paths)).toBe(true)
    expect(await hasMatchingProcess((await readSupervisorState(paths))!)).toBe(true)
  })

  it('does not treat a reused or mismatched PID as its instance', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-supervisor-'))
    const paths = supervisorPaths(root, 'codex', 'work')
    await writeSupervisorState(paths, {
      schemaVersion: 1,
      appId: 'codex',
      profileId: 'work',
      phase: 'ready',
      pid: process.pid,
      processStartedAt: 'not this process',
      instanceToken: 'b'.repeat(32),
      createdAt: new Date().toISOString(),
      version: '0.1.0-test',
      effectiveConfig: 'same',
    })
    expect(await hasMatchingProcess((await readSupervisorState(paths))!)).toBe(false)
  })

  it('serializes concurrent start ownership and permits safe stale cleanup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-supervisor-'))
    const paths = supervisorPaths(root, 'codex', 'work')
    const release = await acquireSupervisorStartLock(paths)
    await expect(acquireSupervisorStartLock(paths)).rejects.toThrow('already in progress')
    await release()
    const second = await acquireSupervisorStartLock(paths)
    await second()
    await mkdir(paths.directory, { recursive: true })
    await removeSupervisorState(paths)
    expect(await readSupervisorState(paths)).toBeUndefined()
  })
})
