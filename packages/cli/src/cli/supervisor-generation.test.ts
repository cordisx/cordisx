import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureHomeConfig } from '../config/home-config.js'
import { launchFingerprint } from './launch-fingerprint.js'
import { type CordisXManagedInvocation, parseCordisXCli } from './parse.js'
import { runSupervisorCommand } from './supervisor-command.js'
import {
  processStartIdentity,
  readSupervisorState,
  supervisorPaths,
  type SupervisorState,
  writeSupervisorState,
} from './supervisor-state.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('supervisor startup generation', () => {
  it.each(['new', 'reused'] as const)('rejects a replacement generation while waiting for a %s start', async mode => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cx-generation-'))
    roots.push(root)
    await ensureHomeConfig({ env: { CORDISX_HOME: root } })
    const invocation = parseCordisXCli(['start', '--json']) as CordisXManagedInvocation
    const paths = supervisorPaths(root, 'codex', 'default')
    const startedAt = (await processStartIdentity(process.pid))!
    const original: SupervisorState = {
      schemaVersion: 1,
      appId: 'codex',
      profileId: 'default',
      phase: 'starting',
      pid: process.pid,
      processStartedAt: startedAt,
      hostPid: process.pid,
      hostProcessStartedAt: startedAt,
      instanceToken: 'a'.repeat(64),
      createdAt: new Date().toISOString(),
      version: JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version,
      effectiveConfig: launchFingerprint({
        source: await readFile(path.join(root, 'config.json'), 'utf8'),
        options: invocation.options,
        hostArgs: [],
        dataMode: 'shared',
        cwd: process.cwd(),
      }),
    }
    if (mode === 'reused') await writeSupervisorState(paths, original)
    const stdout = vi.fn()
    const presentation = vi.fn()
    const phases: string[] = []
    let publishHost: Promise<void> | undefined
    const spawn = vi.fn(() => {
      publishHost = (async () => {
        for (;;) {
          const state = await readSupervisorState(paths)
          if (state) {
            await writeSupervisorState(paths, { ...state, hostPid: process.pid, hostProcessStartedAt: startedAt })
            return
          }
          await new Promise(resolve => setTimeout(resolve, 5))
        }
      })()
      return { pid: process.pid, unref: () => {} }
    })
    const pending = runSupervisorCommand(invocation, {
      env: { CORDISX_HOME: root },
      stdout,
      internalSpawnSupervisor: spawn,
      internalScheduleShortcutPresentation: presentation,
      internalSupervisorReadinessTimeoutMs: 2_000,
    }, async (ready, phase) => {
      phases.push(phase)
      if (phase !== 'host-launched') return
      // Deterministically complete a replacement between two readiness polls.
      await writeSupervisorState(paths, {
        ...ready.state,
        instanceToken: 'b'.repeat(64),
        effectiveConfig: 'replacement configuration',
        phase: 'ready',
      })
    })
    await expect(pending.then(() => 'unexpected ready')).rejects.toThrow(
      'background supervisor generation changed before renderer readiness',
    )
    await publishHost
    expect(phases).toEqual(['host-launched'])
    expect(stdout).not.toHaveBeenCalled()
    expect(presentation).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(mode === 'new' ? 1 : 0)
    expect(await readSupervisorState(paths)).toMatchObject({
      phase: 'ready',
      effectiveConfig: 'replacement configuration',
    })
  })
})
