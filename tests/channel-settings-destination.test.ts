import { describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { managerSnapshot } from './helpers/react-manager.js'
import {
  availableChannelSettingsDestination,
  channelSettingsDestinations,
  registerChannelSettingsDestination,
  subscribeChannelSettingsDestinations,
} from '../packages/cli/src/renderer/channel-settings-destination.js'

describe('actual available own Channel settings destination', () => {
  it('restores the Host fallback on revocation, missing page, source replacement or retirement', () => {
    const dom = new JSDOM(), document = dom.window.document, changed = vi.fn()
    const unsubscribe = subscribeChannelSettingsDestinations(document, changed)
    let live = true
    const dispose = registerChannelSettingsDestination(document, {
      owner: 'channel',
      source: 'file:///candidate',
      routeId: 'preferences-defaults',
      live: () => live,
    })
    let snapshot = managerSnapshot({
      settingsNavigationItems: [{ id: 'channel:channels', owner: 'channel', disabled: false }] as never,
      plugins: [{ id: 'channel', source: 'file:///candidate', status: 'active' }] as never,
      navigation: {
        routes: [{
          owner: 'channel',
          id: 'preferences-defaults',
          valid: true,
          authorized: true,
          effectivePointPolicy: 'allow',
          definition: {
            outlet: 'manager.content',
            path: '/manager/channel/preferences/new-chats',
            page: 'preferences-defaults',
          },
        }] as never,
        pages: [{ owner: 'channel', id: 'preferences-defaults' }] as never,
        outlets: [],
      },
    })
    const available = () => availableChannelSettingsDestination(snapshot, channelSettingsDestinations(document))
    expect(available()?.routeId).toBe('preferences-defaults')
    const original = snapshot
    snapshot = {
      ...original,
      navigation: {
        ...original.navigation,
        routes: original.navigation.routes.map(route => ({ ...route, authorized: false })),
      },
    }
    expect(available()).toBeUndefined()
    snapshot = { ...original, navigation: { ...original.navigation, pages: [] } }
    expect(available()).toBeUndefined()
    snapshot = { ...original, plugins: original.plugins.map(plugin => ({ ...plugin, source: 'file:///other' })) }
    expect(available()).toBeUndefined()
    snapshot = original
    live = false
    expect(available()).toBeUndefined()
    live = true
    dispose()
    dispose()
    expect(available()).toBeUndefined()
    expect(changed).toHaveBeenCalledTimes(2)
    unsubscribe()
    dom.window.close()
  })
})
