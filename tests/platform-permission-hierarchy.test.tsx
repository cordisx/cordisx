import React from 'react'
import { describe, expect, it } from 'vitest'
import type { ManagerPermissionSnapshot } from '../packages/cli/src/renderer/manager.js'
import { managerModel, managerRouter, managerSnapshot, reactManagerFixture } from './helpers/react-manager.js'
const identity = { source: 'file:///plugins/demo/index.ts', id: 'demo' }
function permission(
  capability: ManagerPermissionSnapshot['capability'],
  overrides: Partial<ManagerPermissionSnapshot> = {},
): ManagerPermissionSnapshot {
  return {
    identity,
    capability,
    required: false,
    reason: { key: `permission.${capability}`, fallback: `Reason for ${capability}` },
    reasonText: '申请使用对应的宿主功能',
    scope: {},
    fingerprint: `sha256:${'a'.repeat(64)}`,
    policy: 'ask',
    denialCount: 0,
    availability: {
      status: 'unavailable',
      reasonText: '没有宿主提供方可路由声明范围',
      providers: [],
    },
    ...overrides,
  }
}

describe('React Manager permission detail', () => {
  it('keeps editable authorization independent from unavailable providers and dispatches the exact scope through official Select', async () => {
    const fixture = reactManagerFixture()
    const { PermissionDetailPage } = await import('../packages/cli/src/renderer/manager/pages/PermissionDetailPage.js')
    const item = permission('models.read', { scope: { providers: ['openai'] } })
    const state = managerSnapshot({ permissions: [item] })
    const model = managerModel(state)
    const router = managerRouter({
      kind: 'permission',
      pluginId: 'demo',
      capability: item.capability,
      fingerprint: item.fingerprint,
    })
    try {
      await fixture.render(<PermissionDetailPage model={model} snapshot={state} router={router} />)
      expect(fixture.document.body.textContent).toContain(item.availability.reasonText)
      expect(fixture.element('.t-select input')).toHaveProperty('disabled', false)
      await fixture.choose('.t-select input', '始终允许')
      expect(model.setPermissionPolicy).toHaveBeenCalledExactlyOnceWith('demo', 'models.read', 'allow', {
        providers: ['openai'],
      })
      await fixture.render(<PermissionDetailPage model={model} snapshot={managerSnapshot()} router={router} />)
      expect(fixture.document.body.textContent).toContain('权限记录已不存在')
      expect(fixture.document.querySelector('.t-select')).toBeNull()
    } finally {
      await fixture.dispose()
    }
  })
  it('renders the exact artifact certification evidence in its Host-owned detail', async () => {
    const fixture = reactManagerFixture()
    const { PermissionDetailPage } = await import('../packages/cli/src/renderer/manager/pages/PermissionDetailPage.js')
    const certification = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-certified-permission-projection.v1.schema.json' as const,
      schemaVersion: 1 as const,
      kind: 'cordisx-certified-permission-eligibility' as const,
      status: 'active' as const,
      source: identity.source,
      pluginId: identity.id,
      version: '1.2.3',
      integrity: `sha256:${'b'.repeat(64)}` as const,
      reviewPolicy: { id: 'cordisx-marketplace-review' as const, version: '1.0.0' },
      reviewedAt: '2026-08-29T00:00:00.000Z',
      expiresAt: '2026-09-30T00:00:00.000Z',
      evidence: {
        kind: 'protected-marketplace-review' as const,
        reference: 'https://github.com/cordisx/marketplace/pull/123',
      },
      feed: {
        generatedAt: '2026-08-30T00:00:00.000Z',
        root: 'https://marketplace.example/feed.json',
        authority: 'cordisx.marketplace.codeowners/v1' as const,
      },
      fingerprint: `sha256:${'c'.repeat(64)}` as const,
      revision: '2026-08-30T00:00:00.000Z',
    }
    const state = {
      ...managerSnapshot(),
      permissions: [permission('ui.extension-points.render', {
        scope: { extensionPoints: ['workspace.toolbar.items'] },
        fingerprint: `sha256:${'d'.repeat(64)}`,
        authorizationOrigin: 'certified-implicit',
        authorizationReason: 'Exact Certified artifact auto-approved by the Host catalog',
        certification,
        availability: {
          status: 'supported',
          reasonText: 'Host extension point adapter is available',
          providers: [{
            providerId: 'host-extension-point:workspace.toolbar.items',
            providerNameText: 'Workspace toolbar',
            kind: 'host-local',
            family: 'ui-rendering',
            status: 'supported',
            reasonText: 'Available',
            scope: { extensionPoints: ['workspace.toolbar.items'] },
          }],
        },
      })],
    }

    const item = state.permissions[0]!
    try {
      await fixture.render(
        <PermissionDetailPage
          model={managerModel(state)}
          snapshot={state}
          router={managerRouter({
            kind: 'permission',
            pluginId: 'demo',
            capability: item.capability,
            fingerprint: item.fingerprint,
          })}
        />,
      )
      const trace = fixture.element('[data-permission-authorization-origin="certified-implicit"]')
      expect(trace.textContent).toContain('demo@1.2.3')
      expect(trace.textContent).toContain(certification.integrity)
      expect(trace.textContent).toContain(certification.fingerprint)
      expect(trace.querySelector('a')?.href).toBe(certification.evidence.reference)
      expect(trace.querySelector('a')?.rel).toBe('noopener noreferrer')
    } finally {
      await fixture.dispose()
    }
  })
})
