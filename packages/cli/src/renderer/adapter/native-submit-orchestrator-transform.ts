export const NATIVE_SUBMIT_ORCHESTRATOR_RESOURCE = Object.freeze({
  url: 'app://-/assets/app-primary-6cd7b8b3f5e3.js',
  sha256: '35d81a22c75f5a44b58baee0c0045ba6bb36cc9b387f43fab82178b4a2236849',
})

export const NATIVE_SUBMIT_ORCHESTRATOR_RESOURCE_BUILD_9275 = Object.freeze({
  url: 'app://-/assets/app-primary-4af6ed7f68d1.js',
  sha256: '6d75ae321771510842fbcc303846913f7434bc8a67e0c69fb5adb22c632eb3ac',
})

export const NATIVE_SUBMIT_ORCHESTRATOR_RESOURCE_BUILD_9647 = Object.freeze({
  url: 'app://-/assets/app-primary-d63a2421d501.js',
  sha256: 'e381729764540940326372f7785bd5f68bc7dd2e49fad0eed4d8a99bbb3de706',
})

const ANCHOR = 'skipGoalReplacementConfirmation:se=!1,skipGoalSubmit:ce=!1}=P;a();'
const CONTEXT_ANCHOR = ';De={...t,threadReferences:n,'
const MODEL_CALLBACK_ANCHOR = 'Wt=(e,t)=>{dt(e,t)}'
const MARKER = '__cordisxNativeSubmitTransformBuild8109V3'
const VERSION = 'app-primary-6cd7b8b3f5e3:operation-context-v3'
const REPLACEMENT = `skipGoalReplacementConfirmation:se=!1,skipGoalSubmit:ce=!1}=P;
let __cxDecision={allow:!0};let __cxHook=globalThis.__cordisxNativeSubmitHook;
if(typeof __cxHook===\`function\`){
__cxDecision=await __cxHook({
target:K.type,thread:c,response:w,followUp:p?.type,
followUpThread:p?.type===\`local\`?p.localConversationId:void 0,
defaultAction:d,explicitAction:P.followUpSubmitAction,edit:h,
promptOverride:ae!=null||ie!=null
});
if(__cxDecision?.allow!==!0)return;
if(__cxDecision.operationToken!==void 0&&(typeof __cxDecision.operationToken!==\`string\`||__cxDecision.operationToken.length<16||__cxDecision.operationToken.length>256||/[\\0\\r\\n]/u.test(__cxDecision.operationToken)))return;
}a();`
const CONTEXT_REPLACEMENT =
  ';De={...t,...(__cxDecision.operationToken===void 0?{}:{__cordisxOperationToken:__cxDecision.operationToken}),threadReferences:n,'

export const NATIVE_SUBMIT_ORCHESTRATOR_ACKNOWLEDGEMENT = `globalThis.${MARKER}===${JSON.stringify(VERSION)}`
export const NATIVE_SUBMIT_ORCHESTRATOR_FENCE =
  `(delete globalThis.__cordisxNativeSubmitHook,delete globalThis.${MARKER},true)`

export interface NativeSubmitOrchestratorTransformResult {
  readonly source: string
  readonly anchorMatches: number
  readonly acknowledgementExpression: string
  readonly fenceExpression: string
}

/** Exact-pinned build-8109 transform; source mismatch fails closed. */
export function transformNativeSubmitOrchestrator(source: string): NativeSubmitOrchestratorTransformResult {
  const occurrences = source.split(ANCHOR).length - 1
  if (occurrences !== 1) throw new Error(`Expected one native submit orchestrator anchor, found ${occurrences}`)
  const contextOccurrences = source.split(CONTEXT_ANCHOR).length - 1
  if (contextOccurrences !== 1) {
    throw new Error(`Expected one native submit context anchor, found ${contextOccurrences}`)
  }
  const modelCallbackOccurrences = source.split(MODEL_CALLBACK_ANCHOR).length - 1
  if (modelCallbackOccurrences !== 1) {
    throw new Error(`Expected one native model callback anchor, found ${modelCallbackOccurrences}`)
  }
  return {
    source: source.replace(ANCHOR, REPLACEMENT).replace(CONTEXT_ANCHOR, CONTEXT_REPLACEMENT)
      // Preserve completion of the existing native update, including its optimistic-state cleanup.
      .replace(MODEL_CALLBACK_ANCHOR, 'Wt=(e,t)=>{return dt(e,t)}')
      + `\n;globalThis.${MARKER}=${JSON.stringify(VERSION)};globalThis.__cordisxNativeSubmissionActivate?.(true);`,
    anchorMatches: occurrences,
    acknowledgementExpression: NATIVE_SUBMIT_ORCHESTRATOR_ACKNOWLEDGEMENT,
    fenceExpression: NATIVE_SUBMIT_ORCHESTRATOR_FENCE,
  }
}

