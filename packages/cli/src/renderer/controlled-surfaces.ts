import {
  CORDISX_EXTENSION_POINT_CONTROL_ACCESS_SCHEMA_V1,
  CORDISX_EXTENSION_POINT_CONTROL_AUTHORIZATION_SCHEMA_V1,
  CORDISX_EXTENSION_POINT_CONTROL_DECLARATION_SCHEMA_V1,
  CORDISX_EXTENSION_POINT_CONTROL_EVENT_SCHEMA_V1,
  CORDISX_EXTENSION_POINT_CONTROL_RESULT_SCHEMA_V1,
  CORDISX_EXTENSION_POINT_CONTROL_SNAPSHOT_SCHEMA_V1,
  type CordisXExtensionPointControlAccessV1,
  type CordisXExtensionPointControlAuthorizationV1,
  type CordisXExtensionPointControlBindingsProjectionV1,
  type CordisXExtensionPointControlCandidateSnapshotV1,
  type CordisXExtensionPointControlClaimOptions,
  type CordisXExtensionPointControlClaimReferenceV1,
  type CordisXExtensionPointControlDeclarationV1,
  type CordisXExtensionPointControlEventV1,
  type CordisXExtensionPointControlIdentityV1,
  type CordisXExtensionPointControlLease,
  type CordisXExtensionPointControlLeaseSnapshot,
  type CordisXExtensionPointControlMode,
  type CordisXExtensionPointControlPointSnapshotV1,
  type CordisXExtensionPointControlResultV1,
  type CordisXExtensionPointControlSafeValueSchemaV1,
  type CordisXExtensionPointControlSnapshotV1,
  type CordisXHostExtensionPointControlCatalogV1,
  type CordisXHostExtensionPointControlPointV1,
  type CordisXJsonScalar,
} from '../contracts.js'
import { assertLocalId, immutableSnapshot } from './validation.js'
import type { PluginGenerationView } from './generation-visibility.js'
import {
  type CandidateRecord,
  canonicalClaimKey,
  claimKey,
  claimReference,
  type ControlledSurfaceCommandContext,
  ControlledSurfaceCommandError,
  type ControlledSurfaceGeneration,
  type ControlledSurfaceGroupChoice,
  type ControlledSurfaceManagerSnapshot,
  type ControlledSurfacePointBinding,
  ControlledSurfacePolicyBroker,
  type ControlledSurfaceRegistration,
  type ControlledSurfaceRegistrationHandle,
  modeCompatible,
  pathToAncestor,
  reason,
  type Resolution,
  type ResolvedCandidate,
  sameClaim,
  sameGeneration,
  unique,
  validSafeValue,
} from './controlled-surface-policy.js'
export {
  BrowserControlledSurfacePolicyStore,
  ControlledSurfaceCommandError,
  ControlledSurfacePolicyBroker,
  MemoryControlledSurfacePolicyStore,
  normalizeControlledSurfaceDeclaration,
} from './controlled-surface-policy.js'
export type {
  ControlledSurfaceCommandContext,
  ControlledSurfaceGeneration,
  ControlledSurfaceGroupChoice,
  ControlledSurfaceManagerSnapshot,
  ControlledSurfacePointBinding,
  ControlledSurfacePolicyStore,
  ControlledSurfaceRegistration,
  ControlledSurfaceRegistrationHandle,
  ControlledSurfaceSelectedClaim,
} from './controlled-surface-policy.js'

export class ControlledSurfaceCoordinator {
  private readonly points: ReadonlyMap<string, CordisXHostExtensionPointControlPointV1>
  private readonly candidates = new Map<string, CandidateRecord>()
  private readonly lastEvents = new Map<
    string,
    Map<string, Readonly<{ sequence: number; payload: Readonly<Record<string, CordisXJsonScalar>> }>>
  >()
  private readonly listeners = new Set<() => void>()
  private nextSequence = 0
  private snapshotRevision = 0
  private eventSequence = 0
  private disposed = false
  private readonly disconnectPolicy: () => void

  constructor(
    readonly catalog: CordisXHostExtensionPointControlCatalogV1,
    private readonly bindings: Readonly<Record<string, ControlledSurfacePointBinding>>,
    readonly hostGeneration: string,
    readonly policies = new ControlledSurfacePolicyBroker(),
    private readonly isGenerationVisible: (
      generation: ControlledSurfaceGeneration,
      view?: PluginGenerationView,
    ) => boolean = () => true,
    private readonly isGenerationCallable: (generation: ControlledSurfaceGeneration) => boolean = generation =>
      this.isGenerationVisible(generation),
  ) {
    if (catalog.schemaVersion !== 1 || catalog.points.length > 256 || hostGeneration.length === 0) {
      throw new Error('invalid controlled surface Host scope')
    }
    const points = new Map<string, CordisXHostExtensionPointControlPointV1>()
    for (const point of catalog.points) {
      assertLocalId(point.id, 'controlled surface point id')
      if (points.has(point.id)) throw new Error(`duplicate controlled surface point ${point.id}`)
      if (this.bindings[point.id] === undefined) {
        throw new Error(`controlled surface point ${point.id} requires a Host binding`)
      }
      this.validatePoint(point)
      points.set(point.id, immutableSnapshot(point))
    }
    for (const point of points.values()) {
      if (point.parentPointId !== undefined && !points.has(point.parentPointId)) {
        throw new Error(`unknown parent point ${point.parentPointId}`)
      }
      if (pathToAncestor(points, point.id, point.id) !== undefined) {
        throw new Error(`controlled surface hierarchy contains a cycle at ${point.id}`)
      }
    }
    this.points = points
    this.disconnectPolicy = policies.subscribe(() => this.invalidate())
  }

