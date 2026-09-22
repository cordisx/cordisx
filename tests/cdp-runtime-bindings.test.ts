import { expect, it, vi } from 'vitest'
import { installRuntimeBindings } from '../packages/cli/src/launcher/cdp-runtime-bindings.js'

it('dispatches independent names together and waits for every ACK before continuing', async () => {
  const pending: Array<(value: Record<string, unknown>) => void> = []
  const send = vi.fn((_method: string, _params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>(resolve => pending.push(resolve))
  )
  const next = vi.fn()
  const installation = installRuntimeBindings({ send }, ['first', 'second', 'third']).then(next)
  expect(send.mock.calls).toEqual([
    ['Runtime.addBinding', { name: 'first' }],
    ['Runtime.addBinding', { name: 'second' }],
    ['Runtime.addBinding', { name: 'third' }],
  ])
  pending[2]!({})
  pending[0]!({})
  await Promise.resolve()
  expect(next).not.toHaveBeenCalled()
  pending[1]!({})
  await installation
  expect(next).toHaveBeenCalledOnce()
})

it('drains later ACKs after a rejection before allowing rollback to start', async () => {
  const pending: Array<{ resolve(value: Record<string, unknown>): void; reject(error: Error): void }> = []
  const send = vi.fn(() => new Promise<Record<string, unknown>>((resolve, reject) => pending.push({ resolve, reject })))
  const rollback = vi.fn()
  const failure = new Error('binding rejected')
  const installation = installRuntimeBindings({ send }, ['first', 'second', 'third']).catch(rollback)
  pending[0]!.reject(failure)
  pending[2]!.resolve({})
  await Promise.resolve()
  expect(rollback).not.toHaveBeenCalled()
  pending[1]!.resolve({})
  await installation
  expect(rollback).toHaveBeenCalledExactlyOnceWith(failure)
})
