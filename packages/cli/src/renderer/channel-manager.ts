import {
  originalService,
  projectionFor,
  registerChannelManagerState,
  registerChannelServiceFacade,
  serviceOwnerFor,
  stateFor,
} from './channel-manager-state.js'
import { type Context, type Disposable, Service } from '@deepseek-ai/cordis'
import type {
  ChannelManagerLogExportResultV2,
  ChannelManagerLogPageV2,
  ChannelManagerRequestV2,
  ChannelManagerResultV2,
  ChannelManagerSnapshotV3,
  ChannelManagerTargetRequestV1,
  ChannelManagerTargetResultV1,
} from '@cordisx/protocol/channel-manager/v2'
import type { ChannelManagerSnapshotV4 } from '@cordisx/protocol/channel-manager/v3'
import type { ChannelManagerConnectionConfigurationV1, ChannelManagerV4 } from '@cordisx/protocol/channel-manager/v4'
import type { ChannelManagerV6 } from '@cordisx/protocol/channel-manager/v6'
import type {
  ChannelManagerFormMountResultV1,
  ChannelManagerFormOptionsV1,
  ChannelManagerV7,
} from '@cordisx/protocol/channel-manager/v7'
import type { ChannelManagerV8 } from '@cordisx/protocol/channel-manager/v8'
import type { ChannelManagerBindingPageV2, ChannelManagerV9 } from '@cordisx/protocol/channel-manager/v9'
import type { ChannelManagerV10 } from '@cordisx/protocol/channel-manager/v10'
import type { ChannelSettingsFormSectionV2 } from '@cordisx/protocol/channel-manager/v12'
import type { ChannelManagerV14 } from '@cordisx/protocol/channel-manager/v14'
import { mountChannelManagerSettings } from './channel-manager-settings-mount.js'
import { mountContinuationDefaults } from './channel-continuation-defaults-workflow.js'
import { ChannelSettingsWorkflow } from './channel-settings-workflow.js'
import { initializeChannelManagerWorkflows } from './channel-manager-workflows.js'
import { registerChannelSettingsDestination } from './channel-settings-destination.js'
import { ChannelConversationWorkflow } from './channel-conversation-workflow.js'
import {
  channelConnectionFormSnapshot,
  mountChannelConnectionForm,
  mountLegacyChannelCredentialForm,
} from './channel-connection-form-mount.js'
import { mutateChannelConnectionConfiguration } from './channel-connection-configuration.js'
import { managedConsoleSeatFor } from './managed-console-seats.js'
import type {
  HostServiceConfigDescriptor,
  HostServiceConfigMutation,
  HostServiceConfigMutationResult,
} from '../launcher/service-config.js'
import type { ChannelManagerActionResult } from '../launcher/channel-manager-api.js'
import { ChannelCredentialWorkflow } from './channel-credential-workflow.js'
import { captureChannelCredential } from './channel-credential-prompt.js'
import type { ChannelCredentialDraftResult, ChannelCredentialRef } from '../launcher/channel-credential-drafts.js'
import type { PermissionBroker } from './platform.js'
import type { RequestedScope } from './platform/platform-permission-store.js'
import { generationVisibilityFromContext } from './generation-visibility.js'
import { generationFromContext, ownerFromContext, sourceFromContext } from './ownership.js'
import { PublicChannelManagerController } from './channel-manager-public.js'
import { restrictChannelManagerActions } from './channel-manager-actions.js'
import { markChannelSnapshotUnavailable, readChannelSnapshot } from './channel-manager-unavailable.js'
import {
  type ChannelManagerConnectionProjection,
  type ChannelManagerProjectionV1,
  compositeRef,
  EMPTY_PROJECTION,
  normalizeProjection,
  withRuntimeProjection,
} from './channel-manager-projection.js'
export type {
  ChannelManagerAccountProjection,
  ChannelManagerBindingProjection,
  ChannelManagerConnectionProjection,
  ChannelManagerDiagnosticProjection,
  ChannelManagerLogProjection,
  ChannelManagerProjectionV1,
  ChannelManagerRouteProjection,
  ChannelProductStatus,
} from './channel-manager-projection.js'

/** This renderer client can invoke only the launcher allowlist and receives only the redacted result projection. */
export interface ChannelManagerActionsApi {
  /** Only a current redacted snapshot can be requested through this bridge. */
  readonly snapshotOnly?: true
  run(
    action:
      | 'enable'
      | 'disable'
      | 'reconnect'
      | 'archive'
      | 'restore'
      | 'unbind'
      | 'snapshot'
      | 'policy'
      | 'policy-set'
      | 'continuation-defaults'
      | 'continuation-defaults-set'
      | 'execution-defaults'
      | 'execution-defaults-set'
      | 'channel-execution-defaults'
      | 'channel-execution-defaults-set'
      | 'execution-settings'
      | 'execution-settings-set'
      | 'model-list'
      | 'task-config'
      | 'task-config-set'
      | 'task-settings'
      | 'task-settings-set'
      | 'binding-labels'
      | 'conversation-page'
      | 'conversation-detail'
      | 'conversation-activity'
      | 'conversation-bindings'
      | 'binding-navigation',
    input: Record<string, unknown>,
  ): Promise<ChannelManagerActionResult>
}

