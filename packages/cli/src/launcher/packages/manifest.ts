import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import type {
  HostPackageManifest,
  HostResolvedRuntimeManifest,
  PackageDependency,
  PackageManifestResolver,
  ResolvedPackageCandidate,
} from './types.js'
import { PackageLifecycleError } from './types.js'

export const PLUGIN_PACKAGE_SCHEMA_V2 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-package.v2.schema.json'
export const PLUGIN_RUNTIME_MANIFEST_SCHEMAS = [
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v1.schema.json',
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v2.schema.json',
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v3.schema.json',
] as const

const LOCAL_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/
const SEMANTIC_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const DIGEST = /^sha256:[a-f0-9]{64}$/
const ENTRY = /^\.\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:mjs|js|ts)$/
const JSON_PATH = /^\.\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.json$/
const PUBLIC_HTTPS = /^https:\/\/[^?#]+$/
const FORBIDDEN_RUNTIME_VALUE_KEYS = new Set([
  'connection',
  'connections',
  'transport',
  'mapping',
  'limits',
  'secretRef',
  'secretState',
  'credential',
  'credentials',
  'process',
  'processLifetime',
  'dataDir',
])

export type PackageRuntimeManifestValidator = (value: unknown) => HostResolvedRuntimeManifest

export interface JsonPackageManifestV2ResolverOptions {
  /** Host file convention, kept outside the protocol contract. */
  readonly packageManifestPath?: string
  readonly runtimeValidators: Readonly<Record<string, PackageRuntimeManifestValidator>>
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PackageLifecycleError('invalid-package-manifest', `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed)
  const unknown = Object.keys(value).find(key => !accepted.has(key))
  if (unknown !== undefined) throw new PackageLifecycleError('invalid-package-manifest', `${label}.${unknown} is unsupported`)
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new PackageLifecycleError('invalid-package-manifest', `${label} must be a string`)
  return value
}

function safePath(value: unknown, pattern: RegExp, label: string): string {
  const entry = string(value, label)
  if (!pattern.test(entry) || entry.includes('..')) {
    throw new PackageLifecycleError('invalid-package-manifest', `${label} must be package-relative`)
  }
  return entry
}

async function containedFile(root: string, relative: string, label: string): Promise<string> {
  const canonicalRoot = `${await realpath(root)}${path.sep}`
  const target = await realpath(path.resolve(root, relative.slice(2))).catch(() => {
    throw new PackageLifecycleError('invalid-package-manifest', `${label} does not exist`)
  })
  if (!target.startsWith(canonicalRoot)) {
    throw new PackageLifecycleError('invalid-package-manifest', `${label} escapes package root`)
  }
  return target
}

function dependencies(value: unknown, packageId: string): readonly PackageDependency[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new PackageLifecycleError('invalid-package-manifest', 'package dependencies must be an array of at most 32 items')
  }
  const seen = new Set<string>()
  return value.map((entry, index) => {
    const item = object(entry, `dependencies[${index}]`)
    exactKeys(item, ['id', 'version'], `dependencies[${index}]`)
    const id = string(item.id, `dependencies[${index}].id`)
    const version = string(item.version, `dependencies[${index}].version`)
    if (!LOCAL_ID.test(id) || !SEMANTIC_VERSION.test(version) || id === packageId || seen.has(id)) {
      throw new PackageLifecycleError('invalid-package-manifest', `dependencies[${index}] is invalid, duplicated, or self-referential`)
    }
    seen.add(id)
    return { id, version }
  })
}

function assertNoLauncherValues(value: unknown, trail = 'runtimeManifest'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoLauncherValues(entry, `${trail}[${index}]`))
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_RUNTIME_VALUE_KEYS.has(key)) {
      throw new PackageLifecycleError('launcher-config-tunnel', `${trail}.${key} is launcher-owned and forbidden in runtime manifest values`)
    }
    assertNoLauncherValues(entry, `${trail}.${key}`)
  }
}

/**
 * Resolves the current package-v2 document and its separately digested runtime
 * manifest. Formal runtime-schema validators are injected by the owning Host.
 */
export class JsonPackageManifestV2Resolver implements PackageManifestResolver {
  readonly #options: JsonPackageManifestV2ResolverOptions

  constructor(options: JsonPackageManifestV2ResolverOptions) {
    this.#options = options
  }

  async resolve(snapshotRoot: string): Promise<ResolvedPackageCandidate> {
    const packageManifestPath = this.#options.packageManifestPath ?? './cordisx-package.json'
    const manifestFile = await containedFile(snapshotRoot, safePath(packageManifestPath, JSON_PATH, 'package manifest path'), 'package manifest')
    const raw = JSON.parse(await readFile(manifestFile, 'utf8')) as unknown
    const manifest = object(raw, 'package manifest')
    exactKeys(manifest, [
      '$schema', 'schemaVersion', 'id', 'version', 'entry', 'readme', 'canonicalSource',
      'distribution', 'compatibility', 'dependencies', 'runtimeManifest',
    ], 'package manifest')
    if (manifest.$schema !== PLUGIN_PACKAGE_SCHEMA_V2 || manifest.schemaVersion !== 2) {
      throw new PackageLifecycleError('invalid-package-manifest', 'package manifest must use plugin-package.v2')
    }
    const pluginId = string(manifest.id, 'package manifest id')
    if (!LOCAL_ID.test(pluginId)) throw new PackageLifecycleError('invalid-package-manifest', 'package manifest id is invalid')
    const version = string(manifest.version, 'package version')
    if (!SEMANTIC_VERSION.test(version)) throw new PackageLifecycleError('invalid-package-manifest', 'package manifest version is not exact semantic version')
    const entry = safePath(manifest.entry, ENTRY, 'package manifest entry')
    await containedFile(snapshotRoot, entry, 'package entry')

    const distribution = object(manifest.distribution, 'package distribution')
    exactKeys(distribution, ['mode', 'signature'], 'package distribution')
    if (distribution.mode !== 'explicit-local-v1' || distribution.signature !== 'unsupported') {
      throw new PackageLifecycleError('unsupported-package-distribution', 'remote/signature package trust is unsupported')
    }
    const compatibility = object(manifest.compatibility, 'package compatibility')
    exactKeys(compatibility, ['runtimeAbi', 'protocolSchemas'], 'package compatibility')
    if (compatibility.runtimeAbi !== 1 || !Array.isArray(compatibility.protocolSchemas)
      || compatibility.protocolSchemas.length < 1 || compatibility.protocolSchemas.length > 64
      || compatibility.protocolSchemas.some(schema => typeof schema !== 'string' || !schema.startsWith('https://'))
      || new Set(compatibility.protocolSchemas).size !== compatibility.protocolSchemas.length) {
      throw new PackageLifecycleError('incompatible-runtime', 'package compatibility is invalid')
    }

    const runtimeReference = object(manifest.runtimeManifest, 'runtime manifest reference')
    exactKeys(runtimeReference, ['path', 'schema', 'digest'], 'runtime manifest reference')
    const runtimePath = safePath(runtimeReference.path, JSON_PATH, 'runtime manifest path')
    const runtimeSchema = string(runtimeReference.schema, 'runtime manifest schema')
    const runtimeDigest = string(runtimeReference.digest, 'runtime manifest digest')
    if (!PLUGIN_RUNTIME_MANIFEST_SCHEMAS.includes(runtimeSchema as typeof PLUGIN_RUNTIME_MANIFEST_SCHEMAS[number])
      || !DIGEST.test(runtimeDigest)
      || !(compatibility.protocolSchemas as readonly unknown[]).includes(runtimeSchema)) {
      throw new PackageLifecycleError('incompatible-runtime', 'runtime manifest reference is unsupported or not declared compatible')
    }
    const runtimeFile = await containedFile(snapshotRoot, runtimePath, 'runtime manifest')
    const runtimeBytes = await readFile(runtimeFile)
    const actualRuntimeDigest = `sha256:${createHash('sha256').update(runtimeBytes).digest('hex')}`
    if (actualRuntimeDigest !== runtimeDigest) {
      throw new PackageLifecycleError('integrity-mismatch', `runtime manifest digest mismatch; received ${actualRuntimeDigest}`)
    }
    const runtimeRaw = JSON.parse(runtimeBytes.toString('utf8')) as unknown
    assertNoLauncherValues(runtimeRaw)
    const validator = this.#options.runtimeValidators[runtimeSchema]
    if (validator === undefined) throw new PackageLifecycleError('incompatible-runtime', `no Host validator for ${runtimeSchema}`)
    const runtimeManifest = validator(runtimeRaw)
    if (runtimeManifest.$schema !== runtimeSchema || runtimeManifest.id !== pluginId) {
      throw new PackageLifecycleError('package-identity-mismatch', 'runtime manifest schema/id differs from its package reference')
    }

    const publicSource = manifest.canonicalSource
    if (publicSource !== undefined && (typeof publicSource !== 'string' || !PUBLIC_HTTPS.test(publicSource))) {
      throw new PackageLifecycleError('invalid-package-manifest', 'canonicalSource must be public HTTPS without query or fragment')
    }
    const packageManifest: HostPackageManifest = {
      pluginId,
      version,
      entry,
      ...(manifest.readme === undefined ? {} : {
        readme: safePath(manifest.readme, /^\.\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:md|markdown)$/, 'package readme'),
      }),
      dependencies: dependencies(manifest.dependencies, pluginId),
      compatibility: {
        runtimeAbi: 1,
        protocolSchemas: [...compatibility.protocolSchemas as string[]],
      },
      distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
      ...(publicSource === undefined ? {} : { canonicalSource: publicSource as string }),
      runtimeManifest: {
        path: runtimePath,
        schema: runtimeSchema,
        digest: runtimeDigest as `sha256:${string}`,
      },
      permissionFingerprint: createHash('sha256').update(JSON.stringify(runtimeManifest)).digest('hex'),
    }
    return {
      packageManifest,
      runtimeManifest,
    }
  }
}
