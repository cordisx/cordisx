import { Context, Service } from '@deepseek-ai/cordis'
import type {
  CordisXCommandHandler,
  CordisXCommandMetadata,
  CordisXCommandReference,
  CordisXCommands,
  CordisXSurfaceInvocationContextV1,
} from '../contracts.js'
import { ownerFromContext, qualifyOwnedId } from './ownership.js'
import type { ExtensionPointAccessResolver } from './extension-points.js'
import { CORDISX_HOST_ICON_TOKENS } from './surfaces.js'
import { ICON_TOKEN_PATTERN, assertLocalId, assertLocalizedText, assertReference, immutableSnapshot } from './validation.js'
import type { PluginConsoleAspect, PluginPrincipalToken } from './plugin-console.js'

interface CommandRecord {
  readonly owner: string
  readonly qualifiedId: string
  readonly metadata: CordisXCommandMetadata
  readonly handler: CordisXCommandHandler
  readonly principal?: PluginPrincipalToken
  readonly running: Map<string, AbortController>
  lastError?: string
}

export interface CommandSnapshot {
  readonly owner: string
  readonly id: string
  readonly qualifiedId: string
  readonly metadata: CordisXCommandMetadata
  readonly running: number
  readonly lastError?: string
}

/** Host-generated origin. This is intentionally absent from the public CordisXCommands API. */
export interface SurfaceCommandOrigin {
  readonly pointId: string
  readonly contributionId: string
  readonly context?: CordisXSurfaceInvocationContextV1
}

export class CommandRegistry {
  private readonly records = new Map<string, CommandRecord>()
  private readonly listeners = new Set<() => void>()
  private disposed = false

  constructor(private access?: ExtensionPointAccessResolver, private readonly console?: PluginConsoleAspect) {}

  setAccessResolver(access: ExtensionPointAccessResolver): void {
    this.access = access
  }

  register(owner: string, metadata: CordisXCommandMetadata, handler: CordisXCommandHandler, principal?: PluginPrincipalToken): () => void {
    if (this.disposed) throw new Error('CordisX command registry is disposed')
    assertLocalId(owner, 'command owner')
    assertLocalId(metadata.id, 'command id')
    const unknown = Object.keys(metadata).find(key => !['id', 'title', 'category', 'icon', 'public'].includes(key))
    if (unknown !== undefined) throw new Error(`command metadata has unknown field ${unknown}`)
    assertLocalizedText(metadata.title, 'command title')
    if (metadata.category !== undefined) assertLocalizedText(metadata.category, 'command category')
    if (metadata.icon !== undefined && (!ICON_TOKEN_PATTERN.test(metadata.icon)
      || !(CORDISX_HOST_ICON_TOKENS as readonly string[]).includes(metadata.icon))) {
      throw new Error(`command ${metadata.id} uses unknown host icon token ${metadata.icon}`)
    }
    if (metadata.public !== undefined && typeof metadata.public !== 'boolean') throw new Error('command public must be a boolean')
    if (typeof handler !== 'function') throw new Error(`command ${metadata.id} requires a handler`)
    const qualifiedId = qualifyOwnedId(owner, metadata.id)
    if (this.records.has(qualifiedId)) throw new Error(`command ${qualifiedId} is already registered`)
    const record: CommandRecord = {
      owner,
      qualifiedId,
      metadata: immutableSnapshot(metadata),
      handler,
      ...(principal === undefined ? {} : { principal }),
      running: new Map(),
    }
    this.records.set(qualifiedId, record)
    this.notify()
    let active = true
    return () => {
      if (!active) return
      active = false
      for (const controller of record.running.values()) controller.abort()
      record.running.clear()
      this.records.delete(qualifiedId)
      this.notify()
    }
  }

