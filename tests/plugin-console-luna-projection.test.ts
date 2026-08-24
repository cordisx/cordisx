import { describe, expect, it } from 'vitest'
import type { CordisXPluginConsoleEntryV1 } from '../packages/cli/src/contracts.js'
import { projectPluginConsoleForLuna } from '../packages/cli/src/renderer/manager.js'
import { snapshotConsoleValue } from '../packages/cli/src/renderer/plugin-console.js'

function entry(overrides: Partial<CordisXPluginConsoleEntryV1> = {}): CordisXPluginConsoleEntryV1 {
  return {
    contract: 'cordisx.plugin-console-entry/v1', schemaVersion: 1,
    entryId: 'entry-1', seq: 1, time: 1_700_000_000_000,
    plugin: { source: 'file:///plugin.ts', pluginId: 'plugin' }, generation: 'plugin:g1',
    coverage: 'scoped-console', kind: 'console', method: 'log', source: 'console.log',
    message: 'x=4 payload Array(2)', args: [
      snapshotConsoleValue('x=%d'), snapshotConsoleValue(4),
      snapshotConsoleValue({ nested: { ok: true } }), snapshotConsoleValue([1, 2]),
    ],
    ...overrides,
  }
}

describe('Luna Log projection', () => {
  it('keeps the native formatted message and expands safe object/array snapshots in the same text stream', () => {
    const projection = projectPluginConsoleForLuna([{ entry: entry(), count: 1 }])
    expect(projection.text).toContain('console.log  x=4 payload Array(2)')
    expect(projection.text).toContain('arg[2]: [object Object] {')
    expect(projection.text).toContain('nested: [object Object] {')
    expect(projection.text).toContain('arg[3]: Array(2) [')
    expect(projection.blocks).toMatchObject([{ startLine: 0 }])
    expect(projection.blocks[0]!.endLine).toBe(projection.text.split('\n').length)
  })

  it('prints Error stacks in Luna and groups one correlated Host boundary chain', () => {
    const failure = new Error('boom')
    failure.stack = 'Error: boom\n    at plugin.ts:1:1'
    const requested = entry({ entryId: 'request', coverage: 'host-mediated', kind: 'invocation', source: 'tools.call', message: 'Call requested', correlationId: 'call-1', phase: 'requested', args: [] })
    const terminal = entry({ entryId: 'failure', coverage: 'host-mediated', kind: 'invocation', method: 'error', source: 'tools.call', message: 'Call failed', correlationId: 'call-1', phase: 'failure', args: [snapshotConsoleValue(failure)], stack: failure.stack })
    const projection = projectPluginConsoleForLuna([{ entry: requested, count: 1 }, { entry: terminal, count: 1 }])
    expect(projection.text).toContain('├─ tools.call')
    expect(projection.text).toContain('Error: boom')
    expect(projection.text).toContain('at plugin.ts:1:1')
  })
})
