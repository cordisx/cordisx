import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

export class KernelOperationBusyError extends Error {}

/** The pathname must remain stable: never unlink or rename a kernel mutex. */
export async function acquireKernelOperationLock(mutex: string): Promise<() => Promise<void>> {
  const command = process.platform === 'darwin' ? '/usr/bin/lockf' : '/usr/bin/flock'
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error(`CordisX operation locking is unsupported on ${process.platform}: no kernel lock backend`)
  }
  const args = process.platform === 'darwin'
    ? ['-s', '-t', '0', '3']
    : ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3']
  const handle = await open(mutex, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    await handle.chmod(0o600)
    const locked = spawnSync(command, args, {
      stdio: ['ignore', 'ignore', 'pipe', handle.fd],
      encoding: 'utf8',
    })
    if (locked.error !== undefined) throw locked.error
    if (locked.status === 75) throw new KernelOperationBusyError('another CordisX operation is already in progress')
    if (locked.status !== 0) {
      throw new Error(
        `failed to acquire CordisX operation lock (${
          locked.status ?? locked.signal ?? 'unknown'
        }): ${locked.stderr.trim()}`,
      )
    }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    await handle.close()
  }
}
