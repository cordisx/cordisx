import { type CordisXConfig, type CordisXConfigPlugin, loadConfig } from '../launcher/config.js'
import { loadPluginComposition } from '../launcher/plugin-composition.js'
import type { PluginActivationStore } from '../launcher/plugin-activation.js'
import type { PluginRuntimeMutation } from '../launcher/plugin-lifecycle-model.js'
import { attachmentEqual, type RendererAttachmentIdentity } from '../launcher/renderer-lifecycle-peer.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import type { ManagerRendererCommandPeer } from './manager-renderer-peer.js'
import type { ManagerRendererReadLifetimes } from './manager-renderer-read-lifetimes.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'
import type {
  ServiceRendererBootstrapEntry,
  ServiceRendererConfiguredChannelInput,
  ServiceRendererSnapshot,
} from './service-renderer-bootstrap-state.js'

type CohortItem = { readonly id: string; readonly entry: ServiceRendererBootstrapEntry }
type ChannelLease = Awaited<ReturnType<ServiceRendererConfiguredChannelInput['bridge']['suspendAll']>>
type Reservation = {
  readonly transactionId: string
  readonly previous: CordisXPluginActivationRecordV1
  readonly cohort: readonly CohortItem[]
  readonly current: () => boolean
  channel?: ChannelLease
  adopting: boolean
  adopted: boolean
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('renderer-lifecycle-handoff-unavailable')
  }
  return value as Record<string, unknown>
}

/** Profile-owner coordination for the existing Manager seats, never a browser capability. */
export class ServiceRendererLifecycleHandoff {
  private reservation: Reservation | undefined

  constructor(
    private readonly input: {
      readonly homeDir: string
      readonly configPath: string
      readonly profileId: string
      readonly store: PluginActivationStore
      readonly entries: Map<string, ServiceRendererBootstrapEntry>
      readonly participants: ServiceRendererParticipants
      readonly readLifetimes: ManagerRendererReadLifetimes
      readonly configuredChannel: () => ServiceRendererConfiguredChannelInput | undefined
      readonly snapshot: () => ServiceRendererSnapshot
      readonly policies: () => Promise<readonly CordisXPersistedPermissionPolicyRecord[]>
      readonly profileInputs: (snapshot: ServiceRendererSnapshot) => Promise<Map<string, string>>
      readonly current: (rendererId: string, entry: ServiceRendererBootstrapEntry) => boolean
    },
  ) {}

  private track<T>(entry: ServiceRendererBootstrapEntry, action: () => Promise<T>): Promise<T> {
    const operation = action()
    const settled = operation.then(() => true, () => false)
    entry.checks.add(settled)
    return operation.finally(() => entry.checks.delete(settled))
  }

  private async readInputs(snapshot: ServiceRendererSnapshot): Promise<{
    readonly config: CordisXConfig
    readonly plugins: readonly CordisXConfigPlugin[]
    readonly policies: readonly CordisXPersistedPermissionPolicyRecord[]
    readonly inputs: Map<string, string>
  }> {
    const [config, plugins, policies, inputs] = await Promise.all([
      loadConfig(this.input.configPath, { profileId: this.input.profileId, projectRoot: this.input.homeDir }),
      loadPluginComposition(this.input.store, snapshot.active),
      this.input.policies(),
      this.input.profileInputs(snapshot),
    ])
    return { config, plugins, policies, inputs }
  }

