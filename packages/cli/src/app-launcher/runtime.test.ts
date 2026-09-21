import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureHomeConfig } from '../config/home-config.js'
import { runAppLauncherOperation } from '../cli/app-entry.js'
import type { runSupervisorCommand } from '../cli/supervisor-command.js'
import { writePrivateJson } from '../shortcuts/store.js'

let roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots = []
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-app-runtime-'))
  roots.push(root)
  const home = path.join(root, 'home')
  const configPath = path.join(home, 'config.json')
  const config = await ensureHomeConfig({ configPath })
  await writeFile(
    configPath,
    JSON.stringify(
      {
        ...config,
        apps: {
          ...config.apps,
          codex: {
            defaultProfile: 'work',
            profiles: {
              personal: { displayName: 'Personal', dataMode: 'host-isolated' },
              work: { displayName: 'Work', dataMode: 'shared' },
            },
          },
        },
      },
      null,
      2,
    ),
  )
  const cacheDirectory = path.join(root, 'cache'), cacheRegistry = path.join(root, 'records')
  await mkdir(cacheDirectory)
  await mkdir(cacheRegistry)
  const runtimePath = path.join(root, 'runtime.json')
  await writePrivateJson(runtimePath, {
    schemaVersion: 1,
    node: process.execPath,
    entryScript: fileURLToPath(new URL('../cli/app-entry.ts', import.meta.url)),
    cordisxHome: home,
    cwd: root,
    cacheDirectory,
    cacheRegistry,
  })
  return { root, home, configPath, runtimePath }
}

describe('CordisX app runtime', () => {
  it('lists only real profiles from the current default app without mutating config', async () => {
    const f = await fixture()
    const before = await readFile(f.configPath, 'utf8')
    await expect(runAppLauncherOperation(f.runtimePath, 'menu')).resolves.toEqual({
      ok: true,
      appId: 'codex',
      defaultProfile: 'work',
      profiles: [
        { id: 'personal', displayName: 'Personal', dataMode: 'host-isolated' },
        { id: 'work', displayName: 'Work', dataMode: 'shared' },
      ],
    })
    expect(await readFile(f.configPath, 'utf8')).toBe(before)
  })

  it('launches the realtime default or an existing menu profile and activates the returned owned Host', async () => {
    const f = await fixture()
    const invocations: unknown[] = []
    const ready = { state: { hostPid: 42, hostProcessStartedAt: 'owned' }, target: {} }
    const run = vi.fn(async (invocation: unknown) => {
      invocations.push(invocation)
      return ready
    }) as unknown as typeof runSupervisorCommand
    const activate = vi.fn(async () => ({ ok: true as const, hostPid: 42, hostStartedAt: 'owned' }))
    await runAppLauncherOperation(f.runtimePath, 'launch-default', undefined, undefined, {
      runSupervisor: run,
      activate,
    })
    await runAppLauncherOperation(f.runtimePath, 'launch-profile', 'codex', 'personal', {
      runSupervisor: run,
      activate,
    })
    expect(invocations).toEqual([
      expect.objectContaining({ action: 'start', createShortcut: true }),
      expect.objectContaining({ action: 'start', createShortcut: true, app: 'codex', profile: 'personal' }),
    ])
    expect(invocations[0]).not.toHaveProperty('app')
    expect(invocations[0]).not.toHaveProperty('profile')
    expect(activate).toHaveBeenCalledTimes(2)
    await expect(runAppLauncherOperation(
      f.runtimePath,
      'launch-profile',
      'codex',
      'missing',
      { runSupervisor: run, activate },
    )).rejects.toThrow('no longer exists')
  })
})
