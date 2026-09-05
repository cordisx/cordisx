import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
  type CordisXPermissionAuthorizationDecisionV1,
  type CordisXPermissionAuthorizationPlanV1,
} from '../packages/cli/src/contracts.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'

describe('Platform runtime activation', () => {
  it('blocks a required denied capability and mounts fresh after policy recovery', async () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const baseConfig = await loadConfig(path.join(projectRoot, 'cordisx.config.example.json'))
    const entry = path.join(projectRoot, 'tests/fixtures/agent-events-required-plugin.ts')
    const config = {
      ...baseConfig,
      plugins: [{ id: 'agent-events-required', entry, enabled: true, config: {} }],
    }
    const bundle = await buildRendererBundle(config)
    const dom = new JSDOM(
      `
      <html lang="en"><head></head><body>
        <div class="sidebar-header"><button id="workspace-switcher" aria-haspopup="menu">Codex</button></div>
      </body></html>
    `,
      { runScripts: 'dangerously', url: 'https://codex.local/' },
    )
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })

    const identityKey = JSON.stringify([pathToFileURL(entry).href, 'agent-events-required'])
    const fingerprint = JSON.stringify({
      name: 'agent.events.read',
      required: true,
      reason: { key: 'permission.required', fallback: 'Agent events are required for this fixture' },
      scope: {},
    })
    dom.window.localStorage.setItem(
      'cordisx.platform.permissionPolicies.v1',
      JSON.stringify([{
        identityKey,
        capability: 'agent.events.read',
        fingerprint,
        policy: 'deny',
      }]),
    )

    dom.window.eval(bundle)
    for (
      let attempt = 0;
      attempt < 20 && dom.window.document.documentElement.dataset.cordisxReady !== 'true';
      attempt += 1
    ) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const runtime = (dom.window as unknown as {
      __cordisxRuntime?: {
        snapshot(): {
          plugins: readonly { id: string; status: string; blockedReason?: string }[]
          permissions: readonly {
            capability: string
            policy: string
            blockedReason?: string
            availability: { status: string; reasonText: string; providers: readonly { providerId: string }[] }
          }[]
        }
        permissionAuthorizationPlan(id: string): CordisXPermissionAuthorizationPlanV1
        authorizePlugin(id: string, decision: CordisXPermissionAuthorizationDecisionV1): Promise<void>
        setPluginBlocked(id: string, blocked: boolean): Promise<void>
        setPermissionPolicy(id: string, capability: 'agent.events.read', policy: 'allow'): Promise<void>
        dispose(): Promise<void>
      }
    }).__cordisxRuntime
    expect(runtime?.snapshot().plugins[0]).toMatchObject({
      id: 'agent-events-required',
      status: 'permission-blocked',
      blockedReason: 'Required capability denied: agent.events.read',
    })
    expect(runtime?.snapshot().permissions[0]).toMatchObject({
      capability: 'agent.events.read',
      policy: 'deny',
      blockedReason: 'Required capability agent.events.read is denied',
      availability: { status: 'supported', providers: [{ providerId: 'host-agent-events' }] },
    })
    expect(runtime?.snapshot().permissions[1]).toMatchObject({
      capability: 'agent.history.read',
      availability: { status: 'unavailable', providers: [{ providerId: 'host-agent-history' }] },
    })
    expect(runtime?.snapshot().permissions[0]?.availability.reasonText).toBe('Available')
    dom.window.document.documentElement.lang = 'zh-CN'
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(runtime?.snapshot().permissions[0]?.availability.reasonText).toBe('当前可用')
    expect(dom.window.document.documentElement.dataset.agentEventsRequiredMounted).toBeUndefined()

    const plan = runtime?.permissionAuthorizationPlan('agent-events-required')
    expect(plan).toMatchObject({
      profileId: 'development',
      defaultDecision: 'allow',
      declarations: [
        { capability: 'agent.events.read', required: true, policy: 'deny' },
        { capability: 'agent.history.read', required: false, policy: 'ask' },
      ],
    })
    if (plan === undefined) throw new Error('authorization plan is unavailable')
    const decide = (
      required: 'allow' | 'allow-once' | 'deny',
    ): CordisXPermissionAuthorizationDecisionV1 => ({
      $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
      schemaVersion: 1,
      planId: plan.planId,
      operation: plan.operation,
      profileId: plan.profileId,
      identity: plan.identity,
      decisions: plan.declarations.map(item => ({
        capability: item.capability,
        scope: item.scope,
        decision: item.capability === 'agent.events.read' ? required : 'deny',
      })),
    })
    await runtime?.authorizePlugin('agent-events-required', decide('allow-once'))
    expect(runtime?.snapshot().plugins[0]?.status).toBe('active')
    expect(runtime?.snapshot().permissions[0]?.policy).toBe('deny')
    expect(dom.window.localStorage.getItem('cordisx.platform.permissionPolicies.v2')).not.toContain('allow-once')
    await runtime?.setPluginBlocked('agent-events-required', true)

    await runtime?.authorizePlugin('agent-events-required', decide('allow'))
    expect(runtime?.snapshot().plugins[0]?.status).toBe('active')
    expect(dom.window.document.documentElement.dataset.agentEventsRequiredMounted).toBe('true')

    await runtime?.dispose()
    expect(dom.window.document.documentElement.dataset.agentEventsRequiredMounted).toBeUndefined()
    dom.window.close()
  })

  it('uses the launcher profile projection and acknowledged narrow RPC for persistent policy changes', async () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const baseConfig = await loadConfig(path.join(projectRoot, 'cordisx.config.example.json'))
    const entry = path.join(projectRoot, 'tests/fixtures/agent-events-required-plugin.ts')
    const config = { ...baseConfig, plugins: [{ id: 'agent-events-required', entry, enabled: true, config: {} }] }
    const identity = { source: pathToFileURL(entry).href, id: 'agent-events-required' }
    const initial = createPermissionPolicyRecord({
      profileId: 'work',
      identity,
      capability: 'agent.events.read',
      scope: {},
      policy: 'allow',
    })
    const token = 'permission-persistence-token'
    const bundle = await buildRendererBundle(config, {
      permission: { profileId: 'work', policies: [initial], bridgeToken: token },
    })
    const dom = new JSDOM(
      `
      <html lang="en"><head></head><body>
        <div class="sidebar-header"><button id="workspace-switcher" aria-haspopup="menu">Codex</button></div>
      </body></html>
    `,
      { runScripts: 'dangerously', url: 'https://codex.local/' },
    )
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    const payloads: Record<string, unknown>[] = []
    Object.defineProperty(dom.window, '__cordisxPermissionPolicyRequestV1', {
      configurable: true,
      value: (text: string) => {
        const payload = JSON.parse(text) as { requestId: string; token: string; records: unknown[] }
        payloads.push(payload as unknown as Record<string, unknown>)
        queueMicrotask(() =>
          (dom.window as unknown as {
            __cordisxPermissionPolicyReceiveV1?: (response: string) => void
          }).__cordisxPermissionPolicyReceiveV1?.(JSON.stringify({
            requestId: payload.requestId,
            ok: true,
            value: payload.records,
          }))
        )
      },
    })
    dom.window.eval(bundle)
    for (
      let attempt = 0;
      attempt < 30 && dom.window.document.documentElement.dataset.cordisxReady !== 'true';
      attempt += 1
    ) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const runtime = (dom.window as unknown as {
      __cordisxRuntime?: {
        snapshot(): { plugins: readonly { status: string }[]; permissions: readonly { policy: string }[] }
        setPermissionPolicy(id: string, capability: 'agent.events.read', policy: 'deny'): Promise<void>
        dispose(): Promise<void>
      }
    }).__cordisxRuntime
    expect(runtime?.snapshot()).toMatchObject({
      plugins: [{ status: 'active' }],
      permissions: [{ policy: 'allow' }, { policy: 'ask' }],
    })
    await runtime?.setPermissionPolicy('agent-events-required', 'agent.events.read', 'deny')
    expect(runtime?.snapshot()).toMatchObject({
      plugins: [{ status: 'permission-blocked' }],
      permissions: [{ policy: 'deny' }, { policy: 'ask' }],
    })
    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toMatchObject({
      token,
      records: [{ key: { profileId: 'work', identity: { pluginId: 'agent-events-required' } }, policy: 'deny' }],
    })
    expect(JSON.stringify(payloads[0])).not.toContain('configPath')
    await runtime?.dispose()
    dom.window.close()
  })

  it('blocks a truly unavailable required capability and restores it from a new provider generation', async () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const baseConfig = await loadConfig(path.join(projectRoot, 'cordisx.config.example.json'))
    const entry = path.join(projectRoot, 'tests/fixtures/platform-required-plugin.ts')
    const plugin = { id: 'platform-required', entry, enabled: true, config: {} }
    const unavailableBundle = await buildRendererBundle({ ...baseConfig, plugins: [plugin] }, {
      generation: 'generation-unavailable',
    })
    const providerBundle = await buildRendererBundle({
      ...baseConfig,
      providers: [{
        id: 'gateway-a',
        kind: 'cli-proxy-api',
        displayName: 'Gateway A',
        baseUrl: 'https://gateway-a.test/v1',
        apiKeyEnv: 'GATEWAY_A_KEY',
        codexExecutable: 'codex',
        codexHome: '/tmp/cordisx-gateway-a',
        enabled: true,
        timeoutMs: 1_000,
      }],
      plugins: [plugin],
    }, {
      providerBridgeToken: 'provider-generation-token',
      generation: 'generation-provider-ready',
    })
    const dom = new JSDOM(
      `
      <html lang="en"><head></head><body>
        <div class="sidebar-header"><button id="workspace-switcher" aria-haspopup="menu">Codex</button></div>
      </body></html>
    `,
      { runScripts: 'dangerously', url: 'https://codex.local/' },
    )
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })

    dom.window.eval(unavailableBundle)
    await (dom.window as unknown as { __cordisxBoot?: Promise<unknown> }).__cordisxBoot
    let runtime = (dom.window as unknown as {
      __cordisxRuntime?: {
        snapshot(): {
          plugins: readonly { status: string; blockedReason?: string }[]
          permissions: readonly {
            capability: string
            availability: { status: string; providers: readonly { providerId: string }[] }
          }[]
        }
        dispose(): Promise<void>
      }
    }).__cordisxRuntime
    expect(runtime?.snapshot().plugins[0]).toMatchObject({
      status: 'permission-blocked',
      blockedReason: 'Required capability unavailable: models.read',
    })
    expect(runtime?.snapshot().permissions[0]).toMatchObject({
      capability: 'models.read',
      availability: { status: 'unavailable' },
    })
    expect(dom.window.document.documentElement.dataset.platformRequiredMounted).toBeUndefined()

    Object.defineProperty(dom.window, '__cordisxProviderRequestV1', {
      configurable: true,
      value: (payload: string) => {
        const request = JSON.parse(payload) as { requestId: string; token: string; operation: string }
        expect(request.token).toBe('provider-generation-token')
        const value = request.operation === 'status'
          ? {
            hostId: 'cordisx-provider-fleet',
            hostName: 'CordisX External Provider Fleet',
            mode: 'read-write',
            supportedCapabilities: [
              'models.read',
              'tasks.catalog.read',
              'tasks.content.read',
              'tasks.create',
              'tasks.control',
              'turns.submit',
              'turns.control',
            ],
            diagnostics: [],
            secondConnectionCreated: false,
            rawBridgeExposed: false,
          }
          : request.operation === 'availability'
          ? [{ providerId: 'gateway-a', displayName: 'Gateway A', generation: 'provider-a-1', state: 'ready' }]
          : undefined
        queueMicrotask(() =>
          (dom.window as unknown as {
            __cordisxProviderReceiveV1?: (response: string) => void
          }).__cordisxProviderReceiveV1?.(JSON.stringify({ requestId: request.requestId, ok: true, value }))
        )
      },
    })
    dom.window.eval(providerBundle)
    await (dom.window as unknown as { __cordisxBoot?: Promise<unknown> }).__cordisxBoot
    runtime = (dom.window as unknown as typeof dom.window & {
      __cordisxRuntime?: {
        snapshot(): {
          plugins: readonly { status: string; blockedReason?: string }[]
          permissions: readonly {
            capability: string
            availability: { status: string; providers: readonly { providerId: string }[] }
          }[]
        }
        dispose(): Promise<void>
      }
    }).__cordisxRuntime
    expect(runtime?.snapshot().plugins[0]).toMatchObject({ status: 'active' })
    expect(runtime?.snapshot().plugins[0]?.blockedReason).toBeUndefined()
    expect(dom.window.document.documentElement.dataset.platformRequiredMounted).toBe('true')
    expect(runtime?.snapshot().permissions[0]).toMatchObject({
      capability: 'models.read',
      availability: { status: 'supported' },
    })
    expect(runtime?.snapshot().permissions[0]?.availability.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: 'external:gateway-a' }),
    ]))

    await runtime?.dispose()
    dom.window.close()
  })
})
