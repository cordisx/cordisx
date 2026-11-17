import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ResolvedLaunchPlan } from '../adapters/contracts.js'
import { resolveBundledCodexCliPath } from './native-submission-composition.js'
import { codexHomeOfPlan } from './model-service-projection.js'
import { headlessLiveBudgetEnabled, prepareHeadlessStaticCatalog } from './headless-static-catalog.js'

const execFileAsync = promisify(execFile)
const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u
const within = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export interface DesktopStaticCatalogLease {
  readonly path: string
  /** A fresh copy each time; callers cannot mutate the captured evidence. */
  readonly bytes: Uint8Array
  readonly sha256: string
  readonly nativeVersion: string
  close(): Promise<void>
}

/** Prepare before any possible Desktop prelaunch, using the same selected plan as that launch. */
export async function prepareDesktopStaticCatalog(input: {
  readonly plan: ResolvedLaunchPlan
  readonly cordisxHome: string
  /** Effective HOME and cwd of the Desktop launch, after applying plan.environment. */
  readonly userHome: string
  readonly cwd: string
  readonly environment: NodeJS.ProcessEnv
  /** Test seam for the normal app-server preflight; not a caller-provided result. */
  readonly startProbe?: Parameters<typeof prepareHeadlessStaticCatalog>[0]['startProbe']
}): Promise<DesktopStaticCatalogLease | undefined> {
  const { plan, cordisxHome, userHome, cwd, startProbe } = input
  const desktopExecutable = plan.executable
  if (
    plan.appId !== 'codex' || !PROFILE_ID.test(plan.profileId)
    || !path.isAbsolute(cordisxHome) || !path.isAbsolute(userHome) || !path.isAbsolute(cwd)
  ) return undefined
  const codexHome = codexHomeOfPlan(plan)
  if (!codexHome || !path.isAbsolute(codexHome)) return undefined
  const environment = { ...input.environment, ...plan.environment }
  const effectiveHome = environment.HOME ?? userHome
  const effectiveCodexHome = environment.CODEX_HOME ?? path.join(effectiveHome, '.codex')
  if (
    !path.isAbsolute(effectiveHome) || !path.isAbsolute(effectiveCodexHome)
    || path.resolve(effectiveHome) !== path.resolve(userHome)
    || path.resolve(effectiveCodexHome) !== path.resolve(codexHome)
  ) return undefined
  const stateFile = path.join(
    cordisxHome,
    'apps',
    plan.appId,
    'profiles',
    plan.profileId,
    'channel-conversations.json',
  )
  if (!await headlessLiveBudgetEnabled(stateFile)) return undefined
  try {
    const executable = await realpath(desktopExecutable), macos = path.dirname(executable)
    if (path.basename(macos) !== 'MacOS' || path.basename(path.dirname(macos)) !== 'Contents') return undefined
    const contents = path.dirname(macos), resources = await realpath(path.join(contents, 'Resources'))
    if (!within(contents, resources)) return undefined
    const cli = await resolveBundledCodexCliPath(contents)
    if (!within(resources, cli)) return undefined
    const versionResult = await execFileAsync(cli, ['--version'], {
      cwd,
      env: { ...environment, HOME: userHome, CODEX_HOME: codexHome },
      timeout: 5_000,
      maxBuffer: 4096,
    })
    const versionMatch = /^codex-cli (0\.167\.0-alpha\.3\.2)$/u.exec(versionResult.stdout.trim())
    if (!versionMatch) return undefined
    const nativeVersion = versionMatch[1]!
    const lease = await prepareHeadlessStaticCatalog({
      enabled: true,
      nativeVersion,
      executable: cli,
      codexHome,
      userHome,
      cwd,
      startupCwd: cwd,
      environment,
      ...(startProbe === undefined ? {} : { startProbe }),
    })
    if (!lease) return undefined
    try {
      const bytes = Uint8Array.from(lease.bytes)
      let closing: Promise<void> | undefined
      return Object.freeze({
        path: lease.path,
        sha256: lease.sha256,
        nativeVersion,
        get bytes() {
          return Uint8Array.from(bytes)
        },
        close: () => closing ??= lease.close(),
      })
    } catch {
      await lease.close().catch(() => undefined)
      return undefined
    }
  } catch {
    return undefined
  }
}
