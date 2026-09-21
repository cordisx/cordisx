import path from 'node:path'
import { pathToFileURL } from 'node:url'

export async function verifyInstalledSupervisorLock(globalCordisXRoot, temporaryRoot) {
  const installedSupervisorState = await import(
    pathToFileURL(path.join(globalCordisXRoot, 'dist/src/cli/supervisor-state.js')).href
  )
  const paths = installedSupervisorState.supervisorPaths(
    path.join(temporaryRoot, 'installed-supervisor-home'),
    'codex',
    'default',
  )
  const release = await installedSupervisorState.acquireSupervisorStartLock(paths)
  try {
    await installedSupervisorState.acquireSupervisorStartLock(paths).then(() => {
      throw new Error('globally installed CordisX startup lock admitted concurrent ownership')
    }, error => {
      if (error?.code !== 'SUPERVISOR_OPERATION_BUSY') throw error
    })
  } finally {
    await release()
  }
  await installedSupervisorState.acquireSupervisorStartLock(paths).then(nextRelease => nextRelease())
}
