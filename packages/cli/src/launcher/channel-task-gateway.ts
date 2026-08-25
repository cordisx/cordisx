import { createHash, randomBytes } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type {
  ChannelTaskContext,
  ChannelTaskDispatchResult,
  ChannelTaskGateway,
  ChannelTaskResult,
  PlatformSessionRef,
  ResolvedChannelTaskOperation,
} from '@cordisx/channel-runtime'
import { ProviderFleet } from '../providers/fleet.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'

export interface ChannelWorkspaceRegistration {
  readonly alias: string
  /** An absolute Host-owned root. Resolution is rejected outside it. */
  readonly root: string
  /** The one absolute directory authorized for this alias. */
  readonly cwd: string
}

export interface ChannelTaskPermissionBroker {
  authorize(input: {
    readonly operationId: string
    readonly source: ChannelTaskContext['input']['source']['event']
    readonly profileId: string
    readonly model: { readonly providerId: string; readonly modelId: string }
    readonly cwd: string
    readonly capability: 'tasks.create' | 'turns.submit'
  }): Promise<{ readonly decision: 'allow' | 'ask' | 'deny'; readonly scopeFingerprint: `sha256:${string}` }>
}

export interface ChannelWorkspaceResolver {
  resolve(profileId: string, alias: string): Promise<ChannelWorkspaceRegistration | undefined>
}

export class StaticChannelWorkspaceResolver implements ChannelWorkspaceResolver {
  constructor(private readonly values: Readonly<Record<string, readonly ChannelWorkspaceRegistration[]>>) {}

  async resolve(profileId: string, alias: string): Promise<ChannelWorkspaceRegistration | undefined> {
    return this.values[profileId]?.find(item => item.alias === alias)
  }
}

export class DenyChannelTaskPermissionBroker implements ChannelTaskPermissionBroker {
  async authorize(): Promise<{ readonly decision: 'deny'; readonly scopeFingerprint: `sha256:${string}` }> {
    return { decision: 'deny', scopeFingerprint: `sha256:${'0'.repeat(64)}` }
  }
}

/**
 * Node-safe projection of the existing durable Permission Broker policy
 * ledger. There is no remote-channel self-approval: absent durable policy it
 * deliberately resolves to deny.
 */
export class PermissionBrokerChannelTaskAuthorizer implements ChannelTaskPermissionBroker {
  private readonly policies: readonly CordisXPersistedPermissionPolicyRecord[]

  constructor(input: {
    readonly profileId: string
    readonly source: string
    readonly providers: readonly string[]
    readonly cwdRoots: readonly string[]
    readonly policies: readonly CordisXPersistedPermissionPolicyRecord[]
  }) {
    this.profileId = input.profileId
    this.source = input.source
    this.providers = new Set(input.providers)
    this.cwdRoots = [...input.cwdRoots]
    this.policies = structuredClone(input.policies)
  }

  private readonly profileId: string
  private readonly source: string
  private readonly providers: ReadonlySet<string>
  private readonly cwdRoots: readonly string[]

  async authorize(input: Parameters<ChannelTaskPermissionBroker['authorize']>[0]): Promise<{ readonly decision: 'allow' | 'ask' | 'deny'; readonly scopeFingerprint: `sha256:${string}` }> {
    const declared = this.providers.has(input.model.providerId) && this.cwdRoots.some(root => inside(root, input.cwd))
    const allowed = declared && this.policies.some(record => this.permits(record, input))
    // A remote message has no interactive approval channel and cannot approve
    // itself. `ask` therefore fails closed as `deny` at this launcher boundary.
    return { decision: allowed ? 'allow' : 'deny', scopeFingerprint: channelTaskScopeFingerprint(input) }
  }

  private permits(record: CordisXPersistedPermissionPolicyRecord, input: Parameters<ChannelTaskPermissionBroker['authorize']>[0]): boolean {
    const key = record.key
    if (key.profileId !== this.profileId || key.identity.source !== this.source || key.identity.pluginId !== 'channel' || key.capability !== input.capability) return false
    const policy = record.schemaVersion === 1 ? record.policy === 'allow' : record.policy === 'allow-persistent'
    if (!policy) return false
    const scope = key.scope as { readonly providers?: readonly string[]; readonly cwdRoots?: readonly string[] }
    return (scope.providers === undefined || scope.providers.includes(input.model.providerId))
      && (scope.cwdRoots === undefined || scope.cwdRoots.some(root => inside(root, input.cwd)))
  }
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
}

