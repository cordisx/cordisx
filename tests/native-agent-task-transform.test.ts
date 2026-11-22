import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import {
  applyAgentTaskStructure,
  nativeAgentTaskTransforms,
} from '../packages/cli/src/launcher/native-agent-task-transform.js'
import { taskExecutionSource, taskInitialSource } from './fixtures/native-agent-task-source.js'

function world() {
  const handle = { token: 'opaque-operation-token', model: 'provider-model' }
  const start = vi.fn(async (request: unknown) => request), queue = vi.fn(async (request: unknown) => request)
  const value: Record<string, any> = {
    start,
    queue,
    parse: (value: unknown) => value,
    state: {},
    collaboration: (model: string, thinking: string) => ({ settings: { model, thinking } }),
    inputs: async ({ model, thinking }: any) => ({
      collaborationMode: { settings: { model, thinking } },
      configOverrides: { permissions: 'native' },
    }),
    __cordisxNativeAgentTaskAdapter: { owns: (value: unknown) => value === handle, claim: vi.fn(async () => handle) },
  }
  runInNewContext(
    applyAgentTaskStructure(taskInitialSource, 'initial').replace('export {create as nativeCreate};', ''),
    value,
  )
  return { value, handle, start, queue }
}
describe('structural native task creation', () => {
  it('keeps native guards, local and worktree helpers, and first-turn identity', async () => {
    const { value, handle, start, queue } = world()
    await expect(value.create({ config: { unsafe: 1 }, sourceThreadId: 'source', target: {} })).rejects.toThrow(
      'delegated',
    )
    await expect(value.create({ __cordisxTask: { ...handle }, target: {} })).rejects.toThrow('Invalid native')
    await value.create({ __cordisxTask: handle, target: { type: 'projectless' }, model: 'native', prompt: 'prompt' })
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        collaborationMode: { settings: { model: 'provider-model', thinking: undefined } },
        config: { 'cordisx.operation_token': handle.token },
        responsesapiClientMetadata: { 'cordisx.operation_token': handle.token },
      }),
    )
    await value.create({ __cordisxTask: handle, target: { type: 'worktree' }, model: 'native', prompt: 'prompt' })
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({
        startConversationParamsInput: {
          collaborationMode: { settings: { model: 'provider-model', thinking: undefined } },
          configOverrides: { permissions: 'native', 'cordisx.operation_token': handle.token },
          responsesapiClientMetadata: { 'cordisx.operation_token': handle.token },
        },
      }),
    )
    const executeTurnStart = vi.fn(async (_id: string, request: unknown) => request)
    await value.first({}, { executeTurnStart }, { config: { 'cordisx.operation_token': handle.token } }, {})
    expect(executeTurnStart).toHaveBeenCalledWith(
      'created',
      expect.objectContaining({
        request: expect.objectContaining({ config: { 'cordisx.operation_token': handle.token } }),
      }),
    )
  })
  it('carries inherited effort while preserving an explicit native effort', async () => {
    const { value, handle, start } = world()
    ;(handle as any).reasoningEffort = 'high'
    await value.create({ __cordisxTask: handle, target: { type: 'projectless' }, model: 'native' })
    expect(start.mock.calls.at(-1)?.[0]).toMatchObject({
      collaborationMode: { settings: { model: 'provider-model', thinking: 'high' } },
    })
    await value.create({ __cordisxTask: handle, target: { type: 'projectless' }, model: 'native', thinking: 'low' })
    expect(start.mock.calls.at(-1)?.[0]).toMatchObject({
      collaborationMode: { settings: { model: 'provider-model', thinking: 'low' } },
    })
  })
  it('joins actual dispatcher metadata to original arguments despite target shadowing', async () => {
    const { value, handle } = world()
    runInNewContext(applyAgentTaskStructure(taskExecutionSource, 'execution').replace(/import[^;]+;/, ''), value)
    const args = { target: { type: 'projectless' }, model: 'native', prompt: 'original' }
    await value.dispatch({ callId: 'cordisx-task-actual', arguments: args })
    expect(value.__cordisxNativeAgentTaskAdapter.claim).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'cordisx-task-actual', arguments: args, sourceThreadId: 'source' }),
    )
    value.__cordisxNativeAgentTaskAdapter.claim.mockResolvedValueOnce(undefined)
    await expect(value.dispatch({ callId: 'cordisx-task-actual', arguments: args })).rejects.toThrow(
      'routing unavailable',
    )
    expect(handle.model).toBe('provider-model')
  })
  it('runs renamed bindings and relocated assets across version strings', async () => {
    const renamedInitial = taskInitialSource.replaceAll('model:model', 'model:chosen').replaceAll(
      'collaboration(model,',
      'collaboration(chosen,',
    ).replaceAll('initial.js', 'new-entry.js').replace(/\s+/g, ' ')
    const renamedExecution = taskExecutionSource.replace('./initial.js', './new-entry.js').replace(/\s+/g, ' ')
    const resources = [{ url: 'app://-/assets/new-entry.js', source: renamedInitial }, {
      url: 'app://-/assets/new-dispatch.js',
      source: renamedExecution,
    }]
    const result = nativeAgentTaskTransforms('future', 'unknown', resources, [])
    expect(result.available).toBe(true)
    expect(result.transforms.every(t => t.taskExecutionUrl === resources[1]!.url)).toBe(true)
    const { value, handle } = world()
    runInNewContext(
      result.transforms[0]!.transform(renamedInitial).source.replace('export {create as nativeCreate};', ''),
      value,
    )
    runInNewContext(result.transforms[1]!.transform(renamedExecution).source.replace(/import[^;]+;/, ''), value)
    const created = await value.dispatch({
      callId: 'cordisx-task-renamed',
      arguments: { target: { type: 'projectless' }, model: 'native', prompt: 'original' },
    })
    expect(created.config['cordisx.operation_token']).toBe(handle.token)
    expect(created.collaborationMode.settings.model).toBe(handle.model)
    const executeTurnStart = vi.fn(async (_: string, request: unknown) => request)
    await value.first({}, { executeTurnStart }, created, {})
    expect(executeTurnStart).toHaveBeenCalledWith(
      'created',
      expect.objectContaining({
        request: expect.objectContaining({ config: { 'cordisx.operation_token': handle.token } }),
      }),
    )
  })

  it('leaves ordinary native creation unchanged without a correlated handle', async () => {
    const { value, start } = world()
    value.__cordisxNativeAgentTaskAdapter.claim.mockResolvedValue(undefined)
    runInNewContext(applyAgentTaskStructure(taskExecutionSource, 'execution').replace(/import[^;]+;/, ''), value)
    await value.dispatch({
      callId: 'ordinary',
      arguments: { target: { type: 'projectless' }, model: 'native', prompt: 'original' },
    })
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        collaborationMode: { settings: { model: 'native', thinking: undefined } },
        config: undefined,
      }),
    )
  })
  it('keeps concurrent native calls scoped to each original call identity', async () => {
    const { value } = world()
    const handles = new Map([['cordisx-task-first', { token: 'first-token', model: 'first-model' }], [
      'cordisx-task-second',
      { token: 'second-token', model: 'second-model' },
    ]])
    value.__cordisxNativeAgentTaskAdapter.owns = (h: unknown) => [...handles.values()].includes(h as any)
    value.__cordisxNativeAgentTaskAdapter.claim = async (request: any) => {
      await new Promise(resolve => setTimeout(resolve, request.callId.endsWith('first') ? 5 : 0))
      return handles.get(request.callId)
    }
    runInNewContext(applyAgentTaskStructure(taskExecutionSource, 'execution').replace(/import[^;]+;/, ''), value)
    const results = await Promise.all(
      [...handles].map(([callId]) =>
        value.dispatch({ callId, arguments: { target: { type: 'projectless' }, prompt: callId, model: 'native' } })
      ),
    )
    expect(results.map(r => r.config['cordisx.operation_token'])).toEqual(['first-token', 'second-token'])
    expect(results.map(r => r.collaborationMode.settings.model)).toEqual(['first-model', 'second-model'])
  })

  it('links duplicated Rspack factories and preserves the correlated native creation path', async () => {
    const worktree = /async function worktree\([\s\S]+?\n\}/u.exec(taskInitialSource)![0]
      .replace('async function worktree(', 'async function(')
    const initial = taskInitialSource
      .replace(/async function worktree\([\s\S]+?\n\}/u, '')
      .replace('return worktree(', `return (${worktree})(`)
      .replace('settings!=null&&source!=null', 'null!=settings&&null!=source')
      .replace('async function create(', 'require.d(exports,{},{Nw:async function(')
      .replace('}\nasync function local(', '}});\nasync function local(')
      .replace('export {create as nativeCreate};', '')
      .replace(
        'globalThis.create=create;globalThis.local=local;globalThis.worktree=worktree;globalThis.first=first;',
        '',
      )
    const dispatcher = `var native=require('helper');
      async function dispatch(message){return await (async function({scope:store,argumentsValue:args,sourceThreadId:source,parentTurnId:parent,rootTurnId:root}) {
        const parsed=parse(args), target=parsed.target;
        return await (0,native.Nw)({scope:store,turnTrigger:'app_tool_create_thread',sourceThreadId:source,target:target,model:parsed.model,prompt:parsed.prompt,parentTurnId:parent,rootTurnId:root});
      })({scope:state,argumentsValue:message.arguments,sourceThreadId:'source',parentTurnId:'parent',rootTurnId:'root'})};
      globalThis.dispatch=dispatch;`
    const source =
      `export const __webpack_modules__={helper:function(module,exports,require){${initial}},dispatcher:function(module,exports,require){${dispatcher}}};`
    const duplicate = `export const __webpack_modules__={helper:function(module,exports,require){${initial}}};`
    const resources = [
      { url: 'app://-/assets/combined.js', source },
      { url: 'app://-/assets/duplicate.js', source: duplicate },
    ]
    const firstTurn = {
      url: 'app://-/assets/carrier.js',
      sha256: 'unused',
      taskFirstTurnCarrier: true,
      transform: () => {
        throw Error('not called')
      },
    }
    const result = nativeAgentTaskTransforms('future', 'unknown', resources, [firstTurn])
    expect(result.available).toBe(true)
    expect(result.transforms.filter(t => t.taskExecutionUrl).map(t => t.url)).toEqual(resources.map(r => r.url))
    expect(nativeAgentTaskTransforms('future', 'unknown', resources, []).available).toBe(false)
    const wrongLink = resources.map((r, i) =>
      i ? r : { ...r, source: r.source.replace("require('helper')", "require('different')") }
    )
    expect(nativeAgentTaskTransforms('future', 'unknown', wrongLink, [firstTurn]).available).toBe(false)
    const { value, handle, start, queue } = world()
    const code = result.transforms.find(t => t.url === resources[0]!.url)!.transform(source).source
      .replace('export const __webpack_modules__=', 'globalThis.modules=')
    runInNewContext(code, value)
    const exports: Record<string, any> = {}
    const requireModule: any = (id: string) => {
      if (id !== 'helper') throw Error('wrong module')
      return exports
    }
    requireModule.d = (target: any, ...objects: any[]) => Object.assign(target, ...objects)
    value.modules.helper({}, exports, requireModule)
    value.modules.dispatcher({}, {}, requireModule)
    await value.dispatch({
      callId: 'cordisx-task-rspack',
      arguments: { target: { type: 'projectless' }, model: 'native', prompt: 'fixture' },
    })
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ config: { 'cordisx.operation_token': handle.token } }))
    await value.dispatch({
      callId: 'cordisx-task-worktree',
      arguments: { target: { type: 'worktree' }, model: 'native', prompt: 'fixture' },
    })
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({
      startConversationParamsInput: expect.objectContaining({
        configOverrides: expect.objectContaining({ 'cordisx.operation_token': handle.token }),
      }),
    }))
    await expect(exports.Nw({ config: { unsafe: true }, sourceThreadId: 'source', target: {} })).rejects.toThrow(
      'delegated',
    )
  })

  it('fails only creation when structures are absent, ambiguous or prior composition is invalid', () => {
    const resources = [{ url: 'app://-/assets/initial.js', source: taskInitialSource }, {
      url: 'app://-/assets/execution.js',
      source: taskExecutionSource,
    }]
    const base = [{
      url: resources[0]!.url,
      sha256: 'base',
      transform: () => {
        throw Error('base failure')
      },
    }]
    expect(nativeAgentTaskTransforms('future', 'unknown', resources, base)).toEqual({
      available: false,
      transforms: base,
      reason: 'composition',
    })
    expect(
      nativeAgentTaskTransforms('future', 'unknown', [...resources, {
        ...resources[1]!,
        url: 'app://-/assets/duplicate.js',
      }], []).available,
    ).toBe(false)
    expect(
      nativeAgentTaskTransforms('future', 'unknown', [{
        ...resources[0]!,
        source: taskInitialSource.replace('settings!=null&&source!=null', 'settings!=null'),
      }, resources[1]!], []).available,
    ).toBe(false)
    expect(
      nativeAgentTaskTransforms('future', 'unknown', [resources[0]!, {
        ...resources[1]!,
        source: taskExecutionSource.replace('nativeCreate as create', 'unrelated as create'),
      }], []).available,
    ).toBe(false)
    expect(
      nativeAgentTaskTransforms('future', 'unknown', [{
        ...resources[0]!,
        source: taskInitialSource.replace('disabledPluginIds:[],', 'disabledPluginIds:[],config:unrelatedConfig,'),
      }, resources[1]!], []).available,
    ).toBe(false)
  })
})
