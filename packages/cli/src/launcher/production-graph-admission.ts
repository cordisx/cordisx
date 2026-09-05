import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

export interface ProductionGraphBootstrap {
  readonly source: string
  readonly newDocumentSource?: string
}

export interface ProductionGraphPermission {
  readonly name: string
  readonly origin: string
}

interface ProductionGraphTarget {
  readonly id: string
  readonly url: string
}

interface ProductionGraphSession {
  send(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>
  isClosed(): boolean
}

export interface ProductionGraphRecord {
  readonly target: ProductionGraphTarget
  readonly session: ProductionGraphSession
  readonly identifier: string
  /** Raw bootstrap represented by the registered future-document script. */
  readonly documentSource: string
  readonly loopbackModules?: boolean
  readonly viteLoopbackPermission?: ProductionGraphPermission
}

export interface ProductionGraphPermissionCoordinator {
  acquire(
    session: ProductionGraphSession,
    target: ProductionGraphTarget,
  ): Promise<ProductionGraphPermission | undefined>
  release(session: ProductionGraphSession, permission: ProductionGraphPermission | undefined): Promise<void>
}

export interface ProductionGraphOperations<RecordType extends ProductionGraphRecord> {
  readonly injectionTimeoutMs: number
  readonly permissions: ProductionGraphPermissionCoordinator
  readonly signal: AbortSignal
  isNativeTarget(target: ProductionGraphTarget): boolean
  replace(current: RecordType, replacement: {
    readonly identifier: string
    readonly documentSource: string
    readonly loopbackModules: boolean
    readonly viteLoopbackPermission?: ProductionGraphPermission
  }): void
  disposeRenderer(record: RecordType): Promise<void>
  waitForBootstrap(record: RecordType, installId: string, deadline: number, signal: AbortSignal): Promise<void>
}

/** One re-entrant owner gate for every Host write that can affect a renderer projection. */
export class CdpLifecycleRequestGate {
  readonly #context = new AsyncLocalStorage<symbol>()
  #owner: symbol | undefined
  #pending = 0
  #tail: Promise<void> = Promise.resolve()

  async exclusive<Value>(task: () => Promise<Value>): Promise<Value> {
    if (this.#context.getStore() === this.#owner && this.#owner !== undefined) return await task()
    this.#pending += 1
    const previous = this.#tail
    let release!: () => void
    this.#tail = new Promise<void>(resolve => {
      release = resolve
    })
    await previous
    const owner = Symbol('cdp-host-mutation')
    this.#owner = owner
    try {
      return await this.#context.run(owner, task)
    } finally {
      this.#owner = undefined
      this.#pending -= 1
      release()
    }
  }

  async run<Value>(task: () => Promise<Value>, respond: (value: Value) => Promise<void>): Promise<void> {
    const reentrant = this.#owner !== undefined && this.#context.getStore() === this.#owner
    if (this.#pending > 0 && !reentrant) {
      throw new Error('another plugin lifecycle request is already active')
    }
    const value = await this.exclusive(task)
    await respond(value)
  }
}

export function productionBootstrapSource(documentSource: string, installId: string): string {
  return `globalThis.__cordisxProductionInstallId = ${JSON.stringify(installId)};
globalThis.__cordisxProductionBootstrapState = {
  installId: ${JSON.stringify(installId)},
  status: 'evaluating',
};
try {
${documentSource}
  globalThis.__cordisxProductionBootstrapState = {
    installId: ${JSON.stringify(installId)},
    status: 'evaluated',
  };
} catch (error) {
  globalThis.__cordisxProductionBootstrapState = {
    installId: ${JSON.stringify(installId)},
    status: 'failed',
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  };
  throw error;
}`
}

interface PromotionState<RecordType extends ProductionGraphRecord> {
  readonly current: RecordType
  permission: ProductionGraphPermission | undefined
  identifier?: string
  installId?: string
  restoreIdentifier?: string
  restoreInstallId?: string
  oldRemoved: boolean
  reloadStarted: boolean
  ambiguousMutation: boolean
}

