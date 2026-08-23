import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function manifest(relative: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(repositoryRoot, relative), 'utf8')) as Record<string, unknown>
}

describe('npm workspace boundary', () => {
  it('keeps orchestration private and the existing CLI in its owning workspace', async () => {
    const [root, cli] = await Promise.all([
      manifest('package.json'),
      manifest('packages/cli/package.json'),
    ])

    expect(root).toMatchObject({
      name: 'cordisx-monorepo',
      private: true,
      workspaces: ['packages/*'],
    })
    expect(cli).toMatchObject({
      name: 'cordisx',
      private: true,
      files: ['dist'],
      bin: { cordisx: './dist/src/cli.js' },
    })
    await expect(access(path.join(repositoryRoot, 'packages/cli/src/cli.ts'))).resolves.toBeUndefined()
    await expect(access(path.join(repositoryRoot, 'examples/plugins/slot-showcase/index.ts'))).resolves.toBeUndefined()
  })
})
