import type { CordisXPluginIdentity } from '../platform-contracts.js'
import {
  type CordisXPersistedPermissionPolicyRecord,
  normalizePersistedPermissionPolicyRecord,
} from '../permission-persistence.js'
import {
  MAX_PERMISSION_REQUEST_BYTES,
  parsePermissionBindingRequest,
  type PermissionBindingRequest,
  persistPermissionPoliciesIfUnchanged,
} from '../launcher/permission-rpc.js'
import { STANDALONE_PERMISSION_BINDING_MARKER } from '../standalone-permission-contract.js'
import type { ManagerRendererChannel, ManagerRendererChannelContext } from './manager-renderer-sessions.js'

/**
 * An owner-held barrier must cover every live policy consumer and writer for
 * the profile, including native clients and new admissions. It may report
 * success only after all other consumers have installed the exact readback or
 * have been fenced and the originating renderer can safely receive its reply.
 */
export interface ManagerPermissionPolicyBarrier {
  isCurrent(): boolean | Promise<boolean>
  /** Run the exact policy publication while retaining the owner's profile fence. */
  run<T>(action: () => Promise<T>): Promise<T>
  complete(policies: readonly CordisXPersistedPermissionPolicyRecord[]): boolean | Promise<boolean>
  /** Fence all possibly stale consumers if publication or commit is uncertain. */
  fence(): void | Promise<void>
}

/** These methods are Host-owned capabilities; none may be derived from page input. */
export interface ManagerPermissionPolicyAuthority {
  isAdmitted(context: ManagerRendererChannelContext): boolean | Promise<boolean>
  /** Exact snapshot originally delivered to this renderer, held by the owner. */
  snapshot(context: ManagerRendererChannelContext):
    | readonly CordisXPersistedPermissionPolicyRecord[]
    | undefined
  /**
   * Verify a single-use user action bound to this exact renderer, record batch,
   * and observed snapshot. The browser binding carries no such proof today;
   * an owner-held review/decision mechanism must supply it.
   */
  authorize(
    context: ManagerRendererChannelContext,
    request: PermissionBindingRequest,
    expected: readonly CordisXPersistedPermissionPolicyRecord[],
  ): boolean | Promise<boolean>
  /** Enter the shared barrier before comparing and writing. */
  acquire(
    context: ManagerRendererChannelContext,
    request: PermissionBindingRequest,
    expected: readonly CordisXPersistedPermissionPolicyRecord[],
  ):
    | ManagerPermissionPolicyBarrier
    | undefined
    | Promise<ManagerPermissionPolicyBarrier | undefined>
}

/**
 * Adapter for the existing BindingPermissionPolicyStore. It is deliberately
 * unavailable without a real owner authority; the public marker is only a wire
 * compatibility field and never supplies permission. The callback receives
 * the session-bound identity established by ManagerRendererSessions.
 *
 * A failed/ambiguous barrier permanently fences this channel instance: recovery
 * must construct a new authority from reconciled owner state.
 */