async function compensateProductionGraphPromotion<RecordType extends ProductionGraphRecord>(
  states: readonly PromotionState<RecordType>[],
  operations: ProductionGraphOperations<RecordType>,
): Promise<void> {
  const failures: unknown[] = []
  for (const state of states) {
    const { current } = state
    let restoredIdentifier = current.identifier
    let scriptRestored = !state.oldRemoved
    if (state.identifier !== undefined) {
      await current.session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: state.identifier })
        .catch(error => {
          state.ambiguousMutation = true
          failures.push(error)
        })
    }
    if (state.oldRemoved) {
      try {
        const restoreInstallId = randomUUID()
        const restored = await current.session.send('Page.addScriptToEvaluateOnNewDocument', {
          source: productionBootstrapSource(current.documentSource, restoreInstallId),
        })
        const identifier = restored.identifier
        if (typeof identifier !== 'string') {
          state.ambiguousMutation = true
          throw new Error('CDP did not return a restored injection identifier')
        }
        state.restoreIdentifier = identifier
        state.restoreInstallId = restoreInstallId
        restoredIdentifier = identifier
        scriptRestored = true
      } catch (error) {
        state.ambiguousMutation = true
        failures.push(error)
      }
    }
    if (state.reloadStarted) await operations.disposeRenderer(current).catch(error => failures.push(error))
    let cspRestored = false
    try {
      await current.session.send('Page.setBypassCSP', { enabled: false })
      cspRestored = true
    } catch (error) {
      failures.push(error)
    }
    await operations.permissions.release(current.session, state.permission).catch(error => failures.push(error))
    if (state.reloadStarted && scriptRestored && cspRestored) {
      try {
        await current.session.send('Page.reload', {}, operations.injectionTimeoutMs)
        const restoreInstallId = state.restoreInstallId
        if (restoreInstallId === undefined) throw new Error('restored production install id is unavailable')
        await operations.waitForBootstrap(
          current,
          restoreInstallId,
          Date.now() + operations.injectionTimeoutMs,
          operations.signal,
        )
      } catch (error) {
        failures.push(error)
      }
    }
    operations.replace(current, {
      identifier: restoredIdentifier,
      documentSource: current.documentSource,
      loopbackModules: current.loopbackModules === true,
      ...(current.viteLoopbackPermission === undefined
        ? {}
        : { viteLoopbackPermission: current.viteLoopbackPermission }),
    })
    if (state.ambiguousMutation) {
      failures.push(new Error(`CDP script mutation outcome is ambiguous for target ${current.target.id}`))
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'CordisX browser graph admission compensation was incomplete')
  }
}

export async function promoteProductionGraph<RecordType extends ProductionGraphRecord>(
  records: readonly RecordType[],
  bootstrap: ProductionGraphBootstrap,
  operations: ProductionGraphOperations<RecordType>,
): Promise<Readonly<{ rollback(): Promise<void> }>> {
  if (records.length === 0) throw new Error('no installed CordisX renderer is available for browser graph admission')
  if (records.some(record => !operations.isNativeTarget(record.target))) {
    throw new Error('production loopback graph requires a native app:// renderer target')
  }
  const states: PromotionState<RecordType>[] = records.map(current => ({
    current,
    permission: undefined,
    oldRemoved: false,
    reloadStarted: false,
    ambiguousMutation: false,
  }))
  const setupFailures: unknown[] = []
  for (const state of states) {
    try {
      state.permission = await operations.permissions.acquire(state.current.session, state.current.target)
      await state.current.session.send('Page.setBypassCSP', { enabled: true })
      const installId = randomUUID()
      let added: Record<string, unknown>
      try {
        added = await state.current.session.send('Page.addScriptToEvaluateOnNewDocument', {
          source: productionBootstrapSource(bootstrap.newDocumentSource ?? bootstrap.source, installId),
        })
      } catch (error) {
        state.ambiguousMutation = true
        throw error
      }
      if (typeof added.identifier !== 'string') {
        state.ambiguousMutation = true
        throw new Error('CDP did not return an injection identifier')
      }
      state.identifier = added.identifier
      try {
        await state.current.session.send('Page.removeScriptToEvaluateOnNewDocument', {
          identifier: state.current.identifier,
        })
      } catch (error) {
        state.ambiguousMutation = true
        throw error
      }
      state.oldRemoved = true
      state.installId = installId
    } catch (error) {
      setupFailures.push(error)
    }
  }
  if (setupFailures.length === 0) {
    const reloads = await Promise.allSettled(states.map(async state => {
      state.reloadStarted = true
      await state.current.session.send('Page.reload', {}, operations.injectionTimeoutMs)
      const installId = state.installId
      if (installId === undefined) throw new Error('CordisX browser graph admission install id is unavailable')
      await operations.waitForBootstrap(
        state.current,
        installId,
        Date.now() + operations.injectionTimeoutMs,
        operations.signal,
      )
    }))
    setupFailures.push(...reloads.flatMap(result => result.status === 'rejected' ? [result.reason] : []))
  }
  if (setupFailures.length > 0) {
    try {
      await compensateProductionGraphPromotion(states, operations)
    } catch (compensationError) {
      throw new AggregateError(
        [...setupFailures, compensationError],
        'CordisX browser graph admission failed and compensation was incomplete',
      )
    }
    throw new AggregateError(setupFailures, 'CordisX browser graph admission failed')
  }
  for (const state of states) {
    operations.replace(state.current, {
      identifier: state.identifier!,
      documentSource: bootstrap.newDocumentSource ?? bootstrap.source,
      loopbackModules: true,
      ...(state.permission === undefined ? {} : { viteLoopbackPermission: state.permission }),
    })
  }
  return { rollback: async () => await compensateProductionGraphPromotion(states, operations) }
}

