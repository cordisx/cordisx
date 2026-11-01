import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { analyzeNativeSubmissionTransforms } from '../packages/cli/src/launcher/native-submission-structure.js'
import { resources } from './fixtures/native-submission-structure.js'

// Synthetic lazy normalization, including native workspace edits and two callers.
const factory =
  'let makeWire=()=>{let current=prepared.request;return (workspaceCurrent()||(current={...current,sandboxPolicy:null},recordWorkspace()),useDirect()?current:normalizeWire(current,manager.requestClient.getAppServerVersion()));};'
function fixture(body = factory, call = 'makeWire()') {
  const source = resources()
  source[1]!.source = source[1]!.source.replace(
    'let wire=normalizeWire(prepared.request,manager.requestClient.getAppServerVersion());',
    body
      + " await assertCurrent();await beforeSend();let options=requestOptions();if(useExtension())return await manager.sendExtension('turn/addUserMessage',{...makeWire(),messageId:'synthetic'},options);",
  ).replace("manager.sendRequest('turn/start',wire)", "manager.sendRequest('turn/start'," + call + ',options)')
  return source
}
function runtime(source = fixture()) {
  const effects: string[] = []
  const sandbox = {
    workspaceCurrent: () => {
      effects.push('workspace')
      return false
    },
    recordWorkspace: () => effects.push('workspace-edit'),
    useDirect: () => false,
    useExtension: () => false,
    assertCurrent: async () => {
      effects.push('assert')
    },
    beforeSend: async () => {
      effects.push('before-send')
    },
    requestOptions: () => {
      effects.push('options')
      return { priority: 'critical', trace: 'synthetic' }
    },
    normalizeWire: vi.fn((request: any) => {
      effects.push('normalize')
      return { input: request.input, sandboxPolicy: request.sandboxPolicy, extra: 'native', config: { safe: true } }
    }),
    updateModel: vi.fn(),
    __cordisxNativeSubmissionActivate: vi.fn(),
    dispatch: undefined as any,
  }
  for (const transform of analyzeNativeSubmissionTransforms(source).transforms) {
    const resource = source.find(resource => resource.url === transform.url)!
    runInNewContext(transform.transform(resource.source).source, sandbox)
  }
  const manager = {
    getConversation: () => ({}),
    requestClient: {
      getAppServerVersion: () => {
        effects.push('version')
        return 'synthetic'
      },
    },
    sendRequest: vi.fn(async (_method: string, request: any, _options: any) => {
      effects.push('send')
      return request
    }),
    sendExtension: vi.fn(async (_method: string, request: any, _options: any) => {
      effects.push('extension')
      return request
    }),
  }
  return {
    sandbox,
    manager,
    effects,
    dispatch: (request: any) => sandbox.dispatch({ manager, operation: { request } }),
  }
}