  async execute(
    requestingOwner: string,
    reference: CordisXCommandReference,
    invocationKey = 'default',
    origin?: SurfaceCommandOrigin,
    requestingPrincipal?: PluginPrincipalToken,
  ): Promise<unknown> {
    if (this.disposed) throw new Error('CordisX command registry is disposed')
    assertReference(reference.id, 'command reference')
    const unknown = Object.keys(reference).find(key => !['id', 'arguments'].includes(key))
    if (unknown !== undefined) throw new Error(`command reference has unknown field ${unknown}`)
    const qualifiedId = qualifyOwnedId(requestingOwner, reference.id)
    const record = this.records.get(qualifiedId)
    if (record === undefined) throw new Error(`command ${qualifiedId} is not registered`)
    if (record.owner !== requestingOwner && record.metadata.public !== true) {
      throw new Error(`command ${qualifiedId} is private to plugin ${record.owner}`)
    }
    if (origin !== undefined) {
      const decision = this.access?.authorizeSurfaceCommand(requestingOwner, origin.pointId, origin.contributionId, qualifiedId)
      if (decision !== undefined && !decision.authorized) {
        throw new Error(decision.reason ?? `extension point ${origin.pointId} is denied for plugin ${requestingOwner}`)
      }
      if (origin.context !== undefined && (
        origin.context.pointId !== origin.pointId
        || origin.context.contributionId !== origin.contributionId
        || origin.context.commandId !== qualifiedId
      )) throw new Error('host invocation context does not match its surface origin')
    }
    const executionId = `${qualifiedId}\u0000${invocationKey}`
    if (record.running.has(executionId)) throw new Error(`command ${qualifiedId} is already running for ${invocationKey}`)
    const abort = new AbortController()
    record.running.set(executionId, abort)
    delete record.lastError
    this.notify()
    const invoke = async (correlationId?: string): Promise<unknown> => {
      const executeHandler = async (): Promise<unknown> => await record.handler({
        owner: record.owner,
        id: qualifiedId,
        arguments: reference.arguments === undefined ? undefined : immutableSnapshot(reference.arguments),
        signal: abort.signal,
        invocationKey,
        ...(origin?.context === undefined ? {} : { hostContext: immutableSnapshot(origin.context) }),
      })
      return record.principal === undefined || this.console === undefined
        ? await executeHandler()
        : await this.console.runInPluginContext(record.principal, {
            ...(correlationId === undefined ? {} : { correlationId }),
            trigger: { kind: 'registration', registrationId: qualifiedId },
          }, executeHandler)
    }
    try {
      const principal = requestingPrincipal ?? record.principal
      if (principal === undefined || this.console === undefined) return await invoke()
      const principalOwner = this.console.owner(principal)
      return await this.console.run(principal, `commands.${qualifiedId}`, reference.arguments, async invocation => {
        invocation.dispatch('Dispatched to registered command handler')
        return await invoke(invocation.correlationId)
      }, {
        invocationKey,
        trigger: { kind: 'registration', registrationId: qualifiedId },
        ...(principalOwner.id === record.owner ? {} : { effectiveOwner: this.console.owner(record.principal!) }),
      })
    } catch (error) {
      if (!abort.signal.aborted) record.lastError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      record.running.delete(executionId)
      this.notify()
    }
  }

  has(requestingOwner: string, reference: CordisXCommandReference): boolean {
    const qualifiedId = qualifyOwnedId(requestingOwner, reference.id)
    const record = this.records.get(qualifiedId)
    return record !== undefined && (record.owner === requestingOwner || record.metadata.public === true)
  }

  snapshot(): readonly CommandSnapshot[] {
    return [...this.records.values()]
      .map(record => ({
        owner: record.owner,
        id: record.metadata.id,
        qualifiedId: record.qualifiedId,
        metadata: record.metadata,
        running: record.running.size,
        ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
      }))
      .sort((left, right) => left.qualifiedId.localeCompare(right.qualifiedId))
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const record of this.records.values()) {
      for (const controller of record.running.values()) controller.abort()
    }
    this.records.clear()
    this.listeners.clear()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export interface CordisXCommandServiceOptions { readonly registry?: CommandRegistry; readonly console?: PluginConsoleAspect }

export class CordisXCommandService extends Service implements CordisXCommands {
  private readonly registry: CommandRegistry
  private readonly console: PluginConsoleAspect | undefined

  constructor(ctx: Context, options: CommandRegistry | CordisXCommandServiceOptions = {}) {
    super(ctx, 'commands')
    this.console = options instanceof CommandRegistry ? undefined : options.console
    this.registry = options instanceof CommandRegistry ? options : options.registry ?? new CommandRegistry(undefined, options.console)
    ctx.effect(() => () => this.registry.dispose(), 'cordisx: command registry')
  }

  register(metadata: CordisXCommandMetadata, handler: CordisXCommandHandler): ReturnType<CordisXCommands['register']> {
    const owner = ownerFromContext(this.ctx)
    const principal = this.console?.tokenFromContext(this.ctx)
    return this.ctx.effect(() => this.registry.register(owner, metadata, handler, principal), `commands.register(${JSON.stringify(metadata.id)})`)
  }

  execute(reference: CordisXCommandReference, invocationKey?: string): Promise<unknown> {
    const principal = this.console?.tokenFromContext(this.ctx)
    const owner = principal === undefined ? ownerFromContext(this.ctx) : this.console!.owner(principal).id
    return this.registry.execute(owner, reference, invocationKey, undefined, principal)
  }

  executeFor(owner: string, reference: CordisXCommandReference, invocationKey?: string, origin?: SurfaceCommandOrigin): Promise<unknown> {
    return this.registry.execute(owner, reference, invocationKey, origin)
  }

  hasFor(owner: string, reference: CordisXCommandReference): boolean {
    return this.registry.has(owner, reference)
  }

  snapshot(): readonly CommandSnapshot[] {
    return this.registry.snapshot()
  }

  subscribeInternal(listener: () => void): () => void {
    return this.registry.subscribe(listener)
  }

  setAccessResolver(access: ExtensionPointAccessResolver): void {
    this.registry.setAccessResolver(access)
  }
}
