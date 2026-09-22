import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { nativeSubmissionTransformsForApp } from '../packages/cli/src/launcher/native-submission-composition.js'
import { resources } from './fixtures/native-submission-structure.js'

const token = 'operation-unique-token'
function runtime(hook: unknown = async () => ({ allow: true, operationToken: token }), source = resources()) {
  const transforms = nativeSubmissionTransformsForApp('unknown-version', 'unknown-build', source)
  const effects: string[] = []
  const sandbox: Record<string, any> = {
    __cordisxNativeSubmitHook: hook,
    __cordisxNativeSubmissionActivate: vi.fn(),
    updateModel: vi.fn(async () => true),
    createNativeThread: vi.fn(async () => ({ conversationResponse: { model: 'deepseek-v4-flash' } })),
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

function dispatchManager(sendRequest = vi.fn(async (_method: string, value: unknown) => value)) {
  return {
    getConversation: () => ({}),
    requestClient: { getAppServerVersion: () => 'future' },
    sendRequest,
  }
}

describe('structure-based native submission composition', () => {
  it('uses the accepted first-thread model for the native collaboration baseline', async () => {
    const run = runtime()
    const mode = { mode: 'default', settings: { model: 'gpt-5.6-sol', reasoning_effort: 'medium' } }
    const request = await run.sandbox.first({
      input: 'message',
      config: { 'cordisx.operation_token': token },
      collaborationMode: mode,
    })
    expect(request.collaborationMode.settings.model).toBe('deepseek-v4-flash')
    expect(mode.settings.model).toBe('gpt-5.6-sol')
    expect(run.sandbox.updateModel).not.toHaveBeenCalled()
  })
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
  it('resolves model completion in its owner rather than unrelated minified names', () => {
    const source = resources()
    source[0]!.source += '\nfunction unrelated(){let select;select=(a,b,c)=>d=>a(d)}'
    const run = runtime(null, source)
    expect(run.sandbox.menu.onSelectModel('model', 'high')).toBeInstanceOf(Promise)
    expect(run.sandbox.updateModel).toHaveBeenCalledWith('model', 'high')
  })
  it('awaits admission before additional native guards and effects without requiring adjacency', async () => {
    const source = resources()
    source[0]!.source = source[0]!.source.replace('clear();', 'if(nativePaused())return;extraEffect();clear();')
    let resolve!: (value: unknown) => void
    const run = runtime(() =>
      new Promise(done => {
        resolve = done
      }), source)
    run.sandbox.nativePaused = vi.fn(() => false)
    run.sandbox.extraEffect = vi.fn()
    const denied = run.submit()
    expect(run.sandbox.nativePaused).not.toHaveBeenCalled()
    expect(run.sandbox.extraEffect).not.toHaveBeenCalled()
    resolve({ allow: false })
    await denied
    expect(run.effects).toEqual([])
    expect(run.sandbox.nativePaused).not.toHaveBeenCalled()
    const accepted = run.submit()
    resolve({ allow: true, operationToken: token })
    expect(await accepted).toHaveProperty('__cordisxOperationToken', token)
    expect(run.sandbox.extraEffect).toHaveBeenCalledTimes(1)
    expect(run.effects).toEqual(['send'])
    run.sandbox.nativePaused.mockReturnValue(true)
    const paused = run.submit()
    resolve({ allow: true, operationToken: token })
    expect(await paused).toBeUndefined()
    expect(run.sandbox.extraEffect).toHaveBeenCalledTimes(1)
    expect(run.effects).toEqual(['send'])
  })
  it('rejects reversed effects or broken draft config propagation', () => {
    const reversed = resources()
    reversed[0]!.source = reversed[0]!.source.replace('  let {skipGoal', '  clear();let {skipGoal')
      .replace('clear();let draft', 'let draft')
    expect(() => nativeSubmissionTransformsForApp('future', 'x', reversed)).toThrow('guard ordering changed')
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
  it('carries a new-thread token through first turn and final dispatch despite an inner operation-name shadow', async () => {
    const run = runtime()
    const context = await run.submit()
    expect(context.__cordisxOperationToken).toBe(token)
    run.sandbox.__cordisxNativeServiceTierOverride = 'priority'
    const draft = await run.sandbox.draft({ context, prompt: 'message', serviceTier: null })
    expect(draft.configOverrides).toEqual({ safe: 'retained', 'cordisx.operation_token': token })
    const first = await run.sandbox.first({ config: draft.configOverrides, input: 'message', serviceTier: null })
    expect(first.config).toEqual({ 'cordisx.operation_token': token })
    const normalized = await run.sandbox.normalize({}, 'thread', { request: first, context: {} })
    expect(normalized.request.config).toEqual({ 'cordisx.operation_token': token })
    const sendRequest = vi.fn(async (_method, value) => value)
    const wire = await run.sandbox.dispatch({
      manager: dispatchManager(sendRequest),
      operation: normalized,
    })
    expect(wire).toMatchObject({ permission: 'preserved', config: { 'cordisx.operation_token': token } })
    expect(sendRequest).toHaveBeenCalledWith('turn/start', wire)
  })
  it('carries an existing idle thread token through normal dispatch despite the same inner shadow', async () => {
    const run = runtime()
    const context = await run.submit()
    const request = await run.sandbox.existing({ context, targetConversationId: 'thread', serviceTier: null })
    expect(request.serviceTier).toBeNull()
    const normalized = await run.sandbox.normalize({}, 'thread', { request, context: {} })
    const wire = await run.sandbox.dispatch({ manager: dispatchManager(), operation: normalized })
    expect(wire).toMatchObject({ permission: 'preserved', config: { 'cordisx.operation_token': token } })
  })
  it('leaves an official request without a token unchanged through final dispatch', async () => {
    const run = runtime(null)
    const context = await run.submit()
    const request = await run.sandbox.existing({ context, targetConversationId: 'thread', serviceTier: null })
    const normalized = await run.sandbox.normalize({}, 'thread', { request, context: {} })
    const wire = await run.sandbox.dispatch({ manager: dispatchManager(), operation: normalized })
    expect(wire).toEqual({ input: request.input, permission: 'preserved' })
  })
  it('chooses a collision-free request capture binding', async () => {
    const source = resources()
    source[1]!.source = source[1]!.source.replace(
      'let prepared={request:n.request};',
      'let __cordisxOperationRequest=true,prepared={request:n.request};',
    )
    const run = runtime(undefined, source)
    const context = await run.submit()
    const request = await run.sandbox.existing({ context, targetConversationId: 'thread', serviceTier: null })
    const normalized = await run.sandbox.normalize({}, 'thread', { request, context: {} })
    await expect(run.sandbox.dispatch({ manager: dispatchManager(), operation: normalized })).resolves.toMatchObject({
      config: { 'cordisx.operation_token': token },
    })
    const transformed = run.transforms[1]!.transform(source[1]!.source).source
    expect(transformed).toContain('__cordisxOperationRequest2=prepared.request')
  })
  it('does not alter the active-turn steer boundary', async () => {
    const run = runtime()
    const request = { threadId: 'thread', input: 'steer' }
    const sendRequest = vi.fn(async (_method, value) => value)
    await expect(run.sandbox.steer(dispatchManager(sendRequest), request)).resolves.toEqual(request)
    expect(sendRequest).toHaveBeenCalledWith('turn/steer', request)
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
