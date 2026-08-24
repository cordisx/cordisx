import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  CORDISX_PLATFORM_CAPABILITIES,
  type CordisXCapabilityDeclaration,
  type CordisXPluginManifestV1,
} from '../platform-contracts.js'
import type { CordisXPluginManifestV4 } from '../permission-contracts.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V4 } from '../permission-contracts.js'
import { CapabilityRiskCatalog } from '../capability-risk-catalog.js'
import { normalizePluginManifestV4 } from '../permission-model-v2.js'
import {
  CORDISX_PLUGIN_PACKAGE_SCHEMA_V1,
  CORDISX_PLUGIN_PROTOCOL_V1,
  CORDISX_RUNTIME_ABI_V1,
  type CordisXPluginDependencyV1,
  type CordisXPluginPackageManifestV1,
} from '../plugin-lifecycle-contracts.js'
import { normalizePermissionScope } from '../permissions.js'
import type { ResolvedPackageCandidate } from './packages/types.js'

const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/
const SEMANTIC_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const ENTRY = /^\.\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:mjs|js|ts)$/
const README = /^\.\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:md|markdown)$/
const DIGEST = /^sha256:([a-f0-9]{64})$/

export interface StagedPluginPackage {
  readonly manifest: Omit<CordisXPluginPackageManifestV1, 'runtimeManifest'> & {
    readonly runtimeManifest: CordisXPluginManifestV1 | CordisXPluginManifestV4
  }
  readonly digest: `sha256:${string}`
  readonly moduleSource: string
  readonly artifactSource: string
  readonly readme?: string
  /** Stable launcher-issued identity; this is not a real filesystem path. */
  readonly identitySource: string
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  const unknown = Object.keys(value).find(key => !allowed.has(key))
  if (unknown !== undefined) throw new Error(`${label} contains unknown field ${unknown}`)
}

