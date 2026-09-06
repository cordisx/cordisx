import { Context, Service } from '@deepseek-ai/cordis'
import type {
  CordisXModelDescriptor,
  CordisXModelPage,
  CordisXModelsListInput,
  CordisXPlatform,
  CordisXPlatformAdapterStatus,
  CordisXPlatformCapability,
  CordisXPlatformDiagnostic,
  CordisXPlatformModelRef,
  CordisXPlatformResult,
  CordisXPlatformSessionRef,
  CordisXPluginIdentity,
  CordisXSessionCreateOutcome,
  CordisXSessionPage,
  CordisXSessionProjection,
  CordisXSessionSummary,
  CordisXTaskControlInput,
  CordisXTaskControlOutcome,
  CordisXTaskCreateInput,
  CordisXTaskReadInput,
  CordisXTasksListInput,
  CordisXTurnControlInput,
  CordisXTurnControlOutcome,
  CordisXTurnStart,
  CordisXTurnSubmitInput,
} from '../../contracts.js'
import { generationVisibilityFromContext } from '../generation-visibility.js'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from '../service.js'
import type { PluginConsoleAspect, PluginConsoleInvocation, PluginPrincipalToken } from '../plugin-console.js'
import type { PermissionBroker } from './platform-permission-broker.js'

import { copy, failure, object, safeAdapterFailure } from './platform-manifest.js'
import { RequestedScope } from './platform-permission-store.js'
import { AuthorizationGrant, normalizedPath, scopeAllows } from './platform-permission-types.js'

export interface CordisXPlatformAdapter {
  status(): CordisXPlatformAdapterStatus
  listModels(input: CordisXModelsListInput): Promise<CordisXPlatformResult<CordisXModelPage>>
  listTasks(input: CordisXTasksListInput): Promise<CordisXPlatformResult<CordisXSessionPage>>
  readTask(input: CordisXTaskReadInput): Promise<CordisXPlatformResult<CordisXSessionProjection>>
  createTask(
    input: Omit<CordisXTaskCreateInput, 'initialMessage'>,
  ): Promise<CordisXPlatformResult<CordisXSessionSummary>>
  controlTask(input: CordisXTaskControlInput): Promise<CordisXPlatformResult<CordisXTaskControlOutcome>>
  submitTurn(input: CordisXTurnSubmitInput): Promise<CordisXPlatformResult<CordisXTurnStart>>
  controlTurn(input: CordisXTurnControlInput): Promise<CordisXPlatformResult<CordisXTurnControlOutcome>>
}

const CURRENT_CONNECTION_UNAVAILABLE: CordisXPlatformDiagnostic = Object.freeze({
  code: 'current-connection-client-unavailable',
  message: 'The Desktop current-connection request client is not safely available to CordisX',
})

export class UnavailablePlatformAdapter implements CordisXPlatformAdapter {
  status(): CordisXPlatformAdapterStatus {
    return {
      hostId: 'codex-desktop',
      hostName: 'Codex Desktop',
      mode: 'unavailable',
      supportedCapabilities: [],
      diagnostics: [CURRENT_CONNECTION_UNAVAILABLE],
      secondConnectionCreated: false,
      rawBridgeExposed: false,
    }
  }

  async listModels(): Promise<CordisXPlatformResult<never>> {
    return { ok: false, error: CURRENT_CONNECTION_UNAVAILABLE }
  }
  async listTasks(): Promise<CordisXPlatformResult<never>> {
    return { ok: false, error: CURRENT_CONNECTION_UNAVAILABLE }
  }
  async readTask(): Promise<CordisXPlatformResult<never>> {
    return { ok: false, error: CURRENT_CONNECTION_UNAVAILABLE }
  }
  async createTask(): Promise<CordisXPlatformResult<never>> {
    return { ok: false, error: CURRENT_CONNECTION_UNAVAILABLE }
  }
  async controlTask(): Promise<CordisXPlatformResult<never>> {
    return { ok: false, error: CURRENT_CONNECTION_UNAVAILABLE }
  }
  async submitTurn(): Promise<CordisXPlatformResult<never>> {
    return { ok: false, error: CURRENT_CONNECTION_UNAVAILABLE }
  }
  async controlTurn(): Promise<CordisXPlatformResult<never>> {
    return { ok: false, error: CURRENT_CONNECTION_UNAVAILABLE }
  }
}

