import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSupervisorRuntime } from '../packages/cli/src/cli/supervisor-runtime.js'
import {
  acquireSupervisorStartLock,
  processStartIdentity,
  SupervisorOperationBusyError,
  supervisorPaths,
  writeSupervisorState,
} from '../packages/cli/src/cli/supervisor-state.js'

describe('background supervisor publication handshake', () => {
  it('waits for a matching published generation before consuming the bootstrap token', async () => {
    const root = await mkdtemp(path.join('/tmp', 'cx-runtime-'))
    const paths = supervisorPaths(root, 'codex', 'work')
    const token = 'a'.repeat(64)
    const fingerprint = 'current'
    await writeFile(paths.bootstrapToken, token, { mode: 0o600 }).catch(async () => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(paths.directory, { recursive: true })
      await writeFile(paths.bootstrapToken, token, { mode: 0o600 })
    })
    const pending = createSupervisorRuntime({
      CORDISX_SUPERVISOR_HOME: root,
      CORDISX_SUPERVISOR_APP: 'codex',
      CORDISX_SUPERVISOR_PROFILE: 'work',
      CORDISX_SUPERVISOR_FINGERPRINT: fingerprint,
      CORDISX_SUPERVISOR_TOKEN_FILE: paths.bootstrapToken,
    })
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(await readFile(paths.bootstrapToken, 'utf8')).toBe(token)
    await writeSupervisorState(paths, {
      schemaVersion: 1,
      appId: 'codex',
      profileId: 'work',
      phase: 'starting',
      pid: process.pid,
      processStartedAt: (await processStartIdentity(process.pid))!,
      instanceToken: token,
      createdAt: new Date().toISOString(),
      version: 'test',
      effectiveConfig: fingerprint,
    })
    const runtime = await pending
    await expect(readFile(paths.bootstrapToken, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(acquireSupervisorStartLock(paths)).rejects.toBeInstanceOf(SupervisorOperationBusyError)
    await runtime.markReady(43123)
    const release = await acquireSupervisorStartLock(paths)
    await release()
    await runtime.close()
  })

  it('waits past an older published generation and times out without consuming the token', async () => {
    const root = await mkdtemp(path.join('/tmp', 'cx-runtime-'))
    const paths = supervisorPaths(root, 'codex', 'work')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.bootstrapToken, 'b'.repeat(64), { mode: 0o600 })
    await writeSupervisorState(paths, {
      schemaVersion: 1,
      appId: 'codex',
      profileId: 'work',
      phase: 'starting',
      pid: process.pid,
      processStartedAt: (await processStartIdentity(process.pid))!,
      instanceToken: 'c'.repeat(64),
      createdAt: new Date().toISOString(),
      version: 'test',
      effectiveConfig: 'current',
    })
    await expect(createSupervisorRuntime({
      CORDISX_SUPERVISOR_HOME: root,
      CORDISX_SUPERVISOR_APP: 'codex',
      CORDISX_SUPERVISOR_PROFILE: 'work',
      CORDISX_SUPERVISOR_FINGERPRINT: 'current',
      CORDISX_SUPERVISOR_TOKEN_FILE: paths.bootstrapToken,
    }, { publicationTimeoutMs: 50 })).rejects.toThrow('timed out waiting for background supervisor publication')
    await expect(readFile(paths.bootstrapToken, 'utf8')).resolves.toBe('b'.repeat(64))
  })

  it('leaves the bootstrap token intact when the parent never publishes state', async () => {
    const root = await mkdtemp(path.join('/tmp', 'cx-runtime-'))
    const paths = supervisorPaths(root, 'codex', 'work')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(paths.directory, { recursive: true })
    const token = 'f'.repeat(64)
    await writeFile(paths.bootstrapToken, token, { mode: 0o600 })
    await expect(createSupervisorRuntime({
      CORDISX_SUPERVISOR_HOME: root,
      CORDISX_SUPERVISOR_APP: 'codex',
      CORDISX_SUPERVISOR_PROFILE: 'work',
      CORDISX_SUPERVISOR_FINGERPRINT: 'current',
      CORDISX_SUPERVISOR_TOKEN_FILE: paths.bootstrapToken,
    }, { publicationTimeoutMs: 50 })).rejects.toThrow('timed out waiting for background supervisor publication')
    await expect(readFile(paths.bootstrapToken, 'utf8')).resolves.toBe(token)
  })

  it('rejects lifecycle updates after the published generation is replaced', async () => {
    const root = await mkdtemp(path.join('/tmp', 'cx-runtime-'))
    const paths = supervisorPaths(root, 'codex', 'work')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(paths.directory, { recursive: true })
    const token = 'd'.repeat(64)
    await writeFile(paths.bootstrapToken, token, { mode: 0o600 })
    const state = {
      schemaVersion: 1 as const,
      appId: 'codex',
      profileId: 'work',
      phase: 'starting' as const,
      pid: process.pid,
      processStartedAt: (await processStartIdentity(process.pid))!,
      instanceToken: token,
      createdAt: new Date().toISOString(),
      version: 'test',
      effectiveConfig: 'current',
    }
    await writeSupervisorState(paths, state)
    const runtime = await createSupervisorRuntime({
      CORDISX_SUPERVISOR_HOME: root,
      CORDISX_SUPERVISOR_APP: 'codex',
      CORDISX_SUPERVISOR_PROFILE: 'work',
      CORDISX_SUPERVISOR_FINGERPRINT: 'current',
      CORDISX_SUPERVISOR_TOKEN_FILE: paths.bootstrapToken,
    })
    try {
      await writeSupervisorState(paths, { ...state, instanceToken: 'e'.repeat(64) })
      await expect(runtime.markReady(43123)).rejects.toThrow('generation is no longer current')
    } finally {
      await runtime.close()
    }
  })

  it('releases the startup operation when initialization closes before ready', async () => {
    const root = await mkdtemp(path.join('/tmp', 'cx-runtime-'))
    const paths = supervisorPaths(root, 'codex', 'work')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(paths.directory, { recursive: true })
    const token = '1'.repeat(64)
    await writeFile(paths.bootstrapToken, token, { mode: 0o600 })
    await writeSupervisorState(paths, {
      schemaVersion: 1,
      appId: 'codex',
      profileId: 'work',
      phase: 'starting',
      pid: process.pid,
      processStartedAt: (await processStartIdentity(process.pid))!,
      instanceToken: token,
      createdAt: new Date().toISOString(),
      version: 'test',
      effectiveConfig: 'current',
    })
    const runtime = await createSupervisorRuntime({
      CORDISX_SUPERVISOR_HOME: root,
      CORDISX_SUPERVISOR_APP: 'codex',
      CORDISX_SUPERVISOR_PROFILE: 'work',
      CORDISX_SUPERVISOR_FINGERPRINT: 'current',
      CORDISX_SUPERVISOR_TOKEN_FILE: paths.bootstrapToken,
    })
    await expect(acquireSupervisorStartLock(paths)).rejects.toBeInstanceOf(SupervisorOperationBusyError)
    await runtime.close()
    const release = await acquireSupervisorStartLock(paths)
    await release()
  })
})