function string(value: unknown, label: string, maximum = 2048): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`)
  }
  return value.trim()
}

function localId(value: unknown, label: string): string {
  const id = string(value, label, 96)
  if (!PLUGIN_ID.test(id) || id === 'host' || id.startsWith('cordisx.')) throw new Error(`${label} is invalid or reserved`)
  return id
}

function semanticVersion(value: unknown, label: string): string {
  const version = string(value, label, 64)
  if (!SEMANTIC_VERSION.test(version)) throw new Error(`${label} must be an exact semantic version`)
  return version
}

function localizedReason(value: unknown, label: string): CordisXCapabilityDeclaration['reason'] {
  const reason = object(value, label)
  exactKeys(reason, ['namespace', 'key', 'params', 'fallback'], label)
  const key = string(reason.key, `${label}.key`, 256)
  if (reason.namespace !== undefined && typeof reason.namespace !== 'string') throw new Error(`${label}.namespace must be a string`)
  if (reason.fallback !== undefined && typeof reason.fallback !== 'string') throw new Error(`${label}.fallback must be a string`)
  if (reason.params !== undefined && (reason.params === null || typeof reason.params !== 'object' || Array.isArray(reason.params))) {
    throw new Error(`${label}.params must be an object`)
  }
  return {
    ...(typeof reason.namespace === 'string' ? { namespace: reason.namespace } : {}),
    key,
    ...(reason.params === undefined ? {} : {
      params: reason.params as NonNullable<CordisXCapabilityDeclaration['reason']['params']>,
    }),
    ...(typeof reason.fallback === 'string' ? { fallback: reason.fallback } : {}),
  }
}

export function runtimeManifestV1(value: unknown, packageId: string): CordisXPluginManifestV1 {
  const manifest = object(value, 'package.runtimeManifest')
  exactKeys(manifest, ['$schema', 'schemaVersion', 'id', 'name', 'capabilities'], 'package.runtimeManifest')
  if (manifest.$schema !== CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 || manifest.schemaVersion !== 1) {
    throw new Error('package.runtimeManifest schema is unsupported')
  }
  const id = localId(manifest.id, 'package.runtimeManifest.id')
  if (id !== packageId) throw new Error('package.runtimeManifest.id must equal package.id')
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length > 14) {
    throw new Error('package.runtimeManifest.capabilities must be an array of at most 14 declarations')
  }
  const seen = new Set<string>()
  const capabilities = manifest.capabilities.map((raw, index): CordisXCapabilityDeclaration => {
    const declaration = object(raw, `package.runtimeManifest.capabilities[${index}]`)
    exactKeys(declaration, ['name', 'required', 'reason', 'scope'], `package.runtimeManifest.capabilities[${index}]`)
    if (typeof declaration.name !== 'string' || !(CORDISX_PLATFORM_CAPABILITIES as readonly string[]).includes(declaration.name)) {
      throw new Error(`package.runtimeManifest.capabilities[${index}].name is unsupported`)
    }
    if (seen.has(declaration.name)) throw new Error(`duplicate capability declaration: ${declaration.name}`)
    seen.add(declaration.name)
    if (typeof declaration.required !== 'boolean') throw new Error(`package.runtimeManifest.capabilities[${index}].required must be a boolean`)
    const name = declaration.name as CordisXCapabilityDeclaration['name']
    const scope = normalizePermissionScope(declaration.scope, `package.runtimeManifest.capabilities[${index}].scope`)
    if (name.startsWith('agent.') && scope.sessions !== undefined) throw new Error(`${name} cannot use Platform sessions`)
    if (!name.startsWith('agent.') && scope.sessionIds !== undefined) throw new Error(`${name} cannot use Agent sessionIds`)
    return {
      name,
      required: declaration.required,
      reason: localizedReason(declaration.reason, `package.runtimeManifest.capabilities[${index}].reason`),
      scope,
    }
  })
  return {
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
    schemaVersion: 1,
    id,
    ...(manifest.name === undefined ? {} : { name: string(manifest.name, 'package.runtimeManifest.name', 200) }),
    capabilities,
  }
}

/** Strictly normalize one protocol-v1 local package manifest. */
export function normalizePluginPackageManifest(value: unknown): CordisXPluginPackageManifestV1 {
  const manifest = object(value, 'package')
  exactKeys(manifest, [
    '$schema', 'schemaVersion', 'id', 'version', 'entry', 'readme', 'canonicalSource',
    'compatibility', 'dependencies', 'runtimeManifest',
  ], 'package')
  if (manifest.$schema !== CORDISX_PLUGIN_PACKAGE_SCHEMA_V1 || manifest.schemaVersion !== 1) {
    throw new Error('package schema is unsupported')
  }
  const id = localId(manifest.id, 'package.id')
  const version = semanticVersion(manifest.version, 'package.version')
  const entry = string(manifest.entry, 'package.entry', 512)
  if (!ENTRY.test(entry)) throw new Error('package.entry must be a package-relative JavaScript or TypeScript file')
  let readme: string | undefined
  if (manifest.readme !== undefined) {
    readme = string(manifest.readme, 'package.readme', 512)
    if (!README.test(readme)) throw new Error('package.readme must be a package-relative Markdown file')
  }
  let canonicalSource: string | undefined
  if (manifest.canonicalSource !== undefined) {
    canonicalSource = string(manifest.canonicalSource, 'package.canonicalSource')
    const url = new URL(canonicalSource)
    if (url.protocol !== 'https:' || url.search !== '' || url.hash !== '') {
      throw new Error('package.canonicalSource must be a public canonical HTTPS URL without query or fragment')
    }
  }
  const compatibility = object(manifest.compatibility, 'package.compatibility')
  exactKeys(compatibility, ['runtimeAbi', 'protocol'], 'package.compatibility')
  if (compatibility.runtimeAbi !== CORDISX_RUNTIME_ABI_V1 || compatibility.protocol !== CORDISX_PLUGIN_PROTOCOL_V1) {
    throw new Error('package requires an incompatible CordisX runtime ABI or protocol')
  }
  if (!Array.isArray(manifest.dependencies) || manifest.dependencies.length > 32) {
    throw new Error('package.dependencies must be an array of at most 32 exact dependencies')
  }
  const dependencyIds = new Set<string>()
  const dependencies = manifest.dependencies.map((raw, index): CordisXPluginDependencyV1 => {
    const dependency = object(raw, `package.dependencies[${index}]`)
    exactKeys(dependency, ['id', 'version'], `package.dependencies[${index}]`)
    const dependencyId = localId(dependency.id, `package.dependencies[${index}].id`)
    if (dependencyId === id) throw new Error('package cannot depend on itself')
    if (dependencyIds.has(dependencyId)) throw new Error(`duplicate package dependency: ${dependencyId}`)
    dependencyIds.add(dependencyId)
    return { id: dependencyId, version: semanticVersion(dependency.version, `package.dependencies[${index}].version`) }
  })
  return {
    $schema: CORDISX_PLUGIN_PACKAGE_SCHEMA_V1,
    schemaVersion: 1,
    id,
    version,
    entry,
    ...(readme === undefined ? {} : { readme }),
    ...(canonicalSource === undefined ? {} : { canonicalSource }),
    compatibility: { runtimeAbi: CORDISX_RUNTIME_ABI_V1, protocol: CORDISX_PLUGIN_PROTOCOL_V1 },
    dependencies,
    runtimeManifest: runtimeManifestV1(manifest.runtimeManifest, id),
  }
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

async function regularContainedFile(root: string, relative: string, label: string): Promise<string> {
  const unresolved = path.resolve(root, relative)
  if (!within(root, unresolved)) throw new Error(`${label} escapes the package directory`)
  const resolved = await realpath(unresolved)
  if (!within(root, resolved)) throw new Error(`${label} resolves outside the package directory`)
  const metadata = await lstat(resolved)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`)
  return resolved
}

