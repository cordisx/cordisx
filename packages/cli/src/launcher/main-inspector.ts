export type MainInspectorFailureReason =
  | 'connection-refused'
  | 'fetch-failed'
  | 'helper-exited'
  | 'host-exited'
  | 'http-error'
  | 'invalid-json'
  | 'missing-websocket-url'
  | 'response-shape-mismatch'
  | 'websocket-url-mismatch'

export type MainInspectorHostStatus = 'alive' | 'dead' | 'unknown'

export class MainInspectorUnavailableError extends Error {
  constructor(
    readonly reason: MainInspectorFailureReason,
    readonly port: number,
    readonly hostPid: number,
    readonly hostStatus: MainInspectorHostStatus,
    readonly httpStatus?: number,
  ) {
    super([
      'Owned Host main inspector did not publish its endpoint',
      `reason=${reason}`,
      `port=${port}`,
      `hostPid=${hostPid}`,
      `hostStatus=${hostStatus}`,
      ...(httpStatus === undefined ? [] : [`httpStatus=${httpStatus}`]),
    ].join(' '))
    this.name = 'MainInspectorUnavailableError'
  }
}

interface MainInspectorObservation {
  readonly reason: MainInspectorFailureReason
  readonly httpStatus?: number
}

export interface MainInspectorWaitOptions {
  readonly port: number
  readonly hostPid: number
  readonly hostStatus: () => MainInspectorHostStatus
  readonly helperExited: () => boolean
  readonly timeoutMs?: number
  readonly pollIntervalMs?: number
  readonly fetch?: typeof fetch
}

function networkErrorCode(error: unknown, depth = 0): string | undefined {
  if (depth >= 4) return undefined
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const code = networkErrorCode(nested, depth + 1)
      if (code !== undefined) return code
    }
  }
  if (!(error instanceof Error)) return undefined
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' ? code : networkErrorCode(error.cause, depth + 1)
}

async function inspectEndpoint(
  port: number,
  fetchEndpoint: typeof fetch,
  timeoutMs: number,
): Promise<string | MainInspectorObservation> {
  let response: Response
  try {
    response = await fetchEndpoint(
      `http://127.0.0.1:${port}/json/list`,
      { signal: AbortSignal.timeout(Math.max(1, timeoutMs)) },
    )
  } catch (error) {
    return { reason: networkErrorCode(error) === 'ECONNREFUSED' ? 'connection-refused' : 'fetch-failed' }
  }
  if (!response.ok) return { reason: 'http-error', httpStatus: response.status }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { reason: 'invalid-json' }
  }
  if (!Array.isArray(payload)) return { reason: 'response-shape-mismatch' }
  if (payload.some(target => typeof target !== 'object' || target === null || Array.isArray(target))) {
    return { reason: 'response-shape-mismatch' }
  }

  const urls = payload.flatMap(target => {
    if (!('webSocketDebuggerUrl' in target)) return []
    const url = target.webSocketDebuggerUrl
    return typeof url === 'string' ? [url] : []
  })
  if (urls.length === 0) return { reason: 'missing-websocket-url' }
  const expected = new RegExp(`^ws://127\\.0\\.0\\.1:${port}/[a-f0-9-]+$`, 'u')
  return urls.find(url => expected.test(url)) ?? { reason: 'websocket-url-mismatch' }
}

/** Wait for one owned Host inspector without exposing endpoint response data. */
export async function waitForMainInspectorUrl(options: MainInspectorWaitOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const pollIntervalMs = options.pollIntervalMs ?? 50
  const deadline = Date.now() + timeoutMs
  let observation: MainInspectorObservation = { reason: 'connection-refused' }
  let hostStatus = options.hostStatus()

  while (Date.now() < deadline) {
    hostStatus = options.hostStatus()
    if (hostStatus === 'dead') {
      throw new MainInspectorUnavailableError('host-exited', options.port, options.hostPid, hostStatus)
    }
    if (options.helperExited()) {
      throw new MainInspectorUnavailableError('helper-exited', options.port, options.hostPid, hostStatus)
    }

    const remainingMs = deadline - Date.now()
    const result = await inspectEndpoint(options.port, options.fetch ?? fetch, Math.min(500, remainingMs))
    if (typeof result === 'string') return result
    observation = result
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }

  hostStatus = options.hostStatus()
  if (hostStatus === 'dead') observation = { reason: 'host-exited' }
  else if (options.helperExited()) observation = { reason: 'helper-exited' }
  throw new MainInspectorUnavailableError(
    observation.reason,
    options.port,
    options.hostPid,
    hostStatus,
    observation.httpStatus,
  )
}