export function createManagerRendererPermissionChannel(input: {
  readonly profileId: string
  readonly configPath: string
  readonly identityAllowed: (identity: CordisXPluginIdentity, context: ManagerRendererChannelContext) => boolean
  readonly authority?: ManagerPermissionPolicyAuthority
  /** Owner-only identity mapping. Both directions must be supplied together. */
  readonly identityProjection?: {
    readonly resolve: (
      records: readonly CordisXPersistedPermissionPolicyRecord[],
      context: ManagerRendererChannelContext,
    ) => readonly CordisXPersistedPermissionPolicyRecord[]
    readonly project: (
      records: readonly CordisXPersistedPermissionPolicyRecord[],
      context: ManagerRendererChannelContext,
    ) => readonly CordisXPersistedPermissionPolicyRecord[]
  }
}): ManagerRendererChannel {
  let fenced = false
  const requests = new Set<string>()
  const parse = (item: unknown, context: ManagerRendererChannelContext) =>
    parsePermissionBindingRequest(item, {
      profileId: context.profileId,
      token: STANDALONE_PERMISSION_BINDING_MARKER,
      identities: [],
      identityAllowed: identity => input.identityAllowed(identity, context),
    })
  const normalize = (records: readonly CordisXPersistedPermissionPolicyRecord[]) =>
    Object.freeze(records.map(item => normalizePersistedPermissionPolicyRecord(item)))
  const resolve = (
    records: readonly CordisXPersistedPermissionPolicyRecord[],
    context: ManagerRendererChannelContext,
  ) => normalize(input.identityProjection ? input.identityProjection.resolve(records, context) : records)
  const project = (
    records: readonly CordisXPersistedPermissionPolicyRecord[],
    context: ManagerRendererChannelContext,
  ) => normalize(input.identityProjection ? input.identityProjection.project(records, context) : records)
  return {
    prepare(payload, context) {
      if (
        fenced || !input.authority || context.signal.aborted || context.profileId !== input.profileId
        || typeof payload !== 'string' || Buffer.byteLength(payload) > MAX_PERMISSION_REQUEST_BYTES
      ) throw new Error('MANAGER_PERMISSION_UNAVAILABLE')
      const parsedValue: unknown = JSON.parse(payload)
      const request = parse(parsedValue, context)
      const requested = normalize(request.records)
      const resolved = resolve(requested, context)
      if (
        resolved.length !== requested.length || JSON.stringify(project(resolved, context)) !== JSON.stringify(requested)
      ) throw new Error('MANAGER_PERMISSION_UNAVAILABLE')
      // Capture the owner's record of the renderer snapshot before waiting on
      // a writer. The user-action proof must cover browser transport too.
      const observed = input.authority.snapshot(context)
      if (!observed) throw new Error('MANAGER_PERMISSION_UNAVAILABLE')
      const expected = observed.map(item => normalizePersistedPermissionPolicyRecord(item))
      const requestKey = `${context.rendererId}\0${request.requestId}`
      if (requests.has(requestKey) || requests.size >= 4096) throw new Error('MANAGER_PERMISSION_UNAVAILABLE')
      // Mark before dispatch; a lost reply is never replayed as a new write.
      requests.add(requestKey)
      const authority = input.authority
      return {
        mode: 'write',
        dispatch: async () => {
          const assertAdmission = async () => {
            if (fenced || context.signal.aborted || !await authority.isAdmitted(context) || context.signal.aborted) {
              throw new Error('MANAGER_PERMISSION_UNAVAILABLE')
            }
          }
          await assertAdmission()
          const authorized = {
            requestId: request.requestId,
            records: resolved,
          }
          if (
            !await authority.authorize(
              context,
              authorized,
              expected.map(item => normalizePersistedPermissionPolicyRecord(item)),
            )
          ) throw new Error('MANAGER_PERMISSION_UNAVAILABLE')
          await assertAdmission()
          const barrier = await authority.acquire(
            context,
            authorized,
            expected.map(item => normalizePersistedPermissionPolicyRecord(item)),
          )
          if (!barrier) throw new Error('MANAGER_PERMISSION_UNAVAILABLE')
          try {
            await assertAdmission()
            if (!await barrier.isCurrent() || context.signal.aborted) throw new Error('MANAGER_PERMISSION_UNAVAILABLE')
            const result = await barrier.run(async () =>
              await persistPermissionPoliciesIfUnchanged({
                configPath: input.configPath,
                profileId: input.profileId,
                expected,
                assertCurrent: async () => {
                  await assertAdmission()
                  if (!await barrier.isCurrent() || context.signal.aborted) {
                    throw new Error('MANAGER_PERMISSION_UNAVAILABLE')
                  }
                  // Package identity can change while waiting for the config lock.
                  const current = parse(parsedValue, context)
                  if (JSON.stringify(resolve(current.records, context)) !== JSON.stringify(resolved)) {
                    throw new Error('MANAGER_PERMISSION_UNAVAILABLE')
                  }
                },
              }, resolved)
            )
            await assertAdmission()
            const responseRecords = project(result.records, context)
            if (JSON.stringify(responseRecords) !== JSON.stringify(requested)) {
              throw new Error('MANAGER_PERMISSION_UNAVAILABLE')
            }
            if (
              !await barrier.isCurrent()
              || !await barrier.complete(result.policies.map(item => normalizePersistedPermissionPolicyRecord(item)))
              || context.signal.aborted
            ) {
              throw new Error('MANAGER_PERMISSION_UNAVAILABLE')
            }
            return { requestId: request.requestId, ok: true, value: responseRecords }
          } catch (error) {
            fenced = true
            await Promise.resolve().then(() => barrier.fence()).catch(() => undefined)
            throw error
          }
        },
      }
    },
  }
}
