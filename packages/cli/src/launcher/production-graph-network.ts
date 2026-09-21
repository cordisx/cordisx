const PRODUCTION_GRAPH_PATH_MARKER = '/cordisx-host-generation/'
const PRODUCTION_GRAPH_ORIGIN_PATTERN = /http:\/\/127\.0\.0\.1:\d+\/cordisx-host-generation\/[a-f0-9]{64}/u

export interface ProductionGraphNetworkFailure {
  readonly sequence: number
  readonly stage: 'manifest-fetch' | 'entry-import'
  readonly errorText: string
  readonly canceled: boolean
  readonly blockedReason?: string
  readonly corsErrorStatus?: string
  readonly httpStatus?: number
  readonly observedAt: number
}

interface ProductionGraphNetworkSession {
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  onEvent(method: string, listener: (params: Record<string, unknown>) => void): () => void
}

function productionGraphOrigin(source: string): string | undefined {
  return source.match(PRODUCTION_GRAPH_ORIGIN_PATTERN)?.[0]
}

function boundedDiagnostic(value: unknown, fallback: string, limit: number): string {
  const text = typeof value === 'string' ? value : fallback
  return text
    .replace(/[\r\n\u0000-\u001f\u007f]/gu, ' ')
    .replace(/https?:\/\/[^\s)]+/gu, '[url]')
    .trim()
    .slice(0, limit) || fallback
}

function productionGraphRequestStage(
  value: unknown,
  origin: string,
): ProductionGraphNetworkFailure['stage'] | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (!url.href.startsWith(`${origin}/`)) return undefined
    return url.pathname.endsWith('/manifest.json') ? 'manifest-fetch' : 'entry-import'
  } catch {
    return undefined
  }
}

/** Observe only the launch-private Host graph and retain bounded, path-free failure evidence. */
export async function observeProductionGraphNetwork(
  session: ProductionGraphNetworkSession,
  source: string,
): Promise<
  Readonly<{
    latest(): ProductionGraphNetworkFailure | undefined
    close(): Promise<void>
  }> | undefined
> {
  const origin = productionGraphOrigin(source)
  if (origin === undefined || !origin.includes(PRODUCTION_GRAPH_PATH_MARKER)) return undefined
  const requests = new Map<string, ProductionGraphNetworkFailure['stage']>()
  let failure: ProductionGraphNetworkFailure | undefined
  let sequence = 0
  try {
    await session.send('Network.enable')
  } catch {
    return undefined
  }
  const removeRequest = session.onEvent('Network.requestWillBeSent', params => {
    if (typeof params.requestId !== 'string') return
    const request = params.request as { readonly url?: unknown } | undefined
    const stage = productionGraphRequestStage(request?.url, origin)
    if (stage === undefined) return
    requests.set(params.requestId, stage)
    failure = undefined
  })
  const removeFinished = session.onEvent('Network.loadingFinished', params => {
    if (typeof params.requestId === 'string') requests.delete(params.requestId)
  })
  const removeResponse = session.onEvent('Network.responseReceived', params => {
    if (typeof params.requestId !== 'string') return
    const stage = requests.get(params.requestId)
    if (stage === undefined) return
    const response = params.response as { readonly status?: unknown } | undefined
    if (typeof response?.status !== 'number' || response.status < 400) return
    failure = {
      sequence: ++sequence,
      stage,
      errorText: `HTTP ${response.status}`,
      canceled: false,
      httpStatus: response.status,
      observedAt: Date.now(),
    }
  })
  const removeFailed = session.onEvent('Network.loadingFailed', params => {
    if (typeof params.requestId !== 'string') return
    const stage = requests.get(params.requestId)
    if (stage === undefined) return
    requests.delete(params.requestId)
    const cors = params.corsErrorStatus as { readonly corsError?: unknown } | undefined
    failure = {
      sequence: ++sequence,
      stage,
      errorText: boundedDiagnostic(params.errorText, 'unknown network error', 256),
      canceled: params.canceled === true,
      ...(typeof params.blockedReason === 'string'
        ? { blockedReason: boundedDiagnostic(params.blockedReason, 'unknown', 128) }
        : {}),
      ...(typeof cors?.corsError === 'string'
        ? { corsErrorStatus: boundedDiagnostic(cors.corsError, 'unknown', 128) }
        : {}),
      observedAt: Date.now(),
    }
  })
  let closed = false
  return {
    latest: () => failure,
    close: async () => {
      if (closed) return
      closed = true
      removeRequest()
      removeFinished()
      removeResponse()
      removeFailed()
      requests.clear()
      await session.send('Network.disable').catch(() => undefined)
    },
  }
}

export function productionGraphNetworkError(failure: ProductionGraphNetworkFailure): Error {
  const phase = failure.stage === 'manifest-fetch' ? 'manifest fetch' : 'entry import'
  if (failure.canceled) {
    return new Error(`CordisX Host ${phase} was canceled by the renderer document lifecycle (${failure.errorText})`)
  }
  if (failure.httpStatus !== undefined) return new Error(`CordisX Host ${phase} returned HTTP ${failure.httpStatus}`)
  if (failure.blockedReason !== undefined || failure.corsErrorStatus !== undefined) {
    const reason = [failure.blockedReason, failure.corsErrorStatus].filter(value => value !== undefined).join('; ')
    return new Error(`CordisX Host ${phase} was blocked by browser policy (${reason}; ${failure.errorText})`)
  }
  return new Error(`CordisX Host ${phase} could not reach the loopback server (${failure.errorText})`)
}
