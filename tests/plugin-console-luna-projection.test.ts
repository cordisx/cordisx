import { describe, expect, it } from 'vitest'
import type { CordisXPluginConsoleEntryV1 } from '../packages/cli/src/contracts.js'
import { projectPluginConsoleEntryForLuna } from '../packages/cli/src/renderer/manager.js'
import { snapshotConsoleValue } from '../packages/cli/src/renderer/plugin-console.js'

function entry(overrides: Partial<CordisXPluginConsoleEntryV1> = {}): CordisXPluginConsoleEntryV1 {
  return {
    contract: 'cordisx.plugin-console-entry/v1',
    schemaVersion: 1,
    entryId: 'entry-1',
    seq: 1,
    time: 1_700_000_000_000,
    plugin: { source: 'file:///plugin.ts', pluginId: 'plugin' },
    generation: 'plugin:g1',
    coverage: 'scoped-console',
    kind: 'console',
    method: 'log',
    source: 'console.log',
    message: 'x=4 payload Array(2)',
    args: [
      snapshotConsoleValue('x=%d'),
      snapshotConsoleValue(4),
      snapshotConsoleValue({ nested: { ok: true } }),
      snapshotConsoleValue([1, 2]),
    ],
    ...overrides,
  }
}

describe('Luna Console entry projection', () => {
  it('keeps one native argument array with safe expandable objects and arrays', () => {
    const projection = projectPluginConsoleEntryForLuna(entry())
    expect(projection.type).toBe('log')
    expect(projection.header.from).toBe('console.log')
    expect(projection.header.time).toMatch(/^\d{2}:\d{2}:\d{2}$/u)
    expect(projection.args).toHaveLength(4)
    expect(projection.args[0]).toBe('x=%d')
    expect(projection.args[1]).toBe(4)
    expect(projection.args[2]).toEqual({ nested: { ok: true } })
    expect(projection.args[3]).toEqual([1, 2])
    expect(projection).not.toHaveProperty('text')
  })

  it('keeps every Host boundary event independent and restores Error stacks', () => {
    const failure = new Error('boom')
    failure.stack = 'Error: boom\n    at plugin.ts:1:1'
    const requested = entry({
      entryId: 'request',
      coverage: 'host-mediated',
      kind: 'invocation',
      source: 'tools.call',
      message: 'Call requested',
      correlationId: 'call-1',
      phase: 'requested',
      args: [],
    })
    const terminal = entry({
      entryId: 'failure',
      coverage: 'host-mediated',
      kind: 'invocation',
      method: 'error',
      source: 'tools.call',
      message: 'Call failed',
      correlationId: 'call-1',
      phase: 'failure',
      args: [snapshotConsoleValue(failure)],
      stack: failure.stack,
    })
    const projectedRequest = projectPluginConsoleEntryForLuna(requested)
    const projectedTerminal = projectPluginConsoleEntryForLuna(terminal)
    expect(projectedRequest.args).toEqual(['Call requested'])
    expect(projectedTerminal.args[0]).toBe('Call failed')
    expect(projectedTerminal.args[1]).toBeInstanceOf(Error)
    expect((projectedTerminal.args[1] as Error).stack).toContain('at plugin.ts:1:1')
    expect(projectedRequest.entry.correlationId).toBe(projectedTerminal.entry.correlationId)
  })
})
