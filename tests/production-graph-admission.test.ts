import { describe, expect, it, vi } from 'vitest'
import {
  CdpLifecycleRequestGate,
  type ProductionGraphOperations,
  type ProductionGraphRecord,
  refreshProductionGraphBootstraps,
} from '../packages/cli/src/launcher/production-graph-admission.js'

function deferred<Value = void>(): {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
} {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('production graph admission coordination', () => {
  it('releases the single-flight fence before a response-triggered follow-up', async () => {
    const gate = new CdpLifecycleRequestGate()
    const values: number[] = []
    let followUp: Promise<void> | undefined

    await gate.run(async () => 1, async value => {
      values.push(value)
      followUp = gate.run(async () => 2, async next => {
        values.push(next)
      })
    })
    await followUp

    expect(values).toEqual([1, 2])
  })

  it('rejects a genuinely concurrent lifecycle task', async () => {
    const gate = new CdpLifecycleRequestGate()
    const blocked = deferred()
    const active = gate.run(async () => {
      await blocked.promise
    }, async () => undefined)

    await expect(gate.run(async () => undefined, async () => undefined)).rejects.toThrow(/already active/)
    blocked.resolve()
    await active
  })

  it('queues watcher work while allowing the owning lifecycle task to re-enter', async () => {
    const gate = new CdpLifecycleRequestGate()
    const values: string[] = []
    const entered = deferred()
    const release = deferred()
    const lifecycle = gate.exclusive(async () => {
      values.push('lifecycle')
      await gate.exclusive(async () => {
        values.push('admission')
      })
      entered.resolve()
      await release.promise
      values.push('settled')
    })
    await entered.promise
    const watcher = gate.exclusive(async () => {
      values.push('watcher')
    })
    await Promise.resolve()
    expect(values).toEqual(['lifecycle', 'admission'])
    release.resolve()
    await Promise.all([lifecycle, watcher])
    expect(values).toEqual(['lifecycle', 'admission', 'settled', 'watcher'])
  })

  it('keeps a response-triggered follow-up ahead of watcher work queued during the request', async () => {
    const gate = new CdpLifecycleRequestGate()
    const values: string[] = []
    const entered = deferred()
    const release = deferred()
    let followUp: Promise<void> | undefined
    const lifecycle = gate.run(async () => {
      values.push('lifecycle')
      entered.resolve()
      await release.promise
      return 'result'
    }, async () => {
      values.push('response')
      followUp = gate.run(async () => {
        values.push('snapshot')
      }, async () => {
        values.push('snapshot-response')
      })
    })
    await entered.promise
    const watcher = gate.exclusive(async () => {
      values.push('watcher')
    })
    release.resolve()
    await lifecycle
    await followUp
    await watcher
    expect(values).toEqual(['lifecycle', 'response', 'snapshot', 'snapshot-response', 'watcher'])
  })

  it('closes to new work, drains queued writes, and runs cleanup last', async () => {
    const gate = new CdpLifecycleRequestGate()
    const values: string[] = []
    const entered = deferred()
    const release = deferred()
    const active = gate.exclusive(async () => {
      values.push('active')
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const queued = gate.exclusive(async () => {
      values.push('queued')
    })
    const cleanup = gate.closeAndDrain(async () => {
      values.push('cleanup')
    })
    await expect(gate.exclusive(async () => undefined)).rejects.toThrow('gate is closed')
    release.resolve()
    await Promise.all([active, queued, cleanup])
    expect(values).toEqual(['active', 'queued', 'cleanup'])
  })

  it('uses the operation abort boundary for both future-script mutations', async () => {
    const signal = new AbortController().signal
    const mutations: Array<Readonly<{ method: string; signal?: AbortSignal }>> = []
    const session = {
      send: vi.fn(async () => {
        throw new Error('document script mutations must use the bounded operation')
      }),
      isClosed: () => false,
    }
    const current: ProductionGraphRecord = {
      target: { id: 'native', url: 'app://-/index.html' },
      session,
      identifier: 'old',
      documentSource: 'old-source',
      loopbackModules: true,
    }
    const replace = vi.fn()
    const operations: Pick<
      ProductionGraphOperations<ProductionGraphRecord>,
      'replace' | 'mutateDocumentScript' | 'signal'
    > = {
      signal,
      replace,
      mutateDocumentScript: async (_session, method, _params, operationSignal) => {
        mutations.push({ method, ...(operationSignal === undefined ? {} : { signal: operationSignal }) })
        return method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: 'next' } : {}
      },
    }

    await refreshProductionGraphBootstraps([current], { source: 'next-source' }, operations)

    expect(session.send).not.toHaveBeenCalled()
    expect(mutations).toEqual([
      { method: 'Page.addScriptToEvaluateOnNewDocument', signal },
      { method: 'Page.removeScriptToEvaluateOnNewDocument', signal },
    ])
    expect(replace).toHaveBeenCalledWith(current, expect.objectContaining({ identifier: 'next' }))
  })
})