async function buildArtifact(root: string, entry: string): Promise<{ readonly moduleSource: string; readonly artifactSource: string }> {
  const specifier = `./${path.relative(root, entry).replaceAll(path.sep, '/')}`
  const common = {
    bundle: true,
    platform: 'browser' as const,
    target: ['chrome120'],
    sourcemap: false,
    metafile: true,
    loader: { '.svg': 'text' as const },
    write: false,
    logLevel: 'silent' as const,
  }
  const [moduleResult, artifactResult] = await Promise.all([build({
    entryPoints: [entry],
    format: 'esm',
    ...common,
  }), build({
    stdin: {
      contents: `import * as pluginModule from ${JSON.stringify(specifier)}\nglobalThis.__cordisxPendingPluginModuleV1 = pluginModule\n`,
      resolveDir: root,
      sourcefile: 'cordisx-plugin-generation.ts',
    },
    format: 'iife',
    ...common,
  })])
  if (moduleResult.metafile === undefined || artifactResult.metafile === undefined) {
    throw new Error('plugin build produced no dependency metadata')
  }
  const inputs = [...Object.keys(moduleResult.metafile.inputs), ...Object.keys(artifactResult.metafile.inputs)]
    .map(input => input.replaceAll('\\', '/'))
  if (inputs.some(input => input.includes('node_modules/@deepseek-ai/cordis/'))) {
    throw new Error('plugin artifact must not bundle a second @deepseek-ai/cordis runtime')
  }
  const moduleOutput = moduleResult.outputFiles?.[0]
  const artifactOutput = artifactResult.outputFiles?.[0]
  if (moduleOutput === undefined || artifactOutput === undefined) throw new Error('plugin build produced no browser artifact')
  return { moduleSource: moduleOutput.text, artifactSource: artifactOutput.text }
}

function artifactDigest(manifestText: string, moduleSource: string, artifactSource: string): `sha256:${string}` {
  const digest = createHash('sha256')
    .update(manifestText)
    .update('\0')
    .update(moduleSource)
    .update('\0')
    .update(artifactSource)
    .digest('hex')
  return `sha256:${digest}`
}

