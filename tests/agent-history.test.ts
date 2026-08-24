import { appendFile, chmod, mkdir, mkdtemp, rename, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  type CordisXAgentHistoryPage,
  type CordisXAgentHistoryQuery,
  type CordisXAgentHistoryStatus,
  type CordisXAgentHistoryTailQuery,
  type CordisXPlatformResult,
} from '../packages/cli/src/contracts.js'
import { CodexAgentHistoryHost } from '../packages/cli/src/launcher/agent-history.js'
import { parseAgentHistoryBindingRequest } from '../packages/cli/src/launcher/agent-history-rpc.js'
import { CordisXAgentHistoryService } from '../packages/cli/src/renderer/agent-history.js'
import type { CordisXAgentHistoryAdapter } from '../packages/cli/src/renderer/agent-history-binding.js'
import { MemoryPermissionPolicyStore, PermissionBroker, normalizePluginManifest } from '../packages/cli/src/renderer/platform.js'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from '../packages/cli/src/renderer/service.js'

const SESSION_A = 'session-history-a'
const SESSION_B = 'session-history-b'
const SECRET = Buffer.alloc(32, 7)

function line(type: string, payload: Record<string, unknown>, ordinal: number, timestamp = `2026-08-24T00:00:${String(ordinal).padStart(2, '0')}.000Z`) {
  return JSON.stringify({ ordinal, timestamp, type, payload })
}

function fixtureLines(sessionId = SESSION_A): string[] {
  return [
    line('session_meta', { id: sessionId, cli_version: '0.149.0-alpha.4.1' }, 0),
    line('turn_context', { turn_id: 'turn-1' }, 1),
    line('response_item', { type: 'message', role: 'user', id: 'item-user-1', message_id: 'message-1', content: [{ type: 'input_text', text: 'hello sk-secret-token /Users/example/private.txt' }] }, 2),
    line('response_item', { type: 'function_call', id: 'item-tool-1', call_id: 'call-1', name: 'shell', arguments: '{"password":"never-render"}' }, 3),
    line('event_msg', { type: 'item_completed', item: { type: 'FunctionCall', id: 'item-tool-1', call_id: 'call-1', status: 'completed' } }, 4),
    line('response_item', { type: 'function_call_output', id: 'item-tool-result-1', call_id: 'call-1', output: 'Bearer private-token' }, 5),
    line('compacted', { window_id: 'window-1', replacement_history: [{ role: 'developer', content: 'never import' }] }, 6),
    line('event_msg', { type: 'task_complete', turn_id: 'turn-1', status: 'completed' }, 7),
  ]
}

async function historyRoot(): Promise<{ root: string; codexHome: string; cacheDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-agent-history-'))
  const codexHome = path.join(root, 'codex-home')
  const cacheDir = path.join(root, 'cache')
  await mkdir(path.join(codexHome, 'sessions', '2026', '08', '24'), { recursive: true })
  await mkdir(path.join(codexHome, 'archived_sessions'), { recursive: true })
  return { root, codexHome, cacheDir }
}

function rolloutPath(codexHome: string, sessionId: string, archived = false): string {
  const directory = archived ? path.join(codexHome, 'archived_sessions') : path.join(codexHome, 'sessions', '2026', '08', '24')
  return path.join(directory, `rollout-2026-08-24T00-00-00-${sessionId}.jsonl`)
}

async function writeRollout(codexHome: string, sessionId: string, lines = fixtureLines(sessionId), archived = false): Promise<string> {
  const file = rolloutPath(codexHome, sessionId, archived)
  await writeFile(file, `${lines.join('\n')}\n`)
  return file
}

function host(codexHome: string, cacheDir: string, profileName = 'codex:default') {
  return new CodexAgentHistoryHost({ codexHome, cacheDir, profileName, secret: SECRET })
}

const caller = { ownerKey: 'file:///plugins/trace.ts\0agent-trace-showcase', generation: 'generation-1' }

