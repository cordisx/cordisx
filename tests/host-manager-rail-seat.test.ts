import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { resolveManagerRailSeat } from '../packages/cli/src/renderer/host-probes.js'

function railDocument(): Document {
  const document = new JSDOM(`<!doctype html><body>
    <nav data-app-navigation-rail="true" aria-label="应用导航">
      <div aria-hidden="true"></div>
      <div class="flex flex-col gap-2">
        <div class="flex shrink-0 items-center">
          <button type="button" data-sidebar-destination="builtin:home" aria-current="page">首页</button>
        </div>
        <div class="contents">
          <button type="button" data-sidebar-destination="builtin:automations">定时任务</button>
        </div>
        <button type="button" data-sidebar-destination="builtin:library">资料库</button>
      </div>
    </nav>
  </body>`).window.document
  for (const element of document.querySelectorAll('nav,button')) {
    element.getClientRects = () => ({ length: 1 }) as DOMRectList
  }
  return document
}

describe('26.924 Manager rail seat', () => {
  it('inserts after the native Home item and before the next native item without moving either button', () => {
    const document = railDocument()
    const home = document.querySelector<HTMLButtonElement>('[data-sidebar-destination="builtin:home"]')!
    const automations = document.querySelector<HTMLButtonElement>('[data-sidebar-destination="builtin:automations"]')!
    const seat = resolveManagerRailSeat(document)
    expect(seat?.homeButton).toBe(home)
    expect(seat?.before.contains(automations)).toBe(true)

    const managerItem = document.createElement('div')
    managerItem.setAttribute('data-cordisx-manager-rail-item', 'true')
    seat!.container.insertBefore(managerItem, seat!.before)
    expect([...seat!.container.children].slice(0, 3)).toEqual([
      home.parentElement,
      managerItem,
      automations.parentElement,
    ])
    expect(home.parentElement?.firstElementChild).toBe(home)
    expect(automations.parentElement?.firstElementChild).toBe(automations)
    expect(resolveManagerRailSeat(document)).toEqual(seat)

    managerItem.remove()
    expect(resolveManagerRailSeat(document)).toEqual(seat)
  })

  it('rejects duplicate, misplaced, and untagged items between Home and Automations', () => {
    const document = railDocument()
    const seat = resolveManagerRailSeat(document)!
    const managerItem = document.createElement('div')
    managerItem.setAttribute('data-cordisx-manager-rail-item', 'true')
    seat.container.insertBefore(managerItem, seat.before)

    const duplicate = managerItem.cloneNode(true)
    managerItem.after(duplicate)
    expect(resolveManagerRailSeat(document)).toBeUndefined()
    duplicate.remove()

    managerItem.removeAttribute('data-cordisx-manager-rail-item')
    expect(resolveManagerRailSeat(document)).toBeUndefined()
    managerItem.setAttribute('data-cordisx-manager-rail-item', 'true')
    seat.before.after(managerItem)
    expect(resolveManagerRailSeat(document)).toBeUndefined()
  })

  it('fails closed when the rail or its native anchors are ambiguous', () => {
    const document = railDocument()
    const rail = document.querySelector('nav')!
    rail.after(rail.cloneNode(true))
    expect(resolveManagerRailSeat(document)).toBeUndefined()
    rail.nextElementSibling?.remove()

    const duplicateHome = document.querySelector<HTMLButtonElement>('[data-sidebar-destination="builtin:home"]')!
      .cloneNode(true)
    rail.append(duplicateHome)
    expect(resolveManagerRailSeat(document)).toBeUndefined()
  })

  it('rejects a changed order, hidden anchor, or legacy text-only rail', () => {
    const document = railDocument()
    const home = document.querySelector<HTMLButtonElement>('[data-sidebar-destination="builtin:home"]')!
    const automations = document.querySelector<HTMLButtonElement>('[data-sidebar-destination="builtin:automations"]')!
    const library = document.querySelector<HTMLButtonElement>('[data-sidebar-destination="builtin:library"]')!

    automations.parentElement!.before(library)
    expect(resolveManagerRailSeat(document)).toBeUndefined()
    home.parentElement!.after(automations.parentElement!)
    automations.getClientRects = () => ({ length: 0 }) as DOMRectList
    expect(resolveManagerRailSeat(document)).toBeUndefined()
    automations.getClientRects = () => ({ length: 1 }) as DOMRectList
    home.removeAttribute('data-sidebar-destination')
    expect(resolveManagerRailSeat(document)).toBeUndefined()
  })
})