export interface CordisXPlatformProjection {
  readonly hostId: string
  readonly hostName: string
  readonly snapshotId?: string
  readonly models?: readonly CordisXModelDescriptor[]
  readonly sessions?: readonly CordisXSessionSummary[]
  readonly sessionContents?: readonly CordisXSessionProjection[]
}

export interface CordisXPlatformProjectionSource {
  getSnapshot(): CordisXPlatformProjection
}

export class ProjectionPlatformAdapter implements CordisXPlatformAdapter {
  constructor(private readonly source: CordisXPlatformProjectionSource) {}

  status(): CordisXPlatformAdapterStatus {
    const snapshot = this.source.getSnapshot()
    const supported: CordisXPlatformCapability[] = []
    if (snapshot.models !== undefined) supported.push('models.read')
    if (snapshot.sessions !== undefined) supported.push('tasks.catalog.read')
    if (snapshot.sessionContents !== undefined) supported.push('tasks.content.read')
    return {
      hostId: snapshot.hostId,
      hostName: snapshot.hostName,
      mode: 'read-only',
      supportedCapabilities: supported,
      diagnostics: [],
      secondConnectionCreated: false,
      rawBridgeExposed: false,
    }
  }

  async listModels(input: CordisXModelsListInput): Promise<CordisXPlatformResult<CordisXModelPage>> {
    const models = this.source.getSnapshot().models
    if (models === undefined) return failure('adapter-unavailable', 'The current model projection is unavailable')
    const providerIds = input.providerIds ?? []
    return {
      ok: true,
      value: {
        contract: 'cordisx.platform-model-page/v1',
        schemaVersion: 1,
        providerIds: copy(providerIds),
        models: copy(models.filter(item => providerIds.length === 0 || providerIds.includes(item.ref.providerId))),
      },
    }
  }

  async listTasks(input: CordisXTasksListInput): Promise<CordisXPlatformResult<CordisXSessionPage>> {
    const snapshot = this.source.getSnapshot()
    const sessions = snapshot.sessions
    if (sessions === undefined) {
      return failure('adapter-unavailable', 'The complete session catalog projection is unavailable')
    }
    if (input.cursor !== undefined) {
      return failure('invalid-request', 'The projection adapter does not support continuation cursors')
    }
    const providerIds = input.providerIds ?? []
    const limit = input.limit ?? 100
    const filtered = sessions.filter(item => {
      return (providerIds.length === 0 || providerIds.includes(item.ref.providerId))
        && (input.cwd === undefined || normalizedPath(item.cwd) === normalizedPath(input.cwd))
        && (input.searchTerm === undefined
          || `${item.title ?? ''}\n${item.cwd}`.toLocaleLowerCase().includes(input.searchTerm.toLocaleLowerCase()))
    }).slice(0, limit)
    return {
      ok: true,
      value: {
        contract: 'cordisx.platform-session-page/v1',
        schemaVersion: 1,
        query: {
          ...(input.providerIds === undefined ? {} : { providerIds: copy(input.providerIds) }),
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.searchTerm === undefined ? {} : { searchTerm: input.searchTerm }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        },
        snapshotId: snapshot.snapshotId ?? `projection:${snapshot.hostId}`,
        sessions: copy(filtered),
      },
    }
  }

  async readTask(input: CordisXTaskReadInput): Promise<CordisXPlatformResult<CordisXSessionProjection>> {
    const contents = this.source.getSnapshot().sessionContents
    if (contents === undefined) {
      return failure('adapter-unavailable', 'The complete session content projection is unavailable')
    }
    const session = contents.find(item => {
      return item.ref.providerId === input.session.providerId
        && item.ref.remoteSessionId === input.session.remoteSessionId
    })
    return session === undefined
      ? failure(
        'task-not-found',
        `Session ${input.session.remoteSessionId} was not found for provider ${input.session.providerId}`,
      )
      : { ok: true, value: copy(session) }
  }