  register(input: ControlledSurfaceRegistration): ControlledSurfaceRegistrationHandle {
    this.assertLive()
    const declaration = immutableSnapshot(input.declaration)
    const principal = this.policies.principal(declaration.principalHandle)
    if (
      principal === undefined || principal.source !== input.generation.source
      || principal.pluginId !== input.generation.pluginId
      || principal.origin !== input.generation.principalOrigin
    ) {
      throw new Error('control principal handle does not match its Host-private registry')
    }
    if (declaration.origin !== input.generation.principalOrigin) {
      throw new Error('control declaration origin does not match its Host-private principal')
    }
    const key = `${claimKey(declaration)}\0${input.generation.moduleGeneration ?? 'host'}\0${
      input.generation.transactionId ?? ''
    }\0${input.generation.transactionEpoch ?? ''}`
    if (this.candidates.has(key)) {
      throw new Error(`controlled surface claim already registered: ${claimKey(declaration)}`)
    }
    let presenter: unknown
    let validationError: string | undefined
    try {
      this.validateDeclaration(declaration, input.generation)
      presenter = immutableSnapshot(input.presenter)
    } catch (error) {
      validationError = error instanceof Error ? error.message : String(error)
    }
    const record: CandidateRecord = {
      key,
      sequence: this.nextSequence++,
      declaration,
      generation: Object.freeze({ ...input.generation }),
      ...(input.hostAccess === undefined ? {} : { hostAccess: input.hostAccess }),
      ...(presenter === undefined ? {} : { presenter }),
      ...(validationError === undefined ? {} : { validationError }),
    }
    this.candidates.set(key, record)
    this.invalidate()
    let active = true
    const dispose = (): void => {
      if (!active) return
      active = false
      this.candidates.delete(key)
      this.invalidate()
    }
    const handle = dispose as ControlledSurfaceRegistrationHandle
    handle.dispose = dispose
    handle.updatePresenter = (next: unknown): void => {
      if (!active) throw new Error('controlled surface claim is disposed')
      if (!this.callableGeneration(record.generation)) throw new Error('stale controlled surface generation')
      try {
        record.presenter = immutableSnapshot(next)
        delete record.validationError
        this.validateDeclaration(record.declaration, record.generation)
      } catch (error) {
        record.presenter = undefined
        record.validationError = error instanceof Error ? error.message : String(error)
      }
      this.invalidate()
    }
    return handle
  }

  snapshot(view?: PluginGenerationView): CordisXExtensionPointControlSnapshotV1 {
    return this.resolve(view).snapshot
  }

  hasPoint(pointId: string): boolean {
    this.assertLive()
    return this.points.has(pointId)
  }

  setAuthorization(expectedRevision: number, authorization: CordisXExtensionPointControlAuthorizationV1): number {
    this.assertLive()
    const record = [...this.candidates.values()].find(candidate =>
      claimKey(candidate.declaration) === claimKey(authorization)
    )
    if (record === undefined || record.declaration.principalHandle !== authorization.principalHandle) {
      throw new Error('authorization does not match an exact control claim')
    }
    return this.policies.setAuthorization(expectedRevision, authorization)
  }

  legacyAuthorizations(): readonly CordisXExtensionPointControlAuthorizationV1[] {
    this.assertLive()
    return this.policies.legacyAuthorizations()
  }

  setGroupChoice(expectedRevision: number, choice: ControlledSurfaceGroupChoice): number {
    this.assertLive()
    const group = this.points.get(choice.pointId)?.exclusiveGroups.find(item => item.id === choice.groupId)
    if (group === undefined || group.selection !== 'user') throw new Error('control group is not user-selectable')
    if (choice.outcome === 'native' && !group.nativeFallback) throw new Error('control group has no native fallback')
    if (choice.outcome === 'selected') {
      const candidate = choice.selectedClaim === undefined
        ? undefined
        : [...this.candidates.values()].find(item => sameClaim(item.declaration, choice.selectedClaim!))
      if (candidate === undefined || !group.modes.includes(candidate.declaration.mode)) {
        throw new Error('control group choice does not match an exact candidate')
      }
    }
    return this.policies.setGroupChoice(expectedRevision, choice)
  }

