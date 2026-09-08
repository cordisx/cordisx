import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V11,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V12,
  normalizeTaskManifest,
} from '../packages/cli/src/agent-task-permission-manifest.js'
import { PLUGIN_PACKAGE_SCHEMA_V11, PLUGIN_PACKAGE_SCHEMA_V12 } from '../packages/cli/src/launcher/packages/manifest.js'
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

it.each([10, 11, 12] as const)(
  'validates and stages visual manifest v%s through local development and formal package composition',
  async version => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-visual-package-'))
    const source = path.join(root, 'source'), home = path.join(root, 'home')
    await mkdir(source)
    const manifest = {
      $schema: version === 10
        ? CORDISX_PLUGIN_MANIFEST_SCHEMA_V10
        : version === 11
        ? CORDISX_PLUGIN_MANIFEST_SCHEMA_V11
        : CORDISX_PLUGIN_MANIFEST_SCHEMA_V12,
      schemaVersion: version,
      id: 'animal',
      services: [],
      capabilities: [
        ...(version === 10 ? [] : [{ name: 'usage.read', required: false, scope: { profile: 'current' } }]),
        {
          name: 'ui.extension-points.render',
          required: true,
          scope: { extensionPoints: ['composer.primary-action.visual'] },
        },
      ],
    }
    const bytes = JSON.stringify(manifest)
    const packageManifest = {
      $schema: version === 10
        ? PLUGIN_PACKAGE_SCHEMA_V10
        : version === 11
        ? PLUGIN_PACKAGE_SCHEMA_V11
        : PLUGIN_PACKAGE_SCHEMA_V12,
      schemaVersion: version,
      id: 'animal',
      version: '0.1.0',
      entry: './animal.js',
      dependencies: [],
      distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
      compatibility: { runtimeAbi: 1, protocolSchemas: [manifest.$schema] },
      runtimeManifest: {
        path: './runtime.json',
        schema: manifest.$schema,
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
        runtimeValidators: {
          [manifest.$schema]: value =>
            version === 10 ? normalizeVisualManifestV10(value, 'animal') : normalizeTaskManifest(value, 'animal'),
        },
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
  },
)
