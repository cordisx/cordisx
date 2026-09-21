import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyInstalledPackage } from '../scripts/local-candidate-acceptance-lib.mjs'
import {
  acceptanceEnvironment,
  assertNoAuthenticationMaterial,
  cleanupAcceptanceProfile,
  LOCAL_ACCEPTANCE_MARKER,
  prepareAcceptanceProfile,
  sanitizeAcceptanceReport,
} from '../packages/cli/scripts/local-acceptance-paths.mjs'
import { shouldSkipBuiltinSkillDeployment } from '../packages/cli/src/cli/run-support.js'

const execute = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixturePackage(root: string, name: string, binName: string) {
  const packageRoot = path.join(root, name)
  await mkdir(packageRoot, { recursive: true })
  await writeFile(
    path.join(packageRoot, 'package.json'),
    `${
      JSON.stringify({ name, version: '1.2.3', type: 'module', bin: { [binName]: 'bin.mjs' }, files: ['bin.mjs'] })
    }\n`,
  )
  await writeFile(path.join(packageRoot, 'bin.mjs'), '#!/usr/bin/env node\nconsole.log("fixture help")\n')
  await writeFile(path.join(packageRoot, 'README.md'), `${name}\n`)
  await chmod(path.join(packageRoot, 'bin.mjs'), 0o755)
  return packageRoot
}

describe('local candidate package acceptance', () => {
  it('installs tarballs into a private prefix and proves both bins come from those tarballs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-candidate-package-test-'))
    roots.push(root)
    const packs = path.join(root, 'packs')
    const prefix = path.join(root, 'prefix')
    await mkdir(packs)
    const first = await fixturePackage(root, 'candidate-cordisx', 'cordisx')
    const second = await fixturePackage(root, 'candidate-create-cordisx-plugin', 'create-cordisx-plugin')
    const pack = async (packageRoot: string) => {
      const result = await execute('npm', ['pack', '--json', '--pack-destination', packs], { cwd: packageRoot })
      return JSON.parse(result.stdout)[0]
    }
    const packed = await Promise.all([pack(first), pack(second)])
    const candidates = packed.map(item => ({
      name: item.name,
      version: item.version,
      tarball: path.join(packs, item.filename),
    }))
    await execute('npm', [
      'install',
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...candidates.map(item => item.tarball),
    ])
    const runBin = async (file: string, args: string[], options: { cwd: string }) => {
      await execute(file, args, options)
    }
    await expect(verifyInstalledPackage(prefix, candidates[0], 'cordisx', runBin)).resolves.toMatchObject({
      version: '1.2.3',
      matchesTarball: true,
      packageContentDigest: expect.stringMatching(/^sha256:/u),
    })
    await expect(
      verifyInstalledPackage(prefix, candidates[1], 'create-cordisx-plugin', runBin),
    ).resolves.toMatchObject({ version: '1.2.3', matchesTarball: true })
    await writeFile(path.join(prefix, 'node_modules', candidates[0].name, 'README.md'), 'tampered\n')
    await expect(verifyInstalledPackage(prefix, candidates[0], 'cordisx', runBin)).rejects.toThrow(
      'package contents differ',
    )
  })
})

describe('local candidate profile ownership', () => {
  it('reuses a marked persistent profile and preserves it until explicit cleanup', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'cordisx-candidate-profile-test-'))
    roots.push(parent)
    const target = path.join(parent, 'profile')
    const first = await prepareAcceptanceProfile(target)
    const second = await prepareAcceptanceProfile(target)
    expect(first).toEqual(second)
    expect(JSON.parse(await readFile(path.join(target, LOCAL_ACCEPTANCE_MARKER), 'utf8'))).toMatchObject({
      purpose: 'local-candidate-acceptance',
    })
    await expect(cleanupAcceptanceProfile(target)).resolves.toEqual({ requested: true, removed: true, exists: false })
  })

  it('refuses to clean an unmarked path and removes a runner-owned temporary profile after failure', async () => {
    const unmanaged = await mkdtemp(path.join(os.tmpdir(), 'cordisx-candidate-unmanaged-'))
    roots.push(unmanaged)
    await expect(cleanupAcceptanceProfile(unmanaged)).rejects.toThrow('unmarked root')
    const managed = await prepareAcceptanceProfile()
    await writeFile(path.join(managed.root, 'failed-stage.log'), 'failed\n')
    await expect(cleanupAcceptanceProfile(managed.root)).resolves.toMatchObject({ removed: true, exists: false })
  })

  it('refuses a symlinked persistent profile root', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'cordisx-candidate-symlink-test-'))
    roots.push(parent)
    const target = path.join(parent, 'target')
    const linked = path.join(parent, 'linked')
    await mkdir(target)
    await import('node:fs/promises').then(fs => fs.symlink(target, linked, 'dir'))
    await expect(prepareAcceptanceProfile(linked)).rejects.toThrow('real directory')
  })
})

describe('local candidate privacy', () => {
  it('never treats authentication material as a candidate input', () => {
    expect(() => assertNoAuthenticationMaterial(['dist/cli.js', 'package.json'])).not.toThrow()
    expect(() => assertNoAuthenticationMaterial(['private/credentials.json'])).toThrow('authentication material')
    expect(() => assertNoAuthenticationMaterial(['state/grants/device.json'])).toThrow('authentication material')
  })

  it('inherits login roots without copying them and redacts private report values', () => {
    const environment = acceptanceEnvironment(
      {
        HOME: '/Users/alice',
        CODEX_HOME: '/Users/alice/.codex',
        ACCESS_TOKEN: 'secret-value',
        OPENAI_API_KEY: 'api-key',
        AWS_ACCESS_KEY_ID: 'access-key',
      },
      '/tmp/acceptance/cordisx-home',
    )
    expect(environment).toMatchObject({
      HOME: '/Users/alice',
      CODEX_HOME: '/Users/alice/.codex',
      CORDISX_HOME: '/tmp/acceptance/cordisx-home',
      CORDISX_SKIP_BUILTIN_SKILL_DEPLOYMENT: '1',
    })
    expect(environment.ACCESS_TOKEN).toBeUndefined()
    expect(environment.OPENAI_API_KEY).toBeUndefined()
    expect(environment.AWS_ACCESS_KEY_ID).toBeUndefined()
    expect(shouldSkipBuiltinSkillDeployment(environment)).toBe(true)
    expect(shouldSkipBuiltinSkillDeployment({ CORDISX_SKIP_BUILTIN_SKILL_DEPLOYMENT: 'true' })).toBe(false)
    const report = sanitizeAcceptanceReport(
      {
        path: '/Users/alice/project/file',
        endpoint: 'ws://127.0.0.1:53123/devtools/page/private',
        error: 'token=abc credential:xyz',
      },
      [['/Users/alice', '$HOME']],
    )
    expect(report).toEqual({
      path: '$HOME/project/file',
      endpoint: '[private-url]',
      error: 'token=[redacted] credential=[redacted]',
    })
  })
})
