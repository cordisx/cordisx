import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'

describe('public Connector client plugin integration', () => {
  it('injects a principal-bound client into a plugin, keeps native Codex unavailable, and revokes it with the owner', async () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const baseConfig = await loadConfig(path.join(projectRoot, 'cordisx.config.example.json'))
    const entry = path.join(projectRoot, 'tests/fixtures/connector-public-client-plugin.ts')
    const bundle = await buildRendererBundle({
      ...baseConfig,
      plugins: [{ id: 'connector-public-client', entry, enabled: true, config: {} }],
    })
    const dom = new JSDOM(
      '<html><body><div class="sidebar-header"><button id="workspace-switcher">Codex</button></div></body></html>',
      {
        runScripts: 'dangerously',
        url: 'https://codex.local/',
      },
    )
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    dom.window.eval(bundle)
    await (dom.window as unknown as { __cordisxBoot?: Promise<unknown> }).__cordisxBoot
    for (
      let attempt = 0;
      attempt < 30 && dom.window.document.documentElement.dataset.connectorPublicClientMounted !== 'true';
      attempt += 1
    ) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const fixture = (dom.window as unknown as {
      __cordisxConnectorPublicClientFixture?: {
        client: {
          discover(): Promise<
            {
              status: string
              authorization: unknown
              snapshot?: {
                registrations: readonly {
                  registration: { registrationId: string; connectorId: string; generation: number }
                }[]
              }
            }
          >
          subscribe(
            registration: { registrationId: string; connectorId: string; generation: number },
            afterSequence: number,
          ): Promise<{ result: { status: string }; handle?: unknown }>
        }
      }
      __cordisxRuntime?: {
        dispose(): Promise<void>
        snapshot(): { plugins: readonly { status: string; error?: string }[] }
        setPermissionPolicy(id: string, capability: 'agent.events.read', policy: 'allow' | 'deny'): Promise<void>
      }
    }).__cordisxConnectorPublicClientFixture
    expect(
      (dom.window as unknown as {
        __cordisxRuntime?: { snapshot(): { plugins: readonly { status: string; error?: string }[] } }
      }).__cordisxRuntime?.snapshot().plugins,
    )
      .toMatchObject([{ status: 'active' }])
    expect(dom.window.document.documentElement.dataset.connectorPublicClientMounted).toBe('true')
    const runtime = (dom.window as unknown as {
      __cordisxRuntime?: {
        setPermissionPolicy(id: string, capability: 'agent.events.read', policy: 'allow' | 'deny'): Promise<void>
      }
    }).__cordisxRuntime
    await expect(fixture?.client.discover()).resolves.toMatchObject({
      status: 'denied',
      authorization: { code: 'policy-denied' },
    })
    await runtime?.setPermissionPolicy('connector-public-client', 'agent.events.read', 'deny')
    await expect(fixture?.client.discover()).resolves.toMatchObject({
      status: 'denied',
      authorization: { code: 'policy-denied' },
    })
    await runtime?.setPermissionPolicy('connector-public-client', 'agent.events.read', 'allow')
    const discovery = await fixture?.client.discover()
    const registration = discovery?.status === 'accepted'
      ? discovery.snapshot?.registrations[0]?.registration
      : undefined
    const subscription = registration === undefined
      ? undefined
      : await fixture?.client.subscribe(registration, -1)
    expect(discovery).toMatchObject({
      status: 'accepted',
      snapshot: { registrations: [{ availability: 'unavailable', unavailableCode: 'unsupported' }] },
    })
    expect(subscription).toMatchObject({ result: { status: 'unavailable' } })
    expect(subscription?.handle).toBeUndefined()
    expect(JSON.stringify(discovery)).not.toMatch(/principal|caller|bridge|transport/i)

    const client = fixture?.client
    await (dom.window as unknown as { __cordisxRuntime?: { dispose(): Promise<void> } }).__cordisxRuntime?.dispose()
    await expect(client?.discover()).resolves.toMatchObject({
      status: 'unavailable',
      authorization: { code: 'principal-unavailable' },
    })
    expect(dom.window.document.documentElement.dataset.connectorPublicClientMounted).toBeUndefined()
    dom.window.close()
  })
})
