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
    const [root, cli, creator, managerSource, iconSource] = await Promise.all([
      manifest('package.json'),
      manifest('packages/cli/package.json'),
      manifest('packages/create-cordisx-plugin/package.json'),
      readFile(path.join(repositoryRoot, 'packages/cli/src/renderer/manager.ts'), 'utf8'),
      readFile(path.join(repositoryRoot, 'packages/cli/src/renderer/icons.ts'), 'utf8'),
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
      dependencies: { '@material-symbols/svg-400': '0.46.0' },
    })
    expect(creator).toMatchObject({
      name: 'create-cordisx-plugin',
      private: true,
      files: ['dist', 'template'],
      bin: { 'create-cordisx-plugin': './dist/cli.js' },
    })
    await expect(access(path.join(repositoryRoot, 'packages/cli/src/cli.ts'))).resolves.toBeUndefined()
    await expect(access(path.join(repositoryRoot, 'examples/plugins/slot-showcase/index.ts'))).resolves.toBeUndefined()
    expect(iconSource).toContain("from '@material-symbols/svg-400/rounded/extension.svg'")
    expect(iconSource).toContain("from '@material-symbols/svg-400/rounded/close.svg'")
    expect(iconSource).not.toContain("from '@material-symbols/svg-400'")
    expect(managerSource).not.toMatch(/[◫⊞◇⚙◈×›↗●○]/)
  })
})
