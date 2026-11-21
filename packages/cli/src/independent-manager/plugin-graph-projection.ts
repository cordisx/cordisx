import { randomBytes } from 'node:crypto'
import {
  MAX_PLUGIN_GENERATION_GRAPH_FILE_BYTES,
  type PluginGenerationArtifactServer,
  type PluginGenerationGraphLease,
} from '../launcher/plugin-generation-artifact-server.js'

const GRAPH_PREFIX = '/api/renderer/graphs/'
const ID = /^[a-f0-9]{64}$/u
/** Active generations and renderer tombstones share a bounded session budget. */
export const MAX_SESSION_PLUGIN_GRAPH_GENERATIONS = 256
const FILE =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,7}\.(?:js|mjs|css|avif|gif|jpeg|jpg|png|svg|webp|woff|woff2|wasm)$/u
const MEDIA_TYPES: Readonly<Record<string, string>> = Object.freeze({
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  avif: 'image/avif',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  wasm: 'application/wasm',
})
const PRIVATE_HEADERS = Object.freeze({
  'cache-control': 'private, no-store, max-age=0',
  // SVG and other files may also be opened as documents at this origin. Keep
  // them inert in that context; these headers do not widen the manager CSP.
  'content-security-policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
})

export interface ProjectedPluginGraph {
  readonly graphId: string
  readonly leaseId: string
  readonly pluginId: string
  readonly moduleGeneration: string
  readonly baseUrl: string
  readonly entryUrl: string
  readonly initialStyleUrls: readonly string[]
  readonly importSource: string
  readonly publishSource: string
  readonly retireSource: string
  /** Retires this session's projection, not the owner's shared artifact lease. */
  retire(): void
}

export interface ProjectedGraphResponse {
  readonly status: 200 | 404 | 405
  readonly headers: Readonly<Record<string, string>>
  readonly body?: Uint8Array
}

export interface SessionPluginGraphProjection {
  /** Only trusted owner code may project a lease it obtained from artifactServer. */
  project(lease: PluginGenerationGraphLease, isCurrent: () => boolean): ProjectedPluginGraph
  /** Called only after the HTTP request has been authenticated to this exact session. */
  resolve(request: { readonly method: string; readonly target: string; readonly signal?: AbortSignal }): Promise<
    ProjectedGraphResponse
  >
  retire(graphId: string): void
  close(): void
}

interface RecordEntry {
  readonly graph: ProjectedPluginGraph
  readonly lease: PluginGenerationGraphLease
  readonly isCurrent: () => boolean
  readonly controller: AbortController
}

function validOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return url.origin === value && url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== ''
      && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

function relativeFile(url: string, base: string, extension?: 'module' | 'style'): string | undefined {
  if (!url.startsWith(base)) return undefined
  const relative = url.slice(base.length)
  if (relative.length > 510 || !FILE.test(relative)) return undefined
  if (extension === 'module' && !/\.(?:js|mjs)$/u.test(relative)) return undefined
  if (extension === 'style' && !relative.endsWith('.css')) return undefined
  return relative
}

function validLease(lease: PluginGenerationGraphLease, origin: string): boolean {
  if (!ID.test(lease.leaseId)) return false
  const prefix = `${origin}/cordisx-plugin-artifacts/`
  if (!lease.baseUrl.startsWith(prefix)) return false
  const suffix = lease.baseUrl.slice(prefix.length)
  const segments = suffix.split('/')
  if (
    segments.length !== 3 || segments[2] !== '' || !ID.test(segments[0] ?? '') || segments[1] !== lease.leaseId
  ) return false
  if (relativeFile(lease.entryUrl, lease.baseUrl, 'module') === undefined) return false
  if (lease.initialStyleUrls.some(url => relativeFile(url, lease.baseUrl, 'style') === undefined)) return false
  // The lease's generated expression must actually reference the validated
  // URLs. Replacing the shared base preserves the existing registry and ESM.
  if (!lease.importSource.includes(JSON.stringify(lease.baseUrl))) return false
  if (!lease.importSource.includes(JSON.stringify(lease.entryUrl))) return false
  if (lease.initialStyleUrls.some(url => !lease.importSource.includes(JSON.stringify(url)))) return false
  return true
}

