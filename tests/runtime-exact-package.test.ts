import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { stagePluginPackageSourceV1 } from '../packages/cli/src/launcher/packages/index.js'
import { removeStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import {
  PLUGIN_PACKAGE_SCHEMA_V11,
  PLUGIN_PACKAGE_SCHEMA_V12,
  PLUGIN_PACKAGE_SCHEMA_V13,
} from '../packages/cli/src/launcher/packages/manifest.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V12,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V13,
  normalizePluginManifestV12,
  normalizePluginManifestV13,
} from '../packages/cli/src/runtime-exact-request-permissions.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V11, normalizeUsageManifestV11 } from '../packages/cli/src/usage-permissions.js'

const temporary = new Set<string>()

afterEach(async () => {
  await Promise.all([...temporary].map(async root => await rm(root, { recursive: true, force: true })))
  temporary.clear()
})

async function fixture(version: 11 | 12 | 13) {
  const root = await mkdtemp(path.join(os.tmpdir(), `cordisx-package-v${version}-`))
  temporary.add(root)
  const source = path.join(root, 'source')
  const homeDir = path.join(root, 'home')
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, 'index.js'), 'export function apply() {}\n')
  const runtime = {
    $schema: version === 13
      ? CORDISX_PLUGIN_MANIFEST_SCHEMA_V13
      : version === 12
      ? CORDISX_PLUGIN_MANIFEST_SCHEMA_V12
      : CORDISX_PLUGIN_MANIFEST_SCHEMA_V11,
    schemaVersion: version,
    id: 'runtime-exact',
    capabilities: version === 13
      ? [{ name: 'tasks.create', required: false, scope: { runtime: 'exact-request' } }]
      : [],
    services: [],
  }
  const runtimeText = `${JSON.stringify(runtime, null, 2)}\n`
  await writeFile(path.join(source, 'runtime.json'), runtimeText)
  await writeFile(
    path.join(source, 'cordisx-package.json'),
    `${
      JSON.stringify(
        {
          $schema: version === 13
            ? PLUGIN_PACKAGE_SCHEMA_V13
            : version === 12
            ? PLUGIN_PACKAGE_SCHEMA_V12
            : PLUGIN_PACKAGE_SCHEMA_V11,
          schemaVersion: version,
          id: 'runtime-exact',
          version: '1.0.0',
          entry: './index.js',
          canonicalSource: 'https://plugins.example/runtime-exact',
          distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
          compatibility: {
            runtimeAbi: 1,
            protocolSchemas: [runtime.$schema],
          },
          dependencies: [],
          runtimeManifest: {
            path: './runtime.json',
            schema: runtime.$schema,
            digest: `sha256:${createHash('sha256').update(runtimeText).digest('hex')}`,
          },
        },
        null,
        2,
      )
    }\n`,
  )
  return { source, homeDir }
}

describe('runtime exact-request package admission', () => {
  for (const version of [11, 12, 13] as const) {
    it(`admits formal package and manifest v${version} without rewriting its schema`, async () => {
      const { source, homeDir } = await fixture(version)
      const staged = await stagePluginPackageSourceV1({
        kind: 'local-directory',
        location: pathToFileURL(source).href,
      }, {
        homeDir,
        runtimeValidators: {
          [CORDISX_PLUGIN_MANIFEST_SCHEMA_V11]: value => normalizeUsageManifestV11(value, 'runtime-exact'),
          [CORDISX_PLUGIN_MANIFEST_SCHEMA_V12]: value => normalizePluginManifestV12(value, 'runtime-exact'),
          [CORDISX_PLUGIN_MANIFEST_SCHEMA_V13]: value => normalizePluginManifestV13(value, 'runtime-exact'),
        },
      })
      expect(staged.manifest.runtimeManifest).toMatchObject({ schemaVersion: version })
      await removeStagedPluginPackage(homeDir, staged.digest)
    })
  }
})
