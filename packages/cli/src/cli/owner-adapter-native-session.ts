import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { loadValidatedConfigDocument, parseHomeConfig } from '../config/home-config.js'
import { CdpPluginLifecycleRuntime } from '../launcher/cdp.js'
import { loadConfig } from '../launcher/config.js'
import { PluginActivationStore } from '../launcher/plugin-activation.js'
import {
  entityInstallationId,
  entityPluginGeneration,
  issueOwnerDocumentPrincipalToken,
  OwnerDocumentLeaseRegistry,
} from '../launcher/owner-document-rpc.js'
import { startPluginGenerationArtifactServer } from '../launcher/plugin-generation-loader.js'
import { launchFingerprint } from './launch-fingerprint.js'
import { OwnerAdapterCdpClient } from './owner-adapter-cdp-client.js'
import type { OwnerAdapterClient } from './owner-adapter-client.js'
import { createOwnerAdapterGraphBootstrap } from './owner-adapter-graph-bootstrap.js'
import { OwnerAdapterLaunchIntent } from './owner-adapter-launch-intent.js'
import { createOwnerAdapterManagement } from './owner-adapter-management.js'
import { loadOwnerAdapterMutation } from './owner-adapter-mutation.js'
import type { OwnerReconnectionSession } from './run-injected-host.js'
import { type CordisXCliRuntime, pluginIdentities } from './run-support.js'
import type { PreparedRunCommand } from './run-command-dispatch.js'
import { rendererAgentContext } from './renderer-agent-context.js'
import { buildRendererComposition, loadActiveBrowserGraphs } from './renderer-composition.js'

export async function readNativeOwnerConfig(configPath: string) {
  return await loadValidatedConfigDocument(configPath, 'home config', value => ({
    home: parseHomeConfig(value),
    source: JSON.stringify(value),
  }))
}

type Launch = Omit<Parameters<typeof launchFingerprint>[0], 'source' | 'excludePermissions'>
type NativeSessionInput = OwnerReconnectionSession['input']

/** Build a fresh renderer graph from one verified service generation. */
export async function createOwnerAdapterNativeSession(input: {
  readonly owner: OwnerAdapterClient
  readonly ownerSignal: AbortSignal
  readonly prepared: PreparedRunCommand
  readonly runtime: CordisXCliRuntime
  readonly homeDir: string
  readonly launch: Launch
  readonly context: ReturnType<typeof rendererAgentContext>
  readonly requireStableFingerprint?: string
  readonly publishFingerprint: (expected: string, next: string) => Promise<boolean>
  readonly onParticipant: (participant: OwnerAdapterCdpClient) => void
  readonly onReady: (session: {
    readonly owner: OwnerAdapterClient
    readonly participant: OwnerAdapterCdpClient
    readonly fingerprint: string
    readonly intent: OwnerAdapterLaunchIntent
    readonly signal: AbortSignal
  }) => Promise<void>
}): Promise<
  OwnerReconnectionSession & {
    readonly home: Awaited<ReturnType<typeof readNativeOwnerConfig>>['home']
    readonly fingerprint: string
    readonly stableFingerprint: string
  }