  async reserve(input: {
    readonly transactionId: string
    readonly previous: CordisXPluginActivationRecordV1
    readonly current: () => boolean
    readonly admitted: (peer: ManagerRendererCommandPeer) => boolean
  }): Promise<{
    isCurrent(): boolean
    adopt(snapshot: ServiceRendererSnapshot): Promise<boolean>
    release(): boolean
    cancel(): boolean
    fence(): void
  }> {
    if (this.reservation || !input.current()) throw new Error('renderer-lifecycle-handoff-unavailable')
    const snapshot = this.input.snapshot()
    if (!attachmentEqual(snapshot.active, input.previous)) throw new Error('renderer-lifecycle-handoff-unavailable')
    const peers = this.input.participants.ownerPeers()
    const cohort = peers.map(peer => {
      const id = peer.identity.rendererId
      const entry = this.input.entries.get(id)
      if (
        !entry || entry.peer !== peer || !entry.bootstrapConfirmed || entry.channelTransition
        || entry.lifecycleTransition || entry.pendingIdentity || !input.admitted(peer) || !this.input.current(id, entry)
        || entry.identity && !attachmentEqual(entry.snapshot, snapshot)
      ) throw new Error('renderer-lifecycle-handoff-unavailable')
      return { id, entry }
    })
    let reservation!: Reservation
    const current = () => {
      try {
        const ownerPeers = this.input.participants.ownerPeers()
        return this.reservation === reservation && input.current() && ownerPeers.length === cohort.length
          && cohort.every(({ id, entry }) => this.input.current(id, entry) && ownerPeers.includes(entry.peer))
      } catch {
        return false
      }
    }
    reservation = {
      transactionId: input.transactionId,
      previous: structuredClone(input.previous),
      cohort,
      current,
      adopting: false,
      adopted: false,
    }
    this.reservation = reservation
    for (const { entry } of cohort) entry.lifecycleTransition = { isCurrent: current }
    const fence = () => this.fence(reservation)
    try {
      const pending = cohort.flatMap(({ entry }) => [...entry.checks])
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const drained = await Promise.race([
          Promise.allSettled(pending).then(() => true),
          new Promise<boolean>(resolve => timer = setTimeout(() => resolve(false), 15_000)),
        ])
        if (!drained || !current()) throw new Error('renderer-lifecycle-handoff-unavailable')
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      const configured = this.input.configuredChannel()
      const configuredCount = cohort.filter(({ entry }) => entry.configuredChannel !== undefined).length
      if (configuredCount > 0) {
        if (!configured || configuredCount !== cohort.length) throw new Error('renderer-lifecycle-handoff-unavailable')
        reservation.channel = await configured.bridge.suspendAll(cohort.map(item => item.id))
      }
      const drained = await Promise.all(cohort.map(async item => await this.input.readLifetimes.drainCurrent(item.id)))
      if (drained.some(value => !value) || !current() || reservation.channel && !reservation.channel.isCurrent()) {
        throw new Error('renderer-lifecycle-handoff-unavailable')
      }
      return {
        isCurrent: current,
        adopt: async value => await this.adopt(reservation, value),
        release: () => this.release(reservation, true),
        cancel: () => this.release(reservation, false),
        fence,
      }
    } catch (error) {
      fence()
      throw error
    }
  }

  canProject(identity: RendererAttachmentIdentity): boolean {
    const reservation = this.reservation
    const item = reservation?.cohort.find(value => value.id === identity.rendererId)
    return !!reservation && reservation.current() && !!item?.entry.identity && !!item.entry.identityContext
      && this.input.participants.isLive(identity) && attachmentEqual(item.entry.peer.identity, identity)
  }

