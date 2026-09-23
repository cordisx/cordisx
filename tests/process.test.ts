import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { execFileSync, spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PROCESS_TABLE_MAX_BUFFER_BYTES } from '../packages/cli/src/launcher/process-identity.js'
import {
  assertLoopbackPortAvailable,
  codexExecutableCandidates,
  codexLaunchArgs,
  confirmHiddenCodexOwnership,
  defaultIsolatedProfileDir,
  findFreeLoopbackPort,
  HiddenHostIdentityUnconfirmedError,
  hiddenHostPid,
  hiddenHostPidFromProcessList,
  launchCodex,
  ONLINE_DEVTOOLS_ORIGIN,
  prepareIsolatedCodexProfile,
  projectProfileKey,
  resolveCodexExecutable,
  retainProfileLeaseAfterHiddenHostFailure,
  terminateIsolatedCodex,
} from '../packages/cli/src/launcher/process.js'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})

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

  it('matches hidden Host debug and inspector ports at exact argv boundaries', () => {
    const executable = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'
    const processList = [
      `100 ${executable} --remote-debugging-port=60001 --inspect-brk=127.0.0.1:70001`,
      `101 ${executable} --remote-debugging-port=6000 --inspect-brk=127.0.0.1:70001`,
      `102 ${executable} --remote-debugging-port=6000 --inspect-brk=127.0.0.1:7000`,
    ].join('\n')
    expect(hiddenHostPidFromProcessList(processList, executable, 6000, 7000)).toBe(102)
    expect(hiddenHostPidFromProcessList(processList, executable, 600, 700)).toBeUndefined()
  })

  it('reads the hidden Host command table with the shared large-output boundary', () => {
    const executable = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'
    const padding = `${'x'.repeat(4096)}\n`.repeat(300)
    const processList = `${padding}102 ${executable} --remote-debugging-port=6000\n`
    expect(Buffer.byteLength(processList)).toBeGreaterThan(1024 * 1024)
    vi.mocked(execFileSync).mockReturnValueOnce(processList)

    expect(hiddenHostPid(executable, 6000)).toBe(102)
    expect(execFileSync).toHaveBeenLastCalledWith('ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
      maxBuffer: PROCESS_TABLE_MAX_BUFFER_BYTES,
    })
  })

  it('keeps hidden Host identity unresolved when process enumeration fails', () => {
    expect(hiddenHostPid('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', 6000, undefined, () => {
      throw Object.assign(new Error('fixture process table overflow'), { code: 'ENOBUFS' })
    })).toBeUndefined()
  })

  it('retains the profile lease only when hidden Host identity is unresolved', () => {
    expect(retainProfileLeaseAfterHiddenHostFailure(new HiddenHostIdentityUnconfirmedError())).toBe(true)
    expect(retainProfileLeaseAfterHiddenHostFailure(new Error('ordinary launch failure'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('does not confirm a Host PID whose start identity was never observed', () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      expect(() => confirmHiddenCodexOwnership({ child, hostPid: 2_147_483_647 })).toThrow(
        'Hidden Host launch identity changed before confirmation',
      )
    } finally {
      child.kill('SIGTERM')
    }
  })

  it.skipIf(process.platform === 'win32')('rechecks a cached live Host identity before confirmation', () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const identity = 'Wed Sep 24 00:00:00 2026'
    vi.mocked(execFileSync)
      .mockReturnValueOnce(`2147483646 1 ${identity}\n`)
      .mockReturnValueOnce(`2147483646 1 ${identity}\n`)
      .mockReturnValueOnce('')
      .mockReturnValueOnce('')
    try {
      expect(() => confirmHiddenCodexOwnership({ child, hostPid: 2_147_483_646 })).toThrow(
        'Hidden Host launch identity changed before confirmation',
      )
    } finally {
      child.kill('SIGTERM')
    }
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

  it('prefers the newest installed Codex app bundle on macOS', async () => {
    const home = '/Users/example'
    const candidates = codexExecutableCandidates('darwin', {}, home)
    expect(candidates).toEqual([
      '/Applications/Codex.app/Contents/MacOS/ChatGPT',
      '/Applications/Codex.app/Contents/MacOS/Codex',
      '/Users/example/Applications/Codex.app/Contents/MacOS/ChatGPT',
      '/Users/example/Applications/Codex.app/Contents/MacOS/Codex',
      '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
      '/Users/example/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
    ])

    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-executable-order-test-'))
    const bundledChatGpt = path.join(directory, 'Codex.app', 'Contents', 'MacOS', 'ChatGPT')
    const standaloneChatGpt = path.join(directory, 'ChatGPT.app', 'Contents', 'MacOS', 'ChatGPT')
    try {
      await mkdir(path.dirname(bundledChatGpt), { recursive: true })
      await mkdir(path.dirname(standaloneChatGpt), { recursive: true })
      await writeFile(bundledChatGpt, '')
      await writeFile(standaloneChatGpt, '')
      await chmod(bundledChatGpt, 0o755)
      await chmod(standaloneChatGpt, 0o755)

      const versions = new Map([
        [bundledChatGpt, [7119n]],
        [standaloneChatGpt, [9275n]],
      ])
      await expect(resolveCodexExecutable(
        undefined,
        [bundledChatGpt, standaloneChatGpt],
        async executable => versions.get(executable),
        'darwin',
      )).resolves.toBe(standaloneChatGpt)

      versions.set(bundledChatGpt, [9276n])
      await expect(resolveCodexExecutable(
        undefined,
        [bundledChatGpt, standaloneChatGpt],
        async executable => versions.get(executable),
        'darwin',
      )).resolves.toBe(bundledChatGpt)

      await expect(resolveCodexExecutable(
        undefined,
        [bundledChatGpt, standaloneChatGpt],
        async () => undefined,
        'darwin',
      )).resolves.toBe(bundledChatGpt)
    } finally {
      await rm(directory, { recursive: true })
    }
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
      await new Promise<void>((resolve, reject) =>
        server.close(error => error === undefined ? resolve() : reject(error))
      )
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
      await writeFile(
        executable,
        `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
if (process.argv.includes('--descendant')) setInterval(() => {}, 1000)
else {
const child = spawn(process.argv[1], ['--descendant', '--database=${profile.userDataDir}/Crashpad'], { stdio: 'ignore', detached: true })
writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid))
setInterval(() => {}, 1000)
}
`,
      )
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
        try {
          process.kill(descendantPid, 'SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'stops an exact hidden Host when Launch Services uses another process group',
    async () => {
      const host = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      const waiter = spawn(process.execPath, [
        '-e',
        'const pid = Number(process.argv[1]); setInterval(() => { try { process.kill(pid, 0) } catch { process.exit(0) } }, 25)',
        String(host.pid),
      ], { stdio: 'ignore', detached: true })
      try {
        expect(host.pid).toBeDefined()
        expect(waiter.pid).toBeDefined()
        const group = Number(execFileSync('ps', ['-p', String(host.pid), '-o', 'pgid='], { encoding: 'utf8' }).trim())
        expect(group).not.toBe(host.pid)
        confirmHiddenCodexOwnership({ child: waiter, hostPid: host.pid! })
        await terminateIsolatedCodex(waiter)
        expect(host.exitCode !== null || host.signalCode !== null).toBe(true)
        expect(waiter.exitCode !== null || waiter.signalCode !== null).toBe(true)
      } finally {
        if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL')
        if (waiter.exitCode === null && waiter.signalCode === null) waiter.kill('SIGKILL')
      }
    },
  )

  it.skipIf(process.platform === 'win32')(
    'does not terminate unrelated processes that mention a profile prefix',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-owned-process-test-'))
      const executable = path.join(directory, 'fake-host')
      const profile = { userDataDir: path.join(directory, 'profile'), cleanupOwned: true }
      const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', `${profile.userDataDir}-other`], {
        stdio: 'ignore',
      })
      let launched: ReturnType<typeof launchCodex> | undefined
      try {
        await writeFile(executable, '#!/usr/bin/env node\nsetInterval(() => {}, 1000)\n', { mode: 0o755 })
        launched = launchCodex(executable, 43124, [], profile)
        await new Promise(resolve => setTimeout(resolve, 75))
        await terminateIsolatedCodex(launched, profile)
        expect(unrelated.exitCode).toBeNull()
        expect(unrelated.signalCode).toBeNull()
      } finally {
        if (launched !== undefined && launched.exitCode === null && launched.signalCode === null) {
          await terminateIsolatedCodex(launched, profile).catch(() => undefined)
        }
        if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill('SIGTERM')
        await rm(directory, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform === 'win32')(
    'tracks helpers created while the launched Host is shutting down',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-shutdown-child-test-'))
      const executable = path.join(directory, 'fake-host')
      const childPidPath = path.join(directory, 'shutdown-child.pid')
      const readyPath = path.join(directory, 'ready')
      const profile = { userDataDir: path.join(directory, 'profile'), cleanupOwned: true }
      let launched: ReturnType<typeof launchCodex> | undefined
      let childPid = 0
      try {
        await writeFile(
          executable,
          `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
writeFileSync(${JSON.stringify(readyPath)}, 'ready')
process.on('SIGTERM', () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid))
  setTimeout(() => process.exit(0), 500)
})
setInterval(() => {}, 1000)
`,
          { mode: 0o755 },
        )
        launched = launchCodex(executable, 43125, [], profile)
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (await readFile(readyPath, 'utf8').then(() => true).catch(() => false)) break
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        await expect(readFile(readyPath, 'utf8')).resolves.toBe('ready')
        await terminateIsolatedCodex(launched, profile)
        childPid = Number(await readFile(childPidPath, 'utf8'))
        expect(childPid).toBeGreaterThan(0)
        expect(() => process.kill(childPid, 0)).toThrow(/ESRCH/u)
      } finally {
        if (launched !== undefined && launched.exitCode === null && launched.signalCode === null) {
          await terminateIsolatedCodex(launched, profile).catch(() => undefined)
        }
        if (childPid > 0) {
          try {
            process.kill(childPid, 'SIGKILL')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          }
        }
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
})
