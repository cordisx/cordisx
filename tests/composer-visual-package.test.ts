import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V10,
  normalizeVisualManifestV10,
} from '../packages/cli/src/extension-point-interaction-permissions.js'
import {
  JsonPackageManifestV2Resolver,
  PLUGIN_PACKAGE_SCHEMA_V10,
} from '../packages/cli/src/launcher/packages/manifest.js'
import { buildLocalDevelopmentPlugin } from '../packages/cli/src/launcher/development.js'
import { removeStagedPluginPackage, stageResolvedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'

it('validates and stages the same exact visual manifest through local development and formal package composition', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-visual-package-'))
  const source = path.join(root, 'source'), home = path.join(root, 'home')
  await mkdir(source)
  const manifest = {
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V10,
    schemaVersion: 10,
    id: 'animal',
    services: [],
    capabilities: [
      {
        name: 'ui.extension-points.render',
        required: true,
        scope: { extensionPoints: ['composer.primary-action.visual'] },
      },
    ],
  }
  const bytes = JSON.stringify(manifest)
  const packageManifest = {
    $schema: PLUGIN_PACKAGE_SCHEMA_V10,
    schemaVersion: 10,
    id: 'animal',
    version: '0.1.0',
    entry: './animal.js',
    dependencies: [],
    distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
    compatibility: { runtimeAbi: 1, protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V10] },
    runtimeManifest: {
      path: './runtime.json',
      schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V10,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    },
  }
  try {
    await Promise.all([
      writeFile(path.join(source, 'runtime.json'), bytes),
      writeFile(path.join(source, 'cordisx-package.json'), JSON.stringify(packageManifest)),
      writeFile(
        path.join(source, 'package.json'),
        JSON.stringify({ name: 'animal', version: '0.1.0', type: 'module' }),
      ),
      writeFile(path.join(source, 'animal.js'), 'export function apply() {}'),
    ])
    const local = await buildLocalDevelopmentPlugin(path.join(source, 'animal.js'))
    expect(local.manifest).toMatchObject(manifest)
    const resolver = new JsonPackageManifestV2Resolver({
      runtimeValidators: { [CORDISX_PLUGIN_MANIFEST_SCHEMA_V10]: value => normalizeVisualManifestV10(value, 'animal') },
    })
    const resolved = await resolver.resolve(source)
    const staged = await stageResolvedPluginPackage(home, source, resolved)
    expect(staged.manifest.runtimeManifest).toMatchObject(manifest)
    await removeStagedPluginPackage(home, staged.digest)
    await writeFile(path.join(source, 'runtime.json'), bytes.replace('primary-action', 'other-action'))
    await expect(resolver.resolve(source)).rejects.toThrow('digest mismatch')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
