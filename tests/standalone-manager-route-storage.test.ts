import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'
import {
  readStandaloneManagerRoute,
  writeStandaloneManagerRoute,
} from '../packages/cli/src/renderer/manager/model/standalone-route-storage.js'

it('restores safe standalone destinations without persisting route parameters or edit URLs', () => {
  const dom = new JSDOM('', { url: 'http://127.0.0.1:43123/' })
  const storage = dom.window.sessionStorage
  try {
    writeStandaloneManagerRoute(storage, { kind: 'primary', page: 'model-services' })
    expect(readStandaloneManagerRoute(storage)).toEqual({ kind: 'primary', page: 'model-services' })
    const pluginRoute = { kind: 'manager-content', id: 'channel:settings', reference: { id: 'settings' } } as const
    writeStandaloneManagerRoute(storage, pluginRoute)
    expect(readStandaloneManagerRoute(storage)).toEqual(pluginRoute)
    writeStandaloneManagerRoute(storage, {
      ...pluginRoute,
      reference: { id: 'settings', params: { token: 'sensitive-fixture' } },
    })
    expect(readStandaloneManagerRoute(storage)).toEqual({ kind: 'primary', page: 'plugins' })
    expect(storage.getItem('cordisx.standalone.manager.route.v1')).not.toContain('sensitive-fixture')
    writeStandaloneManagerRoute(storage, {
      kind: 'marketplace-source-edit',
      url: 'https://example.test/?token=fixture',
    })
    expect(readStandaloneManagerRoute(storage)).toEqual({ kind: 'primary', page: 'marketplace' })
    expect(storage.getItem('cordisx.standalone.manager.route.v1')).not.toContain('fixture')
  } finally {
    dom.window.close()
  }
})

it('ignores malformed and unavailable storage', () => {
  const dom = new JSDOM('', { url: 'http://127.0.0.1:43123/' })
  try {
    const storage = dom.window.sessionStorage
    storage.setItem('cordisx.standalone.manager.route.v1', '{"kind":"primary","page":"unknown"}')
    expect(readStandaloneManagerRoute(storage)).toBeUndefined()
    storage.setItem('cordisx.standalone.manager.route.v1', '{"kind":"primary","page":["plugins"]}')
    expect(readStandaloneManagerRoute(storage)).toBeUndefined()
    storage.setItem('cordisx.standalone.manager.route.v1', 'x'.repeat(2049))
    expect(readStandaloneManagerRoute(storage)).toBeUndefined()
    const unavailable = {
      getItem: () => {
        throw new Error('disabled')
      },
      setItem: () => {
        throw new Error('disabled')
      },
    } as unknown as Storage
    expect(readStandaloneManagerRoute(unavailable)).toBeUndefined()
    expect(() => writeStandaloneManagerRoute(unavailable, { kind: 'primary', page: 'plugins' })).not.toThrow()
  } finally {
    dom.window.close()
  }
})
