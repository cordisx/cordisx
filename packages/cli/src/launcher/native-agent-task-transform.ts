import { createHash } from 'node:crypto'
import type { NativeScriptResource } from './native-submission-structure.js'
import type { NativeResourceTransform } from './native-predispatch-interception.js'

export const NATIVE_AGENT_TASK_PINS = Object.freeze({
  version: '26.1021.31345',
  build: '21828',
  initial: '8f4e5fe65617413cabf689afbfc04bc6c24f73a5c0b57d7d0de443942343bd55',
  execution: 'f1a35f5a2b7397024aae8fdfc154bbb86cc6fd17c08c78811f8c41d54cc28a9b',
})
const hash = (source: string) => createHash('sha256').update(source).digest('hex')
const marker = '__cordisxNativeAgentTaskAdapter'
const tokenKey = 'cordisx.operation_token'

/** Exact audited creation dispatcher. The ordinary delegated-config guard remains intact. */
export function agentTaskEdits(kind: 'initial' | 'execution'): readonly (readonly [string, string])[] {
  if (kind === 'execution') {
    return [
      [
        'async function wp({scope:e,argumentsValue:t,parentTurnId:n,',
        'async function wp({scope:e,argumentsValue:t,cordisxCallId:__cxCallId,parentTurnId:n,',
      ],
      ['case dl:b=await wp({scope:e,parentTurnId:', 'case dl:b=await wp({scope:e,cordisxCallId:h.callId,parentTurnId:'],
      [
        'a?.throwIfAborted();let d=await sa({scope:e,turnTrigger:`app_tool_create_thread`,',
        `a?.throwIfAborted();let __cxTask=await globalThis.${marker}?.claim({callId:__cxCallId,sourceThreadId:s,arguments:t,hostId:u});if(typeof __cxCallId==='string'&&__cxCallId.startsWith('cordisx-task-')&&__cxTask===void 0)throw Error('Native task routing unavailable');let d=await sa({scope:e,__cordisxTask:__cxTask,turnTrigger:\`app_tool_create_thread\`,`,
      ],
    ]
  }
  return [
    [
      'title:b,startWithoutFirstTurn:x=!1,onBeforeWorktreeCreate:S}){if(i!=null&&f!=null)',
      'title:b,startWithoutFirstTurn:x=!1,onBeforeWorktreeCreate:S,__cordisxTask:__cxTask}){if(__cxTask!==void 0&&!globalThis.__cordisxNativeAgentTaskAdapter?.owns(__cxTask))throw Error(`Invalid native task handle`);if(i!=null&&f!=null)',
    ],
    [
      'return sus({scope:e,attachments:T?.attachments,input:x?[]:D,',
      'return sus({scope:e,__cordisxTask:__cxTask,attachments:T?.attachments,input:x?[]:D,',
    ],
    [
      'return aus({scope:e,attachments:T?.attachments,config:i,input:D,',
      'return aus({scope:e,__cordisxTask:__cxTask,attachments:T?.attachments,config:i,input:D,',
    ],
    [
      'threadSource:v,turnTrigger:y,parentTurnId:b,rootTurnId:x,title:S}){let C,w,T,E,D,O=Er;',
      'threadSource:v,turnTrigger:y,parentTurnId:b,rootTurnId:x,title:S,__cordisxTask:__cxTask}){let C,w,T,E,D,O=Er;',
    ],
    [
      'A={type:`text`,text:d,text_elements:[]},j=fus(l,_),',
      'A={type:`text`,text:d,text_elements:[]},j=fus(__cxTask?.model??l,_),',
    ],
    [
      'config:M==null?n:{...n,...M},projectAssignment:D,',
      `config:__cxTask===void 0?(M==null?n:{...n,...M}):{...n,...M,${
        JSON.stringify(tokenKey)
      }:__cxTask.token},projectAssignment:D,`,
    ],
    [
      'title:x,workspaceRoots:S,onBeforeWorktreeCreate:C}){let w=m==null?',
      'title:x,workspaceRoots:S,onBeforeWorktreeCreate:C,__cordisxTask:__cxTask}){let w=m==null?',
    ],
    [
      'T.responseItems=r;let E=await lus(e,i,u,h);',
      `T.responseItems=r;if(__cxTask!==void 0){T.configOverrides={...T.configOverrides,${
        JSON.stringify(tokenKey)
      }:__cxTask.token};T.collaborationMode=fus(__cxTask.model,g)}let E=await lus(e,i,u,h);`,
    ],
    [
      'request:{threadId:de,clientUserMessageId:xe,disabledPluginIds:D,',
      `request:{threadId:de,...(typeof n.config?.[${JSON.stringify(tokenKey)}]==='string'?{config:{${
        JSON.stringify(tokenKey)
      }:n.config[${JSON.stringify(tokenKey)}]}}:{}),clientUserMessageId:xe,disabledPluginIds:D,`,
    ],
  ]
}

export function applyAgentTaskEdits(source: string, kind: 'initial' | 'execution'): string {
  for (const [anchor, replacement] of agentTaskEdits(kind)) {
    if (source.split(anchor).length !== 2) throw new Error(`Native task ${kind} anchor unavailable`)
    source = source.replace(anchor, replacement)
  }
  return source
}

/** Compose with the real submission transform on the same resource, never intercept it twice. */
export function nativeAgentTaskTransforms(
  version: string,
  build: string,
  resources: readonly NativeScriptResource[],
  transforms: readonly NativeResourceTransform[],
): { transforms: readonly NativeResourceTransform[]; available: boolean } {
  if (version !== NATIVE_AGENT_TASK_PINS.version || build !== NATIVE_AGENT_TASK_PINS.build) {
    return { transforms, available: false }
  }
  const initial = resources.filter(resource => hash(resource.source) === NATIVE_AGENT_TASK_PINS.initial)
  const execution = resources.filter(resource => hash(resource.source) === NATIVE_AGENT_TASK_PINS.execution)
  if (initial.length !== 1 || execution.length !== 1) return { transforms, available: false }
  try {
    applyAgentTaskEdits(initial[0]!.source, 'initial')
    applyAgentTaskEdits(execution[0]!.source, 'execution')
    const merged = [...transforms]
    for (const [resource, kind] of [[initial[0]!, 'initial'], [execution[0]!, 'execution']] as const) {
      const priorIndex = merged.findIndex(transform => transform.url === resource.url)
      const prior = merged[priorIndex]
      const next: NativeResourceTransform = {
        url: resource.url,
        sha256: hash(resource.source),
        requiredForDocumentReady: prior?.requiredForDocumentReady ?? false,
        transform(source) {
          if (hash(source) !== hash(resource.source)) throw new Error('Native task resource drift')
          const result = prior?.transform(source)
          return {
            source: applyAgentTaskEdits(result?.source ?? source, kind)
              + `\n;globalThis.__cordisxNativeAgentTask_${kind}=true;`,
            anchorMatches: 1,
            acknowledgementExpression: `(globalThis.__cordisxNativeAgentTask_${kind}===true&&(${
              result?.acknowledgementExpression ?? 'true'
            }))`,
            fenceExpression: `(delete globalThis.__cordisxNativeAgentTask_${kind},globalThis.${marker}?.dispose(),${
              result?.fenceExpression ?? 'true'
            })`,
          }
        },
      }
      if (priorIndex < 0) merged.push(next)
      else merged[priorIndex] = next
    }
    return { transforms: merged, available: true }
  } catch {
    return { transforms, available: false }
  }
}
