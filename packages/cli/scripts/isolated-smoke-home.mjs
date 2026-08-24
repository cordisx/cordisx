import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

/** Prepare the only temporary HOME this runner is authorized to delete. */
export async function prepareIsolatedSmokeHome(homeConfig) {
  const homeRoot = await mkdtemp(path.join(os.tmpdir(), TEMP_HOME_PREFIX))
  try {
    await mkdir(path.join(homeRoot, '.cordisx'), { recursive: true })
    await copyFile(homeConfig, path.join(homeRoot, '.cordisx', 'config.json'))
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