export interface ChannelManagerServiceConfigApi {
  list(): Promise<readonly HostServiceConfigDescriptor[]>
  mutate(mutation: HostServiceConfigMutation): Promise<HostServiceConfigMutationResult>
}

export interface ChannelManagerServiceInput {
  readonly navigateConversation?: (sessionId: string) => Promise<void> | void
  readonly presentationMode?: 'standard' | 'snapshot-only'
  readonly profileId?: string
  readonly hostGeneration?: string
  readonly projection?: ChannelManagerProjectionV1
  readonly serviceConfig?: ChannelManagerServiceConfigApi
  /** Host captures a transient credential and performs the entire private config write. */
  readonly createCredentialedConnection?: (input: {
    readonly account: ChannelManagerConnectionProjection['ref']
    readonly secret: string
    readonly mutation: HostServiceConfigMutation
  }) => Promise<HostServiceConfigMutationResult>
  readonly credentialRequest?: (
    input: Record<string, unknown>,
  ) => Promise<ChannelCredentialDraftResult & { projection?: unknown }>
  readonly broker?: PermissionBroker
  readonly document?: Document
  readonly actions?: ChannelManagerActionsApi
  /** Host generation lifetime; an old renderer may never adopt new account artwork. */
  readonly isCurrent?: () => boolean
}

/** Public opaque Channel Manager service backed by the Host-owned runtime projection. */
export class CordisXChannelManagerService extends Service implements ChannelManagerV14 {
  constructor(ctx: Context, input: unknown = EMPTY_PROJECTION) {
    super(ctx, 'channelManager')
    const candidate = input as ChannelManagerProjectionV1 | ChannelManagerServiceInput
    const wrapped = 'projection' in candidate || 'serviceConfig' in candidate || 'credentialRequest' in candidate
        || 'presentationMode' in candidate || 'actions' in candidate
      ? candidate as ChannelManagerServiceInput
      : { projection: candidate as ChannelManagerProjectionV1 }
    const snapshotOnly = wrapped.presentationMode === 'snapshot-only' || wrapped.actions?.snapshotOnly === true
    if (
      snapshotOnly && (wrapped.serviceConfig !== undefined || wrapped.credentialRequest !== undefined
        || wrapped.createCredentialedConnection !== undefined)
    ) throw new Error('snapshot-only Channel Manager cannot expose configuration or credentials')
    const actions = restrictChannelManagerActions(wrapped.actions, snapshotOnly)
    registerChannelManagerState(this, {
      projection: normalizeProjection(wrapped.projection ?? EMPTY_PROJECTION),
      snapshotOnly,
      ...(wrapped.credentialRequest === undefined ? {} : { credentialRequest: wrapped.credentialRequest }),
      ...(wrapped.broker === undefined ? {} : { broker: wrapped.broker }),
      ...(wrapped.serviceConfig === undefined ? {} : { serviceConfig: wrapped.serviceConfig }),
      ...(wrapped.createCredentialedConnection === undefined
        ? {}
        : { createCredentialedConnection: wrapped.createCredentialedConnection }),
      ...(actions === undefined ? {} : { actions }),
      localConnections: [],
      listeners: new Set<() => void>(),
      cachedProjection: undefined,
      refreshSequence: 0,
      lifetime: new AbortController(),
      disposed: false,
      settings: new ChannelSettingsWorkflow(),
      isCurrent: wrapped.isCurrent ?? (() => true),
    })
    const state = stateFor(this)
    if (wrapped.credentialRequest !== undefined && wrapped.document !== undefined) {
      state.credentials = new ChannelCredentialWorkflow({
        available: () => !state.disposed && state.isCurrent() && state.projection.service.writable,
        revision: () => state.publicController!.currentRevision(),
        advance: () => {
          state.publicController!.invalidate()
          this.notifyListeners()
        },
        target: token => state.publicController!.target(token),
        connectionToken: ref => state.publicController!.tokenFor(ref),
        rekeyConnection: (pending, resolved) => state.publicController!.resolvePendingToken(pending, resolved),
        prompt: input => captureChannelCredential({ ...input, document: wrapped.document! }),
        request: wrapped.credentialRequest,
        adopt: projection => {
          state.projection = normalizeProjection(projection as ChannelManagerProjectionV1)
          delete state.runtimeProjection
        },
      })
    }
    if (!snapshotOnly) initializeChannelManagerWorkflows(state, wrapped)
    state.publicController = new PublicChannelManagerController({
      profileId: wrapped.profileId ?? 'default',
      hostGeneration: wrapped.hostGeneration ?? 'host-unavailable',
      projection: () => projectionFor(this),
      ...(state.credentials === undefined ? {} : { credentials: state.credentials }),
      configurationAvailable: () => state.serviceConfig !== undefined && state.projection.service.writable,
      update: (ref, patch) => this.updateConfiguration(ref, patch),
      actionsAvailable: () => stateFor(this).actions !== undefined && stateFor(this).actions!.snapshotOnly !== true,
      logsAvailable: () => !snapshotOnly,
      runAction: async (action, value) => await this.runAction(action, value),
    })
    if (snapshotOnly && actions === undefined) markChannelSnapshotUnavailable(state)
    if (actions && !snapshotOnly) {
      state.conversations = new ChannelConversationWorkflow({
        profileId: wrapped.profileId ?? 'default',
        hostGeneration: wrapped.hostGeneration ?? 'host-unavailable',
        controller: state.publicController,
        actions,
        caller: 'detached',
        live: () => false,
        authorize: async () => false,
        ...(wrapped.navigateConversation === undefined ? {} : { navigate: wrapped.navigateConversation }),
      })
    }
    ctx.effect(() => () => {
      const state = stateFor(this)
      state.disposed = true
      state.lifetime.abort()
      state.credentials?.dispose()
      state.conversations?.dispose()
      state.settings.clear()
      state.refreshSequence += 1
      delete state.runtimeProjection
      state.listeners.clear()
    }, 'cordisx: Channel account identity lifetime')
  }