export const NATIVE_SUBMIT_ORCHESTRATOR_TRANSFORM = Object.freeze({
  ...NATIVE_SUBMIT_ORCHESTRATOR_RESOURCE,
  transform: transformNativeSubmitOrchestrator,
})

const ANCHOR_BUILD_9275 = 'skipGoalReplacementConfirmation:le=!1,skipGoalSubmit:ue=!1}=F;a();'
const CONTEXT_ANCHOR_BUILD_9275 = 'je={...t,threadReferences:n,'
const MODEL_CALLBACK_ANCHOR_BUILD_9275 = 'dn=(e,t)=>{Ot(e,t)}'
const MARKER_BUILD_9275 = '__cordisxNativeSubmitTransformBuild9275V1'
const VERSION_BUILD_9275 = 'app-primary-4af6ed7f68d1:operation-context-v1'
const REPLACEMENT_BUILD_9275 = `skipGoalReplacementConfirmation:le=!1,skipGoalSubmit:ue=!1}=F;
let __cxDecision={allow:!0};let __cxHook=globalThis.__cordisxNativeSubmitHook;
if(typeof __cxHook===\`function\`){
__cxDecision=await __cxHook({
target:K.type,thread:l,response:T,followUp:m?.type,
followUpThread:m?.type===\`local\`?m.localConversationId:void 0,
defaultAction:f,explicitAction:F.followUpSubmitAction,edit:g,
promptOverride:J!=null||se!=null
});
if(__cxDecision?.allow!==!0)return;
if(__cxDecision.operationToken!==void 0&&(typeof __cxDecision.operationToken!==\`string\`||__cxDecision.operationToken.length<16||__cxDecision.operationToken.length>256||/[\\0\\r\\n]/u.test(__cxDecision.operationToken)))return;
}a();`
const CONTEXT_REPLACEMENT_BUILD_9275 =
  'je={...t,...(__cxDecision.operationToken===void 0?{}:{__cordisxOperationToken:__cxDecision.operationToken}),threadReferences:n,'

export const NATIVE_SUBMIT_ORCHESTRATOR_ACKNOWLEDGEMENT_BUILD_9275 = `globalThis.${MARKER_BUILD_9275}===${
  JSON.stringify(VERSION_BUILD_9275)
}`
export const NATIVE_SUBMIT_ORCHESTRATOR_FENCE_BUILD_9275 =
  `(delete globalThis.__cordisxNativeSubmitHook,delete globalThis.${MARKER_BUILD_9275},true)`

/** Exact-pinned build-9275 transform; source mismatch fails closed. */
export function transformNativeSubmitOrchestratorBuild9275(
  source: string,
): NativeSubmitOrchestratorTransformResult {
  const occurrences = source.split(ANCHOR_BUILD_9275).length - 1
  if (occurrences !== 1) throw new Error(`Expected one native submit orchestrator anchor, found ${occurrences}`)
  const contextOccurrences = source.split(CONTEXT_ANCHOR_BUILD_9275).length - 1
  if (contextOccurrences !== 1) {
    throw new Error(`Expected one native submit context anchor, found ${contextOccurrences}`)
  }
  const modelCallbackOccurrences = source.split(MODEL_CALLBACK_ANCHOR_BUILD_9275).length - 1
  if (modelCallbackOccurrences !== 1) {
    throw new Error(`Expected one native model callback anchor, found ${modelCallbackOccurrences}`)
  }
  return {
    source: source.replace(ANCHOR_BUILD_9275, REPLACEMENT_BUILD_9275)
      .replace(CONTEXT_ANCHOR_BUILD_9275, CONTEXT_REPLACEMENT_BUILD_9275)
      // Preserve completion of the existing native update, including its optimistic-state cleanup.
      .replace(MODEL_CALLBACK_ANCHOR_BUILD_9275, 'dn=(e,t)=>{return Ot(e,t)}')
      + `\n;globalThis.${MARKER_BUILD_9275}=${
        JSON.stringify(VERSION_BUILD_9275)
      };globalThis.__cordisxNativeSubmissionActivate?.(true);`,
    anchorMatches: occurrences,
    acknowledgementExpression: NATIVE_SUBMIT_ORCHESTRATOR_ACKNOWLEDGEMENT_BUILD_9275,
    fenceExpression: NATIVE_SUBMIT_ORCHESTRATOR_FENCE_BUILD_9275,
  }
}

