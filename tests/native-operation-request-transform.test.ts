import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  NATIVE_OPERATION_REQUEST_ACKNOWLEDGEMENT,
  NATIVE_OPERATION_REQUEST_FENCE,
  transformNativeOperationRequest,
} from '../packages/cli/src/renderer/adapter/native-operation-request-transform.js'

const fixture = `
function dMs(t) {
  let v={},y={existing:true},p=null; const uMs=x=>x;
  Object.assign({}, {plugins:t.elicitationPluginIds.map(e=>({type:\`plugin\`,id:e}))});let b=uMs;
  return {config:v,configOverrides:y,memoryPreferences:p,requiresThreadReferences:false};
}
function cno({config:a,configOverrides:o,input:s,toolOutput:c,...rest}) {
  let S='default',C='project';
  return {...rest,input:s,toolOutput:c,threadStartKind:S,config:o,...C===\`projectless\`?{projectless:true}:{}};
}
async function startConversation(e,ae) {
  let {serviceName:L,config:R,projectAssignment:z,mode:ee,threadSource:B,threadStartKind:V,requiresThreadReferences:H=!1}=e,
    v=e.collaborationMode,ce=null,y='explicitRequestOnly',a=e.input,u=e.toolOutput,G=v;
  return {threadId:ae.thread.id,model:v==null?ae.model:null,serviceTier:ce,effort:v?.settings.reasoning_effort,multiAgentMode:y,input:a,toolOutput:u,collaborationMode:G};
}
function TMs(i) {
  let j={},c=null,k=false,g=[],a='thread-1',t='submit',m=null,p=null,w=i.input,o='/cwd',GIn=null,l=null;
  j!=null&&c!=null&&!k&&(j.activePermissionProfile={id:c,extends:null},j.runtimeWorkspaceRoots=g);let M={request:{
  threadId:a,turnTrigger:t,clientUserMessageId:m??p?.id,input:w,cwd:o,model:null,effort:null,multiAgentMode:GIn,serviceTier:l,
  }};return M.request;
}
function cRt(request,version){return {...request,normalizedVersion:version}}
async function lun({manager:e,operation:n,clientUserMessageId:a,readPersistedValue:d},f){let p=n.request,{localTurnMetadata:m,attachments:h,commentAttachments:g,beforeSendRequest:_}=n.context??{};
  let C={prepare:async()=>({request:{threadId:p.threadId,input:p.input,collaborationMode:p.collaborationMode,config:{normalizerRetained:true}}})},E=await C.prepare({}),j;
  {let n=C.markRequestDispatched?.(),r=cRt(E.request,e.requestClient.getAppServerVersion());j=await e.sendRequest(\`turn/start\`,r,{clientUserMessageId:a});}return j;
}
globalThis.lun=lun;globalThis.dMs=dMs;globalThis.TMs=TMs;globalThis.cno=cno;globalThis.startConversation=startConversation;
`