  createLease(
    declaration: CordisXExtensionPointControlDeclarationV1,
    generation: ControlledSurfaceGeneration,
  ): CordisXExtensionPointControlLease & { dispose(): void } {
    this.assertLive()
    const key = claimKey(declaration)
    let active = true
    const listeners = new Set<() => void>()
    const revoked = (): CordisXExtensionPointControlLeaseSnapshot =>
      Object.freeze({
        revision: this.snapshotRevision,
        state: 'revoked',
        reason: 'lease.revoked',
        properties: Object.freeze({}),
        commands: Object.freeze([]),
        events: Object.freeze([]),
      })
    const currentSnapshot = (): CordisXExtensionPointControlLeaseSnapshot => {
      if (!active || !this.visibleGeneration(generation)) return revoked()
      const point = this.snapshot().points.find(item => item.id === declaration.identity.pointId)
      const candidate = point?.candidates.find(item => claimKey(item) === key)
      if (candidate === undefined) return revoked()
      const selected = candidate.state === 'selected' && candidate.authorization === 'allowed'
      const eventMap = selected ? this.lastEvents.get(key) : undefined
      return Object.freeze({
        revision: this.snapshotRevision,
        state: candidate.state,
        reason: candidate.reason,
        properties: selected
          ? immutableSnapshot(
            Object.fromEntries((candidate.bindings?.properties ?? []).map(item => [item.id, item.value])),
          )
          : Object.freeze({}),
        commands: selected ? candidate.bindings?.commands ?? Object.freeze([]) : Object.freeze([]),
        events: selected
          ? Object.freeze(
            [...(eventMap ?? [])].map(([id, event]) =>
              Object.freeze({ id, sequence: event.sequence, payload: event.payload })
            ),
          )
          : Object.freeze([]),
      })
    }
    const disconnect = this.subscribe(() => {
      for (const listener of listeners) {
        try {
          listener()
        } catch { /* A plugin observer cannot split Host publication. */ }
      }
    })
    return Object.freeze({
      snapshot: currentSnapshot,
      subscribe: (listener: () => void): () => void => {
        if (!active) throw new Error('controlled surface lease is revoked')
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      invoke: async (
        commandId: string,
        arguments_: Readonly<Record<string, CordisXJsonScalar>> = {},
      ): Promise<CordisXExtensionPointControlResultV1> => {
        const invocationId = typeof globalThis.crypto?.randomUUID === 'function'
          ? globalThis.crypto.randomUUID()
          : `control-${Date.now()}-${Math.random().toString(36).slice(2)}`
        return await this.invoke(generation, {
          $schema: CORDISX_EXTENSION_POINT_CONTROL_ACCESS_SCHEMA_V1,
          schemaVersion: 1,
          principalHandle: declaration.principalHandle,
          invocationId,
          hostGeneration: this.hostGeneration,
          operation: 'point.host-command.invoke',
          identity: declaration.identity,
          claimId: declaration.claimId,
          contributionId: declaration.contributionId,
          mode: declaration.mode,
          commandId,
          arguments: immutableSnapshot(arguments_),
        })
      },
      dispose: (): void => {
        if (!active) return
        active = false
        listeners.clear()
        disconnect()
      },
    })
  }

  managerSnapshot(): ControlledSurfaceManagerSnapshot {
    const snapshot = this.snapshot()
    return Object.freeze({
      revision: snapshot.revision,
      policyRevision: this.policies.revision(),
      hostGeneration: snapshot.hostGeneration,
      diagnostics: Object.freeze(
        [...this.candidates.values()]
          .filter(item => item.validationError !== undefined)
          .map(item =>
            Object.freeze({ contributionId: item.declaration.contributionId, message: item.validationError! })
          )
          .sort((left, right) => left.contributionId.localeCompare(right.contributionId)),
      ),
      points: Object.freeze(snapshot.points.map(point =>
        Object.freeze({
          id: point.id,
          state: point.state,
          reason: point.reason,
          selected: Object.freeze(point.candidates.filter(item => item.state === 'selected').map(claimReference)),
          eligibleCandidates: Object.freeze(
            point.candidates.filter(item => item.state === 'eligible').map(claimReference),
          ),
          deniedCandidates: Object.freeze(
            point.candidates.filter(item => item.authorization === 'denied').map(claimReference),
          ),
          groupDecisions: point.groupDecisions,
          groups: Object.freeze((this.points.get(point.id)?.exclusiveGroups ?? []).map(group => {
            const decision = point.groupDecisions.find(item => item.groupId === group.id)
            const policyChoice = group.selection === 'user' ? this.policies.choice(point.id, group.id) : undefined
            return Object.freeze({
              id: group.id,
              selection: group.selection,
              nativeFallback: group.nativeFallback,
              modes: group.modes,
              ...(policyChoice === undefined ? {} : { policyChoice }),
              ...(decision === undefined ? {} : { decision }),
            })
          })),
          ...(point.suppression === undefined ? {} : { suppression: point.suppression }),
          candidates: Object.freeze(point.candidates.map(item =>
            Object.freeze({
              principalHandle: item.principalHandle,
              identity: item.identity,
              claimId: item.claimId,
              contributionId: item.contributionId,
              mode: item.mode,
              ...(this.points.get(point.id)?.modes.find(mode => mode.id === item.mode)?.exclusiveGroup === undefined
                ? {}
                : {
                  exclusiveGroup: this.points.get(point.id)!.modes.find(mode => mode.id === item.mode)!.exclusiveGroup,
                }),
              priority: item.priority,
              authorization: item.authorization,
              policy: this.effectivePolicy(item),
              state: item.state,
              reason: item.reason,
            })
          )),
        })
      )),
    })
  }

  selectedPresenters(
    pointId: string,
  ): readonly { readonly declaration: CordisXExtensionPointControlDeclarationV1; readonly presenter: unknown }[] {
    const selected = this.resolve().selected
    return Object.freeze(
      [...selected.values()]
        .filter(item => item.record.declaration.identity.pointId === pointId)
        .map(item => Object.freeze({ declaration: item.record.declaration, presenter: item.record.presenter })),
    )
  }

  async invoke(
    caller: ControlledSurfaceGeneration,
    request: CordisXExtensionPointControlAccessV1,
  ): Promise<CordisXExtensionPointControlResultV1> {
    const reject = (why: string): CordisXExtensionPointControlResultV1 =>
      Object.freeze({
        $schema: CORDISX_EXTENSION_POINT_CONTROL_RESULT_SCHEMA_V1,
        schemaVersion: 1,
        authority: 'host',
        invocationId: request.invocationId,
        hostGeneration: this.hostGeneration,
        revision: this.snapshotRevision,
        outcome: 'rejected',
        reason: why,
      })
    if (
      request.$schema !== CORDISX_EXTENSION_POINT_CONTROL_ACCESS_SCHEMA_V1 || request.schemaVersion !== 1
      || request.hostGeneration !== this.hostGeneration || request.operation !== 'point.host-command.invoke'
    ) return reject('request.stale')
    if (
      caller.principalHandle !== request.principalHandle || caller.pluginId !== request.identity.pluginId
      || caller.source !== request.identity.source || !this.callableGeneration(caller)
    ) return reject('caller.stale')
    const resolution = this.resolve()
    const pointSnapshot = resolution.snapshot.points.find(item => item.id === request.identity.pointId)
    const candidateSnapshot = pointSnapshot?.candidates.find(item =>
      item.principalHandle === request.principalHandle
      && sameClaim(item, request) && item.contributionId === request.contributionId
    )
    if (candidateSnapshot?.authorization === 'denied') return reject('authorization.denied')
    if (pointSnapshot !== undefined && pointSnapshot.state !== 'active') return reject(pointSnapshot.reason)
    const resolved = resolution.selected.get(claimKey(request))
    if (resolved === undefined || resolved.record.declaration.contributionId !== request.contributionId) {
      return reject('claim.not-selected')
    }
    if (!sameGeneration(resolved.record.generation, caller)) return reject('generation.stale')
    const point = this.points.get(request.identity.pointId)
    const command = point?.safeCommands.find(item => item.id === request.commandId)
    const projected = resolved.snapshot.bindings?.commands.find(item => item.id === request.commandId)
    if (command === undefined) return reject('command.unavailable')
    if (projected?.available !== true) return reject(projected?.reason ?? 'command.unavailable')
    if (!this.validFields(command.arguments, request.arguments)) return reject('arguments.invalid')
    try {
      await this.bindings[point!.id]!.dispatch(
        request.commandId,
        immutableSnapshot(request.arguments),
        Object.freeze({
          caller,
          declaration: resolved.record.declaration,
          generation: resolved.record.generation,
        }),
      )
      return Object.freeze({
        ...reject('command.accepted'),
        outcome: 'accepted',
        reason: 'command.accepted',
        revision: this.snapshotRevision,
      })
    } catch (error) {
      return reject(error instanceof ControlledSurfaceCommandError ? error.reason : 'command.failed')
    }
  }

  publishEvent(
    pointId: string,
    eventId: string,
    payload: Readonly<Record<string, CordisXJsonScalar>>,
  ): readonly CordisXExtensionPointControlEventV1[] {
    const point = this.points.get(pointId)
    const event = point?.safeEvents.find(item => item.id === eventId)
    if (point === undefined || event === undefined || !this.validFields(event.payload, payload)) {
      return Object.freeze([])
    }
    const sequence = ++this.eventSequence
    const published = Object.freeze([...this.resolve().selected.values()].flatMap(({ record, snapshot }) => {
      if (
        record.declaration.identity.pointId !== pointId
        || !record.declaration.requestedBindings.events.includes(eventId)
        || snapshot.bindings?.events.find(item => item.id === eventId)?.available !== true
      ) return []
      const projectedPayload = immutableSnapshot(payload)
      const events = this.lastEvents.get(claimKey(record.declaration)) ?? new Map()
      events.set(eventId, Object.freeze({ sequence, payload: projectedPayload }))
      this.lastEvents.set(claimKey(record.declaration), events)
      return [Object.freeze({
        $schema: CORDISX_EXTENSION_POINT_CONTROL_EVENT_SCHEMA_V1,
        schemaVersion: 1,
        authority: 'host' as const,
        principalHandle: record.declaration.principalHandle,
        hostGeneration: this.hostGeneration,
        sequence,
        identity: record.declaration.identity,
        claimId: record.declaration.claimId,
        contributionId: record.declaration.contributionId,
        mode: record.declaration.mode,
        eventId,
        payload: projectedPayload,
      })]
    }))
    if (published.length > 0) {
      for (const listener of this.listeners) {
        try {
          listener()
        } catch { /* One event observer cannot split Host delivery. */ }
      }
    }
    return published
  }

  invalidate(): void {
    this.assertLive()
    this.lastEvents.clear()
    this.snapshotRevision += 1
    for (const listener of this.listeners) {
      try {
        listener()
      } catch { /* One observer cannot split one Host revision. */ }
    }
  }

  subscribe(listener: () => void): () => void {
    this.assertLive()
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disconnectPolicy()
    this.candidates.clear()
    this.lastEvents.clear()
    this.listeners.clear()
  }

  private resolve(view?: PluginGenerationView): Resolution {
    this.assertLive()
    const pointSnapshots = new Map<string, CordisXExtensionPointControlPointSnapshotV1>()
    const selected = new Map<string, ResolvedCandidate>()
    const points = [...this.points.values()].sort((left, right) => {
      const depth = (point: CordisXHostExtensionPointControlPointV1): number => {
        let result = 0
        let parent = point.parentPointId
        while (parent !== undefined) {
          result += 1
          parent = this.points.get(parent)?.parentPointId
        }
        return result
      }
      return depth(left) - depth(right) || left.id.localeCompare(right.id)
    })
    for (const point of points) {
      const binding = this.bindings[point.id]!
      let current: ReturnType<ControlledSurfacePointBinding['currentState']>
      try {
        current = immutableSnapshot(binding.currentState())
      } catch {
        current = { state: 'pending', reason: 'binding.failed' }
      }
      const visibleRecords = [...this.candidates.values()]
        .filter(item =>
          item.declaration.identity.pointId === point.id && item.validationError === undefined
          && this.visibleGeneration(item.generation, view)
        )
        .sort((left, right) =>
          right.declaration.priority - left.declaration.priority
          || canonicalClaimKey(left.declaration).localeCompare(canonicalClaimKey(right.declaration))
          || left.sequence - right.sequence
        )
      const seenClaims = new Set<string>()
      const records = visibleRecords.filter((record) => {
        const key = canonicalClaimKey(record.declaration)
        if (seenClaims.has(key)) return false
        seenClaims.add(key)
        return true
      })
      const suppressor = [...selected.values()].find(item => {
        const ancestor = this.points.get(item.record.declaration.identity.pointId)
        return ancestor?.ownership.scope === 'subtree'
          && ancestor.ownership.suppressesDescendantsWhenModes.includes(item.record.declaration.mode)
          && pathToAncestor(this.points, point.id, ancestor.id) !== undefined
      })
      if (suppressor !== undefined) {
        const ancestorId = suppressor.record.declaration.identity.pointId
        const path = pathToAncestor(this.points, point.id, ancestorId)!
        const candidates = records.map(record =>
          this.candidateSnapshot(record, 'suppressed', 'ancestor.ownership', undefined, undefined, 'suppressed')
        )
        pointSnapshots.set(
          point.id,
          Object.freeze({
            id: point.id,
            state: 'suppressed',
            reason: 'ancestor.ownership',
            candidates: Object.freeze(candidates),
            groupDecisions: Object.freeze([]),
            suppression: Object.freeze({
              kind: 'ancestor-ownership',
              ancestorPointId: ancestorId,
              ancestorClaim: claimReference(suppressor.record.declaration),
              path,
              hostGeneration: this.hostGeneration,
              reason: 'ancestor.ownership',
            }),
          }),
        )
        continue
      }

      const initial = new Map<
        string,
        {
          state: CordisXExtensionPointControlCandidateSnapshotV1['state']
          reason: string
          authorization: 'allowed' | 'denied'
          bindings?: CordisXExtensionPointControlBindingsProjectionV1
        }
      >()
      for (const record of records) {
        let hostAccess: Readonly<{ authorized: boolean; reason?: string; policy?: 'inherit' | 'allow' | 'deny' }>
        try {
          hostAccess = record.hostAccess?.() ?? { authorized: true }
        } catch {
          hostAccess = { authorized: false, reason: 'point-policy.failed' }
        }
        const authorization = !hostAccess.authorized
          ? 'denied' as const
          : 'allowed' as const
        if (authorization === 'denied') {
          initial.set(record.key, {
            state: 'denied',
            reason: hostAccess.authorized
              ? 'authorization.denied'
              : reason(hostAccess.reason ?? 'point-policy.denied', 'point-policy.denied'),
            authorization,
          })
        } else if (current.state !== 'active') {
          initial.set(record.key, { state: 'pending', reason: 'point.not-active', authorization })
        } else {
          const bindingsProjection = this.projectBindings(point, record)
          if (bindingsProjection === undefined) {
            initial.set(record.key, { state: 'pending', reason: 'binding.invalid', authorization })
          } else {initial.set(record.key, {
              state: 'eligible',
              reason: 'policy.eligible',
              authorization,
              bindings: bindingsProjection,
            })}
        }
      }

      const selectedRecords: CandidateRecord[] = []
      const decisions: CordisXExtensionPointControlPointSnapshotV1['groupDecisions'][number][] = []
      for (const group of point.exclusiveGroups) {
        const eligible = records.filter(record =>
          group.modes.includes(record.declaration.mode) && initial.get(record.key)?.state === 'eligible'
        )
        const choice = group.selection === 'user' ? this.policies.choice(point.id, group.id) : undefined
        const winner = group.selection === 'host-priority'
          ? eligible[0]
          : choice?.outcome === 'selected' && choice.selectedClaim !== undefined
          ? eligible.find(record => sameClaim(record.declaration, choice.selectedClaim!))
          : undefined
        if (winner !== undefined) {
          selectedRecords.push(winner)
          initial.set(winner.key, {
            ...initial.get(winner.key)!,
            state: 'selected',
            reason: group.selection === 'user' ? 'user.selected' : 'policy.priority',
          })
          decisions.push(Object.freeze({
            groupId: group.id,
            outcome: 'selected',
            selectedClaim: claimReference(winner.declaration),
            authority: group.selection === 'user' ? 'user' : 'host-policy',
            hostGeneration: this.hostGeneration,
            reason: group.selection === 'user' ? 'user.selected' : 'policy.priority',
          }))
        } else {
          const useNative = group.nativeFallback && choice?.outcome !== 'selected'
          decisions.push(Object.freeze({
            groupId: group.id,
            outcome: useNative ? 'native' : 'none',
            authority: group.selection === 'user' ? 'user' : 'host-policy',
            hostGeneration: this.hostGeneration,
            reason: useNative ? 'user.native' : eligible.length === 0 ? 'policy.no-candidate' : 'policy.no-selection',
          }))
        }
      }
      let orderedRank = 0
      for (
        const record of records.filter(item =>
          point.modes.find(mode => mode.id === item.declaration.mode)?.stacking === 'ordered'
          && initial.get(item.key)?.state === 'eligible'
        )
      ) {
        const compatible = selectedRecords.every(selectedRecord =>
          modeCompatible(point, record.declaration.mode, selectedRecord.declaration.mode)
        )
        initial.set(record.key, {
          ...initial.get(record.key)!,
          state: compatible ? 'selected' : 'conflicted',
          reason: compatible ? 'policy.ordered' : 'mode.conflict',
        })
        if (compatible) selectedRecords.push(record)
      }
      const candidates = records.map(record => {
        const state = initial.get(record.key)!
        const group = point.modes.find(item => item.id === record.declaration.mode)?.exclusiveGroup
        const stacking = point.modes.find(item => item.id === record.declaration.mode)?.stacking
        const selection = state.state !== 'selected' ? undefined : {
          authority: group === undefined
            ? 'host-policy' as const
            : point.exclusiveGroups.find(item => item.id === group)?.selection === 'user'
            ? 'user' as const
            : 'host-policy' as const,
          hostGeneration: this.hostGeneration,
          ...(group === undefined ? {} : { exclusiveGroup: group }),
          ...(stacking === 'ordered' ? { rank: orderedRank++ } : {}),
          reason: state.reason,
        }
        const snapshot = this.candidateSnapshot(
          record,
          state.state,
          state.reason,
          state.authorization,
          state.bindings,
          undefined,
          selection,
        )
        if (state.state === 'selected') selected.set(claimKey(record.declaration), { record, snapshot })
        return snapshot
      })
      pointSnapshots.set(
        point.id,
        Object.freeze({
          id: point.id,
          state: current.state,
          reason: reason(current.reason, current.state === 'active' ? 'point.mounted' : 'point.not-mounted'),
          candidates: Object.freeze(candidates),
          groupDecisions: Object.freeze(decisions),
        }),
      )
    }
    return {
      snapshot: Object.freeze({
        $schema: CORDISX_EXTENSION_POINT_CONTROL_SNAPSHOT_SCHEMA_V1,
        schemaVersion: 1,
        authority: 'host',
        hostGeneration: this.hostGeneration,
        revision: this.snapshotRevision,
        points: Object.freeze([...pointSnapshots.values()].sort((left, right) => left.id.localeCompare(right.id))),
      }),
      selected,
    }
  }

  private candidateSnapshot(
    record: CandidateRecord,
    state: CordisXExtensionPointControlCandidateSnapshotV1['state'],
    why: string,
    authorization: 'allowed' | 'denied' | undefined,
    bindings: CordisXExtensionPointControlBindingsProjectionV1 | undefined,
    forcedState?: 'suppressed',
    selection?: CordisXExtensionPointControlCandidateSnapshotV1['selection'],
  ): CordisXExtensionPointControlCandidateSnapshotV1 {
    const auth = authorization ?? this.effectiveAuthorization(record)
    return Object.freeze({
      principalHandle: record.declaration.principalHandle,
      origin: record.declaration.origin,
      identity: record.declaration.identity,
      claimId: record.declaration.claimId,
      contributionId: record.declaration.contributionId,
      mode: record.declaration.mode,
      priority: record.declaration.priority,
      authorization: auth,
      state: forcedState ?? state,
      reason: why,
      ...(selection === undefined ? {} : { selection: Object.freeze(selection) }),
      ...(bindings === undefined || state !== 'selected' ? {} : { bindings }),
    })
  }

  private effectiveAuthorization(record: CandidateRecord): 'allowed' | 'denied' {
    try {
      if (record.hostAccess?.().authorized === false) return 'denied'
    } catch {
      return 'denied'
    }
    return 'allowed'
  }

  private effectivePolicy(reference: CordisXExtensionPointControlClaimReferenceV1): 'inherit' | 'allow' | 'deny' {
    const record = [...this.candidates.values()].find(candidate => sameClaim(candidate.declaration, reference))
    try {
      return record?.hostAccess?.().policy ?? 'inherit'
    } catch {
      return 'inherit'
    }
  }

  private projectBindings(
    point: CordisXHostExtensionPointControlPointV1,
    record: CandidateRecord,
  ): CordisXExtensionPointControlBindingsProjectionV1 | undefined {
    const binding = this.bindings[point.id]!
    try {
      const properties = record.declaration.requestedBindings.properties.map(id => {
        const descriptor = point.safeProperties.find(item => item.id === id)
        const value = descriptor === undefined ? undefined : binding.readProperty(id)
        if (descriptor === undefined || !validSafeValue(descriptor.schema, value)) throw new Error('invalid property')
        return Object.freeze({ id, value })
      })
      const commands = record.declaration.requestedBindings.commands.map(id => {
        if (!point.safeCommands.some(item => item.id === id)) throw new Error('invalid command')
        const availability = binding.commandAvailability?.(id) ?? { available: true }
        return Object.freeze({
          id,
          available: availability.available,
          ...(availability.available || availability.reason === undefined
            ? {}
            : { reason: reason(availability.reason, 'command.unavailable') }),
        })
      })
      const events = record.declaration.requestedBindings.events.map(id => {
        if (!point.safeEvents.some(item => item.id === id)) throw new Error('invalid event')
        const availability = binding.eventAvailability?.(id) ?? { available: true }
        return Object.freeze({
          id,
          available: availability.available,
          ...(availability.available || availability.reason === undefined
            ? {}
            : { reason: reason(availability.reason, 'event.unavailable') }),
        })
      })
      return Object.freeze({
        properties: Object.freeze(properties),
        commands: Object.freeze(commands),
        events: Object.freeze(events),
      })
    } catch {
      return undefined
    }
  }

  private validatePoint(point: CordisXHostExtensionPointControlPointV1): void {
    unique(point.modes.map(item => item.id), `point ${point.id} modes`)
    unique(point.exclusiveGroups.map(item => item.id), `point ${point.id} groups`)
    unique(point.safeProperties.map(item => item.id), `point ${point.id} properties`)
    unique(point.safeCommands.map(item => item.id), `point ${point.id} commands`)
    unique(point.safeEvents.map(item => item.id), `point ${point.id} events`)
    const compose = point.modes.find(item => item.id === 'compose')
    if (compose?.stacking !== 'ordered' || compose.defaultAuthorization !== 'allow') {
      throw new Error(`point ${point.id} requires compatible compose mode`)
    }
    for (const mode of point.modes) {
      if (mode.id !== 'compose' && mode.defaultAuthorization !== 'deny') {
        throw new Error(`point ${point.id}/${mode.id} must default deny`)
      }
      if (mode.coexistsWith.some(peer => !point.modes.find(item => item.id === peer)?.coexistsWith.includes(mode.id))) {
        throw new Error(`point ${point.id}/${mode.id} coexistence is not reciprocal`)
      }
      const groups = point.exclusiveGroups.filter(group => group.modes.includes(mode.id))
      if (mode.stacking === 'exclusive' && (groups.length !== 1 || groups[0]!.id !== mode.exclusiveGroup)) {
        throw new Error(`point ${point.id}/${mode.id} lacks exact exclusive group`)
      }
      if (mode.stacking === 'ordered' && (mode.exclusiveGroup !== undefined || groups.length > 0)) {
        throw new Error(`point ${point.id}/${mode.id} ordered mode cannot join a group`)
      }
    }
    for (const group of point.exclusiveGroups) {
      unique(group.modes, `point ${point.id}/${group.id} modes`)
      if (group.modes.some(modeId => point.modes.find(mode => mode.id === modeId)?.stacking !== 'exclusive')) {
        throw new Error(`point ${point.id}/${group.id} references a non-exclusive mode`)
      }
    }
    for (let leftIndex = 0; leftIndex < point.exclusiveGroups.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < point.exclusiveGroups.length; rightIndex += 1) {
        for (const left of point.exclusiveGroups[leftIndex]!.modes) {
          for (const right of point.exclusiveGroups[rightIndex]!.modes) {
            if (!modeCompatible(point, left, right)) {
              throw new Error(`point ${point.id} exclusive groups cannot coexist`)
            }
          }
        }
      }
    }
    if (point.ownership.scope === 'point' && point.ownership.suppressesDescendantsWhenModes.length > 0) {
      throw new Error(`point ${point.id} cannot suppress descendants`)
    }
  }