export const NATIVE_SUBMIT_ORCHESTRATOR_TRANSFORM_BUILD_9275 = Object.freeze({
  ...NATIVE_SUBMIT_ORCHESTRATOR_RESOURCE_BUILD_9275,
  transform: transformNativeSubmitOrchestratorBuild9275,
})

const ANCHOR_BUILD_9647 = 'skipGoalReplacementConfirmation:ce=!1,skipGoalSubmit:le=!1,turnTrigger:ue}=L;s();'
const CONTEXT_ANCHOR_BUILD_9647 =
  'Fe={...t,...ue==null?{}:{turnTrigger:ue},artifactFollowupAttributions:je,threadReferences:n,'
const MODEL_CALLBACK_ANCHOR_BUILD_9647 = 'Dt=function(e,t){return(te?.selectModelAndReasoningEffort??J)(Ot(e),t,()=>{'
const NEW_THREAD_CONTEXT_ANCHOR_BUILD_9647 = 't.elicitationPluginIds.map(e=>({type:`plugin`,id:e}))});let x=Net'
const NEW_THREAD_REQUEST_ANCHOR_BUILD_9647 = 'model:null,serviceTier:d,daybreakEnabled:'
const EXISTING_THREAD_DECLARATION_ANCHOR_BUILD_9647 =
  'let N=f==null||D?null:Ode({config:A,permissionSelection:f,runtimeWorkspaceRoots:_}),P={request:{'
const EXISTING_THREAD_REQUEST_ANCHOR_BUILD_9647 =
  'threadId:a,turnTrigger:t,clientUserMessageId:h??m?.id,input:w,cwd:o,model:null,effort:null,multiAgentMode:Sse,serviceTier:l,'
const MARKER_BUILD_9647 = '__cordisxNativeSubmitTransformBuild9647V1'
const VERSION_BUILD_9647 = 'app-primary-d63a2421d501:operation-context-v1'
const REPLACEMENT_BUILD_9647 = `skipGoalReplacementConfirmation:ce=!1,skipGoalSubmit:le=!1,turnTrigger:ue}=L;
let __cxDecision={allow:!0};let __cxHook=globalThis.__cordisxNativeSubmitHook;
if(typeof __cxHook===\`function\`){
__cxDecision=await __cxHook({
target:Y.type,thread:u,response:E,followUp:h?.type,
followUpThread:h?.type===\`local\`?h.localConversationId:void 0,
defaultAction:p,explicitAction:L.followUpSubmitAction,edit:_,
promptOverride:oe!=null||ae!=null
});
if(__cxDecision?.allow!==!0)return;
if(__cxDecision.operationToken!==void 0&&(typeof __cxDecision.operationToken!==\`string\`||__cxDecision.operationToken.length<16||__cxDecision.operationToken.length>256||/[\\0\\r\\n]/u.test(__cxDecision.operationToken)))return;
}s();`
const CONTEXT_REPLACEMENT_BUILD_9647 =
  'Fe={...t,...(__cxDecision.operationToken===void 0?{}:{__cordisxOperationToken:__cxDecision.operationToken}),...ue==null?{}:{turnTrigger:ue},artifactFollowupAttributions:je,threadReferences:n,'
const SERVICE_TIER_OVERRIDE_BUILD_9647 =
  'globalThis.__cordisxNativeServiceTierOverride===`priority`?`priority`:globalThis.__cordisxNativeServiceTierOverride===`default`?null:'
const OPERATION_TOKEN_CONFIG_KEY_BUILD_9647 = 'cordisx.operation_token'
const VALID_CONTEXT_TOKEN_BUILD_9647 =
  'typeof t.__cordisxOperationToken===`string`&&t.__cordisxOperationToken.length>=16&&t.__cordisxOperationToken.length<=256&&!/[\\0\\r\\n]/u.test(t.__cordisxOperationToken)?t.__cordisxOperationToken:void 0'
const VALID_EXISTING_TOKEN_BUILD_9647 =
  'typeof i.__cordisxOperationToken===`string`&&i.__cordisxOperationToken.length>=16&&i.__cordisxOperationToken.length<=256&&!/[\\0\\r\\n]/u.test(i.__cordisxOperationToken)?i.__cordisxOperationToken:void 0'
const NEW_THREAD_CONTEXT_REPLACEMENT_BUILD_9647 =
  `t.elicitationPluginIds.map(e=>({type:\`plugin\`,id:e}))});let __cxOperationToken=${VALID_CONTEXT_TOKEN_BUILD_9647};__cxOperationToken!==void 0&&(b={...b,${
    JSON.stringify(OPERATION_TOKEN_CONFIG_KEY_BUILD_9647)
  }:__cxOperationToken});let x=Net`
