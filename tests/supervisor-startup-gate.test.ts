import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCordisXCli } from '../packages/cli/src/cli/parse.js'
import { runSupervisorCommandWithStartupGate } from '../packages/cli/src/cli/supervisor-command.js'
import {
  processStartIdentity,
  readSupervisorState,
  supervisorPaths,
  writeSupervisorState,
} from '../packages/cli/src/cli/supervisor-state.js'
import type { StartupGate } from '../packages/cli/src/cli/startup-gate.js'

function fakeGate(events: string[], actions: Array<'retry' | 'dismiss'> = []): StartupGate {
  return {
    stage: async message => {
      events.push(`stage:${message}`)
    },
    hostLaunched: async () => {
      events.push('host-hidden')
    },
    ready: async (_pid, _startedAt) => {
      events.push('ready')
    },
    failed: async message => {
      events.push(`failed:${message}`)
      return actions.shift() ?? 'dismiss'
    },
    close: async () => {
      events.push('closed')
    },
  }
}

describe('supervisor startup gate', () => {
  it('is visible before Host spawn and opens only after Host and renderer readiness', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-startup-gate-'))
    const paths = supervisorPaths(root, 'codex', 'default')
    const startedAt = await processStartIdentity(process.pid)
    const events: string[] = []
    const stderr = new PassThrough()
    let diagnostics = ''
    stderr.on('data', chunk => diagnostics += String(chunk))

    await runSupervisorCommandWithStartupGate(parseCordisXCli(['start']), {
      env: { CORDISX_HOME: root },
      stdout: () => undefined,
      stderr,
      internalOpenStartupGate: async () => {
        events.push('visible')
        return fakeGate(events)
      },
      internalSpawnSupervisor: () => {
        events.push('spawn')
        void (async () => {
          for (;;) {
            const state = await readSupervisorState(paths)
            if (state !== undefined) {
              await writeSupervisorState(paths, {
                ...state,
                hostPid: process.pid,
                hostProcessStartedAt: startedAt!,
              })
              await new Promise(resolve => setTimeout(resolve, 25))
              await writeSupervisorState(paths, {
                ...state,
                phase: 'ready',
                hostPid: process.pid,
                hostProcessStartedAt: startedAt!,
                cdpEndpoint: 'http://127.0.0.1:49991',
              })
              return
            }
            await new Promise(resolve => setTimeout(resolve, 5))
          }
        })()
        return { pid: process.pid, unref: () => undefined }
      },
    })

    expect(events).toEqual([
      'visible',
      'stage:正在检查运行配置',
      'spawn',
      'host-hidden',
      'stage:正在准备模型与界面',
      'stage:正在完成启动',
      'ready',
      'closed',
    ])
    expect(diagnostics).toMatch(/startup gate visible: \d+ ms/)
    expect(diagnostics).toMatch(/full application ready: \d+ ms/)
  })

  it('turns a failed launch into an explicit retry and keeps the gate until success', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-startup-gate-retry-'))
    const paths = supervisorPaths(root, 'codex', 'default')
    const events: string[] = []
    let spawned = 0
    const children = [
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { detached: true, stdio: 'ignore' }),
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { detached: true, stdio: 'ignore' }),
    ]
    const hostStartedAt = await processStartIdentity(process.pid)
    try {
      await runSupervisorCommandWithStartupGate(parseCordisXCli(['start']), {
        env: { CORDISX_HOME: root },
        stdout: () => undefined,
        stderr: new PassThrough(),
        internalOpenStartupGate: async () => {
          events.push('visible')
          return fakeGate(events, ['retry'])
        },
        internalSpawnSupervisor: () => {
          const attempt = ++spawned
          void (async () => {
            for (;;) {
              const state = await readSupervisorState(paths)
              if (state !== undefined) {
                await writeSupervisorState(
                  paths,
                  attempt === 1
                    ? {
                      ...state,
                      phase: 'failed',
                      failure: 'provider setup failed',
                      failedAt: new Date().toISOString(),
                    }
                    : {
                      ...state,
                      phase: 'ready',
                      hostPid: process.pid,
                      hostProcessStartedAt: hostStartedAt!,
                      cdpEndpoint: 'http://127.0.0.1:49992',
                    },
                )
                return
              }
              await new Promise(resolve => setTimeout(resolve, 5))
            }
          })()
          return children[attempt - 1]!
        },
      })

      expect(spawned).toBe(2)
      expect(events.some(event => event === 'failed:provider setup failed')).toBe(true)
      expect(events.at(-2)).toBe('ready')
      expect(events.at(-1)).toBe('closed')
    } finally {
      for (const child of children) {
        try {
          process.kill(-child.pid!, 'SIGKILL')
        } catch { /* already stopped */ }
      }
    }
  })

  it('reuses an already-ready Host without asking the gate to hide it again', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-startup-gate-ready-'))
    const paths = supervisorPaths(root, 'codex', 'default')
    const startedAt = await processStartIdentity(process.pid)
    const firstEvents: string[] = []
    let spawned = 0

    await runSupervisorCommandWithStartupGate(parseCordisXCli(['start']), {
      env: { CORDISX_HOME: root },
      stdout: () => undefined,
      stderr: new PassThrough(),
      internalOpenStartupGate: async () => {
        firstEvents.push('visible')
        return fakeGate(firstEvents)
      },
      internalSpawnSupervisor: () => {
        spawned += 1
        void (async () => {
          for (;;) {
            const state = await readSupervisorState(paths)
            if (state !== undefined) {
              await writeSupervisorState(paths, {
                ...state,
                phase: 'ready',
                hostPid: process.pid,
                hostProcessStartedAt: startedAt!,
                cdpEndpoint: 'http://127.0.0.1:49993',
              })
              return
            }
            await new Promise(resolve => setTimeout(resolve, 5))
          }
        })()
        return { pid: process.pid, unref: () => undefined }
      },
    })

    const repeatedEvents: string[] = []
    await runSupervisorCommandWithStartupGate(parseCordisXCli(['start']), {
      env: { CORDISX_HOME: root },
      stdout: () => undefined,
      stderr: new PassThrough(),
      internalOpenStartupGate: async () => {
        repeatedEvents.push('visible')
        return fakeGate(repeatedEvents)
      },
      internalSpawnSupervisor: () => {
        throw new Error('already-ready activation must not spawn another supervisor')
      },
    })

    expect(spawned).toBe(1)
    expect(firstEvents).toContain('host-hidden')
    expect(repeatedEvents).toEqual([
      'visible',
      'stage:正在检查运行配置',
      'stage:正在完成启动',
      'ready',
      'closed',
    ])
  })
})
