import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { resolveManagerTitlebarSeat } from '../packages/cli/src/renderer/host-probes.js'
import { managerHeaderBackRoute } from '../packages/cli/src/renderer/manager/model/header-navigation.js'

function titlebarFixture() {
  const document = new JSDOM(`<!doctype html><body>
    <header data-app-shell-titlebar="true">
      <div data-app-shell-header-slot="start"><button>Back</button><button>Forward</button></div>
      <div data-app-shell-main-titlebar="true" data-testid="app-shell-header-context-menu-surface">
        <div data-app-shell-titlebar-slot="main" data-app-shell-focus-area="main">
          <span id="native-title">Native title</span>
        </div>
      </div>
      <div data-app-shell-header-slot="end"><button>Window action</button></div>
    </header>
  </body>`).window.document
  const bar = document.querySelector<HTMLElement>('header')!
  const start = document.querySelector<HTMLElement>('[data-app-shell-header-slot="start"]')!
  const end = document.querySelector<HTMLElement>('[data-app-shell-header-slot="end"]')!
  const slot = document.querySelector<HTMLElement>('[data-app-shell-titlebar-slot="main"]')!
  const native = document.getElementById('native-title')!
  const rect = (left: number, width: number): DOMRect =>
    ({ left, top: 0, right: left + width, bottom: 44, width, height: 44 }) as DOMRect
  for (const element of [bar, start, end, slot]) {
    element.getClientRects = () => ({ length: 1 }) as DOMRectList
  }
  bar.getBoundingClientRect = () => rect(0, 1719)
  start.getBoundingClientRect = () => rect(0, 290)
  slot.getBoundingClientRect = () => rect(290, 1393)
  end.getBoundingClientRect = () => rect(1683, 36)
  return { document, bar, start, end, slot, native, rect }
}

describe('26.924 Manager titlebar seat', () => {
  it('resolves the unique main title slot without altering native controls', () => {
    const fixture = titlebarFixture()
    const before = fixture.document.body.innerHTML
    expect(resolveManagerTitlebarSeat(fixture.document)).toEqual({
      slot: fixture.slot,
      native: [fixture.native],
      bounds: { left: 290, top: 0, width: 1393, height: 44 },
    })
    expect(fixture.document.body.innerHTML).toBe(before)
    const seat = fixture.document.createElement('div')
    seat.dataset.cordisxManagerTitlebarSeat = 'true'
    fixture.slot.append(seat)
    expect(resolveManagerTitlebarSeat(fixture.document)?.native).toEqual([fixture.native])
  })

  it('bounds an overlaid 36px native end control instead of rejecting the main slot', () => {
    const fixture = titlebarFixture()
    fixture.slot.getBoundingClientRect = () => fixture.rect(290, 1429)
    expect(resolveManagerTitlebarSeat(fixture.document)?.bounds).toEqual({
      left: 290,
      top: 0,
      width: 1393,
      height: 44,
    })
    fixture.end.getBoundingClientRect = () => fixture.rect(1600, 119)
    expect(resolveManagerTitlebarSeat(fixture.document)).toBeUndefined()
  })

  it('fails closed when the title slot is ambiguous, displaced, or the Host seat is misplaced', () => {
    const fixture = titlebarFixture()
    const duplicate = fixture.bar.cloneNode(true) as HTMLElement
    fixture.bar.after(duplicate)
    expect(resolveManagerTitlebarSeat(fixture.document)).toBeUndefined()
    duplicate.remove()
    fixture.slot.getBoundingClientRect = () => fixture.rect(250, 1393)
    expect(resolveManagerTitlebarSeat(fixture.document)).toBeUndefined()
    fixture.slot.getBoundingClientRect = () => fixture.rect(290, 1393)
    const seat = fixture.document.createElement('div')
    seat.dataset.cordisxManagerTitlebarSeat = 'true'
    fixture.slot.prepend(seat)
    expect(resolveManagerTitlebarSeat(fixture.document)).toBeUndefined()
    seat.remove()
    fixture.bar.removeAttribute('data-app-shell-titlebar')
    expect(resolveManagerTitlebarSeat(fixture.document)).toBeUndefined()
  })
})

describe('Manager leading control', () => {
  it('keeps primary and contributed roots as identity marks', () => {
    expect(managerHeaderBackRoute({ kind: 'primary', page: 'plugins' })).toBeUndefined()
    expect(managerHeaderBackRoute({ kind: 'manager-content', id: 'team', reference: { id: 'team' } }))
      .toBeUndefined()
  })

  it('exposes Back only for a known internal parent', () => {
    expect(managerHeaderBackRoute({ kind: 'plugin', pluginId: 'gateway', page: 'config' })).toEqual({
      kind: 'primary',
      page: 'plugins',
    })
    expect(managerHeaderBackRoute({ kind: 'marketplace-source-edit', url: 'https://example.com' })).toEqual({
      kind: 'marketplace-sources',
    })
    expect(managerHeaderBackRoute({ kind: 'model-connection-create' })).toEqual({
      kind: 'primary',
      page: 'model-services',
    })
    expect(managerHeaderBackRoute(
      { kind: 'manager-content', id: 'team', reference: { id: 'detail' } },
      { id: 'team' },
    )).toEqual({ kind: 'manager-content', id: 'team', reference: { id: 'team' } })
    expect(managerHeaderBackRoute(
      { kind: 'notification-rules' },
      undefined,
      { kind: 'primary', page: 'plugins' },
    )).toEqual({ kind: 'primary', page: 'plugins' })
  })
})
