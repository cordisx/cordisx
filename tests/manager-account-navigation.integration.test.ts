import path from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import type { CordisXRuntimeHandle } from '../packages/cli/src/renderer/runtime-shared.js'
import { exactDomPermissionPolicies, installPermissionPolicyBridge } from './helpers/dom-permission.js'

describe('Manager account navigation without a native router', () => {
  it.each(['allow-persistent', 'ask', 'deny-persistent'] as const)(
    'preserves account discovery and mounting boundaries for %s in the production composition',
    async policy => {
      const root = path.resolve(import.meta.dirname, '..')
      const id = 'account-fixture'
      const entry = path.join(root, 'tests/fixtures/manager-account-navigation-plugin.ts')
      const bundle = await buildRendererBundle({
        version: 1,
        rootDir: root,
        codex: { debugPort: 9229 },
        providers: [],
        plugins: [{ id, entry, enabled: true, config: {} }],
      }, {
        profileId: 'account-test',
        permission: {
          profileId: 'account-test',
          bridgeToken: '1'.repeat(64),
          policies: exactDomPermissionPolicies('account-test', [{
            id,
            entry,
            pointIds: ['manager.content', 'manager.settings.navigation-items'],
          }]).map(record => ({ ...record, policy })),
        },
      })
      // Native URL selects the real Codex router adapter. No navigator is supplied.
      // This is a DOM/runtime simulation, not evidence from an actual Desktop App.
      const dom = new JSDOM('<html><body><div id="root"></div></body></html>', {
        runScripts: 'dangerously',
        url: 'app://-/index.html',
      })
      Object.assign(dom.window, { structuredClone })
      installPermissionPolicyBridge(dom.window)
      let runtime: CordisXRuntimeHandle | undefined
      try {
        dom.window.eval(bundle)
        await (dom.window as unknown as { __cordisxBoot: Promise<unknown> }).__cordisxBoot
        runtime = (dom.window as unknown as { __cordisxRuntime: CordisXRuntimeHandle }).__cordisxRuntime
        const snapshot = runtime.snapshot()
        expect(snapshot.plugins).toContainEqual(expect.objectContaining({ id, status: 'active' }))
        expect(snapshot.navigation.routes).toContainEqual(expect.objectContaining({
          qualifiedId: `${id}:manager`,
          valid: true,
          authorized: policy === 'allow-persistent',
        }))
        const body = dom.window.document.createElement('section')
        dom.window.document.body.append(body)
        if (policy !== 'allow-persistent') {
          if (policy === 'ask') {
            expect(snapshot.settingsNavigationItems).toContainEqual(expect.objectContaining({
              id: `${id}:manager`,
              permissionReview: expect.objectContaining({ capability: 'ui.extension-points.render' }),
            }))
          } else {
            expect(snapshot.settingsNavigationItems).toEqual([])
          }
          await expect(runtime.mountManagerContent(`${id}:manager`, { id: 'manager' }, body, {
            navigate() {},
            back() {},
          })).rejects.toThrow()
          expect(body.querySelector('[data-account-details]')).toBeNull()
          return
        }
        expect(snapshot.settingsNavigationItems).toContainEqual(expect.objectContaining({
          id: `${id}:manager`,
          navigationGroup: 'external-accounts',
          disabled: false,
        }))
        const mount = await runtime.mountManagerContent(`${id}:manager`, { id: 'manager' }, body, {
          navigate() {},
          back() {},
        })
        expect(body.querySelector('[data-account-details]')?.textContent).toBe('Authentication details')
        await runtime.setPluginBlocked(id, true)
        expect(runtime.snapshot().settingsNavigationItems).toEqual([])
        expect(body.querySelector('[data-account-details]')).toBeNull()
        await mount.dispose()
      } finally {
        await runtime?.dispose()
        dom.window.close()
      }
    },
  )
})
