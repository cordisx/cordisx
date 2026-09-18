export const NATIVE_SUBMIT_ORCHESTRATOR_RESOURCE = Object.freeze({
  url: 'app://-/assets/app-primary-6cd7b8b3f5e3.js',
  sha256: '35d81a22c75f5a44b58baee0c0045ba6bb36cc9b387f43fab82178b4a2236849',
})

export const NATIVE_SUBMIT_ORCHESTRATOR_RESOURCE_BUILD_9275 = Object.freeze({
  url: 'app://-/assets/app-primary-4af6ed7f68d1.js',
  sha256: '6d75ae321771510842fbcc303846913f7434bc8a67e0c69fb5adb22c632eb3ac',
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
