import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadPluginGenerationArtifact,
  MAX_PLUGIN_RUNTIME_MODULE_BYTES,
} from '../packages/cli/src/launcher/plugin-generation-loader.js'

const temporary = new Set<string>()

afterEach(async () => {
  await Promise.all([...temporary].map(async directory => await rm(directory, { recursive: true, force: true })))
  temporary.clear()
})

async function artifactDirectory(source = 'export const value = 1\n'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-generation-loader-'))
  temporary.add(root)
  await mkdir(path.join(root, 'artifact'))
  await writeFile(path.join(root, 'artifact', 'module.js'), source)
  return path.join(root, 'artifact')
}

describe('plugin generation loader', () => {
  it('loads a bounded immutable browser module', async () => {
    const directory = await artifactDirectory()
    const loaded = await loadPluginGenerationArtifact({
      artifactDirectory: directory,
      runtimeEntry: './module.js',
    })

    expect(loaded).toContain('__cordisxPendingPluginModuleFactoryV1')
    expect(loaded).toContain('value')
  })

  it('rejects a regular file above the generic 24 MiB ceiling before reading it', async () => {
    const directory = await artifactDirectory('')
    await truncate(path.join(directory, 'module.js'), MAX_PLUGIN_RUNTIME_MODULE_BYTES + 1)

    await expect(loadPluginGenerationArtifact({
      artifactDirectory: directory,
      runtimeEntry: './module.js',
    })).rejects.toThrow('runtime module entry is not a bounded regular file')
  })
})