  snapshot(): ChannelManagerSnapshotV3 {
    this.assertOwnedRead()
    return stateFor(this).publicController!.snapshot()
  }

  forOwnService(): ChannelManagerV4 | undefined {
    if (!this.operationLive()) return undefined
    const id = ownerFromContext(this.ctx),
      source = sourceFromContext(this.ctx),
      generation = generationFromContext(this.ctx)
    if (!source || !generation) return undefined
    const owner = stateFor(this).broker?.serviceOwner(
      { id, source },
      generation,
      'channel.accounts.read',
      generationVisibilityFromContext(this.ctx)?.view(this.ctx),
    )
    if (!owner) return undefined
    const original = originalService(this)
    const facade = Object.create(original) as CordisXChannelManagerService
    // The caller property must be configurable for Cordis's tracing proxy to
    // rebind it. A non-configurable property breaks native service invocation.
    Object.defineProperty(facade, 'ctx', { value: this.ctx, configurable: true })
    const lifetime = new AbortController()
    this.ctx.effect(() => () => lifetime.abort(), 'channelManager owned service lifetime')
    registerChannelServiceFacade(facade, owner, lifetime.signal)
    // Cordis tracing carries the actual caller into every inherited method. A
    // borrowed facade never becomes a bearer grant for a different plugin.
    return facade
  }

  forOwnReplyService(): ChannelManagerV6 | undefined {
    return this.forOwnService() as ChannelManagerV6 | undefined
  }

  forOwnPageService(): ChannelManagerV7 | undefined {
    return this.forOwnService() as ChannelManagerV7 | undefined
  }

  async mountConversationReplyPolicyForm(
    target: HTMLElement,
    options: ChannelManagerFormOptionsV1,
  ): Promise<ChannelManagerFormMountResultV1> {
    const owner = ownerFromContext(this.ctx)
    if (
      !managedConsoleSeatFor(target, owner) || options.signal.aborted
      || !await this.authorizeChannel('channel.bindings.read')
    ) return { status: 'unavailable', code: 'HOST_FORM_UNAVAILABLE' }
    const state = stateFor(this)
    if (!state.policy) return { status: 'unavailable', code: 'CHANNEL_POLICY_UNAVAILABLE' }
    const lifetime = new AbortController()
    const dispose = this.ctx.effect(() => () => lifetime.abort(), 'channelManager inline policy form')
    try {
      const result = await state.policy.mount(
        owner,
        target,
        { ...options, signal: AbortSignal.any([options.signal, lifetime.signal]) },
        () => this.operationLive() && this.ownedReadAllowed(),
        () => this.authorizeChannel('channel.bindings.write'),
      )
      if (result.status === 'mounted') void result.closed.then(() => dispose())
      else dispose()
      return result
    } catch {
      dispose()
      return { status: 'unavailable', code: 'CHANNEL_POLICY_UNAVAILABLE' }
    }
  }

  forOwnWorkflowService(): ChannelManagerV9 | undefined {
    return this.forOwnService() as ChannelManagerV9 | undefined
  }

  forOwnConversationService(): ChannelManagerV10 | undefined {
    return this.forOwnService() as ChannelManagerV10 | undefined
  }
  forOwnSettingsService(): ChannelManagerV14 | undefined {
    return this.forOwnService() as ChannelManagerV14 | undefined
  }

  mountContinuationDefaultsForm(target: HTMLElement, options: ChannelManagerFormOptionsV1) {
    return mountContinuationDefaults({
      ctx: this.ctx,
      owner: ownerFromContext(this.ctx),
      target,
      options,
      workflow: stateFor(this).continuation,
      live: () => this.operationLive() && this.ownedReadAllowed(),
      authorizeRead: () => this.authorizeChannel('channel.bindings.read'),
      authorizeWrite: () => this.authorizeChannel('channel.bindings.write'),
    })
  }

  async mountSettingsForm(
    section: ChannelSettingsFormSectionV2,
    target: HTMLElement,
    options: ChannelManagerFormOptionsV1,
  ) {
    return this.mountSettingsSection(section, target, options)
  }
  mountChannelCreationDefaultsForm(target: HTMLElement, options: ChannelManagerFormOptionsV1) {
    return this.mountSettingsSection('channel-new-chats', target, options)
  }
  private mountSettingsSection(
    section: ChannelSettingsFormSectionV2 | 'channel-new-chats',
    target: HTMLElement,
    options: ChannelManagerFormOptionsV1,
  ) {
    return mountChannelManagerSettings({
      ctx: this.ctx,
      owner: ownerFromContext(this.ctx),
      caller: this.operationOwner(),
      state: stateFor(this),
      section,
      target,
      options,
      live: () => this.operationLive() && this.ownedReadAllowed(),
      authorizeRead: () => this.authorizeChannel('channel.bindings.read'),
      authorizeWrite: () => this.authorizeChannel('channel.bindings.write'),
    })
  }

