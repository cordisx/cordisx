import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ONLINE_DEVTOOLS_ORIGIN,
  assertLoopbackPortAvailable,
  codexExecutableCandidates,
  codexLaunchArgs,
  defaultIsolatedProfileDir,
  findFreeLoopbackPort,
  launchCodex,
  prepareIsolatedCodexProfile,
  projectProfileKey,
  resolveCodexExecutable,
  terminateIsolatedCodex,
} from '../packages/cli/src/launcher/process.js'

describe('isolated Codex process support', () => {
  it('creates a stable project profile without inventing an isolated HOME', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-profile-test-'))
    const profileDir = path.join(directory, 'codex-app-profile')
    try {
      const profile = await prepareIsolatedCodexProfile('/project/example', {
        cordisxHomeDir: path.join(directory, 'home'),
        explicitProfileDir: profileDir,
      })
      expect(profile).toEqual({ userDataDir: profileDir, cleanupOwned: false })
      await expect(access(profile.userDataDir)).resolves.toBeUndefined()
      if (process.platform !== 'win32') expect((await stat(profile.userDataDir)).mode & 0o777).toBe(0o700)
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it('derives deterministic and checkout-specific default profile paths', () => {
    const home = path.join(path.sep, 'selected', 'cordisx-home')
    expect(projectProfileKey('/work/alpha')).toBe(projectProfileKey('/work/alpha'))
    expect(projectProfileKey('/work/alpha')).not.toBe(projectProfileKey('/other/alpha'))
    expect(defaultIsolatedProfileDir('/work/alpha', home)).toContain(path.join(home, 'projects'))
    expect(defaultIsolatedProfileDir('/work/alpha', home)).not.toContain(path.join(os.homedir(), '.cordisx'))
    expect(defaultIsolatedProfileDir('/work/alpha', home)).toMatch(/codex-app-profile$/)
  })

  it('puts enforced isolation and loopback arguments after user arguments', async () => {
    const profile = { userDataDir: '/safe/profile', cleanupOwned: true }
    const args = codexLaunchArgs(43123, ['--remote-debugging-port=1', '--user-data-dir=/unsafe'], profile, true)
    expect(args.slice(-4)).toEqual([
      '--user-data-dir=/safe/profile',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=43123',
      `--remote-allow-origins=http://127.0.0.1:43123,${ONLINE_DEVTOOLS_ORIGIN}`,
    ])
  })

  it('allocates a valid ephemeral port', async () => {
    const port = await findFreeLoopbackPort()
    expect(port).toBeGreaterThanOrEqual(1024)
    expect(port).toBeLessThanOrEqual(65535)
  })

  it('does not derive a Windows executable from cwd when LOCALAPPDATA is missing or relative', () => {
    expect(codexExecutableCandidates('win32', {}, 'C:\\Users\\example')).toEqual([])
    expect(codexExecutableCandidates('win32', { LOCALAPPDATA: 'relative' }, 'C:\\Users\\example')).toEqual([])
    expect(codexExecutableCandidates('win32', { LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local' }))
      .toEqual([
        'C:\\Users\\example\\AppData\\Local\\Programs\\Codex\\Codex.exe',
        'C:\\Users\\example\\AppData\\Local\\Programs\\ChatGPT\\ChatGPT.exe',
      ])
  })

  it('rejects a directory passed as an explicit executable', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-executable-test-'))
    try {
      await expect(resolveCodexExecutable(directory)).rejects.toThrow('host executable is not a regular file')
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it('rejects an occupied explicit loopback port', async () => {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing test port')
    try {
      await expect(assertLoopbackPortAvailable(address.port)).rejects.toThrow(
        `loopback CDP port is unavailable: ${address.port}`,
      )
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    }
  })

  it('terminates only the exact launched child and leaves a sibling alive', async () => {
    const script = 'setInterval(() => {}, 1000)'
    const launched = spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
    const sibling = spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
    try {
      await terminateIsolatedCodex(launched)
      expect(launched.exitCode !== null || launched.signalCode !== null).toBe(true)
      expect(sibling.exitCode).toBeNull()
      expect(sibling.signalCode).toBeNull()
    } finally {
      if (sibling.exitCode === null && sibling.signalCode === null) sibling.kill('SIGTERM')
    }
  })

  it.skipIf(process.platform === 'win32')('cleans the full launcher-owned Host process group', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-launch-group-test-'))
    const executable = path.join(directory, 'fake-host')
    const descendantPidPath = path.join(directory, 'descendant.pid')
    const profile = { userDataDir: path.join(directory, 'profile'), cleanupOwned: true }
    let launched: ReturnType<typeof launchCodex> | undefined
    let descendantPid: number | undefined
    try {
      await writeFile(executable, `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
if (process.argv.includes('--descendant')) setInterval(() => {}, 1000)
else {
const child = spawn(process.argv[1], ['--descendant', '--database=${profile.userDataDir}/Crashpad'], { stdio: 'ignore', detached: true })
writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid))
setInterval(() => {}, 1000)
}
`)
      await chmod(executable, 0o755)
      launched = launchCodex(executable, 43123, [], profile)
      for (let attempt = 0; attempt < 50; attempt += 1) {
        descendantPid = Number(await readFile(descendantPidPath, 'utf8').catch(() => '0'))
        if (Number.isInteger(descendantPid) && descendantPid > 0) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(descendantPid).toBeGreaterThan(0)
      await terminateIsolatedCodex(launched, profile)
      for (let attempt = 0; attempt < 50 && descendantPid !== undefined; attempt += 1) {
        try {
          process.kill(descendantPid, 0)
          await new Promise(resolve => setTimeout(resolve, 20))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') break
          throw error
        }
      }
      expect(() => process.kill(descendantPid!, 0)).toThrow(/ESRCH/)
    } finally {
      if (launched !== undefined && launched.exitCode === null && launched.signalCode === null) {
        await terminateIsolatedCodex(launched, profile).catch(() => undefined)
      }
      if (descendantPid !== undefined) {
        try { process.kill(descendantPid, 'SIGKILL') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      await rm(directory, { recursive: true, force: true })
    }
  })
})
