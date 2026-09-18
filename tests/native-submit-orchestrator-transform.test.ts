import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import {
  NATIVE_SUBMIT_ORCHESTRATOR_ACKNOWLEDGEMENT,
  NATIVE_SUBMIT_ORCHESTRATOR_ACKNOWLEDGEMENT_BUILD_9275,
  NATIVE_SUBMIT_ORCHESTRATOR_FENCE,
  NATIVE_SUBMIT_ORCHESTRATOR_FENCE_BUILD_9275,
  NATIVE_SUBMIT_ORCHESTRATOR_RESOURCE,
  NATIVE_SUBMIT_ORCHESTRATOR_RESOURCE_BUILD_9275,
  NATIVE_SUBMIT_ORCHESTRATOR_TRANSFORM,
  NATIVE_SUBMIT_ORCHESTRATOR_TRANSFORM_BUILD_9275,
  transformNativeSubmitOrchestrator,
  transformNativeSubmitOrchestratorBuild9275,
} from '../packages/cli/src/renderer/adapter/native-submit-orchestrator-transform.js'

const anchor = 'skipGoalReplacementConfirmation:se=!1,skipGoalSubmit:ce=!1}=P;a();'
const contextAnchor = ';De={...t,threadReferences:n,'
const modelCallbackAnchor = 'Wt=(e,t)=>{dt(e,t)}'
const fixture = `let Wt;Wt=(e,t)=>{dt(e,t)};globalThis.selectModel=Wt;
globalThis.submit=async function(P={}) {
  let K={type:'worktree'},c,w,p,d='steer',h,ae,ie;
  let {${anchor}
  let t={input:P.input},n=[],De;De={...t,threadReferences:n,attachments:P.attachments};
  return De;
};`

const fixtureBuild9275 = `let dn;dn=(e,t)=>{Ot(e,t)};globalThis.selectModel=dn;
globalThis.submit=async function(F={}) {
  let K={type:'worktree'},l,T,m,f='steer',g,J,se;
  let {${'skipGoalReplacementConfirmation:le=!1,skipGoalSubmit:ue=!1}=F;a();'}
  let t={input:F.input},n=[],je;je={...t,threadReferences:n,attachments:F.attachments};
  return je;
};`

function runtime(hook?: (descriptor: unknown) => unknown) {
  const effects: string[] = []
  const activate = vi.fn()
  const sandbox = {
    a: () => effects.push('send'),
    __cordisxNativeSubmitHook: hook,
    __cordisxNativeSubmissionActivate: activate,
  } as Record<string, any>
  runInNewContext(transformNativeSubmitOrchestrator(fixture).source, sandbox)
  return { sandbox, effects, activate }
}

function runtimeBuild9275(hook?: (descriptor: unknown) => unknown) {
  const effects: string[] = []
  const activate = vi.fn()
  const sandbox = {
    a: () => effects.push('send'),
    __cordisxNativeSubmitHook: hook,
    __cordisxNativeSubmissionActivate: activate,
  } as Record<string, any>
  runInNewContext(transformNativeSubmitOrchestratorBuild9275(fixtureBuild9275).source, sandbox)
  return { sandbox, effects, activate }
}