  async createTask(): Promise<CordisXPlatformResult<never>> {
    return failure('adapter-read-only', 'The current Platform adapter is read-only')
  }
  async controlTask(): Promise<CordisXPlatformResult<never>> {
    return failure('adapter-read-only', 'The current Platform adapter is read-only')
  }
  async submitTurn(): Promise<CordisXPlatformResult<never>> {
    return failure('adapter-read-only', 'The current Platform adapter is read-only')
  }
  async controlTurn(): Promise<CordisXPlatformResult<never>> {
    return failure('adapter-read-only', 'The current Platform adapter is read-only')
  }
}

export interface CordisXPlatformServiceOptions {
  readonly adapter: CordisXPlatformAdapter
  readonly broker: PermissionBroker
  readonly console?: PluginConsoleAspect
}

const platformServiceOptions = new WeakMap<object, CordisXPlatformServiceOptions>()

const CORDIS_ORIGINAL = Symbol.for('cordis.original')

function optionsFor(service: object): CordisXPlatformServiceOptions {
  const original = (service as { [CORDIS_ORIGINAL]?: unknown })[CORDIS_ORIGINAL]
  if (typeof original === 'object' && original !== null) {
    const options = platformServiceOptions.get(original)
    if (options !== undefined) return options
  }
  let candidate: object | null = service
  while (candidate !== null) {
    const options = platformServiceOptions.get(candidate)
    if (options !== undefined) return options
    candidate = Object.getPrototypeOf(candidate) as object | null
  }
  throw new Error('CordisX Platform service is detached from its host binding')
}

function pluginIdentity(ctx: Context): CordisXPluginIdentity | undefined {
  const identity = ctx as Context & { [CORDISX_PLUGIN_ID]?: string; [CORDISX_PLUGIN_SOURCE]?: string }
  return identity[CORDISX_PLUGIN_ID] === undefined || identity[CORDISX_PLUGIN_SOURCE] === undefined
    ? undefined
    : { id: identity[CORDISX_PLUGIN_ID], source: identity[CORDISX_PLUGIN_SOURCE] }
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function validProviderIds(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length <= 32
    && value.every(validText)
    && new Set(value).size === value.length
}

function validModelRef(value: unknown): value is CordisXPlatformModelRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as Partial<CordisXPlatformModelRef>
  return Object.keys(value).every(key => key === 'providerId' || key === 'modelId')
    && validText(ref.providerId)
    && validText(ref.modelId)
}

function validSessionRef(value: unknown): value is CordisXPlatformSessionRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as Partial<CordisXPlatformSessionRef>
  return Object.keys(value).every(key => key === 'providerId' || key === 'remoteSessionId')
    && validText(ref.providerId)
    && validText(ref.remoteSessionId)
}

function sameSession(left: CordisXPlatformSessionRef, right: CordisXPlatformSessionRef): boolean {
  return left.providerId === right.providerId && left.remoteSessionId === right.remoteSessionId
}

function absolutePath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/** Permission-brokered Platform service. The adapter and broker never cross this API. */
export class CordisXPlatformService extends Service implements CordisXPlatform {
  constructor(ctx: Context, options: CordisXPlatformServiceOptions) {
    super(ctx, 'platform')
    platformServiceOptions.set(this, options)
  }

  get models(): CordisXPlatform['models'] {
    const options = optionsFor(this)
    const token = options.console?.tokenFromContext(this.ctx)
    return Object.freeze({
      list: async (input = {}) =>
        token === undefined || options.console === undefined
          ? await this.listModels(input)
          : await options.console.run(token, 'platform.models.list', input, invocation =>
            this.listModels(input, token, invocation)),
    })
  }