  registerChatCreationSettingsDestination(reference: { readonly id: string }): { dispose(): void } | undefined {
    const state = stateFor(this),
      owner = ownerFromContext(this.ctx),
      source = sourceFromContext(this.ctx),
      facade = serviceOwnerFor(this)
    if (
      !reference || typeof reference.id !== 'string' || Object.keys(reference).some(key => key !== 'id')
      || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(reference.id) || !facade || !source || !this.operationLive()
      || !this.ownedReadAllowed()
    ) return undefined
    const document = state.policy?.document
    if (!document) return undefined
    const routeService = this.ctx.routes as {
      registry?: { managerContentRoute(owner: string, reference: { id: string }): { state: string } }
    } | undefined
    const remove = registerChannelSettingsDestination(document, {
      owner,
      source,
      routeId: reference.id,
      live: () =>
        this.operationLive() && this.ownedReadAllowed()
        && routeService?.registry?.managerContentRoute(owner, reference).state === 'available',
    })
    const dispose = this.ctx.effect(() => remove, 'channelManager own settings destination')
    return { dispose }
  }
  conversationPage(request: Parameters<ChannelManagerV10['conversationPage']>[0], signal: AbortSignal) {
    return this.conversationWorkflow().page(request, signal)
  }
  conversationDetail(token: string, signal: AbortSignal) {
    return this.conversationWorkflow().detail(token, signal)
  }
  conversationActivity(request: Parameters<ChannelManagerV10['conversationActivity']>[0], signal: AbortSignal) {
    return this.conversationWorkflow().activity(request, signal)
  }
  conversationBindings(request: Parameters<ChannelManagerV10['conversationBindings']>[0], signal: AbortSignal) {
    return this.conversationWorkflow().bindings(request, signal)
  }
  openBindingConversation(token: string, signal: AbortSignal) {
    return this.conversationWorkflow().openBinding(token, signal)
  }
  private conversationWorkflow() {
    const workflow = stateFor(this).conversations
    if (!workflow || !this.operationLive()) throw new Error('CHANNEL_CONVERSATIONS_UNAVAILABLE')
    return workflow.forCaller({
      caller: this.operationOwner(),
      live: () => this.operationLive() && this.ownedReadAllowed(),
      authorize: (capability, requested) => this.authorizeChannel(capability, requested),
    })
  }

  async conversationWorkflowPolicy(signal: AbortSignal) {
    if (!await this.authorizeChannel('channel.bindings.read')) throw new Error('PERMISSION_DENIED')
    const policy = stateFor(this).policy
    if (!policy) throw new Error('CHANNEL_POLICY_UNAVAILABLE')
    return policy.readWorkflow(signal)
  }

  async mountConversationWorkflowPolicyForm(target: HTMLElement, options: ChannelManagerFormOptionsV1) {
    const owner = ownerFromContext(this.ctx), state = stateFor(this)
    if (
      !managedConsoleSeatFor(target, owner) || !state.policy || !await this.authorizeChannel('channel.bindings.read')
    ) return { status: 'unavailable' as const, code: 'HOST_FORM_UNAVAILABLE' }
    return state.policy.mount(
      owner,
      target,
      options,
      () => this.operationLive() && this.ownedReadAllowed(),
      () => this.authorizeChannel('channel.bindings.write'),
      true,
    )
  }

  async chatCreationDefaults(signal: AbortSignal) {
    if (!await this.authorizeChannel('channel.bindings.read')) throw new Error('PERMISSION_DENIED')
    const execution = stateFor(this).execution
    if (!execution) throw new Error('EXECUTION_SETTINGS_UNAVAILABLE')
    return execution.read(undefined, signal)
  }

  async bindingExecution(bindingToken: string, signal: AbortSignal) {
    if (!await this.authorizeChannel('channel.bindings.read')) throw new Error('PERMISSION_DENIED')
    const state = stateFor(this), binding = state.publicController!.bindingTarget(bindingToken)
    if (!binding || !state.execution) throw new Error('TARGET_UNAVAILABLE')
    return state.execution.read(binding.session.remoteSessionId, signal)
  }

  mountChatCreationDefaultsForm(target: HTMLElement, options: ChannelManagerFormOptionsV1) {
    return this.mountExecutionForm(undefined, target, options)
  }

  mountBindingExecutionForm(bindingToken: string, target: HTMLElement, options: ChannelManagerFormOptionsV1) {
    return this.mountExecutionForm(bindingToken, target, options)
  }
  async mountBindingModelForm(
    bindingToken: string,
    target: HTMLElement,
    options: ChannelManagerFormOptionsV1,
  ): Promise<ChannelManagerFormMountResultV1> {
    const owner = ownerFromContext(this.ctx),
      state = stateFor(this),
      binding = state.publicController!.bindingTarget(bindingToken)
    if (
      !binding || !state.tasks || !managedConsoleSeatFor(target, owner) || options.signal.aborted
      || !await this.authorizeChannel('channel.bindings.read')
    ) return { status: 'unavailable', code: 'TARGET_UNAVAILABLE' }
    return state.tasks.mount({
      target,
      owner,
      options,
      sessionId: binding.session.remoteSessionId,
      live: () =>
        this.operationLive() && this.ownedReadAllowed()
        && state.publicController!.bindingTarget(bindingToken)?.bindingId === binding.bindingId,
      authorize: () => this.authorizeChannel('channel.bindings.write'),
    })
  }

