import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCordisXCli } from '../packages/cli/src/cli/parse.js'
import { runSupervisorCommand } from '../packages/cli/src/cli/supervisor-command.js'
import {
  processStartIdentity,
  readSupervisorState,
  supervisorPaths,
  writeSupervisorState,
} from '../packages/cli/src/cli/supervisor-state.js'
import { requestSupervisorStop, startSupervisorControlServer } from '../packages/cli/src/cli/supervisor-control.js'

describe('supervisor management commands', () => {
  it('emits stable status JSON and marks a stale starting record failed instead of trusting its PID', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-supervisor-command-'))
    const output: string[] = []
    await runSupervisorCommand(parseCordisXCli(['status', '--json']), {
      env: { CORDISX_HOME: root },
      stdout: value => output.push(value),
    })
    expect(JSON.parse(output.pop()!)).toEqual({
      app: 'codex',
      profile: 'default',
      status: 'stopped',
      pid: null,
      uptime: 0,
      version: '0.1.0-beta.6',
      cdpEndpoint: null,
    })
    const paths = supervisorPaths(root, 'codex', 'default')
    await writeSupervisorState(paths, {
      schemaVersion: 1,
      appId: 'codex',
      profileId: 'default',
      phase: 'ready',
      pid: process.pid,
      processStartedAt: 'reused pid',
      instanceToken: 'a'.repeat(32),
      createdAt: new Date().toISOString(),
      version: '0.1.0-beta.6',
      effectiveConfig: 'old',
    })
    await runSupervisorCommand(parseCordisXCli(['status', '--json']), {
      env: { CORDISX_HOME: root },
      stdout: value => output.push(value),
    })
    expect(JSON.parse(output.pop()!)).toMatchObject({
      status: 'failed',
      pid: null,
      failure: 'CordisX background supervisor exited before renderer readiness',
    })
  })

  it('rejects an idempotent start whose effective configuration differs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-supervisor-command-'))
    const startedAt = await processStartIdentity(process.pid)
    const paths = supervisorPaths(root, 'codex', 'default')
    await writeSupervisorState(paths, {
      schemaVersion: 1,
      appId: 'codex',
      profileId: 'default',
      phase: 'ready',
      pid: process.pid,
      processStartedAt: startedAt!,
      instanceToken: 'b'.repeat(32),
      createdAt: new Date().toISOString(),
      version: '0.1.0-beta.6',
      effectiveConfig: 'different',
    })
    await expect(runSupervisorCommand(parseCordisXCli(['start']), { env: { CORDISX_HOME: root } }))
      .rejects.toThrow('run `cordisx restart` explicitly')
  })

  it('serializes concurrent starts and returns the one ready instance without a duplicate spawn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-supervisor-command-'))
    const paths = supervisorPaths(root, 'codex', 'default')
    let spawned = 0
    const output: string[] = []
    const runtime = {
      env: { CORDISX_HOME: root },
      stdout: (line: string) => output.push(line),
      internalSpawnSupervisor: () => {
        spawned++
        void (async () => {
          for (;;) {
            const state = await readSupervisorState(paths)
            if (state !== undefined) {
              await writeSupervisorState(paths, { ...state, phase: 'ready', cdpEndpoint: 'http://127.0.0.1:49999' })
              return
            }
            await new Promise(resolve => setTimeout(resolve, 5))
          }
        })()
        return { pid: process.pid, unref: () => undefined }
      },
    }
    await Promise.all([
      runSupervisorCommand(parseCordisXCli(['start', '--json']), runtime),
      runSupervisorCommand(parseCordisXCli(['start', '--json']), runtime),
    ])
    expect(spawned).toBe(1)
    expect(output.map(line => JSON.parse(line))).toEqual([
      expect.objectContaining({ status: 'ready', pid: process.pid, cdpEndpoint: 'http://127.0.0.1:49999' }),
      expect.objectContaining({ status: 'ready', pid: process.pid, cdpEndpoint: 'http://127.0.0.1:49999' }),
    ])
  })

  it('terminates a timed-out detached startup and leaves an inspectable failed state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-supervisor-command-'))
    const paths = supervisorPaths(root, 'codex', 'default')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { detached: true, stdio: 'ignore' })
    const output: string[] = []
    try {
      await expect(runSupervisorCommand(parseCordisXCli(['start']), {
        env: { CORDISX_HOME: root },
        internalSupervisorReadinessTimeoutMs: 75,
        internalSpawnSupervisor: () => child,
      })).rejects.toThrow('timed out waiting for CordisX renderer readiness')

      const failed = await readSupervisorState(paths)
      expect(failed).toMatchObject({
        phase: 'failed',
        pid: child.pid,
        failure: 'timed out waiting for CordisX renderer readiness',
      })
      await expect(runSupervisorCommand(parseCordisXCli(['status', '--json']), {
        env: { CORDISX_HOME: root },
        stdout: line => output.push(line),
      })).resolves.toBeUndefined()
      expect(JSON.parse(output.pop()!)).toMatchObject({ status: 'failed', pid: null })
      await expect(readSupervisorState(paths)).resolves.toMatchObject({ phase: 'failed' })
      expect(() => process.kill(child.pid!, 0)).toThrow()
    } finally {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch { /* timeout cleanup already stopped it */ }
    }
  }, 15_000)

  it('follows new log bytes until the owned caller cancels', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-supervisor-command-'))
    const paths = supervisorPaths(root, 'codex', 'default')
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.log, 'first\n', { flag: 'a' })
    const controller = new AbortController()
    const lines: string[] = []
    const pending = runSupervisorCommand(parseCordisXCli(['logs', '--follow']), {
      env: { CORDISX_HOME: root },
      stdout: line => lines.push(line),
      internalSignal: controller.signal,
    })
    await new Promise(resolve => setTimeout(resolve, 130))
    await writeFile(paths.log, 'second\n', { flag: 'a' })
    await new Promise(resolve => setTimeout(resolve, 130))
    controller.abort()
    await pending
    expect(lines).toEqual(['first', 'second'])
  })

  it('requires the instance token on the private Unix control socket', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-supervisor-control-'))
    const socket = path.join(root, 'control.sock')
    let stopped = false
    const server = await startSupervisorControlServer({
      socketPath: socket,
      token: 'c'.repeat(64),
      stop: () => {
        stopped = true
      },
    })
    try {
      expect(await requestSupervisorStop(socket, 'wrong')).toBe(false)
      expect(stopped).toBe(false)
      expect(await requestSupervisorStop(socket, 'c'.repeat(64))).toBe(true)
      expect(stopped).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('stops only the fenced detached process group for the selected instance', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-supervisor-command-'))
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { detached: true, stdio: 'ignore' })
    const host = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { detached: true, stdio: 'ignore' })
    const paths = supervisorPaths(root, 'codex', 'default')
    try {
      const startedAt = await processStartIdentity(child.pid!)
      const hostStartedAt = await processStartIdentity(host.pid!)
      await writeSupervisorState(paths, {
        schemaVersion: 1,
        appId: 'codex',
        profileId: 'default',
        phase: 'ready',
        pid: child.pid!,
        processStartedAt: startedAt!,
        instanceToken: 'd'.repeat(32),
        createdAt: new Date().toISOString(),
        version: '0.1.0-beta.6',
        effectiveConfig: 'current',
        hostPid: host.pid!,
        hostProcessStartedAt: hostStartedAt!,
      })
      const output: string[] = []
      await runSupervisorCommand(parseCordisXCli(['stop', '--json']), {
        env: { CORDISX_HOME: root },
        stdout: line => output.push(line),
      })
      expect(JSON.parse(output[0]!)).toEqual({ app: 'codex', profile: 'default', status: 'stopped' })
      await expect(readSupervisorState(paths)).resolves.toBeUndefined()
      expect(() => process.kill(host.pid!, 0)).toThrow()
    } finally {
      try {
        process.kill(-child.pid!, 'SIGTERM')
      } catch { /* already stopped */ }
      try {
        process.kill(-host.pid!, 'SIGTERM')
      } catch { /* already stopped */ }
    }
  })
})
