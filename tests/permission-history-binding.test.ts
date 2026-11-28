import { afterEach, expect, it } from 'vitest'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'
import { BrowserPermissionHistoryBinding } from '../packages/cli/src/renderer/permission-history-binding.js'

const record = createPermissionPolicyRecord({
  profileId: 'default',
  identity: { id: 'demo', source: 'file:///demo.js' },
  capability: 'models.read',
  scope: {},
  policy: 'allow',
})

afterEach(() => {
  globalThis.__cordisxPermissionHistoryRequestV1 = undefined
  globalThis.__cordisxPermissionHistoryReceiveV1 = undefined
})

it('reads the service-projected source and distinguishes an unconfirmed decision', async () => {
  globalThis.__cordisxPermissionHistoryRequestV1 = payload => {
    const { requestId } = JSON.parse(payload) as { requestId: string }
    queueMicrotask(() =>
      globalThis.__cordisxPermissionHistoryReceiveV1?.(JSON.stringify({
        requestId,
        ok: true,
        value: [{ record, decision: 'allow', client: 'codex', requestedAt: '2026-11-28T08:00:00.000Z' }],
      }))
    )
  }
  const binding = BrowserPermissionHistoryBinding.connect()!
  try {
    expect(await binding.read('demo')).toEqual([{
      record,
      decision: 'allow',
      client: 'codex',
      requestedAt: '2026-11-28T08:00:00.000Z',
    }])
  } finally {
    binding.dispose()
  }
})

it('rejects history returned for a different plugin', async () => {
  globalThis.__cordisxPermissionHistoryRequestV1 = payload => {
    const { requestId } = JSON.parse(payload) as { requestId: string }
    queueMicrotask(() =>
      globalThis.__cordisxPermissionHistoryReceiveV1?.(JSON.stringify({
        requestId,
        ok: true,
        value: [{ record, decision: 'allow', client: 'web', requestedAt: '2026-11-28T08:00:00.000Z' }],
      }))
    )
  }
  const binding = BrowserPermissionHistoryBinding.connect()!
  try {
    await expect(binding.read('other')).rejects.toThrow('permission history is invalid')
  } finally {
    binding.dispose()
  }
})

it('reads lifecycle authorization choices through the same bounded Web channel', async () => {
  globalThis.__cordisxPermissionHistoryRequestV1 = payload => {
    const request = JSON.parse(payload) as { requestId: string; kind: string }
    expect(request.kind).toBe('lifecycle')
    queueMicrotask(() =>
      globalThis.__cordisxPermissionHistoryReceiveV1?.(JSON.stringify({
        requestId: request.requestId,
        ok: true,
        value: [{
          operation: 'install',
          client: 'codex',
          requestedAt: '2026-11-28T08:00:00.000Z',
          committedAt: '2026-11-28T08:00:01.000Z',
          decisions: [{ capability: 'models.read', decision: 'allow-once' }],
        }, {
          operation: 'runtime',
          client: 'codex',
          requestedAt: '2026-11-28T08:01:00.000Z',
          decisions: [{ capability: 'models.read', decision: 'allow-once' }],
        }],
      }))
    )
  }
  const binding = BrowserPermissionHistoryBinding.connect()!
  try {
    expect(await binding.readLifecycle('demo')).toMatchObject([{
      client: 'codex',
      operation: 'install',
      decisions: [{ capability: 'models.read', decision: 'allow-once' }],
    }, { operation: 'runtime', client: 'codex' }])
  } finally {
    binding.dispose()
  }
})
