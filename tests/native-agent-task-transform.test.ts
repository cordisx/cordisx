import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { agentTaskEdits, applyAgentTaskEdits } from '../packages/cli/src/launcher/native-agent-task-transform.js'

// Minimal executable audited dispatcher anchors. No native code/credentials or App is run.
const initial = `
async function ius({scope:e,config:i,sourceThreadId:f,target:m,title:b,startWithoutFirstTurn:x=!1,onBeforeWorktreeCreate:S}){if(i!=null&&f!=null)throw Error('guard');
let T,D,r;
if(m.type==='worktree')return sus({scope:e,attachments:T?.attachments,input:x?[]:D,responseItems:r});
return aus({scope:e,attachments:T?.attachments,config:i,input:D,rest:1});}
async function aus({scope:e,config:n,model:l,thinking:_,threadSource:v,turnTrigger:y,parentTurnId:b,rootTurnId:x,title:S}){let C,w,T,E,D,O=Er;
let d='original',A={type:\`text\`,text:d,text_elements:[]},j=fus(l,_),M=null;
return {collaborationMode:j,config:M==null?n:{...n,...M},projectAssignment:D,cwd:'resolved'};}
async function sus({scope:e,model:o,thinking:g,title:x,workspaceRoots:S,onBeforeWorktreeCreate:C}){let w=m==null?{}:{};
let T={configOverrides:{permission:'native'}},r=[];T.responseItems=r;let E=await lus(e,i,u,h);return T;}
function first(n){let de='created',xe='message',D=[];return {request:{threadId:de,clientUserMessageId:xe,disabledPluginIds:D,model:'native'}};}
globalThis.ius=ius;globalThis.aus=aus;globalThis.sus=sus;globalThis.first=first;`

describe('audited task creation adapter composition', () => {
  it('retains delegated-config rejection and applies only a branded task handle to local and worktree inputs', async () => {
    const handle = { token: 'opaque-operation-token', model: 'provider-model' }
    const world: Record<string, any> = {
      Er: 'local',
      fus: (model: string) => ({ settings: { model } }),
      m: null,
      i: 0,
      u: 0,
      h: 0,
      lus: async () => ({}),
      __cordisxNativeAgentTaskAdapter: { owns: (value: unknown) => value === handle },
    }
    runInNewContext(applyAgentTaskEdits(initial, 'initial'), world)
    await expect(world.ius({ config: { unsafe: 1 }, sourceThreadId: 'source', target: {} })).rejects.toThrow('guard')
    await expect(world.ius({ __cordisxTask: { ...handle }, target: {} })).rejects.toThrow('Invalid native task handle')
    expect(await world.aus({ model: 'old', __cordisxTask: handle })).toMatchObject({
      cwd: 'resolved',
      collaborationMode: { settings: { model: 'provider-model' } },
      config: { 'cordisx.operation_token': handle.token },
    })
    expect(await world.sus({ __cordisxTask: handle })).toMatchObject({
      configOverrides: { permission: 'native', 'cordisx.operation_token': handle.token },
      collaborationMode: { settings: { model: 'provider-model' } },
    })
    expect(world.first({ config: { 'cordisx.operation_token': handle.token } }).request.config).toEqual({
      'cordisx.operation_token': handle.token,
    })
  })
  it('keeps uncorrelated ordinary creation unchanged and rejects a correlated call without its admitted claim', async () => {
    const request = agentTaskEdits('execution')[2]![0]
    const source = `${
      agentTaskEdits('execution')[0]![0]
    }rootTurnId:r,getAvailableModels:i,signal:a,sourceHostId:o,sourceThreadId:s}){let c={data:{model:'native',prompt:'input'}},u='local';${request}model:c.data.model,prompt:c.data.prompt});return d;}
    async function dispatch(){let b;switch(0){${agentTaskEdits('execution')[1]![0]}0});break;}};globalThis.wp=wp;`
    const sa = vi.fn(async (input: unknown) => input)
    const world: Record<string, any> = { sa }
    runInNewContext(applyAgentTaskEdits(source, 'execution'), world)
    expect(await world.wp({ argumentsValue: {}, sourceThreadId: 'source' })).toMatchObject({
      model: 'native',
      prompt: 'input',
    })
    await expect(world.wp({ cordisxCallId: 'cordisx-task-actual', argumentsValue: {}, sourceThreadId: 'source' }))
      .rejects.toThrow('Native task routing unavailable')
    expect(sa).toHaveBeenCalledTimes(1)
  })
})
