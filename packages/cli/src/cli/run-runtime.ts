import { randomBytes } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import type { buildRendererBundle } from '../launcher/bundle.js'
import { ensureHomeConfig } from '../config/home-config.js'
import { PluginActivationStore } from '../launcher/plugin-activation.js'
import { loadStagedPluginPackage } from '../launcher/plugin-package.js'
import { managedBackendRuntimeServiceAccess } from '../launcher/packages/managed-backend-service-access.js'
import { createNativeSubmissionComposition } from '../launcher/native-submission-composition.js'
import { ManagedServiceRuntime } from '../launcher/managed-service-runtime.js'
import { type ManagedServiceNodeActivation, ManagedServiceNodeHost } from '../launcher/managed-service-node-host.js'
import type { OwnerDocumentBridgeHandler } from '../launcher/owner-document-rpc.js'
import type { CodexAgentHistoryHost } from '../launcher/agent-history.js'
import type { WorkUsageProfileLocation } from '../launcher/work-usage-profile.js'
import type { openNativeStartupGate } from './startup-gate.js'
import type { OpenManagementCommandService } from './management-command.js'
import type { runInjectedHost } from './run-injected-host.js'

export interface CordisXCliRuntime {
  /** Test-only app installation destination. */
  readonly internalAppOutput?: import('../app-launcher/runtime-install.js').AppCommandOutputOptions
  /** Test-only exact-path replacement for `/usr/bin/open`. */
  readonly internalOpenApp?: (path: string) => void | Promise<void>
  /** Isolated native verification output; never read from user CLI/env. */
  readonly internalShortcutOutput?: import('../shortcuts/model.js').ShortcutOutputOptions
  /** The persistent app launcher may reuse one verified entry for the same live Host generation. */
  readonly internalReuseShortcut?: boolean
  /** Only the signed native shortcut entry supplies this internal path. */
  readonly internalShortcutDockRecordPath?: string
  /** GUI children start outside protected project folders; cwd still records launch intent. */
  readonly internalShortcutSpawnCwd?: string
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  /** Test/integration seam for the canonical default `~/.cordisx` root. */
  readonly homedir?: string
  readonly stdout?: (line: string) => void
  readonly stdin?: Readable & { readonly isTTY?: boolean }
  readonly stderr?: Writable
  /** Repository-only seam until the shared management service is composed. */
  readonly internalOpenPluginManagementService?: OpenManagementCommandService
  /** Test-only confirmation seam. It confirms a mutation, never plugin permissions. */
  readonly internalManagementConfirm?: (prompt: string) => boolean | Promise<boolean>
  /** Test-only cancellation seam for long-lived `cordisx logs --follow`. */
  readonly internalSignal?: AbortSignal
  /** Repository-only detached-supervisor seam; production always spawns the packaged CLI. */
  readonly internalSpawnSupervisor?: (input: {
    readonly args: readonly string[]
    readonly env: NodeJS.ProcessEnv
    readonly logFd: number
  }) => Readonly<{ pid: number; unref(): void }>
  /** Repository-only seam for bounded supervisor failure-path integration tests. */
  readonly internalSupervisorReadinessTimeoutMs?: number
  /** Repository-only startup-gate seam; false keeps command tests headless. */
  readonly internalOpenStartupGate?: false | typeof openNativeStartupGate
  readonly internalScheduleShortcutPresentation?: import('./shortcut-presentation-worker.js').PresentationScheduler
  /** Internal-only renderer bundle closure for repository-controlled production integration tests. */
  readonly internalBuildRendererBundle?: typeof buildRendererBundle
  /** Repository-only proof that the production composition and authority agree. */
  readonly internalObserveOwnerDocuments?: (input: {
    readonly bootstrapSource: string
    readonly source: string
    readonly handler: OwnerDocumentBridgeHandler
  }) => void | Promise<void>
  readonly internalBuiltinSkillSourceDir?: string
  readonly internalBuiltinSkillsSourceRootDir?: string
  readonly internalSharedHomeDir?: string
  readonly internalRunInjectedHost?: typeof runInjectedHost
  readonly internalCreateNativeSubmissionComposition?: typeof createNativeSubmissionComposition
  readonly internalCreateDevelopmentManagedServiceActivation?: typeof createDevelopmentManagedServiceActivation
  readonly internalNativeSubmissionPlatform?: NodeJS.Platform
  readonly internalNativeSubmissionLegacyLockRecovery?: Readonly<{ exitedPid: number; inode: number }>
  readonly internalAgentHistoryHost?: (
    environment: Readonly<Record<string, string>> | NodeJS.ProcessEnv,
    configPath: string,
    profileName: string,
    workProfile?: WorkUsageProfileLocation,
  ) => CodexAgentHistoryHost
}

export async function createDevelopmentManagedServiceActivation(input: {
  readonly homeConfigPath: string
  readonly homeDir: string
  readonly environment: NodeJS.ProcessEnv
  readonly profileId?: string
  readonly runtimeGeneration?: string
}): Promise<ManagedServiceNodeActivation> {
  const homeConfig = await ensureHomeConfig({ configPath: input.homeConfigPath })
  const codex = Object.hasOwn(homeConfig.apps, 'codex') ? homeConfig.apps.codex : undefined
  if (codex === undefined) throw new Error('host app is not configured: codex')
  const runtimeGeneration = input.runtimeGeneration ?? randomBytes(16).toString('hex')
  const store = new PluginActivationStore(input.homeDir, input.profileId ?? codex.defaultProfile, runtimeGeneration)
  const active = await store.loadActive()
  const nestedAccesses = await Promise.all(active.plugins.flatMap(item =>
    item.enabled
      ? [(async () => {
        const staged = await loadStagedPluginPackage(input.homeDir, item.digest)
        if (
          staged.manifest.id !== item.id || staged.manifest.version !== item.version
          || JSON.stringify(staged.manifest.dependencies) !== JSON.stringify(item.dependencies)
        ) throw new Error(`active plugin package metadata failed readback for ${item.id}`)
        const manifest = staged.manifest.runtimeManifest
        if (manifest.schemaVersion !== 14) return []
        return await Promise.all(manifest.services.flatMap(service =>
          service.kind === 'managed-backend'
            ? [managedBackendRuntimeServiceAccess(
              input.homeDir,
              {
                id: item.id,
                version: item.version,
                digest: item.digest,
                moduleGeneration: item.moduleGeneration,
              },
              service.id,
              runtimeGeneration,
            )]
            : []
        ))
      })()]
      : []
  ))
  const host = new ManagedServiceNodeHost(
    new ManagedServiceRuntime({ homeDir: input.homeDir, environment: input.environment }),
    input.profileId ?? codex.defaultProfile,
    runtimeGeneration,
  )
  try {
    return await host.replace(nestedAccesses.flat())
  } catch (error) {
    await host.dispose().catch(() => undefined)
    throw error
  }
}