describe('native submit orchestrator transform', () => {
  it('pins the audited resource and inserts an awaited guard before the first effect', () => {
    const result = transformNativeSubmitOrchestrator(fixture)
    expect(NATIVE_SUBMIT_ORCHESTRATOR_RESOURCE).toEqual({
      url: 'app://-/assets/app-primary-6cd7b8b3f5e3.js',
      sha256: '35d81a22c75f5a44b58baee0c0045ba6bb36cc9b387f43fab82178b4a2236849',
    })
    expect(NATIVE_SUBMIT_ORCHESTRATOR_TRANSFORM).toMatchObject(NATIVE_SUBMIT_ORCHESTRATOR_RESOURCE)
    expect(NATIVE_SUBMIT_ORCHESTRATOR_TRANSFORM.transform).toBe(transformNativeSubmitOrchestrator)
    expect(result.anchorMatches).toBe(1)
    expect(result.acknowledgementExpression).toBe(NATIVE_SUBMIT_ORCHESTRATOR_ACKNOWLEDGEMENT)
    expect(result.fenceExpression).toBe(NATIVE_SUBMIT_ORCHESTRATOR_FENCE)
    expect(result.source).toContain('__cxDecision=await __cxHook({')
    expect(result.source.indexOf('__cordisxNativeSubmitHook')).toBeLessThan(result.source.indexOf('a();'))
    expect(result.source).toContain('target:K.type,thread:c,response:w,followUp:p?.type')
    expect(result.source).toContain('promptOverride:ae!=null||ie!=null')
  })

  it('fails closed when the exact anchor is absent or duplicated', () => {
    expect(() => transformNativeSubmitOrchestrator('unrelated')).toThrow('found 0')
    expect(() => transformNativeSubmitOrchestrator(`${anchor}${anchor}`)).toThrow('found 2')
    expect(() => transformNativeSubmitOrchestrator(fixture.replace(contextAnchor, ';De={'))).toThrow(
      'context anchor, found 0',
    )
    expect(() => transformNativeSubmitOrchestrator(fixture + contextAnchor)).toThrow('context anchor, found 2')
    expect(() => transformNativeSubmitOrchestrator(fixture.replace(modelCallbackAnchor, 'Wt=dt'))).toThrow(
      'model callback anchor, found 0',
    )
    expect(() => transformNativeSubmitOrchestrator(fixture + modelCallbackAnchor)).toThrow(
      'model callback anchor, found 2',
    )
  })

  it('returns native model update completion instead of acknowledging the optimistic projection', async () => {
    let finish!: (value: boolean) => void
    const update = new Promise<boolean>(resolve => {
      finish = resolve
    })
    const run = runtime()
    run.sandbox.dt = () => update
    const result = run.sandbox.selectModel('model-b', 'high')
    expect(result).toBe(update)
    finish(true)
    await expect(result).resolves.toBe(true)
    run.sandbox.dt = async () => {
      throw new Error('native update failed')
    }
    await expect(run.sandbox.selectModel('model-b', 'high')).rejects.toThrow('native update failed')
  })

  it('denies before any native effect and preserves native pass-through when no hook exists', async () => {
    const denied = runtime(async () => ({ allow: false }))
    expect(await denied.sandbox.submit({ input: 'draft', attachments: ['a'] })).toBeUndefined()
    expect(denied.effects).toEqual([])
    const native = runtime()
    expect(await native.sandbox.submit({ input: 'draft', attachments: ['a'] })).toMatchObject({
      input: 'draft',
      attachments: ['a'],
    })
    expect(native.effects).toEqual(['send'])
  })

  it.each([null, true, {}, { allow: true, operationToken: 'short' }, { allow: true, operationToken: 'x'.repeat(257) }, {
    allow: true,
    operationToken: 'invalid\noperation-token',
  }])('rejects malformed hook decision %j', async decision => {
    const run = runtime(async () => decision)
    expect(await run.sandbox.submit()).toBeUndefined()
    expect(run.effects).toEqual([])
  })

  it('keeps operation tokens on their exact context when async admissions resolve in reverse order', async () => {
    const resolve: Array<(value: unknown) => void> = []
    const run = runtime(() => new Promise(done => resolve.push(done)))
    const first = run.sandbox.submit({ input: 'first' })
    const second = run.sandbox.submit({ input: 'second' })
    resolve[1]!({ allow: true, operationToken: 'operation-second-token' })
    resolve[0]!({ allow: true, operationToken: 'operation-first-token' })
    expect(await second).toMatchObject({ input: 'second', __cordisxOperationToken: 'operation-second-token' })
    expect(await first).toMatchObject({ input: 'first', __cordisxOperationToken: 'operation-first-token' })
    expect(run.effects).toHaveLength(2)
  })

  it('acknowledges executed transformation and fences only its own managed hook', () => {
    const run = runtime(async () => ({ allow: false }))
    expect(run.activate).toHaveBeenCalledOnce()
    expect(run.activate).toHaveBeenCalledWith(true)
    expect(runInNewContext(NATIVE_SUBMIT_ORCHESTRATOR_ACKNOWLEDGEMENT, run.sandbox)).toBe(true)
    runInNewContext(NATIVE_SUBMIT_ORCHESTRATOR_FENCE, run.sandbox)
    expect(runInNewContext(NATIVE_SUBMIT_ORCHESTRATOR_ACKNOWLEDGEMENT, run.sandbox)).toBe(false)
    expect(run.sandbox.__cordisxNativeSubmitHook).toBeUndefined()
  })

  it('supports the exact audited build-9275 primary resource and fails closed on drift', () => {
    const result = transformNativeSubmitOrchestratorBuild9275(fixtureBuild9275)
    expect(NATIVE_SUBMIT_ORCHESTRATOR_RESOURCE_BUILD_9275).toEqual({
      url: 'app://-/assets/app-primary-4af6ed7f68d1.js',
      sha256: '6d75ae321771510842fbcc303846913f7434bc8a67e0c69fb5adb22c632eb3ac',
    })
    expect(NATIVE_SUBMIT_ORCHESTRATOR_TRANSFORM_BUILD_9275).toMatchObject(
      NATIVE_SUBMIT_ORCHESTRATOR_RESOURCE_BUILD_9275,
    )
    expect(result.anchorMatches).toBe(1)
    expect(result.source).toContain('__cxDecision=await __cxHook({')
    expect(result.source.indexOf('__cordisxNativeSubmitHook')).toBeLessThan(result.source.indexOf('a();'))
    expect(result.source).toContain(
      '__cordisxOperationToken:__cxDecision.operationToken}),threadReferences:n,',
    )
    expect(() => transformNativeSubmitOrchestratorBuild9275('unrelated')).toThrow('found 0')
    expect(() => transformNativeSubmitOrchestratorBuild9275(fixtureBuild9275 + fixtureBuild9275)).toThrow('found 2')
  })

  it('preserves build-9275 model completion and submission admission semantics', async () => {
    let finish!: (value: boolean) => void
    const update = new Promise<boolean>(resolve => {
      finish = resolve
    })
    const run = runtimeBuild9275(async () => ({ allow: true, operationToken: 'operation-build-9275' }))
    run.sandbox.Ot = () => update
    const modelResult = run.sandbox.selectModel('model-b', 'high')
    expect(modelResult).toBe(update)
    finish(true)
    await expect(modelResult).resolves.toBe(true)
    await expect(run.sandbox.submit({ input: 'draft' })).resolves.toMatchObject({
      input: 'draft',
      __cordisxOperationToken: 'operation-build-9275',
    })
    expect(run.effects).toEqual(['send'])
    expect(run.activate).toHaveBeenCalledWith(true)
    expect(runInNewContext(NATIVE_SUBMIT_ORCHESTRATOR_ACKNOWLEDGEMENT_BUILD_9275, run.sandbox)).toBe(true)
    runInNewContext(NATIVE_SUBMIT_ORCHESTRATOR_FENCE_BUILD_9275, run.sandbox)
    expect(runInNewContext(NATIVE_SUBMIT_ORCHESTRATOR_ACKNOWLEDGEMENT_BUILD_9275, run.sandbox)).toBe(false)

    const denied = runtimeBuild9275(async () => ({ allow: false }))
    await expect(denied.sandbox.submit({ input: 'blocked' })).resolves.toBeUndefined()
    expect(denied.effects).toEqual([])
  })
})
