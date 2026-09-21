import { randomBytes } from 'node:crypto'
import { lstat, open, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveHostAdapter } from '../adapters/registry.js'
import { resolveOwningPackageVersion } from '../launcher/package-version.js'
import {
  createDefaultHomeConfig,
  loadHomeConfig,
  resolveHomeConfigMarketplaceSources,
  resolveHomeConfigPath,
} from '../config/home-config.js'
import { resolveProfileSelection } from '../cli/profiles.js'
import {
  hasMatchingProcess,
  hasMatchingProcessIdentity,
  stateFileIsPrivate,
  type SupervisorPaths,
  supervisorPaths,
  type SupervisorState,
} from '../cli/supervisor-state.js'
import { type CordisXFeedbackInvocation } from '../cli/parse.js'
import { type CordisXCliRuntime, rootFromConfigPath } from '../cli/run-support.js'
import { safeDiagnosticMessage } from '../launcher/diagnostic-redaction.js'
import {
  FEEDBACK_MANIFEST_CONTRACT,
  FEEDBACK_POLICY_VERSION,
  type FeedbackArtifact,
  type FeedbackManifest,
  type FeedbackResult,
} from './contracts.js'
import { inspectFeedbackBundle, makePrivateStage, publishPrivateStage, writePrivateFile } from './archive.js'
import { feedbackReference, redactFeedbackText } from './redaction.js'

const DEFAULT_LOOKBACK_SECONDS = 15 * 60
const MAX_LOOKBACK_SECONDS = 24 * 60 * 60
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const MAX_BYTES = 10 * 1024 * 1024
const MAX_LOG_BYTES = 512 * 1024
const MAX_DESCRIPTION_BYTES = 8 * 1024
const EXCLUSIONS = [
  'conversation_content',
  'prompts',
  'credentials',
  'cookies',
  'complete_config',
  'complete_urls',
  'absolute_paths',
  'screenshots',
  'project_files',
  'browser_storage',
] as const
const VERSION = await resolveOwningPackageVersion(import.meta.url, 'cordisx')

function iso(value: number): string {
  return new Date(value).toISOString()
}

function countValues(values: readonly Readonly<Record<string, number>>[]): Readonly<Record<string, number>> {
  const output: Record<string, number> = Object.create(null) as Record<string, number>
  for (const value of values) {
    for (const [category, amount] of Object.entries(value)) {
      output[category] = (output[category] ?? 0) + amount
    }
  }
  return output
}

