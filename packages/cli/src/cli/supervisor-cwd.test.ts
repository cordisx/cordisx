import { spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureHomeConfig } from '../config/home-config.js'
import { launchFingerprint } from './launch-fingerprint.js'
import { type CordisXManagedInvocation, parseCordisXCli } from './parse.js'
import { runSupervisorCommand } from './supervisor-command.js'
import { processStartIdentity, readSupervisorState, supervisorPaths, writeSupervisorState } from './supervisor-state.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-cwd-'))
  roots.push(root)
  const home = path.join(root, 'home')
  await ensureHomeConfig({ env: { CORDISX_HOME: home } })
  const cwd = path.join(root, 'physical', 'work')
  await mkdir(cwd, { recursive: true })
  const canonical = await realpath(cwd)
  const alias = path.join(root, 'alias')
  await symlink(cwd, alias)
  const invocation = parseCordisXCli([
    'start',
    '--json',
    '--executable',
    '../bin/host',
    '--profile-dir',
    './profile',
  ]) as CordisXManagedInvocation
  const source = await readFile(path.join(home, 'config.json'), 'utf8')
  const paths = supervisorPaths(home, 'codex', 'default')
  const fingerprint = (workingDirectory: string) =>
    launchFingerprint({
      source,
      options: invocation.options,
      hostArgs: [],
      dataMode: 'shared',
      cwd: workingDirectory,
      codexHome: path.resolve(workingDirectory, '../account'),
    })
  const state = {
    schemaVersion: 1 as const,
    appId: 'codex',
    profileId: 'default',
    phase: 'ready' as const,
    pid: process.pid,
    processStartedAt: (await processStartIdentity(process.pid))!,
    instanceToken: 'a'.repeat(64),
    createdAt: new Date().toISOString(),
    version: JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version as string,
    effectiveConfig: fingerprint(canonical),
  }
  await writeSupervisorState(paths, state)
  const spawn = vi.fn(() => {
    throw new Error('unexpected spawn')
  })
  const runtime = {
    env: { CORDISX_HOME: home, CODEX_HOME: '../account' },
    stdout: vi.fn(),
    stderr: new PassThrough(),
    internalSpawnSupervisor: spawn,
  }
  return { root, paths, invocation, canonical, alias, fingerprint, state, spawn, runtime }
}

describe('managed launch working directory identity', () => {
  it('reuses one instance through a cwd symlink with the same relative launch inputs', async () => {
    const f = await fixture()
    // This is a plain Node probe of OS cwd semantics, never a native Host.
    const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], {
      cwd: f.alias,
      encoding: 'utf8',
    })
    expect(probe.status).toBe(0)
    expect(probe.stdout).toBe(f.canonical)
    const result = await runSupervisorCommand(f.invocation, { ...f.runtime, cwd: f.alias })
    expect(result?.state.pid).toBe(process.pid)
    expect(result?.target.fingerprint).toBe(f.fingerprint(probe.stdout))
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('still rejects a different real cwd or a different running version', async () => {
    const f = await fixture()
    const other = path.join(f.root, 'other')
    await mkdir(other)
    await expect(runSupervisorCommand(f.invocation, { ...f.runtime, cwd: other })).rejects.toThrow(
      'run `cordisx restart` explicitly',
    )
    await writeSupervisorState(f.paths, { ...f.state, version: 'different-version' })
    await expect(runSupervisorCommand(f.invocation, { ...f.runtime, cwd: f.alias })).rejects.toThrow(
      'run `cordisx restart` explicitly',
    )
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('does not create a missing cwd or reinterpret it as the nearest existing directory', async () => {
    const f = await fixture()
    const missing = path.join(f.alias, 'missing')
    await expect(runSupervisorCommand(f.invocation, { ...f.runtime, cwd: missing })).rejects.toThrow(
      'run `cordisx restart` explicitly',
    )
    await expect(access(missing)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readSupervisorState(f.paths))?.effectiveConfig).toBe(f.state.effectiveConfig)
    expect(f.spawn).not.toHaveBeenCalled()
  })
})
