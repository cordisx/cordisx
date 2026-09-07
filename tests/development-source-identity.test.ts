import { expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { resolveDevelopmentIdentitySource } from '../packages/cli/src/launcher/development-source-identity.js'

test('explicit development identity retains original path hashing and rejects a different Git repository', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'development-identity-'))
  const git = async (cwd: string, ...args: string[]) => await promisify(execFile)('git', ['-C', cwd, ...args])
  try {
    const original = path.join(root, 'original')
    await mkdir(original)
    await git(original, 'init', '-q')
    // A minimal renderer package is sufficient for identity validation.
    const runtime = {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v8.schema.json',
      schemaVersion: 8,
      id: 'sample',
      capabilities: [],
      services: [],
    }
    const { createHash } = await import('node:crypto')
    const manifestText = JSON.stringify(runtime)
    await writeFile(path.join(original, 'runtime-manifest.json'), manifestText)
    await writeFile(
      path.join(original, 'package.json'),
      JSON.stringify({ name: 'sample', version: '1.0.0', type: 'module' }),
    )
    await writeFile(path.join(original, 'sample.ts'), 'export function apply() {}')
    await writeFile(
      path.join(original, 'cordisx-package.json'),
      JSON.stringify({
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-package.v8.schema.json',
        schemaVersion: 8,
        id: 'sample',
        version: '1.0.0',
        entry: './sample.ts',
        distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
        compatibility: { runtimeAbi: 1, protocolSchemas: [runtime.$schema] },
        dependencies: [],
        runtimeManifest: {
          path: './runtime-manifest.json',
          schema: runtime.$schema,
          digest: `sha256:${createHash('sha256').update(manifestText).digest('hex')}`,
        },
      }),
    )
    await git(original, 'add', '.')
    await git(
      original,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture',
    )
    const next = path.join(root, 'next')
    await git(original, 'worktree', 'add', '--detach', next)
    const identity = await resolveDevelopmentIdentitySource({ id: 'sample', entry: path.join(original, 'sample.ts') })
    expect(
      await resolveDevelopmentIdentitySource({
        id: 'sample',
        entry: path.join(next, 'sample.ts'),
        developmentIdentityEntry: path.join(original, 'sample.ts'),
      }),
    ).toBe(identity)
    const other = path.join(root, 'other')
    await git(root, 'clone', '-q', original, other)
    await expect(
      resolveDevelopmentIdentitySource({
        id: 'sample',
        entry: path.join(other, 'sample.ts'),
        developmentIdentityEntry: path.join(original, 'sample.ts'),
      }),
    ).rejects.toThrow('same Git')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
