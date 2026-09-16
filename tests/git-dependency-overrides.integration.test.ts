import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

it('keeps bundled plugin source metadata outside the transitive Git dependency graph', async () => {
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
    await saveJson(path.join(host, 'package.json'), {
      name: 'cordisx-git-override-host',
      version: '1.0.0',
      private: true,
      workspaces: ['packages/*'],
      files: ['index.js', 'prepare.mjs'],
      main: 'index.js',
      scripts: { prepare: 'node prepare.mjs' },
      cordisxSources: { '@cordisx-test/runtime': 'pending' },
    })
    await saveJson(path.join(host, 'packages/cli/package.json'), {
      name: 'cordisx-git-override-cli',
      version: '1.0.0',
      cordisxSources: { '@cordisx-test/runtime': 'pending' },
    })
    await writeFile(
      path.join(host, 'prepare.mjs'),
      `import { writeFile } from 'node:fs/promises'\nawait writeFile('index.js', 'module.exports = "host"\\n')\n`,
      'utf8',
    )
    const initialHostCommit = await commit(host)
    const initialHostSpec = `git+file://${host}#${initialHostCommit}`

    await saveJson(path.join(dependency, 'package.json'), {
      name: '@cordisx-test/runtime',
      version: '1.0.0',
      files: ['index.js', 'prepare.mjs'],
      main: 'index.js',
      scripts: { prepare: 'node prepare.mjs' },
      devDependencies: { 'cordisx-git-override-host': initialHostSpec },
    })
    await writeFile(
      path.join(dependency, 'prepare.mjs'),
      `import { writeFile } from 'node:fs/promises'\n`
        + `import host from 'cordisx-git-override-host'\n`
        + `await writeFile('index.js', \`module.exports = \${JSON.stringify(\`runtime:\${host}\`)}\\n\`)\n`,
      'utf8',
    )
    const dependencyCommit = await commit(dependency)
    const dependencySpec = `git+file://${dependency}#${dependencyCommit}`

    for (const manifestPath of [path.join(host, 'package.json'), path.join(host, 'packages/cli/package.json')]) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      manifest.cordisxSources['@cordisx-test/runtime'] = dependencySpec
      await saveJson(manifestPath, manifest)
    }
    const hostCommit = await commit(host)

    await saveJson(path.join(consumer, 'package.json'), {
      name: 'cordisx-git-override-consumer',
      version: '1.0.0',
      private: true,
      dependencies: { '@cordisx-test/runtime': dependencySpec },
      overrides: { 'cordisx-git-override-host': `git+file://${host}#${hostCommit}` },
    })
    await execute('npm', ['install', '--offline', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: consumer,
      env: { ...process.env, npm_config_cache: cache },
      timeout: 30_000,
    })
    const runtime = await import(path.join(consumer, 'node_modules', '@cordisx-test', 'runtime', 'index.js'))
    expect(runtime.default).toBe('runtime:host')
    await expect(access(path.join(consumer, 'node_modules', 'cordisx-git-override-host'))).rejects.toThrow()
    const committedHost = JSON.parse(
      (await execute('git', ['show', `${hostCommit}:package.json`], { cwd: host })).stdout,
    )
    expect(committedHost.dependencies).toBeUndefined()
    expect(committedHost.cordisxSources['@cordisx-test/runtime']).toBe(dependencySpec)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 40_000)
