/**
 * Host-private lifecycle for a future product-page admission adapter.
 *
 * This registry deliberately has no Cordis service or public Context surface.
 * It records the authenticated page mount, binds command executions to that
 * mount, and moves an accepted fresh-Room capture only at a matching later
 * page-route activation. The Protocol adapter will translate its versioned
 * public values into these Host-owned records after that contract is formal.
 */

export interface PageAdmissionBinding {
  readonly bindingId: string
  readonly ownerGeneration: string
}

export interface PageAdmissionRoute {
  readonly outlet: string
  /** Exact local route declaration id, never a qualified display id. */
  readonly routeId: string
  readonly roomId?: string
}

export interface PageAdmissionTarget {
  readonly roomId: string
  readonly participantId: string
  readonly memberId: string
  readonly runId: string
}

export interface PageAdmissionDestinationRoute {
  readonly outlet: string
  readonly routeId: string
  readonly param: 'roomId'
  readonly roomId: string
}

export interface PageAdmissionSourceCapture {
  readonly sessionId: string
  readonly messageId: string
}

export interface PageAdmissionMountInput {
  readonly owner: string
  readonly source?: string
  readonly moduleGeneration: string
  readonly connectionGeneration: string
  readonly route: PageAdmissionRoute
  readonly signal: AbortSignal
}

export interface PageAdmissionCommand {
  readonly executionId: string
  readonly commandId: string
  readonly binding: PageAdmissionBinding
}

export interface PageAdmissionDeclaration {
  readonly token: string
  readonly target: PageAdmissionTarget
}

export interface PageAdmissionClaim {
  readonly declaration: PageAdmissionDeclaration
  readonly source: PageAdmissionSourceCapture
}

interface BindingRecord extends PageAdmissionMountInput {
  readonly binding: PageAdmissionBinding
  active: boolean
}

interface CommandRecord {
  readonly command: PageAdmissionCommand
  readonly owner: string
  readonly source?: string
  readonly moduleGeneration: string
  readonly connectionGeneration: string
  closed: boolean
}

interface DeclarationRecord {
  readonly declaration: PageAdmissionDeclaration
  readonly executionId: string
  bindingId: string
  readonly owner: string
  readonly source?: string
  readonly moduleGeneration: string
  readonly connectionGeneration: string
  readonly destination?: PageAdmissionDestinationRoute
  reserved: boolean
  accepted?: PageAdmissionSourceCapture
  claimed: boolean
  revoked: boolean
}

const opaque = (value: string): boolean => value.length > 0 && value.length <= 4_096

const sameRoute = (left: PageAdmissionDestinationRoute, right: PageAdmissionRoute): boolean =>
  left.outlet === right.outlet && left.routeId === right.routeId && left.roomId === right.roomId

const sameOwner = (left: Pick<BindingRecord, 'owner' | 'source' | 'moduleGeneration' | 'connectionGeneration'>, right: Pick<BindingRecord, 'owner' | 'source' | 'moduleGeneration' | 'connectionGeneration'>): boolean =>
  left.owner === right.owner && left.source === right.source
  && left.moduleGeneration === right.moduleGeneration && left.connectionGeneration === right.connectionGeneration

const targetKey = (target: PageAdmissionTarget): string => [
  target.roomId,
  target.participantId,
  target.memberId,
  target.runId,
].map(value => `${value.length}:${value}`).join('')

/**
 * One Host-owned lifecycle registry. Plugins never receive this registry,
 * binding records, or route claims directly.
 */
export class PageAdmissionBindingRegistry {
  private readonly bindings = new Map<string, BindingRecord>()
  private readonly commands = new Map<string, CommandRecord>()
  private readonly declarations = new Map<string, DeclarationRecord>()
  private sequence = 0
  private disposed = false

  mount(input: PageAdmissionMountInput): PageAdmissionBinding {
    if (this.disposed) throw new Error('page admission lifecycle is disposed')
    if (!opaque(input.owner) || !opaque(input.moduleGeneration) || !opaque(input.connectionGeneration)
      || !opaque(input.route.outlet) || !opaque(input.route.routeId)
      || (input.route.roomId !== undefined && !opaque(input.route.roomId))) {
      throw new Error('page admission mount identity is invalid')
    }
    const binding = Object.freeze({
      bindingId: this.identifier('page-binding'),
      ownerGeneration: this.identifier('page-owner-generation'),
    })
    const record: BindingRecord = { ...input, route: Object.freeze({ ...input.route }), binding, active: true }
    this.bindings.set(binding.bindingId, record)
    input.signal.addEventListener('abort', () => this.release(binding), { once: true })
    if (input.signal.aborted) this.release(binding)
    return binding
  }