function packageDirectory(homeDir: string, digest: string): string {
  const match = DIGEST.exec(digest)
  if (match?.[1] === undefined) throw new Error('plugin package digest is invalid')
  return path.join(homeDir, 'packages', 'sha256', match[1])
}

/** Launcher-private ESM entry for initial composition; never include it in renderer snapshots. */
export function stagedPluginModulePath(homeDir: string, digest: `sha256:${string}`): string {
  return path.join(packageDirectory(homeDir, digest), 'module.js')
}

async function writeFileSynced(filePath: string, contents: string): Promise<void> {
  const handle = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function publishPackage(
  homeDir: string,
  digest: `sha256:${string}`,
  manifestText: string,
  moduleSource: string,
  artifactSource: string,
  readme: string | undefined,
  runtimeManifestText?: string,
): Promise<void> {
  const parent = path.join(homeDir, 'packages', 'sha256')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(parent, 0o700)
  const destination = packageDirectory(homeDir, digest)
  try {
    const metadata = await lstat(destination)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('existing plugin package target is not a real directory')
    const [storedManifest, storedModule, storedArtifact] = await Promise.all([
      readFile(path.join(destination, 'manifest.json'), 'utf8'),
      readFile(path.join(destination, 'module.js'), 'utf8'),
      readFile(path.join(destination, 'artifact.js'), 'utf8'),
    ])
    if (artifactDigest(storedManifest, storedModule, storedArtifact) !== digest) throw new Error('existing plugin package failed integrity readback')
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = path.join(parent, `.candidate-${process.pid}-${randomUUID()}`)
  await mkdir(temporary, { mode: 0o700 })
  let published = false
  try {
    await Promise.all([
      writeFileSynced(path.join(temporary, 'manifest.json'), manifestText),
      writeFileSynced(path.join(temporary, 'module.js'), moduleSource),
      writeFileSynced(path.join(temporary, 'artifact.js'), artifactSource),
      ...(runtimeManifestText === undefined ? [] : [writeFileSynced(path.join(temporary, 'runtime-manifest.json'), runtimeManifestText)]),
      ...(readme === undefined ? [] : [writeFileSynced(path.join(temporary, 'README.md'), readme)]),
    ])
    await rename(temporary, destination)
    published = true
    if (process.platform !== 'win32') {
      await Promise.all([
        chmod(path.join(destination, 'manifest.json'), 0o444),
        chmod(path.join(destination, 'module.js'), 0o444),
        chmod(path.join(destination, 'artifact.js'), 0o444),
        ...(runtimeManifestText === undefined ? [] : [chmod(path.join(destination, 'runtime-manifest.json'), 0o444)]),
        ...(readme === undefined ? [] : [chmod(path.join(destination, 'README.md'), 0o444)]),
      ])
      await chmod(destination, 0o555)
    }
  } finally {
    if (!published) await rm(temporary, { recursive: true, force: true })
  }
}

interface StoredSeparatedPackageV2 {
  readonly contract: 'cordisx.launcher-staged-package/v2'
  readonly package: ResolvedPackageCandidate['packageManifest']
}

interface StoredSeparatedPackageV3 {
  readonly contract: 'cordisx.launcher-staged-package/v3'
  readonly package: ResolvedPackageCandidate['packageManifest']
  readonly runtimeObject: {
    /** Digest declared by the source package for the original runtime document bytes. */
    readonly sourceDigest: `sha256:${string}`
    /** Digest of the normalized bytes persisted in this immutable store object. */
    readonly storedDigest: `sha256:${string}`
  }
}

type StoredSeparatedPackage = StoredSeparatedPackageV2 | StoredSeparatedPackageV3

function separatedPackage(value: unknown): value is StoredSeparatedPackage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const contract = (value as { contract?: unknown }).contract
  return contract === 'cordisx.launcher-staged-package/v2'
    || contract === 'cordisx.launcher-staged-package/v3'
}

/**
 * Build and publish a package-v2 candidate resolved by the Host-only source
 * adapter. The durable package envelope preserves the source runtime digest and
 * separately binds the normalized bytes persisted as an immutable store object.
 */
export async function stageResolvedPluginPackage(
  homeDir: string,
  sourceDirectory: string,
  resolved: ResolvedPackageCandidate,
): Promise<StagedPluginPackage> {
  const root = await realpath(sourceDirectory)
  const runtime = resolved.runtimeManifest
  const runtimeManifest = runtime.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 && runtime.schemaVersion === 1
    ? runtimeManifestV1(runtime, resolved.packageManifest.pluginId)
    : runtime.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V4 && runtime.schemaVersion === 4
      ? normalizePluginManifestV4(runtime, resolved.packageManifest.pluginId, new CapabilityRiskCatalog())
      : undefined
  if (runtimeManifest === undefined) throw new Error('the current renderer generation ABI accepts runtime plugin manifest v1 or v4 only')
  const entry = await regularContainedFile(root, resolved.packageManifest.entry, 'package entry')
  const readmePath = resolved.packageManifest.readme === undefined
    ? undefined
    : await regularContainedFile(root, resolved.packageManifest.readme, 'package README')
  const [built, readme] = await Promise.all([
    buildArtifact(root, entry),
    readmePath === undefined ? Promise.resolve(undefined) : readFile(readmePath, 'utf8'),
  ])
  const runtimeManifestText = `${JSON.stringify(runtimeManifest, null, 2)}\n`
  const storedRuntimeDigest = `sha256:${createHash('sha256').update(runtimeManifestText).digest('hex')}` as const
  const stored: StoredSeparatedPackageV3 = {
    contract: 'cordisx.launcher-staged-package/v3',
    package: resolved.packageManifest,
    runtimeObject: {
      sourceDigest: resolved.packageManifest.runtimeManifest.digest,
      storedDigest: storedRuntimeDigest,
    },
  }
  const manifestText = `${JSON.stringify(stored, null, 2)}\n`
  const digest = artifactDigest(manifestText, built.moduleSource, built.artifactSource)
  await publishPackage(homeDir, digest, manifestText, built.moduleSource, built.artifactSource, readme, runtimeManifestText)
  return await loadStagedPluginPackage(homeDir, digest)
}

/** Validate, build, hash, and publish one explicit local package into the immutable store. */
export async function stageLocalPluginPackage(homeDir: string, sourceDirectory: string): Promise<StagedPluginPackage> {
  if (!path.isAbsolute(sourceDirectory)) throw new Error('local plugin source directory must be absolute')
  const root = await realpath(sourceDirectory)
  const rootMetadata = await lstat(root)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error('local plugin source must be a real directory')
  const manifestPath = await regularContainedFile(root, './cordisx.plugin.json', 'package manifest')
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
  } catch (error) {
    throw new Error('local plugin manifest is not valid JSON', { cause: error })
  }
  const manifest = normalizePluginPackageManifest(parsed)
  const entry = await regularContainedFile(root, manifest.entry, 'package entry')
  const readmePath = manifest.readme === undefined ? undefined : await regularContainedFile(root, manifest.readme, 'package README')
  const [built, readme] = await Promise.all([
    buildArtifact(root, entry),
    readmePath === undefined ? Promise.resolve(undefined) : readFile(readmePath, 'utf8'),
  ])
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
  const digest = artifactDigest(manifestText, built.moduleSource, built.artifactSource)
  await publishPackage(homeDir, digest, manifestText, built.moduleSource, built.artifactSource, readme)
  const hex = digest.slice('sha256:'.length)
  return {
    manifest,
    digest,
    moduleSource: built.moduleSource,
    artifactSource: built.artifactSource,
    ...(readme === undefined ? {} : { readme }),
    identitySource: manifest.canonicalSource ?? `file:///cordisx-store/sha256/${hex}/entry.js`,
  }
}

