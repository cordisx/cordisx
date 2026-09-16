import type { PluginManifestManagedBackendRuntimeResourceV14 } from '@cordisx/protocol/plugin-manifest/v14'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

const MAX_RESOURCE_BYTES = 64 * 1024 * 1024
const MAX_RESOURCE_COUNT = 128
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
const RESOURCE_PATH = /^\.\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

export interface ManagedServicePackageResource {
  readonly path: `./${string}`
  readonly mode: PluginManifestManagedBackendRuntimeResourceV14['mode']
  readonly byteLength: number
  readonly digest: `sha256:${string}`
  readonly contents: Uint8Array
}

interface StoredResource {
  readonly path: `./${string}`
  readonly mode: PluginManifestManagedBackendRuntimeResourceV14['mode']
  readonly byteLength: number
  readonly digest: `sha256:${string}`
}

type ResourceDeclarations = readonly (readonly PluginManifestManagedBackendRuntimeResourceV14[])[]

type StoredService = {
  readonly declaration: {
    readonly kind: string
    readonly runtimeResources?: readonly PluginManifestManagedBackendRuntimeResourceV14[]
  }
}

function digest(contents: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`
}

function assertResourceDeclaration(declaration: PluginManifestManagedBackendRuntimeResourceV14): void {
  if (!RESOURCE_PATH.test(declaration.path) || declaration.path.includes('..') || declaration.path.includes('//')) {
    throw new Error('managed service resource path is invalid')
  }
  if (
    (declaration.mode !== 'executable' && declaration.mode !== 'data')
    || !Number.isSafeInteger(declaration.byteLength) || declaration.byteLength < 0
    || declaration.byteLength > MAX_RESOURCE_BYTES
    || !/^sha256:[a-f0-9]{64}$/.test(declaration.digest)
  ) throw new Error('managed service resource declaration is invalid')
}

export function managedServiceResourceMatchesTarget(
  declaration: PluginManifestManagedBackendRuntimeResourceV14,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): boolean {
  return (declaration.platforms === undefined
    || declaration.platforms.includes(platform as 'darwin' | 'linux' | 'win32'))
    && (declaration.architectures === undefined
      || declaration.architectures.includes(architecture as 'arm64' | 'x64'))
}

function selectedResourceDeclarations(
  services: ResourceDeclarations,
): ReadonlyMap<string, PluginManifestManagedBackendRuntimeResourceV14> {
  const selectedByPath = new Map<string, PluginManifestManagedBackendRuntimeResourceV14>()
  for (const declarations of services) {
    if (declarations.length > MAX_RESOURCE_COUNT) {
      throw new Error('managed service resource count exceeds the limit')
    }
    for (const declaration of declarations) assertResourceDeclaration(declaration)
    const selected = declarations.filter(declaration => managedServiceResourceMatchesTarget(declaration))
    if (selected.reduce((total, declaration) => total + declaration.byteLength, 0) > MAX_TOTAL_BYTES) {
      throw new Error('managed service resource bytes exceed the limit')
    }
    for (const declaration of selected) {
      const prior = selectedByPath.get(declaration.path)
      if (
        prior !== undefined
        && (prior.mode !== declaration.mode || prior.byteLength !== declaration.byteLength
          || prior.digest !== declaration.digest)
      ) throw new Error('managed service resource declarations conflict for the current target')
      selectedByPath.set(declaration.path, declaration)
    }
  }
  return selectedByPath
}

async function readResource(
  root: string,
  declaration: Pick<PluginManifestManagedBackendRuntimeResourceV14, 'path' | 'mode' | 'byteLength' | 'digest'>,
): Promise<ManagedServicePackageResource> {
  const canonicalRoot = await realpath(root)
  const target = path.resolve(canonicalRoot, declaration.path.slice(2))
  const resolved = await realpath(target)
  if (resolved !== target || !resolved.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error('managed service resource escapes its package or uses a symbolic link')
  }
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size > MAX_RESOURCE_BYTES) {
      throw new Error('managed service resource is not a bounded regular file')
    }
    const contents = new Uint8Array(await handle.readFile())
    if (contents.byteLength !== metadata.size) throw new Error('managed service resource changed during readback')
    const actualDigest = digest(contents)
    if (contents.byteLength !== declaration.byteLength || actualDigest !== declaration.digest) {
      throw new Error('managed service resource failed integrity readback')
    }
    return Object.freeze({
      path: declaration.path,
      mode: declaration.mode,
      byteLength: contents.byteLength,
      digest: actualDigest,
      contents,
    })
  } finally {
    await handle.close()
  }
}

export async function collectManagedServicePackageResources(
  root: string,
  services: ResourceDeclarations,
): Promise<readonly ManagedServicePackageResource[]> {
  const selectedByPath = selectedResourceDeclarations(services)
  const canonicalRoot = await realpath(root)
  const resources = await Promise.all([...selectedByPath.values()].map(async declaration => {
    const target = path.resolve(canonicalRoot, declaration.path.slice(2))
    const relative = path.relative(canonicalRoot, target)
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('managed service resource path is invalid')
    }
    return await readResource(canonicalRoot, declaration)
  }))
  return Object.freeze([...resources].sort((left, right) => left.path.localeCompare(right.path)))
}

export function managedServiceResourceManifest(
  resources: readonly ManagedServicePackageResource[],
): string | undefined {
  if (resources.length === 0) return undefined
  const stored: StoredResource[] = resources.map(({ path, mode, byteLength, digest }) => ({
    path,
    mode,
    byteLength,
    digest,
  }))
  return `${JSON.stringify(stored, null, 2)}\n`
}

export async function readStoredManagedServicePackageResources(
  directory: string,
  services: readonly StoredService[],
): Promise<readonly ManagedServicePackageResource[]> {
  const selectedByPath = selectedResourceDeclarations(
    services.flatMap(service =>
      service.declaration.kind === 'managed-backend' ? [service.declaration.runtimeResources ?? []] : []
    ),
  )
  const text = await readFile(path.join(directory, 'managed-service-resources.json'), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    },
  )
  if (text === undefined) {
    if (selectedByPath.size > 0) throw new Error('managed service resource manifest is invalid')
    return []
  }
  const value = JSON.parse(text) as unknown
  if (!Array.isArray(value) || value.length !== selectedByPath.size) {
    throw new Error('managed service resource manifest is invalid')
  }
  const seen = new Set<string>()
  const resources = await Promise.all(value.map(async item => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('managed service resource manifest entry is invalid')
    }
    const record = item as Record<string, unknown>
    const byteLength = record.byteLength
    if (Object.keys(record).some(key => !['path', 'mode', 'byteLength', 'digest'].includes(key))) {
      throw new Error('managed service resource manifest entry has unknown fields')
    }
    if (typeof record.path !== 'string') throw new Error('managed service resource path is invalid')
    if (record.mode !== 'executable' && record.mode !== 'data') {
      throw new Error('managed service resource manifest entry is invalid')
    }
    if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new Error('managed service resource manifest entry is invalid')
    }
    const resourceDigest = record.digest
    if (typeof resourceDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(resourceDigest)) {
      throw new Error('managed service resource manifest entry is invalid')
    }
    assertResourceDeclaration({
      path: record.path as `./${string}`,
      mode: record.mode,
      byteLength,
      digest: resourceDigest as `sha256:${string}`,
    })
    const declaration = selectedByPath.get(record.path)
    if (
      declaration === undefined || seen.has(record.path)
      || declaration.mode !== record.mode || declaration.byteLength !== byteLength
      || declaration.digest !== resourceDigest
    ) throw new Error('managed service resource manifest entry is undeclared or inconsistent')
    seen.add(record.path)
    return await readResource(directory, {
      path: record.path as `./${string}`,
      mode: record.mode,
      byteLength,
      digest: resourceDigest as `sha256:${string}`,
    })
  }))
  return Object.freeze(resources.sort((left, right) => left.path.localeCompare(right.path)))
}