  begin(binding: PageAdmissionBinding, commandId: string): PageAdmissionCommand | undefined {
    const record = this.binding(binding)
    if (record === undefined || !record.active || !opaque(commandId)) return undefined
    const command = Object.freeze({
      executionId: this.identifier('page-command'),
      commandId,
      binding: record.binding,
    })
    this.commands.set(command.executionId, {
      command,
      owner: record.owner,
      ...(record.source === undefined ? {} : { source: record.source }),
      moduleGeneration: record.moduleGeneration,
      connectionGeneration: record.connectionGeneration,
      closed: false,
    })
    return command
  }

  declare(
    command: PageAdmissionCommand,
    target: PageAdmissionTarget,
    destination?: PageAdmissionDestinationRoute,
  ): PageAdmissionDeclaration | undefined {
    const execution = this.command(command)
    const binding = execution === undefined ? undefined : this.binding(command.binding)
    if (execution === undefined || execution.closed || binding === undefined || !binding.active
      || !this.validTarget(target) || (destination !== undefined && !this.validDestination(target, destination))) return undefined
    const duplicate = [...this.declarations.values()].some(candidate =>
      candidate.executionId === command.executionId && targetKey(candidate.declaration.target) === targetKey(target))
    if (duplicate) return undefined
    const declaration = Object.freeze({ token: this.identifier('page-target'), target: Object.freeze({ ...target }) })
    this.declarations.set(declaration.token, {
      declaration,
      executionId: command.executionId,
      bindingId: command.binding.bindingId,
      owner: execution.owner,
      ...(execution.source === undefined ? {} : { source: execution.source }),
      moduleGeneration: execution.moduleGeneration,
      connectionGeneration: execution.connectionGeneration,
      ...(destination === undefined ? {} : { destination: Object.freeze({ ...destination }) }),
      reserved: false,
      claimed: false,
      revoked: false,
    })
    return declaration
  }

  reserve(declaration: PageAdmissionDeclaration): boolean {
    const record = this.declaration(declaration)
    const command = record === undefined ? undefined : this.commands.get(record.executionId)
    const binding = record === undefined ? undefined : this.bindings.get(record.bindingId)
    if (record === undefined || record.revoked || record.reserved || record.accepted !== undefined || record.claimed
      || command === undefined || command.closed || binding === undefined || !binding.active) return false
    record.reserved = true
    return true
  }

  /** Call only after the future Host reservation has captured exact accepted Session/message identities. */
  accept(declaration: PageAdmissionDeclaration, source: PageAdmissionSourceCapture): boolean {
    const record = this.declaration(declaration)
    const binding = record === undefined ? undefined : this.bindings.get(record.bindingId)
    if (record === undefined || record.revoked || !record.reserved || record.accepted !== undefined || record.claimed
      || binding === undefined || !binding.active || !opaque(source.sessionId) || !opaque(source.messageId)) return false
    record.accepted = Object.freeze({ ...source })
    return true
  }

  complete(command: PageAdmissionCommand): void {
    const record = this.command(command)
    if (record === undefined || record.closed) return
    record.closed = true
    for (const declaration of this.declarations.values()) {
      if (declaration.executionId === command.executionId
        && declaration.destination !== undefined && !declaration.claimed) declaration.revoked = true
    }
  }

  /** Exact accepted captures usable on the given still-live binding. */
  captures(binding: PageAdmissionBinding): readonly PageAdmissionClaim[] {
    const current = this.binding(binding)
    if (current === undefined || !current.active) return []
    return Object.freeze([...this.declarations.values()].flatMap(record =>
      record.bindingId !== binding.bindingId || record.accepted === undefined || record.revoked
        || (record.destination !== undefined && !record.claimed)
        ? []
        : [{ declaration: record.declaration, source: record.accepted }]))
  }

