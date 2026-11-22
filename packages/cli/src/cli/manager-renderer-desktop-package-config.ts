import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import { parseRendererConfigOperation } from '../launcher/renderer-config-management.js'
import type { DesktopOwnerRendererLifecycle } from './desktop-owner-renderer-lifecycle.js'
import { DesktopPackageConfigWrite, type DesktopPackageConfigWriteGate } from './desktop-package-config-write.js'
import { fenceManagerOrigin } from './manager-origin-fence.js'
import type { ManagerRendererChannel, ManagerRendererSessions } from './manager-renderer-sessions.js'
import type { ServiceRendererBootstrap } from './service-renderer-bootstrap.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'

const TOKEN = 'renderer-binding-placeholder'

/** One authenticated Manager can ask its Desktop owner to apply one proven package edit. */
export function createManagerRendererDesktopPackageConfig(input: {
  readonly profileId: string
  readonly generation: string
  readonly lifecycle: DesktopOwnerRendererLifecycle
  readonly participants: ServiceRendererParticipants
  readonly bootstrap: ServiceRendererBootstrap
  readonly writes: DesktopPackageConfigWriteGate
  readonly sessions: () => ManagerRendererSessions
}): ManagerRendererChannel {
  const seen = new WeakMap<AbortSignal, Set<string>>()
  return {
    prepare(payload, context) {
      if (
        typeof payload !== 'string' || Buffer.byteLength(payload) > 200 * 1024 || context.admitted !== true
        || context.signal.aborted || context.profileId !== input.profileId
        || context.ownerGeneration !== input.generation
      ) throw new Error('DESKTOP_PACKAGE_CONFIG_UNAVAILABLE')
      const value: unknown = JSON.parse(payload)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DESKTOP_PACKAGE_CONFIG_INVALID')
      const item = value as Record<string, unknown>
      if (
        Object.keys(item).length !== 4
        || Object.keys(item).some(key => !['version', 'token', 'requestId', 'operation'].includes(key))
        || item.version !== 1 || item.token !== TOKEN || typeof item.requestId !== 'string'
        || !/^[A-Za-z0-9._:-]{1,160}$/u.test(item.requestId)
      ) throw new Error('DESKTOP_PACKAGE_CONFIG_INVALID')
      const operation = parseRendererConfigOperation(item.operation, input.profileId)
      if (operation.action !== 'update') throw new Error('DESKTOP_PACKAGE_CONFIG_INVALID')
      const requestId = item.requestId
      return {
        mode: 'write',
        dispatch: async () => {
          const requests = seen.get(context.signal) ?? new Set<string>()
          if (context.signal.aborted || requests.has(requestId) || requests.size >= 4096) {
            throw new Error('DESKTOP_PACKAGE_CONFIG_UNAVAILABLE')
          }
          requests.add(requestId)
          seen.set(context.signal, requests)
          let origin: Awaited<ReturnType<typeof fenceManagerOrigin>>
          try {
            origin = await fenceManagerOrigin({
              sessions: input.sessions(),
              participants: input.participants,
              lifecycle: input.lifecycle,
            })
          } catch {
            return { requestId, ok: true, value: { status: 'rejected', reason: 'busy' } }
          }
          let handoff: Awaited<ReturnType<ServiceRendererBootstrap['reservePackageConfig']>> | undefined
          let reservation: ReturnType<DesktopPackageConfigWriteGate['begin']> | undefined
          let dispatched = false
          try {
            handoff = await input.bootstrap.reservePackageConfig(origin, operation.pluginId)
            const native = origin.desktopConfiguration
            const proof = await native?.proof(operation.pluginId)
            if (!native || !proof || !handoff.isCurrent()) throw new Error('DESKTOP_PACKAGE_CONFIG_UNAVAILABLE')
            const write = new DesktopPackageConfigWrite({
              snapshot: handoff.snapshot,
              plugin: handoff.plugin,
              proof,
              operation,
              profileId: input.profileId,
              rendererGeneration: input.generation,
              seat: native.seat,
              current: () => handoff!.isCurrent() && reservation?.isCurrent() === true,
              run: async action => await handoff!.run(action),
            })
            reservation = input.writes.begin(write)
            dispatched = true
            const result = await native.update(operation)
            const applied = result.status === 'ok' && 'configuration' in result && write.outcome() === 'committed'
              && result.configuration.revision === operation.expectedRevision + 1
              && attachmentEqual(result.configuration.value, write.expectedValue())
            const rejected = result.status === 'rejected' && write.unchanged()
            if (!applied && !rejected) throw new Error('DESKTOP_PACKAGE_CONFIG_RESULT_UNKNOWN')
            const expected = applied ? write.expectedValue() : handoff.plugin.config
            const after = await native.proof(operation.pluginId)
            if (
              !await handoff.adopt(expected, after, applied) || !native.confirm()
              || applied && !await handoff.confirmRenderer(requestId, operation.expectedRevision, expected)
              || !handoff.cancel() || !origin.release()
            ) throw new Error('DESKTOP_PACKAGE_CONFIG_RESULT_UNKNOWN')
            reservation.release()
            return {
              requestId,
              ok: true,
              value: applied
                ? { status: 'applied', revision: operation.expectedRevision + 1 }
                : { status: 'rejected', reason: 'unavailable' },
            }
          } catch {
            reservation?.release()
            if (!dispatched && handoff?.cancel() !== false && origin.release()) {
              return { requestId, ok: true, value: { status: 'rejected', reason: 'unavailable' } }
            }
            handoff?.fence()
            origin.fence()
            throw new Error('DESKTOP_PACKAGE_CONFIG_RESULT_UNKNOWN')
          }
        },
      }
    },
  }
}
