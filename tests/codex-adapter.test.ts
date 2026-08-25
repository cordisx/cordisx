import { access, chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexAdapter, isolatedCodexEnvironment } from '../packages/cli/src/adapters/codex.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async directory => await rm(directory, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; executable: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-adapter-'))
  temporaryDirectories.push(root)
  const executable = path.join(root, 'fake-host')
  await writeFile(executable, '', { mode: 0o755 })
  return { root, executable }
}

describe('Codex adapter launch plan', () => {
  it('uses a persistent independent Chromium profile while sharing Host roots', async () => {
    const { root, executable } = await fixture()
    const plan = await codexAdapter.resolveLaunchPlan({
      cordisxHomeDir: root,
      profileId: 'default',
      dataMode: 'shared',
      executable,
    })

    expect(plan.environment).toEqual({})
    expect(plan.sharedDataRoots.map(item => item.name)).toEqual(['HOME', 'CODEX_HOME'])
    expect(plan.chromiumProfile).toEqual({
      mode: 'independent',
      path: path.join(root, 'apps', 'codex', 'profiles', 'default', 'chromium'),
    })
    expect(plan.isolatedDataRoots).toEqual([
      { name: 'Chromium profile', path: path.join(root, 'apps', 'codex', 'profiles', 'default', 'chromium'), managed: true },
    ])
    await codexAdapter.prepareLaunch(plan)
    await expect(access(path.join(root, 'apps', 'codex', 'profiles', 'default', 'chromium'))).resolves.toBeUndefined()
  })

  it('projects stable isolated host roots without mutating process.env', async () => {
    const { root, executable } = await fixture()
    const before = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME }
    const plan = await codexAdapter.resolveLaunchPlan({
      cordisxHomeDir: root,
      profileId: 'work',
      dataMode: 'host-isolated',
      executable,
    })

    expect(plan.environment.HOME).toBe(path.join(root, 'apps', 'codex', 'profiles', 'work', 'host-home'))
    expect(plan.environment.CODEX_HOME).toBe(path.join(root, 'apps', 'codex', 'profiles', 'work', 'codex-home'))
    expect(process.env.HOME).toBe(before.HOME)
    expect(process.env.CODEX_HOME).toBe(before.CODEX_HOME)

    await codexAdapter.prepareLaunch(plan)
    await expect(Promise.all(plan.isolatedDataRoots.map(async item => await import('node:fs/promises').then(fs => fs.access(item.path))))).resolves.toBeDefined()
    const managedRoot = plan.isolatedDataRoots.find(item => item.name === 'HOME')
    if (managedRoot === undefined) throw new Error('missing managed HOME root')
    await chmod(managedRoot.path, 0o755)
    await codexAdapter.prepareLaunch(plan)
    expect((await stat(managedRoot.path)).mode & 0o777).toBe(0o700)
  })

  it('projects the standard Windows and Linux user-data roots explicitly', () => {
    expect(isolatedCodexEnvironment('C:\\profiles\\work', 'win32')).toEqual({
      HOME: 'C:\\profiles\\work\\host-home',
      USERPROFILE: 'C:\\profiles\\work\\host-home',
      APPDATA: 'C:\\profiles\\work\\host-home\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\profiles\\work\\host-home\\AppData\\Local',
      CODEX_HOME: 'C:\\profiles\\work\\codex-home',
    })
    expect(isolatedCodexEnvironment('/profiles/work', 'linux')).toMatchObject({
      HOME: '/profiles/work/host-home',
      XDG_CONFIG_HOME: '/profiles/work/host-home/.config',
      XDG_DATA_HOME: '/profiles/work/host-home/.local/share',
      XDG_CACHE_HOME: '/profiles/work/host-home/.cache',
      CODEX_HOME: '/profiles/work/codex-home',
    })
  })

  it('allows an explicit independent Chromium directory for shared Host roots', async () => {
    const { root, executable } = await fixture()
    const explicit = path.join(root, 'user-owned-profile')
    await import('node:fs/promises').then(async fs => await fs.mkdir(explicit, { mode: 0o755 }))
    const plan = await codexAdapter.resolveLaunchPlan({
      cordisxHomeDir: root,
      profileId: 'work',
      dataMode: 'shared',
      executable,
      chromiumProfileDir: explicit,
    })
    await codexAdapter.prepareLaunch(plan)
    expect((await stat(explicit)).mode & 0o777).toBe(0o755)
  })
})
