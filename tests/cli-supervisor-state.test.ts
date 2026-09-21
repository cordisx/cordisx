import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  acquireSupervisorStartLock,
  effectiveConfigFingerprint,
  hasMatchingProcess,
  LegacySupervisorLockError,
  processStartIdentity,
  readSupervisorState,
  removeSupervisorState,
  stateFileIsPrivate,
  SupervisorOperationBusyError,
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

  it('serializes concurrent ownership through an OS lock and keeps the fixed lock paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-supervisor-'))
    const paths = supervisorPaths(root, 'codex', 'work')
    const release = await acquireSupervisorStartLock(paths)
    await expect(acquireSupervisorStartLock(paths)).rejects.toBeInstanceOf(SupervisorOperationBusyError)
    await release()
    const second = await acquireSupervisorStartLock(paths)
    await second()
    expect((await lstat(paths.lock)).isDirectory()).toBe(true)
    expect((await lstat(paths.mutex)).isFile()).toBe(true)
    await mkdir(paths.directory, { recursive: true })
    await removeSupervisorState(paths)
    expect(await readSupervisorState(paths)).toBeUndefined()
  })

  it('recovers the kernel lock after a lock-owner process is killed', async () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-supervisor-crash-'))
    const moduleUrl = new URL('../packages/cli/src/cli/supervisor-state.ts', import.meta.url).href
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { acquireSupervisorStartLock, supervisorPaths } from ${JSON.stringify(moduleUrl)};
       await acquireSupervisorStartLock(supervisorPaths(process.argv[1], 'codex', 'work'));
       process.stdout.write('locked'); setInterval(() => {}, 1_000)`,
      root,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve())
        child.stderr.once('data', error => reject(new Error(String(error))))
        child.once('exit', code => reject(new Error(`lock owner exited early: ${code}`)))
      })
      const paths = supervisorPaths(root, 'codex', 'work')
      await expect(acquireSupervisorStartLock(paths)).rejects.toBeInstanceOf(SupervisorOperationBusyError)
      process.kill(child.pid!, 'SIGKILL')
      await new Promise(resolve => child.once('exit', resolve))
      const release = await acquireSupervisorStartLock(paths)
      await release()
    } finally {
      try {
        process.kill(child.pid!, 'SIGKILL')
      } catch { /* already stopped */ }
    }
  })

  it('requires explicit recovery before replacing a legacy regular-file lock', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-supervisor-legacy-'))
    const paths = supervisorPaths(root, 'codex', 'work')
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.lock, '')
    await expect(acquireSupervisorStartLock(paths)).rejects.toBeInstanceOf(LegacySupervisorLockError)
    expect((await lstat(paths.lock)).isFile()).toBe(true)
    const release = await acquireSupervisorStartLock(paths, { recoverLegacy: true })
    await release()
    expect((await lstat(paths.lock)).isDirectory()).toBe(true)
    await expect(rm(paths.lock, { force: true })).rejects.toMatchObject({ code: 'ERR_FS_EISDIR' })
    expect((await lstat(paths.lock)).isDirectory()).toBe(true)
  })
})