  get tasks(): CordisXPlatform['tasks'] {
    const options = optionsFor(this)
    const token = options.console?.tokenFromContext(this.ctx)
    const instrument = <Value>(
      source: string,
      input: unknown,
      operation: (invocation?: PluginConsoleInvocation) => Promise<Value>,
    ): Promise<Value> => (
      token === undefined || options.console === undefined
        ? operation()
        : options.console.run(token, source, input, operation)
    )
    return Object.freeze({
      list: async (input = {}) =>
        await instrument('platform.tasks.list', input, invocation => this.listTasks(input, token, invocation)),
      read: async input =>
        await instrument('platform.tasks.read', input, invocation => this.readTask(input, token, invocation)),
      create: async input =>
        await instrument('platform.tasks.create', input, invocation => this.createTask(input, token, invocation)),
      control: async input =>
        await instrument('platform.tasks.control', input, invocation => this.controlTask(input, token, invocation)),
    })
  }

  get turns(): CordisXPlatform['turns'] {
    const options = optionsFor(this)
    const token = options.console?.tokenFromContext(this.ctx)
    const instrument = <Value>(
      source: string,
      input: unknown,
      operation: (invocation?: PluginConsoleInvocation) => Promise<Value>,
    ): Promise<Value> => (
      token === undefined || options.console === undefined
        ? operation()
        : options.console.run(token, source, input, operation)
    )
    return Object.freeze({
      submit: async input =>
        await instrument('platform.turns.submit', input, invocation => this.submitTurn(input, token, invocation)),
      control: async input =>
        await instrument('platform.turns.control', input, invocation => this.controlTurn(input, token, invocation)),
    })
  }

  status(): CordisXPlatformAdapterStatus {
    return copy(optionsFor(this).adapter.status())
  }

  private async authorize(
    capability: CordisXPlatformCapability,
    requested: RequestedScope,
    token?: PluginPrincipalToken,
  ): Promise<CordisXPlatformResult<AuthorizationGrant>> {
    const identity = token === undefined ? pluginIdentity(this.ctx) : optionsFor(this).console?.owner(token)
    if (identity === undefined) {
      return failure('permission-undeclared', 'Platform calls require a runtime-bound plugin identity')
    }
    return await optionsFor(this).broker.authorize(
      identity,
      capability,
      requested,
      generationVisibilityFromContext(this.ctx)?.view(this.ctx),
    )
  }

  private async guarded<Value>(
    operation: () => Promise<CordisXPlatformResult<Value>>,
  ): Promise<CordisXPlatformResult<Value>> {
    try {
      return await operation()
    } catch {
      return safeAdapterFailure()
    }
  }

  private async ensureSessionScope(
    grant: AuthorizationGrant,
    session: CordisXPlatformSessionRef,
  ): Promise<CordisXPlatformResult<true>> {
    const scope = grant.declaration.scope
    if (scope.cwdRoots === undefined) return { ok: true, value: true }
    const projection = await this.guarded(async () => await optionsFor(this).adapter.readTask({ session }))
    if (!projection.ok) return projection
    const requested = { session, providerId: session.providerId, cwd: projection.value.cwd }
    if (scopeAllows(scope, requested)) return { ok: true, value: true }
    const identity = pluginIdentity(this.ctx)
    if (identity !== undefined) optionsFor(this).broker.recordScopeDenial(identity, grant.declaration.name, requested)
    return failure(
      'permission-scope-denied',
      `Session ${session.remoteSessionId} is outside the declared ${grant.declaration.name} scope`,
    )
  }

  private async listModels(
    input: CordisXModelsListInput,
    token?: PluginPrincipalToken,
    invocation?: PluginConsoleInvocation,
  ): Promise<CordisXPlatformResult<CordisXModelPage>> {
    if (input.providerIds !== undefined && !validProviderIds(input.providerIds)) {
      return failure('invalid-request', 'providerIds must be a unique string array')
    }
    const grant = await this.authorize('models.read', {
      ...(input.providerIds === undefined ? {} : { providerIds: input.providerIds }),
    }, token)
    if (!grant.ok) return grant
    invocation?.dispatch()
    const result = await this.guarded(async () => await optionsFor(this).adapter.listModels(input))
    if (!result.ok) return result
    return {
      ok: true,
      value: {
        ...result.value,
        models: result.value.models.filter(item => scopeAllows(grant.value.declaration.scope, { model: item.ref })),
      },
    }
  }

