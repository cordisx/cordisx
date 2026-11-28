import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { launchFingerprint } from '../packages/cli/src/cli/launch-fingerprint.js'
import { parseCordisXCli } from '../packages/cli/src/cli/parse.js'
import { runSupervisorCommand } from '../packages/cli/src/cli/supervisor-command.js'
import {
  acquireSupervisorStartLock,
  clientSupervisorPaths,
  processStartIdentity,
  readSupervisorState,
  supervisorPaths,
  writeSupervisorState,
} from '../packages/cli/src/cli/supervisor-state.js'

vi.mock('../packages/cli/src/cli/startup-caller-wait.js', () => ({ waitForStartupCaller: async () => {} }))

it('publishes one cancellable client while its service starts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-client-starts-owner-'))
  const ownerPaths = supervisorPaths(root, 'codex', 'default')
  const clientPaths = clientSupervisorPaths(root, 'codex', 'default')
  let started = 0
  const output: string[] = []
  try {
    await writeFile(path.join(root, 'config.json'), JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
    const runtime = {
      env: { CORDISX_HOME: root },
      stdout: (line: string) => output.push(line),
      internalSupervisorReadinessTimeoutMs: 5_000,
      internalSpawnSupervisor: (input: { args: readonly string[] }) => {
        expect(input.args).toContain('run')
        started++
        void (async () => {
          for (let attempt = 0; attempt < 200; attempt++) {
            const current = await readSupervisorState(clientPaths)
            if (current) {
              await writeSupervisorState(ownerPaths, {
                ...current,
                mode: 'service',
                clientOfService: undefined,
                phase: 'ready',
                effectiveConfig: 'service',
              })
              await writeSupervisorState(clientPaths, { ...current, phase: 'ready', clientConnection: 'connected' })
              return
            }
            await new Promise(resolve => setTimeout(resolve, 5))
          }
        })()
        return { pid: process.pid, unref: () => undefined }
      },
    }
    const invocation = parseCordisXCli(['start', 'codex', '--json'])
    await Promise.all([runSupervisorCommand(invocation, runtime), runSupervisorCommand(invocation, runtime)])
    expect(started).toBe(1)
    expect((await readSupervisorState(ownerPaths))?.mode).toBe('service')
    expect(await readSupervisorState(clientPaths)).toMatchObject({
      clientOfService: true,
      clientConnection: 'connected',
    })
    expect(output.map(line => JSON.parse(line).connection)).toEqual(['connected', 'connected'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 10_000)

it('stops a starting client without waiting for a service owner to appear', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-client-cancel-start-'))
  const clientPaths = clientSupervisorPaths(root, 'codex', 'default')
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  try {
    const pending = runSupervisorCommand(parseCordisXCli(['start', 'codex', '--json']), {
      env: { CORDISX_HOME: root },
      stdout: () => {},
      internalSupervisorReadinessTimeoutMs: 5_000,
      internalSpawnSupervisor: () => child,
    })
    const rejected = expect(pending).rejects.toThrow(/stopped|removed|exited/u)
    await vi.waitFor(async () =>
      expect(await readSupervisorState(clientPaths)).toMatchObject({
        phase: 'starting',
        clientOfService: true,
      })
    )
    await runSupervisorCommand(parseCordisXCli(['stop', 'codex', '--json']), {
      env: { CORDISX_HOME: root },
      stdout: () => {},
      internalSupervisorReadinessTimeoutMs: 5_000,
    })
    await rejected
    expect(await readSupervisorState(clientPaths)).toBeUndefined()
    expect(() => process.kill(child.pid!, 0)).toThrow()
  } finally {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch { /* Already stopped. */ }
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

it(
  'restarts a missing service for an explicitly started disconnected client without spawning another App',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cx-client-recover-owner-'))
    const ownerPaths = supervisorPaths(root, 'codex', 'default')
    const clientPaths = clientSupervisorPaths(root, 'codex', 'default')
    const invocation = parseCordisXCli(['start', 'codex', '--json'])
    if (invocation.action !== 'start') throw new Error('expected start')
    const version = JSON.parse(await readFile(new URL('../packages/cli/package.json', import.meta.url), 'utf8')).version
    const source = JSON.stringify(createDefaultHomeConfig())
    const output: string[] = []
    try {
      await writeFile(path.join(root, 'config.json'), source, { mode: 0o600 })
      await writeSupervisorState(clientPaths, {
        schemaVersion: 1,
        appId: 'codex',
        profileId: 'default',
        clientOfService: true,
        clientConnection: 'disconnected',
        phase: 'ready',
        pid: process.pid,
        processStartedAt: (await processStartIdentity(process.pid))!,
        instanceToken: 'a'.repeat(64),
        createdAt: new Date().toISOString(),
        version,
        effectiveConfig: launchFingerprint({
          source,
          options: invocation.options,
          hostArgs: [],
          dataMode: 'shared',
          cwd: await realpath(process.cwd()),
        }),
      })
      const spawn = vi.fn((input: { args: readonly string[] }) => {
        expect(input.args).toContain('service-owner')
        void (async () => {
          for (let attempt = 0; attempt < 200; attempt++) {
            const owner = await readSupervisorState(ownerPaths)
            const client = await readSupervisorState(clientPaths)
            if (owner && client) {
              await writeSupervisorState(ownerPaths, { ...owner, phase: 'ready' })
              await writeSupervisorState(clientPaths, { ...client, clientConnection: 'connected' })
              return
            }
            await new Promise(resolve => setTimeout(resolve, 5))
          }
        })()
        return { pid: process.pid, unref: () => undefined }
      })
      const runtime = {
        env: { CORDISX_HOME: root },
        stdout: (line: string) => output.push(line),
        internalSupervisorReadinessTimeoutMs: 5_000,
        internalSpawnSupervisor: spawn,
      }
      await Promise.all([runSupervisorCommand(invocation, runtime), runSupervisorCommand(invocation, runtime)])
      expect(spawn).toHaveBeenCalledOnce()
      expect(output.map(line => JSON.parse(line).connection)).toEqual(['connected', 'connected'])
      expect((await readSupervisorState(clientPaths))?.pid).toBe(process.pid)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  10_000,
)

it('waits for an already-starting service and uses its completed configuration for the native client', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-client-waits-owner-'))
  const configPath = path.join(root, 'config.json')
  const ownerPaths = supervisorPaths(root, 'codex', 'default')
  const clientPaths = clientSupervisorPaths(root, 'codex', 'default')
  const invocation = parseCordisXCli(['start', 'codex', '--json'])
  if (invocation.action !== 'start') throw new Error('expected start')
  const startedAt = (await processStartIdentity(process.pid))!
  const version = JSON.parse(await readFile(new URL('../packages/cli/package.json', import.meta.url), 'utf8')).version
  const owner = {
    schemaVersion: 1 as const,
    appId: 'codex',
    profileId: 'default',
    mode: 'service' as const,
    phase: 'starting' as const,
    pid: process.pid,
    processStartedAt: startedAt,
    instanceToken: 'a'.repeat(64),
    createdAt: new Date().toISOString(),
    version,
    effectiveConfig: 'service',
  }
  let spawned = 0
  let observedFingerprint: string | undefined
  try {
    await writeFile(configPath, JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
    await writeSupervisorState(ownerPaths, owner)
    const pending = runSupervisorCommand(invocation, {
      env: { CORDISX_HOME: root },
      stdout: () => {},
      internalSupervisorReadinessTimeoutMs: 5_000,
      internalSpawnSupervisor: input => {
        spawned++
        observedFingerprint = input.env.CORDISX_SUPERVISOR_FINGERPRINT
        void (async () => {
          for (let attempt = 0; attempt < 200; attempt++) {
            const client = await readSupervisorState(clientPaths)
            if (client) {
              await writeSupervisorState(clientPaths, { ...client, phase: 'ready', clientConnection: 'connected' })
              return
            }
            await new Promise(resolve => setTimeout(resolve, 5))
          }
        })()
        return { pid: process.pid, unref: () => undefined }
      },
    })
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(spawned).toBe(0)
    const config = createDefaultHomeConfig()
    const source = JSON.stringify({
      ...config,
      apps: {
        codex: {
          ...config.apps.codex!,
          profiles: { default: { displayName: 'Ready', dataMode: 'shared' } },
        },
      },
    })
    await writeFile(configPath, source)
    await writeSupervisorState(ownerPaths, { ...owner, phase: 'ready' })
    await pending
    expect(spawned).toBe(1)
    expect(observedFingerprint).toBe(launchFingerprint({
      source,
      options: invocation.options,
      hostArgs: [],
      dataMode: 'shared',
      cwd: await realpath(process.cwd()),
    }))
    expect((await readSupervisorState(ownerPaths))?.instanceToken).toBe(owner.instanceToken)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 10_000)

it('reselects the client when the service publishes after acquiring its startup lock', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-client-owner-publication-'))
  const ownerPaths = supervisorPaths(root, 'codex', 'default')
  const clientPaths = clientSupervisorPaths(root, 'codex', 'default')
  const version = JSON.parse(await readFile(new URL('../packages/cli/package.json', import.meta.url), 'utf8')).version
  await writeFile(path.join(root, 'config.json'), JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
  const release = await acquireSupervisorStartLock(ownerPaths)
  let released = false
  let spawnedAsClient = false
  try {
    const pending = runSupervisorCommand(parseCordisXCli(['start', 'codex', '--json']), {
      env: { CORDISX_HOME: root },
      stdout: () => {},
      internalSupervisorReadinessTimeoutMs: 5_000,
      internalSpawnSupervisor: input => {
        spawnedAsClient = input.env.CORDISX_SUPERVISOR_CLIENT === '1'
        void (async () => {
          for (let attempt = 0; attempt < 200; attempt++) {
            const state = await readSupervisorState(clientPaths)
            if (state) {
              await writeSupervisorState(clientPaths, { ...state, phase: 'ready', clientConnection: 'connected' })
              return
            }
            await new Promise(resolve => setTimeout(resolve, 5))
          }
        })()
        return { pid: process.pid, unref: () => undefined }
      },
    })
    await new Promise(resolve => setTimeout(resolve, 150))
    await writeSupervisorState(ownerPaths, {
      schemaVersion: 1,
      appId: 'codex',
      profileId: 'default',
      mode: 'service',
      phase: 'ready',
      pid: process.pid,
      processStartedAt: (await processStartIdentity(process.pid))!,
      instanceToken: 'a'.repeat(64),
      createdAt: new Date().toISOString(),
      version,
      effectiveConfig: 'service',
    })
    await release()
    released = true
    await pending
    expect(spawnedAsClient).toBe(true)
    expect((await readSupervisorState(ownerPaths))?.mode).toBe('service')
  } finally {
    if (!released) await release()
    await rm(root, { recursive: true, force: true })
  }
}, 10_000)

it('does not start a client if the service generation changes while waiting', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-client-owner-changed-'))
  const ownerPaths = supervisorPaths(root, 'codex', 'default')
  const owner = {
    schemaVersion: 1 as const,
    appId: 'codex',
    profileId: 'default',
    mode: 'service' as const,
    phase: 'starting' as const,
    pid: process.pid,
    processStartedAt: (await processStartIdentity(process.pid))!,
    instanceToken: 'a'.repeat(64),
    createdAt: new Date().toISOString(),
    version: 'fixture',
    effectiveConfig: 'service',
  }
  const spawn = vi.fn(() => ({ pid: process.pid, unref: () => undefined }))
  try {
    await writeFile(path.join(root, 'config.json'), JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
    await writeSupervisorState(ownerPaths, owner)
    const pending = runSupervisorCommand(parseCordisXCli(['start', 'codex', '--json']), {
      env: { CORDISX_HOME: root },
      stdout: () => {},
      internalSupervisorReadinessTimeoutMs: 5_000,
      internalSpawnSupervisor: spawn,
    })
    await new Promise(resolve => setTimeout(resolve, 150))
    await writeSupervisorState(ownerPaths, { ...owner, phase: 'ready', instanceToken: 'b'.repeat(64) })
    await expect(pending).rejects.toThrow('supervisor generation was replaced')
    expect(spawn).not.toHaveBeenCalled()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 10_000)
