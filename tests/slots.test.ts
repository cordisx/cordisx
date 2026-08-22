import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { DomSlotRegistry, type SlotResolver } from '../src/renderer/slots.js'
import type { CordisXSlotName } from '../src/contracts.js'

function allResolvers(composer: SlotResolver): Record<CordisXSlotName, SlotResolver> {
  const missing: SlotResolver = () => undefined
  return {
    'header.actions': missing,
    'composer.before': composer,
    'composer.after': missing,
    'sidebar.footer': missing,
    'shell.overlay': missing,
  }
}

describe('DomSlotRegistry', () => {
  it('remounts after the Codex anchor is replaced and runs both disposers', async () => {
    const dom = new JSDOM('<body><main id="first"></main></body>')
    const document = dom.window.document
    const resolver: SlotResolver = current => {
      const anchor = current.querySelector('main')
      return anchor === null ? undefined : { anchor, placement: 'append' }
    }
    const registry = new DomSlotRegistry(document, allResolvers(resolver))
    let mounts = 0
    let disposals = 0
    const unregister = registry.register({
      name: 'composer.before',
      id: 'demo',
    }, ({ container }) => {
      mounts += 1
      container.textContent = `mount-${mounts}`
      return () => { disposals += 1 }
    })

    expect(document.querySelector('[data-cordisx-contribution="demo"]')?.textContent).toBe('mount-1')
    document.querySelector('main')?.replaceWith(document.createElement('main'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(document.querySelector('[data-cordisx-contribution="demo"]')?.textContent).toBe('mount-2')
    expect(disposals).toBe(1)

    unregister()
    expect(disposals).toBe(2)
    expect(document.querySelector('[data-cordisx-contribution="demo"]')).toBeNull()
    registry.dispose()
  })

  it('orders list cells by order and then registration, independent of shadow priority', () => {
    const dom = new JSDOM('<body><main></main></body>')
    const document = dom.window.document
    const resolver: SlotResolver = current => ({ anchor: current.querySelector('main')!, placement: 'append' })
    const registry = new DomSlotRegistry(document, allResolvers(resolver))
    const add = (id: string, priority: number, order = 0): void => {
      registry.register({ name: 'composer.before', id, priority, order }, ({ container }) => { container.textContent = id })
    }
    add('later', 10, 30)
    add('ordered-second', -10, 20)
    add('first', 10, 10)
    add('middle', 0, 20)
    const ids = [...document.querySelectorAll('[data-cordisx-contribution]')]
      .map(element => element.getAttribute('data-cordisx-contribution'))
    expect(ids).toEqual(['first', 'ordered-second', 'middle', 'later'])
    registry.dispose()
  })

  it('shadows the same id by priority and restores the next entry on unload', () => {
    const dom = new JSDOM('<body><main></main></body>')
    const document = dom.window.document
    const resolver: SlotResolver = current => ({ anchor: current.querySelector('main')!, placement: 'append' })
    const registry = new DomSlotRegistry(document, allResolvers(resolver))
    let highDisposals = 0
    let lowDisposals = 0
    const removeHigh = registry.register({ name: 'composer.before', id: 'same', priority: 10 }, ({ container }) => {
      container.textContent = 'high'
      return () => { highDisposals += 1 }
    })
    const removeLow = registry.register({ name: 'composer.before', id: 'same', priority: -10 }, ({ container }) => {
      container.textContent = 'low'
      return () => { lowDisposals += 1 }
    })

    expect(document.querySelectorAll('[data-cordisx-contribution="same"]')).toHaveLength(1)
    expect(document.querySelector('[data-cordisx-contribution="same"]')?.textContent).toBe('low')
    expect(highDisposals).toBe(1)
    expect(() => registry.register(
      { name: 'composer.before', id: 'same', priority: -10 },
      () => undefined,
    )).toThrow(/at priority -10/)

    removeLow()
    expect(lowDisposals).toBe(1)
    expect(document.querySelector('[data-cordisx-contribution="same"]')?.textContent).toBe('high')

    removeHigh()
    expect(highDisposals).toBe(2)
    registry.dispose()
  })
})
