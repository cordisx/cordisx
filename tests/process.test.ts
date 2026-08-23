import { access, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ONLINE_DEVTOOLS_ORIGIN,
  codexLaunchArgs,
  defaultIsolatedProfileDir,
  findFreeLoopbackPort,
  prepareIsolatedCodexProfile,
  projectProfileKey,
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
})
