import { expect, it, vi } from 'vitest'
import { createNativeManagedModelListRecovery } from '../packages/cli/assets/launcher/native-managed-model-list-recovery.mjs'

const missing = (id: string, providerId: string) => ({
  id,
  error: { code: -32600, data: { type: 'modelProviderNotConfigured', modelProvider: providerId } },
})
const request = (id: string, providerId: string) => ({
  id,
  method: 'model/list',
  params: { modelProvider: providerId },
})

it('retains ambiguous request IDs until every outstanding native response has returned', () => {
  const controlCall = vi.fn()
  const recovery = createNativeManagedModelListRecovery({
    controlCall,
    writeDesktop: vi.fn(),
    emitDiagnostic: vi.fn(),
    stop: vi.fn(),
  })
  try {
    recovery.issued(request('same', 'one'))
    recovery.issued(request('same', 'two'))
    expect(recovery.received(missing('same', 'one'), 'first')).toBe(false)
    recovery.issued(request('same', 'three'))
    expect(recovery.received(missing('same', 'two'), 'second')).toBe(false)
    expect(recovery.received(missing('same', 'three'), 'third')).toBe(false)
    expect(controlCall).not.toHaveBeenCalled()
  } finally {
    recovery.clear()
  }
})

it('preserves the native failure if an ID becomes ambiguous during catalog recovery', async () => {
  let resolve!: (value: unknown) => void
  const pending = new Promise<unknown>(done => {
    resolve = done
  })
  const writeDesktop = vi.fn(async () => {})
  const recovery = createNativeManagedModelListRecovery({
    controlCall: () => pending,
    writeDesktop,
    emitDiagnostic: vi.fn(),
    stop: vi.fn(),
  })
  try {
    recovery.issued(request('same', 'one'))
    expect(recovery.received(missing('same', 'one'), 'original-native-failure')).toBe(true)
    recovery.issued(request('same', 'two'))
    expect(recovery.received(missing('same', 'two'), 'second-native-failure')).toBe(false)
    resolve({ data: [{ id: 'one-model' }], nextCursor: null })
    await vi.waitFor(() => expect(writeDesktop).toHaveBeenCalledWith('original-native-failure'))
    expect(writeDesktop).toHaveBeenCalledTimes(1)
  } finally {
    recovery.clear()
  }
})
