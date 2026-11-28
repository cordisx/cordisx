import React from 'react'
import { expect, it, vi } from 'vitest'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'
import type { ManagerPermissionSnapshot } from '../packages/cli/src/renderer/manager.js'
import { managerModel, reactManagerFixture } from './helpers/react-manager.js'

it('shows the client and unconfirmed outcome only for the selected permission', async () => {
  const fixture = reactManagerFixture()
  const { PermissionDecisionHistory } = await import(
    '../packages/cli/src/renderer/manager/pages/PermissionDecisionHistory.js'
  )
  const identity = { id: 'demo', source: 'file:///plugins/demo.js' }
  const record = createPermissionPolicyRecord({
    profileId: 'default',
    identity,
    capability: 'models.read',
    scope: { providers: ['openai'] },
    policy: 'allow',
  })
  const other = createPermissionPolicyRecord({
    profileId: 'default',
    identity,
    capability: 'models.read',
    scope: { providers: ['other'] },
    policy: 'deny',
  })
  const permission: ManagerPermissionSnapshot = {
    identity,
    capability: 'models.read',
    required: false,
    reason: { key: 'models' },
    reasonText: 'Read models',
    scope: { providers: ['openai'] },
    fingerprint: 'fixture',
    policy: 'allow',
    denialCount: 0,
    availability: { status: 'supported', reasonText: 'Ready', providers: [] },
  }
  const permissionHistory = vi.fn(async () => [
    { record, decision: 'allow' as const, client: 'codex' as const, requestedAt: '2026-11-28T08:00:00.000Z' },
    {
      record: other,
      decision: 'deny' as const,
      client: 'web' as const,
      requestedAt: '2026-11-28T08:01:00.000Z',
      committedAt: '2026-11-28T08:01:01.000Z',
    },
  ])
  try {
    await fixture.render(
      <PermissionDecisionHistory
        permission={permission}
        locale="en"
        model={managerModel(undefined, { permissionHistory })}
      />,
    )
    expect(permissionHistory).toHaveBeenCalledWith('demo')
    const history = fixture.element('[data-permission-decision-history]')
    expect(history.textContent).toContain('Codex')
    expect(history.textContent).toContain('Outcome unconfirmed')
    expect(history.textContent).not.toContain('CordisX Web')
  } finally {
    await fixture.dispose()
  }
})
