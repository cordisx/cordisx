import { describe, expect, it } from 'vitest'
import { ManagerManagedServiceUIGate } from '../packages/cli/src/cli/manager-managed-service-ui-gate.js'

describe('managed service UI transition gate', () => {
  it('blocks new calls and waits for earlier calls to finish before releasing a reservation', async () => {
    const gate = new ManagerManagedServiceUIGate()
    const finishRead = gate.begin()
    const reservation = gate.reserve(() => true)
    expect(gate.open).toBe(false)
    expect(() => gate.begin()).toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    finishRead()
    const held = await reservation
    expect(held.isCurrent()).toBe(true)
    expect(held.release()).toBe(true)
    expect(gate.open).toBe(true)
    gate.begin()()
  })

  it('parks an observation result and fences its delivery against the next transition', async () => {
    const gate = new ManagerManagedServiceUIGate()
    const first = await gate.reserve(() => true)
    const controller = new AbortController()
    let delivered = false
    const delivery = gate.beginWhenOpen(controller.signal).then(finish => {
      delivered = true
      return finish
    })
    await Promise.resolve()
    expect(delivered).toBe(false)
    expect(gate.parked).toBe(true)
    expect(first.release()).toBe(true)
    const finishDelivery = await delivery
    let reserved = false
    const next = gate.reserve(() => true).then(value => {
      reserved = true
      return value
    })
    await Promise.resolve()
    expect(reserved).toBe(false)
    finishDelivery()
    expect((await next).release()).toBe(true)
  })

  it('rejects parked results when their renderer leaves or the transition is fenced', async () => {
    const gate = new ManagerManagedServiceUIGate()
    const held = await gate.reserve(() => true)
    const controller = new AbortController()
    const aborted = gate.beginWhenOpen(controller.signal)
    const fenced = gate.beginWhenOpen(new AbortController().signal)
    controller.abort()
    await expect(aborted).rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    held.fence()
    await expect(fenced).rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    expect(gate.open).toBe(false)
  })

  it('reopens after a drain timeout before any owner transaction begins', async () => {
    const gate = new ManagerManagedServiceUIGate()
    const finishRead = gate.begin()
    await expect(gate.reserve(() => true, 100)).rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    expect(gate.open).toBe(true)
    finishRead()
  })

  it('keeps a stale reservation fenced even if an earlier read eventually finishes', async () => {
    const gate = new ManagerManagedServiceUIGate()
    let current = true
    const finishRead = gate.begin()
    const pending = gate.reserve(() => current)
    current = false
    finishRead()
    await expect(pending).rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    expect(gate.open).toBe(false)
    expect(() => gate.begin()).toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
  })

  it('fences rather than reopening when the owner changes before release', async () => {
    const gate = new ManagerManagedServiceUIGate()
    let current = true
    const held = await gate.reserve(() => current)
    current = false
    expect(held.release()).toBe(false)
    expect(gate.open).toBe(false)
  })

  it('wakes a waiting reservation when the owner closes', async () => {
    const gate = new ManagerManagedServiceUIGate()
    const finishRead = gate.begin()
    const pending = gate.reserve(() => true)
    gate.close()
    await expect(pending).rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    finishRead()
    expect(gate.open).toBe(false)
  })
})
