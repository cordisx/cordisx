import { mkdtemp, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCordisXCli } from '../packages/cli/src/cli/parse.js'
import { runSupervisorCommand } from '../packages/cli/src/cli/supervisor-command.js'
import { createSupervisorRuntime } from '../packages/cli/src/cli/supervisor-runtime.js'
import {
  acquireSupervisorStartLock,
  processStartIdentity,
  readSupervisorState,
  removeSupervisorState,
  supervisorPaths,
  writeSupervisorState,
} from '../packages/cli/src/cli/supervisor-state.js'

async function published(paths: ReturnType<typeof supervisorPaths>) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const state = await readSupervisorState(paths)
    if (state !== undefined) return state
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('fixture did not publish its generation')
}

describe('supervisor readiness generation', () => {
  it('lets an unpublished orphan child exit without Host effects or a retained mutex', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cx-orphan-'))
    const paths = supervisorPaths(root, 'codex', 'default')
    const release = await acquireSupervisorStartLock(paths)
    await writeFile(paths.bootstrapToken, 'b'.repeat(64), { mode: 0o600 })
    const moduleUrl = new URL('../packages/cli/src/cli/supervisor-runtime.ts', import.meta.url).href
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { createSupervisorRuntime } from ${JSON.stringify(moduleUrl)};
       try {
         const runtime = await createSupervisorRuntime(process.env, { publicationTimeoutMs: 150 });
         await runtime.close();
         process.stdout.write('unexpected publication');
       } catch (error) {
         process.stderr.write(error.message);
         process.exitCode = 1;
       }`,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        CORDISX_SUPERVISOR_HOME: root,
        CORDISX_SUPERVISOR_APP: 'codex',
        CORDISX_SUPERVISOR_PROFILE: 'default',
        CORDISX_SUPERVISOR_FINGERPRINT: 'orphan',
        CORDISX_SUPERVISOR_TOKEN_FILE: paths.bootstrapToken,
      },
    })
    let stderr = ''
    let stdout = ''
    child.stderr.on('data', value => {
      stderr += String(value)
    })
    child.stdout.on('data', value => {
      stdout += String(value)
    })
    const exited = once(child, 'exit')
    try {
      // Simulate loss of the publishing parent's ownership, without publishing.
      await release()
      expect(await exited).toEqual([1, null])
      expect(stderr).toContain('timed out waiting for background supervisor publication')
      expect(stdout).toBe('')
      expect(await readSupervisorState(paths)).toBeUndefined()
      const next = await acquireSupervisorStartLock(paths)
      await next()
    } finally {
      await release()
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await exited
      }
    }
  })

  it('does not let a replaced start return another generation as its success', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cx-generation-'))
    const paths = supervisorPaths(root, 'codex', 'default')
    const output: string[] = []
    const start = runSupervisorCommand(parseCordisXCli(['start']), {
      env: { CORDISX_HOME: root },
      stdout: line => output.push(line),
      internalSupervisorReadinessTimeoutMs: 500,
      internalSpawnSupervisor: () => ({ pid: process.pid, unref: () => undefined }),
    })
    const result = start.then(() => undefined, error => error as Error)
    const first = await published(paths)
    const replacement = { ...first, instanceToken: 'f'.repeat(64), phase: 'ready' as const }
    await writeSupervisorState(paths, replacement)
    expect(await result).toMatchObject({ message: 'CordisX background supervisor generation was replaced' })
    expect(output).toEqual([])
    expect(await readSupervisorState(paths)).toEqual(replacement)
  })

  it('ends a removed generation promptly without waiting for renderer timeout', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cx-generation-'))
    const paths = supervisorPaths(root, 'codex', 'default')
    const start = runSupervisorCommand(parseCordisXCli(['start']), {
      env: { CORDISX_HOME: root },
      internalSupervisorReadinessTimeoutMs: 500,
      internalSpawnSupervisor: () => ({ pid: process.pid, unref: () => undefined }),
    })
    const result = start.then(() => undefined, error => error as Error)
    await published(paths)
    await removeSupervisorState(paths)
    expect(await result).toMatchObject({ message: 'CordisX background supervisor state was stopped or removed' })
    expect(await readSupervisorState(paths)).toBeUndefined()
  })

  it('recovers proven-dead state on start alone and composes the real publication handshake', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cx-generation-'))
    const paths = supervisorPaths(root, 'codex', 'default')
    await writeSupervisorState(paths, {
      schemaVersion: 1,
      appId: 'codex',
      profileId: 'default',
      phase: 'starting',
      pid: process.pid,
      processStartedAt: 'not this process',
      instanceToken: 'a'.repeat(64),
      createdAt: new Date().toISOString(),
      version: 'old',
      effectiveConfig: 'old',
    })
    let child: Promise<Awaited<ReturnType<typeof createSupervisorRuntime>>> | undefined
    let spawned = 0
    const output: string[] = []
    try {
      const runtime = {
        env: { CORDISX_HOME: root },
        stdout: (line: string) => output.push(line),
        internalSupervisorReadinessTimeoutMs: 2_000,
        internalSpawnSupervisor: (input: { env: NodeJS.ProcessEnv }) => {
          spawned++
          child = createSupervisorRuntime(input.env).then(async supervisor => {
            await supervisor.markReady(43123)
            return supervisor
          })
          return { pid: process.pid, unref: () => undefined }
        },
      }
      await Promise.all([
        runSupervisorCommand(parseCordisXCli(['start', '--json']), runtime),
        runSupervisorCommand(parseCordisXCli(['start', '--json']), runtime),
      ])
      expect(spawned).toBe(1)
      expect(output.map(line => JSON.parse(line))).toEqual([
        expect.objectContaining({ status: 'ready', pid: process.pid }),
        expect.objectContaining({ status: 'ready', pid: process.pid }),
      ])
      expect(await readSupervisorState(paths)).toMatchObject({
        processStartedAt: await processStartIdentity(process.pid),
        phase: 'ready',
      })
    } finally {
      await (await child)?.close()
    }
  })
})
