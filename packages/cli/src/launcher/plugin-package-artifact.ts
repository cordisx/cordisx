import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { StagedPluginServiceModule } from './plugin-package-types.js'
import type { ManagedServicePackageResource } from './managed-service-package-resources.js'
import type { BuiltPluginGenerationArtifact } from './production-plugin-build.js'
import { readPluginGenerationArtifactV1 } from './plugin-generation-artifact-server.js'
import { assertPluginGenerationArtifactFileReferences } from './plugin-generation-artifact-validation.js'

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

export function artifactDigest(
  manifestText: string,
  moduleSource: string,
  artifactSource: string,
  serviceModules: readonly StagedPluginServiceModule[] = [],
  managedServiceResources: readonly ManagedServicePackageResource[] = [],
  entityTemplatesText?: string,
  browserArtifact?: BuiltPluginGenerationArtifact,
  documentsText?: string,
): `sha256:${string}` {
  const digest = createHash('sha256')
    .update(manifestText)
    .update('\0')
    .update(moduleSource)
    .update('\0')
    .update(artifactSource)
  for (
    const service of [...serviceModules].sort((left, right) => left.declaration.id.localeCompare(right.declaration.id))
  ) {
    digest.update('\0service\0')
      .update(JSON.stringify(service.declaration))
      .update('\0')
      .update(service.moduleSource)
  }
  for (const resource of [...managedServiceResources].sort((left, right) => left.path.localeCompare(right.path))) {
    digest.update('\0managed-service-resource\0')
      .update(resource.path)
      .update('\0')
      .update(resource.mode)
      .update('\0')
      .update(resource.digest)
      .update('\0')
      .update(resource.contents)
  }
  if (entityTemplatesText !== undefined) digest.update('\0entity-templates\0').update(entityTemplatesText)
  if (documentsText !== undefined) digest.update('\0plugin-documents\0').update(documentsText)
  if (browserArtifact !== undefined) {
    digest.update('\0browser-artifact\0').update(`${JSON.stringify(browserArtifact.manifest, null, 2)}\n`)
    for (const [file, contents] of [...browserArtifact.files].sort(([left], [right]) => left.localeCompare(right))) {
      digest.update('\0browser-file\0').update(file).update('\0').update(contents)
    }
  }
  const value = digest.digest('hex')
  return `sha256:${value}`
}

export async function readStoredBrowserArtifact(directory: string): Promise<BuiltPluginGenerationArtifact | undefined> {
  const metadata = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (metadata === undefined) return undefined
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('stored browser artifact root must be a real directory')
  }
  const root = await realpath(directory)
  const manifest = await readPluginGenerationArtifactV1(root)
  if (manifest === undefined) return undefined
  const actualFiles = new Set<string>()
  const actualDirectories = new Set<string>()
  const visit = async (relativeDirectory: string): Promise<void> => {
    const entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true })
    for (const entry of entries) {
      const relative = path.posix.join(relativeDirectory.replaceAll(path.sep, '/'), entry.name)
      if (entry.isSymbolicLink()) throw new Error('stored browser artifact contains a symbolic link')
      if (entry.isDirectory()) {
        actualDirectories.add(relative)
        await visit(relative)
      } else if (entry.isFile()) actualFiles.add(`./${relative}`)
      else throw new Error('stored browser artifact contains a non-regular entry')
    }
  }
  await visit('')
  const expectedFiles = new Set(['./artifact.json', ...manifest.files.map(file => file.path)])
  const expectedDirectories = new Set<string>()
  for (const file of manifest.files) {
    let parent = path.posix.dirname(file.path.slice(2))
    while (parent !== '.') {
      expectedDirectories.add(parent)
      parent = path.posix.dirname(parent)
    }
  }
  if (
    actualFiles.size !== expectedFiles.size || [...actualFiles].some(file => !expectedFiles.has(file))
    || actualDirectories.size !== expectedDirectories.size
    || [...actualDirectories].some(item => !expectedDirectories.has(item))
  ) {
    throw new Error('stored browser artifact contains undeclared files or directories')
  }
  const files = new Map<`./${string}`, Uint8Array>()
  for (const descriptor of manifest.files) {
    const file = path.resolve(root, descriptor.path.slice(2))
    if (!within(root, file)) throw new Error('stored browser artifact path escapes its immutable directory')
    const metadata = await lstat(file)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('stored browser artifact contains a non-regular file')
    }
    const contents = await readFile(file)
    if (
      contents.byteLength !== descriptor.byteLength
      || `sha256:${createHash('sha256').update(contents).digest('hex')}` !== descriptor.digest
    ) {
      throw new Error(`stored browser artifact file failed integrity readback: ${descriptor.path}`)
    }
    files.set(descriptor.path, contents)
  }
  await assertPluginGenerationArtifactFileReferences(manifest, files)
  const moduleBytes = files.get(manifest.entry)
  if (moduleBytes === undefined) throw new Error('stored browser artifact entry is missing')
  return Object.freeze({ manifest, files, moduleSource: Buffer.from(moduleBytes).toString('utf8'), inputModules: [] })
}
