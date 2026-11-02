import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { AdapterBundle, AdapterModule, NativeResourceTransform } from '../packages/codex-adapter/src/contracts.js'
import { fixedNativeTransform } from '../packages/codex-adapter/src/fixed-transform.js'
import { TransformMaterializationSession } from '../packages/cli/src/launcher/codex-adapter/materialization.js'
import { selectAdapterModules } from '../packages/cli/src/launcher/codex-adapter/selection.js'

const source = 'export const value=1'
const input = { appVersion: 'unknown', buildNumber: 'future', resources: [{ url: 'app://-/assets/a.js', source }] }
const output = () => ({
  source: source + ';globalThis.ready=true',
  anchorMatches: 1,
  acknowledgementExpression: 'true',
  fenceExpression: 'true',
})
const transform = (run = vi.fn(output)): NativeResourceTransform => ({
  url: input.resources[0]!.url,
  sha256: createHash('sha256').update(source).digest('hex'),
  outputContract: 'fixed-original-v1',
  transform: run,
})
const module = (id: string, analyze: AdapterModule['analyze'], composes: string[] = []): AdapterModule => ({
  id,
  analyze,
  composes,
  requires: composes.map(id => ({ id, samePackage: true })),
})
const bundle = (modules: AdapterModule[]): AdapterBundle => ({
  apiVersion: 1,
  relayContract: 1,
  version: 'fixture',
  resourceHints: [],
  modules,
})

it('materializes each fixed transform identity once across validation, composition and final capture', () => {
  const first = vi.fn(output)
  const composed = vi.fn(output)
  const session = new TransformMaterializationSession()
  const plan = selectAdapterModules(
    [{
      identity: 'owned',
      bundle: bundle([
        module('submission', () => ({ transforms: [transform(first)] })),
        module('tasks', context => ({
          transforms: [{
            ...context.transforms[0]!,
            transform: observed => {
              context.transforms[0]!.transform(observed)
              return composed()
            },
          }],
        }), ['submission']),
        ...Array.from({ length: 15 }, (_, i) => module(`reader-${i}`, () => ({}))),
      ]),
    }],
    input,
    session,
  )
  const result = session.materialize(plan.transforms[0]!, source)
  expect(result.anchorMatches).toBe(1)
  expect(first).toHaveBeenCalledOnce()
  expect(composed).toHaveBeenCalledOnce()
  expect(plan.modules).toHaveLength(17)
  expect(() => session.materialize(plan.transforms[0]!, source + ' ')).toThrow('changed')
})

it('keeps legacy functions uncached and never shares memoized output between analysis sessions', () => {
  const run = vi.fn(output)
  const fixed = transform(run)
  new TransformMaterializationSession().materialize(fixed, source)
  new TransformMaterializationSession().materialize(fixed, source)
  expect(run).toHaveBeenCalledTimes(2)
  const { outputContract: _contract, ...legacy } = fixed
  const session = new TransformMaterializationSession()
  session.materialize(legacy, source)
  session.materialize(legacy, source)
  expect(run).toHaveBeenCalledTimes(4)
})

it('does not reuse a prior output for a new composed object and rolls back bad composition atomically', () => {
  const run = vi.fn(output)
  const bad = vi.fn(() => ({ ...output(), anchorMatches: 2 }))
  const plan = selectAdapterModules([{
    identity: 'owned',
    bundle: bundle([
      module('submission', () => ({ transforms: [transform(run)] })),
      module('tasks', context => ({ transforms: [{ ...context.transforms[0]!, transform: bad }] }), ['submission']),
    ]),
  }], input)
  expect(plan.modules.map(m => m.id)).toEqual(['submission'])
  expect(run).toHaveBeenCalledOnce()
  expect(bad).toHaveBeenCalledOnce()
  expect(plan.transforms[0]!.transform(source).anchorMatches).toBe(1)
})

it('owned task preflight memoizes only the fixed original bytes and freezes the complete result', () => {
  const run = vi.fn(output)
  const fixed = fixedNativeTransform(transform(run))
  expect(fixed.transform(source)).toBe(fixed.transform(source))
  expect(Object.isFrozen(fixed.transform(source))).toBe(true)
  expect(run).toHaveBeenCalledOnce()
  expect(() => fixed.transform(source + ' ')).toThrow('changed')
})
