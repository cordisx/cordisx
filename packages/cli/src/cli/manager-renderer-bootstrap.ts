import { setTimeout as delay } from 'node:timers/promises'
import { type ManagerRendererGraph, parseManagerRendererGraph } from '../independent-manager/graph-stage-loader.js'
import type { ManagerOwner } from './manager-owner.js'
import type { ManagerRendererInvocation } from './manager-renderer-sessions.js'
import { decodeManagerRendererBundle } from './manager-renderer-bundle-codec.js'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

class ManagerOwnerStatusTransportError extends Error {}

/** The graph projector is session-local and accepts descriptors from the authenticated owner only. */
export interface ManagerRendererBootstrapProjection {
  projectInitial(descriptors: readonly unknown[]): readonly ManagerRendererGraph[]
  close(): void
}

/** Private sidecar composition. Never pass the owner handle or upstream URLs to a browser. */
export function createManagerRendererBootstrap(input: {
  readonly owner: Pick<ManagerOwner, 'request'>
  readonly invocation: ManagerRendererInvocation
  readonly managerOrigin: string
  readonly projection: ManagerRendererBootstrapProjection
  readonly isCurrent: () => boolean | Promise<boolean>
  readonly signal: AbortSignal
  readonly forbiddenSecrets: readonly string[]
}) {
  const origin = new URL(input.managerOrigin)
  if (
    origin.origin !== input.managerOrigin || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1'
    || origin.port === ''
  ) throw new Error('MANAGER_BOOTSTRAP_UNAVAILABLE')
  let started = false
  const current = async () => !input.signal.aborted && await input.isCurrent() && !input.signal.aborted
  const call = async (payload: unknown, ownerStatus = false) => {
    if (!await current()) throw new Error('MANAGER_BOOTSTRAP_UNAVAILABLE')
    let response: unknown
    try {
      response = await input.owner.request({
        kind: 'manager-renderer',
        action: 'call',
        channel: 'manager-bootstrap',
        ...input.invocation,
        payload,
      }, { signal: input.signal, ...(ownerStatus ? { timeoutMs: 8_000 } : {}) })
    } catch (error) {
      if (ownerStatus && !input.signal.aborted) {
        throw new ManagerOwnerStatusTransportError('MANAGER_OWNER_STATUS_TRANSPORT', { cause: error })
      }
      throw error
    }
    const result = record(response)
    if (!await current() || result?.status !== 'ok') throw new Error('MANAGER_BOOTSTRAP_UNAVAILABLE')
    const value = record(result.value)
    if (value?.status !== 'ok') throw new Error('MANAGER_BOOTSTRAP_UNAVAILABLE')
    return value
  }
  return {
    async isSessionCurrent(): Promise<boolean> {
      const status = async () => {
        const value = await call({ action: 'status' }, true)
        return value.current === true && await current()
      }
      try {
        return await status()
      } catch (error) {
        // This is a read-only owner check, not an operation or lifecycle
        // command. Reconfirm the owner before retrying a lost transport.
        if (!(error instanceof ManagerOwnerStatusTransportError) || input.signal.aborted) return false
        try {
          if (!await current()) return false
          await delay(100, undefined, { signal: input.signal })
          return await status()
        } catch {
          return false
        }
      }
    },
    async prepare(
      permissionPublicKey?: unknown,
    ): Promise<{ readonly initialGraphs: readonly ManagerRendererGraph[]; readonly bundle: Buffer }> {
      if (started) throw new Error('MANAGER_BOOTSTRAP_UNAVAILABLE')
      started = true
      let bundle: Buffer | undefined
      try {
        const prepared = await call({ action: 'prepare' })
        if (
          !record(prepared.snapshot) || !Array.isArray(prepared.privateGraphs) || prepared.privateGraphs.length > 256
        ) {
          throw new Error('MANAGER_BOOTSTRAP_UNAVAILABLE')
        }
        const privateBases = prepared.privateGraphs.map(item => record(item)?.baseUrl)
        if (privateBases.some(base => typeof base !== 'string' || base.length < 1 || base.length > 2048)) {
          throw new Error('MANAGER_BOOTSTRAP_UNAVAILABLE')
        }
        const graphs = input.projection.projectInitial(prepared.privateGraphs)
          .map(graph => parseManagerRendererGraph(graph, input.managerOrigin))
        if (
          graphs.length !== prepared.privateGraphs.length || new Set(graphs.map(graph =>
              graph.leaseId
            )).size !== graphs.length
          || new Set(graphs.map(graph => graph.pluginId)).size !== graphs.length
        ) throw new Error('MANAGER_BOOTSTRAP_UNAVAILABLE')
        const completed = await call({
          action: 'complete',
          managerOrigin: input.managerOrigin,
          graphs,
          ...(permissionPublicKey === undefined ? {} : { permissionPublicKey }),
        })
        if (!Array.isArray(completed.initialGraphs) || completed.initialGraphs.length !== graphs.length) {
          throw new Error('MANAGER_BOOTSTRAP_UNAVAILABLE')
        }
        const initialGraphs = completed.initialGraphs.map(graph =>
          parseManagerRendererGraph(graph, input.managerOrigin)
        )
        if (JSON.stringify(initialGraphs) !== JSON.stringify(graphs)) throw new Error('MANAGER_BOOTSTRAP_UNAVAILABLE')
        bundle = await decodeManagerRendererBundle(completed.bundle)
        const privateValues = [...privateBases, ...input.forbiddenSecrets]
        if (
          privateValues.some(secret => typeof secret !== 'string' || secret.length < 1 || bundle!.includes(secret))
          || !await current()
        ) throw new Error('MANAGER_BOOTSTRAP_UNAVAILABLE')
        return { initialGraphs, bundle }
      } catch {
        bundle?.fill(0)
        input.projection.close()
        throw new Error('MANAGER_BOOTSTRAP_UNAVAILABLE')
      }
    },
  }
}
