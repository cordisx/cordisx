import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  NATIVE_OPERATION_REQUEST_ACKNOWLEDGEMENT,
  NATIVE_OPERATION_REQUEST_ACKNOWLEDGEMENT_9275,
  NATIVE_OPERATION_REQUEST_ACKNOWLEDGEMENT_9647,
  NATIVE_OPERATION_REQUEST_FENCE,
  NATIVE_OPERATION_REQUEST_FENCE_9647,
  transformNativeOperationRequest,
  transformNativeOperationRequest9275,
  transformNativeOperationRequest9647,
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

describe('native operation request transform build 9275', () => {
  const fixture9275 = `
function aRa(e){let{additionalDeveloperInstructions:j,requiresThreadReferences:M}=e;if(D===\`projectless\`){};
  let h=e.collaborationMode,g=e.serviceTier,_=false,T='source',E='default',c={existing:true};
  return {collaborationMode:h,multiAgentMode:Y_n,serviceTier:g,daybreakEnabled:_,threadSource:T,threadStartKind:E,config:c,...D===\`projectless\`?{projectless:true}:{}};
}
async function lQt(e,t,n,r,i,a,o){let s=n.request,{inheritThreadSettings:c=!0,useAppServerPermissionDefault:l,usePermissionSelection:u=!1}=n.context??{},P=s.model,Te=s.serviceTier,F=s.effort,gQt=null;
  let Ee={model:P,cyberAccessProgram:s.cyberAccessProgram,serviceTier:Te,effort:F,multiAgentMode:gQt,};
  let De={model:P??null,serviceTier:Te,effort:F??null,multiAgentMode:gQt,};
  return {request:Ee,params:De};
}
function Ite(request,version){return {...request,config:{normalizedVersion:version}}}
async function T$t({manager:e,conversationId:t,operation:n,capabilities:r,origin:i,clientUserMessageId:a,createId:o,ownerWindowError:s,onOutcomeUnknown:c,onMessageAdded:l,onInitialTitleRequested:u,readPersistedValue:d},f){let p=n.request,{beforeSendRequest:_}=n.context??{};
  let C={},E={request:p},M,j;{let n=C.markRequestDispatched?.(),r=Ite(E.request,e.requestClient.getAppServerVersion());M=e.getConversation(t)?.environmentSelectionEvidence;
  j=await e.sendRequest(\`turn/start\`,r);}return j;
}
globalThis.aRa=aRa;globalThis.lQt=lQt;globalThis.T$t=T$t;
`

  it('carries the operation token and fast mode through both build-9275 request paths', async () => {
    const sandbox: Record<string, any> = { D: 'project', Y_n: null }
    runInNewContext(transformNativeOperationRequest9275(fixture9275).source, sandbox)
    sandbox.__cordisxNativeServiceTierOverride = 'priority'
    const token = 'build-9275-operation-token'
    expect(sandbox.aRa({ __cordisxOperationToken: token })).toMatchObject({
      serviceTier: 'priority',
      config: { existing: true, 'cordisx.operation_token': token },
    })
    const operation = await sandbox.lQt(null, 'thread-1', {
      request: { model: 'gpt', serviceTier: null, effort: 'high' },
      context: { __cordisxOperationToken: token },
    })
    expect(operation.request).toMatchObject({
      serviceTier: 'priority',
      config: { 'cordisx.operation_token': token },
    })
    expect(operation.params.serviceTier).toBe('priority')
    const manager = {
      requestClient: { getAppServerVersion: () => '9275' },
      getConversation: () => null,
      sendRequest: async (_method: string, request: unknown) => request,
    }
    await expect(sandbox.T$t({ manager, conversationId: 'thread-1', operation })).resolves.toMatchObject({
      config: { normalizedVersion: '9275', 'cordisx.operation_token': token },
    })
  })

  it('fails closed on an incomplete resource and exposes a distinct acknowledgement', () => {
    expect(() => transformNativeOperationRequest9275('')).toThrow('build-9275 new-thread declaration anchor')
    expect(NATIVE_OPERATION_REQUEST_ACKNOWLEDGEMENT_9275).not.toBe(NATIVE_OPERATION_REQUEST_ACKNOWLEDGEMENT)
  })
})

describe('native operation request transform build 9647', () => {
  const fixture9647 = `
async function kbn(){let s={model:'gpt'},P='gpt',ke=null,F='high';
  let Ae={model:P,cyberAccessProgram:s.cyberAccessProgram,serviceTier:ke,effort:F,multiAgentMode:Ibn,};
  let je={model:P??null,serviceTier:ke,effort:F??null,multiAgentMode:Ibn,};return {request:Ae,params:je};}
function g_o(e){let{config:s,configOverrides:c,input:l,toolOutput:u}=e,O='project',D='default';
  return {input:l,toolOutput:u,threadStartKind:D,config:c,...O===\`projectless\`?{projectless:true}:{}};}
function V0t(request,version){return {...request,normalizedVersion:version,config:{normalizerRetained:true}}}
async function Gxn({manager:e,conversationId:t,operation:n,capabilities:r,origin:i,clientUserMessageId:a,createId:o,ownerWindowError:s,onOutcomeUnknown:c,onMessageAdded:l,onInitialTitleRequested:u,readPersistedValue:d},f){let p=n.request,{localTurnMetadata:m,attachments:h,commentAttachments:g,
  }=n.context??{};
  let T={},O={request:p},L,I;{let c=T.markRequestDispatched?.(),u=V0t(O.request,e.requestClient.getAppServerVersion());L=e.getConversation(t)?.environmentSelectionEvidence;
  I=await e.sendRequest(\`turn/start\`,u);}return I;}
globalThis.kbn=kbn;globalThis.g_o=g_o;globalThis.Gxn=Gxn;`

  it('preserves the exact token after normalization and applies fast mode', async () => {
    const sandbox: Record<string, any> = { Ibn: null }
    runInNewContext(transformNativeOperationRequest9647(fixture9647).source, sandbox)
    sandbox.__cordisxNativeServiceTierOverride = 'priority'
    await expect(sandbox.kbn()).resolves.toMatchObject({
      request: { serviceTier: 'priority' },
      params: { serviceTier: 'priority' },
    })
    const manager = {
      requestClient: { getAppServerVersion: () => '9647' },
      getConversation: () => null,
      sendRequest: async (_method: string, request: unknown) => request,
    }
    await expect(sandbox.Gxn({
      manager,
      operation: { request: { config: { 'cordisx.operation_token': 'operation-build-9647' } } },
    })).resolves.toMatchObject({
      normalizedVersion: '9647',
      config: { normalizerRetained: true, 'cordisx.operation_token': 'operation-build-9647' },
    })
    await expect(sandbox.Gxn({
      manager,
      operation: { request: { config: { 'cordisx.operation_token': 'bad' } } },
    })).resolves.toMatchObject({ config: { normalizerRetained: true } })
    expect(runInNewContext(NATIVE_OPERATION_REQUEST_ACKNOWLEDGEMENT_9647, sandbox)).toBe(true)
    runInNewContext(NATIVE_OPERATION_REQUEST_FENCE_9647, sandbox)
    expect(runInNewContext(NATIVE_OPERATION_REQUEST_ACKNOWLEDGEMENT_9647, sandbox)).toBe(false)
    expect(() => transformNativeOperationRequest9647('unrelated')).toThrow('found 0')
  })
})
