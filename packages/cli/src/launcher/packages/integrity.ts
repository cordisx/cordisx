import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, opendir, readFile, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { x as extractTar } from 'tar'
import type { CanonicalPackageSource, LocalPackageSource } from './types.js'
import { PackageLifecycleError } from './types.js'

export interface StagedPackageSnapshot {
  readonly stagingDirectory: string
  readonly payloadDirectory: string
  readonly source: CanonicalPackageSource
  readonly integrity: `sha256:${string}`
  readonly digest: string
}

function portableRelative(relative: string): string {
  return relative.split(path.sep).join('/')
}

function assertSafeRelative(relative: string, label: string): void {
  const portable = portableRelative(relative)
  if (portable === '' || portable === '.') return
  if (portable.startsWith('/') || portable.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new PackageLifecycleError('unsafe-package-path', `${label} escapes the package root: ${relative}`)
  }
}

async function copyDirectoryStrict(source: string, destination: string, relative = ''): Promise<void> {
  const metadata = await lstat(source)
  if (metadata.isSymbolicLink()) {
    throw new PackageLifecycleError('package-link-rejected', `symbolic links are not accepted: ${relative || source}`)
  }
  if (!metadata.isDirectory()) {
    throw new PackageLifecycleError('invalid-package-source', `package source must be a directory: ${source}`)
  }
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const directory = await opendir(source)
  const entries = []
  for await (const entry of directory) entries.push(entry)
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const childRelative = relative === '' ? entry.name : path.join(relative, entry.name)
    assertSafeRelative(childRelative, 'package entry')
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    const child = await lstat(from)
    if (child.isSymbolicLink()) {
      throw new PackageLifecycleError('package-link-rejected', `symbolic links are not accepted: ${childRelative}`)
    }
    if (child.isDirectory()) {
      await copyDirectoryStrict(from, to, childRelative)
      continue
    }
    if (!child.isFile()) {
      throw new PackageLifecycleError(
        'package-special-file-rejected',
        `special files are not accepted: ${childRelative}`,
      )
    }
    if (child.nlink > 1) {
      throw new PackageLifecycleError(
        'package-hardlink-rejected',
        `hard-linked files are not accepted: ${childRelative}`,
      )
    }
    await copyFile(from, to)
    await chmod(to, child.mode & 0o111 ? 0o700 : 0o600)
  }
}

async function normalizedArchiveRoot(extracted: string): Promise<string> {
  const directory = await opendir(extracted)
  const entries = []
  for await (const entry of directory) entries.push(entry)
  if (entries.length === 1 && entries[0]!.isDirectory() && entries[0]!.name === 'package') {
    return path.join(extracted, 'package')
  }
  return extracted
}

async function extractArchiveStrict(archive: string, destination: string): Promise<void> {
  const extracted = path.join(destination, '.archive')
  await mkdir(extracted, { recursive: true, mode: 0o700 })
  let rejectedEntry: { readonly code: string; readonly message: string } | undefined
  try {
    await extractTar({
      cwd: extracted,
      file: archive,
      preservePaths: false,
      strict: true,
      filter: (entryPath, entry) => {
        const portable = entryPath.replaceAll('\\', '/')
        if (path.posix.isAbsolute(portable) || portable.split('/').some(part => part === '..')) {
          rejectedEntry = {
            code: 'unsafe-package-path',
            message: `archive entry escapes the package root: ${entryPath}`,
          }
          return false
        }
        if (
          !('type' in entry)
          || (entry.type !== 'File' && entry.type !== 'OldFile' && entry.type !== 'ContiguousFile'
            && entry.type !== 'Directory')
        ) {
          rejectedEntry = { code: 'package-link-rejected', message: `archive entry type is not accepted: ${entryPath}` }
          return false
        }
        return true
      },
    })
    if (rejectedEntry !== undefined) throw new PackageLifecycleError(rejectedEntry.code, rejectedEntry.message)
  } catch (error) {
    throw new PackageLifecycleError(
      'invalid-package-archive',
      `failed to extract local package archive: ${(error as Error).message}`,
    )
  }
  const root = await normalizedArchiveRoot(extracted)
  await copyDirectoryStrict(root, path.join(destination, 'payload'))
  await rm(extracted, { recursive: true, force: true })
}

