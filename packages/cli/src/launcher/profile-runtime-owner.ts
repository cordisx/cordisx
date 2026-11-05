import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { acquireKernelOperationLock, KernelOperationBusyError } from './kernel-operation-lock.js'

/** Plugin activation and model API state are keyed by home/profile, including foreground App launches. */
export async function acquireProfileRuntimeOwner(home: string, profile: string): Promise<() => Promise<void>> {
  const root = path.join(home, 'run', 'profile-owners')
  await mkdir(root, { recursive: true, mode: 0o700 })
  try {
    return await acquireKernelOperationLock(path.join(root, `${profile}.lock`))
  } catch (error) {
    if (!(error instanceof KernelOperationBusyError)) throw error
    throw new Error(`CordisX profile ${profile} already has a runtime owner; stop that instance before switching modes`)
  }
}