const NEW_THREAD_REQUEST_REPLACEMENT_BUILD_9647 = NEW_THREAD_REQUEST_ANCHOR_BUILD_9647.replace(
  'serviceTier:d',
  `serviceTier:${SERVICE_TIER_OVERRIDE_BUILD_9647}d`,
)
const EXISTING_THREAD_DECLARATION_REPLACEMENT_BUILD_9647 =
  `let N=f==null||D?null:Ode({config:A,permissionSelection:f,runtimeWorkspaceRoots:_}),__cxOperationToken=${VALID_EXISTING_TOKEN_BUILD_9647},P={request:{`
const EXISTING_THREAD_REQUEST_REPLACEMENT_BUILD_9647 = `${
  EXISTING_THREAD_REQUEST_ANCHOR_BUILD_9647.replace(
    'serviceTier:l',
    `serviceTier:${SERVICE_TIER_OVERRIDE_BUILD_9647}l`,
  )
}...(__cxOperationToken===void 0?{}:{config:{${
  JSON.stringify(OPERATION_TOKEN_CONFIG_KEY_BUILD_9647)
}:__cxOperationToken}}),`

export const NATIVE_SUBMIT_ORCHESTRATOR_ACKNOWLEDGEMENT_BUILD_9647 = `globalThis.${MARKER_BUILD_9647}===${
  JSON.stringify(VERSION_BUILD_9647)
}`
export const NATIVE_SUBMIT_ORCHESTRATOR_FENCE_BUILD_9647 =
  `(delete globalThis.__cordisxNativeSubmitHook,delete globalThis.${MARKER_BUILD_9647},true)`

/** Exact-pinned build-9647 transform; source mismatch fails closed. */
export function transformNativeSubmitOrchestratorBuild9647(
  source: string,
): NativeSubmitOrchestratorTransformResult {
  for (
    const [name, anchor] of [
      ['submit orchestrator', ANCHOR_BUILD_9647],
      ['submit context', CONTEXT_ANCHOR_BUILD_9647],
      ['model callback', MODEL_CALLBACK_ANCHOR_BUILD_9647],
      ['new-thread context', NEW_THREAD_CONTEXT_ANCHOR_BUILD_9647],
      ['new-thread request', NEW_THREAD_REQUEST_ANCHOR_BUILD_9647],
      ['existing-thread declaration', EXISTING_THREAD_DECLARATION_ANCHOR_BUILD_9647],
      ['existing-thread request', EXISTING_THREAD_REQUEST_ANCHOR_BUILD_9647],
    ]
  ) {
    const count = source.split(anchor!).length - 1
    if (count !== 1) throw new Error(`Expected one build-9647 native ${name} anchor, found ${count}`)
  }
  return {
    source: source.replace(ANCHOR_BUILD_9647, REPLACEMENT_BUILD_9647)
      .replace(CONTEXT_ANCHOR_BUILD_9647, CONTEXT_REPLACEMENT_BUILD_9647)
      .replace(NEW_THREAD_CONTEXT_ANCHOR_BUILD_9647, NEW_THREAD_CONTEXT_REPLACEMENT_BUILD_9647)
      .replace(NEW_THREAD_REQUEST_ANCHOR_BUILD_9647, NEW_THREAD_REQUEST_REPLACEMENT_BUILD_9647)
      .replace(EXISTING_THREAD_DECLARATION_ANCHOR_BUILD_9647, EXISTING_THREAD_DECLARATION_REPLACEMENT_BUILD_9647)
      .replace(EXISTING_THREAD_REQUEST_ANCHOR_BUILD_9647, EXISTING_THREAD_REQUEST_REPLACEMENT_BUILD_9647)
      + `\n;globalThis.${MARKER_BUILD_9647}=${
        JSON.stringify(VERSION_BUILD_9647)
      };globalThis.__cordisxNativeSubmissionActivate?.(true);`,
    anchorMatches: 1,
    acknowledgementExpression: NATIVE_SUBMIT_ORCHESTRATOR_ACKNOWLEDGEMENT_BUILD_9647,
    fenceExpression: NATIVE_SUBMIT_ORCHESTRATOR_FENCE_BUILD_9647,
  }
}

export const NATIVE_SUBMIT_ORCHESTRATOR_TRANSFORM_BUILD_9647 = Object.freeze({
  ...NATIVE_SUBMIT_ORCHESTRATOR_RESOURCE_BUILD_9647,
  transform: transformNativeSubmitOrchestratorBuild9647,
})