  private async listTasks(
    input: CordisXTasksListInput,
    token?: PluginPrincipalToken,
    invocation?: PluginConsoleInvocation,
  ): Promise<CordisXPlatformResult<CordisXSessionPage>> {
    if (input.providerIds !== undefined && !validProviderIds(input.providerIds)) {
      return failure('invalid-request', 'providerIds must be a unique string array')
    }
    if (input.cwd !== undefined && (!validText(input.cwd) || !absolutePath(input.cwd))) {
      return failure('invalid-request', 'cwd must be an absolute path')
    }
    if (input.searchTerm !== undefined && !validText(input.searchTerm)) {
      return failure('invalid-request', 'searchTerm must be a non-empty string')
    }
    if (input.cursor !== undefined && !validText(input.cursor)) {
      return failure('invalid-request', 'cursor must be a non-empty string')
    }
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500)) {
      return failure('invalid-request', 'limit must be an integer between 1 and 500')
    }
    const grant = await this.authorize('tasks.catalog.read', {
      ...(input.providerIds === undefined ? {} : { providerIds: input.providerIds }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    }, token)
    if (!grant.ok) return grant
    invocation?.dispatch()
    const result = await this.guarded(async () => await optionsFor(this).adapter.listTasks(input))
    if (!result.ok) return result
    return {
      ok: true,
      value: {
        ...result.value,
        sessions: result.value.sessions.filter(item =>
          scopeAllows(grant.value.declaration.scope, {
            providerId: item.ref.providerId,
            cwd: item.cwd,
            session: item.ref,
          })
        ),
      },
    }
  }

  private async readTask(
    input: CordisXTaskReadInput,
    token?: PluginPrincipalToken,
    invocation?: PluginConsoleInvocation,
  ): Promise<CordisXPlatformResult<CordisXSessionProjection>> {
    if (!validSessionRef(input.session)) {
      return failure('invalid-request', 'session must be a complete Platform session reference')
    }
    const requested = { providerId: input.session.providerId, session: input.session }
    const grant = await this.authorize('tasks.content.read', requested, token)
    if (!grant.ok) return grant
    invocation?.dispatch()
    const result = await this.guarded(async () => await optionsFor(this).adapter.readTask(input))
    if (!result.ok) return result
    if (!sameSession(result.value.ref, input.session) || result.value.model.providerId !== input.session.providerId) {
      return safeAdapterFailure()
    }
    if (scopeAllows(grant.value.declaration.scope, { ...requested, cwd: result.value.cwd })) return result
    const identity = pluginIdentity(this.ctx)
    if (identity !== undefined) {
      optionsFor(this).broker.recordScopeDenial(identity, grant.value.declaration.name, {
        ...requested,
        cwd: result.value.cwd,
      })
    }
    return failure('permission-scope-denied', 'Session content is outside the declared scope')
  }

  private async createTask(
    input: CordisXTaskCreateInput,
    token?: PluginPrincipalToken,
    invocation?: PluginConsoleInvocation,
  ): Promise<CordisXPlatformResult<CordisXSessionCreateOutcome>> {
    if (!validModelRef(input.model)) {
      return failure('invalid-request', 'model must be a complete Platform model reference')
    }
    if (!validText(input.cwd) || !absolutePath(input.cwd)) {
      return failure('invalid-request', 'cwd must be an absolute path')
    }
    if (input.initialMessage !== undefined && !validText(input.initialMessage)) {
      return failure('invalid-request', 'initialMessage must be a non-empty string')
    }
    const grant = await this.authorize('tasks.create', {
      providerId: input.model.providerId,
      model: input.model,
      cwd: input.cwd,
    }, token)
    if (!grant.ok) return grant
    invocation?.dispatch()
    const models = await this.guarded(async () =>
      await optionsFor(this).adapter.listModels({ providerIds: [input.model.providerId] })
    )
    if (!models.ok) return models
    const providerModels = models.value.models.filter(model => model.ref.providerId === input.model.providerId)
    if (providerModels.length === 0) {
      return failure('invalid-provider', `Provider ${input.model.providerId} is not currently available`)
    }
    if (!providerModels.some(model => model.ref.modelId === input.model.modelId)) {
      return failure(
        'invalid-model',
        `Model ${input.model.modelId} is not currently available from provider ${input.model.providerId}`,
      )
    }
    const created = await this.guarded(async () =>
      await optionsFor(this).adapter.createTask({
        model: input.model,
        cwd: input.cwd,
      })
    )
    if (!created.ok) return created
    if (
      created.value.ref.providerId !== input.model.providerId
      || created.value.model.providerId !== input.model.providerId
    ) return safeAdapterFailure()
    if (input.initialMessage === undefined) return { ok: true, value: { status: 'created', session: created.value } }
    const turn = await this.guarded(async () =>
      await optionsFor(this).adapter.submitTurn({ session: created.value.ref, message: input.initialMessage as string })
    )
    if (turn.ok) return { ok: true, value: { status: 'created', session: created.value, initialTurn: turn.value } }
    return {
      ok: true,
      value: {
        status: 'created-initial-turn-failed',
        session: created.value,
        error: {
          code: 'initial-turn-failed',
          message:
            `Session ${created.value.ref.remoteSessionId} was created, but its initial turn did not start: ${turn.error.message}`,
          ...(turn.error.retryable === undefined ? {} : { retryable: turn.error.retryable }),
        },
      },
    }
  }

  private async controlTask(
    input: CordisXTaskControlInput,
    token?: PluginPrincipalToken,
    invocation?: PluginConsoleInvocation,
  ): Promise<CordisXPlatformResult<CordisXTaskControlOutcome>> {
    if (
      !validSessionRef(input.session) || !['continue', 'fork', 'archive', 'restore', 'delete'].includes(input.action)
    ) {
      return failure('invalid-request', 'task control input is invalid')
    }
    const grant = await this.authorize('tasks.control', {
      providerId: input.session.providerId,
      session: input.session,
    }, token)
    if (!grant.ok) return grant
    invocation?.dispatch()
    const scope = await this.ensureSessionScope(grant.value, input.session)
    if (!scope.ok) return scope
    return await this.guarded(async () => await optionsFor(this).adapter.controlTask(input))
  }

  private async submitTurn(
    input: CordisXTurnSubmitInput,
    token?: PluginPrincipalToken,
    invocation?: PluginConsoleInvocation,
  ): Promise<CordisXPlatformResult<CordisXTurnStart>> {
    if (!validSessionRef(input.session) || !validText(input.message)) {
      return failure('invalid-request', 'session and message must be valid')
    }
    const grant = await this.authorize(
      'turns.submit',
      { providerId: input.session.providerId, session: input.session },
      token,
    )
    if (!grant.ok) return grant
    invocation?.dispatch()
    const scope = await this.ensureSessionScope(grant.value, input.session)
    if (!scope.ok) return scope
    return await this.guarded(async () => await optionsFor(this).adapter.submitTurn(input))
  }

  private async controlTurn(
    input: CordisXTurnControlInput,
    token?: PluginPrincipalToken,
    invocation?: PluginConsoleInvocation,
  ): Promise<CordisXPlatformResult<CordisXTurnControlOutcome>> {
    if (!validSessionRef(input.session) || !['steer', 'interrupt'].includes(input.action)) {
      return failure('invalid-request', 'turn control input is invalid')
    }
    if (input.action === 'steer' && !validText(input.message)) {
      return failure('invalid-request', 'steer message must be a non-empty string')
    }
    const grant = await this.authorize('turns.control', {
      providerId: input.session.providerId,
      session: input.session,
    }, token)
    if (!grant.ok) return grant
    invocation?.dispatch()
    const scope = await this.ensureSessionScope(grant.value, input.session)
    if (!scope.ok) return scope
    return await this.guarded(async () => await optionsFor(this).adapter.controlTurn(input))
  }
}
