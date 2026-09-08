import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  JsonPackageManifestV2Resolver,
  PLUGIN_PACKAGE_SCHEMA_V11,
  PLUGIN_PACKAGE_SCHEMA_V12,
  PLUGIN_PACKAGE_SCHEMA_V13,
} from '../packages/cli/src/launcher/packages/manifest.js'

const roots = new Set<string>()
const runtimeSchemas = new Map([1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13].map(version => [
  version,
  `https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v${version}.schema.json`,
]))
const packageSchemas = new Map([
  [11, PLUGIN_PACKAGE_SCHEMA_V11],
  [12, PLUGIN_PACKAGE_SCHEMA_V12],
  [13, PLUGIN_PACKAGE_SCHEMA_V13],
])

afterEach(async () => {
  await Promise.all([...roots].map(async root => await rm(root, { recursive: true, force: true })))
  roots.clear()
})

async function candidate(packageVersion: 11 | 12 | 13, runtimeVersion: number): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-predecessor-matrix-'))
  roots.add(root)
  await mkdir(root, { recursive: true })
  const runtimeSchema =
    `https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v${runtimeVersion}.schema.json`
  const runtime = {
    $schema: runtimeSchema,
    schemaVersion: runtimeVersion,
    id: 'matrix-plugin',
    capabilities: [],
    services: [],
  }
  const bytes = JSON.stringify(runtime)
  await Promise.all([
    writeFile(path.join(root, 'index.js'), 'export function apply() {}\n'),
    writeFile(path.join(root, 'runtime.json'), bytes),
    writeFile(
      path.join(root, 'cordisx-package.json'),
      JSON.stringify({
        $schema: packageSchemas.get(packageVersion),
        schemaVersion: packageVersion,
        id: 'matrix-plugin',
        version: '1.0.0',
        entry: './index.js',
        distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
        compatibility: { runtimeAbi: 1, protocolSchemas: [runtimeSchema] },
        dependencies: [],
        runtimeManifest: {
          path: './runtime.json',
          schema: runtimeSchema,
          digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        },
      }),
    ),
  ])
  return root
}

function resolver() {
  return new JsonPackageManifestV2Resolver({
    runtimeValidators: Object.fromEntries(
      [...runtimeSchemas.values()].map(schema => [schema, value => value as never]),
    ),
  })
}

describe('plugin package predecessor matrix', () => {
  for (const packageVersion of [11, 12, 13] as const) {
    const allowed = [
      1,
      2,
      3,
      4,
      5,
      8,
      9,
      10,
      11,
      ...(packageVersion >= 12 ? [12] : []),
      ...(packageVersion >= 13 ? [13] : []),
    ]
    it(`allows every formal predecessor of package v${packageVersion}`, async () => {
      for (const runtimeVersion of allowed) {
        await expect(resolver().resolve(await candidate(packageVersion, runtimeVersion))).resolves.toMatchObject({
          runtimeManifest: { schemaVersion: runtimeVersion },
        })
      }
    })
    it(`rejects removed v6/v7 manifests from package v${packageVersion}`, async () => {
      for (const runtimeVersion of [6, 7]) {
        await expect(resolver().resolve(await candidate(packageVersion, runtimeVersion))).rejects.toThrow(
          'runtime manifest reference is unsupported',
        )
      }
    })
  }
})