  /**
   * Host-only activation hook. It moves each accepted fresh capture exactly
   * once to the matching destination binding; it never retains the old mount.
   */
  claim(binding: PageAdmissionBinding): readonly PageAdmissionClaim[] {
    const destination = this.binding(binding)
    if (destination === undefined || !destination.active) return []
    const claimed: PageAdmissionClaim[] = []
    for (const record of this.declarations.values()) {
      const origin = this.bindings.get(record.bindingId)
      const command = this.commands.get(record.executionId)
      if (record.destination === undefined || record.accepted === undefined || record.claimed || record.revoked
        || command === undefined || command.closed
        || origin === undefined || origin.active || !sameOwner(origin, destination)
        || !sameRoute(record.destination, destination.route)) continue
      record.claimed = true
      record.bindingId = binding.bindingId
      claimed.push({ declaration: record.declaration, source: record.accepted })
    }
    return Object.freeze(claimed)
  }

  release(binding: PageAdmissionBinding): void {
    const record = this.binding(binding)
    if (record === undefined || !record.active) return
    record.active = false
    for (const command of this.commands.values()) {
      if (command.command.binding.bindingId !== binding.bindingId) continue
      const declarations = [...this.declarations.values()].filter(candidate => candidate.executionId === command.command.executionId)
      const transferable = declarations.length > 0 && declarations.every(candidate =>
        candidate.destination !== undefined && candidate.accepted !== undefined && !candidate.revoked && !candidate.claimed)
      if (!transferable) this.complete(command.command)
    }
    for (const declaration of this.declarations.values()) {
      if (declaration.bindingId !== binding.bindingId) continue
      if (declaration.claimed) {
        declaration.revoked = true
        continue
      }
      // Only an already accepted fresh-Room continuation may outlive the old
      // binding long enough for the destination activation hook to claim it.
      if (declaration.destination !== undefined && declaration.accepted !== undefined) continue
      declaration.revoked = true
    }
  }

  fenceOwner(owner: string, source: string | undefined, moduleGeneration: string): void {
    for (const binding of this.bindings.values()) {
      if (binding.owner === owner && binding.source === source && binding.moduleGeneration === moduleGeneration) {
        this.release(binding.binding)
      }
    }
    for (const declaration of this.declarations.values()) {
      if (declaration.owner === owner && declaration.source === source && declaration.moduleGeneration === moduleGeneration) {
        declaration.revoked = true
      }
    }
  }

  fenceConnection(connectionGeneration: string): void {
    for (const binding of this.bindings.values()) {
      if (binding.connectionGeneration !== connectionGeneration) this.release(binding.binding)
    }
    for (const declaration of this.declarations.values()) {
      if (declaration.connectionGeneration !== connectionGeneration) declaration.revoked = true
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const binding of this.bindings.values()) this.release(binding.binding)
    this.bindings.clear()
    this.commands.clear()
    this.declarations.clear()
  }

  private binding(binding: PageAdmissionBinding): BindingRecord | undefined {
    const record = this.bindings.get(binding.bindingId)
    return record?.binding.ownerGeneration === binding.ownerGeneration ? record : undefined
  }

  private command(command: PageAdmissionCommand): CommandRecord | undefined {
    const record = this.commands.get(command.executionId)
    return record?.command.commandId === command.commandId
      && record.command.binding.bindingId === command.binding.bindingId
      && record.command.binding.ownerGeneration === command.binding.ownerGeneration
      ? record
      : undefined
  }

  private declaration(declaration: PageAdmissionDeclaration): DeclarationRecord | undefined {
    const record = this.declarations.get(declaration.token)
    return record !== undefined && targetKey(record.declaration.target) === targetKey(declaration.target) ? record : undefined
  }

  private validTarget(target: PageAdmissionTarget): boolean {
    return opaque(target.roomId) && opaque(target.participantId) && opaque(target.memberId) && opaque(target.runId)
  }

  private validDestination(target: PageAdmissionTarget, destination: PageAdmissionDestinationRoute): boolean {
    return opaque(destination.outlet) && opaque(destination.routeId) && destination.param === 'roomId'
      && destination.roomId === target.roomId
  }

  private identifier(kind: string): string {
    this.sequence += 1
    return `${kind}.${this.sequence}`
  }
}
