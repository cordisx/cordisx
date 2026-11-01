import { describe, expect, it } from 'vitest'
import { type AdapterBundle, type AdapterModule, bundle } from '../packages/codex-adapter/src/index.js'
import { resources } from './fixtures/native-submission-structure.js'
import { type AdapterCandidate, selectAdapterModules } from '../packages/cli/src/launcher/codex-adapter/selection.js'
const candidate = (identity: string, modules = bundle.modules): AdapterCandidate => ({
  identity,
  bundle: { ...bundle, modules },
})
const input = () => ({ appVersion: '2099.future', buildNumber: '999999999', resources: resources() })
const module = (
  id: string,
  analyze: AdapterModule['analyze'],
  requires: AdapterModule['requires'] = [],
  composes: readonly string[] = [],
): AdapterModule => ({ id, analyze, requires, composes })

describe('independent adapter combinations', () => {
  it('uses structures on unknown future builds and fences all original resource bytes', () => {
    const plan = selectAdapterModules([candidate('npm-artifact')], input())
    expect(plan.modules.find(m => m.id === 'submission')?.identity).toBe('npm-artifact')
    expect(() => plan.transforms[0]!.transform('changed')).toThrow('changed')
  })
  it('combines independent modules from many coexisting versions without a count limit', () => {
    const extra = Array.from({ length: 12 }, (_, i) => candidate(`artifact-${i}`, [module(`read-${i}`, () => ({}))]))
    const plan = selectAdapterModules([...extra, candidate('base')], input())
    expect(plan.modules.filter(m => m.id.startsWith('read-'))).toHaveLength(12)
  })
  it('rejects unsupported Host API/relay contracts and uses a compatible baseline', () => {
    const invalid = { identity: 'invalid', bundle: { ...bundle, relayContract: 2 } as unknown as AdapterBundle }
    const plan = selectAdapterModules([invalid, candidate('baseline')], input())
    expect(plan.modules[0]!.identity).toBe('baseline')
    expect(plan.rejected).toContainEqual(
      expect.objectContaining({ identity: 'invalid', reason: expect.stringContaining('contract') }),
    )
  })
  it('never mixes a dependent creation/first-turn module from another package generation', () => {
    const tasks = module(
      'tasks',
      () => {
        throw new Error('must not run')
      },
      [{ id: 'submission', samePackage: true }],
      ['submission'],
    )
    const plan = selectAdapterModules([candidate('new', [tasks]), candidate('base', [bundle.modules[0]!])], input())
    expect(plan.modules.map(m => m.id)).toEqual(['submission'])
    expect(plan.rejected.some(r => r.reason.includes('dependency'))).toBe(true)
  })
  it('rejects overlapping writes without a declared composition dependency', () => {
    const conflict = module('conflict', context => ({ transforms: context.transforms.map(t => ({ ...t })) }))
    const plan = selectAdapterModules([candidate('base', [bundle.modules[0]!, conflict])], input())
    expect(plan.modules.map(m => m.id)).toEqual(['submission'])
    expect(plan.rejected.some(r => r.reason.includes('resource conflict'))).toBe(true)
  })
  it('rejects a partial staged composition atomically and preserves working submission', () => {
    const broken = module(
      'tasks',
      context => ({ transforms: context.transforms.map((t, i) => i ? t : ({ ...t, sha256: '0'.repeat(64) })) }),
      [{ id: 'submission', samePackage: true }],
      ['submission'],
    )
    const plan = selectAdapterModules([candidate('base', [bundle.modules[0]!, broken])], input())
    expect(plan.modules.map(m => m.id)).toEqual(['submission'])
    expect(plan.transforms).toHaveLength(2)
  })
  it('does not apply any adapter when every structure is incompatible', () => {
    expect(() =>
      selectAdapterModules([candidate('base')], {
        ...input(),
        resources: [{ url: 'app://-/assets/unknown.js', source: 'export const x=1' }],
      })
    ).toThrow('incompatible')
  })
})