  async project(
    mutation: PluginRuntimeMutation,
    identity: RendererAttachmentIdentity,
    stage?: Record<string, unknown>,
  ): Promise<unknown> {
    const reservation = this.reservation
    const item = reservation?.cohort.find(value => value.id === identity.rendererId)
    if (
      !reservation || !item || !this.canProject(identity) || mutation.transactionId !== reservation.transactionId
      || !attachmentEqual(mutation.previous, reservation.previous)
    ) throw new Error('renderer-lifecycle-handoff-unavailable')
    const entry = item.entry
    const projection = entry.identity!
    const context = entry.identityContext!
    const preflight = mutation.transactionEpoch === mutation.transactionId + ':preflight'
    if (preflight) {
      if (stage !== undefined || entry.pendingIdentity || !entry.snapshot) {
        throw new Error('renderer-lifecycle-handoff-unavailable')
      }
      return await this.track(entry, async () => {
        const snapshot = entry.snapshot!
        const inputs = await this.readInputs(snapshot)
        if (
          !reservation.current() || !attachmentEqual(snapshot.active, mutation.previous)
          || !attachmentEqual(inputs.config, entry.config) || !attachmentEqual(inputs.plugins, entry.plugins)
          || !attachmentEqual(inputs.policies, entry.policies) || !attachmentEqual(inputs.inputs, entry.packageInputs)
        ) throw new Error('renderer-lifecycle-handoff-unavailable')
        const projected = await projection.prepareCandidate(context, mutation)
        try {
          if (!reservation.current()) throw new Error('renderer-lifecycle-handoff-unavailable')
          this.input.participants.offerIdentityCandidate(identity, {
            transactionId: mutation.transactionId,
            targetId: mutation.targetId,
            affectedPluginIds: mutation.affectedPluginIds,
            previous: mutation.previous,
            candidate: mutation.candidate,
            projectedCandidate: projected.candidate,
          })
          entry.pendingIdentity = {
            transactionId: mutation.transactionId,
            previous: structuredClone(mutation.previous),
            candidate: structuredClone(mutation.candidate),
            projectedPrevious: projected.previous,
            projectedCandidate: projected.candidate,
          }
        } catch (error) {
          this.input.participants.discardIdentityCandidate(identity, mutation.transactionId)
          projection.cancelCandidate(context, mutation.transactionId)
          throw error
        }
        return undefined
      })
    }
    const pending = entry.pendingIdentity
    if (
      !stage || !pending || pending.transactionId !== mutation.transactionId
      || !attachmentEqual(pending.previous, mutation.previous)
      || !attachmentEqual(pending.candidate, mutation.candidate)
      || !attachmentEqual(stage.previous, mutation.previous) || !attachmentEqual(stage.candidate, mutation.candidate)
    ) throw new Error('renderer-lifecycle-handoff-unavailable')
    const next = mutation.candidate.plugins.find(plugin => plugin.id === mutation.targetId)
    const alias = next
      ? projection.candidateAlias(context, mutation.transactionId, mutation.targetId)
      : projection.currentAlias(context, mutation.targetId)
    const original = projection.resolveLifecycle(context, alias, mutation.targetId)
    let pkg: Record<string, unknown> | undefined
    if (stage.package !== undefined) {
      const value = object(stage.package)
      const manifest = object(value.manifest)
      if (
        value.identitySource !== original.source || value.digest !== original.digest
        || manifest.canonicalSource !== undefined && manifest.canonicalSource !== original.source
      ) throw new Error('renderer-lifecycle-handoff-unavailable')
      pkg = {
        ...value,
        identitySource: alias,
        manifest: {
          ...manifest,
          ...(manifest.canonicalSource === undefined ? {} : { canonicalSource: alias }),
        },
      }
    }
    let authorizationDecision: Record<string, unknown> | undefined
    if (stage.authorizationDecision !== undefined) {
      const decision = object(stage.authorizationDecision)
      const owner = object(decision.identity)
      if (owner.pluginId !== mutation.targetId || owner.source !== original.source) {
        throw new Error('renderer-lifecycle-handoff-unavailable')
      }
      authorizationDecision = { ...decision, identity: { ...owner, source: alias } }
    }
    if (!reservation.current()) throw new Error('renderer-lifecycle-handoff-unavailable')
    return {
      ...stage,
      previous: pending.projectedPrevious,
      candidate: pending.projectedCandidate,
      ...(pkg === undefined ? {} : { package: pkg }),
      ...(authorizationDecision === undefined ? {} : { authorizationDecision }),
    }
  }