const missing = (): ProjectedGraphResponse => ({ status: 404, headers: PRIVATE_HEADERS })

/**
 * A projection belongs to exactly one authenticated renderer session. The
 * owner must bind its HTTP request to that session before invoking resolve();
 * neither the graph URL nor a shared browser cookie is session authentication.
 *
 * Only trusted owner code can call project(), with leases issued by the given
 * artifact server. isCurrent is an authoritative, synchronous owner/session
 * and lease lifecycle check. The owner must also call retire/close as part of
 * its lifecycle fence, including before retiring the underlying shared lease.
 */
export function createSessionPluginGraphProjection(input: {
  readonly managerOrigin: string
  readonly artifactServer: Pick<PluginGenerationArtifactServer, 'origin'>
  readonly fetch?: typeof fetch
}): SessionPluginGraphProjection {
  const origin = input.artifactServer.origin
  if (!validOrigin(input.managerOrigin) || !validOrigin(origin)) throw new Error('plugin-graph-origin-invalid')
  const fetchArtifact = input.fetch ?? fetch
  const entries = new Map<string, RecordEntry>()
  const byLease = new Map<PluginGenerationGraphLease, RecordEntry>()
  const byLeaseId = new Map<string, RecordEntry>()
  const retiredLeaseIds = new Set<string>()
  let closed = false

  const current = (entry: RecordEntry): boolean => {
    if (closed || entries.get(entry.graph.graphId) !== entry || entry.controller.signal.aborted) return false
    try {
      if (entry.isCurrent() === true) return true
    } catch {
      // An unavailable authority is not proof that the lease is still live.
    }
    retire(entry.graph.graphId)
    return false
  }

  const retire = (graphId: string): void => {
    const entry = entries.get(graphId)
    if (entry === undefined) return
    entries.delete(graphId)
    byLease.delete(entry.lease)
    byLeaseId.delete(entry.lease.leaseId)
    // The renderer registry leaves a tombstone for retired generation IDs.
    // A later activation must use a new generation lease and graph URL.
    retiredLeaseIds.add(entry.lease.leaseId)
    entry.controller.abort()
  }

  return {
    project(lease, isCurrent) {
      if (closed) throw new Error('plugin-graph-session-closed')
      if (typeof isCurrent !== 'function' || !validLease(lease, origin)) {
        throw new Error('plugin-graph-lease-invalid')
      }
      const existing = byLease.get(lease)
      if (existing !== undefined) {
        if (!current(existing)) throw new Error('plugin-graph-lease-stale')
        return existing.graph
      }
      if (retiredLeaseIds.has(lease.leaseId)) throw new Error('plugin-graph-lease-stale')
      if (byLeaseId.has(lease.leaseId)) throw new Error('plugin-graph-lease-conflict')
      if (entries.size + retiredLeaseIds.size >= MAX_SESSION_PLUGIN_GRAPH_GENERATIONS) {
        throw new Error('plugin-graph-session-limit')
      }
      let live = false
      try {
        live = isCurrent() === true
      } catch {
        // An unavailable authority cannot grant a lease.
      }
      if (!live) throw new Error('plugin-graph-lease-stale')
      let graphId: string
      do graphId = randomBytes(32).toString('hex')
      while (entries.has(graphId))
      const baseUrl = `${input.managerOrigin}${GRAPH_PREFIX}${graphId}/`
      const graph: ProjectedPluginGraph = Object.freeze({
        graphId,
        leaseId: lease.leaseId,
        pluginId: lease.pluginId,
        moduleGeneration: lease.moduleGeneration,
        baseUrl,
        entryUrl: baseUrl + lease.entryUrl.slice(lease.baseUrl.length),
        initialStyleUrls: Object.freeze(lease.initialStyleUrls.map(url => baseUrl + url.slice(lease.baseUrl.length))),
        importSource: lease.importSource.replaceAll(lease.baseUrl, baseUrl),
        publishSource: lease.publishSource,
        retireSource: lease.retireSource,
        retire: () => retire(graphId),
      })
      const entry = { graph, lease, isCurrent, controller: new AbortController() }
      entries.set(graphId, entry)
      byLease.set(lease, entry)
      byLeaseId.set(lease.leaseId, entry)
      return graph
    },
    async resolve(request) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return { status: 405, headers: PRIVATE_HEADERS }
      // Inspect the raw target, before URL parsing could normalize '..' or an
      // encoded separator. A browser-normalized escape still loses its graph ID.
      if (!request.target.startsWith(GRAPH_PREFIX) || request.target.length > GRAPH_PREFIX.length + 64 + 1 + 510) {
        return missing()
      }
      const rest = request.target.slice(GRAPH_PREFIX.length)
      const graphId = rest.slice(0, 64)
      const relative = rest.slice(65)
      if (!ID.test(graphId) || rest[64] !== '/' || !FILE.test(relative)) return missing()
      const entry = entries.get(graphId)
      if (entry === undefined || !current(entry) || request.signal?.aborted === true) return missing()
      const media = MEDIA_TYPES[relative.slice(relative.lastIndexOf('.') + 1)]
      if (media === undefined) return missing()
      const signal = request.signal === undefined
        ? entry.controller.signal
        : AbortSignal.any([entry.controller.signal, request.signal])
      let response: Response | undefined
      try {
        response = await fetchArtifact(entry.lease.baseUrl + relative, {
          method: request.method,
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal,
        })
        if (!current(entry) || signal.aborted || response.status !== 200 || response.redirected) return missing()
        if (response.headers.get('content-type') !== media) return missing()
        const rawLength = response.headers.get('content-length')
        if (rawLength === null || !/^(?:0|[1-9][0-9]*)$/u.test(rawLength)) return missing()
        const length = Number(rawLength)
        if (!Number.isSafeInteger(length) || length > MAX_PLUGIN_GENERATION_GRAPH_FILE_BYTES) return missing()
        const headers = Object.freeze({ ...PRIVATE_HEADERS, 'content-type': media, 'content-length': rawLength })
        if (request.method === 'HEAD') return current(entry) && !signal.aborted ? { status: 200, headers } : missing()
        if (response.body === null) return missing()
        const reader = response.body.getReader()
        const cancelReader = () => void reader.cancel().catch(() => undefined)
        signal.addEventListener('abort', cancelReader, { once: true })
        if (signal.aborted) cancelReader()
        const chunks: Uint8Array[] = []
        let total = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (!current(entry) || signal.aborted) return missing()
            if (done) break
            total += value.byteLength
            if (total > length || total > MAX_PLUGIN_GENERATION_GRAPH_FILE_BYTES) return missing()
            chunks.push(value)
          }
        } finally {
          signal.removeEventListener('abort', cancelReader)
          cancelReader()
        }
        if (total !== length || !current(entry) || signal.aborted) return missing()
        const body = new Uint8Array(total)
        let position = 0
        for (const chunk of chunks) {
          body.set(chunk, position)
          position += chunk.byteLength
        }
        return current(entry) && !signal.aborted ? { status: 200, headers, body } : missing()
      } catch {
        // Do not leak upstream URLs, lease secrets, or transport errors.
        return missing()
      } finally {
        // Rejecting at headers must not leave a response stream consuming the
        // connection; a locked stream is already canceled via cancelReader.
        if (response?.body !== null && response?.body !== undefined && !response.body.locked) {
          void response.body.cancel().catch(() => undefined)
        }
      }
    },
    retire,
    close() {
      if (closed) return
      closed = true
      for (const graphId of [...entries.keys()]) retire(graphId)
    },
  }
}
