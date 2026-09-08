import { Context } from '@deepseek-ai/cordis'
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import type { CordisXPageMountContext } from '../packages/cli/src/contracts.js'
import { CordisXEntitySettingsNavigationService } from '../packages/cli/src/renderer/entity-settings-navigation.js'
import { BrowserRouteHistoryAdapter } from '../packages/cli/src/renderer/codex-router-history.js'
import { NavigationRegistry, OutletRegistry, PageRegistry } from '../packages/cli/src/renderer/navigation.js'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from '../packages/cli/src/renderer/ownership.js'
import { fakeI18n, FakeOutlet } from './suites/navigation.fixtures.js'

it('resolves exact entity settings again on open and fences disposed caller/service without leaking targets', async () => {
  const context = new Context()
  const identity = { agentId: 'agent', revision: 'frozen' }
  const target = { contributionId: 'private', root: { id: 'root' }, target: { id: 'exact' } }
  let available = true
  const open = vi.fn()
  const resolve = vi.fn(value =>
    available && value.agentId === identity.agentId && value.revision === identity.revision ? target : undefined
  )
  const service = context.plugin(CordisXEntitySettingsNavigationService, { resolve, open })
  await service
  let navigation!: typeof context.entitySettingsNavigation
  const caller = context.extend({ [CORDISX_PLUGIN_ID]: 'chatroom', [CORDISX_PLUGIN_SOURCE]: 'file:///source-a' })
    .plugin(Object.assign((ctx: Context) => {
      navigation = ctx.entitySettingsNavigation
    }, { inject: ['entitySettingsNavigation'] }))
  await caller
  expect(await navigation.get({ identity })).toEqual({ status: 'available' })
  expect(open).not.toHaveBeenCalled()
  available = false
  expect(await navigation.open({ identity })).toEqual({ status: 'unavailable', code: 'target-unavailable' })
  expect(open).not.toHaveBeenCalled()
  available = true
  expect(await navigation.open({ identity: { ...identity, revision: 'latest' } })).toMatchObject({
    status: 'unavailable',
  })
  expect(await navigation.open({ identity, source: 'forged' } as never)).toEqual({
    status: 'unavailable',
    code: 'invalid-identity',
  })
  expect(await navigation.open({ identity })).toEqual({ status: 'accepted', code: 'opened' })
  expect(open).toHaveBeenCalledExactlyOnceWith(target)
  await caller.dispose()
  expect(await navigation.open({ identity })).toEqual({ status: 'unavailable', code: 'caller-unavailable' })
  await service.dispose()
  expect(await navigation.get({ identity })).toEqual({ status: 'unavailable', code: 'host-unavailable' })
  expect(open).toHaveBeenCalledTimes(1)
})

it('page link resolution returns the same Host canonical link without navigation and expires with the mount', async () => {
  const dom = new JSDOM('<main></main>', { url: 'https://host.example/profile/index.html' })
  const view = dom.window as unknown as Window
  const pages = new PageRegistry()
  const outlets = new OutletRegistry()
  const outlet = new FakeOutlet(dom.window.document.querySelector('main')!)
  outlets.declare(
    {
      schemaVersion: 1,
      id: 'main',
      authority: 'host-adapter',
      scope: 'main',
      preferredPlacement: 'portal',
      contextPolicy: 'semantic',
    },
    outlet,
    path => path.startsWith('/main/'),
  )
  view.history.replaceState({ key: 'native-0', idx: 0 }, '')
  const history = new BrowserRouteHistoryAdapter(view)
  const registry = new NavigationRegistry(pages, outlets, fakeI18n(), history)
  let mounted!: CordisXPageMountContext
  pages.register('chatroom', { id: 'room', title: { key: 'room' }, chrome: 'body-only' }, context => {
    mounted = context
  })
  const unregister = registry.register('chatroom', {
    id: 'room',
    path: '/main/rooms/:roomId',
    outlet: 'main',
    page: 'room',
  })
  const route = { id: 'room', params: { roomId: 'same/name 空格' } }
  await registry.navigate('chatroom', route)
  await registry.settled()
  const snapshot = history.snapshot()
  const shows = outlet.shows
  const resolveLink = mounted.navigation.resolveLink!
  const result = await resolveLink(route)
  expect(result).toEqual({ status: 'accepted', url: registry.deepLink('chatroom', route) })
  expect(history.snapshot()).toEqual(snapshot)
  expect(outlet.shows).toBe(shows)
  expect(await resolveLink({ ...route, owner: 'foreign' } as never)).toMatchObject({ code: 'invalid-route' })
  expect(await registry.resolveLink('foreign', route)).toMatchObject({ code: 'route-unavailable' })
  unregister()
  await registry.settled()
  expect(await resolveLink(route)).toEqual({ status: 'unavailable', code: 'caller-unavailable' })
  await registry.dispose()
  expect(await registry.resolveLink('chatroom', route)).toEqual({ status: 'unavailable', code: 'host-unavailable' })
  outlets.dispose()
  pages.dispose()
  history.dispose()
  dom.window.close()
})