/** Read and integrity-check one immutable package without exposing its store path. */
export async function loadStagedPluginPackage(homeDir: string, digest: `sha256:${string}`): Promise<StagedPluginPackage> {
  const directory = packageDirectory(homeDir, digest)
  const [manifestText, moduleSource, artifactSource, readme] = await Promise.all([
    readFile(path.join(directory, 'manifest.json'), 'utf8'),
    readFile(path.join(directory, 'module.js'), 'utf8'),
    readFile(path.join(directory, 'artifact.js'), 'utf8'),
    readFile(path.join(directory, 'README.md'), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    }),
  ])
  if (artifactDigest(manifestText, moduleSource, artifactSource) !== digest) throw new Error('plugin package failed integrity readback')
  const parsed = JSON.parse(manifestText) as unknown
  let manifest: StagedPluginPackage['manifest']
  if (separatedPackage(parsed)) {
    const runtimeBytes = await readFile(path.join(directory, 'runtime-manifest.json'))
    const actualRuntimeDigest = `sha256:${createHash('sha256').update(runtimeBytes).digest('hex')}`
    const expectedRuntimeDigest = parsed.contract === 'cordisx.launcher-staged-package/v3'
      ? parsed.runtimeObject.storedDigest
      : parsed.package.runtimeManifest.digest
    if (parsed.contract === 'cordisx.launcher-staged-package/v3'
      && parsed.runtimeObject.sourceDigest !== parsed.package.runtimeManifest.digest) {
      throw new Error('runtime manifest source provenance failed integrity readback')
    }
    if (actualRuntimeDigest !== expectedRuntimeDigest) throw new Error('runtime manifest failed integrity readback')
    const rawRuntime = JSON.parse(runtimeBytes.toString('utf8')) as unknown
    const candidate = rawRuntime as { readonly $schema?: unknown; readonly schemaVersion?: unknown }
    const runtime = candidate.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 && candidate.schemaVersion === 1
      ? runtimeManifestV1(rawRuntime, parsed.package.pluginId)
      : candidate.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V4 && candidate.schemaVersion === 4
        ? normalizePluginManifestV4(rawRuntime, parsed.package.pluginId, new CapabilityRiskCatalog())
        : undefined
    if (runtime === undefined) throw new Error('stored runtime manifest schema is unsupported')
    manifest = {
      $schema: CORDISX_PLUGIN_PACKAGE_SCHEMA_V1,
      schemaVersion: 1,
      id: parsed.package.pluginId,
      version: parsed.package.version,
      entry: parsed.package.entry,
      ...(parsed.package.readme === undefined ? {} : { readme: parsed.package.readme }),
      ...(parsed.package.canonicalSource === undefined ? {} : { canonicalSource: parsed.package.canonicalSource }),
      compatibility: { runtimeAbi: CORDISX_RUNTIME_ABI_V1, protocol: CORDISX_PLUGIN_PROTOCOL_V1 },
      dependencies: parsed.package.dependencies,
      runtimeManifest: runtime,
    }
  } else {
    manifest = normalizePluginPackageManifest(parsed)
  }
  const hex = digest.slice('sha256:'.length)
  return {
    manifest,
    digest,
    moduleSource,
    artifactSource,
    ...(readme === undefined ? {} : { readme }),
    identitySource: manifest.canonicalSource ?? `file:///cordisx-store/sha256/${hex}/entry.js`,
  }
}

async function makeWritable(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  await chmod(directory, 0o700)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) await makeWritable(target)
    else await chmod(target, 0o600)
  }
}

/** Remove one unreferenced immutable artifact after the activation store has approved GC. */
export async function removeStagedPluginPackage(homeDir: string, digest: `sha256:${string}`): Promise<void> {
  const directory = packageDirectory(homeDir, digest)
  try {
    await makeWritable(directory)
    await rm(directory, { recursive: true, force: false })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
