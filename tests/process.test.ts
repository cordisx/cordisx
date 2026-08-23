import { access, mkdtemp, rm } from 'node:fs/promises'
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
      const profile = await prepareIsolatedCodexProfile('/project/example', profileDir)
      expect(profile).toEqual({ userDataDir: profileDir })
      await expect(access(profile.userDataDir)).resolves.toBeUndefined()
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it('derives deterministic and checkout-specific default profile paths', () => {
    expect(projectProfileKey('/work/alpha')).toBe(projectProfileKey('/work/alpha'))
    expect(projectProfileKey('/work/alpha')).not.toBe(projectProfileKey('/other/alpha'))
    expect(defaultIsolatedProfileDir('/work/alpha')).toContain(path.join('.cordisx', 'projects'))
    expect(defaultIsolatedProfileDir('/work/alpha')).toMatch(/codex-app-profile$/)
  })

  it('puts enforced isolation and loopback arguments after user arguments', async () => {
    const profile = { userDataDir: '/safe/profile' }
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
})
