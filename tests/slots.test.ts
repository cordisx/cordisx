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
      id: 'demo',
      slot: 'composer.before',
      mount({ container }) {
        mounts += 1
        container.textContent = `mount-${mounts}`
        return () => { disposals += 1 }
      },
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

  it('orders contributions by priority and then registration', () => {
    const dom = new JSDOM('<body><main></main></body>')
    const document = dom.window.document
    const resolver: SlotResolver = current => ({ anchor: current.querySelector('main')!, placement: 'append' })
    const registry = new DomSlotRegistry(document, allResolvers(resolver))
    const add = (id: string, priority: number): void => {
      registry.register({ id, priority, slot: 'composer.before', mount({ container }) { container.textContent = id } })
    }
    add('later', 10)
    add('first', -10)
    add('middle', 0)
    const ids = [...document.querySelectorAll('[data-cordisx-contribution]')]
      .map(element => element.getAttribute('data-cordisx-contribution'))
    expect(ids).toEqual(['first', 'middle', 'later'])
    registry.dispose()
  })
})
