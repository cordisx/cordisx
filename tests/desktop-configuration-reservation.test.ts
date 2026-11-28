import { expect, it, vi } from 'vitest'
import { createDesktopConfigurationReservation } from '../packages/cli/src/launcher/desktop-configuration-reservation.js'

function fixture() {
  const seat = {}
  let listener: (() => void) | undefined
  let closed = false
  const admission = {
    get closed() {
      return closed
    },
    configurationSeat: () => {
      if (closed) throw new Error('stale')
      return seat
    },
    configurationProof: vi.fn(async () => ({ proof: true })),
    configuration: vi.fn(async () => ({ status: 'ok' })),
    onInvalidated: (value: () => void) => {
      listener = value
      return () => {
        listener = undefined
      }
    },
    release: vi.fn(() => {
      closed = true
    }),
  }
  const ended = vi.fn()
  const uncertain = vi.fn()
  const reservation = createDesktopConfigurationReservation({
    admission: admission as never,
    ownerCurrent: () => true,
    onEnd: ended,
    onUncertain: uncertain,
  })
  return { admission, reservation, seat, ended, uncertain, invalidate: () => listener?.() }
}

it('releases a read-only reservation without marking a write uncertain', async () => {
  const f = fixture()
  expect(f.reservation.desktopConfiguration.seat).toBe(f.seat)
  expect(await f.reservation.desktopConfiguration.proof('demo')).toEqual({ proof: true })
  expect(f.reservation.release()).toBe(true)
  expect(f.admission.release).toHaveBeenCalledOnce()
  expect(f.ended).toHaveBeenCalledOnce()
  expect(f.uncertain).not.toHaveBeenCalled()
})

it('requires owner confirmation before releasing a dispatched write', async () => {
  const f = fixture()
  await f.reservation.desktopConfiguration.update({
    kind: 'plugin-configuration',
    action: 'update',
    pluginId: 'demo',
    expectedRevision: 0,
    operations: [{ op: 'set', path: ['label'], value: 'new' }],
  })
  expect(f.reservation.release()).toBe(false)
  expect(f.uncertain).toHaveBeenCalledOnce()
  expect(f.ended).toHaveBeenCalledOnce()
})

it('waits for an in-flight write to settle after the seat is invalidated', async () => {
  const f = fixture()
  let finish!: (value: any) => void
  f.admission.configuration.mockImplementation(() => new Promise(resolve => finish = resolve))
  const pending = f.reservation.desktopConfiguration.update({
    kind: 'plugin-configuration',
    action: 'update',
    pluginId: 'demo',
    expectedRevision: 0,
    operations: [{ op: 'set', path: ['label'], value: 'new' }],
  })
  f.invalidate()
  expect(f.uncertain).toHaveBeenCalledOnce()
  expect(f.admission.release).not.toHaveBeenCalled()
  finish({ status: 'ok' })
  await expect(pending).rejects.toThrow('Desktop configuration reservation is stale')
  expect(f.admission.release).toHaveBeenCalledOnce()
  expect(f.ended).toHaveBeenCalledOnce()
})

it('fences an attempt to release while a native write is still running', async () => {
  const f = fixture()
  let finish!: (value: any) => void
  f.admission.configuration.mockImplementation(() => new Promise(resolve => finish = resolve))
  const pending = f.reservation.desktopConfiguration.update({
    kind: 'plugin-configuration',
    action: 'update',
    pluginId: 'demo',
    expectedRevision: 0,
    operations: [{ op: 'set', path: ['label'], value: 'new' }],
  })
  expect(f.reservation.release()).toBe(false)
  expect(f.uncertain).toHaveBeenCalledOnce()
  expect(f.admission.release).not.toHaveBeenCalled()
  finish({ status: 'ok' })
  await expect(pending).rejects.toThrow('Desktop configuration reservation is stale')
  expect(f.admission.release).toHaveBeenCalledOnce()
})

it('reports an admission release failure instead of confirming cleanup', () => {
  const f = fixture()
  f.admission.release.mockImplementation(() => {
    throw new Error('synthetic release failure')
  })
  expect(f.reservation.release()).toBe(false)
  expect(f.uncertain).toHaveBeenCalledOnce()
  expect(f.ended).toHaveBeenCalledOnce()
})
