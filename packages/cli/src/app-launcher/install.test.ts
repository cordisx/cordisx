import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runAppCommand } from '../cli/app-command.js'
import { appLauncherHelper, nativeOperation } from '../shortcuts/native.js'

let roots: string[] = []
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots = []
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-app-install-'))
  roots.push(root)
  const applications = path.join(root, 'Applications')
  const target = path.join(applications, 'CordisX.app')
  const opened: string[] = []
  const runtime = {
    homedir: root,
    env: { HOME: root, CORDISX_HOME: path.join(root, '.cordisx') },
    internalAppOutput: { directory: applications, path: target },
    internalOpenApp: (app: string) => {
      opened.push(app)
    },
    stdout: () => {},
  }
  return { root, applications, target, opened, runtime }
}

describe.skipIf(process.platform !== 'darwin')('CordisX.app installation', () => {
  it('installs a missing app once, then reuses and opens the same owned bundle', async () => {
    const f = await fixture()
    const first = await runAppCommand(f.runtime)
    const firstInode = (await stat(first.path)).ino
    expect(first).toEqual({ status: 'installed', path: f.target })
    expect(await nativeOperation({ operation: 'inspect-app', path: f.target })).toMatchObject({
      bundleIdentifier: 'org.cordisx.launcher',
    })
    expect(JSON.parse(
      await readFile(
        path.join(f.root, 'Library/Application Support/CordisX/app-launcher/runtime.json'),
        'utf8',
      ),
    )).toMatchObject({
      schemaVersion: 1,
      cordisxHome: await realpath(path.join(f.root, '.cordisx')),
    })

    const second = await runAppCommand(f.runtime)
    expect(second).toEqual({ status: 'reused', path: f.target })
    expect((await stat(second.path)).ino).toBe(firstInode)
    const installedHelper = path.join(f.target, 'Contents', 'MacOS', 'CordisXLauncher')
    await writeFile(installedHelper, '#!/bin/sh\nexit 1\n')
    await chmod(installedHelper, 0o755)
    execFileSync('/usr/libexec/PlistBuddy', [
      '-c',
      `Set :CordisXAppHelperDigest ${'0'.repeat(64)}`,
      path.join(f.target, 'Contents', 'Info.plist'),
    ])
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', f.target])

    const updated = await runAppCommand(f.runtime)
    expect(updated).toEqual({ status: 'reused', path: f.target })
    expect((await stat(updated.path)).ino).toBe(firstInode)
    expect(await nativeOperation({ operation: 'inspect-app', path: updated.path })).toMatchObject({
      helperDigest: createHash('sha256').update(await readFile(appLauncherHelper)).digest('hex'),
    })
    expect(() => execFileSync('/usr/bin/codesign', ['--verify', '--strict', updated.path])).not.toThrow()
    const helperModifiedAt = (await stat(installedHelper)).mtimeMs
    await runAppCommand(f.runtime)
    expect((await stat(installedHelper)).mtimeMs).toBe(helperModifiedAt)
    expect(f.opened).toEqual([f.target, f.target, f.target, f.target])
  })

  it('does not overwrite an unknown same-name application', async () => {
    const f = await fixture()
    await mkdir(f.applications, { recursive: true })
    await writeFile(f.target, 'unrelated')
    await expect(runAppCommand(f.runtime)).rejects.toThrow('unrelated application')
    expect(await readFile(f.target, 'utf8')).toBe('unrelated')
    expect(f.opened).toEqual([])
  })
})