describe('native operation request transform', () => {
  it('preserves only the exact operation marker through the final request normalizer', async () => {
    const sandbox: Record<string, any> = {}
    runInNewContext(transformNativeOperationRequest(fixture).source, sandbox)
    const manager = {
      requestClient: { getAppServerVersion: () => '8109' },
      sendRequest: async (_method: string, request: unknown) => request,
    }
    for (const token of ['normalizer-survival-token', 'bad', undefined]) {
      const input = [{ type: 'text', text: 'original input' }]
      const collaborationMode = { mode: 'plan', settings: { model: 'old', reasoning_effort: 'high' } }
      const result = await sandbox.lun({
        manager,
        operation: {
          request: {
            threadId: 'created',
            input,
            collaborationMode,
            config: { dropped: true, 'cordisx.operation_token': token },
          },
        },
      })
      expect(result).toMatchObject({ threadId: 'created', input, collaborationMode, normalizedVersion: '8109' })
      expect(result.config).toEqual({
        normalizerRetained: true,
        ...(token === 'normalizer-survival-token' ? { 'cordisx.operation_token': token } : {}),
      })
    }
  })
  it('carries the same operation through thread creation and its exact first turn, including plan mode', async () => {
    const sandbox: Record<string, any> = {}
    runInNewContext(transformNativeOperationRequest(fixture).source, sandbox)
    const token = 'two-stage-operation-token'
    const prepared = sandbox.dMs({ __cordisxOperationToken: token, elicitationPluginIds: [] })
    const input = [{ type: 'text', text: 'original prompt' }]
    const collaborationMode = { mode: 'plan', settings: { model: 'old-model', reasoning_effort: 'high' } }
    const create = sandbox.cno({ ...prepared, input, collaborationMode })
    expect(create.config['cordisx.operation_token']).toBe(token)
    const turn = await sandbox.startConversation(create, { thread: { id: 'created' }, model: 'selected' })
    expect(turn).toMatchObject({
      threadId: 'created',
      input,
      model: null,
      effort: 'high',
      multiAgentMode: 'explicitRequestOnly',
      collaborationMode,
      config: { 'cordisx.operation_token': token },
    })
    const native = sandbox.cno({ ...sandbox.dMs({ elicitationPluginIds: [] }), input })
    expect(await sandbox.startConversation(native, { thread: { id: 'native' }, model: 'native-model' })).not
      .toHaveProperty('config')
  })
  it('propagates only each context token and preserves native request fields', async () => {
    const sandbox: Record<string, any> = {}
    runInNewContext(transformNativeOperationRequest(fixture).source, sandbox)
    const context = {
      __cordisxOperationToken: 'exact-operation-token',
      input: [{ text: 'draft' }],
      elicitationPluginIds: [],
    }
    expect(sandbox.dMs(context).configOverrides).toEqual({
      existing: true,
      'cordisx.operation_token': 'exact-operation-token',
    })
    expect(sandbox.dMs({ elicitationPluginIds: [] }).configOverrides).toEqual({ existing: true })
    const request = sandbox.TMs(context)
    expect(request).toMatchObject({
      threadId: 'thread-1',
      input: context.input,
      model: null,
      effort: null,
      config: { 'cordisx.operation_token': 'exact-operation-token' },
    })
    expect(sandbox.TMs({ input: [] })).not.toHaveProperty('config')
    expect(sandbox.TMs({ __cordisxOperationToken: 'bad', input: [] })).not.toHaveProperty('config')
    sandbox.__cordisxNativeServiceTierOverride = 'priority'
    expect(sandbox.TMs({ input: [] }).serviceTier).toBe('priority')
    const prepared = sandbox.cno({ ...sandbox.dMs({ elicitationPluginIds: [] }), input: [] })
    await expect(sandbox.startConversation(prepared, { thread: { id: 'fast' }, model: 'fast-model' })).resolves
      .toMatchObject({ serviceTier: 'priority' })
    sandbox.__cordisxNativeServiceTierOverride = 'default'
    expect(sandbox.TMs({ input: [] }).serviceTier).toBeNull()
  })

  it('requires every exact anchor once and acknowledges module execution, not hook existence', () => {
    expect(() => transformNativeOperationRequest(fixture + fixture)).toThrow('found 2')
    expect(() => transformNativeOperationRequest(fixture.replace('let M={request:{', 'let M={other:{'))).toThrow(
      'found 0',
    )
    const sandbox = {}
    runInNewContext(transformNativeOperationRequest(fixture).source, sandbox)
    expect(runInNewContext(NATIVE_OPERATION_REQUEST_ACKNOWLEDGEMENT, sandbox)).toBe(true)
    runInNewContext(NATIVE_OPERATION_REQUEST_FENCE, sandbox)
    expect(runInNewContext(NATIVE_OPERATION_REQUEST_ACKNOWLEDGEMENT, sandbox)).toBe(false)
  })
})
