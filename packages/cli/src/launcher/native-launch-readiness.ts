const DEPENDENCY_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/u

export type NativeLaunchReadinessErrorCode =
  | 'cancelled'
  | 'prepare-failed'
  | 'prepare-timeout'
  | 'cleanup-failed'

/** Bounded launcher diagnostic that never copies dependency error text. */
export class NativeLaunchReadinessError extends Error {
  constructor(
    readonly code: NativeLaunchReadinessErrorCode,
    readonly dependencyId: string | undefined,
    readonly cleanupFailed = false,
  ) {
    super(
      dependencyId === undefined
        ? `native launch readiness ${code}`
        : `native launch readiness ${code}: ${dependencyId}`,
    )
    this.name = 'NativeLaunchReadinessError'
  }
}

export interface NativeLaunchReadinessDependency<T = unknown> {
  readonly id: string
  readonly prepareTimeoutMs: number
  readonly disposeTimeoutMs: number
  /**
   * Until this resolves, the dependency owns every partial resource it creates.
   * A late resolved value transfers cleanup ownership back to the coordinator.
   */
  prepare(signal: AbortSignal): Promise<T>
  /** Must target only the exact resources represented by the prepared value. */
  dispose(value: T): Promise<void>
}

export interface PreparedNativeLaunchDependency<T = unknown> {
  readonly id: string
  readonly value: T
}

export interface NativeLaunchReadinessSession {
  readonly dependencies: readonly PreparedNativeLaunchDependency[]
  dispose(): Promise<void>
}

interface PreparedRecord {
  readonly dependency: NativeLaunchReadinessDependency
  readonly value: unknown
}

type PreparationOutcome<T> =
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'cancelled' | 'failed' | 'timeout' }

const MIN_TIMEOUT_MS = 1
const MAX_TIMEOUT_MS = 120_000

function validTimeout(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_TIMEOUT_MS && value <= MAX_TIMEOUT_MS
}

function checkedDependencies(
  dependencies: readonly NativeLaunchReadinessDependency[],
): readonly NativeLaunchReadinessDependency[] {
  const ids = new Set<string>()
  for (const dependency of dependencies) {
    if (
      !DEPENDENCY_ID.test(dependency.id) || ids.has(dependency.id)
      || !validTimeout(dependency.prepareTimeoutMs) || !validTimeout(dependency.disposeTimeoutMs)
    ) {
      throw new TypeError('native launch readiness dependency contract is invalid or duplicated')
    }
    ids.add(dependency.id)
  }
  return dependencies
}

async function boundedPreparation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<PreparationOutcome<T>> {
  return await new Promise(resolve => {
    let settled = false
    const finish = (outcome: PreparationOutcome<T>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      resolve(outcome)
    }
    const cancel = (): void => finish({ status: 'cancelled' })
    const timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    void operation.then(
      value => finish({ status: 'ready', value }),
      () => finish({ status: 'failed' }),
    )
  })
}

async function disposeRecord(record: PreparedRecord): Promise<boolean> {
  const operation = Promise.resolve().then(async () => await record.dependency.dispose(record.value))
  return await new Promise(resolve => {
    let settled = false
    const finish = (failed: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(failed)
    }
    const timer = setTimeout(() => finish(true), record.dependency.disposeTimeoutMs)
    void operation.then(() => finish(false), () => finish(true))
  })
}

async function disposePrepared(records: readonly PreparedRecord[]): Promise<boolean> {
  let failed = false
  for (const record of [...records].reverse()) {
    if (await disposeRecord(record)) failed = true
  }
  return failed
}

function ownLateResult(dependency: NativeLaunchReadinessDependency, operation: Promise<unknown>): void {
  void operation.then(
    async value => {
      await disposeRecord({ dependency, value })
    },
    () => undefined,
  )
}

/**
 * Prepare launcher-private dependencies before native provider configuration or
 * process launch. Callers retain only opaque values and one cleanup authority.
 */
export async function prepareNativeLaunchReadiness(
  dependencies: readonly NativeLaunchReadinessDependency[],
  signal: AbortSignal,
): Promise<NativeLaunchReadinessSession> {
  if (signal.aborted) throw new NativeLaunchReadinessError('cancelled', undefined)
  const prepared: PreparedRecord[] = []
  for (const dependency of checkedDependencies(dependencies)) {
    if (signal.aborted) {
      const cleanupFailed = await disposePrepared(prepared)
      throw new NativeLaunchReadinessError('cancelled', dependency.id, cleanupFailed)
    }
    const operation = Promise.resolve().then(async () => await dependency.prepare(signal))
    const outcome = await boundedPreparation(operation, signal, dependency.prepareTimeoutMs)
    if (outcome.status !== 'ready') {
      if (outcome.status !== 'failed') ownLateResult(dependency, operation)
      const cleanupFailed = await disposePrepared(prepared)
      throw new NativeLaunchReadinessError(
        outcome.status === 'cancelled'
          ? 'cancelled'
          : outcome.status === 'timeout'
          ? 'prepare-timeout'
          : 'prepare-failed',
        dependency.id,
        cleanupFailed,
      )
    }
    prepared.push({ dependency, value: outcome.value })
    if (signal.aborted) {
      const cleanupFailed = await disposePrepared(prepared)
      throw new NativeLaunchReadinessError('cancelled', dependency.id, cleanupFailed)
    }
  }

  let disposePromise: Promise<void> | undefined
  return Object.freeze({
    dependencies: Object.freeze(prepared.map(record =>
      Object.freeze({
        id: record.dependency.id,
        value: record.value,
      })
    )),
    dispose: () => {
      disposePromise ??= (async () => {
        if (await disposePrepared(prepared)) {
          throw new NativeLaunchReadinessError('cleanup-failed', undefined)
        }
      })()
      return disposePromise
    },
  })
}
