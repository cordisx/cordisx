import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildRendererCompositionSource } from '../packages/cli/src/launcher/bundle.js'
import type { CordisXConfig } from '../packages/cli/src/launcher/config.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('plugin README composition', () => {
  it('finds and watches the nearest package README for a source entry', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-readme-'))
    temporaryDirectories.push(root)
    const pluginRoot = path.join(root, 'plugin')
    const sourceRoot = path.join(pluginRoot, 'src')
    const entry = path.join(sourceRoot, 'index.ts')
    const readme = path.join(pluginRoot, 'README.md')
    await mkdir(sourceRoot, { recursive: true })
    await Promise.all([
      writeFile(path.join(pluginRoot, 'package.json'), '{"name":"fixture-plugin","type":"module"}\n'),
      writeFile(readme, '# Package-level README\n\nVisible in the Manager.\n'),
      writeFile(entry, 'export function apply() {}\n'),
    ])
    const config: CordisXConfig = {
      version: 1,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{ id: 'fixture-plugin', entry, enabled: true, config: {} }],
    }

    const composition = await buildRendererCompositionSource(config, { playground: true })

    expect(composition.source).toContain('# Package-level README')
    expect(composition.watchFiles).toEqual([entry, readme])
  })
})
