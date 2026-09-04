import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CapabilityRiskCatalog } from '../packages/cli/src/capability-risk-catalog.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V7 } from '../packages/cli/src/permission-contracts.js'
import { normalizePluginManifestV7 } from '../packages/cli/src/permission-model-v4.js'
import { JsonPackageManifestV2Resolver, PLUGIN_PACKAGE_SCHEMA_V6, PLUGIN_PACKAGE_SCHEMA_V7 } from '../packages/cli/src/launcher/packages/manifest.js'
import { removeStagedPluginPackage, stageResolvedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'

const roots = new Set<string>()
afterEach(async () => {
  await Promise.all([...roots].map(async root => {
    const home = path.join(root, '.host-home')
    const digests = await readdir(path.join(home, 'packages', 'sha256')).catch(() => [])
    await Promise.all(digests.map(async digest => await removeStagedPluginPackage(home, `sha256:${digest}`)))
    await rm(root, { recursive: true, force: true })
  }))
  roots.clear()
})

async function fixture(packageVersion: 6 | 7): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-package-v7-')); roots.add(root)
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'src/index.js'), 'export function apply() {}\n')
  const runtime = {
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V7,
    schemaVersion: 7,
    id: 'canvas-v7',
    capabilities: [],
    services: [],
    execution: { realm: 'isolated-worker', interfaces: ['ui.transient-canvas/v1'] },
  }
  const runtimeText = `${JSON.stringify(runtime, null, 2)}\n`
  await writeFile(path.join(root, 'runtime.json'), runtimeText)
  await writeFile(path.join(root, 'cordisx-package.json'), `${JSON.stringify({
    $schema: packageVersion === 7 ? PLUGIN_PACKAGE_SCHEMA_V7 : PLUGIN_PACKAGE_SCHEMA_V6,
    schemaVersion: packageVersion,
    id: runtime.id,
    version: '1.0.0',
    entry: './src/index.js',
    distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
    compatibility: { runtimeAbi: 1, protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V7] },
    dependencies: [],
    runtimeManifest: {
      path: './runtime.json', schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V7,
      digest: `sha256:${createHash('sha256').update(runtimeText).digest('hex')}`,
    },
  }, null, 2)}\n`)
  return root
}

describe('plugin-package/v7 Host boundary', () => {
  const resolver = () => new JsonPackageManifestV2Resolver({
    runtimeValidators: {
      [CORDISX_PLUGIN_MANIFEST_SCHEMA_V7]: value => normalizePluginManifestV7(value, 'canvas-v7', new CapabilityRiskCatalog()),
    },
  })

  it('loads and stages an isolated transient-canvas package', async () => {
    const source = await fixture(7)
    const resolved = await resolver().resolve(source)
    expect(resolved.runtimeManifest).toMatchObject({
      schemaVersion: 7,
      execution: { realm: 'isolated-worker', interfaces: ['ui.transient-canvas/v1'] },
    })
    await expect(stageResolvedPluginPackage(path.join(source, '.host-home'), source, resolved))
      .resolves.toMatchObject({ manifest: { runtimeManifest: { schemaVersion: 7 } } })
  })

  it('does not let package-v6 claim manifest-v7', async () => {
    await expect(resolver().resolve(await fixture(6))).rejects.toMatchObject({ code: 'incompatible-runtime' })
  })

  it('rejects Host DOM capabilities from the isolated canvas manifest', () => {
    expect(() => normalizePluginManifestV7({
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V7,
      schemaVersion: 7,
      id: 'canvas-v7',
      capabilities: [{
        name: 'ui.host-dom.read',
        required: false,
        scope: { rootIds: ['app.shell'], operations: ['read-text'] },
      }],
      services: [],
      execution: { realm: 'isolated-worker', interfaces: ['ui.transient-canvas/v1'] },
    }, 'canvas-v7', new CapabilityRiskCatalog())).toThrow(/must not declare Host DOM/u)
  })
})
