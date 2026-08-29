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
      version: '0.1.0-beta.1',
      license: 'AGPL-3.0-or-later',
      files: ['dist', 'README.md', 'LICENSE', 'CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md', 'THIRD_PARTY_NOTICES.md', 'third_party'],
      bin: { cordisx: 'dist/src/cli.js' },
      publishConfig: { access: 'public', tag: 'beta', provenance: true },
      dependencies: { '@material-symbols/svg-400': '0.46.0' },
    })
    expect(cli.private).toBeUndefined()
    expect(creator).toMatchObject({
      name: 'create-cordisx-plugin',
      version: '0.1.0-beta.1',
      license: 'AGPL-3.0-or-later',
      files: ['dist', 'template', 'README.md', 'LICENSE', 'CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md'],
      bin: { 'create-cordisx-plugin': 'dist/cli.js' },
      publishConfig: { access: 'public', tag: 'beta', provenance: true },
    })
    expect(creator.private).toBeUndefined()
    await expect(access(path.join(repositoryRoot, 'packages/cli/src/cli.ts'))).resolves.toBeUndefined()
    await expect(access(path.join(repositoryRoot, 'examples/plugins/slot-showcase/index.ts'))).resolves.toBeUndefined()
    await expect(access(path.join(repositoryRoot, 'examples/plugins/settings-tab-demo/index.ts'))).resolves.toBeUndefined()
    await expect(access(path.join(repositoryRoot, 'examples/plugins/settings-tab-demo/README.md'))).resolves.toBeUndefined()
    await expect(access(path.join(repositoryRoot, 'examples/plugins/hello-toolbar/README.md'))).resolves.toBeUndefined()
    await expect(access(path.join(repositoryRoot, 'cordisx.config.settings-demo.json'))).resolves.toBeUndefined()
    await expect(access(path.join(repositoryRoot, 'cordisx.config.hello-toolbar.json'))).resolves.toBeUndefined()
    await expect(access(path.join(repositoryRoot, 'cordisx.config.ui-demos.json'))).resolves.toBeUndefined()
    await expect(access(path.join(repositoryRoot, 'config/ui-demos/config.json'))).resolves.toBeUndefined()
    expect(iconSource).toContain("from '@material-symbols/svg-400/rounded/extension.svg'")
    expect(iconSource).toContain("from '@material-symbols/svg-400/rounded/close.svg'")
    expect(iconSource).not.toContain("from '@material-symbols/svg-400'")
    expect(managerSource).not.toMatch(/[◫⊞◇⚙◈×›↗●○]/)
  })
})