  private validateDeclaration(
    declaration: CordisXExtensionPointControlDeclarationV1,
    generation: ControlledSurfaceGeneration,
  ): void {
    if (
      declaration.$schema !== CORDISX_EXTENSION_POINT_CONTROL_DECLARATION_SCHEMA_V1 || declaration.schemaVersion !== 1
    ) throw new Error('unsupported control declaration')
    if (
      declaration.principalHandle !== generation.principalHandle
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(declaration.principalHandle)
    ) throw new Error('control principal is invalid')
    if (declaration.identity.pluginId !== generation.pluginId || declaration.identity.source !== generation.source) {
      throw new Error('control declaration identity does not match its fiber')
    }
    const point = this.points.get(declaration.identity.pointId)
    if (point === undefined || !point.modes.some(item => item.id === declaration.mode)) {
      throw new Error('control declaration targets an unavailable point or mode')
    }
    if (!Number.isInteger(declaration.priority) || declaration.priority < -100000 || declaration.priority > 100000) {
      throw new Error('control priority is invalid')
    }
    assertLocalId(declaration.claimId, 'control claim id')
    assertLocalId(declaration.contributionId, 'control contribution id')
    for (const [kind, ids] of Object.entries(declaration.requestedBindings)) unique(ids, `control ${kind}`)
    if (
      declaration.origin === 'legacy-structured' && (declaration.mode !== 'compose'
        || declaration.requestedBindings.properties.length + declaration.requestedBindings.commands.length
              + declaration.requestedBindings.events.length > 0)
    ) {
      throw new Error('legacy contribution cannot gain control authority')
    }
    if (
      declaration.origin === 'legacy-structured' && (declaration.claimId !== declaration.contributionId
        || declaration.legacyOrder === undefined || declaration.priority !== -declaration.legacyOrder)
    ) throw new Error('legacy contribution normalization drift')
    if (declaration.origin === 'explicit' && declaration.legacyOrder !== undefined) {
      throw new Error('explicit contribution cannot carry legacy order')
    }
    if (
      declaration.requestedBindings.properties.some(id => !point.safeProperties.some(item => item.id === id))
      || declaration.requestedBindings.commands.some(id => !point.safeCommands.some(item => item.id === id))
      || declaration.requestedBindings.events.some(id => !point.safeEvents.some(item => item.id === id))
    ) throw new Error('control declaration requests an unknown binding')
  }

  private validFields(
    descriptors: readonly {
      readonly id: string
      readonly schema: CordisXExtensionPointControlSafeValueSchemaV1
      readonly required: boolean
    }[],
    value: Readonly<Record<string, CordisXJsonScalar>>,
  ): boolean {
    if (Object.keys(value).some(key => !descriptors.some(item => item.id === key))) return false
    return descriptors.every(descriptor => {
      const candidate = value[descriptor.id]
      return candidate === undefined ? !descriptor.required : validSafeValue(descriptor.schema, candidate)
    })
  }

  private visibleGeneration(generation: ControlledSurfaceGeneration, view?: PluginGenerationView): boolean {
    try {
      return this.isGenerationVisible(generation, view)
    } catch {
      return false
    }
  }

  private callableGeneration(generation: ControlledSurfaceGeneration): boolean {
    try {
      return this.isGenerationCallable(generation)
    } catch {
      return false
    }
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('controlled surface coordinator is disposed')
  }
}
