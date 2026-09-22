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
  const packageRoot = path.join(root, 'runtime-source')
  const entryScript = path.join(packageRoot, 'dist/src/cli/app-entry.js')
  const dependencyRoot = path.join(root, 'runtime-dependencies')
  const dependency = path.join(dependencyRoot, 'fixture-dependency')
  await mkdir(path.dirname(entryScript), { recursive: true })
  await mkdir(dependency, { recursive: true })
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ type: 'module', version: '1.2.3-test' }))
  await writeFile(path.join(dependency, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }))
  await writeFile(path.join(dependency, 'index.js'), 'export default "dependency"\n')
  await writeFile(
    entryScript,
    'import dependency from "fixture-dependency"\nexport const runtimeMarker = `first-${dependency}`\n',
  )
  const runtime = {
    homedir: root,
    env: { HOME: root, CORDISX_HOME: path.join(root, '.cordisx') },
    internalAppOutput: {
      directory: applications,
      path: target,
      runtimeSource: { entryScript, packageRoot, dependencyRoots: [dependencyRoot] },
    },
    internalOpenApp: (app: string) => {
      opened.push(app)
    },
    stdout: () => {},
  }
  return { root, applications, target, opened, runtime, entryScript }
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
    const firstRuntime = JSON.parse(
      await readFile(
        path.join(f.root, 'Library/Application Support/CordisX/app-launcher/runtime.json'),
        'utf8',
      ),
    ) as { entryScript: string }
    expect(firstRuntime).toMatchObject({
      schemaVersion: 1,
      cordisxHome: await realpath(path.join(f.root, '.cordisx')),
    })
    expect(firstRuntime.entryScript).toMatch(
      /app-launcher\/runtimes\/1\.2\.3-test-[a-f0-9]{64}\/dist\/src\/cli\/app-entry\.js$/u,
    )
    expect(firstRuntime.entryScript).not.toBe(await realpath(f.entryScript))
    expect(await realpath(path.join(path.dirname(firstRuntime.entryScript), '../../../node_modules'))).toMatch(
      /app-launcher\/dependencies\/[a-f0-9]{64}\/node_modules$/u,
    )

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

  it('atomically switches to a new runtime while retaining the previous immutable copy', async () => {
    const f = await fixture()
    await runAppCommand(f.runtime)
    const descriptor = path.join(f.root, 'Library/Application Support/CordisX/app-launcher/runtime.json')
    const first = JSON.parse(await readFile(descriptor, 'utf8')) as { entryScript: string }
    expect(await readFile(first.entryScript, 'utf8')).toContain('first-${dependency}')

    await writeFile(
      f.entryScript,
      'import dependency from "fixture-dependency"\nexport const runtimeMarker = `second-${dependency}`\n',
    )
    await runAppCommand(f.runtime)
    const second = JSON.parse(await readFile(descriptor, 'utf8')) as { entryScript: string }
    expect(second.entryScript).not.toBe(first.entryScript)
    expect(await readFile(first.entryScript, 'utf8')).toContain('first-${dependency}')
    expect(await readFile(second.entryScript, 'utf8')).toContain('second-${dependency}')
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
