import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

async function saveJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function commit(directory: string): Promise<string> {
  await execute('git', ['init', '--quiet'], { cwd: directory })
  await execute('git', ['add', '.'], { cwd: directory })
  await execute('git', [
    '-c',
    'user.name=CordisX Test',
    '-c',
    'user.email=tests@invalid.example',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ], { cwd: directory })
  return (await execute('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim()
}

it('uses root Git overrides for release-version workspace dependencies during Git preparation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-git-overrides-'))
  const dependency = path.join(root, 'dependency')
  const host = path.join(root, 'host')
  const consumer = path.join(root, 'consumer')
  const cache = path.join(root, 'npm-cache')
  try {
    await Promise.all([
      mkdir(dependency),
      mkdir(path.join(host, 'packages', 'cli'), { recursive: true }),
      mkdir(consumer),
    ])
    await saveJson(path.join(dependency, 'package.json'), {
      name: '@cordisx-test/runtime',
      version: '1.0.0',
      files: ['index.js'],
      main: 'index.js',
    })
    await writeFile(path.join(dependency, 'index.js'), 'module.exports = "git-runtime"\n', 'utf8')
    const dependencyCommit = await commit(dependency)
    const dependencySpec = `git+file://${dependency}#${dependencyCommit}`

    await saveJson(path.join(host, 'package.json'), {
      name: 'cordisx-git-override-host',
      version: '1.0.0',
      private: true,
      workspaces: ['packages/*'],
      files: ['prepared.txt'],
      scripts: { prepare: 'node prepare.mjs' },
      dependencies: { '@cordisx-test/runtime': dependencySpec },
      overrides: { '@cordisx-test/runtime': dependencySpec },
    })
    await saveJson(path.join(host, 'packages/cli/package.json'), {
      name: 'cordisx-git-override-cli',
      version: '1.0.0',
      dependencies: { '@cordisx-test/runtime': '1.0.0' },
    })
    await writeFile(
      path.join(host, 'prepare.mjs'),
      `import { writeFile } from 'node:fs/promises'\n`
        + `import runtime from '@cordisx-test/runtime'\n`
        + `await writeFile('prepared.txt', runtime)\n`,
      'utf8',
    )
    const hostCommit = await commit(host)

    await saveJson(path.join(consumer, 'package.json'), {
      name: 'cordisx-git-override-consumer',
      version: '1.0.0',
      private: true,
      dependencies: { host: `git+file://${host}#${hostCommit}` },
    })
    await execute('npm', ['install', '--offline', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: consumer,
      env: { ...process.env, npm_config_cache: cache },
      timeout: 30_000,
    })
    await expect(readFile(path.join(consumer, 'node_modules', 'host', 'prepared.txt'), 'utf8'))
      .resolves.toBe('git-runtime')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 40_000)
