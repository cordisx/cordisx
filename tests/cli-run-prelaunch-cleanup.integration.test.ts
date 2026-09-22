import { access, chmod, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'
import { LauncherMarketplaceCertifiedAuthority } from '../packages/cli/src/launcher/marketplace-certified-authority.js'
import { createBuiltinSkillFixture, mkdtemp } from './helpers/cli-run-fixtures.js'

describe('production Host prelaunch cleanup', () => {
  it('stops the Host and releases its profile lease when authority setup aborts the launch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-authority-failure-'))
    const home = path.join(root, 'home')
    const profile = path.join(root, 'profiles', 'fresh', 'chromium')
    const executable = path.join(root, 'fake-host')
    const pidPath = path.join(root, 'fake-host.pid')
    const builtinSkillSource = await createBuiltinSkillFixture(root)
    await writeFile(
      executable,
      `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid))
setInterval(() => {}, 1_000)
`,
    )
    await chmod(executable, 0o755)

    let launchedPid: number | undefined
    const open = vi.spyOn(LauncherMarketplaceCertifiedAuthority, 'open').mockImplementation(async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          launchedPid = Number.parseInt(await readFile(pidPath, 'utf8'), 10)
          break
        } catch {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }
      if (launchedPid === undefined) throw new Error('fake Host did not start')
      throw new Error('authority setup failed')
    })
    try {
      await expect(runCordisXCli([
        'codex',
        '--profile-dir',
        profile,
        '--executable',
        executable,
      ], {
        env: {
          CORDISX_HOME: home,
          CORDISX_EXPERIMENTAL_NATIVE_SUBMISSION: '0',
        },
        internalBuiltinSkillSourceDir: builtinSkillSource,
        internalSharedHomeDir: path.join(root, 'shared-home'),
        stdout: line => {
          if (line.includes('Certified permission authority unavailable')) {
            throw new Error('authority diagnostic failed')
          }
        },
      })).rejects.toThrow('authority diagnostic failed')
      expect(launchedPid).toBeDefined()
      expect(() => process.kill(launchedPid!, 0)).toThrow(/ESRCH/u)
      await expect(access(`${profile}.cordisx-launch-lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      open.mockRestore()
      if (launchedPid !== undefined) {
        try {
          process.kill(-launchedPid, 'SIGKILL')
        } catch {
          // The expected path already stopped the detached process group.
        }
      }
    }
  })
})