  private async adopt(reservation: Reservation, snapshot: ServiceRendererSnapshot): Promise<boolean> {
    if (!reservation.current() || reservation.adopting || reservation.adopted) return false
    reservation.adopting = true
    try {
      if (!attachmentEqual(this.input.snapshot(), snapshot)) return false
      await Promise.all(reservation.cohort.map(async ({ id, entry }) => {
        if (!entry.identity) return
        await this.track(entry, async () => {
          const pending = entry.pendingIdentity
          const context = entry.identityContext
          if (
            !pending || !context || pending.transactionId !== reservation.transactionId
            || !attachmentEqual(this.input.participants.confirmedIdentitySnapshot(entry.peer.identity), snapshot)
          ) throw new Error('renderer-lifecycle-handoff-unavailable')
          const inputs = await this.readInputs(snapshot)
          if (
            !reservation.current() || !attachmentEqual(this.input.snapshot(), snapshot)
            || !attachmentEqual(inputs.config, entry.config) || !attachmentEqual(inputs.policies, entry.policies)
            || !entry.packageInputs || [...inputs.inputs].some(([pluginId, digest]) =>
              entry.packageInputs!.has(pluginId) && entry.packageInputs!.get(pluginId) !== digest
            )
          ) {
            throw new Error('renderer-lifecycle-handoff-unavailable')
          }
          const { transactionId: _transactionId, ...candidate } = pending.candidate
          void _transactionId
          const committed = { ...candidate, recordKind: 'active', lastGoodRevision: candidate.revision }
          if (attachmentEqual(snapshot.active, committed)) {
            entry.identity!.commitCandidate(context, pending.transactionId, snapshot.active)
          } else {
            entry.identity!.cancelCandidate(context, pending.transactionId)
            if (!attachmentEqual(snapshot.active.plugins, pending.previous.plugins)) {
              throw new Error('renderer-lifecycle-handoff-unavailable')
            }
          }
          const aliases = new Map(snapshot.active.plugins.map(plugin => [
            plugin.id,
            entry.identity!.currentAlias(context, plugin.id),
          ]))
          entry.identity!.projectActivation(context, snapshot.active)
          entry.identityAliases = aliases
          entry.snapshot = structuredClone(snapshot)
          entry.plugins = inputs.plugins
          entry.packageInputs = inputs.inputs
          delete entry.pendingIdentity
          if (!reservation.current()) {
            throw new Error('renderer-lifecycle-handoff-unavailable')
          }
        })
        if (!this.input.current(id, entry)) throw new Error('renderer-lifecycle-handoff-unavailable')
      }))
      if (!reservation.current() || !attachmentEqual(this.input.snapshot(), snapshot)) return false
      reservation.adopted = true
      return true
    } catch {
      return false
    } finally {
      reservation.adopting = false
    }
  }

  private release(reservation: Reservation, adopted: boolean): boolean {
    if (
      this.reservation !== reservation || !reservation.current() || reservation.adopting
      || adopted !== reservation.adopted
    ) {
      this.fence(reservation)
      return false
    }
    try {
      if (!adopted) {
        for (const { entry } of reservation.cohort) {
          const pending = entry.pendingIdentity
          if (!pending) continue
          if (
            !entry.identity || !entry.identityContext
            || !this.input.participants.discardIdentityCandidate(entry.peer.identity, pending.transactionId)
          ) throw new Error('renderer-lifecycle-handoff-unavailable')
          entry.identity.cancelCandidate(entry.identityContext, pending.transactionId)
          delete entry.pendingIdentity
        }
      }
      if (reservation.channel && !reservation.channel.release()) {
        throw new Error('renderer-lifecycle-handoff-unavailable')
      }
      for (const { entry } of reservation.cohort) delete entry.lifecycleTransition
      this.reservation = undefined
      return true
    } catch {
      this.fence(reservation)
      return false
    }
  }

  private fence(reservation: Reservation): void {
    if (this.reservation !== reservation) return
    reservation.channel?.fence()
    for (const { entry } of reservation.cohort) {
      delete entry.lifecycleTransition
      entry.peer.close()
    }
    this.reservation = undefined
  }

  close(): void {
    if (this.reservation) this.fence(this.reservation)
  }
}