describe('Codex Agent history Host', () => {
  it('projects only provable session/turn/message/tool/time/compaction facts and redacts content', async () => {
    const { codexHome, cacheDir } = await historyRoot()
    await writeRollout(codexHome, SESSION_A, [...fixtureLines(), '{broken-json'])
    const service = host(codexHome, cacheDir)

    const referenced = await service.query({ sessionId: SESSION_A, limit: 500, payloadPolicy: 'referenced' }, caller)
    expect(referenced).toMatchObject({ ok: true, value: { source: { kind: 'historical', adapterId: 'codex-history' }, coverage: { state: 'partial', compacted: true, corruptLines: 1 } } })
    if (!referenced.ok) throw new Error('expected history page')
    expect(referenced.value.events.map(event => event.type)).toEqual(expect.arrayContaining([
      'session.lifecycle', 'turn.lifecycle', 'item.lifecycle', 'message.observed',
    ]))
    expect(referenced.value.events.map(event => event.type)).not.toEqual(expect.arrayContaining(['message.delivery', 'input.contribution']))
    expect(referenced.value.events.filter(event => event.toolCallId === 'call-1')).not.toHaveLength(0)
    expect(new Set(referenced.value.events.map(event => event.eventId)).size).toBe(referenced.value.events.length)
    expect(JSON.stringify(referenced.value)).not.toContain('/Users/example')
    expect(JSON.stringify(referenced.value)).not.toContain('never-render')
    expect(JSON.stringify(referenced.value)).not.toContain('replacement_history')

    const inline = await service.query({ sessionId: SESSION_A, limit: 500, payloadPolicy: 'inline' }, caller)
    if (!inline.ok) throw new Error('expected inline history page')
    const serialized = JSON.stringify(inline.value)
    expect(serialized).toContain('hello [REDACTED] [REDACTED]')
    expect(serialized).not.toContain('sk-secret-token')
    expect(inline.value.coverage.redactedFields).toBeGreaterThan(0)
    service.dispose()
  })

  it('pages more than 500 events, tails complete appended lines, and keeps stable ids across restart', async () => {
    const { codexHome, cacheDir } = await historyRoot()
    const lines = [line('session_meta', { id: SESSION_A }, 0), line('turn_context', { turn_id: 'turn-large' }, 1)]
    for (let index = 0; index < 300; index += 1) {
      lines.push(line('response_item', { type: 'message', role: 'user', id: `item-${index}`, message_id: `message-${index}`, text: `message ${index}` }, index + 2, '2026-08-24T01:00:00.000Z'))
    }
    const file = await writeRollout(codexHome, SESSION_A, lines)
    const firstHost = host(codexHome, cacheDir)
    const first = await firstHost.query({ sessionId: SESSION_A, limit: 500 }, caller)
    if (!first.ok) throw new Error('expected first page')
    expect(first.value.events).toHaveLength(500)
    expect(first.value.nextCursor).toMatch(/^[A-Za-z0-9_-]{16,}$/)
    const second = await firstHost.query({ sessionId: SESSION_A, cursor: first.value.nextCursor, limit: 500 }, caller)
    if (!second.ok) throw new Error('expected second page')
    expect(second.value.events.length).toBeGreaterThan(0)
    expect(second.value.toSeq).toBeLessThan(first.value.fromSeq ?? Number.MAX_SAFE_INTEGER)
    const stableEvent = first.value.events.at(-1)

    await appendFile(file, `${line('response_item', { type: 'function_call', id: 'tail-tool', call_id: 'tail-call' }, 302, '2026-08-24T02:00:00.000Z')}\n`)
    const tail = await firstHost.tail({ sessionId: SESSION_A, tailCursor: first.value.tailCursor!, limit: 500 }, caller)
    if (!tail.ok) throw new Error('expected tail page')
    expect(tail.value.events.some(event => event.itemId === 'tail-tool' && event.toolCallId === 'tail-call')).toBe(true)

    const restarted = host(codexHome, cacheDir)
    const afterRestart = await restarted.query({ sessionId: SESSION_A, limit: 500 }, caller)
    if (!afterRestart.ok) throw new Error('expected restarted page')
    expect(afterRestart.value.events.find(event => event.itemId === stableEvent?.itemId && event.type === stableEvent?.type)?.eventId).toBe(stableEvent?.eventId)
    firstHost.dispose()
    restarted.dispose()
  })

  it('buffers a partial tail, reports corrupt and oversized lines, and refuses stale generation/profile cursors', async () => {
    const { codexHome, cacheDir } = await historyRoot()
    const file = rolloutPath(codexHome, SESSION_A)
    await writeFile(file, `${fixtureLines().join('\n')}\n${line('response_item', { type: 'message', role: 'user', id: 'partial' }, 8).slice(0, 40)}`)
    const service = host(codexHome, cacheDir)
    const first = await service.query({ sessionId: SESSION_A, limit: 500 }, caller)
    if (!first.ok) throw new Error('expected partial page')
    expect(first.value.coverage.state).toBe('partial')
    await appendFile(file, `${line('response_item', { type: 'message', role: 'user', id: 'partial' }, 8).slice(40)}\n{bad}\n${JSON.stringify({ type: 'ignored', payload: { blob: 'x'.repeat(32 * 1024 * 1024) } })}\n`)
    const tail = await service.tail({ sessionId: SESSION_A, tailCursor: first.value.tailCursor!, limit: 500 }, caller)
    if (!tail.ok) throw new Error('expected tail')
    expect(tail.value.coverage.corruptLines).toBeGreaterThan(0)
    expect(tail.value.coverage.oversizedLines).toBeGreaterThan(0)

    await expect(service.tail({ sessionId: SESSION_A, tailCursor: tail.value.tailCursor!, limit: 500 }, { ...caller, generation: 'generation-2' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    const otherProfile = host(codexHome, cacheDir, 'codex:other')
    await expect(otherProfile.tail({ sessionId: SESSION_A, tailCursor: tail.value.tailCursor!, limit: 500 }, caller))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    service.dispose()
    otherProfile.dispose()
  }, 30_000)

  it('isolates sessions, resolves archived files, and ignores symlinked rollout paths', async () => {
    const { root, codexHome, cacheDir } = await historyRoot()
    await writeRollout(codexHome, SESSION_A, fixtureLines(SESSION_A), true)
    const outside = path.join(root, 'outside.jsonl')
    await writeFile(outside, `${fixtureLines(SESSION_B).join('\n')}\n`)
    await symlink(outside, rolloutPath(codexHome, SESSION_B))
    const service = host(codexHome, cacheDir)
    const archivedPage = await service.query({ sessionId: SESSION_A }, caller)
    expect(archivedPage).toMatchObject({ ok: true, value: { coverage: { state: 'complete', tailAvailable: false } } })
    if (!archivedPage.ok) throw new Error('expected archived page')
    expect(archivedPage.value).not.toHaveProperty('tailCursor')
    await expect(service.query({ sessionId: SESSION_B }, caller)).resolves.toMatchObject({ ok: true, value: { coverage: { state: 'unavailable' }, events: [] } })
    service.dispose()
  })

  it('follows an active-to-archive move and fails closed after truncation', async () => {
    const { codexHome, cacheDir } = await historyRoot()
    const active = await writeRollout(codexHome, SESSION_A)
    const service = host(codexHome, cacheDir)
    const first = await service.query({ sessionId: SESSION_A, limit: 500 }, caller)
    if (!first.ok || first.value.tailCursor === undefined) throw new Error('expected active tail cursor')
    const archived = rolloutPath(codexHome, SESSION_A, true)
    await rename(active, archived)
    const moved = await service.tail({ sessionId: SESSION_A, tailCursor: first.value.tailCursor, limit: 500 }, caller)
    expect(moved).toMatchObject({ ok: true, value: { coverage: { tailAvailable: false } } })
    if (!moved.ok) throw new Error('expected moved page')
    expect(moved.value).not.toHaveProperty('tailCursor')

    await writeFile(archived, `${fixtureLines().slice(0, 2).join('\n')}\n`)
    await expect(service.tail({ sessionId: SESSION_A, tailCursor: first.value.tailCursor, limit: 500 }, caller))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    service.dispose()
  })

  it('persists a metadata key with owner-only permissions and exposes no path-shaped RPC input', async () => {
    const { codexHome, cacheDir } = await historyRoot()
    await writeRollout(codexHome, SESSION_A)
    const service = new CodexAgentHistoryHost({ codexHome, cacheDir, profileName: 'default' })
    await service.status()
    const key = path.join(cacheDir, 'history.key')
    expect((await stat(key)).mode & 0o777).toBe(0o600)
    await chmod(key, 0o600)
    expect(() => parseAgentHistoryBindingRequest({
      requestId: 'request-1', token: 'token', operation: 'query', caller,
      input: { sessionId: SESSION_A, path: '/private/history.jsonl' },
    }, 'token')).toThrow('invalid Agent history request fields')
    expect(JSON.stringify(await service.status())).not.toContain(codexHome)
    service.dispose()
  })
})

class FakeHistoryAdapter implements CordisXAgentHistoryAdapter {
  readonly query = vi.fn(async (input: CordisXAgentHistoryQuery): Promise<CordisXPlatformResult<CordisXAgentHistoryPage>> => ({
    ok: true,
    value: {
      contract: 'cordisx.agent-history/v1', schemaVersion: 1, sessionId: input.sessionId,
      snapshotId: 'snapshot.history.0001', limit: input.limit ?? 500,
      requestedPayloadPolicy: input.payloadPolicy ?? 'referenced', effectivePayloadPolicy: input.payloadPolicy ?? 'referenced',
      source: { kind: 'historical', adapterId: 'fixture', adapterVersion: '1', hostId: 'fixture', profileId: 'profile.opaque.0001' },
      coverage: { state: 'complete', compacted: false, corruptLines: 0, oversizedLines: 0, redactedFields: 0, tailAvailable: true },
      tailCursor: 'tail.history.0001', events: [],
    },
  }))
  readonly tail = vi.fn(async (input: CordisXAgentHistoryTailQuery): Promise<CordisXPlatformResult<CordisXAgentHistoryPage>> => await this.query(input))
  status(): CordisXAgentHistoryStatus {
    return { hostId: 'fixture', hostName: 'Fixture history', mode: 'available', adapterId: 'fixture', adapterVersion: '1', profileId: 'profile.opaque.0001', defaultPayloadPolicy: 'referenced', diagnostics: [], filesystemExposed: false, rawBridgeExposed: false }
  }
  dispose(): void {}
}

describe('Agent history renderer service', () => {
  it('enforces ask/allow/deny, session scope, and fiber disposal without exposing adapter authority', async () => {
    const identity = { id: 'trace', source: 'file:///plugins/trace.ts' }
    const ask = { request: vi.fn(async () => 'allow' as const) }
    const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), ask)
    broker.register(identity, normalizePluginManifest({
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
      schemaVersion: 1,
      id: identity.id,
      capabilities: [{
        name: 'agent.history.read', required: false,
        reason: { key: 'permission.agent-history', fallback: 'Read redacted Agent history' },
        scope: { sessionIds: [SESSION_A] },
      }],
    }, identity.id))
    const adapter = new FakeHistoryAdapter()
    const root = new Context()
    const fiber = root.plugin(CordisXAgentHistoryService, { adapter, broker, generation: 'generation-1' })
    await fiber
    const ctx = root.extend({ [CORDISX_PLUGIN_ID]: identity.id, [CORDISX_PLUGIN_SOURCE]: identity.source })
    await expect(ctx.agentHistory.query({ sessionId: SESSION_A })).resolves.toMatchObject({ ok: true })
    expect(ask.request).toHaveBeenCalledOnce()
    broker.setPolicy(identity, 'agent.history.read', 'deny')
    await expect(ctx.agentHistory.query({ sessionId: SESSION_A })).resolves.toMatchObject({ ok: false, error: { code: 'permission-denied' } })
    broker.setPolicy(identity, 'agent.history.read', 'allow')
    await expect(ctx.agentHistory.query({ sessionId: SESSION_B })).resolves.toMatchObject({ ok: false, error: { code: 'permission-scope-denied' } })
    expect(ctx.agentHistory.status()).toMatchObject({ filesystemExposed: false, rawBridgeExposed: false })
    expect(Object.keys(ctx.agentHistory)).not.toEqual(expect.arrayContaining(['adapter', 'broker']))
    await fiber.dispose()
    expect(() => ctx.agentHistory.status()).toThrow()
    broker.dispose()
  })
})
