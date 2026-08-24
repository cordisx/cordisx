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
    const entry = path.join(projectRoot, 'tests/fixtures/platform-required-plugin.ts')
    const config = {
      ...baseConfig,
      plugins: [{ id: 'platform-required', entry, enabled: true, config: {} }],
    }
    const bundle = await buildRendererBundle(config)
    const dom = new JSDOM(`
      <html lang="en"><head></head><body>
        <div class="sidebar-header"><button id="workspace-switcher" aria-haspopup="menu">Codex</button></div>
      </body></html>
    `, { runScripts: 'dangerously', url: 'https://codex.local/' })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })

    const identityKey = JSON.stringify([pathToFileURL(entry).href, 'platform-required'])
    const fingerprint = JSON.stringify({
      name: 'models.read',
      required: true,
      reason: { key: 'permission.required', fallback: 'Models are required for this fixture' },
      scope: {},
    })
    dom.window.localStorage.setItem('cordisx.platform.permissionPolicies.v1', JSON.stringify([{
      identityKey,
      capability: 'models.read',
      fingerprint,
      policy: 'deny',
    }]))

    dom.window.eval(bundle)
    for (let attempt = 0; attempt < 20 && dom.window.document.documentElement.dataset.cordisxReady !== 'true'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const runtime = (dom.window as unknown as {
      __cordisxRuntime?: {
        snapshot(): {
          plugins: readonly { id: string; status: string; blockedReason?: string }[]
          permissions: readonly { capability: string; policy: string; blockedReason?: string }[]
        }
        permissionAuthorizationPlan(id: string): CordisXPermissionAuthorizationPlanV1
        authorizePlugin(id: string, decision: CordisXPermissionAuthorizationDecisionV1): Promise<void>
        setPluginBlocked(id: string, blocked: boolean): Promise<void>
        setPermissionPolicy(id: string, capability: 'models.read', policy: 'allow'): Promise<void>
        dispose(): Promise<void>
      }
    }).__cordisxRuntime
    expect(runtime?.snapshot().plugins[0]).toMatchObject({
      id: 'platform-required',
      status: 'permission-blocked',
      blockedReason: 'Required capability denied: models.read',
    })
    expect(runtime?.snapshot().permissions[0]).toMatchObject({
      capability: 'models.read',
      policy: 'deny',
      blockedReason: 'Required capability models.read is denied',
    })
    expect(dom.window.document.documentElement.dataset.platformRequiredMounted).toBeUndefined()

    const plan = runtime?.permissionAuthorizationPlan('platform-required')
    expect(plan).toMatchObject({
      profileId: 'development',
      defaultDecision: 'allow',
      declarations: [
        { capability: 'models.read', required: true, policy: 'deny' },
        { capability: 'tasks.catalog.read', required: false, policy: 'ask' },
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
        decision: item.capability === 'models.read' ? required : 'deny',
      })),
    })
    await runtime?.authorizePlugin('platform-required', decide('allow-once'))
    expect(runtime?.snapshot().plugins[0]?.status).toBe('active')
    expect(runtime?.snapshot().permissions[0]?.policy).toBe('deny')
    expect(dom.window.localStorage.getItem('cordisx.platform.permissionPolicies.v2')).not.toContain('allow-once')
    await runtime?.setPluginBlocked('platform-required', true)

    await runtime?.authorizePlugin('platform-required', decide('allow'))
    expect(runtime?.snapshot().plugins[0]?.status).toBe('active')
    expect(dom.window.document.documentElement.dataset.platformRequiredMounted).toBe('true')

    await runtime?.dispose()
    expect(dom.window.document.documentElement.dataset.platformRequiredMounted).toBeUndefined()
    dom.window.close()
  })

  it('uses the launcher profile projection and acknowledged narrow RPC for persistent policy changes', async () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const baseConfig = await loadConfig(path.join(projectRoot, 'cordisx.config.example.json'))
    const entry = path.join(projectRoot, 'tests/fixtures/platform-required-plugin.ts')
    const config = { ...baseConfig, plugins: [{ id: 'platform-required', entry, enabled: true, config: {} }] }
    const identity = { source: pathToFileURL(entry).href, id: 'platform-required' }
    const initial = createPermissionPolicyRecord({
      profileId: 'work', identity, capability: 'models.read', scope: {}, policy: 'allow',
    })
    const token = 'permission-persistence-token'
    const bundle = await buildRendererBundle(config, {
      permission: { profileId: 'work', policies: [initial], bridgeToken: token },
    })
    const dom = new JSDOM(`
      <html lang="en"><head></head><body>
        <div class="sidebar-header"><button id="workspace-switcher" aria-haspopup="menu">Codex</button></div>
      </body></html>
    `, { runScripts: 'dangerously', url: 'https://codex.local/' })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    const payloads: Record<string, unknown>[] = []
    Object.defineProperty(dom.window, '__cordisxPermissionPolicyRequestV1', {
      configurable: true,
      value: (text: string) => {
        const payload = JSON.parse(text) as { requestId: string; token: string; records: unknown[] }
        payloads.push(payload as unknown as Record<string, unknown>)
        queueMicrotask(() => (dom.window as unknown as {
          __cordisxPermissionPolicyReceiveV1?: (response: string) => void
        }).__cordisxPermissionPolicyReceiveV1?.(JSON.stringify({
          requestId: payload.requestId, ok: true, value: payload.records,
        })))
      },
    })
    dom.window.eval(bundle)
    for (let attempt = 0; attempt < 30 && dom.window.document.documentElement.dataset.cordisxReady !== 'true'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const runtime = (dom.window as unknown as {
      __cordisxRuntime?: {
        snapshot(): { plugins: readonly { status: string }[]; permissions: readonly { policy: string }[] }
        setPermissionPolicy(id: string, capability: 'models.read', policy: 'deny'): Promise<void>
        dispose(): Promise<void>
      }
    }).__cordisxRuntime
    expect(runtime?.snapshot()).toMatchObject({
      plugins: [{ status: 'active' }],
      permissions: [{ policy: 'allow' }, { policy: 'ask' }],
    })
    await runtime?.setPermissionPolicy('platform-required', 'models.read', 'deny')
    expect(runtime?.snapshot()).toMatchObject({
      plugins: [{ status: 'permission-blocked' }],
      permissions: [{ policy: 'deny' }, { policy: 'ask' }],
    })
    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toMatchObject({ token, records: [{ key: { profileId: 'work', identity: { pluginId: 'platform-required' } }, policy: 'deny' }] })
    expect(JSON.stringify(payloads[0])).not.toContain('configPath')
    await runtime?.dispose()
    dom.window.close()
  })
})