function total(values: Readonly<Record<string, number>>): number {
  return Object.values(values).reduce((sum, value) => sum + value, 0)
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function readRegular(target: string): Promise<Buffer | undefined> {
  try {
    const metadata = await lstat(target)
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined
    return await readFile(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function readBoundedRegularText(
  target: string,
  maxBytes: number,
): Promise<{ readonly text: string; readonly omittedBytes: number } | undefined> {
  try {
    const before = await lstat(target)
    if (!before.isFile() || before.isSymbolicLink()) return undefined
    const handle = await open(target, 'r')
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error('feedback log changed while being opened')
      }
      const size = opened.size
      if (size <= maxBytes) {
        const buffer = Buffer.alloc(size)
        const { bytesRead } = await handle.read(buffer, 0, size, 0)
        return { text: buffer.subarray(0, bytesRead).toString('utf8'), omittedBytes: 0 }
      }
      const markerBudget = 96
      const side = Math.max(1, Math.floor((maxBytes - markerBudget) / 2))
      const head = Buffer.alloc(side)
      const tail = Buffer.alloc(side)
      const headRead = await handle.read(head, 0, side, 0)
      const tailStart = Math.max(0, size - side)
      const tailRead = await handle.read(tail, 0, side, tailStart)
      const omittedBytes = Math.max(0, size - headRead.bytesRead - tailRead.bytesRead)
      return {
        text: `${head.subarray(0, headRead.bytesRead).toString('utf8')}\n[TRUNCATED ${omittedBytes} BYTES]\n${
          tail.subarray(0, tailRead.bytesRead).toString('utf8')
        }`,
        omittedBytes,
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function addArtifact(
  artifact: FeedbackArtifact,
  metadata: Pick<FeedbackArtifact, 'purpose' | 'evidenceType' | 'status' | 'redactions' | 'omittedBytes'>,
): FeedbackArtifact {
  return { ...artifact, ...metadata }
}

async function supervisorProjection(
  state: SupervisorState | undefined,
  paths: SupervisorPaths,
  lock: { readonly present: boolean; readonly private: boolean; readonly ageSeconds?: number },
): Promise<unknown> {
  const processIdentity = state === undefined || state.processStartedAt === 'unknown'
    ? 'unknown'
    : await hasMatchingProcess(state)
    ? 'matching'
    : 'stale'
  const hostProcessIdentity = state?.hostPid === undefined || state.hostProcessStartedAt === undefined
    ? 'unknown'
    : await hasMatchingProcessIdentity(state.hostPid, state.hostProcessStartedAt)
    ? 'matching'
    : 'stale'
  return {
    supervisor: state === undefined ? { status: 'missing' } : {
      phase: state.phase,
      createdAt: state.createdAt,
      processIdentity,
      hostProcessIdentity,
      statePrivate: await stateFileIsPrivate(paths),
      failure: state.failure === undefined ? undefined : 'present',
    },
    startLock: {
      present: lock.present,
      private: lock.private,
      ...(lock.ageSeconds === undefined ? {} : { ageSeconds: lock.ageSeconds }),
    },
  }
}

function pluginSourceClass(entry: string): 'https' | 'http' | 'file' | 'path' | 'package' {
  if (entry.startsWith('https://')) return 'https'
  if (entry.startsWith('http://')) return 'http'
  if (entry.startsWith('file:')) return 'file'
  return path.isAbsolute(entry) || entry.startsWith('./') || entry.startsWith('../') ? 'path' : 'package'
}

async function doctorProjection(input: {
  readonly appId: string
  readonly appRef?: string
  readonly profileRef: string
  readonly profileId: string
  readonly dataMode: 'shared' | 'host-isolated'
  readonly homeDir: string
}): Promise<unknown> {
  const target = {
    app: {
      kind: input.appId === 'codex' ? 'codex' : 'other',
      ...(input.appRef === undefined ? {} : { ref: input.appRef }),
    },
    profile: { ref: input.profileRef },
    dataMode: input.dataMode,
  }
  try {
    const plan = await resolveHostAdapter(input.appId).resolveLaunchPlan({
      cordisxHomeDir: input.homeDir,
      profileId: input.profileId,
      dataMode: input.dataMode,
    })
    return {
      status: 'available',
      target,
      chromiumMode: plan.chromiumProfile.mode,
      sharedRootCount: plan.sharedDataRoots.length,
      isolatedRootCount: plan.isolatedDataRoots.length,
      environmentKeys: Object.keys(plan.environment).sort(),
    }
  } catch (error) {
    return { status: 'unavailable', target, reason: safeDiagnosticMessage(error) }
  }
}

function legacyDisposition(
  text: string,
  phase: SupervisorState['phase'] | undefined,
): FeedbackManifest['selection']['disposition'] {
  const lower = text.toLowerCase()
  if (/renderer[^\n]*(?:injected|ready)|injection[^\n]*success/u.test(lower)) {
    return /cleanup[^\n]*(?:failed|incomplete|rejected)/u.test(lower) ? 'ready_then_cleanup_degraded' : 'ready'
  }
  if (/injection[^\n]*(?:failed|error)/u.test(lower)) return 'injection_failed'
  if (phase === 'failed') return 'launch_failed'
  if (phase === 'stopping') return 'terminated'
  return 'unknown'
}

export async function collectFeedback(
  invocation: CordisXFeedbackInvocation,
  runtime: CordisXCliRuntime,
): Promise<FeedbackResult> {
  if (invocation.feedbackAction !== 'collect') throw new Error('feedback collection requires collect')
  const now = Date.now()
  const lookbackSeconds = invocation.since === undefined ? DEFAULT_LOOKBACK_SECONDS : parseDuration(invocation.since)
  if (lookbackSeconds > MAX_LOOKBACK_SECONDS) throw new Error('feedback lookback exceeds 24 hours')
  const from = invocation.from === undefined ? now - lookbackSeconds * 1000 : parseTime(invocation.from, '--from')
  const until = invocation.until === undefined ? now : parseTime(invocation.until, '--until')
  if (from > until || until > now + 60_000) throw new Error('feedback time range is invalid')
  const maxBytes = invocation.maxBytes ?? DEFAULT_MAX_BYTES
  if (maxBytes > MAX_BYTES) throw new Error('feedback --max-bytes exceeds 10485760')
  const environment = runtime.env ?? process.env
  const configPath = resolveHomeConfigPath({
    env: environment,
    ...(runtime.homedir === undefined ? {} : { homedir: runtime.homedir }),
  })
  const homeDir = rootFromConfigPath(configPath)
  let configMissing = false
  const config = await loadHomeConfig({ configPath }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    configMissing = true
    return createDefaultHomeConfig()
  })
  const appId = invocation.app ?? config.defaultApp
  const selection = await resolveProfileSelection({
    config,
    configPath,
    appId,
    ...(invocation.profile === undefined ? {} : { profileId: invocation.profile }),
    persistMissing: false,
  })
  const paths = supervisorPaths(homeDir, selection.appId, selection.profileId)
  const state = await readSupervisorStateSafely(paths.state)
  if (invocation.launch !== undefined) throw new Error('launch_selection_unsupported_without_structured_ledger')
  const bundleKey = randomBytes(32)
  const bundleId = `fb_${randomBytes(12).toString('hex')}`
  const timestamp = new Date(now).toISOString().replace(/[:.]/gu, '-')
  const root = invocation.output === undefined ? path.join(homeDir, 'feedback') : path.resolve(invocation.output)
  const finalPath = invocation.output === undefined
    ? path.join(root, `cordisx-feedback-${timestamp}-${bundleId.slice(3, 11)}`)
    : root
  const stage = await makePrivateStage(path.dirname(finalPath), path.basename(finalPath))
  const artifacts: FeedbackArtifact[] = []
  const missing: FeedbackManifest['missing'][number][] = [{
    field: 'native_host_log',
    status: 'unsupported',
    reason: 'unsupported_host_build',
  }]
  if (configMissing) missing.push({ field: 'home_config', status: 'missing', reason: 'not_found_using_defaults' })
  const redactionCounts: Readonly<Record<string, number>>[] = []
  try {
    const appRef = selection.appId === 'codex' ? undefined : feedbackReference(bundleKey, 'app', selection.appId)
    const profileRef = feedbackReference(bundleKey, 'profile', selection.profileId)
    const environmentArtifact = addArtifact(
      await writePrivateFile(
        stage,
        'diagnostics/environment.json',
        json({
          cordisxVersion: VERSION,
          nodeVersion: process.version,
          platform: platformName(process.platform),
          arch: process.arch,
          hostVersion: null,
          hostBuild: null,
        }),
      ),
      {
        purpose: 'runtime environment projection',
        evidenceType: 'environment_projection',
        status: 'present',
        redactions: 0,
      },
    )
    artifacts.push(environmentArtifact)
    artifacts.push(addArtifact(
      await writePrivateFile(
        stage,
        'diagnostics/doctor.json',
        json(
          await doctorProjection({
            appId: selection.appId,
            ...(appRef === undefined ? {} : { appRef }),
            profileRef,
            profileId: selection.profileId,
            dataMode: selection.dataMode,
            homeDir,
          }),
        ),
      ),
      {
        purpose: 'privacy-safe launch plan projection',
        evidenceType: 'environment_projection',
        status: 'present',
        redactions: 0,
      },
    ))
    const lockMetadata = await lstat(paths.lock).then(metadata => ({
      present: true,
      private: metadata.isFile() && !metadata.isSymbolicLink()
        && (process.platform === 'win32' || (metadata.mode & 0o077) === 0),
      ageSeconds: Math.max(0, Math.floor((now - metadata.mtimeMs) / 1000)),
    })).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { present: false, private: false }
      throw error
    })
    artifacts.push(addArtifact(
      await writePrivateFile(
        stage,
        'diagnostics/supervisor.json',
        json(await supervisorProjection(state, paths, lockMetadata)),
      ),
      {
        purpose: 'supervisor and lock metadata',
        evidenceType: 'environment_projection',
        status: 'present',
        redactions: 0,
      },
    ))
    const sources = resolveHomeConfigMarketplaceSources(config, selection.profileId, selection.appId).map(source => ({
      ref: feedbackReference(bundleKey, 'source', source.url),
      enabled: source.enabled,
      trusted: source.trusted,
      sourceClass: new URL(source.url).protocol === 'https:' ? 'https' : 'http',
    }))
    artifacts.push(addArtifact(
      await writePrivateFile(
        stage,
        'diagnostics/plugins.json',
        json(config.plugins.map(plugin => ({
          ref: feedbackReference(bundleKey, 'plugin', plugin.id),
          sourceRef: feedbackReference(bundleKey, 'plugin-source', plugin.entry),
          version: 'unknown',
          enabled: plugin.enabled !== false,
          state: plugin.enabled === false ? 'disabled' : 'configured',
          sourceClass: pluginSourceClass(plugin.entry),
        }))),
      ),
      { purpose: 'installed plugin summary', evidenceType: 'environment_projection', status: 'present', redactions: 0 },
    ))
    artifacts.push(addArtifact(
      await writePrivateFile(stage, 'diagnostics/sources.json', json(sources)),
      {
        purpose: 'Marketplace source summary',
        evidenceType: 'environment_projection',
        status: 'present',
        redactions: 0,
      },
    ))
    artifacts.push(addArtifact(
      await writePrivateFile(
        stage,
        'diagnostics/providers.json',
        json(config.providers.map(provider => ({
          ref: feedbackReference(bundleKey, 'provider', provider.id),
          kind: provider.kind,
          enabled: provider.enabled !== false,
          disposition: 'configured',
        }))),
      ),
      { purpose: 'provider status summary', evidenceType: 'environment_projection', status: 'present', redactions: 0 },
    ))
    const reservedBytes = 16 * 1024
    const logBudget = Math.max(1, Math.min(MAX_LOG_BYTES, maxBytes - reservedBytes))
    const logExcerpt = await readBoundedRegularText(paths.log, logBudget)
    let logText = ''
    if (logExcerpt === undefined) {
      missing.push({ field: 'host_log', status: 'missing', reason: 'not_found' })
    } else {
      const sanitized = redactFeedbackText(logExcerpt.text, [homeDir, process.cwd()])
      redactionCounts.push(sanitized.counts)
      logText = sanitized.text
      artifacts.push(addArtifact(
        await writePrivateFile(stage, 'diagnostics/host-log.txt', sanitized.text),
        {
          purpose: 'bounded legacy supervisor log excerpt',
          evidenceType: 'product_log',
          status: logExcerpt.omittedBytes === 0 ? 'present' : 'truncated',
          redactions: total(sanitized.counts),
          ...(logExcerpt.omittedBytes === 0 ? {} : { omittedBytes: logExcerpt.omittedBytes }),
        },
      ))
    }
    if (invocation.descriptionFile !== undefined) {
      const rawDescription = await readRegular(path.resolve(invocation.descriptionFile))
      if (rawDescription === undefined) throw new Error('description_file_not_found')
      if (rawDescription.length > MAX_DESCRIPTION_BYTES) throw new Error('description_file_too_large')
      const sanitized = redactFeedbackText(rawDescription.toString('utf8'), [homeDir, process.cwd()])
      redactionCounts.push(sanitized.counts)
      artifacts.push(addArtifact(
        await writePrivateFile(stage, 'user/description.txt', sanitized.text),
        {
          purpose: 'user-authored report',
          evidenceType: 'user_report',
          status: 'present',
          redactions: total(sanitized.counts),
        },
      ))
    }
    artifacts.push(addArtifact(
      await writePrivateFile(
        stage,
        'README.txt',
        'CordisX local feedback bundle. Review manifest.json before export.\n',
      ),
      { purpose: 'local review notice', evidenceType: 'environment_projection', status: 'present', redactions: 0 },
    ))
    const counts = countValues(redactionCounts)
    const manifest: FeedbackManifest = {
      contract: FEEDBACK_MANIFEST_CONTRACT,
      schemaVersion: 1,
      bundleId,
      createdAt: iso(now),
      producer: {
        cordisxVersion: VERSION,
        nodeVersion: process.version,
        platform: platformName(process.platform),
        osVersion: os.release(),
        arch: process.arch,
        hostVersion: null,
        hostBuild: null,
      },
      policy: { version: FEEDBACK_POLICY_VERSION, localOnly: true, contentCollection: 'excluded' },
      target: {
        app: {
          kind: selection.appId === 'codex' ? 'codex' : 'other',
          ...(appRef === undefined ? {} : { ref: appRef }),
        },
        profile: { kind: selection.profileId === 'default' ? 'default' : 'named', ref: profileRef },
        dataMode: selection.dataMode,
      },
      selection: {
        launchId: state === undefined ? null : feedbackReference(bundleKey, 'launch', state.instanceToken),
        from: iso(from),
        until: iso(until),
        correlationConfidence: logExcerpt === undefined ? 'none' : 'partial',
        disposition: legacyDisposition(logText, state?.phase),
        cdpPort: null,
      },
      limits: { lookbackSeconds, maxBytes, maxEvents: 2000, collectionTimeoutMs: 10000 },
      artifacts,
      exclusions: EXCLUSIONS.map(category => ({ category, reason: 'excluded_by_feedback_policy' })),
      missing,
      redactions: { total: total(counts), byCategory: counts },
      warnings: logExcerpt === undefined
        ? []
        : [{ code: 'legacy_partial_correlation', message: 'host.log has no structured launch ledger' }],
    }
    const manifestSource = json(manifest)
    await writePrivateFile(stage, 'manifest.json', manifestSource)
    await inspectFeedbackBundle(stage)
    await publishPrivateStage(stage, finalPath)
    const bytes = artifacts.reduce((sum, artifact) => sum + artifact.bytes, Buffer.byteLength(manifestSource))
    return {
      status: 'collected',
      bundlePath: finalPath,
      manifestPath: path.join(finalPath, 'manifest.json'),
      bundleId,
      summary: {
        launches: state === undefined ? 0 : 1,
        includedArtifacts: artifacts.length,
        excludedCategories: EXCLUSIONS.length,
        missingSources: missing.length,
        redactions: total(counts),
        bytes,
      },
    }
  } catch (error) {
    await import('node:fs/promises').then(({ rm }) => rm(stage, { recursive: true, force: true }))
    throw error
  }
}

async function readSupervisorStateSafely(statePath: string): Promise<SupervisorState | undefined> {
  try {
    const source = await readRegular(statePath)
    if (source === undefined) return undefined
    const value = JSON.parse(source.toString('utf8')) as Partial<SupervisorState>
    return value.schemaVersion === 1 && typeof value.instanceToken === 'string' && typeof value.phase === 'string'
      ? value as SupervisorState
      : undefined
  } catch {
    return undefined
  }
}

function parseTime(value: string, label: string): number {
  const result = Date.parse(value)
  if (!Number.isFinite(result)) throw new Error(`${label} requires an ISO-8601 timestamp`)
  return result
}

function parseDuration(value: string): number {
  const match = /^(\d+)([smhd])$/u.exec(value)
  if (match === null) throw new Error('--since requires a duration such as 15m')
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as 's' | 'm' | 'h' | 'd']
  return Number(match[1]) * multiplier
}

function platformName(platform: NodeJS.Platform): 'darwin' | 'linux' | 'win32' | 'other' {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32' ? platform : 'other'
}