interface LaunchGrant {
  readonly token: string
  readonly operationId: string
  readonly routeId: string
  readonly serviceGeneration: string
  readonly configurationRevision: number
  readonly sourceKey: string
  readonly target: { readonly profileId: string; readonly model: { readonly providerId: string; readonly modelId: string }; readonly workspace: ChannelWorkspaceRegistration }
  readonly scopeFingerprint: `sha256:${string}`
  readonly expiresAt: number
  consumed: boolean
}

function sourceKey(input: ChannelTaskContext['input']['source']['event']): string {
  return JSON.stringify([input.adapterId, input.accountId, input.tenantId, input.conversationId, input.threadId, input.eventId])
}

function text(input: ChannelTaskContext['input']): string | undefined {
  const value = input.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
  return value === '' ? undefined : value
}

function failure(code: string, retryable: boolean) {
  return { code: code.replace(/[^A-Za-z0-9._-]/g, '_').toUpperCase().slice(0, 128) || 'CHANNEL_GATEWAY_REJECTED', retryable }
}

function rejected(operationId: string, operation: 'create' | 'followup', code: string, retryable = false): ChannelTaskDispatchResult {
  return {
    contract: 'cordisx.platform-task-dispatch-result/v1', schemaVersion: 1, operationId, operation,
    status: 'rejected', failure: failure(code, retryable), observedAt: new Date().toISOString(),
  }
}

/**
 * Node-only Channel task gateway. It deliberately owns cwd resolution and the
 * single-use grant registry; the Channel runtime receives only dispatch
 * results, never grants, paths, raw provider frames, or permission metadata.
 */
export class LauncherChannelTaskGateway implements ChannelTaskGateway {
  private readonly grants = new Map<string, LaunchGrant>()
  private readonly results = new Map<string, ChannelTaskResult>()

  constructor(private readonly options: {
    readonly fleet: ProviderFleet
    readonly profileId: string
    readonly workspaces: ChannelWorkspaceResolver
    readonly permissions: ChannelTaskPermissionBroker
    readonly now?: () => number
    readonly grantTtlMs?: number
  }) {}

  async execute(operation: ResolvedChannelTaskOperation, context: ChannelTaskContext): Promise<ChannelTaskResult> {
    const existing = this.results.get(context.operationId)
    if (existing !== undefined) return structuredClone(existing)
    const result = operation.kind === 'create'
      ? await this.create(operation, context)
      : operation.kind === 'followup'
        ? await this.followup(operation.session, context)
        : { dispatch: rejected(context.operationId, 'followup', 'CHANNEL_OPERATION_UNSUPPORTED') }
    this.results.set(context.operationId, structuredClone(result))
    return result
  }

  private async create(operation: Extract<ResolvedChannelTaskOperation, { readonly kind: 'create' }>, context: ChannelTaskContext): Promise<ChannelTaskResult> {
    const model = await this.resolveModel(operation, context)
    if (model === undefined) return { dispatch: rejected(context.operationId, 'create', 'CHANNEL_SELECTOR_REJECTED') }
    const workspace = await this.resolveWorkspace(operation.workspace.alias)
    if (workspace === undefined) return { dispatch: rejected(context.operationId, 'create', 'CHANNEL_WORKSPACE_REJECTED') }
    const first = await this.options.permissions.authorize({
      operationId: context.operationId, source: context.input.source.event, profileId: this.options.profileId,
      model, cwd: workspace.cwd, capability: 'tasks.create',
    })
    const second = await this.options.permissions.authorize({
      operationId: context.operationId, source: context.input.source.event, profileId: this.options.profileId,
      model, cwd: workspace.cwd, capability: 'turns.submit',
    })
    if (first.decision !== 'allow' || second.decision !== 'allow' || first.scopeFingerprint !== second.scopeFingerprint) {
      return { dispatch: rejected(context.operationId, 'create', 'CHANNEL_PERMISSION_DENIED') }
    }
    const grant = this.issue(context, model, workspace, first.scopeFingerprint)
    const consumed = this.consume(grant.token, context)
    if (consumed === undefined) return { dispatch: rejected(context.operationId, 'create', 'CHANNEL_GRANT_REJECTED') }
    const dispatched = await this.options.fleet.dispatchCreate({
      operationId: context.operationId, model: consumed.target.model, cwd: consumed.target.workspace.cwd, message: text(context.input) ?? '',
    })
    return {
      ...(dispatched.session === undefined ? {} : { session: dispatched.session }),
      dispatch: dispatched,
    }
  }

