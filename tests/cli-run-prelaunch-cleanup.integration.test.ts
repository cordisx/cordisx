import { access, chmod, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'
import { LauncherMarketplaceCertifiedAuthority } from '../packages/cli/src/launcher/marketplace-certified-authority.js'
import { createBuiltinSkillFixture, mkdtemp } from './helpers/cli-run-fixtures.js'

describe('production Host launch ordering', () => {
  it('does not create the Host and releases its profile lease when authority setup aborts preparation', async () => {
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

    const open = vi.spyOn(LauncherMarketplaceCertifiedAuthority, 'open').mockImplementation(async () => {
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
      await expect(access(pidPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(`${profile}.cordisx-launch-lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      open.mockRestore()
    }
  })
})
