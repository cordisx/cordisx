import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V14,
  normalizeLatestRuntimeManifest,
} from '../packages/cli/src/launcher/latest-runtime-manifest.js'
import { collectManagedServicePackageResources } from '../packages/cli/src/launcher/managed-service-package-resources.js'
import { loadStagedPluginPackage, stageResolvedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import { resolveManagedRuntimeResource } from '../packages/cli/src/launcher/managed-service-runtime-files.js'
import type { ManagedServiceRecord } from '../packages/cli/src/launcher/managed-service-runtime-record.js'
import {
  JsonPackageManifestV2Resolver,
  PLUGIN_PACKAGE_SCHEMA_V14,
} from '../packages/cli/src/launcher/packages/manifest.js'
import { managedBackendRuntimeServiceAccess } from '../packages/cli/src/launcher/packages/managed-backend-service-access.js'
import { readStoredServiceModules } from '../packages/cli/src/launcher/stored-plugin-services.js'

const DEFINITION_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-definition.v1.schema.json'

function runtimeManifest() {
  const foreignPlatform = process.platform === 'win32' ? 'linux' : 'win32'
  return {
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V14,
    schemaVersion: 14,
    id: 'managed-fixture',
    capabilities: [],
    services: [{
      id: 'source',
      kind: 'managed-backend',
      owner: 'host',
      entry: './service.mjs',
      definitionSchema: DEFINITION_SCHEMA,
      runtimeResources: [
        {
          path: './service.mjs',
          mode: 'executable',
          digest: `sha256:${createHash('sha256').update('export async function apply() {}\n').digest('hex')}`,
          byteLength: Buffer.byteLength('export async function apply() {}\n'),
        },
        {
          path: './config/gateway.json',
          mode: 'data',
          digest: `sha256:${createHash('sha256').update('{"sources":[]}\n').digest('hex')}`,
          byteLength: Buffer.byteLength('{"sources":[]}\n'),
        },
        {
          path: './schemas/models.v1.schema.json',
          mode: 'data',
          digest: `sha256:${
            createHash('sha256').update(
              '{"$id":"https://raw.githubusercontent.com/example/managed-fixture/main/schemas/models.v1.schema.json","type":"object"}\n',
            ).digest('hex')
          }`,
          byteLength: Buffer.byteLength(
            '{"$id":"https://raw.githubusercontent.com/example/managed-fixture/main/schemas/models.v1.schema.json","type":"object"}\n',
          ),
        },
        ...Array.from({ length: 5 }, (_, index) => ({
          path: `./foreign-target-${index}.bin` as const,
          mode: 'data' as const,
          digest: `sha256:${'0'.repeat(64)}` as const,
          byteLength: 64 * 1024 * 1024,
          platforms: [foreignPlatform],
        })),
      ],
      consumerGrants: [
        { pluginId: 'managed-fixture', operations: ['models.list'] },
        { pluginId: 'gateway-fixture', operations: ['models.list'] },
      ],
    }, {
      id: 'secondary',
      kind: 'managed-backend',
      owner: 'host',
      entry: './secondary.mjs',
      definitionSchema: DEFINITION_SCHEMA,
      runtimeResources: [
        {
          path: './secondary.mjs',
          mode: 'executable',
          digest: `sha256:${createHash('sha256').update('export async function apply() {}\n').digest('hex')}`,
          byteLength: Buffer.byteLength('export async function apply() {}\n'),
        },
        {
          path: './config/secondary.json',
          mode: 'data',
          digest: `sha256:${createHash('sha256').update('{"secondary":true}\n').digest('hex')}`,
          byteLength: Buffer.byteLength('{"secondary":true}\n'),
        },
      ],
      consumerGrants: [],
    }],
  } as const
}

function runtimeResource(path: `./${string}`, contents: string, mode: 'data' | 'executable' = 'data') {
  return {
    path,
    mode,
    digest: `sha256:${createHash('sha256').update(contents).digest('hex')}` as const,
    byteLength: Buffer.byteLength(contents),
  }
}

function storedManagedService(consumerGrants: { pluginId: string; operations: string[] }[]) {
  return {
    id: 'stored-service',
    kind: 'managed-backend',
    owner: 'host',
    entry: './stored-service.mjs',
    definitionSchema: DEFINITION_SCHEMA,
    runtimeResources: [],
    consumerGrants,
  }
}

describe('plugin manifest v14 managed backend admission', () => {
  it('normalizes grants and rejects duplicate consumer authority', () => {
    const normalized = normalizeLatestRuntimeManifest(runtimeManifest(), 'managed-fixture')
    expect(normalized?.schemaVersion).toBe(14)
    expect(normalized?.services[0]).toMatchObject({
      kind: 'managed-backend',
      consumerGrants: [
        { pluginId: 'managed-fixture', operations: ['models.list'] },
        { pluginId: 'gateway-fixture', operations: ['models.list'] },
      ],
    })
    const invalid = structuredClone(runtimeManifest()) as unknown as {
      services: { consumerGrants: { pluginId: string; operations: string[] }[] }[]
    }
    invalid.services[0]!.consumerGrants.push({ pluginId: 'managed-fixture', operations: ['models.list'] })
    expect(() => normalizeLatestRuntimeManifest(invalid, 'managed-fixture')).toThrow('consumerGrants[2] is invalid')

    for (const operations of [[], Array.from({ length: 33 }, (_, index) => `operation-${index}`)]) {
      const invalidOperations = structuredClone(runtimeManifest())
      invalidOperations.services[0]!.consumerGrants[0]!.operations = operations
      expect(() => normalizeLatestRuntimeManifest(invalidOperations, 'managed-fixture')).toThrow(
        'consumerGrants[0] is invalid',
      )
    }
    const tooManyGrants = structuredClone(runtimeManifest())
    tooManyGrants.services[0]!.consumerGrants = Array.from({ length: 33 }, (_, index) => ({
      pluginId: `consumer-${index}`,
      operations: ['models.list'],
    }))
    expect(() => normalizeLatestRuntimeManifest(tooManyGrants, 'managed-fixture')).toThrow('services[0] is invalid')
    const boundary = structuredClone(runtimeManifest())
    boundary.services[0]!.consumerGrants = Array.from({ length: 32 }, (_, index) => ({
      pluginId: `consumer-${index}`,
      operations: Array.from({ length: 32 }, (_, operation) => `operation-${operation}`),
    }))
    expect(normalizeLatestRuntimeManifest(boundary, 'managed-fixture').services[0]).toMatchObject({
      consumerGrants: { length: 32 },
    })
  })

  it('round-trips declared runtime resources and rejects stored content tampering', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-managed-v14-'))
    const home = path.join(root, 'home')
    const runtime = `${JSON.stringify(runtimeManifest(), null, 2)}\n`
    const digest = `sha256:${createHash('sha256').update(runtime).digest('hex')}`
    await Promise.all([mkdir(path.join(root, 'config')), mkdir(path.join(root, 'schemas'))])
    await Promise.all([
      writeFile(path.join(root, 'entry.ts'), 'export default {}\n'),
      writeFile(path.join(root, 'service.mjs'), 'export async function apply() {}\n'),
      writeFile(path.join(root, 'secondary.mjs'), 'export async function apply() {}\n'),
      writeFile(path.join(root, 'runtime-manifest.json'), runtime),
      writeFile(path.join(root, 'config', 'gateway.json'), '{"sources":[]}\n'),
      writeFile(path.join(root, 'config', 'secondary.json'), '{"secondary":true}\n'),
      writeFile(
        path.join(root, 'schemas', 'models.v1.schema.json'),
        '{"$id":"https://raw.githubusercontent.com/example/managed-fixture/main/schemas/models.v1.schema.json","type":"object"}\n',
      ),
      writeFile(
        path.join(root, 'cordisx-package.json'),
        `${
          JSON.stringify(
            {
              $schema: PLUGIN_PACKAGE_SCHEMA_V14,
              schemaVersion: 14,
              id: 'managed-fixture',
              version: '1.0.0',
              entry: './entry.ts',
              distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
              compatibility: { runtimeAbi: 1, protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V14] },
              dependencies: [],
              runtimeManifest: {
                path: './runtime-manifest.json',
                schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V14,
                digest,
              },
            },
            null,
            2,
          )
        }\n`,
      ),
    ])
    const resolver = new JsonPackageManifestV2Resolver({
      runtimeValidators: {
        [CORDISX_PLUGIN_MANIFEST_SCHEMA_V14]: value => {
          const normalized = normalizeLatestRuntimeManifest(value, 'managed-fixture')
          if (normalized === undefined) throw new Error('v14 normalization failed')
          return normalized
        },
      },
    })
    const resolved = await resolver.resolve(root)
    expect(resolved.runtimeManifest.schemaVersion).toBe(14)
    const staged = await stageResolvedPluginPackage(home, root, resolved)
    expect(staged.serviceModules).toMatchObject([
      { declaration: { id: 'source', kind: 'managed-backend', owner: 'host' } },
      { declaration: { id: 'secondary', kind: 'managed-backend', owner: 'host' } },
    ])
    expect(staged.managedServiceResources.map(resource => resource.path)).toEqual([
      './config/gateway.json',
      './config/secondary.json',
      './schemas/models.v1.schema.json',
      './secondary.mjs',
      './service.mjs',
    ])
    const sourceAccess = await managedBackendRuntimeServiceAccess(
      home,
      { id: 'managed-fixture', version: '1.0.0', digest: staged.digest, moduleGeneration: 'source-one' },
      'source',
      'host-one',
    )
    const secondaryAccess = await managedBackendRuntimeServiceAccess(
      home,
      { id: 'managed-fixture', version: '1.0.0', digest: staged.digest, moduleGeneration: 'secondary-one' },
      'secondary',
      'host-one',
    )
    expect(sourceAccess.runtimeResources?.map(resource => resource.path)).toEqual([
      './service.mjs',
      './config/gateway.json',
      './schemas/models.v1.schema.json',
    ])
    expect(secondaryAccess.runtimeResources?.map(resource => resource.path)).toEqual([
      './secondary.mjs',
      './config/secondary.json',
    ])
    const packageDirectory = path.join(home, 'packages', 'sha256', staged.digest.slice('sha256:'.length))
    const executableResource = path.join(packageDirectory, 'service.mjs')
    const dataResource = path.join(packageDirectory, 'config', 'gateway.json')
    const resourceDirectory = path.join(packageDirectory, 'config')
    const resourceManifest = path.join(packageDirectory, 'managed-service-resources.json')
    if (process.platform !== 'win32') {
      expect((await lstat(executableResource)).mode & 0o777).toBe(0o500)
      expect((await lstat(dataResource)).mode & 0o777).toBe(0o444)
      expect((await lstat(resourceDirectory)).mode & 0o777).toBe(0o555)
      expect((await lstat(resourceManifest)).mode & 0o777).toBe(0o444)
      await Promise.all([
        chmod(executableResource, 0o444),
        chmod(dataResource, 0o500),
        chmod(resourceDirectory, 0o700),
        chmod(resourceManifest, 0o600),
      ])
    }
    await expect(resolveManagedRuntimeResource(
      {
        access: {
          declaration: secondaryAccess.declaration,
          artifactDirectory: secondaryAccess.artifactDirectory,
          runtimeResources: secondaryAccess.runtimeResources,
        },
      } as unknown as ManagedServiceRecord,
      './config/gateway.json',
      'data',
    )).rejects.toThrow('undeclared')
    const reloaded = await loadStagedPluginPackage(home, staged.digest)
    const resourceSnapshot = (resources: typeof staged.managedServiceResources) =>
      resources.map(({ path, mode, byteLength, digest, contents }) => ({
        path,
        mode,
        byteLength,
        digest,
        contents: Buffer.from(contents).toString('utf8'),
      }))
    expect(resourceSnapshot(reloaded.managedServiceResources)).toEqual(resourceSnapshot(staged.managedServiceResources))
    if (process.platform !== 'win32') {
      expect((await lstat(executableResource)).mode & 0o777).toBe(0o500)
      expect((await lstat(dataResource)).mode & 0o777).toBe(0o444)
      expect((await lstat(resourceDirectory)).mode & 0o777).toBe(0o555)
      expect((await lstat(resourceManifest)).mode & 0o777).toBe(0o444)
      expect((await lstat(packageDirectory)).mode & 0o777).toBe(0o555)
    }
    const storedResource = path.join(
      home,
      'packages',
      'sha256',
      staged.digest.slice('sha256:'.length),
      'schemas',
      'models.v1.schema.json',
    )
    if (process.platform !== 'win32') await chmod(storedResource, 0o600)
    await writeFile(storedResource, '{}\n')
    await expect(loadStagedPluginPackage(home, staged.digest)).rejects.toThrow('integrity')
  })

  it('stages and reloads a selected resource union larger than one service quota', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-managed-union-'))
    const home = path.join(root, 'home')
    const resources = await Promise.all(['alpha', 'beta'].map(async service => {
      const declarations = []
      for (let index = 0; index < 65; index += 1) {
        const relative = index === 0 ? `./${service}.mjs` as const : `./${service}/resource-${index}.txt` as const
        const contents = index === 0 ? 'export async function apply() {}\n' : `${service}-${index}\n`
        await mkdir(path.dirname(path.join(root, relative.slice(2))), { recursive: true })
        await writeFile(path.join(root, relative.slice(2)), contents)
        declarations.push(runtimeResource(relative, contents, index === 0 ? 'executable' : 'data'))
      }
      return declarations
    }))
    const runtimeObject = {
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V14,
      schemaVersion: 14,
      id: 'managed-union',
      capabilities: [],
      services: resources.map((runtimeResources, index) => ({
        id: index === 0 ? 'alpha' : 'beta',
        kind: 'managed-backend' as const,
        owner: 'host' as const,
        entry: index === 0 ? './alpha.mjs' as const : './beta.mjs' as const,
        definitionSchema: DEFINITION_SCHEMA,
        runtimeResources,
        consumerGrants: [],
      })),
    }
    const runtimeText = `${JSON.stringify(runtimeObject, null, 2)}\n`
    await Promise.all([
      writeFile(path.join(root, 'entry.ts'), 'export default {}\n'),
      writeFile(path.join(root, 'runtime-manifest.json'), runtimeText),
      writeFile(
        path.join(root, 'cordisx-package.json'),
        `${
          JSON.stringify(
            {
              $schema: PLUGIN_PACKAGE_SCHEMA_V14,
              schemaVersion: 14,
              id: 'managed-union',
              version: '1.0.0',
              entry: './entry.ts',
              distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
              compatibility: { runtimeAbi: 1, protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V14] },
              dependencies: [],
              runtimeManifest: {
                path: './runtime-manifest.json',
                schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V14,
                digest: `sha256:${createHash('sha256').update(runtimeText).digest('hex')}`,
              },
            },
            null,
            2,
          )
        }\n`,
      ),
    ])
    const resolver = new JsonPackageManifestV2Resolver({
      runtimeValidators: {
        [CORDISX_PLUGIN_MANIFEST_SCHEMA_V14]: value => normalizeLatestRuntimeManifest(value, 'managed-union'),
      },
    })
    const staged = await stageResolvedPluginPackage(home, root, await resolver.resolve(root))
    expect(staged.managedServiceResources).toHaveLength(130)
    expect((await loadStagedPluginPackage(home, staged.digest)).managedServiceResources).toHaveLength(130)
  })

  it('applies resource count and selected-byte quotas to each service', async () => {
    const declaration = (index: number, byteLength = 0) => ({
      path: `./resource-${index}.bin` as const,
      mode: 'data' as const,
      byteLength,
      digest: `sha256:${'0'.repeat(64)}` as const,
    })
    await expect(collectManagedServicePackageResources(
      '/path-is-not-read',
      [Array.from({ length: 129 }, (_, index) => declaration(index))],
    )).rejects.toThrow('resource count exceeds')
    await expect(collectManagedServicePackageResources(
      '/path-is-not-read',
      [[
        declaration(0, 64 * 1024 * 1024),
        declaration(1, 64 * 1024 * 1024),
        declaration(2, 64 * 1024 * 1024),
        declaration(3, 64 * 1024 * 1024),
        declaration(4, 1),
      ]],
    )).rejects.toThrow('resource bytes exceed')
  })

  it('enforces v14 consumer grant bounds during stored service replay', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-stored-grants-'))
    await mkdir(path.join(root, 'services'))
    await writeFile(path.join(root, 'services', 'stored-service.mjs'), 'export async function apply() {}\n')
    const read = async (consumerGrants: { pluginId: string; operations: string[] }[]) => {
      await writeFile(path.join(root, 'services.json'), `${JSON.stringify([storedManagedService(consumerGrants)])}\n`)
      return await readStoredServiceModules(root)
    }
    await expect(read([{ pluginId: 'consumer', operations: [] }])).rejects.toThrow('consumerGrants[0] is invalid')
    await expect(read([{
      pluginId: 'consumer',
      operations: Array.from({ length: 33 }, (_, index) => `operation-${index}`),
    }])).rejects.toThrow('consumerGrants[0] is invalid')
    await expect(read(Array.from({ length: 33 }, (_, index) => ({
      pluginId: `consumer-${index}`,
      operations: ['operation'],
    })))).rejects.toThrow('stored service[0] is unsupported')
    const boundary = await read(Array.from({ length: 32 }, (_, index) => ({
      pluginId: `consumer-${index}`,
      operations: Array.from({ length: 32 }, (_, operation) => `operation-${operation}`),
    })))
    expect(boundary[0]?.declaration).toMatchObject({ consumerGrants: { length: 32 } })
  })
})
