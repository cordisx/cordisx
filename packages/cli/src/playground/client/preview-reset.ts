export const PLAYGROUND_PREVIEW_RESET_MARKER_KEY = 'cordisx.playground.preview-reset/v1'
export const PLAYGROUND_PREVIEW_RESET_RESULT_KEY = 'cordisx.playground.preview-reset-result/v1'
export const PLAYGROUND_PREVIEW_RESET_APPLIED_KEY = 'cordisx.playground.preview-reset-applied/v1'

export interface PlaygroundPreviewResetEpoch {
  readonly version: 1
  readonly instanceId: string
  readonly generation: number
}

export interface PlaygroundPreviewResetMarker {
  readonly version: 1
  readonly nonce: string
  readonly phase: 'requesting' | 'awaiting-readback' | 'verifying'
  readonly startedAt: string
}

export interface PlaygroundPreviewResetResult {
  readonly version: 1
  readonly status: 'complete' | 'failed'
  readonly roomRows: number
  readonly recentTaskRows: number
  readonly simulatorRecords: number
  readonly sources: PlaygroundPreviewResetSourceBreakdown
  readonly instanceId: string
  readonly serverGeneration: number
  readonly appliedGeneration: number
  readonly completedAt: string
  readonly message?: string
}

export interface PlaygroundPreviewResetSourceBreakdown {
  readonly liveRuntime: number
  readonly runtimeMemory: number
  readonly taskSnapshotRegistry: number
  readonly hostSessionRegistry: number
  readonly legacyAliasRegistry: number
  readonly finalSelector: number
}

const disposableSessionNamespace = /^cordisx\.playground\.(?:simulator|host-session|scenario-lab|debug-generation|agent-loop)(?:[/:.]|$)/u

function parse<Value>(storage: Storage, key: string): Value | undefined {
  try {
    const raw = storage.getItem(key)
    return raw === null ? undefined : JSON.parse(raw) as Value
  } catch {
    return undefined
  }
}

export function isPlaygroundDisposableSessionKey(key: string): boolean {
  return disposableSessionNamespace.test(key)
}

export function clearPlaygroundDisposableSessionData(storage: Storage): readonly string[] {
  const matching: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key !== null && isPlaygroundDisposableSessionKey(key)) matching.push(key)
  }
  for (const key of matching) storage.removeItem(key)
  return Object.freeze(matching)
}

export function countPlaygroundDisposableSessionRecords(storage: Storage): number {
  let count = 0
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key !== null && isPlaygroundDisposableSessionKey(key)) count += 1
  }
  return count
}

export function readPlaygroundPreviewResetMarker(storage: Storage | undefined): PlaygroundPreviewResetMarker | undefined {
  if (storage === undefined) return undefined
  const marker = parse<Partial<PlaygroundPreviewResetMarker>>(storage, PLAYGROUND_PREVIEW_RESET_MARKER_KEY)
  return marker?.version === 1
    && typeof marker.nonce === 'string' && marker.nonce !== ''
    && (marker.phase === 'requesting' || marker.phase === 'awaiting-readback' || marker.phase === 'verifying')
    && typeof marker.startedAt === 'string'
    ? marker as PlaygroundPreviewResetMarker
    : undefined
}

export function writePlaygroundPreviewResetMarker(storage: Storage, marker: PlaygroundPreviewResetMarker): void {
  storage.setItem(PLAYGROUND_PREVIEW_RESET_MARKER_KEY, JSON.stringify(marker))
}

export function clearPlaygroundPreviewResetMarker(storage: Storage): void {
  storage.removeItem(PLAYGROUND_PREVIEW_RESET_MARKER_KEY)
}

export function readPlaygroundPreviewResetResult(storage: Storage): PlaygroundPreviewResetResult | undefined {
  const result = parse<Partial<PlaygroundPreviewResetResult>>(storage, PLAYGROUND_PREVIEW_RESET_RESULT_KEY)
  const sources = result?.sources as Partial<PlaygroundPreviewResetSourceBreakdown> | undefined
  return result?.version === 1
    && (result.status === 'complete' || result.status === 'failed')
    && Number.isSafeInteger(result.roomRows) && Number.isSafeInteger(result.recentTaskRows)
    && Number.isSafeInteger(result.simulatorRecords) && typeof result.completedAt === 'string'
    && typeof result.instanceId === 'string' && result.instanceId !== ''
    && Number.isSafeInteger(result.serverGeneration) && Number.isSafeInteger(result.appliedGeneration)
    && sources !== undefined
    && Number.isSafeInteger(sources.liveRuntime) && Number.isSafeInteger(sources.runtimeMemory)
    && Number.isSafeInteger(sources.taskSnapshotRegistry) && Number.isSafeInteger(sources.hostSessionRegistry)
    && Number.isSafeInteger(sources.legacyAliasRegistry) && Number.isSafeInteger(sources.finalSelector)
    ? result as PlaygroundPreviewResetResult
    : undefined
}

export function writePlaygroundPreviewResetResult(storage: Storage, result: PlaygroundPreviewResetResult): void {
  storage.setItem(PLAYGROUND_PREVIEW_RESET_RESULT_KEY, JSON.stringify(result))
}

export function isPlaygroundPreviewResetEpoch(value: unknown): value is PlaygroundPreviewResetEpoch {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const epoch = value as Partial<PlaygroundPreviewResetEpoch>
  return epoch.version === 1
    && typeof epoch.instanceId === 'string' && epoch.instanceId !== ''
    && Number.isSafeInteger(epoch.generation) && (epoch.generation ?? -1) >= 0
}

export function readPlaygroundPreviewResetApplied(storage: Storage | undefined): PlaygroundPreviewResetEpoch | undefined {
  if (storage === undefined) return undefined
  const epoch = parse<unknown>(storage, PLAYGROUND_PREVIEW_RESET_APPLIED_KEY)
  return isPlaygroundPreviewResetEpoch(epoch) ? epoch : undefined
}

export function writePlaygroundPreviewResetApplied(storage: Storage, epoch: PlaygroundPreviewResetEpoch): void {
  storage.setItem(PLAYGROUND_PREVIEW_RESET_APPLIED_KEY, JSON.stringify(epoch))
}

export function playgroundPreviewResetEpochMatches(
  applied: PlaygroundPreviewResetEpoch | undefined,
  server: PlaygroundPreviewResetEpoch | undefined,
): boolean {
  return applied !== undefined && server !== undefined
    && applied.instanceId === server.instanceId
    && applied.generation === server.generation
}