> {
  const { owner, prepared, runtime, homeDir, context } = input
  const { appId, configPath, selection, stdout } = prepared
  const generation = owner.snapshot.active.runtimeGeneration
  let artifacts: Awaited<ReturnType<typeof startPluginGenerationArtifactServer>> | undefined
  let renderer: Awaited<ReturnType<typeof buildRendererComposition>> | undefined
  let management: ReturnType<typeof createOwnerAdapterManagement> | undefined
  let participant: OwnerAdapterCdpClient | undefined
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    participant?.close()
    management?.close()
    await Promise.allSettled([owner.close(), renderer?.close(), artifacts?.close()])
  }
  try {
    const [configured, config] = await Promise.all([
      loadConfig(configPath, { profileId: selection.profileId, projectRoot: homeDir }),
      readNativeOwnerConfig(configPath),
    ])
    input.ownerSignal.throwIfAborted()
    const { home, source } = config
    const fingerprint = launchFingerprint({ ...input.launch, source })
    const stableFingerprint = launchFingerprint({ ...input.launch, source, excludePermissions: true })
    if (input.requireStableFingerprint !== undefined && stableFingerprint !== input.requireStableFingerprint) {
      throw new Error('CordisX client configuration changed while disconnected; restart the client')
    }
    const launchIntent = new OwnerAdapterLaunchIntent({
      initialSource: source,
      initialFingerprint: fingerprint,
      launch: input.launch,
      readSource: async () => (await readNativeOwnerConfig(configPath)).source,
      publish: input.publishFingerprint,
    })
    const store = new PluginActivationStore(homeDir, selection.profileId, generation)
    const cdp = new CdpPluginLifecycleRuntime()
    cdp.initializeOwnerRegistryEpoch(owner.snapshot.registryEpoch)
    artifacts = await startPluginGenerationArtifactServer()
    const { activatedPlugins } = await loadActiveBrowserGraphs(store, owner.snapshot.active, {
      homeDir,
      artifactServer: artifacts,
      lifecycleRuntime: cdp,
    })
    const configuredIds = new Set(configured.plugins.map(plugin => plugin.id))
    if (activatedPlugins.some(plugin => configuredIds.has(plugin.id))) {
      throw new Error('configured plugin conflicts with a service-owned package')
    }
    const composition = { ...configured, plugins: [...configured.plugins, ...activatedPlugins] }
    const documentLeases = new OwnerDocumentLeaseRegistry({
      stable: pluginIdentities(configured).map(identity => ({ source: identity.source, pluginId: identity.id })),
      active: activatedPlugins.flatMap(plugin =>
        plugin.enabled && plugin.package !== undefined
          ? [{
            source: plugin.source ?? pathToFileURL(plugin.entry).href,
            pluginId: plugin.id,
            moduleGeneration: plugin.package.moduleGeneration,
          }]
          : []
      ),
    })
    cdp.setOwnerDocumentAuthority({
      leases: documentLeases,
      issue: (identity, moduleGeneration) => ({
        ...identity,
        moduleGeneration,
        installationId: entityInstallationId(selection.profileId, identity.pluginId),
        pluginGeneration: entityPluginGeneration(moduleGeneration),
        token: issueOwnerDocumentPrincipalToken(owner.documentSecret, {
          profileId: selection.profileId,
          generation,
          moduleGeneration,
          identity,
        }),
      }),
    })
    const lifecycleToken = randomBytes(32).toString('hex')
    const managementToken = randomBytes(32).toString('hex')
    management = createOwnerAdapterManagement(owner)
    renderer = await buildRendererComposition(composition, stdout, {
      appId,
      profileId: selection.profileId,
      ownerPolicyVerification: { publicKey: owner.policyPublicKey, rendererId: owner.rendererId },
      ...(selection.profile.iconTheme === undefined ? {} : { iconThemePreference: selection.profile.iconTheme }),
      permission: {
        profileId: selection.profileId,
        policies: home.permissions.filter(policy => policy.key.profileId === selection.profileId),
        persistent: true,
        ownerSnapshot: true,
        nativeOwnerReview: true,
      },
      generation,
      ownerDocumentSecret: owner.documentSecret,
      pluginLifecycle: {
        token: lifecycleToken,
        activation: owner.snapshot.active,
        registryEpoch: owner.snapshot.registryEpoch,
      },
      pluginManagement: { token: managementToken, profileId: selection.profileId },
      agentContextBridgeToken: context.token,
      productionGraph: true,
      ...(runtime.internalBuildRendererBundle === undefined
        ? {}
        : { internalBuildRendererBundle: runtime.internalBuildRendererBundle }),
    })
    if (!renderer.permissionBridgeToken) throw new Error('native-permission-bridge-unavailable')
    const graphBootstrap = createOwnerAdapterGraphBootstrap({
      renderer,
      configured,
      configPath,
      profileId: selection.profileId,
      store,
      cdp,
      current: () => owner.current,
    })
    participant = new OwnerAdapterCdpClient({
      cdp,
      policyScope: { profileId: selection.profileId, generation, rendererId: owner.rendererId },
      onPolicyAdopted: async transition => await launchIntent.adopted(transition),
      loadMutation: async value =>
        await loadOwnerAdapterMutation({
          value,
          homeDir,
          profileId: selection.profileId,
          generation,
          rendererId: owner.rendererId,
        }),
    })
    input.onParticipant(participant)
    input.ownerSignal.throwIfAborted()
    const currentParticipant = participant
    const hostInput: NativeSessionInput = {
      ownerSignal: input.ownerSignal,
      source: renderer.source,
      ...(renderer.newDocumentSource === undefined ? {} : { newDocumentSource: renderer.newDocumentSource }),
      hasLoopbackGraph: renderer.hasLoopbackGraph,
      pluginArtifactOrigin: artifacts.origin,
      productionGraphBootstrap: graphBootstrap,
      agentHistoryBridgeToken: renderer.agentHistoryBridgeToken,
      remoteOwnerDocuments: { request: async payload => await owner.documentBinding(payload) },
      remoteMarketplaceArtifact: { request: async (payload, signal) => await owner.artifact(payload, signal) },
      permissionPersistence: {
        configPath,
        profileId: selection.profileId,
        token: renderer.permissionBridgeToken!,
        identities: [],
        // The service, rather than the launcher page, validates the exact active package.
        identityAllowed: () => true,
        remote: {
          register: async (keyId, key) => await owner.permission({ kind: 'permission-key-register', keyId, key }, true),
          write: async (request, proof) =>
            await owner.permission({ kind: 'permission-policy-write', ...request, proof }),
          once: async request => await owner.permission({ kind: 'permission-once', ...request }),
          uncertain: () => owner.invalidate(),
        },
      },
      agentContext: context.binding,
      remotePluginLifecycle: {
        scope: { token: lifecycleToken, profileId: selection.profileId, generation },
        request: async envelope => await owner.lifecycle(envelope),
        runtime: cdp,
      },
      pluginManagement: {
        token: managementToken,
        profileId: selection.profileId,
        generation,
        service: management,
        ownerCoordinated: true,
      },
      onReady: async signal => {
        const readySignal = signal === undefined ? input.ownerSignal : AbortSignal.any([signal, input.ownerSignal])
        readySignal.throwIfAborted()
        if (
          launchFingerprint({ ...input.launch, source: (await readNativeOwnerConfig(configPath)).source })
            !== fingerprint
        ) {
          throw new Error('CordisX client configuration changed during renderer admission')
        }
        await input.onReady({
          owner,
          participant: currentParticipant,
          fingerprint,
          intent: launchIntent,
          signal: readySignal,
        })
      },
    }
    return { input: hostInput, close, home, fingerprint, stableFingerprint }
  } catch (error) {
    await close()
    throw error
  }
}