describe('lazy native wire normalization', () => {
  it.each([false, true])('preserves both native callers and options (extension: %s)', async extension => {
    const run = runtime()
    run.sandbox.useExtension = () => extension
    const token = 'synthetic-operation-token'
    const request = { input: 'hello', sandboxPolicy: 'native', config: { 'cordisx.operation_token': token } }
    const result = await run.dispatch(request)
    expect(result).toEqual({
      input: 'hello',
      sandboxPolicy: null,
      extra: 'native',
      config: { safe: true, 'cordisx.operation_token': token },
      ...(extension ? { messageId: 'synthetic' } : {}),
    })
    expect(run.effects).toEqual([
      'assert',
      'before-send',
      'options',
      'workspace',
      'workspace-edit',
      'version',
      'normalize',
      extension ? 'extension' : 'send',
    ])
    expect(run.sandbox.normalizeWire).toHaveBeenCalledTimes(1)
    expect(extension ? run.manager.sendExtension : run.manager.sendRequest).toHaveBeenCalledWith(
      extension ? 'turn/addUserMessage' : 'turn/start',
      result,
      { priority: 'critical', trace: 'synthetic' },
    )
    expect(extension ? run.manager.sendRequest : run.manager.sendExtension).not.toHaveBeenCalled()
    expect(request.sandboxPolicy).toBe('native')
    expect(request.config).toEqual({ 'cordisx.operation_token': token })
  })
  it.each([undefined, '', 'short', 'invalid-token-with-newline\n', 'synthetic-operation-token'])(
    'does not invent authority or alter direct/native fields (token: %s)',
    async token => {
      const run = runtime()
      run.sandbox.workspaceCurrent = () => true
      run.sandbox.useDirect = () => true
      const request = {
        input: 'hello',
        sandboxPolicy: 'native',
        config: token === undefined ? undefined : { 'cordisx.operation_token': token },
      }
      const result = await run.dispatch(request)
      expect(result).toEqual(request)
      if (token !== 'synthetic-operation-token') expect(result).toBe(request)
      expect(run.sandbox.normalizeWire).not.toHaveBeenCalled()
    },
  )
  it('leaves a tokenless normalized request unchanged', async () => {
    const run = runtime()
    const result = await run.dispatch({ input: 'hello' })
    expect(result).toEqual({ input: 'hello', sandboxPolicy: null, extra: 'native', config: { safe: true } })
    expect(result).toBe(run.sandbox.normalizeWire.mock.results[0]!.value)
  })
  it('reads the prepared request once and preserves native guard failure', async () => {
    const source = fixture()
    source[1]!.source = source[1]!.source.replace(
      'let prepared={request:n.request};',
      'let prepared={get request(){return readRequest(n.request)}};',
    )
    const run = runtime(source)
    const readRequest = vi.fn(value => value)
    Object.assign(run.sandbox, { readRequest })
    await run.dispatch({ input: 'hello' })
    expect(readRequest).toHaveBeenCalledTimes(1)
    readRequest.mockClear()
    run.sandbox.assertCurrent = async () => {
      throw new Error('native guard')
    }
    await expect(run.dispatch({ input: 'blocked' })).rejects.toThrow('native guard')
    expect(readRequest).not.toHaveBeenCalled()
    expect(run.manager.sendRequest).toHaveBeenCalledTimes(1)
  })
  it('does not send if normalization throws', async () => {
    const run = runtime()
    run.sandbox.normalizeWire.mockImplementation(() => {
      throw new Error('native normalize')
    })
    await expect(run.dispatch({ input: 'hello' })).rejects.toThrow('native normalize')
    expect(run.manager.sendRequest).not.toHaveBeenCalled()
    expect(run.manager.sendExtension).not.toHaveBeenCalled()
  })
  it('isolates concurrent requests and avoids existing carrier bindings', async () => {
    const source = fixture(
      factory.replace('let current=', 'let __cordisxOperationRequest, __cordisxNormalizedWire;let current='),
    )
    const run = runtime(source)
    const tokens = ['first-synthetic-token', 'second-synthetic-token']
    const results = await Promise.all(
      tokens.map(token => run.dispatch({ input: token, config: { 'cordisx.operation_token': token } })),
    )
    expect(results.map((result: any) => result.config['cordisx.operation_token'])).toEqual(tokens)
  })
  it.each([
    ['let makeWire=async()=>{return prepared.request;};', 'makeWire()'],
    ['let makeWire=(input)=>{return input;};', 'makeWire(prepared.request)'],
    ['let makeWire=()=>unknownRequest();', 'makeWire()'],
    ['let makeWire=()=>{if(useDirect())return prepared.request;return other.request;};', 'makeWire()'],
    ['let makeWire=()=>{let current=unknownRequest();return current;};', 'makeWire()'],
    [
      'let makeWire=()=>{let current=prepared.request,other=unrelated.request;return useDirect()?current:other;};',
      'makeWire()',
    ],
    ['let makeWire=()=>{let current=prepared.request;return useDirect()?current:unknownRequest();};', 'makeWire()'],
    ['let makeWire=()=>{let current=prepared.request;current=unrelated.request;return current;};', 'makeWire()'],
    ['let makeWire=()=>{let current=prepared.request;current={...current,config:{}};return current;};', 'makeWire()'],
    ['let makeWire=()=>{let current=prepared.request;return current++;};', 'makeWire()'],
    ['let current=prepared.request;let makeWire=()=>{return current;};', 'makeWire()'],
    [factory, 'unknownRequest()'],
    [factory, 'makeWire?.()'],
    [factory, 'manager.makeWire()'],
  ])('fails closed for unsupported/ambiguous factories: %s', (body, call) => {
    expect(() => analyzeNativeSubmissionTransforms(fixture(body, call))).toThrow()
  })
})
