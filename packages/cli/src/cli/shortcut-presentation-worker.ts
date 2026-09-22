import { spawn } from 'node:child_process'
import { appendFile, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CordisXManagedInvocation } from './parse.js'
import { requestDockRefresh, requestShortcutPresentation } from './supervisor-control.js'
import { readSupervisorState, type SupervisorPaths } from './supervisor-state.js'
import { createShortcut, reuseShortcut } from '../shortcuts/create.js'
import type { ShortcutLaunchIdentity, ShortcutOutputOptions } from '../shortcuts/model.js'
import { privateDirectory, readPrivateJson, writePrivateJson } from '../shortcuts/store.js'

export interface ShortcutPresentationJob {
  readonly schemaVersion: 1
  readonly invocation: CordisXManagedInvocation
  readonly appId: string
  readonly profileId: string
  readonly dataMode: 'shared' | 'host-isolated'
  readonly home: string
  readonly cwd: string
  readonly codexHome?: string
  readonly output?: ShortcutOutputOptions
  readonly launchIdentity: ShortcutLaunchIdentity
  readonly paths: SupervisorPaths
  readonly instanceToken: string
  readonly recordPath: string
  readonly updateShortcut: boolean
  readonly reuseExistingAvatar: boolean
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function currentGeneration(job: ShortcutPresentationJob): Promise<boolean> {
  const state = await readSupervisorState(job.paths)
  return state?.phase === 'ready'
    && state.instanceToken === job.instanceToken
    && state.pid === job.launchIdentity.supervisorPid
    && state.processStartedAt === job.launchIdentity.supervisorStartedAt
    && state.hostPid === job.launchIdentity.hostPid
    && state.hostProcessStartedAt === job.launchIdentity.hostStartedAt
}

export async function updateShortcutPresentation(job: ShortcutPresentationJob): Promise<void> {
  if (!await currentGeneration(job)) return
  const shortcutInput = {
    invocation: job.invocation,
    appId: job.appId,
    profileId: job.profileId,
    dataMode: job.dataMode,
    home: job.home,
    cwd: job.cwd,
    env: job.codexHome ? { CODEX_HOME: job.codexHome } : {},
    ...(job.output ? { output: job.output } : {}),
    launchIdentity: job.launchIdentity,
  }
  if (job.updateShortcut) {
    // Reuse is limited to an avatar entry stamped with this exact live Host
    // generation. A record from any other process identity is regenerated.
    let shortcut: Awaited<ReturnType<typeof createShortcut>> | undefined = job.reuseExistingAvatar
      ? await reuseShortcut({ ...shortcutInput, launchIdentity: job.launchIdentity })
      : undefined
    if (!shortcut) {
      let displayProfile = await requestShortcutPresentation(job.paths.socket, job.instanceToken)
      const avatarDeadline = Date.now() + 10_000
      while (displayProfile.status !== 'available' || !displayProfile.avatar) {
        if (Date.now() >= avatarDeadline || !await currentGeneration(job)) return
        await new Promise(resolve => setTimeout(resolve, 250))
        displayProfile = await requestShortcutPresentation(job.paths.socket, job.instanceToken)
      }
      if (!await currentGeneration(job)) return
      shortcut = await createShortcut({
        avatar: displayProfile.avatar,
        ...shortcutInput,
      })
    }
  }
  if (!await currentGeneration(job)) return
  if (!await requestDockRefresh(job.paths.socket, job.instanceToken, job.recordPath)) {
    throw new Error('Dock icon refresh was rejected')
  }
}

const worker = fileURLToPath(new URL('./shortcut-presentation-worker.js', import.meta.url))

/** Persist and detach presentation work so CLI/App exit cannot cancel it. */
export async function scheduleShortcutPresentation(job: ShortcutPresentationJob): Promise<void> {
  await privateDirectory(job.paths.directory)
  const jobPath = path.join(job.paths.directory, `.shortcut-presentation-${randomBytes(12).toString('hex')}.json`)
  await writePrivateJson(jobPath, job)
  const child = spawn(process.execPath, [worker, jobPath], {
    cwd: job.cwd,
    env: process.env,
    detached: true,
    stdio: 'ignore',
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    child.unref()
  } catch (error) {
    await rm(jobPath, { force: true })
    throw error
  }
}

async function runWorker(jobPath: string): Promise<void> {
  let job: ShortcutPresentationJob | undefined
  try {
    job = await readPrivateJson(jobPath) as ShortcutPresentationJob
    if (job.schemaVersion !== 1 || !path.isAbsolute(job.paths.log)) {
      throw new Error('Invalid shortcut presentation job')
    }
    await updateShortcutPresentation(job)
  } catch (error) {
    if (job?.paths.log) {
      await appendFile(
        job.paths.log,
        `[cordisx] background shortcut presentation failed: ${failureMessage(error)}\n`,
        { encoding: 'utf8' },
      ).catch(() => undefined)
    }
  } finally {
    await rm(jobPath, { force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const jobPath = process.argv[2]
  if (jobPath && path.isAbsolute(jobPath)) await runWorker(jobPath)
}
