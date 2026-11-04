import { access, chmod, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'
import { LauncherMarketplaceCertifiedAuthority } from '../packages/cli/src/launcher/marketplace-certified-authority.js'
import { createBuiltinSkillFixture, mkdtemp } from './helpers/cli-run-fixtures.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { parseCordisXCli } from '../packages/cli/src/cli/parse.js'
import { prepareProductionHostBootstrap } from '../packages/cli/src/cli/production-host-bootstrap.js'
import * as hostProcess from '../packages/cli/src/launcher/process.js'
import * as dock from '../packages/cli/src/shortcuts/dock.js'

describe('production Host launch ordering', () => {
  it('retains prepared ownership without launching an uncontrolled early window when the inspector is unavailable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-deferred-host-'))
    const profile = path.join(root, 'chromium')
    const configPath = path.join(root, 'config.json')
    const config = createDefaultHomeConfig()
    await writeFile(configPath, JSON.stringify(config))
    const invocation = parseCordisXCli(['run', 'codex'])
    if (invocation.action !== 'run') throw new Error('expected run')
    const launch = vi.spyOn(hostProcess, 'launchCodex').mockReturnValue({ pid: 123 } as never)
    const inspector = vi.spyOn(dock, 'supportsOwnedMainInspector').mockResolvedValue(false)
    const markHostLaunched = vi.fn()
    const output: string[] = []
    let prepared: Awaited<ReturnType<typeof prepareProductionHostBootstrap>> | undefined
    try {
      prepared = await prepareProductionHostBootstrap(
        {
          invocation: { ...invocation, action: 'launch' },
          stdout: line => output.push(line),
          environment: {},
          configPath,
          appId: 'codex',
          selection: {
            config,
            appId: 'codex',
            profileId: 'default',
            profile: { dataMode: 'shared' },
            dataMode: 'shared',
            created: false,
          },
          adapter: {
            id: 'codex',
            displayName: 'Fixture',
            prepareLaunch: async () => {},
            resolveLaunchPlan: async () => ({
              version: 1,
              appId: 'codex',
              appName: 'Fixture',
              profileId: 'default',
              dataMode: 'shared',
              executable: process.execPath,
              chromiumProfile: { mode: 'independent', path: profile },
              environment: {},
              sharedDataRoots: [],
              isolatedDataRoots: [],
            }),
          },
        },
        {},
        {
          prelaunch: true,
          prepareNativeSubmission: false,
          mainInspector: true,
          markHostLaunched,
        },
      )
      expect(launch).not.toHaveBeenCalled()
      expect(markHostLaunched).not.toHaveBeenCalled()
      expect(prepared.prelaunchedHost).toBeUndefined()
      expect(prepared.profileLease).toBeDefined()
      expect(prepared.plan?.chromiumProfile).toEqual({ mode: 'independent', path: profile })
      expect(output).toContainEqual(expect.stringContaining('preparing before the ordinary Host launch'))
    } finally {
      await prepared?.profileLease?.release()
      launch.mockRestore()
      inspector.mockRestore()
    }
  })

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