async function listTree(root: string, relative = ''): Promise<readonly string[]> {
  const directory = await opendir(path.join(root, relative))
  const entries = []
  for await (const entry of directory) entries.push(entry)
  entries.sort((a, b) => a.name.localeCompare(b.name))
  const result: string[] = []
  for (const entry of entries) {
    const child = relative === '' ? entry.name : path.join(relative, entry.name)
    result.push(child)
    if (entry.isDirectory()) result.push(...await listTree(root, child))
  }
  return result
}

/** Deterministic hash of normalized package contents, independent of mtimes. */
export async function hashPackageTree(root: string): Promise<string> {
  const hash = createHash('sha256')
  for (const relative of await listTree(root)) {
    assertSafeRelative(relative, 'package entry')
    const metadata = await lstat(path.join(root, relative))
    const portable = portableRelative(relative)
    if (metadata.isSymbolicLink()) {
      throw new PackageLifecycleError('package-link-rejected', `symbolic links are not accepted: ${portable}`)
    }
    if (metadata.isDirectory()) {
      hash.update(`D\0${portable}\0`)
      continue
    }
    if (!metadata.isFile()) {
      throw new PackageLifecycleError('package-special-file-rejected', `special files are not accepted: ${portable}`)
    }
    if (metadata.nlink > 1) {
      throw new PackageLifecycleError('package-hardlink-rejected', `hard-linked files are not accepted: ${portable}`)
    }
    const contents = await readFile(path.join(root, relative))
    const executable = metadata.mode & 0o111 ? '1' : '0'
    hash.update(`F\0${portable}\0${executable}\0${contents.byteLength}\0`)
    hash.update(contents)
  }
  return hash.digest('hex')
}

function parseExpectedIntegrity(value: string): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(value)
  if (match === null) {
    throw new PackageLifecycleError('invalid-expected-integrity', 'expected integrity must be sha256:<lowercase hex>')
  }
  return match[1]!
}

export class PluginPackageSourceSnapshotter {
  readonly #root: string

  constructor(root: string) {
    this.#root = path.resolve(root)
  }

  get root(): string {
    return this.#root
  }

  async snapshot(source: LocalPackageSource, transactionId = randomUUID()): Promise<StagedPackageSnapshot> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(transactionId)) {
      throw new PackageLifecycleError('invalid-transaction-id', 'transaction id is invalid')
    }
    const canonicalPath = await realpath(path.resolve(source.path)).catch((error) => {
      throw new PackageLifecycleError(
        'package-source-unavailable',
        `cannot resolve package source: ${(error as Error).message}`,
      )
    })
    const sourceStat = await lstat(canonicalPath)
    if (sourceStat.isSymbolicLink()) {
      throw new PackageLifecycleError('package-link-rejected', 'package source cannot be a symbolic link')
    }
    const stagingDirectory = path.join(this.#root, 'staging', `${transactionId}.${randomUUID()}`)
    const payloadDirectory = path.join(stagingDirectory, 'payload')
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 })
    try {
      if (source.kind === 'local-directory') {
        if (!sourceStat.isDirectory()) {
          throw new PackageLifecycleError('invalid-package-source', 'local-directory source must be a directory')
        }
        await copyDirectoryStrict(canonicalPath, payloadDirectory)
      } else if (source.kind === 'local-package' && sourceStat.isDirectory()) {
        await copyDirectoryStrict(canonicalPath, payloadDirectory)
      } else {
        if (!sourceStat.isFile()) {
          throw new PackageLifecycleError(
            'invalid-package-source',
            `${source.kind} source must be a file or explicit package directory`,
          )
        }
        await extractArchiveStrict(canonicalPath, stagingDirectory)
      }
      const digest = await hashPackageTree(payloadDirectory)
      if (source.expectedIntegrity !== undefined && parseExpectedIntegrity(source.expectedIntegrity) !== digest) {
        throw new PackageLifecycleError(
          'integrity-mismatch',
          `expected ${source.expectedIntegrity}; received sha256:${digest}`,
        )
      }
      return {
        stagingDirectory,
        payloadDirectory,
        source: {
          kind: source.kind,
          url: pathToFileURL(canonicalPath).href,
          ...(source.downloadedFrom === undefined ? {} : { downloadedFrom: source.downloadedFrom }),
        },
        integrity: `sha256:${digest}`,
        digest,
      }
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true })
      throw error
    }
  }

  async discard(snapshot: StagedPackageSnapshot): Promise<void> {
    await rm(snapshot.stagingDirectory, { recursive: true, force: true })
  }
}
