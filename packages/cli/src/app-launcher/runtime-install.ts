import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, mkdtemp, opendir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { isMissing, privateDirectory } from '../shortcuts/store.js'

const run = promisify(execFile)

export interface AppRuntimeSource {
  readonly entryScript: string
  readonly packageRoot: string
  readonly dependencyRoots: readonly string[]
}

export interface AppCommandOutputOptions {
  readonly directory: string
  readonly path?: string
  readonly runtimeSource?: AppRuntimeSource
}

async function existingDirectory(candidate: string): Promise<string | undefined> {
  try {
    const resolved = await realpath(candidate)
    return (await lstat(resolved)).isDirectory() ? resolved : undefined
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

async function workspaceRoot(packageRoot: string): Promise<string | undefined> {
  let current = path.dirname(packageRoot)
  while (current !== path.dirname(current)) {
    try {
      const manifest = JSON.parse(await readFile(path.join(current, 'package.json'), 'utf8')) as {
        workspaces?: unknown
      }
      if (manifest.workspaces !== undefined) return current
    } catch (error) {
      if (!isMissing(error) && !(error instanceof SyntaxError)) throw error
    }
    current = path.dirname(current)
  }
  return undefined
}

export async function resolveAppRuntimeSource(entryScript: string): Promise<AppRuntimeSource> {
  const resolvedEntry = await realpath(entryScript)
  const dist = path.resolve(path.dirname(resolvedEntry), '..', '..')
  if (path.basename(dist) !== 'dist') throw new Error('CordisX app entry is outside its packaged distribution')
  const packageRoot = path.dirname(dist)
  const workspace = await workspaceRoot(packageRoot)
  const dependencyRoots = []
  if (workspace) {
    const root = await existingDirectory(path.join(workspace, 'node_modules'))
    if (root) dependencyRoots.push(root)
  }
  const local = await existingDirectory(path.join(packageRoot, 'node_modules'))
  if (local && !dependencyRoots.includes(local)) dependencyRoots.push(local)
  return { entryScript: resolvedEntry, packageRoot, dependencyRoots }
}

async function digestTree(root: string): Promise<string> {
  const hash = createHash('sha256')
  const visited = new Set<string>()
  const visit = async (directory: string, logical = ''): Promise<void> => {
    const resolvedDirectory = await realpath(directory)
    if (visited.has(resolvedDirectory)) {
      hash.update(`seen:${logical}\0`)
      return
    }
    visited.add(resolvedDirectory)
    const entries = []
    const handle = await opendir(resolvedDirectory)
    for await (const entry of handle) entries.push(entry)
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolute = path.join(resolvedDirectory, entry.name)
      const relative = path.join(logical, entry.name)
      const resolved = entry.isSymbolicLink() ? await realpath(absolute) : absolute
      const metadata = await lstat(resolved)
      hash.update(metadata.isDirectory() ? `d:${relative}\0` : `f:${relative}\0`)
      if (metadata.isDirectory()) await visit(resolved, relative)
      else hash.update(await readFile(resolved))
    }
  }
  await visit(root)
  return hash.digest('hex')
}

async function cloneDirectory(source: string, target: string, merge = false): Promise<void> {
  await run('/bin/cp', ['-cRL', merge ? path.join(source, '.') : source, target])
}

async function validInstalledRuntime(
  directory: string,
  relativeEntry: string,
  expectedNodeModules?: string,
): Promise<boolean> {
  try {
    const metadata = await lstat(directory)
    const entry = await lstat(path.join(directory, relativeEntry))
    return metadata.isDirectory() && !metadata.isSymbolicLink() && entry.isFile() && !entry.isSymbolicLink()
      && (expectedNodeModules === undefined
        || await realpath(path.join(directory, 'node_modules')) === await realpath(expectedNodeModules))
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function installDependencyLayer(support: string, roots: readonly string[]): Promise<{
  readonly digest: string
  readonly nodeModules?: string
}> {
  if (roots.length === 0) return { digest: 'none' }
  const hash = createHash('sha256')
  const resolvedRoots = []
  for (const root of roots) {
    const resolved = await existingDirectory(root)
    if (!resolved) throw new Error(`CordisX runtime dependency root is unavailable: ${root}`)
    resolvedRoots.push(resolved)
    hash.update(await digestTree(resolved))
  }
  const digest = hash.digest('hex')
  const layers = path.join(support, 'dependencies')
  await privateDirectory(layers)
  const target = path.join(layers, digest)
  const nodeModules = path.join(target, 'node_modules')
  if (await existingDirectory(nodeModules)) return { digest, nodeModules }
  const stage = await mkdtemp(path.join(layers, '.dependencies-'))
  try {
    const stagedModules = path.join(stage, 'node_modules')
    for (const root of resolvedRoots) {
      if (await existingDirectory(stagedModules)) await cloneDirectory(root, stagedModules, true)
      else await cloneDirectory(root, stagedModules)
    }
    await rename(stage, target)
    return { digest, nodeModules }
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
}

/** Installs one immutable app runtime, then returns its exact copied entry. */
export async function installVersionedAppRuntime(
  support: string,
  source: AppRuntimeSource,
  node: string,
): Promise<string> {
  const packageRoot = await realpath(source.packageRoot)
  const sourceEntry = await realpath(source.entryScript)
  const dist = path.join(packageRoot, 'dist')
  const relativeEntry = path.relative(packageRoot, sourceEntry)
  if (!relativeEntry.startsWith(`dist${path.sep}`) || path.isAbsolute(relativeEntry)) {
    throw new Error('CordisX app entry is outside its runtime package')
  }
  const manifestPath = path.join(packageRoot, 'package.json')
  const manifestText = await readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(manifestText) as { version?: unknown }
  if (typeof manifest.version !== 'string' || !/^[0-9A-Za-z.+-]+$/u.test(manifest.version)) {
    throw new Error('CordisX runtime package has no portable version')
  }
  const dependencies = await installDependencyLayer(support, source.dependencyRoots)
  const digest = createHash('sha256')
    .update(manifestText)
    .update(await digestTree(dist))
    .update(dependencies.digest)
    .digest('hex')
  const runtimes = path.join(support, 'runtimes')
  await privateDirectory(runtimes)
  const target = path.join(runtimes, `${manifest.version}-${digest}`)
  if (await validInstalledRuntime(target, relativeEntry, dependencies.nodeModules)) {
    return path.join(target, relativeEntry)
  }
  const stage = await mkdtemp(path.join(runtimes, '.runtime-'))
  try {
    await cloneDirectory(dist, path.join(stage, 'dist'))
    await writeFile(path.join(stage, 'package.json'), manifestText, { mode: 0o600 })
    if (dependencies.nodeModules) {
      await symlink(path.relative(stage, dependencies.nodeModules), path.join(stage, 'node_modules'), 'dir')
    }
    const installedEntry = path.join(stage, relativeEntry)
    await run(node, [
      '--input-type=module',
      '--eval',
      'await import(process.argv[1])',
      pathToFileURL(installedEntry).href,
    ])
    await rename(stage, target)
    return path.join(target, relativeEntry)
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
}
