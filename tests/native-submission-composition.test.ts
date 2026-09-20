import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { nativeSubmissionTransformsForApp } from '../packages/cli/src/launcher/native-submission-composition.js'
import { resources } from './fixtures/native-submission-structure.js'

const token = 'operation-unique-token'
function runtime(hook: unknown = async () => ({ allow: true, operationToken: token })) {
  const source = resources()
  const transforms = nativeSubmissionTransformsForApp('unknown-version', 'unknown-build', source)
  const effects: string[] = []
  const sandbox: Record<string, any> = {
    __cordisxNativeSubmitHook: hook,
    __cordisxNativeSubmissionActivate: vi.fn(),
    updateModel: vi.fn(async () => true),
    normalizeWire: (request: Record<string, unknown>) => ({ input: request.input, permission: 'preserved' }),
  }
  transforms.forEach((transform, i) => runInNewContext(transform.transform(source[i]!.source).source, sandbox))
  const submit = (input = 'message') =>
    sandbox.submit({
      clearStopTurnConfirmation: () => effects.push('send'),
      submitTarget: { type: 'local' },
      isResponseInProgress: false,
      options: { input },
      conversationId: 'thread',
      defaultFollowUpSubmitAction: 'steer',
    })
  return { sandbox, effects, transforms, source, submit }
}

describe('structure-based native submission composition', () => {
  it('recognizes renamed local bindings, changed asset names and added whitespace', () => {
    const changed = resources().map(resource => ({
      url: resource.url.replace('unrecognized', 'new-content-hash'),
      source: resource.source.replace(/\bclear\b/g, 'renamedClear').replace(/\bwire\b/g, 'renamedWire').replace(
        /;/g,
        ';\n',
      ),
    }))
    const transforms = nativeSubmissionTransformsForApp('unknown', 'new', changed)
    expect(transforms).toHaveLength(2)
    expect(transforms[0]!.transform(changed[0]!.source).source).toContain('renamedClear()')
    expect(transforms[1]!.transform(changed[1]!.source).source).toContain('renamedWire.config')
  })
  it.each([['future', 'unknown'], ['26.915.31945', '9922'], ['', '']])(
    'does not use identity %s/%s as admission',
    (version, build) => {
      const transforms = nativeSubmissionTransformsForApp(version, build, resources())
      expect(transforms).toHaveLength(2)
      expect(transforms[0]!.url).toBe(resources()[0]!.url)
      expect(transforms[0]!.sha256).toMatch(/^[a-f0-9]{64}$/)
    },
  )
  it('rejects missing, duplicate and malformed structures with specific diagnostics', () => {
    const missing = resources()
    missing[0]!.source = missing[0]!.source.replace('skipGoalSubmit:', 'unknownOption:')
    expect(() => nativeSubmissionTransformsForApp('future', 'x', missing)).toThrow('submit-options')
    const duplicate = resources()
    duplicate.push({ url: 'app://-/assets/duplicate.js', source: duplicate[0]!.source })
    expect(() => nativeSubmissionTransformsForApp('future', 'x', duplicate)).toThrow('submit-guard')
    expect(() =>
      nativeSubmissionTransformsForApp('future', 'x', [{ url: 'app://-/assets/bad.js', source: 'async function {' }])
    ).toThrow('incompatible')
  })
  it('fences resource changes between discovery and interception', () => {
    const run = runtime()
    expect(() => run.transforms[0]!.transform(run.source[0]!.source + '\n')).toThrow(
      'changed after capability discovery',
    )
  })
  it('rejects an inserted pre-admission effect or broken draft config propagation', () => {
    const effects = resources()
    effects[0]!.source = effects[0]!.source.replace('clear();', 'sendBeforeAdmission();clear();')
    expect(() => nativeSubmissionTransformsForApp('future', 'x', effects)).toThrow('guard ordering changed')
    const broken = resources()
    broken[1]!.source = broken[1]!.source.replace('config:overrides', 'config:undefined')
    expect(() => nativeSubmissionTransformsForApp('future', 'x', broken)).toThrow('draft-config-forward')
  })
  it.each([null, {}, { allow: false }, { allow: true, operationToken: 'short' }, {
    allow: true,
    operationToken: 'invalid\nlong-token',
  }])('denies invalid admission before native effects: %j', async result => {
    const run = runtime(async () => result)
    expect(await run.submit()).toBeUndefined()
    expect(run.effects).toEqual([])
  })
  it('preserves native pass-through with no hook and awaits model update completion', async () => {
    const run = runtime(null)
    expect(await run.submit()).not.toHaveProperty('__cordisxOperationToken')
    expect(run.effects).toEqual(['send'])
    let resolve!: (value: boolean) => void
    const pending = new Promise<boolean>(done => {
      resolve = done
    })
    run.sandbox.updateModel = () => pending
    expect(run.sandbox.menu.onSelectModel('model', 'high')).toBe(pending)
    resolve(true)
    await expect(pending).resolves.toBe(true)
  })
  it('carries the token through draft, first turn, normalization and final dispatch without touching permissions', async () => {
    const run = runtime()
    const context = await run.submit()
    expect(context.__cordisxOperationToken).toBe(token)
    run.sandbox.__cordisxNativeServiceTierOverride = 'priority'
    const draft = await run.sandbox.draft({ context, prompt: 'message', serviceTier: null })
    expect(draft.configOverrides).toEqual({ safe: 'retained', 'cordisx.operation_token': token })
    const first = await run.sandbox.first({ config: draft.configOverrides, input: 'message', serviceTier: null })
    expect(first.config).toEqual({ 'cordisx.operation_token': token })
    const request = await run.sandbox.existing({ context, targetConversationId: 'thread', serviceTier: null })
    expect(request.serviceTier).toBe('priority')
    const normalized = await run.sandbox.normalize({}, 'thread', { request, context: {} })
    expect(normalized.request.config).toEqual({ 'cordisx.operation_token': token })
    const sendRequest = vi.fn(async (_method, value) => value)
    const wire = await run.sandbox.dispatch({
      manager: { requestClient: { getAppServerVersion: () => 'future' }, sendRequest },
      operation: normalized,
    })
    expect(wire).toMatchObject({ permission: 'preserved', config: { 'cordisx.operation_token': token } })
    expect(sendRequest).toHaveBeenCalledWith('turn/start', wire)
  })
  it('keeps concurrent admission tokens on their own contexts and removes authority on disposal', async () => {
    const resolve: Array<(value: unknown) => void> = []
    const run = runtime(() => new Promise(done => resolve.push(done)))
    const a = run.submit('a'), b = run.submit('b')
    resolve[1]!({ allow: true, operationToken: 'second-operation-token' })
    resolve[0]!({ allow: true, operationToken: 'first-operation-token' })
    expect(await a).toMatchObject({ input: 'a', __cordisxOperationToken: 'first-operation-token' })
    expect(await b).toMatchObject({ input: 'b', __cordisxOperationToken: 'second-operation-token' })
    const result = run.transforms[0]!.transform(run.source[0]!.source)
    expect(runInNewContext(result.acknowledgementExpression, run.sandbox)).toBe(true)
    runInNewContext(result.fenceExpression, run.sandbox)
    expect(runInNewContext(result.acknowledgementExpression, run.sandbox)).toBe(false)
    expect(run.sandbox.__cordisxNativeSubmitHook).toBeUndefined()
  })
})
