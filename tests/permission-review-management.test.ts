import { describe, expect, it, vi } from 'vitest'
import {
  applyManagementPermissionReview,
  parsePermissionReviewOperation,
} from '../packages/cli/src/launcher/permission-review-management.js'
import type { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4 } from '../packages/cli/src/permission-contracts.js'
import { PermissionReviewGate } from '../packages/cli/src/launcher/permission-review-gate.js'

const input = {
  kind: 'permission-review-apply' as const,
  expectedRevision: 3,
  userConfirmed: true as const,
  decision: {
    $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4,
    schemaVersion: 4 as const,
    origin: 'explicit-user' as const,
    planId: 'plan-1',
    operation: 'install' as const,
    profileId: 'work',
    identity: { source: 'https://example.test/plugin', pluginId: 'fixture' },
    binding: { operationId: 'op', requestId: 'candidate', runtimeGeneration: 'generation-1' },
    decisions: [],
  },
}

describe('private permission review management', () => {
  it('refuses concurrent reviews and releases the gate after failure', async () => {
    const gate = new PermissionReviewGate()
    let release!: () => void
    const waiting = new Promise<void>(resolve => {
      release = resolve
    })
    const first = gate.run(async () => {
      await waiting
      throw new Error('fixture failure')
    })
    await expect(gate.run(async () => 'second')).rejects.toThrow('Another plugin permission review')
    release()
    await expect(first).rejects.toThrow('fixture failure')
    await expect(gate.run(async () => 'third')).resolves.toBe('third')
  })

  it('rejects absent confirmation, unsupported versions, wrong profiles and extra envelope fields', () => {
    expect(parsePermissionReviewOperation(input, 'work')).toEqual(input)
    for (
      const invalid of [
        { ...input, userConfirmed: false },
        { ...input, userConfirmed: undefined },
        { ...input, decision: { ...input.decision, schemaVersion: 1 } },
        { ...input, decision: { ...input.decision, profileId: 'other' } },
        { ...input, decision: { ...input.decision, origin: 'default' } },
        { ...input, extra: true },
      ]
    ) expect(() => parsePermissionReviewOperation(invalid, 'work')).toThrow('invalid permission review')
  })

  it('does not claim a result if the authority may have committed before a failure', async () => {
    let committed = false
    const apply = vi.fn(async () => {
      committed = true
      throw new Error('connection was lost after publication')
    })
    const coordinator = {
      store: { loadActive: async () => ({ revision: 3 }) },
      applyPermissionReviewV4: apply,
    } as unknown as PluginLifecycleCoordinator
    expect(
      await applyManagementPermissionReview({
        coordinator,
        profileId: 'work',
        generation: 'generation-1',
        operation: input,
      }),
    ).toEqual({ status: 'unknown', reason: 'review-not-confirmed' })
    expect(committed).toBe(true)
    expect(apply).toHaveBeenCalledOnce()
  })
})