  private async followup(session: PlatformSessionRef, context: ChannelTaskContext): Promise<ChannelTaskResult> {
    const dispatched = await this.options.fleet.dispatchFollowup({
      operationId: context.operationId, session, message: text(context.input) ?? '',
    })
    return { ...(dispatched.session === undefined ? {} : { session: dispatched.session }), dispatch: dispatched }
  }

  private async resolveModel(
    operation: Extract<ResolvedChannelTaskOperation, { readonly kind: 'create' }>,
    context: ChannelTaskContext,
  ): Promise<{ readonly providerId: string; readonly modelId: string } | undefined> {
    const provider = operation.provider
    const selectedModel = operation.model
    if (provider === undefined || selectedModel === undefined || 'useDefault' in provider || 'useDefault' in selectedModel) return undefined
    if (operation.profile !== undefined && ('useDefault' in operation.profile || operation.profile.id !== this.options.profileId)) return undefined
    const providerId = provider.id
    const modelId = selectedModel.id
    const models = await this.options.fleet.listModels({ providerIds: [providerId] })
    return models.ok && models.value.models.some(item => item.ref.providerId === providerId && item.ref.modelId === modelId)
      ? { providerId, modelId }
      : undefined
  }

  private async resolveWorkspace(alias: string): Promise<ChannelWorkspaceRegistration | undefined> {
    const registered = await this.options.workspaces.resolve(this.options.profileId, alias)
    if (registered === undefined || !path.isAbsolute(registered.root) || !path.isAbsolute(registered.cwd)) return undefined
    try {
      const [root, cwd, info] = await Promise.all([realpath(registered.root), realpath(registered.cwd), stat(registered.cwd)])
      const relative = path.relative(root, cwd)
      if (!info.isDirectory() || (relative !== '' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)))) return undefined
      return { alias: registered.alias, root, cwd }
    } catch {
      return undefined
    }
  }

  private issue(
    context: ChannelTaskContext,
    model: { readonly providerId: string; readonly modelId: string },
    workspace: ChannelWorkspaceRegistration,
    scopeFingerprint: `sha256:${string}`,
  ): LaunchGrant {
    const token = `chtl1_${randomBytes(32).toString('base64url')}`
    const grant: LaunchGrant = {
      token, operationId: context.operationId, routeId: context.routeId, serviceGeneration: context.serviceGeneration,
      configurationRevision: context.configurationRevision, sourceKey: sourceKey(context.input.source.event),
      target: { profileId: this.options.profileId, model, workspace }, scopeFingerprint,
      expiresAt: (this.options.now ?? Date.now)() + (this.options.grantTtlMs ?? 60_000), consumed: false,
    }
    this.grants.set(token, grant)
    return grant
  }

  private consume(token: string, context: ChannelTaskContext): LaunchGrant | undefined {
    const grant = this.grants.get(token)
    this.grants.delete(token)
    if (grant === undefined || grant.consumed || grant.expiresAt <= (this.options.now ?? Date.now)()
      || grant.operationId !== context.operationId || grant.routeId !== context.routeId
      || grant.serviceGeneration !== context.serviceGeneration || grant.configurationRevision !== context.configurationRevision
      || grant.sourceKey !== sourceKey(context.input.source.event) || grant.target.profileId !== this.options.profileId) return undefined
    grant.consumed = true
    return grant
  }
}

/** Small deterministic Host helper for policy integrations and tests. */
export function channelTaskScopeFingerprint(input: Omit<Parameters<ChannelTaskPermissionBroker['authorize']>[0], 'capability'>): `sha256:${string}` {
  const { operationId, source, profileId, model, cwd } = input
  return `sha256:${createHash('sha256').update(JSON.stringify({ operationId, source, profileId, model, cwd })).digest('hex')}`
}