export async function refreshProductionGraphBootstraps<RecordType extends ProductionGraphRecord>(
  records: readonly RecordType[],
  bootstrap: ProductionGraphBootstrap,
  operations: Pick<ProductionGraphOperations<RecordType>, 'replace'>,
): Promise<void> {
  const states = records.map(current => ({
    current,
    identifier: undefined as string | undefined,
    oldRemoved: false,
    ambiguousMutation: false,
  }))
  const failures: unknown[] = []
  for (const state of states) {
    try {
      if (state.current.loopbackModules !== true) {
        throw new Error('future browser graph bootstrap refresh requires admitted loopback transport')
      }
      let added: Record<string, unknown>
      try {
        added = await state.current.session.send('Page.addScriptToEvaluateOnNewDocument', {
          source: productionBootstrapSource(bootstrap.newDocumentSource ?? bootstrap.source, randomUUID()),
        })
      } catch (error) {
        state.ambiguousMutation = true
        throw error
      }
      if (typeof added.identifier !== 'string') {
        state.ambiguousMutation = true
        throw new Error('CDP did not return an injection identifier')
      }
      state.identifier = added.identifier
      try {
        await state.current.session.send('Page.removeScriptToEvaluateOnNewDocument', {
          identifier: state.current.identifier,
        })
      } catch (error) {
        state.ambiguousMutation = true
        throw error
      }
      state.oldRemoved = true
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    const compensationFailures: unknown[] = []
    for (const state of states) {
      if (state.identifier !== undefined) {
        await state.current.session.send('Page.removeScriptToEvaluateOnNewDocument', {
          identifier: state.identifier,
        }).catch(error => {
          state.ambiguousMutation = true
          compensationFailures.push(error)
        })
      }
      if (state.oldRemoved) {
        try {
          const restored = await state.current.session.send('Page.addScriptToEvaluateOnNewDocument', {
            source: productionBootstrapSource(state.current.documentSource, randomUUID()),
          })
          if (typeof restored.identifier !== 'string') {
            state.ambiguousMutation = true
            throw new Error('CDP did not return a restored injection identifier')
          }
          operations.replace(state.current, {
            identifier: restored.identifier,
            documentSource: state.current.documentSource,
            loopbackModules: true,
            ...(state.current.viteLoopbackPermission === undefined
              ? {}
              : { viteLoopbackPermission: state.current.viteLoopbackPermission }),
          })
        } catch (error) {
          state.ambiguousMutation = true
          compensationFailures.push(error)
        }
      }
      if (state.ambiguousMutation) {
        compensationFailures.push(
          new Error(`CDP script mutation outcome is ambiguous for target ${state.current.target.id}`),
        )
      }
    }
    if (compensationFailures.length > 0) {
      throw new AggregateError(
        [...failures, ...compensationFailures],
        'CordisX future browser graph bootstrap refresh failed and compensation was incomplete',
      )
    }
    throw new AggregateError(failures, 'CordisX future browser graph bootstrap refresh failed')
  }
  for (const state of states) {
    operations.replace(state.current, {
      identifier: state.identifier!,
      documentSource: bootstrap.newDocumentSource ?? bootstrap.source,
      loopbackModules: true,
      ...(state.current.viteLoopbackPermission === undefined
        ? {}
        : { viteLoopbackPermission: state.current.viteLoopbackPermission }),
    })
  }
}
