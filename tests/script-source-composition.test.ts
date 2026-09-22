import { describe, expect, it } from 'vitest'
import { composeScriptMembers } from '../packages/cli/src/launcher/model-catalog/script-composition.js'
import { parseScriptOutput } from '../packages/cli/src/launcher/model-catalog/script-output-parser.js'
import type { ScriptSourceSnapshot } from '../packages/cli/src/launcher/model-catalog/script-types.js'

const snapshot = (ids: string[], mode: 'replace' | 'supplement' = 'supplement'): ScriptSourceSnapshot => ({
  bindingRef: 'binding',
  scopeRevision: 'scope',
  authorityRevision: 'config-1',
  mode,
  revision: 1,
  runGeneration: 1,
  models: parseScriptOutput(
    Buffer.from(JSON.stringify({ schemaVersion: 1, complete: true, models: ids.map(id => ({ id })) })),
    mode,
  ),
  complete: true,
  loading: false,
  freshness: 'fresh',
  evidence: 'script-declared',
  persistence: 'session-only',
})
const input = {
  bindingRef: 'binding',
  scopeRevision: 'scope',
  authorityRevision: 'config-1',
  base: [{ id: 'same', label: 'Same', aliases: [], provenance: ['auto'] }],
}

describe('script membership composition only', () => {
  it('retains duplicate provenance and supplement-only notListed, including auto-empty/removal', () => {
    const script = snapshot(['same', 'extra'])
    const composed = composeScriptMembers({ ...input, strategy: 'auto-augment', script })
    expect(composed.find(model => model.id === 'same')).toMatchObject({
      provenance: ['auto', 'script-supplement'],
      notListed: false,
    })
    expect(composed.find(model => model.id === 'extra')).toMatchObject({
      provenance: ['script-supplement'],
      notListed: true,
    })
    expect(
      composeScriptMembers({ ...input, base: [], strategy: 'auto-augment', script }).every(model => model.notListed),
    ).toBe(true)
    expect(composeScriptMembers({ ...input, strategy: 'auto-augment', script: snapshot([]) })).toEqual(input.base)
  })
  it('never supplements auto-only/manual-replace and isolates scope/config authority', () => {
    for (const strategy of ['auto-only', 'native-only', 'manual-replace'] as const) {
      expect(composeScriptMembers({ ...input, strategy, script: snapshot(['extra']) })).toBe(input.base)
    }
    for (const patch of [{ scopeRevision: 'other' }, { authorityRevision: 'other' }, { bindingRef: 'other' }]) {
      expect(composeScriptMembers({ ...input, ...patch, strategy: 'native-augment', script: snapshot(['extra']) }))
        .toBe(input.base)
    }
  })
  it('replace has authoritative empty and no fallback; failed same-authority retains its LKG', () => {
    expect(composeScriptMembers({ ...input, strategy: 'script-replace', script: snapshot([], 'replace') })).toEqual([])
    expect(composeScriptMembers({ ...input, strategy: 'script-replace' })).toEqual([])
    const script = {
      ...snapshot(['lkg'], 'replace'),
      freshness: 'stale' as const,
      error: 'script-exit-failed' as const,
    }
    expect(composeScriptMembers({ ...input, strategy: 'script-replace', script }).map(model => model.id)).toEqual([
      'lkg',
    ])
  })
})
