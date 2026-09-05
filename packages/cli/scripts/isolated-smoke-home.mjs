import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const TEMP_HOME_PREFIX = 'cordisx-isolated-home-'

function assertManagedHomeRoot(homeRoot) {
  const temporaryDirectory = path.resolve(os.tmpdir())
  const resolved = path.resolve(homeRoot)
  if (path.dirname(resolved) !== temporaryDirectory || !path.basename(resolved).startsWith(TEMP_HOME_PREFIX)) {
    throw new Error('isolated smoke home cleanup refused an unmanaged path')
  }
  return resolved
}

async function makeManagedTreeWritable(target) {
  if (process.platform === 'win32') return
  const metadata = await lstat(target)
  if (metadata.isSymbolicLink()) return
  if (!metadata.isDirectory()) {
    await chmod(target, 0o600)
    return
  }
  await chmod(target, 0o700)
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    await makeManagedTreeWritable(path.join(target, entry.name))
  }
}

/** Prepare the only temporary HOME this runner is authorized to delete. */
export async function prepareIsolatedSmokeHome(homeConfig) {
  const homeRoot = await mkdtemp(path.join(os.tmpdir(), TEMP_HOME_PREFIX))
  try {
    await mkdir(path.join(homeRoot, '.cordisx'), { recursive: true })
    const destination = path.join(homeRoot, '.cordisx', 'config.json')
    const sourceText = await readFile(homeConfig, 'utf8')
    const source = JSON.parse(sourceText)
    let changed = false
    if (Array.isArray(source?.plugins)) {
      source.plugins = source.plugins.map(plugin => {
        if (
          plugin === null || typeof plugin !== 'object' || typeof plugin.entry !== 'string'
          || path.isAbsolute(plugin.entry) || plugin.entry.startsWith('cordisx:')
        ) return plugin
        changed = true
        return { ...plugin, entry: path.resolve(path.dirname(homeConfig), plugin.entry) }
      })
    }
    if (changed) await writeFile(destination, `${JSON.stringify(source, null, 2)}\n`)
    else await copyFile(homeConfig, destination)
    return homeRoot
  } catch (error) {
    await rm(homeRoot, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

/** Remove exactly a runner-created temporary HOME and return machine-readable proof. */
export async function cleanupIsolatedSmokeHome(homeRoot) {
  if (homeRoot === undefined) return { homeRoot: null, homeRootRemoved: true, homeRootExists: false }
  const managedRoot = assertManagedHomeRoot(homeRoot)
  await makeManagedTreeWritable(managedRoot)
  await rm(managedRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  const exists = await access(managedRoot).then(() => true, error => {
    if (error?.code === 'ENOENT') return false
    throw error
  })
  if (exists) throw new Error(`isolated smoke home still exists after cleanup: ${managedRoot}`)
  return { homeRoot: managedRoot, homeRootRemoved: true, homeRootExists: false }
}

/** A failing smoke may never write a report; preserve that original failure. */
export async function appendRunnerCleanup(reportPath, cleanup) {
  if (reportPath === undefined) return false
  const text = await readFile(path.resolve(reportPath), 'utf8').catch(error => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  if (text === undefined) return false
  const report = JSON.parse(text)
  report.runnerCleanup = cleanup
  await writeFile(path.resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`)
  return true
}
