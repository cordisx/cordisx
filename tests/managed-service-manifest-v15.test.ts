import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V15,
  normalizeLatestRuntimeManifest,
} from '../packages/cli/src/launcher/latest-runtime-manifest.js'
import { normalizePluginManifest } from '../packages/cli/src/renderer/platform/platform-manifest.js'
import {
  JsonPackageManifestV2Resolver,
  PLUGIN_PACKAGE_SCHEMA_V14,
  PLUGIN_PACKAGE_SCHEMA_V15,
} from '../packages/cli/src/launcher/packages/manifest.js'
import { localDevelopmentManifestIdentity } from '../packages/cli/src/launcher/development-manifest-identity.js'
import { declaration } from './managed-service-runtime-fixture.js'

function manifest() {
  return {
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V15,
    schemaVersion: 15,
    id: 'example',
    capabilities: [],
    services: [{ ...declaration('gateway', 'example', []), entry: './service.mjs' }],
    startup: {
      contract: 'cordisx.startup-declaration/v1',
      pages: [],
      capabilities: [{
        id: 'target',
        serviceId: 'gateway',
        kind: 'provider',
        providerId: 'actual-provider',
        compositionOrigin: 'api',
        dependsOn: [],
        milestones: [],
        wait: { interactive: 'background', command: 'when-selected' },
        success: { allOf: [{ kind: 'service-ready' }, { kind: 'catalog-known' }, { kind: 'provider-published' }] },
      }],
    },
  }
}

describe('manifest v15 admission', () => {
  it('preserves exact startup in Host and safe renderer projections and rejects invalid schema pairs/fields', () => {
    const value = manifest()
    expect(normalizeLatestRuntimeManifest(value, 'example')).toMatchObject({
      schemaVersion: 15,
      startup: value.startup,
    })
    expect(normalizePluginManifest(value, 'example')).toMatchObject({ startup: value.startup })
    expect(() => normalizeLatestRuntimeManifest({ ...value, schemaVersion: 14 }, 'example')).toThrow()
    expect(() => normalizeLatestRuntimeManifest({ ...value, startup: undefined }, 'example')).toThrow()
    expect(() =>
      normalizeLatestRuntimeManifest({ ...value, startup: { ...value.startup, guessedOwner: 'example' } }, 'example')
    ).toThrow()
    expect(() =>
      normalizeLatestRuntimeManifest({
        ...value,
        startup: { ...value.startup, capabilities: [{ ...value.startup.capabilities[0], serviceId: 'missing' }] },
      }, 'example')
    ).toThrow('service')
  })

  it('admits exact package v15 with runtime v15 and rejects v14 silently carrying it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-v15-'))
    const value = manifest()
    const source = JSON.stringify(value)
    const package_ = {
      $schema: PLUGIN_PACKAGE_SCHEMA_V15,
      schemaVersion: 15,
      id: 'example',
      version: '1.0.0',
      entry: './index.mjs',
      distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
      dependencies: [],
      compatibility: { runtimeAbi: 1, protocolSchemas: [value.$schema] },
      runtimeManifest: {
        path: './manifest.json',
        schema: value.$schema,
        digest: `sha256:${createHash('sha256').update(source).digest('hex')}`,
      },
    }
    const resolver = new JsonPackageManifestV2Resolver({
      runtimeValidators: {
        [CORDISX_PLUGIN_MANIFEST_SCHEMA_V15]: value => normalizeLatestRuntimeManifest(value, 'example')!,
      },
    })
    try {
      await Promise.all([
        writeFile(path.join(root, 'manifest.json'), source),
        writeFile(path.join(root, 'index.mjs'), 'export function apply() {}'),
        writeFile(path.join(root, 'service.mjs'), 'export function apply() {}'),
        writeFile(path.join(root, 'cordisx-package.json'), JSON.stringify(package_)),
      ])
      expect((await resolver.resolve(root)).runtimeManifest).toMatchObject({
        schemaVersion: 15,
        startup: value.startup,
      })
      expect(await localDevelopmentManifestIdentity(root)).toBe('example')
      await writeFile(
        path.join(root, 'cordisx-package.json'),
        JSON.stringify({ ...package_, $schema: PLUGIN_PACKAGE_SCHEMA_V14, schemaVersion: 14 }),
      )
      await expect(resolver.resolve(root)).rejects.toThrow('unsupported')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