  private async mountExecutionForm(
    bindingToken: string | undefined,
    target: HTMLElement,
    options: ChannelManagerFormOptionsV1,
  ): Promise<ChannelManagerFormMountResultV1> {
    const owner = ownerFromContext(this.ctx), state = stateFor(this)
    if (
      !managedConsoleSeatFor(target, owner) || !state.execution || options.signal.aborted
      || !await this.authorizeChannel('channel.bindings.read')
    ) return { status: 'unavailable', code: 'HOST_FORM_UNAVAILABLE' }
    const binding = bindingToken === undefined ? undefined : state.publicController!.bindingTarget(bindingToken)
    if (bindingToken !== undefined && !binding) return { status: 'unavailable', code: 'TARGET_UNAVAILABLE' }
    const live = () =>
      this.operationLive() && this.ownedReadAllowed()
      && (bindingToken === undefined
        || state.publicController!.bindingTarget(bindingToken)?.bindingId === binding?.bindingId)
    return state.execution.mount({
      target,
      owner,
      options,
      live,
      authorize: () => this.authorizeChannel('channel.bindings.write'),
      ...(binding === undefined ? {} : { sessionId: binding.session.remoteSessionId }),
    })
  }

  async bindingDisplayPage(
    request: { connectionToken: string; afterCursor?: string; limit?: number },
    signal: AbortSignal,
  ): Promise<ChannelManagerBindingPageV2> {
    signal.throwIfAborted()
    if (!await this.authorizeChannel('channel.bindings.read')) throw new Error('PERMISSION_DENIED')
    await this.refreshIdentity(signal)
    const state = stateFor(this), page = state.publicController!.bindingPage(request)
    const revision = state.publicController!.currentRevision()
    const result = await state.actions?.run('binding-labels', {})
    signal.throwIfAborted()
    this.assertOwnedRead()
    if (!this.operationLive() || revision !== state.publicController!.currentRevision()) {
      throw new Error('STALE_CHANNEL_REVISION')
    }
    if (result?.status !== 'applied') throw new Error('BINDING_NAMES_UNAVAILABLE')
    return {
      ...page,
      contract: 'cordisx.channel-manager-binding-page/v2',
      schemaVersion: 2,
      bindings: page.bindings.map(binding => {
        const target = state.publicController!.bindingTarget(binding.bindingToken)
        const names = result.bindingLabels?.find(label => label.bindingId === target?.bindingId)
        const safe = (value: string | undefined, fallback: string) =>
          value?.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 120) || fallback
        return {
          ...binding,
          sessionName: safe(names?.sessionName, 'Codex 对话'),
          conversationName: safe(names?.conversationName, '频道会话'),
        }
      }),
    }
  }

  forOwnConfigurationService(): ChannelManagerV8 | undefined {
    return this.forOwnService() as ChannelManagerV8 | undefined
  }

  mountCredentialForm(connectionToken: string, target: HTMLElement, options: ChannelManagerFormOptionsV1) {
    return this.mountConnectionForm(connectionToken, target, options, false)
  }

  mountConnectionConfigurationForm(connectionToken: string, target: HTMLElement, options: ChannelManagerFormOptionsV1) {
    return this.mountConnectionForm(connectionToken, target, options, true)
  }

  private async mountConnectionForm(
    connectionToken: string,
    target: HTMLElement,
    options: ChannelManagerFormOptionsV1,
    combined: boolean,
  ): Promise<ChannelManagerFormMountResultV1> {
    const pageOwner = ownerFromContext(this.ctx)
    if (
      !managedConsoleSeatFor(target, pageOwner) || options.signal.aborted
      || !await this.authorizeChannel('channel.accounts.read')
    ) return { status: 'unavailable', code: 'HOST_FORM_UNAVAILABLE' }
    const state = stateFor(this), controller = state.publicController!, account = controller.target(connectionToken)
    if (!account || (!combined && (!state.credentials || !['feishu', 'lark'].includes(account.adapterId)))) {
      return { status: 'unavailable', code: 'TARGET_UNAVAILABLE' }
    }
    const lifetime = new AbortController(), operationOwner = `${this.operationOwner()}:inline:${crypto.randomUUID()}`
    const dispose = this.ctx.effect(() => () => {
      lifetime.abort()
      state.credentials?.retireOwner(operationOwner)
    }, 'channelManager owned connection form')
    const live = () =>
      !lifetime.signal.aborted && !options.signal.aborted && this.operationLive() && this.ownedReadAllowed()
    const common = {
      target,
      pageOwner,
      operationOwner,
      connectionToken,
      account,
      options,
      lifetime: AbortSignal.any([state.lifetime.signal, lifetime.signal]),
      live,
      controller,
      authorize: (account: ChannelCredentialRef) =>
        this.authorizeChannel('channel.accounts.connect', {
          channelAccount: { adapterId: account.adapterId, accountId: account.accountId },
        }),
    }
    try {
      const result = combined
        ? await mountChannelConnectionForm({
          ...common,
          ...(state.credentials && ['feishu', 'lark'].includes(account.adapterId)
            ? { credentials: state.credentials }
            : {}),
          read: async () => {
            if (!live() || !await this.authorizeChannel('channel.accounts.read')) throw new Error('PERMISSION_DENIED')
            const descriptor = await this.serviceConfiguration()
            if (!descriptor) throw new Error('TARGET_UNAVAILABLE')
            return channelConnectionFormSnapshot(descriptor, controller, connectionToken, live)
          },
          subscribe: listener => this.subscribeInternal(listener),
          update: (ref, patch, revision) => this.updateConfiguration(ref, patch, revision),
        })
        : mountLegacyChannelCredentialForm({ ...common, credentials: state.credentials! })
      if (result.status === 'mounted') void result.closed.then(() => dispose())
      else dispose()
      return result
    } catch {
      dispose()
      return { status: 'unavailable', code: 'HOST_FORM_UNAVAILABLE' }
    }
  }

  snapshotWithIdentity(): ChannelManagerSnapshotV4 {
    this.assertOwnedRead()
    return stateFor(this).publicController!.snapshotWithIdentity()
  }

  async bindingPage(request: Parameters<ChannelManagerV4['bindingPage']>[0], signal: AbortSignal) {
    signal.throwIfAborted()
    if (!await this.authorizeChannel('channel.bindings.read')) throw new Error('PERMISSION_DENIED')
    await this.refreshIdentity(signal)
    signal.throwIfAborted()
    return stateFor(this).publicController!.bindingPage(request)
  }

  async connectionConfiguration(
    connectionToken: string,
    signal: AbortSignal,
  ): Promise<ChannelManagerConnectionConfigurationV1> {
    signal.throwIfAborted()
    if (!await this.authorizeChannel('channel.accounts.read')) throw new Error('PERMISSION_DENIED')
    const state = stateFor(this), target = state.publicController!.target(connectionToken)
    const descriptor = await this.serviceConfiguration()
    signal.throwIfAborted()
    if (!target || !descriptor || !this.operationLive()) throw new Error('TARGET_UNAVAILABLE')
    const connection = (descriptor.configuration as {
      connections: Array<
        {
          ref: ChannelCredentialRef
          displayName?: string
          selectors?: Array<'direct' | 'group' | 'mentions' | 'replies'>
        }
      >
    }).connections.find(item => compositeRef(item.ref) === compositeRef(target))
    if (!connection) throw new Error('TARGET_UNAVAILABLE')
    return {
      contract: 'cordisx.channel-manager-connection-configuration/v1',
      schemaVersion: 1,
      profileId: descriptor.scope.profileId,
      hostGeneration: this.snapshot().hostGeneration,
      revision: state.publicController!.currentRevision(),
      connectionToken,
      ...(connection.displayName === undefined ? {} : { displayName: connection.displayName }),
      selectors: connection.selectors ?? ['direct', 'group'],
    }
  }

  async refreshIdentity(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.assertOwnedRead()
    const state = stateFor(this)
    const result = await readChannelSnapshot(state, signal, () => this.notifyListeners())
    if (result === undefined) return
    this.assertOwnedRead()
    const before = JSON.stringify({ accounts: projectionFor(this).accounts, bindings: projectionFor(this).bindings })
    // Normalize the entire readback before it can replace any last-good account data.
    withRuntimeProjection(state.projection, result)
    state.runtimeProjection = result
    const after = JSON.stringify({ accounts: projectionFor(this).accounts, bindings: projectionFor(this).bindings })
    if (before === after) return
    state.cachedProjection = undefined
    state.publicController!.invalidate()
    this.notifyListeners()
  }

  async conversationPolicy(signal: AbortSignal) {
    signal.throwIfAborted()
    if (!await this.authorizeChannel('channel.bindings.read')) throw new Error('PERMISSION_DENIED')
    const policy = stateFor(this).policy
    if (!policy) throw new Error('CHANNEL_POLICY_UNAVAILABLE')
    const result = await policy.read(signal)
    this.assertOwnedRead()
    return result
  }

  async conversationReplyPolicy(signal: AbortSignal) {
    signal.throwIfAborted()
    if (!await this.authorizeChannel('channel.bindings.read')) throw new Error('PERMISSION_DENIED')
    const policy = stateFor(this).policy
    if (!policy) throw new Error('CHANNEL_POLICY_UNAVAILABLE')
    const result = await policy.readReply(signal)
    this.assertOwnedRead()
    return result
  }

  async configureConversationPolicy(signal: AbortSignal) {
    return this.configurePolicy(signal, false)
  }

  async configureConversationReplyPolicy(signal: AbortSignal) {
    return this.configurePolicy(signal, true)
  }

  private async configurePolicy(signal: AbortSignal, replyFields: boolean) {
    if (signal.aborted) return { status: 'cancelled' as const, code: 'CANCELLED' }
    if (!await this.authorizeChannel('channel.bindings.read')) {
      return { status: 'rejected' as const, code: 'PERMISSION_DENIED' }
    }
    const policy = stateFor(this).policy
    if (!policy) return { status: 'unavailable' as const, code: 'CHANNEL_POLICY_UNAVAILABLE' }
    const owner = new AbortController()
    const dispose = this.ctx.effect(() => () => owner.abort(), 'channelManager.configureConversationPolicy()')
    try {
      return await policy.configure(
        this.operationOwner(),
        AbortSignal.any([signal, owner.signal]),
        () => this.ownedReadAllowed(),
        replyFields,
      )
    } finally {
      dispose()
    }
  }

  async issue(request: ChannelManagerTargetRequestV1): Promise<ChannelManagerTargetResultV1> {
    const allowed = request.operation === 'target.connection.create'
      ? this.operationLive() && this.ownedReadAllowed()
      : await this.authorizeChannel('channel.accounts.read')
    if (!allowed) {
      return {
        ...request,
        contract: 'cordisx.channel-manager-target-result/v1',
        schemaVersion: 1,
        revision: stateFor(this).publicController!.currentRevision(),
        status: 'rejected',
        code: 'PERMISSION_DENIED',
      }
    }
    const owner = this.operationOwner()
    this.ctx.effect(() => () => stateFor(this).credentials?.retireOwner(owner), 'channelManager credential owner')
    return stateFor(this).publicController!.issue(request, owner)
  }

  async execute(request: ChannelManagerRequestV2): Promise<ChannelManagerResultV2> {
    const credential = request.operation === 'credential.capture' || request.operation === 'connection.create'
      || request.operation === 'connection.rotate-credential'
    const capability = credential ? 'channel.accounts.read' : request.operation.startsWith('binding.')
      ? 'channel.bindings.write'
      : request.operation.startsWith('logs.')
      ? 'channel.accounts.read'
      : 'channel.accounts.connect'
    const target = credential ? undefined : stateFor(this).publicController!.permissionTarget(request)
    if (
      !await this.authorizeChannel(
        capability,
        target === undefined ? {} : {
          channelTenant: {
            adapterId: target.adapterId,
            accountId: target.accountId,
            tenantId: target.tenantId,
          },
        },
      )
    ) {
      return {
        ...request,
        contract: 'cordisx.channel-manager-result/v2',
        schemaVersion: 2,
        revision: stateFor(this).publicController!.currentRevision(),
        status: 'rejected',
        code: 'PERMISSION_DENIED',
      }
    }
    const owner = this.operationOwner()
    const lifetime = new AbortController()
    const dispose = this.ctx.effect(() => () => lifetime.abort(), 'channelManager.execute()')
    try {
      // Bind private credential authorization to this operation's Cordis caller,
      // rather than the Host context that originally constructed the shared workflow.
      return await stateFor(this).publicController!.execute(
        request,
        owner,
        () => this.operationLive() && this.ownedReadAllowed(),
        lifetime.signal,
        account =>
          this.authorizeChannel('channel.accounts.connect', {
            channelAccount: { adapterId: account.adapterId, accountId: account.accountId },
          }),
        {
          update: (ref, patch) => this.updateConfiguration(ref, patch),
          runAction: (action, input) => this.runAction(action, input),
        },
      )
    } finally {
      dispose()
    }
  }

  private operationOwner(): string {
    return JSON.stringify([sourceFromContext(this.ctx), ownerFromContext(this.ctx), generationFromContext(this.ctx)])
  }
  private operationLive(): boolean {
    const state = stateFor(this)
    if (state.disposed || !state.isCurrent() || serviceOwnerFor(this)?.lifetime.aborted) return false
    try {
      generationVisibilityFromContext(this.ctx)?.view(this.ctx)
      return true
    } catch {
      return false
    }
  }
  private async authorizeChannel(
    capability:
      | 'channel.accounts.read'
      | 'channel.accounts.connect'
      | 'channel.bindings.read'
      | 'channel.bindings.write'
      | 'channel.events.subscribe',
    requested: RequestedScope = {},
  ): Promise<boolean> {
    const state = stateFor(this)
    if (!this.operationLive()) return false
    const id = ownerFromContext(this.ctx), source = sourceFromContext(this.ctx)
    const facade = serviceOwnerFor(this)
    if (facade !== undefined) {
      return this.ownedServiceAllowed(capability, requested)
    }
    if (id === 'host') return true
    if (!source || !state.broker) return false
    const allowed = await state.broker.authorizeChannel(
      { id, source },
      capability,
      requested,
      generationVisibilityFromContext(this.ctx)?.view(this.ctx),
    )
    return allowed && this.operationLive()
  }

  private ownedServiceAllowed(
    capability:
      | 'channel.accounts.read'
      | 'channel.accounts.connect'
      | 'channel.bindings.read'
      | 'channel.bindings.write'
      | 'channel.events.subscribe',
    requested: RequestedScope = {},
  ): boolean {
    const facade = serviceOwnerFor(this), state = stateFor(this)
    const id = ownerFromContext(this.ctx), source = sourceFromContext(this.ctx)
    if (
      !facade || !source || !state.broker || !this.operationLive()
      || generationFromContext(this.ctx) !== facade.owner.moduleGeneration
    ) return false
    return state.broker.authorizeServiceOwner(
      { id, source },
      facade.owner,
      capability,
      requested,
      generationVisibilityFromContext(this.ctx)?.view(this.ctx),
    )
  }

  private ownedReadAllowed(): boolean {
    return serviceOwnerFor(this) === undefined || this.ownedServiceAllowed('channel.accounts.read')
  }

  protected assertOwnedRead(): void {
    if (!this.ownedReadAllowed()) throw new Error('PERMISSION_DENIED')
  }

  private async updateConfiguration(
    ref: ChannelCredentialRef,
    patch: { displayName?: string; selectors?: readonly string[] },
    expectedRevision?: number,
  ) {
    const result = await mutateChannelConnectionConfiguration({
      descriptor: await this.serviceConfiguration(),
      account: ref,
      patch,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      live: () => this.operationLive() && this.ownedReadAllowed(),
      mutate: mutation => this.mutateServiceConfiguration(mutation),
    })
    if (result.status !== 'applied') return result
    const key = compositeRef(ref)
    if (!this.operationLive() || !this.ownedReadAllowed()) return { status: 'applied' as const, code: 'APPLIED' }
    const state = stateFor(this)
    state.projection = normalizeProjection({
      ...state.projection,
      connections: state.projection.connections.map(item =>
        compositeRef(item.ref) === key
          ? { ...item, ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }) }
          : item
      ),
      accounts: state.projection.accounts.map(item =>
        compositeRef(item.ref) === key
          ? { ...item, ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }) }
          : item
      ),
      service: { ...state.projection.service, revision: result.revision!, lastGoodRevision: result.revision! },
    })
    state.publicController!.invalidate()
    this.notifyListeners()
    return { status: 'applied' as const, code: 'APPLIED' }
  }

  async queryLogs(
    request: Extract<ChannelManagerRequestV2, { operation: 'logs.query' }>,
  ): Promise<ChannelManagerLogPageV2> {
    if (!await this.authorizeChannel('channel.accounts.read')) throw new Error('PERMISSION_DENIED')
    return stateFor(this).publicController!.queryLogs(request)
  }

  async exportLogs(
    request: Extract<ChannelManagerRequestV2, { operation: 'logs.export' }>,
  ): Promise<ChannelManagerLogExportResultV2> {
    if (!await this.authorizeChannel('channel.accounts.read')) throw new Error('PERMISSION_DENIED')
    return stateFor(this).publicController!.exportLogs(request)
  }

  subscribe(listener: () => void): { dispose(): void } {
    this.assertOwnedRead()
    if (serviceOwnerFor(this) === undefined) return Object.freeze({ dispose: this.subscribeInternal(listener) })
    const remove = this.subscribeInternal(() => {
      if (this.ownedReadAllowed()) listener()
    })
    const dispose = this.ctx.effect(() => remove, 'channelManager owned service subscription')
    return Object.freeze({ dispose })
  }

  private subscribeInternal(listener: () => void): Disposable<void> {
    const listeners = stateFor(this).listeners
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  private rememberLocalCandidate(connection: ChannelManagerConnectionProjection): void {
    const state = stateFor(this)
    const normalized = normalizeProjection({ ...state.projection, connections: [connection] }).connections[0]!
    const id = compositeRef(normalized.ref)
    if ([...state.projection.connections, ...state.localConnections].some(item => compositeRef(item.ref) === id)) return
    state.localConnections.push(normalized)
    state.cachedProjection = undefined
    state.publicController!.invalidate()
    this.notifyListeners()
  }

  private async serviceConfiguration(): Promise<HostServiceConfigDescriptor | undefined> {
    const serviceConfig = stateFor(this).serviceConfig
    if (serviceConfig === undefined) return undefined
    return (await serviceConfig.list()).find(item => (
      item.identity.pluginId === 'channel' && item.identity.serviceId === 'runtime'
    ))
  }

  private mutateServiceConfiguration(mutation: HostServiceConfigMutation): Promise<HostServiceConfigMutationResult> {
    const serviceConfig = stateFor(this).serviceConfig
    if (serviceConfig === undefined) throw new Error('channel-service-configuration-unavailable')
    return serviceConfig.mutate(mutation)
  }

  private createConnection(input: {
    readonly account: ChannelManagerConnectionProjection['ref']
    readonly secret: string
    readonly mutation: HostServiceConfigMutation
  }): Promise<HostServiceConfigMutationResult> {
    const create = stateFor(this).createCredentialedConnection
    if (create === undefined) throw new Error('channel-credential-capture-unavailable')
    return create(input)
  }

  private async runAction(
    action: 'enable' | 'disable' | 'reconnect' | 'archive' | 'restore' | 'unbind',
    input: Record<string, unknown>,
  ): Promise<ChannelManagerActionResult> {
    const state = stateFor(this)
    if (state.actions === undefined) throw new Error('channel-action-unavailable')
    state.refreshSequence += 1
    let result: ChannelManagerActionResult
    try {
      result = await state.actions.run(action, input)
    } finally {
      // Reject reads that began during a failed or completed connection operation too.
      state.refreshSequence += 1
    }
    if (state.disposed || !state.isCurrent() || !this.ownedReadAllowed()) return result
    if (result.projection !== undefined) state.runtimeProjection = result.projection
    state.cachedProjection = undefined
    if (result.status === 'applied') state.publicController!.invalidate()
    this.notifyListeners()
    return result
  }

  private notifyListeners(): void {
    for (const listener of stateFor(this).listeners) listener()
  }
}
