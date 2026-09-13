import { JSDOM } from 'jsdom'
import { expect, test, vi } from 'vitest'
import { createPageHeaderBreadcrumbs } from '../packages/cli/src/renderer/page-header-breadcrumbs.js'
import type { CordisXLocalizedText, CordisXRouteReference } from '../packages/cli/src/contracts.js'

test('renders live room breadcrumbs, keeps one Back button, owner navigation and ellipsis, and fences retired mounts', async () => {
  const dom = new JSDOM('<header><div id="leading">icon</div><strong>对局房间</strong></header>')
  const document = dom.window.document
  const leading = document.getElementById('leading')!
  const title = document.querySelector('strong')!
  const navigate = vi.fn(async (_reference: CordisXRouteReference) => {})
  const report = vi.fn()
  let active = true
  let language = '游戏大厅'
  const controller = createPageHeaderBreadcrumbs({
    leading,
    title,
    active: () => active,
    button: () => {
      const button = document.createElement('button')
      button.textContent = 'Back'
      return button
    },
    resolve: message => message.key === 'lobby' ? language : message.fallback ?? message.key,
    navigate,
    report,
  })
  expect(controller.render()).toBe(false)
  const items = [{ key: 'lobby' }, { key: 'room-name', fallback: '真实房间🏠'.repeat(20) }]
  expect(controller.update(items, { id: 'lobby' })).toBe(true)
  const button = leading.querySelector('button')!
  expect(title.textContent).toBe('游戏大厅/' + items[1]!.fallback)
  expect(title.querySelector('[aria-current="page"]')?.textContent).toBe(items[1]!.fallback)
  expect(title.querySelector('[aria-current="page"]')?.getAttribute('style')).toContain('text-overflow: ellipsis')
  button.click()
  await Promise.resolve()
  expect(navigate).toHaveBeenLastCalledWith({ id: 'lobby' })
  items[1]!.fallback = 'mutated caller'
  language = 'Lobby'
  controller.render()
  expect(title.textContent).not.toContain('mutated caller')
  expect(title.textContent).toContain('Lobby/')
  expect(
    controller.update([{ key: 'lobby' }, { key: 'room-name', fallback: 'Updated room' }], {
      id: 'lobby',
      params: { tab: 'public' },
    }),
  ).toBe(true)
  expect(leading.querySelector('button')).toBe(button)
  button.click()
  expect(navigate).toHaveBeenLastCalledWith({ id: 'lobby', params: { tab: 'public' } })
  const stable = title.textContent
  for (
    const invalid of [[], Array(9).fill({ key: 'room' }), [{ key: 'room', html: '<b>unsafe</b>' }], [{
      key: 'room',
      fallback: 'A'.repeat(16385),
    }]]
  ) {
    expect(controller.update(invalid as readonly CordisXLocalizedText[], { id: 'lobby' })).toBe(false)
  }
  expect(controller.update([{ key: 'room' }], { id: 'lobby', params: { bad: {} } } as unknown as CordisXRouteReference))
    .toBe(false)
  expect(title.textContent).toBe(stable)
  navigate.mockRejectedValueOnce(Error('owner policy denied'))
  button.click()
  await Promise.resolve()
  await Promise.resolve()
  expect(report).toHaveBeenCalledOnce()
  active = false
  expect(controller.update([{ key: 'room' }], { id: 'lobby' })).toBe(false)
  const count = navigate.mock.calls.length
  button.click()
  expect(navigate).toHaveBeenCalledTimes(count)
  active = true
  controller.dispose()
  expect(controller.update([{ key: 'room' }], { id: 'lobby' })).toBe(false)
  button.click()
  expect(navigate).toHaveBeenCalledTimes(count)
  dom.window.close()
})
